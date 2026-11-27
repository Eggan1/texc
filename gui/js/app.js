/* texc GUI shell.
   The app frame and boot sequence: top bar and tabs, project drawer, splitter, image tabs,
   menus / modals / toasts, Tools (literature search, proofread, word count, fix errors,
   settings), the Problems popover, the log viewer, compile orchestration and SSE handling.
   See docs/ARCHITECTURE.md. */
(function () {
  "use strict";

  const T = (window.T = window.T || {});

  function onReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
    else fn();
  }

  // Without the foundation (api.js) nothing can reach the server: say so and stop.
  if (!T.bus || !T.api) {
    onReady(() => {
      const d = document.createElement("div");
      d.className = "app-fatal";
      d.innerHTML = "<b>texc could not start</b><span>js/api.js did not load. Check that the texc server is running, then reload the page.</span>";
      document.body.appendChild(d);
    });
    return;
  }

  const bus = T.bus;
  const U = T.util || {};
  const esc = U.esc || ((s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const icon = (name, size) => (typeof T.icon === "function" ? T.icon(name, size) : "");
  const isMac = U.isMac != null ? U.isMac : /Mac|iPhone|iPad/.test(navigator.platform);
  const MOD = isMac ? "⌘" : "Ctrl+";

  const TEXT_EXT = new Set("tex ltx sty cls bst bib bbx cbx lbx def cfg dtx ins txt md tikz csv dat json yaml yml lua py r m".split(" "));
  const IMAGE_EXT = new Set("png jpg jpeg gif svg webp bmp ico avif pdf".split(" "));
  const TEX_EXT = new Set(["tex", "ltx", "sty", "cls", "dtx", "ins", "tikz", "bbx", "cbx", "lbx", "def", "cfg"]);
  const UPLOAD_MAX = 25 * 1024 * 1024;

  // ------------------------------------------------------------------ small helpers
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const fmtNum = (n) => Number(n || 0).toLocaleString();
  const basename = (p) => String(p || "").split("/").pop();
  const dirname = (p) => { const s = String(p || ""); const i = s.lastIndexOf("/"); return i < 0 ? "" : s.slice(0, i); };
  const extOf = (p) => { const b = basename(p); const i = b.lastIndexOf("."); return i <= 0 ? "" : b.slice(i + 1).toLowerCase(); };
  const normPath = (p) => String(p || "").replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  const overlayRoot = () => document.getElementById("overlay-root") || document.body;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "html") el.innerHTML = v;
        else if (k === "text") el.textContent = v;
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (k === "value" && "value" in el) el.value = v;
        else el.setAttribute(k, v === true ? "" : v);
      }
    }
    for (const c of kids.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // Per-folder UI state (docs/ARCHITECTURE.md): T.store keeps it on the server (it survives the app's
  // changing ports); plain localStorage only if api.js predates T.store. Values are JSON strings.
  const store = {
    get(key, fallback) {
      let v = null;
      try { v = T.store ? T.store.get(key) : localStorage.getItem(key); } catch (_) { return fallback; }
      if (v == null) return fallback;
      try { return JSON.parse(v); } catch (_) { return fallback; }
    },
    set(key, value) {
      let s;
      try { s = JSON.stringify(value); } catch (_) { return; }
      try { if (T.store) T.store.set(key, s); else localStorage.setItem(key, s); } catch (_) { /* ignore */ }
    },
  };
  // ui-state keys are capped at 200 chars. T.store is already per folder, so the root in a
  // key only separates folders in the localStorage fallback; drop it when the path is too long.
  const folderKey = (prefix, root) => { const k = `${prefix}:${root}`; return k.length <= 200 ? k : prefix; };

  function fmtSize(b) {
    if (b == null || isNaN(b)) return "";
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
    return `${(b / 1048576).toFixed(1)} MB`;
  }

  function errMsg(e) {
    if (!e) return "unknown error";
    if (e.name === "AbortError") return "cancelled";
    if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message || "")) return "can't reach the texc server";
    return e.message || String(e);
  }

  function reportError(e, prefix) {
    console.error("[texc]", prefix || "", e);
    toast(`${prefix ? prefix + ": " : ""}${errMsg(e)}`, "error");
  }

  // ------------------------------------------------------------------ server calls
  // Thin wrapper over T.api: a 401 means the page's token is stale (server restarted).
  let authWarned = false;
  function guard(promise) {
    return Promise.resolve(promise).catch((e) => {
      if (e && e.status === 401 && !authWarned) {
        authWarned = true;
        toast("The texc server no longer accepts this page's session (was it restarted?). Reload the page.", "error",
          { timeout: 0, action: { label: "Reload", onClick: () => location.reload() } });
      }
      throw e;
    });
  }
  const api = {
    get: (p, q) => guard(T.api.get(p, q)),
    post: (p, b) => guard(T.api.post(p, b)),
    put: (p, b) => guard(T.api.put(p, b)),
    del: (p) => guard(T.api.del(p)),
  };

  // ------------------------------------------------------------------ sibling modules
  // Every call into T.editor / T.pdf / T.chat goes through call(), so a module that failed to
  // load (or lacks a function) costs one toast instead of breaking the shell.
  const MODULE_LABEL = { editor: "The editor", pdf: "The PDF preview", chat: "The chat" };
  const failed = new Set();
  function moduleFailed(name, err) {
    if (failed.has(name)) return;
    failed.add(name);
    console.error(`[texc] ${name} module failed`, err);
    toast(`${MODULE_LABEL[name] || name} failed to load${err && err.message ? ` (${err.message})` : ""}. The rest of texc keeps working.`, "error", { timeout: 9000 });
  }
  function has(name, fn) {
    const m = T[name];
    return !!m && !failed.has(name) && (!fn || typeof m[fn] === "function");
  }
  function call(name, fn, ...args) {
    const m = T[name];
    if (!m || failed.has(name)) return undefined;
    if (typeof m[fn] !== "function") { console.warn(`[texc] T.${name}.${fn} is not available`); return undefined; }
    try {
      const r = m[fn](...args);
      if (r && typeof r.then === "function") r.then(null, (e) => console.warn(`[texc] T.${name}.${fn} rejected`, e));
      return r;
    } catch (e) {
      console.error(`[texc] T.${name}.${fn} threw`, e);
      return undefined;
    }
  }
  // Like call(), but rejections reach the caller.
  function callAsync(name, fn, ...args) {
    const m = T[name];
    if (!m || failed.has(name) || typeof m[fn] !== "function") return Promise.resolve(undefined);
    try { return Promise.resolve(m[fn](...args)); } catch (e) { return Promise.reject(e); }
  }
  function cmInstance() {
    // CodeMirror 5 hangs its instance on the wrapper element; used only as a read-only fallback.
    const el = $("#editor-host .CodeMirror");
    return el && el.CodeMirror ? el.CodeMirror : null;
  }

  // ------------------------------------------------------------------ project file index
  let fileIndex = new Map(); // path -> {path,type,size,mtime,text}
  const projectRoot = () => (T.state.project && (T.state.project.root || T.state.project.name)) || "default";
  const settings = () => T.state.settings || {};

  function kindOf(path) {
    const f = fileIndex.get(path);
    if (f && f.type === "dir") return "dir";
    const ext = extOf(path);
    if (f && f.text) return "text";
    if (IMAGE_EXT.has(ext)) return "image";
    if (f) return "binary";
    return TEXT_EXT.has(ext) ? "text" : "binary";
  }
  function fileIcon(path) {
    const ext = extOf(path);
    if (ext === "bib") return "file-bib";
    if (TEX_EXT.has(ext)) return "file-tex";
    if (IMAGE_EXT.has(ext)) return "file-image";
    return "file";
  }

  // ================================================================== overlay layers
  // One stack for menus, popovers, modals, overlays and the drawer: Esc closes the topmost,
  // and a pointer-down outside closes "outside" layers from the top until one contains it.
  const layers = [];
  const pushLayer = (l) => (layers.push(l), l);
  const dropLayer = (l) => { const i = layers.indexOf(l); if (i >= 0) layers.splice(i, 1); };
  function closeTopLayer() {
    const l = layers[layers.length - 1];
    if (!l) return false;
    l.close();
    return true;
  }
  document.addEventListener("pointerdown", (e) => {
    for (const l of layers.slice().reverse()) {
      if (!layers.includes(l)) continue;
      if (!l.outside) break; // modal layers block everything below them
      const inside = l.el.contains(e.target) || (l.anchor && l.anchor.contains && l.anchor.contains(e.target));
      if (inside) break;
      l.close();
    }
  }, true);

  // ================================================================== toasts
  let toastBox = null;
  const TOAST_ICON = { info: "alert", success: "check", warn: "alert", error: "alert" };
  function toast(text, kind, opts) {
    kind = kind === "warning" ? "warn" : kind;
    if (!TOAST_ICON[kind]) kind = "info";
    opts = opts || {};
    if (!toastBox || !toastBox.isConnected) {
      toastBox = h("div", { class: "app-toasts", "aria-live": "polite" });
      overlayRoot().append(toastBox);
    }
    const msg = String(text == null ? "" : text);
    // The same message while it is still visible just restarts its timer.
    for (const el of toastBox.children) {
      if (el._msg === msg && el._kind === kind && !el._closing) { el._handle.bump(); return el._handle; }
    }
    const el = h("div", { class: `app-toast is-${kind}`, role: kind === "error" ? "alert" : "status" });
    const ic = h("span", { class: "app-toast-icon", html: icon(TOAST_ICON[kind], 16) });
    const label = h("span", { class: "app-toast-text" }, msg);
    el.append(ic, label);
    let ms = opts.timeout != null ? opts.timeout : kind === "error" ? 7000 : kind === "warn" ? 5000 : 3500;
    let timer = null;
    const arm = () => { clearTimeout(timer); if (ms > 0) timer = setTimeout(() => handle.close(), ms); };
    const handle = {
      el,
      close() {
        if (el._closing) return;
        el._closing = true;
        clearTimeout(timer);
        el.classList.add("is-leaving");
        setTimeout(() => el.remove(), 130);
      },
      update(t, k, timeout) {
        el._msg = String(t == null ? "" : t);
        label.textContent = el._msg;
        if (k && TOAST_ICON[k] && k !== el._kind) {
          el.classList.replace(`is-${el._kind}`, `is-${k}`);
          el._kind = k;
          ic.innerHTML = icon(TOAST_ICON[k], 16);
        }
        if (timeout != null) ms = timeout;
        arm();
        return handle;
      },
      bump() { arm(); el.classList.remove("is-bump"); void el.offsetWidth; el.classList.add("is-bump"); },
    };
    if (opts.action && opts.action.label) {
      el.append(h("button", {
        type: "button", class: "app-toast-action",
        onclick: () => { handle.close(); try { opts.action.onClick && opts.action.onClick(); } catch (e) { console.error(e); } },
      }, opts.action.label));
    }
    el.append(h("button", { type: "button", class: "app-toast-close", "aria-label": "Dismiss", html: icon("close", 14), onclick: () => handle.close() }));
    el._msg = msg;
    el._kind = kind;
    el._handle = handle;
    el.addEventListener("mouseenter", () => clearTimeout(timer));
    el.addEventListener("mouseleave", arm);
    toastBox.append(el);
    const live = Array.from(toastBox.children).filter((c) => !c._closing);
    if (live.length > 4) live.slice(0, live.length - 4).forEach((c) => c._handle.close());
    arm();
    return handle;
  }

  // ================================================================== positioning
  function placeNear(el, anchor, opts) {
    opts = opts || {};
    const gap = opts.gap != null ? opts.gap : 4;
    let r;
    if (anchor && typeof anchor.getBoundingClientRect === "function") r = anchor.getBoundingClientRect();
    else if (anchor && anchor.x != null) r = { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    else r = { left: innerWidth / 2, right: innerWidth / 2, top: 60, bottom: 60 };
    el.style.left = "0px";
    el.style.top = "0px";
    el.style.maxHeight = `${innerHeight - 16}px`;
    const w = el.offsetWidth, ht = el.offsetHeight;
    let left = opts.align === "right" ? r.right - w : r.left;
    left = clamp(left, 8, Math.max(8, innerWidth - 8 - w));
    let top = r.bottom + gap;
    if (top + ht > innerHeight - 8) {
      const above = r.top - gap - ht;
      top = above >= 8 ? above : Math.max(8, innerHeight - 8 - ht);
    }
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  // ================================================================== menus
  let menuLayer = null;
  /* T.app.menu(anchor, items, opts?) -> {el, close} | null
     anchor: an Element (clicking it again toggles the menu) or a point {x, y}.
     items: {label, icon?, onClick, danger?, disabled?, checked?, hint?, title?, submenu?} | '-' | {header}.
     submenu: true only draws the ▸; its onClick opens the next menu.
     opts: {align: 'left'|'right', minWidth, className, onClose}. */
  function menu(anchor, items, opts) {
    opts = opts || {};
    if (menuLayer && anchor && menuLayer.anchor === anchor) { menuLayer.close(); return null; }
    if (menuLayer) menuLayer.close();
    const list = (items || []).filter(Boolean);
    const el = h("div", { class: `app-menu${opts.className ? " " + opts.className : ""}`, role: "menu", tabindex: "-1" });
    if (opts.minWidth) el.style.minWidth = `${Math.round(opts.minWidth)}px`;
    const withIcons = list.some((it) => it !== "-" && (it.icon || it.checked !== undefined));
    if (withIcons) el.classList.add("has-icons");
    const anchorEl = anchor instanceof Element ? anchor : null;
    let closed = false;
    const layer = { kind: "menu", el, anchor: anchorEl, outside: true, close };
    function close() {
      if (closed) return;
      closed = true;
      const hadFocus = el.contains(document.activeElement);
      dropLayer(layer);
      if (menuLayer === layer) menuLayer = null;
      el.remove();
      if (anchorEl) {
        anchorEl.classList.remove("is-menu-open");
        anchorEl.setAttribute("aria-expanded", "false");
        if (hadFocus && anchorEl.isConnected) try { anchorEl.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
      }
      if (typeof opts.onClose === "function") try { opts.onClose(); } catch (e) { console.error(e); }
    }
    for (const it of list) {
      if (it === "-" || it.divider) { el.append(h("div", { class: "app-menu-sep", role: "separator" })); continue; }
      if (it.header) { el.append(h("div", { class: "app-menu-header" }, it.header)); continue; }
      const b = h("button", {
        type: "button",
        class: `app-menu-item${it.danger ? " is-danger" : ""}${it.checked ? " is-checked" : ""}`,
        role: it.checked !== undefined ? "menuitemcheckbox" : "menuitem",
        "aria-checked": it.checked !== undefined ? String(!!it.checked) : null,
        "aria-haspopup": it.submenu ? "menu" : null,
        disabled: !!it.disabled,
        title: it.title || null,
      });
      if (withIcons) b.append(h("span", { class: "app-menu-icon", html: it.icon ? icon(it.icon, 16) : it.checked ? icon("check", 16) : "" }));
      b.append(h("span", { class: "app-menu-label" }, it.label));
      if (it.hint) b.append(h("span", { class: "app-menu-hint" }, it.hint));
      if (it.submenu) b.append(h("span", { class: "app-menu-sub", html: icon("chevron-right", 12) }));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        close();
        if (typeof it.onClick !== "function") return;
        try {
          const r = it.onClick(e);
          if (r && typeof r.then === "function") r.then(null, (err) => reportError(err));
        } catch (err) { reportError(err); }
      });
      el.append(b);
    }
    el.addEventListener("keydown", (e) => {
      const btns = $$(".app-menu-item:not([disabled])", el);
      if (!btns.length) return;
      const i = btns.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); (btns[i + 1] || btns[0]).focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); (i > 0 ? btns[i - 1] : btns[btns.length - 1]).focus(); }
      else if (e.key === "Home") { e.preventDefault(); btns[0].focus(); }
      else if (e.key === "End") { e.preventDefault(); btns[btns.length - 1].focus(); }
      else if (e.key === "Tab") { e.preventDefault(); close(); }
    });
    overlayRoot().append(el);
    placeNear(el, anchor, opts);
    pushLayer(layer);
    menuLayer = layer;
    if (anchorEl) {
      anchorEl.classList.add("is-menu-open");
      anchorEl.setAttribute("aria-expanded", "true");
    }
    requestAnimationFrame(() => { if (!closed) el.focus({ preventScroll: true }); });
    return { el, close };
  }
  window.addEventListener("resize", () => { if (menuLayer) menuLayer.close(); });
  window.addEventListener("blur", () => { if (menuLayer) menuLayer.close(); });

  // ================================================================== modals
  function trapTab(e, root) {
    const f = $$('button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', root)
      .filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* T.app.modal(opts) -> {el, body, buttons, done: Promise<value>, close(value), setBusy(bool)}
     opts: {title, body: fn(bodyEl, handle) | Node | string (plain text), html, actions, width,
            className, dismissable=true, top=false, onClose(value), initialFocus: selector}
     actions: [{label, primary?, danger?, disabled?, value?, onClick?(handle)}]. An action without
     onClick closes with its value (or label). onClick may be async; returning false keeps the
     modal open, and a throw shows an error toast. Default actions: one "Close" button. */
  function modal(opts) {
    opts = opts || {};
    const prevFocus = document.activeElement;
    const dismissable = opts.dismissable !== false;
    const scrim = h("div", { class: `app-scrim${opts.top ? " is-top" : ""}` });
    const card = h("div", { class: `app-modal${opts.className ? " " + opts.className : ""}`, role: "dialog", "aria-modal": "true", tabindex: "-1" });
    if (opts.width) card.style.width = typeof opts.width === "number" ? `${opts.width}px` : opts.width;
    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));
    const handle = { el: card, body: null, buttons: [], done, closed: false, busy: false, close, setBusy };
    const layer = { kind: "modal", el: scrim, outside: false, close: () => { if (dismissable) close(null); } };

    if (opts.title) {
      card.setAttribute("aria-label", opts.title);
      const head = h("div", { class: "app-modal-head" }, h("div", { class: "app-modal-title" }, opts.title));
      if (dismissable) head.append(h("button", { type: "button", class: "icon-btn app-modal-x", "aria-label": "Close", title: "Close", html: icon("close", 16), onclick: () => close(null) }));
      card.append(head);
    }
    const body = h("div", { class: "app-modal-body" });
    handle.body = body;
    card.append(body);
    const actions = opts.actions === undefined ? [{ label: "Close", primary: true }] : opts.actions || [];
    if (actions.length) {
      const foot = h("div", { class: "app-modal-foot" });
      for (const a of actions) {
        const b = h("button", { type: "button", class: `app-btn${a.primary ? " is-primary" : ""}${a.danger ? " is-danger" : ""}`, disabled: !!a.disabled }, a.label);
        b._action = a;
        b.addEventListener("click", () => runAction(a, b));
        handle.buttons.push(b);
        foot.append(b);
      }
      card.append(foot);
    }
    scrim.append(card);

    async function runAction(a, b) {
      if (handle.busy || handle.closed) return;
      if (typeof a.onClick !== "function") { close(a.value !== undefined ? a.value : a.label); return; }
      let r;
      setBusy(true, b);
      try { r = await a.onClick(handle); }
      catch (e) { setBusy(false, b); reportError(e); return; }
      setBusy(false, b);
      if (r === false || handle.closed) return;
      close(a.value !== undefined ? a.value : r !== undefined ? r : a.label);
    }
    function setBusy(on, btn) {
      handle.busy = !!on;
      handle.buttons.forEach((x) => { x.disabled = on ? true : !!x._action.disabled; });
      if (btn) btn.classList.toggle("is-busy", !!on);
      card.classList.toggle("is-busy", !!on);
    }
    function close(value) {
      if (handle.closed) return;
      handle.closed = true;
      dropLayer(layer);
      scrim.remove();
      if (typeof opts.onClose === "function") try { opts.onClose(value); } catch (e) { console.error(e); }
      resolveDone(value === undefined ? null : value);
      if (prevFocus && typeof prevFocus.focus === "function" && document.contains(prevFocus) && !layers.length) {
        try { prevFocus.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
      }
    }

    // A click that starts and ends on the scrim dismisses (so drag-selecting text never does).
    let downOnScrim = false;
    scrim.addEventListener("mousedown", (e) => { downOnScrim = e.target === scrim; });
    scrim.addEventListener("click", (e) => {
      if (downOnScrim && e.target === scrim && dismissable) close(null);
      downOnScrim = false;
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Tab") { trapTab(e, card); return; }
      // keyCode 229: WebKit reports the Enter that commits an IME composition with isComposing false.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !e.defaultPrevented && e.target.tagName === "INPUT" && !/^(checkbox|radio|button|file)$/.test(e.target.type)) {
        const primary = handle.buttons.find((x) => x._action.primary && !x.disabled);
        if (primary) { e.preventDefault(); primary.click(); }
      }
    });

    overlayRoot().append(scrim);
    pushLayer(layer);
    if (typeof opts.body === "function") {
      try { opts.body(body, handle); } catch (e) { console.error(e); body.append(h("div", { class: "app-error" }, errMsg(e))); }
    } else if (opts.body instanceof Node) body.append(opts.body);
    else if (opts.html != null) body.innerHTML = String(opts.html);
    else if (opts.body != null) body.append(h("div", { class: "app-modal-text" }, String(opts.body)));

    requestAnimationFrame(() => {
      if (handle.closed || card.contains(document.activeElement)) return;
      const target = (opts.initialFocus && card.querySelector(opts.initialFocus))
        || card.querySelector("[autofocus]")
        || card.querySelector('input:not([type="hidden"]):not([disabled]):not([type="checkbox"]), textarea:not([disabled])')
        || handle.buttons.find((b) => b._action.primary) || handle.buttons.find((b) => b._action.danger)
        || handle.buttons[handle.buttons.length - 1] || card;
      try { target.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
    });
    return handle;
  }

  /* T.app.choose(text, buttons, opts?) -> Promise<value | null>; buttons: [{label, value, primary?, danger?}] */
  function choose(text, buttons, opts) {
    opts = opts || {};
    return modal({
      title: opts.title || null,
      width: opts.width || 420,
      className: "app-confirm",
      body: (el) => {
        el.append(h("div", { class: "app-modal-text" }, text));
        if (opts.detail) el.append(h("div", { class: "app-modal-detail" }, opts.detail));
      },
      actions: buttons.map((b) => ({ label: b.label, value: b.value === undefined ? b.label : b.value, primary: !!b.primary, danger: !!b.danger })),
    }).done;
  }

  /* T.app.confirm(text, {ok, cancel, danger, title, detail}) -> Promise<bool> */
  function confirm(text, opts) {
    opts = opts || {};
    return choose(text, [
      { label: opts.cancel || "Cancel", value: false },
      { label: opts.ok || "OK", value: true, primary: !opts.danger, danger: !!opts.danger },
    ], opts).then((v) => v === true);
  }

  /* T.app.prompt(label, {title, value, placeholder, ok, cancel, hint, select:[from,to], validate(v) -> message|null}) -> Promise<string|null> */
  function prompt(label, opts) {
    opts = opts || {};
    let input, errEl;
    const m = modal({
      title: opts.title || null,
      width: opts.width || 420,
      className: "app-prompt",
      body: (el) => {
        const id = `app-prompt-${Date.now().toString(36)}`;
        if (label) el.append(h("label", { class: "app-field-label", for: id }, label));
        input = h("input", { id, class: "app-input", type: "text", value: opts.value || "", placeholder: opts.placeholder || "", spellcheck: "false", autocomplete: "off", autocapitalize: "off" });
        errEl = h("div", { class: "app-field-error", role: "alert", hidden: true });
        input.addEventListener("input", () => { errEl.hidden = true; });
        el.append(input, errEl);
        if (opts.hint) el.append(h("div", { class: "app-field-hint" }, opts.hint));
      },
      actions: [
        { label: opts.cancel || "Cancel", value: null },
        {
          label: opts.ok || "OK", primary: true,
          onClick: async () => {
            const raw = input.value;
            const problem = opts.validate ? await opts.validate(raw) : raw.trim() ? null : "Enter a value";
            if (problem) { errEl.textContent = problem; errEl.hidden = false; input.focus(); return false; }
            return raw.trim();
          },
        },
      ],
    });
    // Place the caret (or a selection such as a file stem) once the modal has focused the input.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!input || m.closed) return;
      const [a, b] = opts.select || [input.value.length, input.value.length];
      try { input.setSelectionRange(a, b); } catch (_) { /* ignore */ }
    }));
    return m.done.then((v) => (typeof v === "string" ? v : null));
  }

  // ================================================================== top bar + tabs
  const tabs = []; // [{type:'chat'|'file'|'image', id, title, gone?}]
  let activeKey = null;
  let activateSeq = 0;
  const dirty = new Map(); // path -> unsaved or pending AI hunks
  const chatTitles = new Map(); // chat id -> title
  const opening = new Map(); // path -> in-flight T.editor.open promise
  const tabKey = (t) => (t.type === "chat" ? "chat:" : "path:") + t.id;
  const findTab = (key) => tabs.find((t) => tabKey(t) === key) || null;
  const activeTab = () => findTab(activeKey);
  const tabsStoreKey = () => folderKey("texc:tabs", projectRoot());

  function currentPath() {
    const t = activeTab();
    if (t && t.type !== "chat") return t.id;
    return call("editor", "current") || null;
  }

  function statusSvg(state) {
    if (state === "error" || state === "warn") {
      return '<svg class="ic ic-status" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M12 6.6v6.8" stroke="#0b0b0b" stroke-width="2.8" stroke-linecap="round"/><circle cx="12" cy="17.6" r="1.65" fill="#0b0b0b"/></svg>';
    }
    return icon("alert", 14);
  }

  function renderTopbar() {
    const drawerBtn = $("#btn-drawer"), newBtn = $("#btn-newchat"), toolsBtn = $("#btn-tools"), statusBtn = $("#btn-status");
    if (drawerBtn) { drawerBtn.innerHTML = icon("menu", 16); drawerBtn.setAttribute("aria-label", "Project files"); drawerBtn.setAttribute("aria-expanded", "false"); }
    if (newBtn) { newBtn.innerHTML = icon("compose", 16); newBtn.setAttribute("aria-label", "New chat"); }
    if (toolsBtn) { toolsBtn.innerHTML = `<span>Tools</span>${icon("grid", 14)}`; toolsBtn.setAttribute("aria-haspopup", "menu"); toolsBtn.setAttribute("aria-expanded", "false"); }
    if (statusBtn) statusBtn.setAttribute("aria-haspopup", "dialog");
    updateStatusDot();
  }

  function tabIcon(t) {
    if (t.type === "chat") return "chat";
    if (t.type === "image") return "file-image";
    return fileIcon(t.id);
  }

  function renderTabs() {
    const nav = $("#tabs");
    if (!nav) return;
    const sameName = new Map();
    tabs.forEach((t) => { if (t.type !== "chat") sameName.set(t.title, (sameName.get(t.title) || 0) + 1); });
    const frag = document.createDocumentFragment();
    for (const t of tabs) {
      const key = tabKey(t);
      const isActive = key === activeKey;
      const isDirty = t.type === "file" && !!dirty.get(t.id);
      const el = h("div", {
        class: `app-tab${isActive ? " is-active" : ""}${isDirty ? " is-dirty" : ""}${t.gone ? " is-gone" : ""}`,
        role: "tab", tabindex: isActive ? "0" : "-1", "aria-selected": String(isActive), draggable: "true",
        "data-key": key,
        title: t.type === "chat" ? t.title : `${t.id}${t.gone ? " (deleted on disk)" : isDirty ? " (unsaved changes)" : ""}`,
      });
      el.append(h("span", { class: "app-tab-icon", html: icon(tabIcon(t), 14) }));
      el.append(h("span", { class: "app-tab-title" }, t.title || "Untitled"));
      if (t.type !== "chat" && sameName.get(t.title) > 1 && dirname(t.id)) el.append(h("span", { class: "app-tab-hint" }, basename(dirname(t.id))));
      el.append(h("button", {
        type: "button", class: "app-tab-close", tabindex: "-1",
        "aria-label": `Close ${t.title}`, title: isDirty ? "Unsaved changes" : "Close",
        html: `<span class="app-tab-dot"></span>${icon("close", 12)}`,
      }));
      frag.append(el);
    }
    nav.replaceChildren(frag);
    updateTabFades();
  }

  function updateTabFades() {
    const nav = $("#tabs");
    if (!nav) return;
    nav.classList.toggle("fade-l", nav.scrollLeft > 2);
    nav.classList.toggle("fade-r", nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 2);
  }

  function revealTab(key) {
    const nav = $("#tabs");
    if (!nav) return;
    const el = nav.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!el) return;
    const left = el.offsetLeft, right = left + el.offsetWidth;
    if (left < nav.scrollLeft) nav.scrollLeft = Math.max(0, left - 12);
    else if (right > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = right - nav.clientWidth + 12;
    updateTabFades();
  }

  function persistTabs() {
    if (!T.state.project) return;
    store.set(tabsStoreKey(), { tabs: tabs.map((t) => ({ type: t.type, id: t.id, title: t.title })), active: activeKey });
  }

  function setDirty(path, value) {
    path = normPath(path);
    const v = !!value;
    if (!!dirty.get(path) === v) return;
    if (v) dirty.set(path, true); else dirty.delete(path);
    if (tabs.some((t) => t.type === "file" && t.id === path)) renderTabs();
  }
  function recomputeDirty(path) {
    const pend = call("editor", "pending", path);
    return !!call("editor", "isDirty", path) || (Array.isArray(pend) && pend.length > 0);
  }

  function chatCurrentId() {
    const c = T.chat;
    if (!c || failed.has("chat")) return undefined;
    try {
      let v;
      if (typeof c.current === "function") v = c.current();
      else if (typeof c.currentId === "function") v = c.currentId();
      else if (c.currentId != null) v = c.currentId;
      return v && typeof v === "object" ? v.id : v;
    } catch (_) { return undefined; }
  }

  async function showFileInEditor(path) {
    if (!has("editor")) { showPlainFallback(path); return; }
    if (call("editor", "has", path)) { call("editor", "show", path); return; }
    let p = opening.get(path);
    if (!p) {
      p = callAsync("editor", "open", path).finally(() => opening.delete(path));
      opening.set(path, p);
    }
    await p;
  }

  // Switch the visible view to a tab (docs/ARCHITECTURE.md "Tabs").
  async function activateTab(key, opts) {
    opts = opts || {};
    const tab = findTab(key);
    if (!tab) return;
    const prevKey = activeKey;
    const seq = ++activateSeq;
    activeKey = key;
    renderTabs();
    persistTabs();
    revealTab(key);
    const chatView = $("#chat-view"), editorView = $("#editor-view"), editorHost = $("#editor-host"), imageHost = $("#image-host");
    setModuleNote(null);
    if (tab.type === "chat") {
      if (editorView) editorView.hidden = true;
      if (chatView) chatView.hidden = false;
      call("chat", "setMode", "full");
      if ((prevKey !== key || opts.force) && chatCurrentId() !== tab.id) call("chat", "openChat", tab.id);
      if (!has("chat")) setModuleNote("The chat failed to load (js/chat.js). Files, compiling and the preview still work.");
    } else {
      if (chatView) chatView.hidden = true;
      if (editorView) editorView.hidden = false;
      call("chat", "setMode", "dock");
      if (tab.type === "image") {
        if (editorHost) editorHost.hidden = true;
        if (imageHost) imageHost.hidden = false;
        showImage(tab.id);
      } else {
        const fallback = !has("editor");
        if (imageHost) imageHost.hidden = !fallback;
        if (editorHost) editorHost.hidden = fallback;
        try {
          await showFileInEditor(tab.id);
          if (seq !== activateSeq) return;
          call("editor", "refresh");
        } catch (e) {
          if (seq !== activateSeq) return;
          toast(`Couldn't open ${tab.id}: ${errMsg(e)}`, "error");
          if (e && (e.status === 400 || e.status === 404 || e.status === 415)) { closeTab(key, { force: true }); return; }
        }
      }
    }
    if (seq !== activateSeq) return;
    updateDrawerCurrent();
    bus.emit("tab:changed", { type: tab.type, id: tab.id, title: tab.title });
  }

  // Adds the tab if needed (after the active tab) and activates it.
  function ensureTab(spec, opts) {
    opts = opts || {};
    const key = tabKey(spec);
    let t = findTab(key);
    if (!t) {
      t = { type: spec.type, id: spec.id, title: spec.title || basename(spec.id) };
      const ai = tabs.findIndex((x) => tabKey(x) === activeKey);
      tabs.splice(ai >= 0 ? ai + 1 : tabs.length, 0, t);
    } else if (spec.title && t.type === "chat" && t.title !== spec.title) {
      t.title = spec.title;
    }
    if (opts.activate === false) { renderTabs(); persistTabs(); return Promise.resolve(); }
    return activateTab(key, opts);
  }

  /* T.app.openFile(path, line?, ch?) -> Promise. Opens or activates the file's tab. */
  async function openFile(path, line, ch) {
    path = normPath(path);
    if (!path) return;
    const kind = kindOf(path);
    if (kind === "dir") { openDrawer(path); return; }
    if (kind === "binary") {
      toast(`${basename(path)} is a binary file and can't be opened here.`, "info", {
        action: { label: "Open raw", onClick: () => window.open(T.api.url("/api/raw", { path }), "_blank", "noopener") },
      });
      return;
    }
    await ensureTab({ type: kind === "image" ? "image" : "file", id: path, title: basename(path) });
    const n = Number(line);
    if (kind === "text" && n > 0 && activeKey === `path:${path}` && has("editor")) call("editor", "goto", path, n, Number(ch) || 0);
  }

  /* T.app.newChat() -> Promise. Creates a chat via T.chat.newChat() and opens it as a tab. */
  async function newChatTab(opts) {
    opts = opts || {};
    // Reuse an untouched "New chat" tab instead of piling up empty chats.
    if (!opts.forceNew) {
      const empty = tabs.find((t) => t.type === "chat" && t.untitled);
      if (empty) { await activateTab(tabKey(empty)); focusComposer(); return empty.id; }
    }
    let id = null;
    if (has("chat", "newChat")) {
      try { id = await T.chat.newChat(); } catch (e) { reportError(e, "Couldn't start a new chat"); }
    }
    if (id && typeof id === "object") id = id.id;
    if (!id) id = `local-${Date.now().toString(36)}`;
    id = String(id);
    chatTitles.set(id, "New chat");
    const exists = findTab(`chat:${id}`);
    await ensureTab({ type: "chat", id, title: "New chat" }, { activate: opts.activate, force: true });
    const t = findTab(`chat:${id}`);
    if (t && !exists) t.untitled = true;
    if (opts.activate !== false) focusComposer();
    return id;
  }

  /* T.app.openChatTab(id, title?) -> Promise */
  function openChatTab(id, title) {
    if (!id) return newChatTab();
    id = String(id);
    return ensureTab({ type: "chat", id, title: title || chatTitles.get(id) || "New chat" });
  }

  async function closeTab(key, opts) {
    opts = opts || {};
    const tab = findTab(key);
    if (!tab) return false;
    if (tab.type === "file" && has("editor")) {
      if (!opts.force) {
        const pend = call("editor", "pending", tab.id);
        if (Array.isArray(pend) && pend.length) {
          const v = await choose(`${tab.title} has ${plural(pend.length, "pending AI edit")}.`, [
            { label: "Cancel", value: null },
            { label: "Undo all", value: "undo" },
            { label: "Keep all", value: "keep", primary: true },
          ], { title: "Close tab" });
          if (!v) return false;
          call("editor", "resolveAll", tab.id, v === "keep");
        }
        if (call("editor", "isDirty", tab.id)) {
          try { await callAsync("editor", "save", tab.id); } catch (e) {
            const ok = await confirm(`Couldn't save ${tab.title} (${errMsg(e)}). Close it anyway and lose the changes?`, { ok: "Close anyway", danger: true, title: "Unsaved changes" });
            if (!ok) return false;
          }
        }
      }
      call("editor", "close", tab.id);
    }
    const i = tabs.indexOf(tab);
    if (i < 0) return false;
    tabs.splice(i, 1);
    if (tab.type !== "chat") dirty.delete(tab.id);
    if (tab.type === "image") clearImageHost(tab.id);
    if (!tabs.length) {
      activeKey = null;
      await newChatTab({ forceNew: true });
      return true;
    }
    if (activeKey === key) {
      const next = tabs[i] || tabs[i - 1];
      activeKey = null;
      await activateTab(tabKey(next));
    } else {
      renderTabs();
      persistTabs();
    }
    return true;
  }

  function moveTab(fromKey, toKey, before) {
    const from = findTab(fromKey), to = findTab(toKey);
    if (!from || !to || from === to) return;
    tabs.splice(tabs.indexOf(from), 1);
    const j = tabs.indexOf(to);
    tabs.splice(before ? j : j + 1, 0, from);
    renderTabs();
    persistTabs();
  }

  function tabMenu(key, point) {
    const t = findTab(key);
    if (!t) return;
    const idx = tabs.indexOf(t);
    const items = [
      { label: "Close", onClick: () => closeTab(key) },
      { label: "Close others", disabled: tabs.length < 2, onClick: async () => { for (const o of tabs.slice()) if (o !== t && !(await closeTab(tabKey(o)))) break; } },
      { label: "Close tabs to the right", disabled: idx === tabs.length - 1, onClick: async () => { for (const o of tabs.slice(idx + 1)) if (!(await closeTab(tabKey(o)))) break; } },
    ];
    if (t.type !== "chat") {
      items.push("-", { label: "Reveal in project files", onClick: () => openDrawer(t.id) });
      items.push({ label: "Copy path", onClick: () => copyText(t.id) });
    }
    menu(point, items);
  }

  function copyText(text) {
    const ok = () => toast("Copied", "success", { timeout: 1500 });
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, () => fallbackCopy(text) && ok());
    } else if (fallbackCopy(text)) ok();
  }
  function fallbackCopy(text) {
    const ta = h("textarea", { style: { position: "fixed", left: "-9999px", top: "0" } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    ta.remove();
    if (!ok) toast("Couldn't copy to the clipboard", "error");
    return ok;
  }

  function wireTopbar() {
    const drawerBtn = $("#btn-drawer"), newBtn = $("#btn-newchat"), toolsBtn = $("#btn-tools"), statusBtn = $("#btn-status");
    if (drawerBtn) drawerBtn.addEventListener("click", () => (drawerOpen ? closeDrawer() : openDrawer()));
    if (newBtn) newBtn.addEventListener("click", () => newChatTab({ forceNew: true })); // always a new chat tab
    if (toolsBtn) toolsBtn.addEventListener("click", (e) => toolsMenu(e.currentTarget));
    if (statusBtn) statusBtn.addEventListener("click", (e) => toggleProblems(e.currentTarget));

    const nav = $("#tabs");
    if (!nav) return;
    nav.addEventListener("click", (e) => {
      const el = e.target.closest(".app-tab");
      if (!el) return;
      if (e.target.closest(".app-tab-close")) { e.stopPropagation(); closeTab(el.dataset.key); return; }
      if (el.dataset.key !== activeKey) activateTab(el.dataset.key);
    });
    nav.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll
    // Middle-click closes a tab. WebKit versions without auxclick get the same from mouseup.
    nav.addEventListener("onauxclick" in window ? "auxclick" : "mouseup", (e) => {
      if (e.button !== 1) return;
      const el = e.target.closest(".app-tab");
      if (el) { e.preventDefault(); closeTab(el.dataset.key); }
    });
    nav.addEventListener("contextmenu", (e) => {
      const el = e.target.closest(".app-tab");
      if (!el) return;
      e.preventDefault();
      tabMenu(el.dataset.key, { x: e.clientX, y: e.clientY });
    });
    nav.addEventListener("keydown", (e) => {
      const el = e.target.closest(".app-tab");
      if (!el) return;
      const all = $$(".app-tab", nav);
      const i = all.indexOf(el);
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const n = all[(i + (e.key === "ArrowRight" ? 1 : -1) + all.length) % all.length];
        n.focus();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activateTab(el.dataset.key);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        closeTab(el.dataset.key);
      }
    });
    nav.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && nav.scrollWidth > nav.clientWidth) {
        nav.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
    nav.addEventListener("scroll", updateTabFades, { passive: true });
    window.addEventListener("resize", updateTabFades);

    // Drag to reorder.
    let dragKey = null;
    const clearMarks = () => $$(".drop-before, .drop-after, .is-dragging", nav).forEach((x) => x.classList.remove("drop-before", "drop-after", "is-dragging"));
    nav.addEventListener("dragstart", (e) => {
      const el = e.target.closest && e.target.closest(".app-tab");
      if (!el) return;
      dragKey = el.dataset.key;
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", (findTab(dragKey) || {}).title || ""); } catch (_) { /* ignore */ }
      el.classList.add("is-dragging");
    });
    nav.addEventListener("dragover", (e) => {
      if (!dragKey) return;
      e.preventDefault();
      const el = e.target.closest(".app-tab");
      $$(".drop-before, .drop-after", nav).forEach((x) => x.classList.remove("drop-before", "drop-after"));
      if (el && el.dataset.key !== dragKey) {
        const r = el.getBoundingClientRect();
        el.classList.add(e.clientX < r.left + r.width / 2 ? "drop-before" : "drop-after");
      }
    });
    nav.addEventListener("drop", (e) => {
      if (!dragKey) return;
      e.preventDefault();
      const el = e.target.closest(".app-tab");
      if (el && el.dataset.key !== dragKey) {
        const r = el.getBoundingClientRect();
        moveTab(dragKey, el.dataset.key, e.clientX < r.left + r.width / 2);
      }
      dragKey = null;
      clearMarks();
    });
    nav.addEventListener("dragend", () => { dragKey = null; clearMarks(); });
  }

  // Restores the saved tab row, or opens [New chat (active), <main file>] as in the spec.
  async function restoreTabs() {
    const saved = store.get(tabsStoreKey(), null);
    let chats = [];
    try {
      const r = await api.get("/api/chats");
      if (Array.isArray(r)) chats = r;
    } catch (_) { /* chats are optional at boot */ }
    for (const c of chats) if (c && c.id != null) chatTitles.set(String(c.id), c.title || "Chat");
    const known = new Set(chats.map((c) => c && String(c.id)));

    const restored = [];
    let activeK = null;
    let freshIndex = -1; // where a new chat replaces an active chat that was never saved
    if (saved && Array.isArray(saved.tabs)) {
      for (const s of saved.tabs) {
        if (!s || s.id == null || !["chat", "file", "image"].includes(s.type)) continue;
        const id = String(s.id);
        const key = tabKey({ type: s.type, id });
        if (s.type === "chat") {
          if (known.has(id)) restored.push({ type: "chat", id, title: chatTitles.get(id) || s.title || "Chat" });
          else if (key === saved.active && freshIndex < 0) { freshIndex = restored.length; activeK = "fresh"; }
          else continue;
        } else {
          const p = normPath(id);
          if (!fileIndex.has(p)) continue;
          const kind = kindOf(p);
          if (kind !== "text" && kind !== "image") continue;
          restored.push({ type: kind === "image" ? "image" : "file", id: p, title: basename(p) });
        }
        if (key === saved.active && activeK !== "fresh") activeK = key;
      }
    }
    const main = T.state.main && normPath(T.state.main);
    if (!restored.length && freshIndex < 0) {
      // The default layout.
      freshIndex = 0;
      activeK = "fresh";
      if (main && fileIndex.has(main) && kindOf(main) === "text") restored.push({ type: "file", id: main, title: basename(main) });
    } else if (!restored.some((t) => t.type === "chat") && freshIndex < 0) {
      freshIndex = 0;
    }
    tabs.splice(0, tabs.length, ...restored);
    if (freshIndex >= 0) {
      let id = null;
      if (has("chat", "newChat")) {
        try { id = await T.chat.newChat(); } catch (e) { console.error(e); }
      }
      if (id && typeof id === "object") id = id.id;
      id = String(id || `local-${Date.now().toString(36)}`);
      chatTitles.set(id, "New chat");
      tabs.splice(freshIndex, 0, { type: "chat", id, title: "New chat", untitled: true });
      if (activeK === "fresh") activeK = `chat:${id}`;
    }
    if (!activeK || !findTab(activeK)) activeK = tabKey(tabs[0]);
    renderTabs();
    await activateTab(activeK, { force: true });
  }

  // ================================================================== image tabs
  let dockObserver = null;
  function trackDockHeight() {
    const dock = $("#dock-chat"), host = $("#image-host");
    if (!dock || !host || dockObserver || typeof ResizeObserver !== "function") return;
    const update = () => host.style.setProperty("--dock-h", `${dock.offsetHeight || 0}px`);
    dockObserver = new ResizeObserver(update);
    dockObserver.observe(dock);
    update();
  }

  function showImage(path) {
    const host = $("#image-host");
    if (!host) return;
    trackDockHeight();
    const f = fileIndex.get(path);
    const version = f && f.mtime ? f.mtime : "";
    if (host.dataset.path === path && host.dataset.version === String(version) && host.firstChild) return;
    host.dataset.path = path;
    host.dataset.version = String(version);
    host.classList.remove("is-plain");
    const src = T.api.url("/api/raw", { path, v: version || undefined });
    if (extOf(path) === "pdf") {
      host.replaceChildren(h("iframe", { class: "app-image-pdf", src, title: basename(path) }));
      return;
    }
    const info = h("div", { class: "app-image-info" }, basename(path));
    const img = h("img", { class: "app-image", alt: basename(path), src, draggable: "false", title: "Click to toggle actual size" });
    img.addEventListener("load", () => {
      info.textContent = [basename(path), img.naturalWidth ? `${img.naturalWidth}×${img.naturalHeight}` : "", f ? fmtSize(f.size) : ""].filter(Boolean).join(" · ");
    });
    img.addEventListener("error", () => {
      host.replaceChildren(h("div", { class: "app-image-error" }, `Couldn't load ${path}.`));
    });
    img.addEventListener("click", () => img.classList.toggle("is-actual"));
    host.replaceChildren(h("div", { class: "app-image-stage" }, img), info);
  }

  function clearImageHost(path) {
    const host = $("#image-host");
    if (!host || (path && host.dataset.path !== path)) return;
    host.replaceChildren();
    delete host.dataset.path;
    delete host.dataset.version;
  }

  // Read-only text view, used only when editor.js failed to load.
  async function showPlainFallback(path) {
    const host = $("#image-host");
    if (!host) return;
    host.hidden = false;
    host.classList.add("is-plain");
    host.dataset.path = path;
    delete host.dataset.version;
    const pre = h("pre", { class: "app-plain-pre" }, "Loading…");
    host.replaceChildren(h("div", { class: "app-plain-note" }, "The editor failed to load. Showing a read-only copy."), pre);
    try {
      const r = await api.get("/api/file", { path });
      if (host.dataset.path === path) pre.textContent = (r && r.content) || "";
    } catch (e) {
      if (host.dataset.path === path) pre.textContent = `Couldn't load ${path}: ${errMsg(e)}`;
    }
  }

  let noteEl = null;
  function setModuleNote(text) {
    if (!text) { if (noteEl) noteEl.hidden = true; return; }
    const views = $("#views");
    if (!views) return;
    if (!noteEl) { noteEl = h("div", { class: "app-module-note" }); views.append(noteEl); }
    noteEl.textContent = text;
    noteEl.hidden = false;
  }

  // ================================================================== project drawer
  let drawerOpen = false;
  let drawerLayer = null;
  let drawerTimer = null;
  const folderState = new Map(); // folder path -> open?
  let folderDefaultOpen = true;
  const treeStoreKey = () => folderKey("texc:tree", projectRoot());

  function loadFolderState() {
    folderState.clear();
    const saved = store.get(treeStoreKey(), null);
    if (saved && typeof saved === "object") for (const k of Object.keys(saved)) folderState.set(k, !!saved[k]);
  }
  const isFolderOpen = (p) => (folderState.has(p) ? folderState.get(p) : folderDefaultOpen);
  function setFolderOpen(p, open) {
    folderState.set(p, !!open);
    const obj = {};
    folderState.forEach((v, k) => { obj[k] = v; });
    store.set(treeStoreKey(), obj);
  }
  function expandAncestors(path) {
    let d = dirname(path);
    while (d) {
      if (!isFolderOpen(d)) setFolderOpen(d, true);
      d = dirname(d);
    }
  }

  function buildTree(files) {
    const root = { name: "", path: "", type: "dir", children: new Map() };
    for (const f of files) {
      const parts = normPath(f.path).split("/").filter(Boolean);
      let node = root;
      let acc = "";
      parts.forEach((part, i) => {
        acc = acc ? `${acc}/${part}` : part;
        const last = i === parts.length - 1;
        let child = node.children.get(part);
        if (!child) {
          child = { name: part, path: acc, type: last ? f.type || "file" : "dir", children: new Map(), info: null };
          node.children.set(part, child);
        }
        if (last) { child.type = f.type || "file"; child.info = f; }
        node = child;
      });
    }
    return root;
  }
  function sortedChildren(node) {
    return Array.from(node.children.values()).sort((a, b) => {
      if ((a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
  }

  function buildDrawerShell() {
    const d = $("#drawer");
    if (!d) return;
    d.setAttribute("aria-label", "Project files");
    d.replaceChildren();
    const head = h("div", { class: "app-drawer-head" },
      h("div", { class: "app-drawer-namerow" },
        h("button", { type: "button", class: "app-drawer-name", id: "app-drawer-name", "aria-haspopup": "menu", "aria-expanded": "false", onclick: (e) => folderMenu(e.currentTarget) }),
        h("button", { type: "button", class: "icon-btn app-drawer-close", title: "Close", "aria-label": "Close project files", html: icon("close", 16), onclick: () => closeDrawer() })),
      h("button", { type: "button", class: "app-drawer-main", id: "app-drawer-main", "aria-haspopup": "menu", title: "Choose the main file", onclick: (e) => mainFileMenu(e.currentTarget) }));
    const tree = h("div", { class: "app-tree", id: "app-tree", role: "tree", tabindex: "0", "aria-label": "Files" });
    const foot = h("div", { class: "app-drawer-foot" },
      h("button", { type: "button", class: "app-drawer-btn", title: "Create a file", onclick: () => newEntry("file", "") }, "New file"),
      h("button", { type: "button", class: "app-drawer-btn", title: "Create a folder", onclick: () => newEntry("dir", "") }, "New folder"),
      h("button", { type: "button", class: "app-drawer-btn", title: "Upload files (or drop them here)", onclick: () => pickUpload("") }, "Upload"));
    d.append(head, tree, foot);
    wireTree(tree);
    wireDrawerDrop(d);
  }

  function renderDrawer() {
    if (!$("#app-tree")) buildDrawerShell();
    const p = T.state.project || {};
    const nameEl = $("#app-drawer-name");
    if (nameEl) {
      const name = p.name || "Project";
      nameEl.innerHTML = `<span class="app-drawer-name-icon">${icon("folder", 15)}</span><span class="app-drawer-name-text">${esc(name)}</span>${icon("chevron-down", 12)}`;
      nameEl.title = p.folder || p.root || name;
      nameEl.setAttribute("aria-label", `${name}: folder menu`);
    }
    const mainBtn = $("#app-drawer-main");
    if (mainBtn) {
      const main = mainMissing() ? "none" : T.state.main || "none";
      mainBtn.innerHTML = `<span class="app-drawer-main-label">Main file:</span><span class="app-drawer-main-name">${esc(main)}</span>${icon("chevron-down", 12)}`;
    }
    renderTree();
  }

  // ---- folder menu (docs/ARCHITECTURE.md): the drawer header's folder name
  // Endpoints that answer 404 (an older server) hide their item from then on.
  const missingApi = new Set();
  const isMissing = (e) => !!e && (e.status === 404 || e.status === 405);
  // The folder actions need the native shell or a server that knows about folders (it sends `app`).
  const hostReady = () => !!T.host && (T.host.native || "app" in (T.state.project || {}));
  const samePath = (a, b) => String(a || "").replace(/\/+$/, "") === String(b || "").replace(/\/+$/, "");
  const midTrunc = (s, n) => { s = String(s || ""); if (s.length <= n) return s; const k = Math.floor((n - 1) / 2); return `${s.slice(0, k)}…${s.slice(s.length - (n - 1 - k))}`; };

  async function fetchRecent() {
    if (missingApi.has("recent")) return null;
    try {
      const r = await withTimeout(T.api.get("/api/recent"), 2000);
      return Array.isArray(r && r.recent) ? r.recent : [];
    } catch (e) {
      if (isMissing(e)) missingApi.add("recent");
      return null;
    }
  }

  let folderMenuPending = false;
  async function folderMenu(anchor) {
    if (menuLayer && menuLayer.anchor === anchor) { menuLayer.close(); return; }
    if (folderMenuPending) return;                  // a second click while Recent loads
    const p = T.state.project || {};
    const host = hostReady() ? T.host : null;
    let recent = null;
    folderMenuPending = true;
    try { recent = host ? await fetchRecent() : null; } finally { folderMenuPending = false; }
    if (!anchor.isConnected || !drawerOpen) return;
    const here = p.folder || p.root || "";
    const others = (recent || []).filter((r) => r && r.path && !samePath(r.path, here)).slice(0, 8);
    const items = [];
    if (host) items.push({ label: "Open Folder…", icon: "folder-open", hint: host.native ? "⌘O" : null, onClick: openFolderFlow });
    if (host && recent) {
      items.push({
        label: "Open Recent", icon: "history", submenu: true, disabled: !others.length,
        title: others.length ? null : "No other recent folders", onClick: () => recentMenu(anchor, others),
      });
    }
    const lobby = host && !host.native ? host.lobbyUrl : null;
    if (host && (host.native || lobby)) items.push({ label: "New Project…", icon: "plus", hint: host.native ? "⌘N" : null, onClick: newProjectFlow });
    if (items.length) items.push("-");
    if (!missingApi.has("reveal")) items.push({ label: "Reveal in Finder", icon: "external", onClick: revealFolder });
    if (host && host.canCloseFolder) items.push({ label: "Close Folder", icon: "close", onClick: closeFolderFlow });
    if (!items.length || items.every((it) => it === "-")) items.splice(0, items.length, { label: "No folder actions with this texc server", disabled: true });
    while (items[items.length - 1] === "-") items.pop();
    menu(anchor, items, { minWidth: 230 });
  }

  // "Open Recent ▸": a second menu on the same anchor.
  function recentMenu(anchor, list) {
    const items = [{ header: "Open Recent" }];
    for (const r of list) {
      const where = r.display || r.path;
      items.push({
        label: r.name || basename(r.path), icon: "folder", disabled: r.exists === false,
        hint: r.exists === false ? "not available" : midTrunc(where, 30), title: where,
        onClick: (e) => openFolderPath(r.path, { newWindow: !!(e && e.metaKey && T.host && T.host.native) }),
      });
    }
    menu(anchor, items, { minWidth: 280 });
  }

  async function openFolderFlow() {
    let path = null;
    try {
      path = await T.host.pickFolder("Open a LaTeX folder");
    } catch (e) {
      if (!e || e.code !== "no_picker") { reportError(e, "Couldn't choose a folder"); return; }
      path = await prompt("Folder", {
        title: "Open Folder", placeholder: "~/Documents/paper", ok: "Open",
        hint: "The folder's full path; ~ is allowed.",
      });
    }
    if (path) await openFolderPath(path);
  }

  async function openFolderPath(path, opts) {
    try {
      const r = await T.host.openFolder(path, opts || {});
      if (r === "opened" || r === true) closeDrawer();
    } catch (e) {
      if (isMissing(e)) toast("Opening another folder needs a newer texc server.", "info");
      else reportError(e, "Couldn't open the folder");
    }
  }

  function newProjectFlow() {
    const host = T.host;
    if (host.native) return host.call("newProject").catch((e) => reportError(e, "Couldn't start a new project"));
    if (!host.lobbyUrl) return undefined;
    // Browser: the Welcome page opens its New Project dialog; this folder stays open here.
    let u;
    try { u = new URL(host.lobbyUrl, location.href); u.searchParams.set("new", "1"); } catch (_) { u = null; }
    window.open(u ? u.href : `${host.lobbyUrl}?new=1`, "_blank", "noopener");
    return undefined;
  }

  async function revealFolder() {
    try {
      await (T.host ? T.host.reveal("") : T.api.post("/api/reveal", { path: "" }));
    } catch (e) {
      if (isMissing(e)) { missingApi.add("reveal"); toast("Reveal in Finder needs a newer texc server.", "info"); }
      else reportError(e, "Couldn't reveal the folder");
    }
  }

  async function closeFolderFlow() {
    try { await T.host.closeFolder(); } catch (e) { reportError(e, "Couldn't close the folder"); }
  }

  function renderTree() {
    const tree = $("#app-tree");
    if (!tree) return;
    const files = (T.state.project && T.state.project.files) || [];
    if (!T.state.project) { tree.innerHTML = '<div class="app-tree-empty">Loading files…</div>'; return; }
    if (!files.length) { tree.innerHTML = '<div class="app-tree-empty">This folder is empty. Create or upload a file.</div>'; return; }
    const root = buildTree(files);
    const cur = currentPath();
    const main = T.state.main;
    const rows = [];
    const walk = (node, depth) => {
      for (const c of sortedChildren(node)) {
        const isDir = c.type === "dir";
        const open = isDir && isFolderOpen(c.path);
        const ic = isDir ? (open ? "folder-open" : "folder") : fileIcon(c.path);
        rows.push(
          `<div class="app-tree-row ${isDir ? "is-dir" : "is-file"}${c.path === cur ? " is-current" : ""}" role="treeitem" tabindex="-1"`
          + ` data-path="${esc(c.path)}" data-type="${isDir ? "dir" : "file"}" style="--depth:${depth}"${isDir ? ` aria-expanded="${open}"` : ""} title="${esc(c.path)}">`
          + `<span class="app-tree-chev">${isDir ? icon(open ? "chevron-down" : "chevron-right", 12) : ""}</span>`
          + `<span class="app-tree-icon">${icon(ic, 15)}</span>`
          + `<span class="app-tree-name">${esc(c.name)}</span>`
          + (!isDir && c.path === main ? '<span class="app-tree-badge">main</span>' : "")
          + `<button type="button" class="app-tree-more" tabindex="-1" aria-label="Actions for ${esc(c.name)}" title="More">${icon("more", 14)}</button>`
          + "</div>");
        if (open) walk(c, depth + 1);
      }
    };
    walk(root, 0);
    tree.innerHTML = rows.join("");
  }

  function updateDrawerCurrent() {
    if (!drawerOpen) return;
    const cur = currentPath();
    $$(".app-tree-row", $("#app-tree") || document).forEach((r) => r.classList.toggle("is-current", r.dataset.path === cur));
  }

  const rowFor = (path) => { const tree = $("#app-tree"); return tree ? tree.querySelector(`.app-tree-row[data-path="${CSS.escape(path)}"]`) : null; };

  function openDrawer(reveal) {
    const d = $("#drawer");
    if (!d) return;
    const target = reveal ? normPath(reveal) : currentPath();
    if (target) expandAncestors(target);
    renderDrawer();
    if (!drawerOpen) {
      drawerOpen = true;
      clearTimeout(drawerTimer);
      d.hidden = false;
      void d.offsetWidth; // start the slide-in from the off-screen position
      d.classList.add("is-open");
      const btn = $("#btn-drawer");
      if (btn) btn.setAttribute("aria-expanded", "true");
      drawerLayer = pushLayer({ kind: "drawer", el: d, anchor: btn, outside: true, close: closeDrawer });
    }
    requestAnimationFrame(() => {
      const row = (target && rowFor(target)) || $(".app-tree-row.is-current") || $(".app-tree-row");
      if (row) {
        row.scrollIntoView({ block: "nearest" });
        row.focus({ preventScroll: true });
        if (reveal) { row.classList.add("is-flash"); setTimeout(() => row.classList.remove("is-flash"), 900); }
      } else {
        const tree = $("#app-tree");
        if (tree) tree.focus({ preventScroll: true });
      }
    });
  }

  function closeDrawer() {
    if (!drawerOpen) return;
    drawerOpen = false;
    if (drawerLayer) dropLayer(drawerLayer);
    drawerLayer = null;
    const d = $("#drawer");
    if (!d) return;
    const hadFocus = d.contains(document.activeElement);
    d.classList.remove("is-open");
    const btn = $("#btn-drawer");
    if (btn) btn.setAttribute("aria-expanded", "false");
    clearTimeout(drawerTimer);
    drawerTimer = setTimeout(() => { if (!drawerOpen) d.hidden = true; }, 170);
    if (hadFocus) document.activeElement.blur();
  }

  function wireTree(tree) {
    tree.addEventListener("click", (e) => {
      const row = e.target.closest(".app-tree-row");
      if (!row) return;
      const path = row.dataset.path;
      const isDir = row.dataset.type === "dir";
      const more = e.target.closest(".app-tree-more");
      if (more) { e.stopPropagation(); rowMenu(row, more); return; }
      if (isDir) {
        setFolderOpen(path, !isFolderOpen(path));
        renderTree();
        const r = rowFor(path);
        if (r) r.focus({ preventScroll: true });
        return;
      }
      closeDrawer();
      openFile(path);
    });
    tree.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".app-tree-row");
      if (!row) return;
      e.preventDefault();
      rowMenu(row, { x: e.clientX, y: e.clientY });
    });
    tree.addEventListener("focus", (e) => {
      if (e.target !== tree) return;
      const row = $(".app-tree-row.is-current", tree) || $(".app-tree-row", tree);
      if (row) row.focus({ preventScroll: true });
    });
    tree.addEventListener("keydown", (e) => {
      const rows = $$(".app-tree-row", tree);
      const row = e.target.closest(".app-tree-row");
      const i = rows.indexOf(row);
      const focusAt = (j) => { const r = rows[clamp(j, 0, rows.length - 1)]; if (r) { r.focus({ preventScroll: true }); r.scrollIntoView({ block: "nearest" }); } };
      if (e.key === "ArrowDown") { e.preventDefault(); focusAt(i + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); focusAt(i < 0 ? 0 : i - 1); }
      else if (!row) return;
      else if (e.key === "ArrowRight" && row.dataset.type === "dir") {
        e.preventDefault();
        if (!isFolderOpen(row.dataset.path)) { setFolderOpen(row.dataset.path, true); renderTree(); focusAt(i); } else focusAt(i + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (row.dataset.type === "dir" && isFolderOpen(row.dataset.path)) { setFolderOpen(row.dataset.path, false); renderTree(); focusAt(i); }
        else { const parent = dirname(row.dataset.path); const pr = parent && rowFor(parent); if (pr) { pr.focus({ preventScroll: true }); pr.scrollIntoView({ block: "nearest" }); } }
      } else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); row.click(); }
      else if (e.key === "F2") { e.preventDefault(); renameEntry(row.dataset.path, row.dataset.type === "dir"); }
      else if (e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); deleteEntry(row.dataset.path, row.dataset.type === "dir"); }
    });
  }

  function rowMenu(row, anchor) {
    const path = row.dataset.path;
    const isDir = row.dataset.type === "dir";
    const items = [];
    if (isDir) {
      items.push(
        { label: "New file…", icon: "file-plus", onClick: () => newEntry("file", path) },
        { label: "New folder…", icon: "folder", onClick: () => newEntry("dir", path) },
        { label: "Upload here…", icon: "upload", onClick: () => pickUpload(path) },
        "-");
    }
    items.push({ label: "Rename…", icon: "edit", onClick: () => renameEntry(path, isDir) });
    if (!isDir && /\.(tex|ltx)$/i.test(path)) {
      items.push({ label: "Set as main file", icon: "star", disabled: path === T.state.main, onClick: () => setMain(path) });
    }
    items.push("-", { label: "Delete", icon: "trash", danger: true, onClick: () => deleteEntry(path, isDir) });
    row.classList.add("is-menu-open");
    menu(anchor, items, { onClose: () => row.classList.remove("is-menu-open") });
  }

  function mainFileMenu(anchor) {
    const texFiles = ((T.state.project && T.state.project.files) || [])
      .filter((f) => f.type !== "dir" && /\.(tex|ltx)$/i.test(f.path))
      .map((f) => normPath(f.path))
      .sort((a, b) => (a.split("/").length - b.split("/").length) || a.localeCompare(b, undefined, { numeric: true }));
    if (!texFiles.length) { menu(anchor, [{ label: "No .tex files in this project", disabled: true }]); return; }
    menu(anchor, texFiles.slice(0, 300).map((p) => ({ label: p, checked: p === T.state.main, onClick: () => setMain(p) })), { minWidth: anchor.offsetWidth });
  }

  async function setMain(path) {
    path = normPath(path);
    if (!path || path === T.state.main) return;
    try {
      const r = await api.post("/api/main", { path });
      T.state.main = normPath((r && r.main) || path);
      if (T.state.project) {
        T.state.project.main = T.state.main;
        if (fileIndex.has(T.state.main)) T.state.project.main_exists = true;
      }
      syncNoMain(false);
      if (drawerOpen) renderDrawer();
      toast(`Main file: ${T.state.main}`, "success");
      bus.emit("main:changed", { main: T.state.main });
      loadedPdf = null; // the shown PDF belongs to the previous main file
      requestCompile();
    } catch (e) {
      reportError(e, "Couldn't set the main file");
    }
  }

  // ---- no main file (docs/ARCHITECTURE.md)
  // The server reports a missing main as main_exists:false (its main is then a virtual "main.tex")
  // and answers compiles with a no_main result. Neither is an error: the preview shows an empty
  // state with Create main.tex / Choose main file….
  let mainWasMissing = null; // null until the first project load
  function mainMissing() {
    const p = T.state.project;
    if (p && typeof p.main_exists === "boolean") return !p.main_exists;
    const r = T.state.lastCompile;
    return !!(r && r.no_main);
  }
  // compileOnFound: a refresh found the main file that was missing, so build it.
  function syncNoMain(compileOnFound) {
    const missing = mainMissing();
    const was = mainWasMissing;
    mainWasMissing = missing;
    if (missing === was) return;
    if (modulesReady) call("pdf", "showNoMain", missing);
    updateStatusDot();
    if (drawerOpen) renderDrawer();
    if (was === true && !missing) {
      loadedPdf = null;
      // The server's watcher may already be building the adopted file (compile on save).
      if (compileOnFound && !sseBuilding) requestCompile();
    }
  }

  let creatingMain = false;
  async function createMain() {
    if (creatingMain) return;                       // a double click must not scaffold twice
    if (missingApi.has("scaffold")) { toast("Creating a main file needs a newer texc server.", "info"); return; }
    let r;
    creatingMain = true;
    try {
      r = await api.post("/api/scaffold", { template: "article" });
    } catch (e) {
      if (isMissing(e)) { missingApi.add("scaffold"); toast("Creating a main file needs a newer texc server.", "info"); }
      else reportError(e, "Couldn't create main.tex");
      return;
    } finally {
      creatingMain = false;
    }
    const created = (r && Array.isArray(r.created) ? r.created : []).map(normPath);
    await refreshProject();
    const main = normPath((r && r.main) || T.state.main);
    if (main && T.state.project && fileIndex.has(main)) {
      T.state.project.main_exists = true;
      syncNoMain(false);
      try { await openFile(main); } catch (_) { /* the compile still runs */ }
    }
    toast(created.length ? `Created ${created.join(", ")}` : `Main file: ${main}`, "success");
    requestCompile();
  }

  const cleanRelPath = (v) => normPath(String(v || "").trim()).replace(/\/+$/, "");
  function validatePath(raw, type, from) {
    const v = String(raw || "").trim();
    if (!v) return "Enter a name.";
    if (type === "file" && /[\\/]$/.test(v)) return "Enter a file name after the folder.";
    const p = cleanRelPath(v);
    if (!p) return "Enter a name.";
    if (p.split("/").some((s) => s === ".." || s === ".")) return "Use a path inside the project.";
    if (/^\.texc(\/|$)/i.test(p)) return ".texc/ is reserved for build files.";
    if (/[\u0000-\u001f]/.test(p)) return "The name contains control characters.";
    if (p !== from && fileIndex.has(p)) return `${p} already exists.`;
    if (from && type === "dir" && p.startsWith(`${from}/`)) return "A folder can't move inside itself.";
    return null;
  }

  async function newEntry(type, folder) {
    const isDir = type === "dir";
    const value = await prompt(isDir ? "Folder path" : "File path", {
      title: isDir ? "New folder" : "New file",
      value: folder ? `${folder}/` : "",
      placeholder: isDir ? "figures" : "sections/method.tex",
      ok: "Create",
      hint: "Relative to the project folder.",
      validate: (v) => validatePath(v, type),
    });
    if (!value) return;
    const path = cleanRelPath(value);
    try {
      await api.post("/api/file/new", { path, type: isDir ? "dir" : "file" });
    } catch (e) {
      toast(e && e.status === 409 ? `${path} already exists.` : `Couldn't create ${path}: ${errMsg(e)}`, "error");
      return;
    }
    expandAncestors(path);
    if (isDir) setFolderOpen(path, true);
    await refreshProject();
    if (isDir) { toast(`Created ${path}/`, "success"); return; }
    closeDrawer();
    await openFile(path);
  }

  async function renameEntry(path, isDir) {
    const base = basename(path);
    const dot = isDir ? -1 : base.lastIndexOf(".");
    const start = path.length - base.length;
    const value = await prompt(isDir ? "New folder path" : "New file path", {
      title: `Rename ${base}`,
      value: path,
      ok: "Rename",
      select: [start, dot > 0 ? start + dot : path.length],
      validate: (v) => validatePath(v, isDir ? "dir" : "file", path),
    });
    if (!value) return;
    const to = cleanRelPath(value);
    if (!to || to === path) return;
    const inside = (p) => p === path || (isDir && p.startsWith(`${path}/`));
    const affected = tabs.filter((t) => t.type !== "chat" && inside(t.id));
    for (const t of affected) {
      const pend = t.type === "file" ? call("editor", "pending", t.id) : null;
      if (Array.isArray(pend) && pend.length) { toast(`Keep or undo the pending AI edits in ${t.title} first.`, "warn"); return; }
    }
    for (const t of affected) {
      if (t.type === "file" && call("editor", "isDirty", t.id)) {
        try { await callAsync("editor", "save", t.id); } catch (e) { reportError(e, `Couldn't save ${t.title}`); return; }
      }
    }
    try {
      await api.post("/api/file/rename", { from: path, to });
    } catch (e) {
      reportError(e, `Couldn't rename ${base}`);
      return;
    }
    let activeMoved = false;
    for (const t of affected) {
      const np = to + t.id.slice(path.length);
      if (t.type === "file") call("editor", "close", t.id); // reopened from its new path
      dirty.delete(t.id);
      if (activeKey === tabKey(t)) { activeKey = `path:${np}`; activeMoved = true; }
      if (t.type === "image") clearImageHost(t.id);
      t.id = np;
      t.title = basename(np);
    }
    if (isDir) {
      for (const [k, v] of Array.from(folderState.entries())) if (inside(k)) { folderState.delete(k); setFolderOpen(to + k.slice(path.length), v); }
    }
    const main = T.state.main;
    if (main && inside(main)) {
      const nm = to + main.slice(path.length);
      try { const r = await api.post("/api/main", { path: nm }); T.state.main = normPath((r && r.main) || nm); }
      catch (_) { T.state.main = nm; }
      if (T.state.project) T.state.project.main = T.state.main;
    }
    await refreshProject();
    renderTabs();
    persistTabs();
    if (activeMoved) activateTab(activeKey, { force: true });
    toast(`Renamed to ${to}`, "success");
  }

  async function deleteEntry(path, isDir) {
    const main = T.state.main;
    const inside = (p) => p === path || (isDir && p.startsWith(`${path}/`));
    const ok = await confirm(isDir ? `Move the folder “${path}” and everything in it to .texc/trash/?` : `Move “${path}” to .texc/trash/?`, {
      title: "Delete", ok: "Move to trash", danger: true,
      detail: main && inside(main) ? "This is (or contains) the main file. Choose another main file before compiling." : "You can restore it from the project's .texc/trash/ folder.",
    });
    if (!ok) return;
    let r;
    try {
      r = await api.post("/api/file/delete", { path });
    } catch (e) {
      reportError(e, `Couldn't delete ${basename(path)}`);
      return;
    }
    for (const t of tabs.filter((x) => x.type !== "chat" && inside(x.id))) await closeTab(tabKey(t), { force: true });
    toast(`Moved to ${(r && r.trashed) || ".texc/trash/"}`, "success");
    await refreshProject();
  }

  // ---- uploads
  let uploadInput = null;
  function pickUpload(folder) {
    if (!uploadInput) {
      uploadInput = h("input", { type: "file", multiple: true, hidden: true });
      uploadInput.addEventListener("change", () => {
        const files = Array.from(uploadInput.files || []);
        const target = uploadInput._folder || "";
        uploadInput.value = "";
        if (files.length) uploadFiles(files, target);
      });
      document.body.append(uploadInput);
    }
    uploadInput._folder = folder || "";
    uploadInput.click();
  }

  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
      r.onerror = () => reject(r.error || new Error("couldn't read the file"));
      r.readAsDataURL(file);
    });
  }

  async function uploadFiles(files, folder) {
    files = Array.from(files || []).filter((f) => f && f.name);
    if (!files.length) return;
    const tooBig = files.filter((f) => f.size > UPLOAD_MAX);
    if (tooBig.length) toast(`${tooBig.map((f) => f.name).join(", ")}: larger than 25 MB, skipped.`, "error");
    const list = files.filter((f) => f.size <= UPLOAD_MAX);
    if (!list.length) return;
    const progress = toast(`Uploading ${plural(list.length, "file")}…`, "info", { timeout: 0 });
    let okCount = 0;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const path = cleanRelPath(`${folder ? folder + "/" : ""}${f.name}`);
      if (fileIndex.has(path)) {
        const replace = await confirm(`${path} already exists. Replace it?`, { ok: "Replace", title: "Upload" });
        if (!replace) continue;
      }
      progress.update(list.length > 1 ? `Uploading ${f.name} (${i + 1} of ${list.length})…` : `Uploading ${f.name}…`);
      try {
        const data = await readBase64(f);
        await api.post("/api/upload", { path, data_base64: data });
        okCount++;
      } catch (e) {
        toast(`Couldn't upload ${f.name}: ${errMsg(e)}`, "error");
      }
    }
    progress.close();
    if (okCount) {
      if (folder) expandAncestors(`${folder}/x`);
      toast(`Uploaded ${plural(okCount, "file")}${folder ? ` to ${folder}/` : ""}`, "success");
      await refreshProject();
    }
  }

  const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files"));
  function wireDrawerDrop(d) {
    let depth = 0;
    const clear = () => { depth = 0; d.classList.remove("is-drop"); $$(".app-tree-row.is-drop", d).forEach((r) => r.classList.remove("is-drop")); };
    const folderAt = (target) => {
      const row = target.closest && target.closest(".app-tree-row");
      if (!row) return { folder: "", row: null };
      const dirRow = row.dataset.type === "dir" ? row : rowFor(dirname(row.dataset.path));
      return { folder: dirRow ? dirRow.dataset.path : "", row: dirRow };
    };
    d.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; d.classList.add("is-drop"); });
    d.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      const { row } = folderAt(e.target);
      $$(".app-tree-row.is-drop", d).forEach((r) => { if (r !== row) r.classList.remove("is-drop"); });
      if (row) row.classList.add("is-drop");
    });
    d.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; if (--depth <= 0) clear(); });
    d.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const { folder } = folderAt(e.target);
      const files = Array.from(e.dataTransfer.files || []);
      clear();
      uploadFiles(files, folder);
    });
  }

  // ---- project refresh (after SSE `files`, CRUD, reconnects)
  let refreshing = null;
  let refreshAgain = false;
  function refreshProject() {
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      try {
        do {
          refreshAgain = false;
          const p = await api.get("/api/project");
          applyProject(p);
          if (p && p.last_result) handleCompileResult(p.last_result, "refresh");
        } while (refreshAgain);
      } catch (e) {
        console.warn("[texc] project refresh failed", e);
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }
  const refreshProjectSoon = (U.debounce || ((f) => f))(() => refreshProject(), 250);

  function applyProject(p) {
    if (!p || typeof p !== "object") return;
    T.state.project = p;
    if (p.settings) T.state.settings = p.settings;
    if (p.ai) T.state.ai = p.ai;
    if (p.main) T.state.main = normPath(p.main);
    fileIndex = new Map((p.files || []).map((f) => [normPath(f.path), f]));
    folderDefaultOpen = fileIndex.size <= 300;
    let changed = false;
    for (const t of tabs) {
      if (t.type === "chat") continue;
      const gone = !fileIndex.has(t.id);
      if (!!t.gone !== gone) { t.gone = gone; changed = true; }
    }
    if (changed) renderTabs();
    if (drawerOpen) renderDrawer();
    const at = activeTab();
    if (at && at.type === "image") showImage(at.id); // reloads when the image changed on disk
    syncNoMain(true);
    bus.emit("files", { files: p.files || [] });
  }

  // ================================================================== compile orchestration
  const seenIds = new Set();
  let maxId = 0;
  let postsInFlight = 0;
  let sseBuilding = false;
  let sseBuildTimer = null;
  let saveGen = 0; // bumps on every file:saved
  let sentGen = -1; // saveGen when the last POST /api/compile went out
  let lastPost = null;
  let preparing = null;
  let loadedPdf = null;
  let loadingPdf = null;

  const saveCompile = (U.debounce || ((f) => f))(() => requestCompile(), 600);

  function updateCompiling() {
    const busy = postsInFlight > 0 || sseBuilding;
    call("pdf", "setCompiling", busy);
    const dot = $("#btn-status");
    if (dot) dot.classList.toggle("is-compiling", busy);
  }

  /* T.app.compile({clean?, engine?}) -> Promise<result | null>
     Saves every dirty file, optionally cleans, then POSTs /api/compile. Requests that arrive
     while files are still being saved merge into that compile, and a request made while a
     build is running is skipped when nothing was saved since that build started. */
  function requestCompile(opts) {
    opts = opts || {};
    saveCompile.cancel && saveCompile.cancel();
    if (preparing) {
      preparing.clean = preparing.clean || !!opts.clean;
      return preparing.promise;
    }
    const st = (preparing = { clean: !!opts.clean, engine: opts.engine || null, promise: null });
    st.promise = prepareAndPost(st);
    return st.promise;
  }

  async function prepareAndPost(st) {
    await Promise.resolve();
    try {
      if (has("editor", "saveAll")) {
        try { await T.editor.saveAll(); } catch (e) { toast(`Couldn't save before compiling: ${errMsg(e)}`, "error"); }
      }
      saveCompile.cancel && saveCompile.cancel(); // saves made just now are part of this compile
      if (st.clean) {
        try { await api.post("/api/clean"); loadedPdf = null; } catch (e) { toast(`Couldn't clean the build files: ${errMsg(e)}`, "error"); }
      } else if (postsInFlight > 0 && saveGen === sentGen && lastPost) {
        return lastPost; // the running build already has everything
      }
    } finally {
      if (preparing === st) preparing = null;
    }
    return postCompile(st.engine);
  }

  function postCompile(engine) {
    sentGen = saveGen;
    postsInFlight++;
    updateCompiling();
    const p = (async () => {
      try {
        const r = await api.post("/api/compile", engine ? { engine } : {});
        handleCompileResult(r, "post");
        return r;
      } catch (e) {
        toast(`Compile request failed: ${errMsg(e)}`, "error");
        return null;
      } finally {
        postsInFlight--;
        updateCompiling();
      }
    })();
    lastPost = p;
    return p;
  }

  function loadPdf(url) {
    if (!url || !has("pdf", "load")) return;
    if (url === loadedPdf || url === loadingPdf) return;
    loadingPdf = url;
    // A load still in flight when the main file disappears must not replace the no-main state.
    callAsync("pdf", "load", url).then(() => {
      if (loadingPdf === url) loadingPdf = null;
      loadedPdf = url;
      if (mainMissing()) call("pdf", "showNoMain", true);
      else call("pdf", "showEmpty", false);
    }, (e) => {
      if (loadingPdf === url) loadingPdf = null;
      if (mainMissing()) call("pdf", "showNoMain", true);
      else toast(`Couldn't show the PDF: ${errMsg(e)}`, "error");
    });
  }

  // The one handler for POST responses, SSE `compile` events and boot/refresh results.
  function handleCompileResult(r, source, opts) {
    opts = opts || {};
    if (source === "sse") { sseBuilding = false; clearTimeout(sseBuildTimer); }
    if (!r || typeof r !== "object") { updateCompiling(); return; }
    const id = Number(r.id);
    if (r.id != null && Number.isFinite(id)) {
      if (seenIds.has(id)) { updateCompiling(); return; }
      seenIds.add(id);
      if (seenIds.size > 300) seenIds.delete(seenIds.values().next().value);
      if (id < maxId) { updateCompiling(); return; } // an older build reported after a newer one
      maxId = id;
    }
    r.errors = Array.isArray(r.errors) ? r.errors : [];
    r.warnings = Array.isArray(r.warnings) ? r.warnings : [];
    r.notes = Array.isArray(r.notes) ? r.notes : [];
    T.state.lastCompile = r;
    const p = T.state.project;
    if (p) {
      p.last_result = r;
      if (r.pdf_url) p.has_pdf = true;
      // A live no_main result means the main file is gone. The way back (main found) comes from a
      // refresh, setMain or createMain: a build that started before a delete may still end "ok".
      if (r.no_main && (source === "post" || source === "sse")) p.main_exists = false;
    }
    updateCompiling();
    syncNoMain(false);
    updateStatusDot();
    refreshProblems();
    if (r.no_main || mainMissing()) { // not a failure: the preview keeps the no-main empty state
      call("pdf", "clearFailure");
      bus.emit("compile:result", r);
      return;
    }
    if (source !== "boot") {
      if (r.timed_out) toast(`Compile timed out after ${settings().compileTimeout || 120} s.`, "error", { action: { label: "View log", onClick: openLog } });
      else if (r.cancelled) toast("Compile cancelled.", "info");
    }
    const anyPdf = loadedPdf || loadingPdf;
    if (r.ok) {
      if (r.pdf_url && !opts.noLoad) loadPdf(r.pdf_url);
      call("pdf", "clearFailure");
    } else {
      call("pdf", "showFailure", r);
      if (r.pdf_url && !anyPdf && !opts.noLoad) loadPdf(r.pdf_url); // first PDF ever, even from a failed run
    }
    if (!r.pdf_url && !anyPdf) call("pdf", "showEmpty", true);
    bus.emit("compile:result", r);
  }

  function updateStatusDot() {
    const btn = $("#btn-status");
    if (!btn) return;
    const r = T.state.lastCompile;
    const ne = r ? (r.errors || []).length : 0;
    const nw = r ? (r.warnings || []).length : 0;
    let state = "none";
    let title = "No compile yet";
    if (mainMissing()) title = "This folder has no main .tex file";
    else if (r) {
      if (ne || r.ok === false) { state = "error"; title = r.ok === false && !ne ? "The last compile failed" : `Problems: ${plural(ne, "error")}, ${plural(nw, "warning")}`; }
      else if (nw) { state = "warn"; title = `Problems: ${plural(nw, "warning")}`; }
      else { state = "clean"; title = "No problems"; }
    }
    btn.classList.remove("is-none", "is-clean", "is-warn", "is-error");
    btn.classList.add(`is-${state}`);
    btn.innerHTML = statusSvg(state);
    btn.title = title;
    btn.setAttribute("aria-label", title);
  }

  // ================================================================== Problems popover
  let problemsLayer = null;

  function toggleProblems(anchor) {
    if (problemsLayer) { problemsLayer.close(); return; }
    openProblems(anchor);
  }

  function openProblems(anchor) {
    if (problemsLayer) { problemsLayer.close(); }
    anchor = anchor || $("#btn-status");
    if (menuLayer) menuLayer.close();
    const el = h("div", { class: "app-popover app-problems", role: "dialog", "aria-label": "Problems", tabindex: "-1" });
    let closed = false;
    const layer = {
      kind: "popover", el, anchor, outside: true,
      close() {
        if (closed) return;
        closed = true;
        dropLayer(layer);
        if (problemsLayer === layer) problemsLayer = null;
        el.remove();
        if (anchor) anchor.setAttribute("aria-expanded", "false");
      },
    };
    problemsLayer = layer;
    renderProblemsInto(el);
    overlayRoot().append(el);
    placeNear(el, anchor, { align: "right", gap: 6 });
    pushLayer(layer);
    if (anchor) anchor.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => { if (!closed) el.focus({ preventScroll: true }); });
  }

  function refreshProblems() {
    if (!problemsLayer) return;
    renderProblemsInto(problemsLayer.el);
    placeNear(problemsLayer.el, problemsLayer.anchor, { align: "right", gap: 6 });
  }

  const shortMsg = (m) => String(m || "").replace(/^(LaTeX|Package \S+) (Error|Warning):\s*/, "").trim() || String(m || "");

  function renderProblemsInto(el) {
    const r = T.state.lastCompile;
    const errors = (r && r.errors) || [];
    const warnings = (r && r.warnings) || [];
    const notes = (r && r.notes) || [];
    const head = h("div", { class: "app-prob-head" },
      h("div", { class: "app-prob-title" }, h("b", null, "Problems"), h("span", { class: "app-prob-counts" }, ` · ${plural(errors.length, "error")} · ${plural(warnings.length, "warning")}`)),
      h("button", { type: "button", class: "app-link-btn", onclick: () => { closeProblemsPopover(); openLog(); } }, "View log"));
    const list = h("div", { class: "app-prob-list", role: "list" });
    if (!r) {
      list.append(h("div", { class: "app-prob-empty" }, "No compile yet.",
        h("div", null, h("button", { type: "button", class: "app-btn is-sm", onclick: () => { closeProblemsPopover(); requestCompile(); } }, "Compile now"))));
    } else if (!errors.length && !warnings.length && !notes.length) {
      const when = r.ok === false ? "The last compile failed without a parsed error. See the log." : `No problems in the last compile${r.duration ? ` (${Number(r.duration).toFixed(1)} s)` : ""}.`;
      list.append(h("div", { class: "app-prob-empty" }, h("span", { class: `app-prob-empty-icon${r.ok === false ? " is-error" : ""}`, html: icon(r.ok === false ? "alert" : "check", 18) }), when));
    } else {
      const sortedWarnings = warnings.slice().sort((a, b) => (b.important ? 1 : 0) - (a.important ? 1 : 0));
      const rows = errors.map((e) => ({ kind: "error", p: e })).concat(sortedWarnings.map((w) => ({ kind: "warn", p: w })));
      const LIMIT = 250;
      rows.slice(0, LIMIT).forEach(({ kind, p }) => list.append(problemRow(kind, p)));
      if (rows.length > LIMIT) list.append(h("div", { class: "app-prob-more" }, `…and ${rows.length - LIMIT} more. Open the log to see everything.`));
      notes.forEach((n) => list.append(h("div", { class: "app-prob-row is-note", role: "listitem" },
        h("span", { class: "app-prob-icon", html: icon("alert", 14) }),
        h("div", { class: "app-prob-text" }, h("span", { class: "app-prob-msg" }, String(n))))));
    }
    el.replaceChildren(head, list);
  }

  function problemRow(kind, p) {
    const file = normPath(p.file || "");
    const line = Number(p.line) || 0;
    const loc = file ? `${file}${line ? `:${line}` : ""}` : line ? `line ${line}` : "";
    const row = h("div", {
      class: `app-prob-row is-${kind}${kind === "warn" && p.important === false ? " is-minor" : ""}`,
      role: "listitem", tabindex: "0",
      title: p.context ? `${p.message}\n${p.context}` : p.message,
    },
    h("span", { class: "app-prob-icon", html: icon("alert", 14) }),
    h("div", { class: "app-prob-text" },
      loc ? h("span", { class: "app-prob-loc" }, loc) : null,
      h("span", { class: "app-prob-msg" }, shortMsg(p.message))));
    if (kind === "error") {
      row.append(h("button", {
        type: "button", class: "app-prob-fix", html: `${icon("wand", 13)}<span>Fix with AI</span>`,
        onclick: (e) => { e.stopPropagation(); closeProblemsPopover(); fixWithAI([p]); },
      }));
    }
    const go = () => {
      closeProblemsPopover();
      const target = file || (line ? T.state.main : "");
      if (target) openFile(target, line || undefined);
      else openLog();
    };
    row.addEventListener("click", go);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
    return row;
  }

  function closeProblemsPopover() { if (problemsLayer) problemsLayer.close(); }

  // ================================================================== AI helpers
  function focusComposer() {
    if (has("chat", "focus")) { call("chat", "focus"); return; }
    const t = activeTab();
    const mount = t && t.type === "chat" ? $("#chat-view") : $("#dock-chat");
    const ta = mount && mount.querySelector("textarea");
    if (ta) requestAnimationFrame(() => ta.focus());
  }

  function askAI(text, opts) {
    if (!has("chat", "ask")) { toast("The chat isn't available, so this can't be sent to the AI.", "error"); return undefined; }
    if (!activeTab()) newChatTab();
    return call("chat", "ask", text, opts || {});
  }

  // Source lines around each error (line ± 3), fetched from /api/file, as chat context items.
  async function errorContexts(errs) {
    const cache = new Map();
    const out = [];
    for (const e of errs) {
      const path = normPath(e.file || (Number(e.line) > 0 ? T.state.main : ""));
      const line = Number(e.line) || 0;
      if (!path || line <= 0 || kindOf(path) !== "text") continue;
      let lines = cache.get(path);
      if (lines === undefined) {
        try {
          const f = await api.get("/api/file", { path });
          lines = String((f && f.content) || "").split("\n");
        } catch (_) { lines = null; }
        cache.set(path, lines);
      }
      if (!lines || !lines.length) continue;
      const l1 = clamp(line - 3, 1, lines.length);
      const l2 = clamp(line + 3, 1, lines.length);
      out.push({ path, from: { line: l1, ch: 0 }, to: { line: l2, ch: (lines[l2 - 1] || "").length }, text: lines.slice(l1 - 1, l2).join("\n") });
    }
    return out;
  }

  async function fixWithAI(errs) {
    errs = (errs || []).filter(Boolean);
    if (!errs.length) return;
    const list = errs.slice(0, 12);
    const context = await errorContexts(list.slice(0, 6));
    const describe = (e) => {
      const f = normPath(e.file || "");
      const where = f ? `${f}${e.line ? `:${e.line}` : ""}` : e.line ? `line ${e.line}` : "unknown location";
      return `${where}: ${e.message}${e.context ? `\n   TeX context: ${e.context}` : ""}`;
    };
    let text;
    if (list.length === 1) text = `Fix this LaTeX compile error.\n\n${describe(list[0])}`;
    else text = `Fix these LaTeX compile errors.\n\n${list.map((e, i) => `${i + 1}. ${describe(e)}`).join("\n")}${errs.length > list.length ? `\n…and ${errs.length - list.length} more.` : ""}`;
    // Show the file next to the docked chat so the proposed hunks appear in place.
    const first = list.find((e) => { const p = normPath(e.file || (Number(e.line) > 0 ? T.state.main : "")); return p && kindOf(p) === "text"; });
    if (first) {
      try { await openFile(normPath(first.file || T.state.main), Number(first.line) || undefined); } catch (_) { /* ask anyway */ }
    }
    askAI(text, { context });
  }

  function fixAllErrors() {
    const r = T.state.lastCompile;
    if (!r) { toast("Nothing to fix yet: compile first.", "info", { action: { label: "Compile", onClick: () => requestCompile() } }); return; }
    const errors = r.errors || [];
    if (!errors.length) {
      if (r.ok === false) toast("The last compile failed without a parsed error.", "warn", { action: { label: "View log", onClick: openLog } });
      else toast("No compile errors to fix.", "success");
      return;
    }
    fixWithAI(errors);
  }

  function targetTexPath() {
    const t = activeTab();
    if (t && t.type === "file" && /\.(tex|ltx)$/i.test(t.id)) return t.id;
    const cur = call("editor", "current");
    if (cur && /\.(tex|ltx)$/i.test(cur)) return cur;
    return mainMissing() ? null : T.state.main || null;
  }

  async function proofread() {
    const path = targetTexPath();
    if (!path) { toast("Open a .tex file to proofread.", "info"); return; }
    try { await openFile(path); } catch (_) { /* the request still works without the editor */ }
    askAI(`Proofread ${path} line by line. Fix spelling, grammar, punctuation and unclear phrasing without changing the meaning, the math or the LaTeX structure. Propose each fix as its own small edit block, then say briefly what you changed.`, { context: [{ path }] });
  }

  async function askAboutSelection() {
    const sel = has("editor", "getSelection") ? call("editor", "getSelection") : null;
    if (sel && sel.path && sel.text) {
      const t = activeTab();
      if (!t || t.type === "chat") await openFile(sel.path); // ⌘K works in the docked chat
      call("chat", "attachSelection", sel);
    }
    focusComposer();
  }

  // ================================================================== Tools menu
  function toolsMenu(anchor) {
    menu(anchor, [
      { label: "Literature search", icon: "book", onClick: () => openLiterature() },
      { label: "Proofread document", icon: "spell", onClick: proofread },
      { label: "Word count", icon: "count", onClick: openWordCount },
      { label: "Fix errors with AI", icon: "wand", onClick: fixAllErrors },
      "-",
      { label: "Settings", icon: "settings", onClick: openSettings },
    ], { align: "right", minWidth: 210 });
  }

  // ---- Literature search
  const lit = { q: "", items: null, error: null };
  let litModal = null;

  function authorsShort(a) {
    const list = Array.isArray(a) ? a : a ? [String(a)] : [];
    if (!list.length) return "Unknown authors";
    return list.length > 3 ? `${list.slice(0, 3).join(", ")} et al.` : list.join(", ");
  }

  function selectionQuery() {
    const sel = has("editor", "getSelection") ? call("editor", "getSelection") : null;
    if (!sel || !sel.text || sel.text.length > 240) return "";
    return sel.text.replace(/\\[a-zA-Z@]+\*?/g, " ").replace(/[{}$\\%~^_&#]/g, " ").replace(/\s+/g, " ").trim();
  }

  /* T.app.openLiterature(query?) */
  function openLiterature(query) {
    if (litModal && !litModal.closed) { const i = $(".app-lit-input", litModal.el); if (i) i.focus(); return; }
    let input, list, status;
    let seq = 0;
    const initial = (query != null ? String(query) : selectionQuery()) || lit.q;
    const search = async (q) => {
      q = String(q || "").trim();
      lit.q = q;
      const my = ++seq;
      if (!q) { lit.items = null; render(); return; }
      status.replaceChildren(h("span", { class: "app-spin" }), "Searching arXiv…");
      status.hidden = false;
      try {
        const r = await api.get("/api/arxiv", { q, max: 15 });
        if (my !== seq || litModal.closed) return;
        lit.items = (r && r.items) || [];
        lit.error = null;
      } catch (e) {
        if (my !== seq || litModal.closed) return;
        lit.items = null;
        lit.error = e && e.status === 502 ? `arXiv is unreachable: ${errMsg(e)}` : `Search failed: ${errMsg(e)}`;
      }
      render();
    };
    const debounced = (U.debounce || ((f) => f))((v) => { if (String(v).trim().length >= 3) search(v); }, 900);
    const render = () => {
      list.replaceChildren();
      status.hidden = true;
      if (lit.error) {
        status.hidden = false;
        status.replaceChildren(h("span", { class: "app-lit-err", html: icon("alert", 14) }), h("span", null, lit.error),
          h("button", { type: "button", class: "app-link-btn", onclick: () => search(input.value) }, "Retry"));
        return;
      }
      if (lit.items == null) {
        status.hidden = false;
        status.replaceChildren(h("span", null, "Search titles, authors and abstracts on arXiv. Press ↵ to search."));
        return;
      }
      if (!lit.items.length) {
        status.hidden = false;
        status.replaceChildren(h("span", null, `No results for “${lit.q}”.`));
        return;
      }
      for (const it of lit.items) list.append(litRow(it));
    };
    litModal = modal({
      className: "app-lit-modal",
      width: 680,
      top: true,
      actions: [],
      body: (el) => {
        input = h("input", { class: "app-lit-input", type: "search", placeholder: "Search arXiv…", spellcheck: "false", autocomplete: "off", value: initial, "aria-label": "Search arXiv" });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); debounced.cancel && debounced.cancel(); search(input.value); }
        });
        input.addEventListener("input", () => debounced(input.value));
        status = h("div", { class: "app-lit-status", role: "status" });
        list = h("div", { class: "app-lit-list", role: "list" });
        el.append(
          h("div", { class: "app-lit-search" }, h("span", { class: "app-lit-search-icon", html: icon("search", 16) }), input,
            h("button", { type: "button", class: "icon-btn", title: "Close", "aria-label": "Close", html: icon("close", 16), onclick: () => litModal.close(null) })),
          status, list,
          h("div", { class: "app-lit-foot" }, h("span", null, "Results from arXiv.org"), h("span", null, "↵ search · Esc close")));
      },
      onClose: () => { debounced.cancel && debounced.cancel(); seq++; },
    });
    render();
    if (initial && (initial !== lit.q || lit.items == null)) search(initial);
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }

  function litRow(it) {
    const meta = [authorsShort(it.authors), it.year, it.id ? `arXiv:${it.id}` : "", it.primary].filter(Boolean).join(" · ");
    const citeBtn = h("button", { type: "button", class: "app-btn is-sm", title: "Add to the .bib file and insert \\cite{…} at the cursor" }, "Cite");
    const askBtn = h("button", { type: "button", class: "app-btn is-sm", title: "Ask the AI about this paper" }, "Ask AI");
    const row = h("div", { class: "app-lit-item", role: "listitem", tabindex: "0" },
      h("div", { class: "app-lit-main" },
        h("div", { class: "app-lit-title" }, it.title || "(untitled)"),
        h("div", { class: "app-lit-meta" }, meta,
          it.url ? h("a", { class: "app-lit-link", href: it.url, target: "_blank", rel: "noopener noreferrer", title: "Open on arXiv", html: icon("external", 12), onclick: (e) => e.stopPropagation() }) : null),
        it.summary ? h("div", { class: "app-lit-abs" }, String(it.summary).replace(/\s+/g, " ").trim()) : null),
      h("div", { class: "app-lit-actions" }, citeBtn, askBtn));
    row.addEventListener("click", (e) => { if (!e.target.closest("button, a")) row.classList.toggle("is-open"); });
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === row) { e.preventDefault(); row.classList.toggle("is-open"); } });
    citeBtn.addEventListener("click", (e) => { e.stopPropagation(); cite(it, citeBtn); });
    askBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (litModal) litModal.close(null);
      askAI(`Tell me about the arXiv paper “${it.title}” (${authorsShort(it.authors)}, ${it.year || "n.d."}, arXiv:${it.id}). Summarise its contribution and say whether and where it would be worth citing in my paper.${it.summary ? `\n\nAbstract: ${String(it.summary).replace(/\s+/g, " ").trim()}` : ""}`);
    });
    return row;
  }

  async function cite(it, btn) {
    if (!it.bibtex || !it.key) { toast("This result has no BibTeX entry.", "error"); return; }
    btn.disabled = true;
    btn.textContent = "Citing…";
    try {
      const r = await api.post("/api/cite", { bibtex: it.bibtex, key: it.key });
      const key = (r && r.key) || it.key;
      const bib = (r && r.bib) || "refs.bib";
      const cur = has("editor", "insertAtCursor") ? call("editor", "current") : null;
      if (cur) call("editor", "insertAtCursor", `\\cite{${key}}`);
      const where = cur ? ` and inserted \\cite{${key}} in ${basename(cur)}` : "";
      toast(r && r.existed ? `${key} is already in ${bib}${cur ? `; inserted \\cite{${key}} in ${basename(cur)}` : ""}.` : `Added ${key} to ${bib}${where}.`, "success");
      btn.textContent = "Cited";
      btn.classList.add("is-done");
      setTimeout(() => { btn.disabled = false; }, 1200);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Cite";
      reportError(e, "Couldn't add the citation");
    }
  }

  // ---- Word count
  function openWordCount() {
    const m = modal({
      title: "Word count",
      width: 420,
      className: "app-wc",
      body: (el) => el.append(h("div", { class: "app-loading" }, h("span", { class: "app-spin" }), "Counting words…")),
      actions: [{ label: "Close", primary: true }],
    });
    api.post("/api/wordcount").then((r) => {
      if (m.closed) return;
      const words = Number(r && r.words) || 0;
      m.body.replaceChildren(
        h("div", { class: "app-wc-big" }, fmtNum(words)),
        h("div", { class: "app-wc-sub" }, `words in ${T.state.main || "the main file"} and the files it includes`),
        r && r.text ? h("pre", { class: "app-wc-pre" }, String(r.text).trim()) : null);
    }, (e) => {
      if (m.closed) return;
      m.body.replaceChildren(h("div", { class: "app-error" }, `Couldn't count words: ${errMsg(e)}`));
    });
  }

  // ---- Settings
  let settingsModal = null;
  function openSettings() {
    if (settingsModal && !settingsModal.closed) return; // ⌘, again while it is open
    const s = Object.assign({}, settings());
    const model = Object.assign({}, s.model || {});
    const providers = ((T.state.ai && T.state.ai.providers) || []).filter((p) => p && p.id);
    const byId = new Map(providers.map((p) => [p.id, p]));
    const current = s.provider || (providers.find((p) => p.available) || {}).id || "off";
    const els = {};
    const row = (label, control, hint) => h("div", { class: "app-set-row" },
      h("div", { class: "app-set-label" }, h("label", { for: control.id }, label), hint ? h("div", { class: "app-set-hint" }, hint) : null),
      h("div", { class: "app-set-control" }, control));
    const select = (id, options, value) => {
      const el = h("select", { class: "app-select", id });
      for (const o of options) el.append(h("option", { value: String(o.value), disabled: !!o.disabled }, o.label));
      el.value = String(value);
      return el;
    };
    const fill = () => {
      const p = byId.get(els.provider.value);
      els.modelRow.hidden = !p;
      const efforts = p && Array.isArray(p.efforts) ? p.efforts : [];
      els.effortRow.hidden = !efforts.length;
      if (p) {
        const models = Array.isArray(p.models) && p.models.length ? p.models.slice() : [p.default_model || "default"];
        const cur = model[p.id] || p.default_model || models[0];
        if (!models.includes(cur)) models.unshift(cur);
        els.model.replaceChildren(...models.map((m) => h("option", { value: m }, m === "default" ? "default (account setting)" : m)));
        els.model.value = cur;
      }
      if (efforts.length) {
        els.effort.replaceChildren(...efforts.map((x) => h("option", { value: x }, x)));
        els.effort.value = efforts.includes(s.effort) ? s.effort : efforts.includes("medium") ? "medium" : efforts[0];
      }
    };
    settingsModal = modal({
      title: "Settings",
      width: 500,
      className: "app-settings",
      body: (el) => {
        const provOpts = providers.map((p) => ({ value: p.id, label: `${p.label || p.id}${p.available === false ? " (not installed)" : ""}`, disabled: p.available === false && p.id !== current }));
        provOpts.push({ value: "off", label: "Off" });
        els.provider = select("set-provider", provOpts, current);
        els.model = h("select", { class: "app-select", id: "set-model" });
        els.effort = h("select", { class: "app-select", id: "set-effort" });
        els.modelRow = row("Model", els.model);
        els.effortRow = row("Reasoning effort", els.effort, "Codex only");
        els.provider.addEventListener("change", fill);
        els.model.addEventListener("change", () => { if (byId.has(els.provider.value)) model[els.provider.value] = els.model.value; });
        els.cos = h("input", { type: "checkbox", class: "app-switch", id: "set-cos", role: "switch" });
        els.cos.checked = s.compileOnSave !== false;
        const fs = Number(s.fontSize) || 13;
        const sizes = [];
        for (let i = 10; i <= 22; i++) sizes.push({ value: i, label: `${i} px` });
        if (!sizes.some((x) => x.value === fs)) sizes.push({ value: fs, label: `${fs} px` });
        els.font = select("set-font", sizes, fs);
        const am = Number(s.autosaveMs) || 800;
        const delays = [300, 500, 800, 1000, 1500, 2000, 3000, 5000];
        if (!delays.includes(am)) delays.push(am);
        delays.sort((a, b) => a - b);
        els.autosave = select("set-autosave", delays.map((d) => ({ value: d, label: d < 1000 ? `${d} ms` : `${d / 1000} s` })), am);
        els.calc = h("input", { type: "checkbox", class: "app-switch", id: "set-calc", role: "switch" });
        els.calc.checked = s.mathResults !== false;
        els.calcHint = h("span", null, "Type = after a formula to see its value; Tab inserts it");
        api.get("/api/calc").then((st) => {
          if (st && st.available === false) {
            els.calcHint.replaceChildren("Needs SymPy: ", h("code", null, st.install || "python3 -m pip install --user sympy"));
          }
        }).catch(() => {});
        el.append(
          h("div", { class: "app-set-section" }, "AI"),
          row("AI provider", els.provider, "Chat and AI edits run through this CLI"),
          els.modelRow, els.effortRow,
          h("div", { class: "app-set-section" }, "Editor"),
          row("Compile on save", els.cos, "Rebuild the PDF after each save"),
          row("Editor font size", els.font),
          row("Autosave delay", els.autosave, "After the last keystroke"),
          row("Results after =", els.calc, els.calcHint));
        fill();
      },
      actions: [
        { label: "Cancel", value: null },
        {
          label: "Save", primary: true,
          onClick: async () => {
            const prov = els.provider.value;
            if (byId.has(prov)) model[prov] = els.model.value;
            const patch = { provider: prov, model, compileOnSave: !!els.cos.checked, fontSize: Number(els.font.value), autosaveMs: Number(els.autosave.value), mathResults: !!els.calc.checked };
            if (!els.effortRow.hidden) patch.effort = els.effort.value;
            const full = await api.put("/api/settings", patch);
            const next = full && typeof full === "object" && !Array.isArray(full) && !full.raw ? full : Object.assign({}, s, patch);
            const fontChanged = Number(s.fontSize) !== Number(next.fontSize);
            T.state.settings = next;
            if (T.state.project) T.state.project.settings = next;
            bus.emit("settings:changed", next);
            if (fontChanged) call("editor", "setOptions", { fontSize: Number(next.fontSize) });
            toast("Settings saved", "success", { timeout: 2000 });
            return true;
          },
        },
      ],
    });
  }

  // ================================================================== log viewer
  let logModal = null;
  function openLog() {
    if (logModal && !logModal.closed) return;
    let pre, seg, jumpBtn;
    let data = null;
    let mode = "log";
    const render = () => {
      if (!data) return;
      const text = mode === "log" ? data.text : data.output;
      $$("button", seg).forEach((b) => b.classList.toggle("is-on", b.dataset.mode === mode));
      if (!text) { pre.textContent = mode === "log" ? "No .log file yet. Compile first." : "No build transcript yet."; jumpBtn.disabled = true; return; }
      pre.replaceChildren(highlightLog(String(text)));
      jumpBtn.disabled = !pre.querySelector(".is-err");
      pre.scrollTop = 0;
    };
    logModal = modal({
      title: "Build log",
      className: "app-log-modal",
      width: "min(980px, 94vw)",
      actions: [],
      body: (el) => {
        seg = h("div", { class: "app-seg", role: "tablist" },
          h("button", { type: "button", "data-mode": "log", class: "is-on", onclick: () => { mode = "log"; render(); } }, "Log"),
          h("button", { type: "button", "data-mode": "output", onclick: () => { mode = "output"; render(); } }, "Output"));
        jumpBtn = h("button", { type: "button", class: "app-btn is-sm", disabled: true, onclick: () => {
          const first = pre.querySelector(".is-err");
          if (first) pre.scrollTop = Math.max(0, first.offsetTop - pre.clientHeight / 3);
        } }, "Jump to first error");
        const copyBtn = h("button", { type: "button", class: "app-btn is-sm", html: `${icon("copy", 13)}<span>Copy</span>`, onclick: () => copyText(pre.textContent || "") });
        pre = h("pre", { class: "app-log-pre", tabindex: "0" }, h("span", { class: "app-loading" }, h("span", { class: "app-spin" }), "Loading the log…"));
        el.append(h("div", { class: "app-log-bar" }, seg, h("div", { class: "app-flex" }), jumpBtn, copyBtn), pre);
      },
    });
    api.get("/api/log").then((r) => {
      if (logModal.closed) return;
      data = { text: (r && r.text) || "", output: (r && r.output) || "" };
      if (!data.text && data.output) mode = "output";
      render();
    }, (e) => {
      if (logModal.closed) return;
      pre.textContent = e && e.status === 404 ? "No log yet. Compile first." : `Couldn't load the log: ${errMsg(e)}`;
    });
  }

  function highlightLog(text) {
    const frag = document.createDocumentFragment();
    const lines = text.split("\n");
    const MAX_MARKED = 40000;
    let buf = [];
    const flush = () => { if (buf.length) { frag.append(document.createTextNode(buf.join("\n") + "\n")); buf = []; } };
    lines.forEach((ln, i) => {
      let cls = null;
      if (i < MAX_MARKED) {
        if (/^!/.test(ln) || /^l\.\d+/.test(ln) || /(^|\s)(LaTeX|Package \S+) Error/.test(ln) || /^\S+:\d+: /.test(ln)) cls = "is-err";
        else if (/Warning/.test(ln)) cls = "is-warn";
        else if (/^(Overfull|Underfull)/.test(ln)) cls = "is-box";
      }
      if (!cls) { buf.push(ln); return; }
      flush();
      frag.append(h("span", { class: `app-log-line ${cls}` }, ln), document.createTextNode("\n"));
    });
    flush();
    return frag;
  }

  // ================================================================== PDF-side actions
  function editorCursor() {
    const path = call("editor", "current");
    if (!path) return null;
    const cm = cmInstance();
    if (cm && typeof cm.getCursor === "function") {
      const c = cm.getCursor();
      return { path, line: c.line + 1, ch: c.ch };
    }
    const sel = call("editor", "getSelection");
    if (sel && sel.from) return { path: sel.path || path, line: sel.from.line, ch: sel.from.ch || 0 };
    return { path, line: 1, ch: 0 };
  }

  async function syncToCursor() {
    const cur = editorCursor();
    if (!cur) { toast("Open a .tex file first, then sync.", "info"); return; }
    try {
      const r = await api.get("/api/synctex/view", { path: cur.path, line: cur.line, column: cur.ch + 1 });
      if (r) call("pdf", "flash", r);
    } catch (e) {
      if (e && e.status === 404) toast(`No matching spot in the PDF for ${basename(cur.path)}:${cur.line}. Compile, then try again.`, "info");
      else reportError(e, "Sync failed");
    }
  }

  async function openPdfExternal() {
    try {
      await api.post("/api/open-pdf");
      toast("Opened the PDF in your viewer", "success", { timeout: 2000 });
    } catch (e) { reportError(e, "Couldn't open the PDF"); }
  }

  async function cleanBuild() {
    try {
      const r = await api.post("/api/clean");
      const n = r && Array.isArray(r.removed) ? r.removed.length : 0;
      toast(n ? `Removed ${plural(n, "build file")}` : "Nothing to clean", "success");
      if (T.state.project) T.state.project.has_pdf = false;
    } catch (e) { reportError(e, "Couldn't clean the build files"); }
  }

  // ================================================================== splitter
  let split = 55;
  function setSplit(pct) {
    split = clamp(Number(pct) || 55, 30, 75);
    document.documentElement.style.setProperty("--left-w", `${split}%`);
    const sp = $("#splitter");
    if (sp) sp.setAttribute("aria-valuenow", String(Math.round(split)));
  }
  function afterLayout() {
    call("editor", "refresh");
    window.dispatchEvent(new Event("resize")); // lets the PDF view refit
  }
  // Runs after T.store.seed() (boot), since the ratio is per-folder state.
  function applySavedSplit() {
    const saved = store.get("texc:split", null);
    if (typeof saved === "number") setSplit(saved);
  }
  function initSplitter() {
    const sp = $("#splitter");
    if (!sp) return;
    sp.tabIndex = 0;
    sp.setAttribute("aria-label", "Resize the editor and preview");
    sp.setAttribute("aria-valuemin", "30");
    sp.setAttribute("aria-valuemax", "75");
    sp.setAttribute("aria-valuenow", String(Math.round(split)));
    sp.title = "Drag to resize · double-click to reset";
    let raf = 0;
    sp.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { sp.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      sp.classList.add("dragging");
      document.body.classList.add("app-resizing");
      const width = document.body.clientWidth || innerWidth;
      const move = (ev) => {
        setSplit(((ev.clientX - 3) / width) * 100);
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; call("editor", "refresh"); });
      };
      const up = () => {
        sp.removeEventListener("pointermove", move);
        sp.removeEventListener("pointerup", up);
        sp.removeEventListener("pointercancel", up);
        try { sp.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        sp.classList.remove("dragging");
        document.body.classList.remove("app-resizing");
        store.set("texc:split", split);
        afterLayout();
      };
      sp.addEventListener("pointermove", move);
      sp.addEventListener("pointerup", up);
      sp.addEventListener("pointercancel", up);
    });
    sp.addEventListener("dblclick", () => { setSplit(55); store.set("texc:split", split); afterLayout(); });
    sp.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setSplit(split + (e.key === "ArrowRight" ? 2 : -2));
      store.set("texc:split", split);
      afterLayout();
    });
  }

  // ================================================================== keyboard
  function onKeyDown(e) {
    if (e.defaultPrevented) return; // CodeMirror (or another module) already handled it
    if (e.key === "Escape") {
      if (layers.length && !e.isComposing) { e.preventDefault(); closeTopLayer(); }
      return;
    }
    const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod || e.altKey) return;
    const k = (e.key || "").toLowerCase();
    if (k === "s" && !e.shiftKey) { e.preventDefault(); requestCompile(); return; } // save all + compile
    if (e.key === "Enter") { e.preventDefault(); requestCompile(); return; }
    if (k === "k" && !e.shiftKey) { e.preventDefault(); askAboutSelection(); return; }
    if (k === "f" && !e.shiftKey) {
      const t = activeTab();
      const inOverlay = e.target && e.target.closest && e.target.closest("#overlay-root");
      if (t && t.type === "file" && !inOverlay && !layers.length) {
        const cm = cmInstance();
        if (cm && typeof cm.execCommand === "function") { e.preventDefault(); cm.focus(); cm.execCommand("find"); }
      }
    }
  }

  // ================================================================== server events
  let sseHello = false;
  function onServerEvent(name, data) {
    switch (name) {
      case "hello":
        if (sseHello) {
          // Reconnected: catch up on anything missed while the stream was down.
          sseBuilding = false;
          updateCompiling();
          refreshProject();
        }
        sseHello = true;
        break;
      case "files":
        refreshProjectSoon();
        break;
      case "file":
        if (data && data.path) {
          const path = normPath(data.path);
          const f = fileIndex.get(path);
          if (f && data.mtime) f.mtime = data.mtime;
          bus.emit("file:changed", { path, mtime: data.mtime });
          const t = activeTab();
          if (t && t.type === "image" && t.id === path) showImage(path);
        }
        break;
      case "compile-start":
        sseBuilding = true;
        clearTimeout(sseBuildTimer);
        // Safety net in case the matching `compile` event is lost.
        sseBuildTimer = setTimeout(() => { sseBuilding = false; updateCompiling(); }, ((Number(settings().compileTimeout) || 120) + 30) * 1000);
        updateCompiling();
        bus.emit("compile:start", data || {});
        break;
      case "compile":
        handleCompileResult(data, "sse");
        break;
      default:
        break;
    }
  }

  // ================================================================== bus wiring
  function wireBus() {
    bus.on("compile:request", (d) => { requestCompile(d || {}); });
    bus.on("file:saved", (d) => {
      saveGen++;
      if (d && d.path) setDirty(d.path, recomputeDirty(normPath(d.path)));
      if (settings().compileOnSave !== false) saveCompile();
    });
    bus.on("file:dirty", (d) => { if (d && d.path) setDirty(d.path, !!d.dirty); });
    bus.on("edits:resolved", (d) => {
      if (d && d.path) setTimeout(() => setDirty(d.path, recomputeDirty(normPath(d.path))), 0);
    });
    bus.on("chat:title", (d) => {
      if (!d || d.id == null || !d.title) return;
      const id = String(d.id);
      chatTitles.set(id, d.title);
      const t = findTab(`chat:${id}`);
      if (t) { t.title = d.title; t.untitled = false; renderTabs(); persistTabs(); }
    });
    bus.on("chat:open-as-tab", (d) => { if (d && d.id != null) openChatTab(d.id); });
    // A chat deleted from the dock's history menu: drop its tab too (chat.js picks the next chat).
    bus.on("chat:deleted", (d) => {
      if (!d || d.id == null) return;
      const id = String(d.id);
      chatTitles.delete(id);
      if (findTab(`chat:${id}`)) closeTab(`chat:${id}`, { force: true });
    });
    bus.on("pdf:goto-source", (d) => { if (d && d.path) openFile(d.path, d.line, d.column || d.ch); });
    bus.on("pdf:sync-to-cursor", () => syncToCursor());
    bus.on("pdf:open-external", () => openPdfExternal());
    bus.on("log:show", () => openLog());
    bus.on("build:clean", () => cleanBuild());
    // The preview's no-main empty state (pdf.js) asks for these.
    bus.on("main:create", () => { createMain(); });
    bus.on("main:choose", (d) => { mainFileMenu((d && d.anchor) || $("#btn-drawer")); });
  }

  // ================================================================== boot
  function bootPanel(kind, text, retry) {
    let panel = $(".app-boot");
    if (!kind) { if (panel) panel.remove(); return; }
    if (!panel) { panel = h("div", { class: "app-boot" }); overlayRoot().append(panel); }
    panel.className = `app-boot is-${kind}`;
    if (kind === "loading") {
      panel.replaceChildren(h("div", { class: "app-boot-card" }, h("span", { class: "app-spin" }), h("span", null, text)));
      return;
    }
    const card = h("div", { class: "app-boot-card", role: "alert" },
      h("div", { class: "app-boot-title" }, "Can't load the project"),
      h("div", { class: "app-boot-text" }, text));
    const row = h("div", { class: "app-boot-actions" });
    if (retry) row.append(h("button", { type: "button", class: "app-btn is-primary", onclick: retry }, "Retry"));
    row.append(h("button", { type: "button", class: "app-btn", onclick: () => location.reload() }, "Reload page"));
    card.append(row);
    panel.replaceChildren(card);
  }

  function loadProject() {
    return new Promise((resolve) => {
      const attempt = () => {
        const slow = setTimeout(() => bootPanel("loading", "Loading project…"), 350);
        api.get("/api/project").then((p) => {
          clearTimeout(slow);
          if (!p || typeof p !== "object") throw new Error("the server sent an empty project");
          bootPanel(null);
          resolve(p);
        }).catch((e) => {
          clearTimeout(slow);
          const msg = e && e.status === 401
            ? "This page's session token was rejected. If you restarted texc, reload the page from the new URL."
            : `The texc server didn't answer (${errMsg(e)}). Is \`texc --gui\` still running?`;
          bootPanel("error", msg, () => { bootPanel("loading", "Retrying…"); attempt(); });
        });
      };
      attempt();
    });
  }

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("init timed out")), ms))]);
  }

  async function initModules() {
    const plan = [
      ["editor", () => T.editor.init($("#editor-host"))],
      ["pdf", () => T.pdf.init($("#preview"))],
      ["chat", () => T.chat.init()],
    ];
    const waits = [];
    for (const [name, run] of plan) {
      if (!T[name] || typeof T[name].init !== "function") { moduleFailed(name, new Error(`js/${name}.js did not load`)); continue; }
      try {
        const r = run();
        if (r && typeof r.then === "function") waits.push(withTimeout(r, 8000).catch((e) => moduleFailed(name, e)));
      } catch (e) {
        moduleFailed(name, e);
      }
    }
    await Promise.all(waits);
    if (failed.has("pdf")) {
      const empty = $("#pdf-empty");
      if (empty) { empty.hidden = false; empty.textContent = "The PDF preview failed to load (js/pdf.js)."; }
    }
  }

  function startPdf(p) {
    const r = p.last_result && typeof p.last_result === "object" ? p.last_result : null;
    if (r) handleCompileResult(r, "boot", { noLoad: true });
    if (mainMissing()) { call("pdf", "showNoMain", true); return; } // nothing to build yet
    if (p.has_pdf) loadPdf((r && r.pdf_url) || `/api/pdf?v=${Date.now()}`);
    else {
      call("pdf", "showEmpty", true);
      requestCompile();
    }
  }

  // ---- texc app / browser host (docs/ARCHITECTURE.md,
  function unsavedWork() {
    if (!has("editor")) return tabs.some((t) => t.type === "file" && dirty.get(t.id));
    const pend = call("editor", "pending");
    if (Array.isArray(pend) && pend.length) return true;
    return tabs.some((t) => t.type === "file" && call("editor", "isDirty", t.id));
  }

  // Runs before the window closes, the app quits or this window changes folder. false cancels.
  let closingRun = null;
  function beforeClose() {
    return closingRun || (closingRun = beforeCloseOnce().finally(() => { closingRun = null; }));
  }
  async function beforeCloseOnce() {
    if (!has("editor")) return true;
    let saved = true;
    try { saved = (await T.editor.saveAll()) !== false; } catch (_) { saved = false; }
    const pend = call("editor", "pending"); // saveAll skips files with pending AI hunks
    if (Array.isArray(pend) && pend.length) {
      const ok = await confirm("Discard the AI edits you haven't reviewed?", {
        title: "Unreviewed AI edits", ok: "Discard", danger: true,
        detail: `${plural(pend.length, "edit")} still wait${pend.length === 1 ? "s" : ""} for Keep or Undo. Discarding undoes ${pend.length === 1 ? "it" : "them"}; your own changes are saved.`,
      });
      if (!ok) return false;
      call("editor", "resolveAll", false); // undo the hunks, then save what the user typed
      try { saved = (await T.editor.saveAll()) !== false && saved; } catch (_) { saved = false; }
    }
    if (!saved) {
      return confirm("Some changes couldn't be saved. Close anyway and lose them?", { title: "Unsaved changes", ok: "Close anyway", danger: true });
    }
    return true;
  }

  // ⌘W in the app. false = nothing to close here, so the shell closes the window.
  async function closeTabCommand() {
    if (layers.length) { closeTopLayer(); return true; } // a menu, dialog or the drawer goes first
    const t = activeTab();
    if (!t) return false;
    if (tabs.length === 1 && t.type === "chat" && t.untitled) return false; // only the empty "New chat" is left
    await closeTab(activeKey);
    return true;
  }

  // WebKit and Chrome keep one native undo history per page, and it includes CodeMirror's hidden
  // textarea. A native undo/redo in the chat composer (or any input) can run past that field's own
  // edits into the editor's textarea: focus jumps there and the document changes silently.
  // CodeMirror keeps its own history, so native history steps aimed at it are refused and focus
  // goes back to the field the user was in.
  let lastField = null;
  function guardNativeHistory() {
    document.addEventListener("focusin", (e) => {
      const t = e.target;
      if (!t || !t.closest || (t.closest(".CodeMirror") && !t.closest(".CodeMirror-dialog"))) return;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable) lastField = t;
    }, true);
    document.addEventListener("beforeinput", (e) => {
      if (e.inputType !== "historyUndo" && e.inputType !== "historyRedo") return;
      const t = e.target;
      if (!t || !t.closest || !t.closest(".CodeMirror") || t.closest(".CodeMirror-dialog")) return;   // the find box is a normal field
      e.preventDefault();
      if (lastField && lastField.isConnected) lastField.focus();
    }, true);
  }

  function wireHost(p) {
    const host = T.host;
    if (!host) return;
    host.lobbyUrl = p.lobby_url || null;
    host.notify({ mode: "project", folder: p.folder || p.root || null, name: p.name || "" });
    if (typeof host.onBeforeClose === "function") host.onBeforeClose(beforeClose);
    if (typeof host.on === "function") {
      host.on("settings", () => { openSettings(); return true; });
      host.on("closeTab", closeTabCommand);
      // Edit > Undo / Redo from the menu bar. The shell asks the page first: CodeMirror keeps its own
      // history, and WebKit's native undo of its hidden textarea would record a new edit instead.
      // null = not the editor, so the shell falls back to the native undo (chat composer, inputs).
      const history = (name) => () => {
        const cm = T.editor && T.editor.cm;
        if (!cm || !cm.hasFocus()) return null;
        if (!cm.isReadOnly()) cm[name]();
        return true;
      };
      host.on("undo", history("undo"));
      host.on("redo", history("redo"));
    }
  }

  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  let events = null;
  let modulesReady = false;

  async function boot() {
    renderTopbar();
    wireTopbar();
    initSplitter();
    wireBus();
    guardNativeHistory();
    window.addEventListener("keydown", onKeyDown);
    // Dropping files outside a drop zone must not navigate away from the app.
    window.addEventListener("dragover", (e) => { if (hasFiles(e) && !e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = "none"; } });
    window.addEventListener("drop", (e) => { if (hasFiles(e) && !e.defaultPrevented) e.preventDefault(); });
    // Browser mode only in practice: WKWebView never shows this prompt; the app asks through
    // beforeClose instead. Live editor state, so a beforeClose that saved/discarded doesn't ask twice.
    window.addEventListener("beforeunload", (e) => {
      if (unsavedWork()) {
        call("editor", "saveAll");
        e.preventDefault();
        e.returnValue = "";
      }
    });

    // 1. project; its per-folder UI state goes into T.store before anything reads it
    const project = await loadProject();
    if (T.store && typeof T.store.seed === "function") {
      T.store.seed(project.ui_state && typeof project.ui_state === "object" ? project.ui_state : {});
    }
    applyProject(project);
    applySavedSplit();
    loadFolderState();
    document.title = `${project.name || "project"} — texc`;
    wireHost(project);
    updateStatusDot();
    // 2. modules
    await initModules();
    modulesReady = true;
    // 3. tabs
    try { await restoreTabs(); } catch (e) { reportError(e, "Couldn't restore the tabs"); }
    // 4. PDF
    startPdf(project);
    // 5. server events
    try { events = T.api.events(onServerEvent); } catch (e) { reportError(e, "Live updates are off"); }
    resolveReady();
  }

  // ================================================================== public API
  T.app = {
    toast,
    confirm,
    choose,
    prompt,
    menu,
    modal,
    openFile,
    openChatTab,
    newChat: (opts) => newChatTab(Object.assign({ forceNew: true }, opts || {})),
    compile: requestCompile,
    ask: askAI,
    showProblems: () => openProblems(),
    showLog: openLog,
    openSettings,
    openLiterature,
    openWordCount,
    openDrawer,
    closeDrawer,
    refreshProject,
    tabs: () => tabs.map((t) => ({ type: t.type, id: t.id, title: t.title })),
    activeTab: () => { const t = activeTab(); return t ? { type: t.type, id: t.id, title: t.title } : null; },
    closeTab: (type, id) => closeTab(tabKey({ type, id: String(id) })),
    ready,
    get events() { return events; },
  };

  onReady(() => {
    boot().catch((e) => {
      console.error("[texc] boot failed", e);
      toast(`texc didn't start cleanly: ${errMsg(e)}`, "error", { timeout: 0, action: { label: "Reload", onClick: () => location.reload() } });
    });
  });
})();
