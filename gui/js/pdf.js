/* texc PDF preview. See docs/ARCHITECTURE.md.
 * The toolbar, lazily rendered devicePixelRatio-aware pages (PDF.js 3.11 UMD, global pdfjsLib),
 * double-buffered reloads that keep the reading position, the SyncTeX double-click,
 * flash highlights, the failure banner and the empty state. */
(function () {
  "use strict";
  const T = (window.T = window.T || {});

  const WORKER_SRC = "/vendor/pdfjs/pdf.worker.min.js";
  const CSS_UNITS = 96 / 72;   // zoom 1 (100%) = true size: 1 pt = 4/3 CSS px, as in PDF.js' own viewer
  const PAD = 12;              // px around the page stack    } must match #pdf-pages padding and
  const GAP = 12;              // px between pages            } .pdf-page margin-bottom in pdf.css
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 4;
  const MAX_CANVAS_PIXELS = 4096 * 4096; // per page; Safari refuses bigger canvases
  const CANVAS_BUDGET = 60e6;            // device pixels kept alive for pages outside the view
  const RENDER_AHEAD = "100% 0px";       // also render pages within one viewport of the visible area
  const MAX_PARALLEL = 2;                // page renders in flight at once
  const ZOOMS = [
    ["fit", "Zoom to fit"], ["page", "Fit page"], [0.5, "50%"], [0.75, "75%"],
    [1, "100%"], [1.25, "125%"], [1.5, "150%"], [2, "200%"],
  ];
  const MESSAGES = {
    empty: "No PDF yet — press Compile",
    loading: "Loading PDF…",
    error: "Couldn't open the PDF",
    nomain: "This folder has no main .tex file",
  };
  const LS_ZOOM = "texc.pdf.zoom";
  const LS_POS = "texc.pdf.pos:";

  const S = {
    inited: false,
    root: null, toolbar: null, banner: null, scroll: null, pagesEl: null, empty: null,
    ui: {},
    worker: null,
    doc: null, url: null, views: [],   // the document on screen and its page views
    zoom: "fit", scale: CSS_UNITS,     // zoom mode and the CSS px per PDF point it gives
    key: "",                           // render key (scale + devicePixelRatio) pages must match
    io: null, visible: new Set(),      // page indexes inside the render-ahead area
    pending: null,                     // the load in flight, if any
    running: 0, pumpQueued: false, hold: false, holdTimer: 0,
    current: 0, lock: null,            // current page index; lock pins it after gotoPage()
    message: null, savedPos: null,     // "empty" | "loading" | "error" | null; spot kept while hidden
    initialPos: null, posKey: "",
    menu: null,
    compiling: false, compileGuard: 0,
    flashQueue: null,
    scrollRaf: 0, gestureZoom: 1,
  };

  // ---------------------------------------------------------------------------------------------
  // helpers
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const esc = (s) => T.util.esc(s);
  const icon = (name, size) => (T.icon ? T.icon(name, size) : "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad2 = (n) => String(n).padStart(2, "0");
  const isCancel = (e) => !!e && (e.name === "RenderingCancelledException" || e.name === "AbortError");

  function h(tag, cls, attrs) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    return el;
  }
  // Per-folder UI state through T.store (api.js; docs/ARCHITECTURE.md); localStorage if it's missing.
  function lsGet(k) { try { return T.store ? T.store.get(k) : localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { if (T.store) T.store.set(k, String(v)); else localStorage.setItem(k, v); } catch (_) { /* private mode */ } }
  function toast(text, kind) {
    if (T.app && typeof T.app.toast === "function") T.app.toast(text, kind || "info");
    else console.warn("[pdf] " + text);
  }
  function freeCanvas(c) {
    if (c) { c.width = 0; c.height = 0; } // releases the backing store at once (matters in Safari)
  }

  // ---------------------------------------------------------------------------------------------
  // init + toolbar
  function init(previewEl) {
    if (S.inited) return;
    S.inited = true;
    const root = (S.root = previewEl || document.getElementById("preview"));
    const part = (id, tag) => root.querySelector("#" + id) || root.appendChild(h(tag, "", { id }));
    S.toolbar = part("pdf-toolbar", "div");
    S.banner = part("pdf-banner", "div");
    S.scroll = part("pdf-scroll", "div");
    S.pagesEl = S.scroll.querySelector("#pdf-pages") || S.scroll.appendChild(h("div", "", { id: "pdf-pages" }));
    S.empty = part("pdf-empty", "div");
    S.banner.setAttribute("role", "status");
    S.banner.setAttribute("aria-live", "polite");
    S.scroll.tabIndex = 0; // lets arrow/page keys scroll the pages after a click
    S.scroll.setAttribute("aria-label", "PDF pages");

    S.zoom = readZoom();
    buildToolbar();
    updateZoomLabel();
    updateToolbarState();

    S.scroll.addEventListener("scroll", onScroll, { passive: true });
    S.scroll.addEventListener("wheel", onWheel, { passive: false });
    S.scroll.addEventListener("gesturestart", onGestureStart);   // Safari trackpad pinch
    S.scroll.addEventListener("gesturechange", onGestureChange);
    S.scroll.addEventListener("gestureend", (e) => e.preventDefault());
    S.pagesEl.addEventListener("dblclick", onDblClick);
    S.pagesEl.addEventListener("mousedown", (e) => { if (e.detail > 1) e.preventDefault(); });
    if (window.ResizeObserver) new ResizeObserver(onResize).observe(S.scroll);
    else window.addEventListener("resize", onResize);
    window.addEventListener("resize", () => closeMenu(false));
    watchDpr();

    const root0 = (T.state && T.state.project && T.state.project.root) || location.pathname;
    // ui-state keys are capped at 200 chars; T.store is per folder anyway, so a long root is dropped.
    S.posKey = (LS_POS + root0).length <= 200 ? LS_POS + root0 : LS_POS.slice(0, -1);
    try { S.initialPos = JSON.parse(lsGet(S.posKey) || "null"); } catch (_) { S.initialPos = null; }

    if (!window.pdfjsLib) {
      setMessage("error", "The PDF viewer library failed to load.");
    } else {
      pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_SRC;
      const proj = T.state && T.state.project;
      if (proj && proj.main_exists === false) setMessage("nomain");
      else if (proj && proj.has_pdf === false) setMessage("empty");
    }
  }

  function buildToolbar() {
    const tb = S.toolbar;
    tb.textContent = "";
    tb.setAttribute("role", "toolbar");
    tb.setAttribute("aria-label", "PDF preview");
    const mac = !T.util || T.util.isMac !== false;

    const compile = h("button", "pdf-btn pdf-compile", { type: "button", title: `Compile (${mac ? "⌘↵" : "Ctrl+Enter"})` });
    compile.innerHTML = icon("refresh", 15) + '<span class="pdf-compile-label">Compile</span>';
    compile.addEventListener("click", () => T.bus.emit("compile:request", {}));

    const pagebox = h("label", "pdf-pagebox", { title: "Go to page" });
    const input = h("input", "pdf-page-input", {
      type: "text", inputmode: "numeric", autocomplete: "off", spellcheck: "false", "aria-label": "Page number",
    });
    const of = h("span", "pdf-page-of");
    pagebox.append(input, of);
    input.addEventListener("focus", () => input.select());
    input.addEventListener("input", () => {
      const clean = input.value.replace(/\D+/g, "");
      if (clean !== input.value) input.value = clean;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const n = parseInt(input.value, 10);
        if (n) gotoPage(n);
        updatePageBox(true);
        input.select();
      } else if (e.key === "Escape") {
        e.preventDefault();
        updatePageBox(true);
        input.blur();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        gotoPage(S.current + 1 + (e.key === "ArrowDown" ? 1 : -1));
        updatePageBox(true);
        input.select();
      }
    });
    input.addEventListener("blur", () => updatePageBox(true));

    const zoom = h("button", "pdf-btn pdf-zoom", { type: "button", "aria-haspopup": "menu", "aria-expanded": "false" });
    zoom.innerHTML = '<span class="pdf-zoom-label"></span>' + icon("chevron-down", 14);
    zoom.addEventListener("click", () => toggleMenu(zoom, zoomItems));

    const dl = h("button", "pdf-btn pdf-icon-btn pdf-download", { type: "button", title: "Download PDF", "aria-label": "Download PDF" });
    dl.innerHTML = icon("download", 16);
    dl.addEventListener("click", download);

    const more = h("button", "pdf-btn pdf-icon-btn pdf-more", {
      type: "button", title: "More", "aria-label": "More actions", "aria-haspopup": "menu", "aria-expanded": "false",
    });
    more.innerHTML = icon("more", 16);
    more.addEventListener("click", () => toggleMenu(more, moreItems));

    tb.append(compile, h("div", "pdf-tb-spacer"), pagebox, zoom, dl, more);
    S.ui = {
      compile, compileLabel: compile.querySelector(".pdf-compile-label"),
      input, of, zoom, zoomLabel: zoom.querySelector(".pdf-zoom-label"), dl, more,
    };
  }

  function updatePageBox(force) {
    const { input, of } = S.ui;
    if (!input) return;
    const n = S.message === null ? S.views.length : 0; // pages hidden behind a message count as none
    const digits = Math.max(2, String(n).length);
    input.disabled = !n;
    input.maxLength = digits;
    input.style.width = `calc(${digits}ch + 14px)`;
    input.placeholder = n ? "" : "–";
    // Never overwrite what the user is typing; blur/Enter/Escape pass force to resync.
    if (force || document.activeElement !== input) input.value = n ? pad2(S.current + 1) : "";
    of.textContent = n ? `of ${n}` : "of –";
  }

  function zoomText(mode) {
    if (mode === "fit") return "Zoom to fit";
    if (mode === "page") return "Fit page";
    return Math.round(mode * 100) + "%";
  }
  function updateZoomLabel() {
    if (!S.ui.zoomLabel) return;
    S.ui.zoomLabel.textContent = zoomText(S.zoom);
    S.ui.zoom.title = "Zoom: " + zoomText(S.zoom);
  }
  const showingPdf = () => !!S.doc && S.message === null;
  function updateToolbarState() {
    if (S.ui.dl) S.ui.dl.disabled = !showingPdf();
    updatePageBox();
  }

  function download() {
    if (!showingPdf()) return;
    const a = h("a", "", { href: T.api.url("/api/pdf", { download: 1 }), download: "" });
    a.hidden = true;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------------------------------------------------------------------------------------------
  // light dropdown menus, positioned inside #preview so they sit on the white card
  const sameZoom = (a, b) => a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-3);

  function zoomItems() {
    return ZOOMS.map(([mode, label]) => ({ label, checked: sameZoom(mode, S.zoom), onClick: () => setZoom(mode) }));
  }
  function moreItems() {
    const has = showingPdf();
    const mac = !T.util || T.util.isMac !== false;
    return [
      { label: "Sync to cursor", icon: "search", disabled: !has, onClick: () => T.bus.emit("pdf:sync-to-cursor", {}) },
      { label: "View log", icon: "doc", onClick: () => T.bus.emit("log:show", {}) },
      { label: mac ? "Open in Preview" : "Open externally", icon: "external", disabled: !has, onClick: () => T.bus.emit("pdf:open-external", {}) },
      "-",
      { label: "Recompile from scratch", icon: "refresh", onClick: () => T.bus.emit("compile:request", { clean: true }) },
      { label: "Clean build files", icon: "trash", onClick: () => T.bus.emit("build:clean", {}) },
    ];
  }

  function toggleMenu(anchor, itemsFn) {
    if (S.menu && S.menu.anchor === anchor) closeMenu(false);
    else openMenu(anchor, itemsFn());
  }

  function openMenu(anchor, items) {
    closeMenu(false);
    const menu = h("div", "pdf-menu", { role: "menu" });
    const buttons = [];
    for (const it of items) {
      if (it === "-") { menu.appendChild(h("div", "pdf-menu-sep", { role: "separator" })); continue; }
      const radio = it.checked !== undefined;
      const b = h("button", "pdf-menu-item", { type: "button", role: radio ? "menuitemradio" : "menuitem", tabindex: "-1" });
      if (radio) b.setAttribute("aria-checked", String(!!it.checked));
      const lead = radio ? `<span class="pdf-menu-check">${it.checked ? icon("check", 14) : ""}</span>` : icon(it.icon, 15);
      b.innerHTML = lead + `<span class="pdf-menu-label">${esc(it.label)}</span>`;
      b.disabled = !!it.disabled;
      b.addEventListener("click", () => { closeMenu(true); it.onClick(); });
      menu.appendChild(b);
      buttons.push(b);
    }
    S.root.appendChild(menu);
    const pr = S.root.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const top = Math.round(ar.bottom - pr.top + 4);
    menu.style.top = top + "px";
    menu.style.right = Math.max(6, Math.round(pr.right - ar.right)) + "px";
    menu.style.maxHeight = Math.max(120, pr.height - top - 8) + "px";
    anchor.setAttribute("aria-expanded", "true");
    anchor.classList.add("is-open");
    S.menu = { el: menu, anchor, buttons };
    requestAnimationFrame(() => menu.classList.add("open"));
    const first = buttons.find((b) => b.getAttribute("aria-checked") === "true") || buttons.find((b) => !b.disabled);
    if (first) first.focus({ preventScroll: true });
    document.addEventListener("pointerdown", onMenuPointer, true);
    document.addEventListener("keydown", onMenuKey, true);
    window.addEventListener("blur", onMenuBlur);
  }

  function closeMenu(returnFocus) {
    const m = S.menu;
    if (!m) return;
    S.menu = null;
    m.anchor.setAttribute("aria-expanded", "false");
    m.anchor.classList.remove("is-open");
    document.removeEventListener("pointerdown", onMenuPointer, true);
    document.removeEventListener("keydown", onMenuKey, true);
    window.removeEventListener("blur", onMenuBlur);
    m.el.classList.remove("open");
    setTimeout(() => m.el.remove(), 160); // after the fade-out
    if (returnFocus) m.anchor.focus({ preventScroll: true });
  }

  function onMenuPointer(e) {
    const m = S.menu;
    if (m && !m.el.contains(e.target) && !m.anchor.contains(e.target)) closeMenu(false);
  }
  function onMenuBlur() { closeMenu(false); }
  function onMenuKey(e) {
    const m = S.menu;
    if (!m) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // Esc closes this menu only, not other overlays
      closeMenu(true);
      return;
    }
    if (e.key === "Tab") { closeMenu(false); return; }
    if (e.key === "Enter" && m.buttons.includes(document.activeElement)) {
      e.preventDefault(); // activate explicitly (and only once) rather than via the keypress default
      document.activeElement.click();
      return;
    }
    const list = m.buttons.filter((b) => !b.disabled);
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    let next = -1;
    if (e.key === "ArrowDown") next = i < 0 ? 0 : (i + 1) % list.length;
    else if (e.key === "ArrowUp") next = i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    if (next >= 0) { e.preventDefault(); list[next].focus(); }
  }

  // ---------------------------------------------------------------------------------------------
  // messages (empty / loading / load error), failure banner, compiling state
  function setMessage(kind, detail) {
    if (!kind) {
      if (S.message === null) return;
      const pos = S.savedPos;
      S.message = null;
      S.savedPos = null;
      S.empty.hidden = true;
      S.scroll.hidden = false;
      // display:none dropped the scroll offset; put the reader back where they were.
      if (pos && S.views.length) restorePosition(pos);
      updateCurrentPage(true);
      updateToolbarState();
      schedule();
      return;
    }
    if (S.message === null && S.views.length) S.savedPos = capturePosition();
    S.message = kind;
    S.empty.innerHTML = `<div class="pdf-empty-msg">${esc(MESSAGES[kind] || kind)}</div>` +
      (detail ? `<div class="pdf-empty-detail">${esc(detail)}</div>` : "");
    S.empty.classList.toggle("is-error", kind === "error");
    S.empty.classList.toggle("is-nomain", kind === "nomain");
    if (kind === "nomain") S.empty.appendChild(noMainActions());
    S.empty.hidden = false;
    S.scroll.hidden = true;
    updateToolbarState();
  }

  function showEmpty(on) {
    if (!S.inited) init();
    // Non-destructive: a loaded document stays in memory and reappears with showEmpty(false).
    // showEmpty(false) only ends the empty state; a load error or "Loading…" stays up.
    if (on) setMessage("empty");
    else if (S.message === "empty") setMessage(null);
  }

  // The no-main empty state (docs/ARCHITECTURE.md). app.js handles both buttons through the bus.
  function noMainActions() {
    const row = h("div", "pdf-empty-actions");
    const create = h("button", "pdf-empty-btn is-primary", { type: "button" });
    create.textContent = "Create main.tex";
    create.addEventListener("click", () => T.bus.emit("main:create", { anchor: create }));
    const choose = h("button", "pdf-empty-btn", { type: "button", "aria-haspopup": "menu" });
    choose.textContent = "Choose main file…";
    choose.addEventListener("click", () => T.bus.emit("main:choose", { anchor: choose }));
    row.append(create, choose);
    return row;
  }

  // showNoMain(true) replaces whatever the preview shows; showNoMain(false) ends only that state.
  function showNoMain(on) {
    if (!S.inited) init();
    if (on) { if (S.message !== "nomain") setMessage("nomain"); }
    else if (S.message === "nomain") setMessage(S.doc ? null : "empty");
  }

  function showFailure(result) {
    if (!S.inited) init();
    const r = result || {};
    const n = Array.isArray(r.errors) ? r.errors.length : Number(r.errors) || 0;
    let text = r.timed_out ? "Compile timed out" : r.cancelled ? "Compile cancelled" : "Compile failed";
    if (n) text += ` — ${n} error${n === 1 ? "" : "s"}`;
    S.banner.innerHTML = icon("alert", 14) + `<span class="pdf-banner-text">${esc(text)}</span>` +
      '<span class="pdf-banner-sep" aria-hidden="true">·</span><button type="button" class="pdf-banner-link">View</button>';
    S.banner.querySelector(".pdf-banner-link").addEventListener("click", () => (n ? openProblems() : T.bus.emit("log:show", {})));
    keepPagesStill(() => { S.banner.hidden = false; });
  }

  function clearFailure() {
    if (!S.inited) init();
    keepPagesStill(() => { S.banner.hidden = true; });
    S.banner.textContent = "";
  }

  // The banner pushes the page area down (or lets it back up); shift the scroll offset by the
  // same amount so the text the reader is looking at doesn't jump.
  function keepPagesStill(change) {
    const before = S.scroll.getBoundingClientRect().top;
    change();
    const delta = S.scroll.getBoundingClientRect().top - before;
    if (delta && S.message === null && S.views.length) S.scroll.scrollTop += delta;
  }

  // There is no "open Problems" call: use app.js's T.app.showProblems() when present,
  // else press the status dot, which opens Problems. Deferred so this click is over
  // before the popover starts listening for outside clicks.
  function openProblems() {
    setTimeout(() => {
      if (T.app && typeof T.app.showProblems === "function") { T.app.showProblems(); return; }
      const dot = document.getElementById("btn-status");
      if (dot) dot.click();
      else T.bus.emit("log:show", {});
    }, 0);
  }

  function setCompiling(on) {
    if (!S.inited) init();
    S.compiling = !!on;
    const b = S.ui.compile;
    b.classList.toggle("is-compiling", S.compiling);
    b.setAttribute("aria-busy", String(S.compiling));
    S.ui.compileLabel.textContent = S.compiling ? "Compiling…" : "Compile";
    clearTimeout(S.compileGuard);
    if (S.compiling) {
      // Safety net so a lost result can't leave the spinner running forever.
      const secs = Number(T.state && T.state.settings && T.state.settings.compileTimeout) || 120;
      S.compileGuard = setTimeout(() => setCompiling(false), (secs + 30) * 1000);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // layout: every page view has a fixed CSS size, so the scroll height never depends on rendering
  function viewportSize() {
    let w = S.scroll.clientWidth;
    let ht = S.scroll.clientHeight;
    if (!w || !ht) { // hidden behind a message, or not laid out yet: estimate from the card
      const r = S.root.getBoundingClientRect();
      w = w || r.width - 10;
      ht = ht || r.height - S.toolbar.offsetHeight - (S.banner.hidden ? 0 : S.banner.offsetHeight);
    }
    return { w: w > 50 ? w : 600, h: ht > 50 ? ht : 800 };
  }

  function scaleFor(mode, views) {
    if (typeof mode === "number") return mode * CSS_UNITS;
    let mw = 0;
    let mh = 0;
    for (const v of views) { if (v.wPt > mw) mw = v.wPt; if (v.hPt > mh) mh = v.hPt; }
    if (!mw || !mh) return CSS_UNITS;
    const { w, h: vh } = viewportSize();
    let s = (w - 2 * PAD) / mw;                         // "fit": the widest page fills the width
    if (mode === "page") s = Math.min(s, (vh - 2 * PAD) / mh); // "page": a whole page fits
    return clamp(s, 0.05, 10);
  }

  function layoutViews(views, scale) {
    let y = PAD;
    for (const v of views) {
      // floor keeps fitted pages from overflowing the width by a rounding half pixel
      const w = Math.max(1, Math.floor(v.wPt * scale + 1e-6));
      const ht = Math.max(1, Math.floor(v.hPt * scale + 1e-6));
      if (w !== v.cssW || ht !== v.cssH) {
        v.cssW = w;
        v.cssH = ht;
        v.el.style.width = w + "px";
        v.el.style.height = ht + "px";
      }
      v.top = y;
      y += ht + GAP;
    }
  }

  const contentHeight = (views) => (views.length ? views[views.length - 1].top + views[views.length - 1].cssH + PAD : 0);

  // Index of the first page whose bottom edge is below y (the page under y, or the next one).
  function indexAt(views, y) {
    let lo = 0;
    let hi = views.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (views[mid].top + views[mid].cssH > y) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  // Reading position = page under the top edge + how far into it, as a fraction of its height.
  function capturePosition() {
    const views = S.views;
    if (!views.length) return null;
    if (S.message !== null) return S.savedPos;
    const sc = S.scroll;
    const top = sc.scrollTop;
    const i = indexAt(views, top);
    const wide = sc.scrollWidth > sc.clientWidth;
    return {
      page: i,
      frac: (top - views[i].top) / views[i].cssH,
      xfrac: wide ? (sc.scrollLeft + sc.clientWidth / 2) / sc.scrollWidth : 0.5,
    };
  }

  function positionTop(views, pos) {
    if (!pos || !views.length) return 0;
    const v = views[clamp(pos.page | 0, 0, views.length - 1)];
    return v.top + (Number(pos.frac) || 0) * v.cssH;
  }

  function restorePosition(pos) {
    const sc = S.scroll;
    if (!pos) { sc.scrollTop = 0; sc.scrollLeft = 0; return; } // no position yet: start at the top
    sc.scrollTop = Math.round(positionTop(S.views, pos));
    if (sc.scrollWidth > sc.clientWidth) sc.scrollLeft = Math.round((pos.xfrac || 0.5) * sc.scrollWidth - sc.clientWidth / 2);
  }

  // The same, anchored on a point (pinch zoom keeps the spot under the fingers still).
  function capturePoint(pt) {
    const sc = S.scroll;
    const r = sc.getBoundingClientRect();
    const ox = pt.x - r.left;
    const oy = pt.y - r.top;
    const y = sc.scrollTop + oy;
    const i = indexAt(S.views, y);
    const v = S.views[i];
    return { page: i, fx: (sc.scrollLeft + ox - v.el.offsetLeft) / v.cssW, fy: (y - v.top) / v.cssH, ox, oy };
  }
  function restorePoint(a) {
    const sc = S.scroll;
    const v = S.views[a.page];
    sc.scrollTop = Math.round(v.top + a.fy * v.cssH - a.oy);
    sc.scrollLeft = Math.round(v.el.offsetLeft + a.fx * v.cssW - a.ox);
  }

  // ---------------------------------------------------------------------------------------------
  // rendering
  function makeViews(proxies) {
    return proxies.map((proxy, i) => {
      const vp = proxy.getViewport({ scale: 1 });
      return {
        index: i, proxy, wPt: vp.width, hPt: vp.height,
        el: h("div", "pdf-page", { "data-page": String(i + 1) }),
        canvas: null, key: "", task: null, taskKey: "", promise: null, failedKey: "",
        cssW: 0, cssH: 0, top: 0,
      };
    });
  }

  const renderKey = (scale) => scale.toFixed(5) + "@" + (window.devicePixelRatio || 1);

  function cancelTask(v) {
    const t = v.task;
    if (!t) return;
    v.task = null;
    try { t.cancel(); } catch (_) { /* already finished */ }
  }

  // Renders one page into a fresh canvas and swaps it in only when complete, so the old
  // (possibly CSS-stretched) bitmap stays visible meanwhile. Resolves true when swapped in.
  function renderView(v, key, scale) {
    if (v.task) {
      if (v.taskKey === key) return v.promise;
      cancelTask(v);
    }
    const vp = v.proxy.getViewport({ scale });
    let ratio = window.devicePixelRatio || 1;
    const area = v.cssW * v.cssH;
    if (area * ratio * ratio > MAX_CANVAS_PIXELS) ratio = Math.sqrt(MAX_CANVAS_PIXELS / area);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(v.cssW * ratio));
    canvas.height = Math.max(1, Math.round(v.cssH * ratio));
    let task;
    try {
      task = v.proxy.render({
        canvasContext: canvas.getContext("2d", { alpha: false }),
        viewport: vp,
        transform: [canvas.width / vp.width, 0, 0, canvas.height / vp.height, 0, 0],
      });
    } catch (err) {
      console.warn(`[pdf] page ${v.index + 1} could not render`, err);
      v.failedKey = key;
      return Promise.resolve(false);
    }
    v.task = task;
    v.taskKey = key;
    S.running++;
    v.promise = task.promise.then(
      () => {
        S.running--;
        if (v.task !== task) { freeCanvas(canvas); return false; } // superseded meanwhile
        v.task = null;
        const old = v.canvas;
        if (old) old.replaceWith(canvas);
        else v.el.insertBefore(canvas, v.el.firstChild);
        freeCanvas(old);
        v.canvas = canvas;
        v.key = key;
        return true;
      },
      (err) => {
        S.running--;
        if (v.task === task) v.task = null;
        freeCanvas(canvas);
        if (!isCancel(err)) {
          v.failedKey = key; // don't retry in a loop; a new zoom or document retries
          console.warn(`[pdf] page ${v.index + 1} failed to render`, err);
        }
        return false;
      });
    return v.promise;
  }

  function schedule() {
    if (S.pumpQueued) return;
    S.pumpQueued = true;
    setTimeout(pump, 0);
  }

  // Starts renders for pages in the render-ahead area, nearest to the viewport centre first.
  function pump() {
    S.pumpQueued = false;
    if (S.hold || S.message !== null || !S.views.length) return;
    S.key = renderKey(S.scale); // also catches a pixel-ratio change that fired no media-query event
    const key = S.key;
    const centre = S.scroll.scrollTop + S.scroll.clientHeight / 2;
    const want = [];
    for (const i of S.visible) {
      const v = S.views[i];
      if (v && v.key !== key && v.failedKey !== key && !(v.task && v.taskKey === key)) want.push(v);
    }
    want.sort((a, b) => Math.abs(a.top + a.cssH / 2 - centre) - Math.abs(b.top + b.cssH / 2 - centre));
    for (const v of want) {
      if (S.running >= MAX_PARALLEL) break;
      renderView(v, key, S.scale).then((ok) => { if (ok) trimCanvases(); schedule(); });
    }
  }

  // Pause rendering during continuous gestures (pinch, splitter drag); pages stretch meanwhile.
  function holdRenders(ms) {
    S.hold = true;
    clearTimeout(S.holdTimer);
    S.holdTimer = setTimeout(() => { S.hold = false; schedule(); }, ms);
  }

  // Frees the bitmaps of far-away pages once the total gets large (each page is several MB).
  function trimCanvases() {
    let total = 0;
    const off = [];
    for (const v of S.views) {
      if (!v.canvas) continue;
      total += v.canvas.width * v.canvas.height;
      if (!S.visible.has(v.index)) off.push(v);
    }
    if (total <= CANVAS_BUDGET) return;
    off.sort((a, b) => Math.abs(b.index - S.current) - Math.abs(a.index - S.current));
    for (const v of off) {
      if (total <= CANVAS_BUDGET) break;
      total -= v.canvas.width * v.canvas.height;
      v.canvas.remove();
      freeCanvas(v.canvas);
      v.canvas = null;
      v.key = "";
      if (!v.task) v.proxy.cleanup();
    }
  }

  function observe(views) {
    if (S.io) S.io.disconnect();
    S.visible = new Set();
    if (!window.IntersectionObserver) { views.forEach((v) => S.visible.add(v.index)); schedule(); return; }
    S.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const v = S.views[Number(e.target.dataset.page) - 1];
        if (!v || v.el !== e.target) continue; // a page of a document already swapped out
        if (e.isIntersecting) S.visible.add(v.index);
        else S.visible.delete(v.index);
      }
      schedule();
    }, { root: S.scroll, rootMargin: RENDER_AHEAD });
    for (const v of views) S.io.observe(v.el);
  }

  // ---------------------------------------------------------------------------------------------
  // loading: fetch -> parse -> lay out off-screen -> pre-render what will be visible -> swap
  function getWorker() {
    // One worker shared by every load: destroying a document then leaves the worker running.
    if (!S.worker || S.worker.destroyed) S.worker = new pdfjsLib.PDFWorker({ name: "texc-pdf", verbosity: 0 });
    return S.worker;
  }

  // Resolves true once the PDF is on screen (or already was), false if a newer load() superseded
  // it. Rejects with the error (`.status` set for HTTP errors) when it fails; the preview then
  // keeps the last good PDF, or shows the empty state (404) or a readable error.
  function load(url, opts) {
    if (!S.inited) init();
    if (!url) return Promise.resolve(false);
    if (!window.pdfjsLib) {
      setMessage("error", "The PDF viewer library failed to load.");
      return Promise.reject(new Error("The PDF viewer library (pdf.min.js) failed to load."));
    }
    const force = !!(opts && opts.force);
    // The compile result and its SSE echo carry the same URL: share or skip the work.
    if (!force && S.pending && S.pending.url === url) return S.pending.promise;
    if (!force && url === S.url && S.doc) {
      setMessage(null);
      return Promise.resolve(true);
    }
    abortPending();
    const p = (S.pending = { url, ctrl: new AbortController(), task: null, views: null, promise: null });
    p.promise = loadInto(p);
    return p.promise;
  }

  async function loadInto(p) {
    const stale = () => S.pending !== p;
    const slow = S.doc ? 0 : setTimeout(() => { if (!stale() && !S.doc) setMessage("loading"); }, 400);
    try {
      let doc;
      for (let attempt = 0; ; attempt++) {
        try {
          doc = await openDocument(p);
          break;
        } catch (err) {
          // A PDF caught mid-write parses as garbage; one quiet retry covers that race.
          if (stale() || attempt > 0 || !retryable(err)) throw err;
          await sleep(600);
          if (stale()) return false;
        }
      }
      if (stale()) return false;
      const proxies = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
      if (stale()) return false;
      p.views = makeViews(proxies);
      await prerender(p);
      if (stale()) return false;
      swapIn(p, doc);
      return true;
    } catch (err) {
      if (stale()) return false;
      S.pending = null;
      disposePending(p);
      if (isCancel(err)) return false;
      throw loadFailed(err); // the caller reports it (app.js shows a toast); the preview shows the state
    } finally {
      clearTimeout(slow);
    }
  }

  async function openDocument(p) {
    const res = await fetch(T.api.url(p.url), { signal: p.ctrl.signal, cache: "no-store" });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch (_) { /* not JSON */ }
      throw Object.assign(new Error(msg), { status: res.status });
    }
    const data = new Uint8Array(await res.arrayBuffer());
    if (S.pending !== p) throw Object.assign(new Error("superseded"), { name: "AbortError" });
    if (p.task) p.task.destroy().catch(() => {});
    // Our own fetch gives one consistent snapshot of the file (no range requests racing a rebuild).
    p.task = pdfjsLib.getDocument({ data, worker: getWorker(), verbosity: 0 });
    return p.task.promise;
  }

  function retryable(err) {
    if (!err || err.status) return !!err && err.status >= 500;
    return err.name === "InvalidPDFException" || err.name === "UnknownErrorException" ||
      err.name === "FormatError" || err instanceof TypeError; // TypeError = network failure
  }

  function abortPending() {
    const p = S.pending;
    if (!p) return;
    S.pending = null;
    disposePending(p);
  }

  function disposePending(p) {
    try { p.ctrl.abort(); } catch (_) { /* ignore */ }
    if (p.views) for (const v of p.views) { cancelTask(v); freeCanvas(v.canvas); v.canvas = null; }
    if (p.task) p.task.destroy().catch(() => {}); // also destroys its document
    p.task = null;
  }

  // Where the reader is (or, before the first document, where they were last session; null = top).
  function currentAnchor() {
    return S.views.length ? capturePosition() : S.initialPos;
  }

  // Lays the new pages out at the current zoom and renders the ones that will be on screen at
  // the restored position, while the old document stays visible. A second pass catches a
  // scroll or resize that happened during the first.
  async function prerender(p) {
    const views = p.views;
    for (let pass = 0; pass < 2; pass++) {
      const scale = scaleFor(S.zoom, views);
      layoutViews(views, scale);
      const vh = viewportSize().h;
      const top = clamp(positionTop(views, currentAnchor()), 0, Math.max(0, contentHeight(views) - vh));
      const key = renderKey(scale);
      const need = views.filter((v) => v.top < top + vh && v.top + v.cssH > top && v.key !== key);
      if (!need.length) return;
      await Promise.all(need.map((v) => renderView(v, key, scale)));
      if (S.pending !== p) return;
    }
  }

  function swapIn(p, doc) {
    const views = p.views;
    const pos = currentAnchor(); // where the reader is now, in the old layout
    const oldDoc = S.doc;
    const oldViews = S.views;
    S.pending = null;
    for (const v of oldViews) cancelTask(v);
    if (S.io) S.io.disconnect();

    S.doc = doc;
    S.views = views;
    S.url = p.url;
    if (S.message !== null) { // a fresh PDF ends any empty/loading/error state
      S.message = null;
      S.savedPos = null;
      S.empty.hidden = true;
      S.scroll.hidden = false;
    }
    S.scale = scaleFor(S.zoom, views);
    S.key = renderKey(S.scale);
    layoutViews(views, S.scale);
    const frag = document.createDocumentFragment();
    for (const v of views) frag.appendChild(v.el);
    // One synchronous step (replace + scroll) so the browser never paints a blank stack.
    S.pagesEl.replaceChildren(frag);
    restorePosition(pos);
    S.initialPos = null;
    S.lock = S.lock && Math.abs(S.lock.top - S.scroll.scrollTop) < 2 ? S.lock : null;
    updateCurrentPage(true);
    observe(views);

    for (const v of oldViews) { freeCanvas(v.canvas); v.canvas = null; }
    if (oldDoc) oldDoc.destroy().catch(() => {});
    updateToolbarState();
    T.bus.emit("pdf:loaded", { url: p.url, pages: views.length });
    if (S.flashQueue) { const r = S.flashQueue; S.flashQueue = null; flash(r); }
  }

  function describe(err) {
    if (err.status === 401) return "The session token was rejected; reload the page.";
    if (err.status === 404) return "There is no PDF yet.";
    if (err.name === "PasswordException") return "The PDF is password-protected.";
    if (err.name === "InvalidPDFException") return "The file isn't a valid PDF.";
    if (err instanceof TypeError) return "The texc server isn't reachable.";
    return err.message || String(err);
  }

  // Shows the failure and returns the error load() rejects with (readable message, same status).
  function loadFailed(err) {
    const out = Object.assign(new Error(describe(err)), { status: err.status, cause: err });
    if (S.flashQueue) { const r = S.flashQueue; S.flashQueue = null; if (S.doc) flash(r); }
    if (S.doc) return out; // keep showing the last good PDF
    if (err.status === 404) setMessage("empty");
    else setMessage("error", out.message);
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // zoom, resize, pinch, devicePixelRatio
  function readZoom() {
    try { return normZoom(JSON.parse(lsGet(LS_ZOOM) || '"fit"')); } catch (_) { return "fit"; }
  }

  function normZoom(mode) {
    if (mode === "fit" || mode === "page") return mode;
    const n = Number(mode);
    return isFinite(n) && n > 0 ? clamp(n, ZOOM_MIN, ZOOM_MAX) : "fit";
  }

  function setZoom(mode, point) {
    if (!S.inited) init();
    S.zoom = normZoom(mode);
    lsSet(LS_ZOOM, JSON.stringify(S.zoom));
    updateZoomLabel();
    relayout(point);
    T.bus.emit("pdf:zoom", { mode: S.zoom, scale: S.scale / CSS_UNITS });
  }

  // Applies the zoom mode's scale: resizes every page (old bitmaps stretch until re-rendered),
  // keeps the reading position, then re-renders what's visible.
  function relayout(point) {
    if (!S.views.length) return;
    const scale = scaleFor(S.zoom, S.views);
    if (Math.abs(scale - S.scale) < 1e-5) return;
    const hidden = S.message !== null;
    const anchor = point && !hidden ? capturePoint(point) : capturePosition();
    S.scale = scale;
    S.key = renderKey(scale);
    for (const v of S.views) if (v.task && v.taskKey !== S.key) cancelTask(v);
    layoutViews(S.views, scale);
    if (hidden) return; // savedPos is page-relative, so it survives the new layout
    if (point) restorePoint(anchor);
    else restorePosition(anchor);
    if (S.lock) S.lock = { page: S.lock.page, top: S.scroll.scrollTop };
    updateCurrentPage();
    schedule();
  }

  function onResize() {
    if (!S.views.length || typeof S.zoom === "number" || !S.scroll.clientWidth) return;
    holdRenders(150); // debounce the crisp re-render; the pages re-fit right away
    relayout();
  }

  function zoomTo(z, point) {
    holdRenders(180);
    setZoom(clamp(z, ZOOM_MIN, ZOOM_MAX), point);
  }

  // Trackpad pinch (and Ctrl+wheel) in Chrome arrives as wheel events with ctrlKey set.
  function onWheel(e) {
    if (S.menu) closeMenu(false); // a user scroll dismisses open menus (programmatic ones don't)
    if (!e.ctrlKey || !S.views.length || S.message !== null) return;
    e.preventDefault();
    const dy = clamp(e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1), -25, 25);
    zoomTo((S.scale / CSS_UNITS) * Math.exp(-dy / 100), { x: e.clientX, y: e.clientY });
  }
  function onGestureStart(e) {
    e.preventDefault();
    S.gestureZoom = S.scale / CSS_UNITS;
  }
  function onGestureChange(e) {
    e.preventDefault();
    if (S.views.length && S.message === null) zoomTo(S.gestureZoom * e.scale, { x: e.clientX, y: e.clientY });
  }

  // Moving the window to a display with another pixel ratio re-renders at the new density.
  function watchDpr() {
    if (!window.matchMedia) return;
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const onChange = () => {
      mq.removeEventListener("change", onChange);
      S.key = renderKey(S.scale);
      schedule();
      watchDpr();
    };
    mq.addEventListener("change", onChange);
  }

  // ---------------------------------------------------------------------------------------------
  // navigation: current page, page box, gotoPage, remembered position
  function onScroll() {
    if (S.scrollRaf) return;
    S.scrollRaf = requestAnimationFrame(() => {
      S.scrollRaf = 0;
      updateCurrentPage();
      savePosSoon();
      schedule(); // cheap; lets any scroll pick up a stale render key (e.g. a pixel-ratio change)
    });
  }

  // The current page is the one taking up most of the viewport (ties go to the upper page).
  function updateCurrentPage(force) {
    const views = S.views;
    if (!views.length || S.message !== null) { if (force) updatePageBox(); return; }
    const sc = S.scroll;
    const top = sc.scrollTop;
    const bottom = top + sc.clientHeight;
    let best = S.current;
    if (S.lock && Math.abs(S.lock.top - top) < 2) {
      best = S.lock.page; // gotoPage() target, even when the end of the document stops the scroll
    } else {
      S.lock = null;
      let bestVis = -1;
      for (let i = indexAt(views, top); i < views.length && views[i].top < bottom; i++) {
        const v = views[i];
        const vis = Math.min(bottom, v.top + v.cssH) - Math.max(top, v.top);
        if (vis > bestVis + 1) { bestVis = vis; best = i; }
      }
    }
    best = clamp(best, 0, views.length - 1);
    if (best !== S.current || force) {
      const changed = best !== S.current;
      S.current = best;
      updatePageBox();
      if (changed) T.bus.emit("pdf:page", { page: best + 1, pages: views.length });
    }
  }

  function gotoPage(n) {
    if (!S.inited) init();
    const views = S.views;
    if (!views.length) return;
    const i = clamp(Math.round(Number(n) || 1) - 1, 0, views.length - 1);
    if (S.message !== null) { // pages hidden: remember the target for when they come back
      S.savedPos = { page: i, frac: -PAD / views[i].cssH, xfrac: 0.5 };
      S.current = i;
      updatePageBox(true);
      return;
    }
    const sc = S.scroll;
    sc.scrollTop = views[i].top - PAD;
    S.lock = { page: i, top: sc.scrollTop };
    updateCurrentPage(true);
  }

  const savePosSoon = T.util.debounce(() => {
    const pos = S.message === null ? capturePosition() : null;
    if (pos) lsSet(S.posKey, JSON.stringify({ page: pos.page, frac: Math.round(pos.frac * 1e4) / 1e4, xfrac: 0.5 }));
  }, 400);

  // ---------------------------------------------------------------------------------------------
  // SyncTeX: double-click -> source, flash(rect) <- source
  function pageOf(target) {
    const el = target && target.closest ? target.closest(".pdf-page") : null;
    const v = el ? S.views[Number(el.dataset.page) - 1] : null;
    return v && v.el === el ? v : null;
  }

  // Page-local CSS px -> PDF points from the page's top-left corner, as `synctex edit` expects.
  // For an unrotated page this is exactly (clientX - pageRect.left) / scale (docs/ARCHITECTURE.md).
  function toSynctex(v, x, y, rect) {
    const vp = v.proxy.getViewport({ scale: rect.width / v.wPt });
    const [px, py] = vp.convertToPdfPoint(x, y);
    const view = v.proxy.view; // [x1, y1, x2, y2] in PDF user space (y up)
    return { x: px - view[0], y: view[3] - py };
  }

  // SyncTeX box (h = left, v = baseline, W = width, H = height, all in pt from the top-left)
  // -> CSS px within the page element.
  function fromSynctex(v, r) {
    const vp = v.proxy.getViewport({ scale: v.cssW / v.wPt });
    const view = v.proxy.view;
    const pageW = view[2] - view[0];
    let left = Number(r.h) || 0;
    let width = Number(r.W) || 0;
    const height = Number(r.H) > 1 ? Number(r.H) : 10;
    const base = Number(r.v) || height;
    if (!(width > 1)) { left = pageW * 0.08; width = pageW * 0.84; } // no width: mark the text line
    const pdfRect = [
      view[0] + left - 2, view[3] - (base + 2),            // bottom-left, 2 pt of breathing room
      view[0] + left + width + 2, view[3] - (base - height - 2), // top-right
    ];
    const [a, b, c, d] = vp.convertToViewportRectangle(pdfRect);
    return { left: Math.min(a, c), top: Math.min(b, d), width: Math.abs(c - a), height: Math.abs(d - b) };
  }

  async function onDblClick(e) {
    const v = pageOf(e.target);
    if (!v) return;
    e.preventDefault();
    const rect = v.el.getBoundingClientRect();
    const pt = toSynctex(v, e.clientX - rect.left, e.clientY - rect.top, rect);
    const params = { page: v.index + 1, x: pt.x.toFixed(2), y: pt.y.toFixed(2) };
    try {
      const res = await T.api.get("/api/synctex/edit", params);
      if (!res || !res.path) { toast("No source line matches that spot"); return; }
      const out = { path: res.path, line: Math.max(1, Number(res.line) || 1) };
      if (Number(res.column) >= 0) out.column = Number(res.column);
      T.bus.emit("pdf:goto-source", out);
    } catch (err) {
      if (err.status === 404) toast("No source line matches that spot");
      else toast("SyncTeX failed: " + err.message, "error");
    }
  }

  function flash(rect) {
    if (!S.inited) init();
    if (!rect || !(Number(rect.page) >= 1)) return;
    if (S.pending) { S.flashQueue = rect; return; } // SyncTeX describes the PDF being swapped in
    const v = S.views[Math.round(rect.page) - 1];
    if (!v) return;
    if (S.message !== null) setMessage(null);
    const box = fromSynctex(v, rect);
    const mark = h("div", "pdf-flash");
    // Percentages keep the mark on its words if the zoom changes while it fades.
    mark.style.left = (box.left / v.cssW) * 100 + "%";
    mark.style.top = (box.top / v.cssH) * 100 + "%";
    mark.style.width = (box.width / v.cssW) * 100 + "%";
    mark.style.height = (box.height / v.cssH) * 100 + "%";
    v.el.appendChild(mark);
    const drop = () => mark.remove();
    mark.addEventListener("animationend", drop);
    setTimeout(drop, 2500); // in case animations are disabled

    const sc = S.scroll;
    const top = v.top + box.top;
    const left = v.el.offsetLeft + box.left;
    const vw = sc.clientWidth;
    const vh = sc.clientHeight;
    const inView = top >= sc.scrollTop + 8 && top + box.height <= sc.scrollTop + vh - 8 &&
      left >= sc.scrollLeft && left + box.width <= sc.scrollLeft + vw;
    if (!inView) {
      const y = Math.max(0, top + box.height / 2 - vh * 0.4);
      const x = sc.scrollWidth > vw ? Math.max(0, left + box.width / 2 - vw / 2) : 0;
      const far = Math.abs(y - sc.scrollTop) > vh * 2;
      sc.scrollTo({ top: y, left: x, behavior: far ? "auto" : "smooth" });
    }
  }

  // ---------------------------------------------------------------------------------------------
  T.pdf = {
    init,
    load,
    setZoom: (mode) => setZoom(mode),
    gotoPage,
    showFailure,
    clearFailure,
    showEmpty,
    showNoMain,
    flash,
    setCompiling,
    // read-only helpers (handy for app.js and tests)
    getZoom: () => S.zoom,
    getScale: () => S.scale / CSS_UNITS,
    currentPage: () => (S.views.length ? S.current + 1 : 0),
    pageCount: () => S.views.length,
  };
})();
