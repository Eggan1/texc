/* texc shared foundation: event bus, HTTP/SSE helpers, small utils. */
(function () {
  "use strict";
  const T = (window.T = window.T || {});
  const TOKEN = (document.querySelector('meta[name="texc-token"]') || {}).content || "";

  // ---- event bus ----
  const handlers = new Map();
  T.bus = {
    on(evt, fn) { (handlers.get(evt) || handlers.set(evt, new Set()).get(evt)).add(fn); return fn; },
    off(evt, fn) { const s = handlers.get(evt); if (s) s.delete(fn); },
    emit(evt, data) {
      const s = handlers.get(evt);
      if (!s) return;
      for (const fn of [...s]) {
        try { fn(data); } catch (e) { console.error(`[bus] ${evt} handler failed`, e); }
      }
    },
  };

  // ---- HTTP ----
  function url(path, params) {
    const u = new URL(path, location.origin);
    if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
    u.searchParams.set("token", TOKEN);
    return u.pathname + u.search;
  }

  async function request(method, path, body, params) {
    const u = new URL(path, location.origin);
    if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
    const opts = { method, headers: { "X-Texc-Token": TOKEN } };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(u.pathname + u.search, opts);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error((data && data.error) || `${method} ${path} failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // POST that answers with text/event-stream; onEvent(name, data) per event.
  function stream(path, body, onEvent) {
    const ctrl = new AbortController();
    const done = (async () => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "X-Texc-Token": TOKEN, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        let msg = `request failed (${res.status})`;
        try { msg = (await res.json()).error || msg; } catch (_) {}
        throw Object.assign(new Error(msg), { status: res.status });
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
          let name = "message", data = "";
          for (const line of raw.split(/\r?\n/)) {
            if (line.startsWith("event:")) name = line.slice(6).trim();
            else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
          }
          if (!data && name === "message") continue;
          let parsed = data;
          try { parsed = JSON.parse(data); } catch (_) {}
          onEvent(name, parsed);
        }
      }
    })();
    return { abort: () => ctrl.abort(), done };
  }

  // Server-pushed events with auto-reconnect.
  function events(onEvent) {
    let es, closed = false, retry = 1000;
    const names = ["hello", "files", "file", "compile-start", "compile"];
    const open = () => {
      es = new EventSource(url("/api/events"));
      names.forEach((n) => es.addEventListener(n, (e) => {
        retry = 1000;
        let d = null;
        try { d = e.data ? JSON.parse(e.data) : null; } catch (_) { d = e.data; }
        onEvent(n, d);
      }));
      es.onerror = () => {
        es.close();
        if (!closed) setTimeout(open, (retry = Math.min(retry * 2, 15000)));
      };
    };
    open();
    return { close() { closed = true; es && es.close(); } };
  }

  T.api = {
    token: TOKEN,
    url,
    get: (path, params) => request("GET", path, undefined, params),
    post: (path, body) => request("POST", path, body === undefined ? {} : body),
    put: (path, body) => request("PUT", path, body),
    del: (path) => request("DELETE", path),
    stream,
    events,
  };

  // ---- utils ----
  T.util = {
    esc(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    },
    debounce(fn, ms) {
      let t;
      const d = function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
      d.cancel = () => clearTimeout(t);
      return d;
    },
    fmtPath(p) { return String(p || "").replace(/^\.\//, ""); },
    basename(p) { return String(p || "").split("/").pop(); },
    isMac: /Mac|iPhone|iPad/.test(navigator.platform),
  };

  // ---- per-folder UI state ----
  // The server keeps it (~/.config/texc/ui-state/), so it survives the app's changing ports.
  // localStorage is only the fallback: the Welcome page, keys set before seed(), old sessions.
  const memo = new Map();
  let synced = false, pending = {}, removed = new Set(), timer = null, inflight = Promise.resolve();
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode, quota */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
  };
  function push(keepalive) {
    clearTimeout(timer);
    timer = null;
    if (!synced) return inflight;
    const set = pending, remove = [...removed];
    pending = {};
    removed = new Set();
    if (!Object.keys(set).length && !remove.length) return inflight;   // flush() still waits for a save in flight
    const req = fetch(url("/api/ui-state"), {
      method: "POST",
      keepalive: !!keepalive,
      headers: { "X-Texc-Token": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ set, remove }),
    }).then((r) => {
      if (r.status === 404) { synced = false; return; }   // a server without /api/ui-state: stop trying
      if (!r.ok) throw new Error(`ui-state ${r.status}`);
    })
      .catch((e) => {
        console.warn("[store] couldn't save UI state", e);
        for (const [k, v] of Object.entries(set)) if (!(k in pending) && !removed.has(k)) pending[k] = v;   // retry later
        for (const k of remove) if (!(k in pending)) removed.add(k);
      });
    inflight = inflight.then(() => req);
    return inflight;
  }
  function schedule() { if (synced && !timer) timer = setTimeout(push, 400); }

  T.store = {
    // Called once with /api/project's ui_state; from then on writes go to the server too.
    seed(obj) {
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) if (typeof v === "string") memo.set(k, v);
      }
      for (const [k, v] of Object.entries(pending)) memo.set(k, v);   // keep writes made before seed
      for (const k of removed) memo.delete(k);                         // ...and removals
      synced = true;
      schedule();
    },
    get(key) { return memo.has(key) ? memo.get(key) : ls.get(key); },     // string or null
    set(key, value) {
      const v = String(value);
      memo.set(key, v);
      removed.delete(key);
      pending[key] = v;
      ls.set(key, v);
      schedule();
    },
    remove(key) {
      memo.delete(key);
      delete pending[key];
      removed.add(key);
      ls.del(key);
      schedule();
    },
    flush() { return push(false); },
  };
  window.addEventListener("pagehide", () => { push(true); });

  T.state = T.state || { project: null, settings: null, ai: null, main: null, lastCompile: null };
})();
