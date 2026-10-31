/* texc Welcome screen (docs/ARCHITECTURE.md): Start (New Project…, Open Folder…), Recent
   folders and the tool status line.
   Data comes from the lobby server (GET /api/lobby). Folders open through T.host: the Mac app's
   shell when T.host.native, else /api/pick + /api/open-folder in a plain browser. */
(function () {
  "use strict";
  const T = window.T;
  const H = T.host;
  const esc = T.util.esc;
  const MAC = T.util.isMac;
  const MOD = MAC ? "⌘" : "Ctrl+";
  const DEFAULT_NAME = "Untitled paper";
  // Only used when the server sends no templates (it should always send them).
  const FALLBACK_TEMPLATES = [
    { id: "article", name: "Article", description: "Title, abstract, sections and a bibliography" },
    { id: "blank", name: "Blank", description: "A minimal article" },
  ];

  const S = {
    data: null,         // last /api/lobby payload
    loadError: null,    // message when the first load failed
    recent: [],
    recentKey: "",      // JSON of the last recent list, to skip no-op re-renders
    home: null,         // home folder (inferred), for "~" display
    opening: null,      // {path, source} while an open is in flight
    openTimer: 0,
    picking: false,
    noPicker: false,    // the folder picker failed once: go straight to the typed path
    modal: null,        // the New Project modal while it's open
    ready: null,        // Promise of the first load
    pointerDown: false, // defer re-renders while a click is in progress
    renderLater: false,
  };

  // ---------------------------------------------------------------- helpers
  const $ = (sel, root) => (root || document).querySelector(sel);
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  const errText = (e) => (e && e.message) || String(e || "Something went wrong.");
  const svg = (body, s) =>
    `<svg width="${s || 16}" height="${s || 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  // Icons icons.js doesn't have.
  const plusCircle = (s) => svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>', s);
  // The texc mark: a dark rounded square with a white "tx", like the app icon.
  const markSvg = (s) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 36 36" fill="none" aria-hidden="true">` +
    `<rect x=".5" y=".5" width="35" height="35" rx="9" fill="#141414" stroke="#2f2f2f"/>` +
    `<g stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M13 10v12.5a3 3 0 0 0 3 3h1.5M9.5 14.5h7"/><path d="M20.5 14.5l6.5 11M27 14.5l-6.5 11"/></g></svg>`;

  // /api/lobby has no home folder, so infer it: from a recent entry whose `display` is
  // "~/…" (path = home + display minus "~"), else /Users/<name> from defaults.parent.
  function inferHome() {
    const d = S.data || {};
    let home = d.home || (d.defaults && d.defaults.home) || null;
    if (typeof home !== "string") home = null;
    if (!home) {
      for (const r of S.recent) {
        const disp = String(r.display || ""), p = String(r.path || "");
        if (disp === "~") { home = p; break; }
        if (disp.startsWith("~/") && p.length > disp.length && p.endsWith(disp.slice(1))) {
          home = p.slice(0, p.length - disp.length + 1);
          break;
        }
      }
    }
    if (!home) {
      const m = /^\/Users\/(?!Shared(?:\/|$))[^/]+/.exec(String((d.defaults && d.defaults.parent) || ""));
      if (m) home = m[0];
    }
    home = home ? home.replace(/\/+$/, "") : null;
    S.home = home && home.charAt(0) === "/" ? home : null;
  }
  function tilde(p) {
    p = String(p || "");
    const h = S.home;
    return h && (p === h || p.startsWith(h + "/")) ? "~" + p.slice(h.length) : p;
  }
  const joinPath = (a, b) => (String(a).endsWith("/") ? a : a + "/") + b;
  // "~/a/b/name" → head "~/a/b" + tail "/name". CSS shrinks the head first: a middle ellipsis.
  function pathHtml(disp) {
    disp = String(disp || "");
    const cut = disp.lastIndexOf("/");
    const head = cut > 0 ? disp.slice(0, cut) : disp;
    const tail = cut > 0 ? disp.slice(cut) : "";
    return `<span class="wl-ph">${esc(head)}</span><span class="wl-pt">${esc(tail)}</span>`;
  }

  function relTime(sec) {
    const t = Number(sec) * 1000;
    if (!isFinite(t) || t <= 0) return "";
    const now = Date.now(), d = Math.max(0, now - t) / 1000;
    if (d < 60) return "just now";
    if (d < 3600) return `${Math.floor(d / 60)} min ago`;
    const day0 = (x) => { const z = new Date(x); return new Date(z.getFullYear(), z.getMonth(), z.getDate()).getTime(); };
    const days = Math.round((day0(now) - day0(t)) / 86400000);
    if (days <= 0 || d < 6 * 3600) return `${Math.floor(d / 3600)} h ago`;
    if (days === 1) return "yesterday";
    if (days < 7) return `${days} days ago`;
    const then = new Date(t);
    const opts = then.getFullYear() === new Date(now).getFullYear()
      ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" };
    try { return then.toLocaleDateString(undefined, opts); } catch (_) { return then.toDateString(); }
  }
  const rowTime = (r) => (r.exists === false ? "not available" : relTime(r.opened));

  function toast(text, kind) {
    let box = $(".wl-toasts");
    if (!box) {
      box = el("div", "wl-toasts");
      box.setAttribute("role", "status");
      box.setAttribute("aria-live", "polite");
      document.body.append(box);
    }
    const t = el("div", "wl-toast" + (kind ? " is-" + kind : ""));
    t.innerHTML = (kind === "error" || kind === "warn" ? `<span class="wl-toast-icon">${T.icon("alert")}</span>` : "") +
      `<span class="wl-toast-text">${esc(text)}</span>` +
      `<button type="button" class="wl-toast-x" title="Dismiss" aria-label="Dismiss">${T.icon("close", 14)}</button>`;
    let timer = 0;
    const kill = () => { clearTimeout(timer); t.remove(); };
    timer = setTimeout(kill, kind === "error" ? 9000 : 6000);
    $(".wl-toast-x", t).addEventListener("click", kill);
    while (box.children.length >= 3) box.firstChild.remove();
    box.append(t);
  }

  // ---------------------------------------------------------------- data
  let lastRefresh = 0, refreshing = null;

  async function load() {
    try {
      const d = await T.api.get("/api/lobby");
      S.data = d && typeof d === "object" ? d : {};
      S.loadError = null;
      setRecent(S.data.recent);
      applyBackground(S.data.background);
    } catch (e) {
      S.loadError = errText(e);
    }
    lastRefresh = Date.now();
    renderRecent();
    renderStatus();
  }

  function setRecent(list) {
    list = Array.isArray(list) ? list : [];
    S.recentKey = JSON.stringify(list);
    S.recent = list.filter((r) => r && typeof r.path === "string" && r.path);
    inferHome();
  }

  // Re-read Recent when the window comes back (another window may have opened a folder, or a drive
  // was plugged in). Throttled; a failed first load is retried instead.
  function refreshRecent(force) {
    if (refreshing) return refreshing;
    if (!S.data) {
      if (!S.loadError) return Promise.resolve();      // the first load is still running
      refreshing = load().finally(() => { refreshing = null; });
      S.ready = refreshing;
      return refreshing;
    }
    if (!force && Date.now() - lastRefresh < 1500) return Promise.resolve();
    lastRefresh = Date.now();
    refreshing = T.api.get("/api/recent")
      .then((r) => {
        if (!r || !Array.isArray(r.recent) || JSON.stringify(r.recent) === S.recentKey) return;
        setRecent(r.recent);
        renderRecent();
      })
      .catch(() => { /* keep what we have */ })
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  // ---------------------------------------------------------------- background image (theme)
  // Any image the user picks, shown behind the page at their chosen transparency. The server keeps it
  // in the config dir (/api/lobby/background).
  const BG_MAX = 20 * 1024 * 1024;
  let bgSave = 0;

  function applyBackground(bg) {
    S.bg = bg && typeof bg === "object" ? bg : null;
    const layer = $("#wl-bg");
    if (!layer) return;
    if (S.bg) {
      layer.style.backgroundImage = `url("${T.api.url("/api/lobby/background", { v: S.bg.version })}")`;
      document.body.style.setProperty("--wl-bg-opacity", String(S.bg.opacity));
      document.body.classList.add("has-bg");
    } else {
      document.body.classList.remove("has-bg");
      layer.style.backgroundImage = "";
    }
  }

  async function saveBackground(body) {
    try {
      const r = await T.api.post("/api/lobby/background", body);
      if (!("opacity" in body) || body.data || body.clear) applyBackground(r && r.background);
      else if (r && r.background && S.bg) S.bg = r.background;   // ignore a late reply after Remove
      return true;
    } catch (e) {
      toast(errText(e), "error");
      return false;
    }
  }

  function pickBackgroundFile(input) {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    clearTimeout(bgSave);
    if (file.size > BG_MAX) { toast("That image is too large (20 MB at most).", "error"); return; }
    const reader = new FileReader();
    reader.onerror = () => toast("Couldn't read that image.", "error");
    reader.onload = async () => {
      const data = String(reader.result || "").split(",")[1] || "";
      if (await saveBackground({ data, name: file.name })) renderThemePop();
    };
    reader.readAsDataURL(file);
  }

  function closeThemePop() {
    if (!S.themePop) return;
    S.themePop.remove();
    S.themePop = null;
    document.removeEventListener("mousedown", onThemeOutside, true);
    document.removeEventListener("keydown", onThemeKey, true);
    const btn = $("#wl-theme");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }
  function onThemeOutside(e) {
    if (S.themePop && !S.themePop.contains(e.target) && !e.target.closest("#wl-theme")) closeThemePop();
  }
  function onThemeKey(e) {
    if (e.key !== "Escape" || S.modal) return;      // the New Project modal handles its own Escape
    e.preventDefault();
    e.stopPropagation();
    closeThemePop();
    const btn = $("#wl-theme");
    if (btn) btn.focus();
  }

  function renderThemePop() {
    if (!S.themePop) return;
    const has = !!S.bg;
    const pct = has ? Math.round((1 - S.bg.opacity) * 100) : 65;
    S.themePop.innerHTML = `<h3>Background</h3>
      <div class="wl-theme-actions">
        <button type="button" class="wl-btn is-sm" data-act="choose">${has ? "Change image…" : "Choose image…"}</button>
        ${has ? '<button type="button" class="wl-btn is-sm" data-act="remove">Remove</button>' : ""}
      </div>
      <label class="wl-theme-row"${has ? "" : " hidden"}>Transparency
        <input type="range" min="0" max="95" step="1" value="${pct}" aria-label="Transparency">
        <span class="wl-theme-val">${pct}%</span></label>
      <div class="wl-theme-note">${has ? "Higher is more see-through." : "PNG, JPEG, WebP or GIF, up to 20 MB."}</div>
      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>`;
    const pop = S.themePop;
    const refocus = pop.contains(document.activeElement) || document.activeElement === document.body;
    const input = $("input[type=file]", pop);
    input.addEventListener("change", () => pickBackgroundFile(input));
    $('[data-act="choose"]', pop).addEventListener("click", () => input.click());
    const rm = $('[data-act="remove"]', pop);
    if (rm) rm.addEventListener("click", async () => { clearTimeout(bgSave); if (await saveBackground({ clear: true })) renderThemePop(); });
    const range = $("input[type=range]", pop);
    range.addEventListener("input", () => {
      const v = Number(range.value);
      $(".wl-theme-val", pop).textContent = v + "%";
      const opacity = Math.max(0.05, 1 - v / 100);
      document.body.style.setProperty("--wl-bg-opacity", String(opacity));
      clearTimeout(bgSave);
      bgSave = setTimeout(() => saveBackground({ opacity }), 300);
    });
    if (refocus) $('[data-act="choose"]', pop).focus();      // re-rendering destroyed the focused button
  }

  function toggleThemePop() {
    if (S.themePop) { closeThemePop(); return; }
    const pop = el("div", "wl-theme-pop");
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Background image");
    document.body.append(pop);
    S.themePop = pop;
    renderThemePop();
    const btn = $("#wl-theme");
    if (btn) btn.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onThemeOutside, true);
    document.addEventListener("keydown", onThemeKey, true);
    const first = $("button", pop);
    if (first) first.focus();
  }

  // ---------------------------------------------------------------- Start column
  function renderStart() {
    const list = $("#wl-start-list");
    list.innerHTML = "";
    list.append(
      startRow("new", plusCircle(16), "New Project…", "N", () => openNewProject()),
      startRow("open", T.icon("folder-open"), "Open Folder…", "O", () => openFolderFlow())
    );
  }

  function startRow(id, icon, label, key, fn) {
    const b = el("button", "wl-row wl-srow wl-nav");
    b.type = "button";
    b.id = "wl-" + id;
    b.dataset.group = "start";
    b.setAttribute("aria-keyshortcuts", (MAC ? "Meta+" : "Control+") + key);
    b.innerHTML = `<span class="wl-row-icon">${icon}</span><span class="wl-row-label">${esc(label)}</span>` +
      `<span class="wl-row-kbd">${esc(MOD + key)}</span>`;
    b.addEventListener("click", fn);
    return b;
  }

  async function openFolderFlow() {
    if (S.opening || S.picking) return;
    if (S.noPicker) { showPathField(); return; }
    S.picking = true;
    let path = null;
    try {
      path = await H.pickFolder("Open a LaTeX folder");
    } catch (e) {
      if (e && e.code === "no_picker") { S.noPicker = true; showPathField(); }
      else toast(`Couldn't show the folder picker: ${errText(e)}`, "error");
      return;
    } finally {
      S.picking = false;
    }
    if (path) openPath(path, { source: "open" });
  }

  // No folder picker (browser mode without the macOS chooser): type the path instead.
  function showPathField() {
    $("#wl-path").hidden = false;
    const input = $("#wl-path-input");
    input.focus();
    input.select();
  }
  function hidePathField() {
    $("#wl-path").hidden = true;
    $("#wl-path-error").hidden = true;
  }
  function onPathSubmit(e) {
    e.preventDefault();
    const input = $("#wl-path-input"), err = $("#wl-path-error");
    const v = input.value.trim();
    err.hidden = true;
    if (!v) { input.focus(); return; }
    openPath(v, {
      source: "path",
      onError: (m) => { err.textContent = m; err.hidden = false; input.focus(); },
    });
  }

  // One way to open a folder: Recent, Open Folder, the typed path. Shows a busy state meanwhile
  // (browser mode waits for the folder's server to start, up to ~20 s).
  async function openPath(path, opts) {
    opts = opts || {};
    if (S.opening) return false;
    const label = opts.label || T.util.basename(String(path).replace(/\/+$/, "")) || path;
    const newWindow = !!(opts.newWindow && H.native);
    setOpening({ path, source: opts.source || "open" });
    const fail = (msg) => {
      setOpening(null);
      if (opts.onError) opts.onError(msg); else toast(msg, "error");
    };
    let res;
    try {
      res = await H.openFolder(path, { newWindow });
    } catch (e) {
      fail(`Couldn't open “${label}”: ${errText(e)}`);
      return false;
    }
    if (H.native) {
      // "opened": this window is switching to the folder (keep the spinner until the page goes);
      // "focused" / "cancelled", or a new window: nothing more to do here.
      if (res === "opened" && !newWindow) holdOpening(20000); else setOpening(null);
    } else if (res === true) {
      holdOpening(15000);   // this tab is navigating to the folder's server
    } else {
      fail(`Couldn't open “${label}”.`);
    }
    return res;
  }
  function setOpening(o) {
    clearTimeout(S.openTimer);
    S.opening = o;
    paintBusy();
  }
  function holdOpening(ms) {
    clearTimeout(S.openTimer);
    S.openTimer = setTimeout(() => setOpening(null), ms);
  }

  function paintBusy() {
    const o = S.opening;
    const openBtn = $("#wl-open");
    if (openBtn) {
      const busy = !!(o && o.source === "open");
      openBtn.classList.toggle("is-busy", busy);
      $(".wl-row-kbd", openBtn).innerHTML = busy ? '<span class="wl-spin"></span>' : esc(MOD + "O");
    }
    const pathBtn = $('#wl-path button[type="submit"]');
    if (pathBtn) {
      const busy = !!(o && o.source === "path");
      pathBtn.disabled = busy;
      pathBtn.classList.toggle("is-busy", busy);
      pathBtn.innerHTML = busy ? '<span class="wl-spin"></span>Opening…' : "Open";
    }
    document.querySelectorAll(".wl-rrow").forEach((row) => {
      const busy = !!(o && o.source === "recent" && o.path === row.dataset.path);
      if (busy === row.classList.contains("is-busy")) return;
      row.classList.toggle("is-busy", busy);
      const r = S.recent.find((x) => x.path === row.dataset.path);
      const time = $(".wl-rtime", row);
      if (time) time.innerHTML = busy ? '<span class="wl-spin"></span>Opening…' : esc(r ? rowTime(r) : "");
    });
    document.body.classList.toggle("is-opening", !!o);
  }

  // ---------------------------------------------------------------- Recent column
  function renderRecent() {
    if (S.pointerDown) { S.renderLater = true; return; }   // don't swap rows under a click
    const list = $("#wl-recent-list");
    const active = document.activeElement;
    const activeRow = active && active.closest ? active.closest(".wl-rrow") : null;
    const keepPath = activeRow ? activeRow.dataset.path : null;
    list.removeAttribute("aria-busy");
    list.innerHTML = "";
    let empty = true;
    if (!S.data && S.loadError) {
      const p = el("p", "wl-empty is-error", `Couldn't load your recent folders: ${esc(S.loadError)} `);
      const retry = el("button", "wl-link", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => refreshRecent(true));
      p.append(retry);
      list.append(p);
    } else if (!S.recent.length) {
      list.append(el("p", "wl-empty", "No recent folders yet. Open a folder with your .tex files to get started."));
    } else {
      empty = false;
      const frag = document.createDocumentFragment();
      for (const r of S.recent) frag.append(recentRow(r));
      list.append(frag);
    }
    const openBtn = $("#wl-open");
    if (openBtn) openBtn.classList.toggle("is-prominent", empty);   // empty Recent: Open Folder stays prominent
    paintBusy();
    if (keepPath) {
      const row = rowFor(keepPath);
      if (row) row.focus({ preventScroll: true });
    }
  }

  function recentRow(r) {
    const missing = r.exists === false;
    const name = String(r.name || T.util.basename(r.path) || r.path);
    const disp = String(r.display || tilde(r.path));
    const when = rowTime(r);
    const opened = Number(r.opened) > 0 ? new Date(Number(r.opened) * 1000) : null;
    const row = el("div", "wl-row wl-rrow wl-nav" + (missing ? " is-missing" : ""));
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.dataset.group = "recent";
    row.dataset.path = r.path;
    row.title = missing ? `${disp}\nNot available. Is its drive connected?` : disp;
    row.setAttribute("aria-label", `${name}, ${disp}, ${missing ? "not available" : "opened " + when}`);
    row.innerHTML =
      `<span class="wl-ricon">${T.icon("folder")}</span>` +
      `<span class="wl-rname">${esc(name)}</span>` +
      `<span class="wl-rpath">${pathHtml(disp)}</span>` +
      `<span class="wl-rtime"${opened && !missing ? ` title="Opened ${esc(opened.toLocaleString())}"` : ""}>${esc(when)}</span>` +
      `<button type="button" class="wl-rx" tabindex="-1" title="Remove from Recent" aria-label="Remove ${esc(name)} from Recent">${T.icon("close", 14)}</button>`;
    return row;
  }

  function rowFor(path) {
    for (const row of document.querySelectorAll(".wl-rrow")) if (row.dataset.path === path) return row;
    return null;
  }

  function onRecentClick(e) {
    const row = e.target.closest(".wl-rrow");
    if (!row) return;
    if (e.target.closest(".wl-rx")) {
      e.stopPropagation();
      forget(row.dataset.path);
      return;
    }
    activateRecent(row.dataset.path, MAC ? e.metaKey : e.ctrlKey);
  }

  async function activateRecent(path, newWindow) {
    if (S.opening) return;
    let r = S.recent.find((x) => x.path === path);
    if (!r) return;
    if (r.exists === false) {
      await refreshRecent(true);   // its drive may be back
      r = S.recent.find((x) => x.path === path) || r;
      if (r.exists === false) {
        toast(`“${r.name || T.util.basename(path)}” isn't available. Connect its drive, or remove it from Recent.`, "warn");
        return;
      }
    }
    openPath(path, { source: "recent", newWindow, label: r.name });
  }

  async function forget(path) {
    const rows = Array.from(document.querySelectorAll(".wl-rrow"));
    const idx = rows.findIndex((x) => x.dataset.path === path);
    const hadFocus = idx >= 0 && rows[idx].contains(document.activeElement);
    let res;
    try {
      res = await T.api.post("/api/recent/forget", { path });
    } catch (e) {
      toast(`Couldn't remove it from Recent: ${errText(e)}`, "error");
      return;
    }
    setRecent(res && Array.isArray(res.recent) ? res.recent : S.recent.filter((x) => x.path !== path));
    renderRecent();
    if (hadFocus) {
      const left = document.querySelectorAll(".wl-rrow");
      const next = left[Math.min(idx, left.length - 1)] || $("#wl-open");
      if (next) next.focus();
    }
  }

  function updateTimes() {
    document.querySelectorAll(".wl-rrow").forEach((row) => {
      if (row.classList.contains("is-busy")) return;
      const r = S.recent.find((x) => x.path === row.dataset.path);
      const t = $(".wl-rtime", row);
      if (r && t) t.textContent = rowTime(r);
    });
  }

  // ---------------------------------------------------------------- footer
  function renderStatus() {
    const box = $("#wl-status");
    const t = S.data && S.data.tools;
    if (!t || typeof t !== "object") { box.innerHTML = ""; return; }
    const tex = t.latexmk ? { k: "is-ok", text: "latexmk ready" } : { k: "is-warn", text: "not found — install MacTeX" };
    const ai = t.claude ? { k: "is-ok", text: "Claude Code · needs internet" }
      : t.codex ? { k: "is-ok", text: "Codex · needs internet" }
      : { k: "is-off", text: "off — install Claude Code" };
    const stat = (name, s) =>
      `<span class="wl-stat ${s.k}"><span class="wl-dot ${s.k}"></span>` +
      `<span class="wl-stat-name">${esc(name)}</span><span class="wl-stat-text">${esc(s.text)}</span></span>`;
    box.innerHTML = stat("TeX", tex) + stat("AI", ai);
  }

  // ---------------------------------------------------------------- keyboard
  function navRows(group) {
    return Array.from(document.querySelectorAll(`.wl-nav[data-group="${group}"]`));
  }

  // ↑/↓ within a column, ←/→ between Start and Recent, Enter opens, Delete removes from Recent.
  function onNavKey(e) {
    if (S.modal || e.defaultPrevented || e.altKey || e.ctrlKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (t && t.closest && t.closest(".wl-rx")) return;   // the × button handles its own keys
    const k = e.key;
    const row = t && t.closest ? t.closest(".wl-nav") : null;
    if (!row) {
      if ((k === "ArrowDown" || k === "ArrowUp") && !e.metaKey && (!t || t === document.body || t === document.documentElement)) {
        const rows = navRows("recent").length ? navRows("recent") : navRows("start");
        const target = k === "ArrowDown" ? rows[0] : rows[rows.length - 1];
        if (target) { e.preventDefault(); target.focus(); }
      }
      return;
    }
    const group = row.dataset.group;
    if (k === "Enter" || k === " ") {
      if (group === "recent") {
        e.preventDefault();
        activateRecent(row.dataset.path, e.metaKey);
      }
      return;   // Start rows are buttons: they click by themselves
    }
    if (e.metaKey) return;
    if ((k === "Delete" || k === "Backspace") && group === "recent") {
      e.preventDefault();
      forget(row.dataset.path);
      return;
    }
    const rows = navRows(group), i = rows.indexOf(row);
    let target = null;
    if (k === "ArrowDown") target = rows[Math.min(i + 1, rows.length - 1)];
    else if (k === "ArrowUp") target = rows[Math.max(i - 1, 0)];
    else if (k === "Home") target = rows[0];
    else if (k === "End") target = rows[rows.length - 1];
    else if (k === "ArrowRight" || k === "ArrowLeft") {
      const toRecent = k === "ArrowRight";
      if (toRecent === (group === "start")) {
        const other = navRows(toRecent ? "recent" : "start");
        target = other[Math.min(i, other.length - 1)] || null;
      }
    } else return;
    e.preventDefault();
    if (target && target !== row) target.focus();
  }

  // Browser mode only; in the app the File menu owns ⌘N / ⌘O.
  function onShortcut(e) {
    const mod = MAC ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey || e.shiftKey || e.defaultPrevented) return;
    const key = typeof e.key === "string" && e.key.length === 1 ? e.key.toLowerCase() : "";
    const which = key === "o" || key === "n" ? key : /^[a-z]$/.test(key) ? null : { KeyO: "o", KeyN: "n" }[e.code];
    if (!which) return;
    e.preventDefault();
    if (which === "n") openNewProject();
    else if (!S.modal) openFolderFlow();
  }

  // ---------------------------------------------------------------- New Project modal
  async function openNewProject() {
    closeThemePop();
    if (S.modal) { S.modal.focus(); return; }
    if (S.ready) { try { await S.ready; } catch (_) { /* opens with fallbacks */ } }
    if (S.modal) { S.modal.focus(); return; }
    S.modal = newProjectModal();
  }

  function nameProblem(n) {
    if (!n) return "Enter a name for the project folder.";
    if (n.length > 100) return "Use at most 100 characters.";
    if (n.indexOf("/") >= 0 || n.indexOf("\u0000") >= 0) return "A folder name can't contain “/”.";
    if (n === "." || n === "..") return "Choose another name.";
    if (n.charAt(0) === ".") return "A folder name can't start with a dot.";
    if (/[\u0000-\u001f\u007f]/.test(n)) return "A folder name can't contain line breaks or control characters.";
    if (n.endsWith("\\")) return "A folder name can't end with a backslash (\\).";
    return null;
  }

  function newProjectModal() {
    const d = S.data || {};
    const defaults = d.defaults || {};
    let templates = Array.isArray(d.templates) ? d.templates.filter((t) => t && t.id) : [];
    if (!templates.length) templates = FALLBACK_TEMPLATES;
    const first = templates.find((t) => t.id === "article") || templates[0];
    const st = {
      parent: String(defaults.parent || ""),
      typed: false,      // Location is a typed path (no folder picker)
      template: first.id,
      busy: false,
      created: null,     // {key, folder}: created, but opening it failed (Create retries the open)
      timer: 0,
      downOnScrim: false,
    };
    const opener = document.activeElement;

    const scrim = el("div", "wl-scrim");
    const card = el("div", "wl-modal");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "wl-np-title");
    card.tabIndex = -1;
    card.innerHTML =
      `<div class="wl-modal-head"><h2 id="wl-np-title" class="wl-modal-title">New Project</h2>` +
      `<button type="button" class="wl-icon-btn" data-act="close" title="Close" aria-label="Close">${T.icon("close")}</button></div>` +
      `<form class="wl-np-form" novalidate autocomplete="off">` +
      `<label class="wl-field"><span class="wl-field-label">Name</span>` +
      `<input class="wl-input" name="name" type="text" maxlength="100" spellcheck="false" autocapitalize="off" autocorrect="off"></label>` +
      `<div class="wl-field"><span class="wl-field-label" id="wl-np-loc">Location</span>` +
      `<div class="wl-loc"><div class="wl-loc-box"></div>` +
      `<input class="wl-input" name="parent" type="text" spellcheck="false" autocapitalize="off" autocorrect="off" hidden aria-labelledby="wl-np-loc" placeholder="~/Documents">` +
      `<button type="button" class="wl-btn" data-act="change" aria-label="Change location">Change…</button></div></div>` +
      `<div class="wl-field"><span class="wl-field-label" id="wl-np-tpl">Template</span>` +
      `<div class="wl-tpls" role="radiogroup" aria-labelledby="wl-np-tpl">` +
      templates.map((t) =>
        `<button type="button" class="wl-tpl" role="radio" data-id="${esc(t.id)}">` +
        `<span class="wl-tpl-name">${esc(t.name || t.id)}</span>` +
        (t.description ? `<span class="wl-tpl-desc">${esc(t.description)}</span>` : "") +
        `<span class="wl-tpl-check">${T.icon("check", 14)}</span></button>`).join("") +
      `</div></div>` +
      `<div class="wl-preview"></div>` +
      `<div class="wl-error" role="alert" hidden></div>` +
      `<div class="wl-modal-foot"><button type="button" class="wl-btn" data-act="cancel">Cancel</button>` +
      `<button type="submit" class="wl-btn is-primary" data-act="create">Create</button></div>` +
      `</form>`;
    scrim.append(card);
    $("#wl-overlay").append(scrim);

    const form = $("form", card);
    const nameIn = $('input[name="name"]', card);
    const locBox = $(".wl-loc-box", card);
    const locIn = $('input[name="parent"]', card);
    const changeBtn = $('[data-act="change"]', card);
    const cancelBtn = $('[data-act="cancel"]', card);
    const createBtn = $('[data-act="create"]', card);
    const errBox = $(".wl-error", card);
    const preview = $(".wl-preview", card);
    nameIn.value = DEFAULT_NAME;

    const parentValue = () => (st.typed ? locIn.value.trim() : st.parent);
    const mainOf = () => {
      const t = templates.find((x) => x.id === st.template) || first;
      return String(t.main || "main.tex");
    };

    function renderLoc() {
      const p = st.parent;
      locBox.classList.toggle("is-empty", !p);
      locBox.title = p;
      locBox.innerHTML = `<span class="wl-row-icon">${T.icon("folder")}</span>` +
        `<span class="wl-loc-path">${p ? pathHtml(tilde(p)) : "Choose a location"}</span>`;
    }
    function renderTemplates() {
      card.querySelectorAll(".wl-tpl").forEach((b) => {
        const on = b.dataset.id === st.template;
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
      });
    }
    function showErr(text, kind) {
      errBox.textContent = text;
      errBox.dataset.kind = kind || "server";
      errBox.hidden = false;
    }
    function hideErr() {
      errBox.hidden = true;
      errBox.textContent = "";
      delete errBox.dataset.kind;
    }
    function update() {
      const name = nameIn.value.trim();
      const parent = parentValue();
      const prob = name ? nameProblem(name) : null;
      const shown = st.typed ? parent : tilde(parent);
      preview.innerHTML = parent
        ? `Creates <code>${esc(joinPath(joinPath(shown, name || "…"), mainOf()))}</code>`
        : "Choose where to create the project.";
      if (prob) showErr(prob, "name");
      else if (errBox.dataset.kind === "name") hideErr();
      createBtn.disabled = st.busy || !name || !!prob || !parent;
    }
    function setBusy(on, label) {
      st.busy = on;
      card.classList.toggle("is-busy", on);
      [nameIn, locIn, changeBtn, cancelBtn].forEach((x) => { x.disabled = on; });
      card.querySelectorAll(".wl-tpl").forEach((b) => { b.disabled = on; });
      createBtn.classList.toggle("is-busy", on);
      createBtn.innerHTML = on ? `<span class="wl-spin"></span>${esc(label)}` : st.created ? "Open" : "Create";
      update();
    }

    function useTyped() {
      if (!st.typed) {
        st.typed = true;
        locIn.value = st.parent ? tilde(st.parent) : "~/";
        locBox.hidden = true;
        changeBtn.hidden = true;
        locIn.hidden = false;
      }
      locIn.focus();
      locIn.select();
      update();
    }
    async function change() {
      if (st.busy) return;
      if (S.noPicker) { useTyped(); return; }
      let p = null;
      try {
        p = await H.pickFolder("Choose where to create the project");
      } catch (e) {
        if (e && e.code === "no_picker") { S.noPicker = true; useTyped(); }
        else showErr(`Couldn't show the folder picker: ${errText(e)}`);
        return;
      }
      if (p && S.modal === api) {
        st.parent = p;
        renderLoc();
        update();
      }
    }

    async function submit(e) {
      if (e) e.preventDefault();
      if (st.busy) return;
      const name = nameIn.value.trim();
      const parent = parentValue();
      const prob = nameProblem(name) || (parent ? null : "Choose where to create the project.");
      if (prob) {
        showErr(prob, "name");
        (name ? (st.typed ? locIn : changeBtn) : nameIn).focus();
        return;
      }
      hideErr();
      const key = JSON.stringify([parent, name, st.template]);
      let folder = st.created && st.created.key === key ? st.created.folder : null;
      if (!folder) {
        st.created = null;
        setBusy(true, "Creating…");
        try {
          const r = await T.api.post("/api/lobby/new", { parent, name, template: st.template });
          folder = r && r.folder;
          if (!folder) throw new Error("The server didn't say where it created the project.");
        } catch (err) {
          setBusy(false);
          showErr(errText(err));
          nameIn.focus();
          return;
        }
        st.created = { key, folder };
      }
      setBusy(true, "Opening…");
      let res;
      try {
        res = await H.openFolder(folder);
      } catch (err) {
        setBusy(false);
        showErr(`Created ${tilde(folder)}, but couldn't open it: ${errText(err)}`);
        return;
      }
      if (H.native ? res === "opened" : res === true) {
        // The page is about to be replaced; close anyway if that somehow doesn't happen.
        clearTimeout(st.timer);
        st.timer = setTimeout(() => close(true), 20000);
      } else if (H.native) {
        close(true);   // "focused" or "cancelled"
      } else {
        setBusy(false);
        showErr(`Created ${tilde(folder)}, but couldn't open it.`);
      }
    }

    function close(force) {
      if (st.busy && !force) return;
      clearTimeout(st.timer);
      document.removeEventListener("keydown", onKey, true);
      scrim.remove();
      if (S.modal === api) S.modal = null;
      if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === "function") {
        opener.focus({ preventScroll: true });
      }
    }

    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(false);
      } else if (e.key === "Tab") {
        const items = Array.from(card.querySelectorAll("button, input"))
          .filter((x) => !x.disabled && !x.hidden && x.tabIndex >= 0 && x.offsetParent !== null);
        if (!items.length) { e.preventDefault(); card.focus(); return; }
        const firstItem = items[0], lastItem = items[items.length - 1], a = document.activeElement;
        if (e.shiftKey && (a === firstItem || !card.contains(a) || a === card)) { e.preventDefault(); lastItem.focus(); }
        else if (!e.shiftKey && (a === lastItem || !card.contains(a) || a === card)) { e.preventDefault(); firstItem.focus(); }
      }
    }
    document.addEventListener("keydown", onKey, true);

    card.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]");
      if (!act || act.disabled) return;
      if (act.dataset.act === "close" || act.dataset.act === "cancel") close(false);
      else if (act.dataset.act === "change") change();
    });
    const tplBox = $(".wl-tpls", card);
    tplBox.addEventListener("click", (e) => {
      const b = e.target.closest(".wl-tpl");
      if (!b || st.busy) return;
      st.template = b.dataset.id;
      renderTemplates();
      update();
    });
    tplBox.addEventListener("keydown", (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step || st.busy) return;
      e.preventDefault();
      const btns = Array.from(card.querySelectorAll(".wl-tpl"));
      const i = btns.findIndex((b) => b.dataset.id === st.template);
      const next = btns[(i + step + btns.length) % btns.length];
      st.template = next.dataset.id;
      renderTemplates();
      update();
      next.focus();
    });
    const onEdit = () => { if (errBox.dataset.kind === "server") hideErr(); update(); };
    nameIn.addEventListener("input", onEdit);
    locIn.addEventListener("input", onEdit);
    form.addEventListener("submit", submit);
    scrim.addEventListener("mousedown", (e) => { st.downOnScrim = e.target === scrim; });
    scrim.addEventListener("click", (e) => { if (e.target === scrim && st.downOnScrim) close(false); });

    const api = {
      focus() { if (!st.busy) nameIn.focus(); },
      close,
    };
    renderLoc();
    renderTemplates();
    update();
    nameIn.focus();
    nameIn.select();
    return api;
  }

  // ---------------------------------------------------------------- boot
  function wantsNew() {
    try { return new URLSearchParams(location.search).get("new") === "1"; } catch (_) { return false; }
  }
  function dropNewParam() {
    try {
      const u = new URL(location.href);
      u.searchParams.delete("new");
      history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    } catch (_) { /* cosmetic */ }
  }

  function boot() {
    document.title = "texc";
    H.on("newProject", () => { openNewProject(); return true; });
    H.notify({ mode: "lobby" });
    $("#wl-mark").innerHTML = markSvg(36);
    const themeBtn = $("#wl-theme");
    if (themeBtn) { themeBtn.innerHTML = T.icon("image", 16); themeBtn.addEventListener("click", toggleThemePop); }
    renderStart();

    $("#wl-recent-list").addEventListener("click", onRecentClick);
    $("#wl-path").addEventListener("submit", onPathSubmit);
    $("#wl-path-input").addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      hidePathField();
      const b = $("#wl-open");
      if (b) b.focus();
    });
    document.addEventListener("keydown", onNavKey);
    if (!H.native) document.addEventListener("keydown", onShortcut);

    // A click that lands while Recent re-renders would be lost: re-render after it instead.
    document.addEventListener("mousedown", () => { S.pointerDown = true; }, true);
    document.addEventListener("mouseup", () => {
      S.pointerDown = false;
      if (S.renderLater) setTimeout(() => { if (S.renderLater && !S.pointerDown) { S.renderLater = false; renderRecent(); } }, 0);
    }, true);

    window.addEventListener("blur", () => { S.pointerDown = false; });
    window.addEventListener("focus", () => refreshRecent(false));
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshRecent(false); });
    window.addEventListener("pageshow", (e) => {
      if (!e.persisted) return;   // back from a folder (browser bfcache): reset and refresh
      setOpening(null);
      if (S.modal) S.modal.close(true);
      refreshRecent(true);
    });
    setInterval(updateTimes, 60000);

    S.ready = load();
    if (wantsNew()) { dropNewParam(); openNewProject(); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
