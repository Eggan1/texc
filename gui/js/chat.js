/* texc chat (T.chat). One thread model, shown either full-pane in #chat-view or in the docked
   sheet inside #dock-chat. It streams replies from /api/ai, renders Markdown + KaTeX, turns
   SEARCH/REPLACE edit blocks into change cards and hands the edits to T.editor.reviewEdits. See docs/ARCHITECTURE.md. */
(function () {
  "use strict";
  const T = (window.T = window.T || {});

  // ---------------------------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------------------------
  // Edit blocks in the assistant text (docs/ARCHITECTURE.md, verbatim).
  const EDIT_RE = /<<<<<<< SEARCH[ \t]*([^\n]*)\n([\s\S]*?)\n?=======[ \t]*\n([\s\S]*?)\n?>>>>>>> REPLACE/g;
  const EDIT_START = "<<<<<<< SEARCH";
  const MAX_UPLOAD = 25 * 1024 * 1024;
  const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
  const FIGURE_RE = /\.(png|jpe?g|gif|svg|webp|bmp|tiff?|eps)$/i;
  const DOCK_KEY = "texc:chat:dock";
  const DOCK_MIN = 140; // px
  const DOCK_MAX = 0.85; // of the editor column
  const DOCK_DEFAULT = 0.42;
  const SUMMARIZE = "Summarize this paper: its question, method, main results and open issues.";
  const PICK_PROVIDER = "Choose an AI provider in Tools → Settings.";
  // Private-use characters mark placeholders. marked and DOMPurify pass them through untouched.
  const MATH_OPEN = "";
  const MATH_CLOSE = "";
  const DOLLAR = ""; // a literal "$" that must never pair up into math
  const GROUP_OPEN = "";
  const GROUP_CLOSE = "";
  const MATH_TOKEN = /(\d+)/g;
  const GROUP_TOKEN = /(\d+)/g;
  const KATEX_OPTS = {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "\\[", right: "\\]", display: true },
      { left: "\\(", right: "\\)", display: false },
      { left: "$", right: "$", display: false },
    ],
    throwOnError: false,
    strict: "ignore",
    ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
    ignoredClasses: ["chat-changes"],
  };

  // ---------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------
  const S = {
    inited: false,
    mode: "full",
    chats: new Map(), // id -> chat
    current: null,
    nodes: new Map(), // message id -> DOM node of the current thread
    dirty: new Set(), // messages waiting for the next frame's re-render
    frame: 0,
    frameTimer: 0,
    editIndex: new Map(), // edit id -> {chat, msg, i}
    earlyResolved: new Map(), // edit id -> "kept"|"undone" that arrived before reviewEdits answered
    selection: null, // latest editor:selection (1-based lines, 0-based ch)
    usedSelKey: "", // selection already attached or dismissed, so it isn't auto-attached again
    queue: [], // ask() calls waiting for a busy chat: {chat, text, context, images}
    dock: { ratio: DOCK_DEFAULT, collapsed: false },
    dockAnim: 0,
    dockPx: -1,
    stick: true, // the thread follows new output while the user is at the bottom
    rec: null, // active speech recognition
    pop: null, // open CHAT popover
    files: null, // project file list fetched by the Add File picker
    uploaded: new Set(), // paths uploaded in this session (for unique names)
    settings: null, // fallback copy of /api/settings when T.state.settings is missing
    md: null, // marked instance
  };
  const E = {}; // DOM references

  // ---------------------------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------------------------
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (name, size) => (typeof T.icon === "function" ? T.icon(name, size) : "");
  const fmtPath = (p) => String(p == null ? "" : p).trim().replace(/^(\.\/)+/, "");
  const basename = (p) => fmtPath(p).split("/").pop();
  const now = () => Date.now() / 1000;
  const rid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const num = (v) => (Number.isFinite(+v) ? +v : 0);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const emit = (evt, data) => { if (T.bus) T.bus.emit(evt, data); };
  const rawUrl = (path) => (T.api && T.api.url ? T.api.url("/api/raw", { path }) : "");
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const isVisible = (el) => !!(el && el.isConnected && el.getClientRects().length);

  // Tiny DOM builder: h("div", {class, text, html, onclick, ...attrs}, ...children)
  function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else if (k === "html") n.innerHTML = v;
        else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const c of kids.flat(Infinity)) {
      if (c == null || c === false) continue;
      n.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
  }

  function toast(text, kind) {
    if (T.app && typeof T.app.toast === "function") T.app.toast(text, kind || "info");
    else (kind === "error" ? console.warn : console.log)("[chat]", text);
  }

  function confirmBox(text, opts) {
    if (T.app && typeof T.app.confirm === "function") return Promise.resolve(T.app.confirm(text, opts));
    return Promise.resolve(window.confirm(text));
  }

  function openFile(path, line) {
    path = fmtPath(path);
    if (!path) return;
    const ln = line > 0 ? line : undefined;
    try {
      if (T.app && typeof T.app.openFile === "function") return T.app.openFile(path, ln);
      if (T.editor && typeof T.editor.open === "function") return T.editor.open(path, ln ? { line: ln, ch: 0 } : undefined);
    } catch (err) {
      toast(`Couldn't open ${path}: ${err.message || err}`, "error");
    }
  }

  // Per-folder UI state through T.store (api.js; docs/ARCHITECTURE.md); localStorage if it's missing.
  function storageGet(key) {
    try { return JSON.parse((T.store ? T.store.get(key) : window.localStorage.getItem(key)) || "null"); } catch (_) { return null; }
  }
  function storageSet(key, value) {
    try {
      const v = JSON.stringify(value);
      if (T.store) T.store.set(key, v); else window.localStorage.setItem(key, v);
    } catch (_) { /* private mode etc. */ }
  }

  function errText(err) {
    if (!err) return "The AI request failed.";
    if (err.status === 401) return "The texc server rejected the request. Reload the page.";
    if (err.name === "TypeError") return "Couldn't reach the texc server. Is it still running?";
    return err.message || String(err);
  }

  function timeAgo(t) {
    let ms = typeof t === "number" ? t : Date.parse(t) || 0;
    if (ms && ms < 1e12) ms *= 1000;
    if (!ms) return "";
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  const toMs = (t) => { let ms = typeof t === "number" ? t : Date.parse(t) || 0; if (ms && ms < 1e12) ms *= 1000; return ms; };

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (_) { /* fall back below */ }
    const ta = h("textarea", { style: "position:fixed;left:-9999px;top:0;opacity:0", "aria-hidden": "true" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => { const s = String(r.result || ""); const i = s.indexOf(","); resolve(i >= 0 ? s.slice(i + 1) : s); };
      r.onerror = () => reject(r.error || new Error("Couldn't read the file."));
      r.readAsDataURL(file);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Context items: {path, from:{line,ch}, to:{line,ch}, text} (lines 1-based, ch 0-based) or {path}
  // ---------------------------------------------------------------------------------------------
  function ctxLabel(c) {
    const p = fmtPath(c.path);
    if (c.from && c.to) return `@${p}:${c.from.line}:${num(c.from.ch) + 1}-${c.to.line}:${num(c.to.ch) + 1}`;
    return `@${p}`;
  }
  function normContext(list) {
    const out = [];
    for (const c of Array.isArray(list) ? list : list ? [list] : []) {
      if (!c || !fmtPath(c.path)) continue;
      const item = { path: fmtPath(c.path) };
      if (c.from && c.to) {
        item.from = { line: Math.max(1, num(c.from.line)), ch: Math.max(0, num(c.from.ch)) };
        item.to = { line: Math.max(1, num(c.to.line)), ch: Math.max(0, num(c.to.ch)) };
        item.text = typeof c.text === "string" ? c.text : "";
      }
      if (!out.some((x) => ctxLabel(x) === ctxLabel(item))) out.push(item);
    }
    return out;
  }
  const selKey = (s) => `${fmtPath(s.path)}:${s.from.line}:${s.from.ch}-${s.to.line}:${s.to.ch}:${(s.text || "").length}`;
  const validSel = (s) => !!(s && s.path && s.from && s.to && typeof s.text === "string" && s.text.length);

  // The latest editor selection, unless it was already attached or dismissed.
  function pendingSelection() {
    const s = S.selection;
    if (!validSel(s) || selKey(s) === S.usedSelKey) return null;
    return normContext([s])[0] || null;
  }
  function refreshSelection() {
    if (T.editor && typeof T.editor.getSelection === "function") {
      try { S.selection = T.editor.getSelection() || null; } catch (_) { /* keep the last event's value */ }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Chat model and persistence
  // ---------------------------------------------------------------------------------------------
  function makeChat(id) {
    return {
      id,
      title: "New chat",
      titled: false,
      created: now(),
      updated: 0,
      messages: [],
      run: null, // the reply being streamed: see startRun()
      loading: false,
      loadError: "",
      draft: { text: "", context: [], images: [] },
      saveChain: Promise.resolve(),
      saveQueued: false,
      saveFailed: false,
      saveTimer: 0,
    };
  }

  // Fill a chat from a stored dict (GET /api/chats/<id>).
  function hydrate(chat, data) {
    if (data.title && data.title !== "New chat") { chat.title = String(data.title); chat.titled = true; }
    if (data.created) chat.created = data.created;
    if (data.updated) chat.updated = data.updated;
    const loaded = [];
    for (const m of data.messages) {
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
      const msg = { id: m.id || rid("m"), role: m.role, content: typeof m.content === "string" ? m.content : String(m.text || ""), ts: m.ts || 0 };
      if (m.role === "user") {
        msg.context = normContext(m.context);
        msg.images = Array.isArray(m.images) ? m.images.filter((p) => typeof p === "string") : [];
      } else {
        msg.active_path = m.active_path || "";
        msg.edits = Array.isArray(m.edits) ? m.edits.filter(Boolean) : [];
        msg.notices = Array.isArray(m.notices) ? m.notices.map(String) : [];
        msg.error = m.error ? String(m.error) : "";
        msg.stopped = !!m.stopped;
        if (m.usage) msg.usage = m.usage;
        msg.phase = msg.error ? "error" : msg.stopped ? "stopped" : "done";
        indexEdits(chat, msg);
      }
      loaded.push(msg);
    }
    // Anything sent while the chat was loading goes after the stored history.
    chat.messages = loaded.concat(chat.messages);
  }

  function serialize(chat) {
    return {
      id: chat.id,
      title: chat.title,
      created: chat.created,
      updated: chat.updated,
      messages: chat.messages.map((m) => {
        const o = { id: m.id, role: m.role, content: m.content, ts: m.ts };
        if (m.role === "user") {
          o.context = m.context;
          o.images = m.images;
        } else {
          o.active_path = m.active_path || "";
          o.edits = m.edits || [];
          o.notices = m.notices || [];
          if (m.error) o.error = m.error;
          // A reply still streaming can't be resumed after a reload, so it is stored as stopped.
          if (m.stopped || m.phase === "streaming") o.stopped = true;
          if (m.usage) o.usage = m.usage;
        }
        return o;
      }),
    };
  }

  // PUT /api/chats/<id>, serialised per chat; the body is built when the request actually starts.
  function save(chat) {
    if (!chat || !chat.messages.length || chat.loading || chat.loadError || !T.api) return Promise.resolve();
    chat.updated = now();
    if (chat.saveQueued) return chat.saveChain;
    chat.saveQueued = true;
    chat.saveChain = chat.saveChain
      .then(() => {
        chat.saveQueued = false;
        return T.api.put(`/api/chats/${encodeURIComponent(chat.id)}`, serialize(chat));
      })
      .then(
        () => { chat.saveFailed = false; },
        (err) => {
          chat.saveQueued = false;
          if (!chat.saveFailed) toast(`Couldn't save the chat: ${err.message || err}`, "error");
          chat.saveFailed = true;
        }
      );
    return chat.saveChain;
  }
  function saveSoon(chat) {
    clearTimeout(chat.saveTimer);
    chat.saveTimer = setTimeout(() => save(chat), 400);
  }

  const editId = (chat, msg, i) => `${chat.id}-${msg.id}-e${i}`;
  function indexEdits(chat, msg) {
    (msg.edits || []).forEach((e, i) => { if (e && e.id) S.editIndex.set(e.id, { chat, msg, i }); });
  }

  function setTitleFrom(chat) {
    if (chat.titled) return;
    const first = chat.messages.find((m) => m.role === "user" && m.content.trim());
    if (!first) return;
    let t = first.content.replace(/\s+/g, " ").trim().split(" ").slice(0, 5).join(" ");
    t = t.replace(/[\s.,;:!?…\-–—]+$/, "");
    if (t.length > 60) t = t.slice(0, 59).trimEnd() + "…";
    chat.title = t || "New chat";
    chat.titled = !!t;
    emit("chat:title", { id: chat.id, title: chat.title });
  }

  function ensureCurrent() {
    if (!S.current) {
      const chat = makeChat(rid("c"));
      S.chats.set(chat.id, chat);
      setCurrent(chat);
    }
    return S.current;
  }

  function setCurrent(chat) {
    const prev = S.current;
    if (prev === chat) { renderThread(); updateComposer(); return; }
    if (prev && E.input) prev.draft.text = E.input.value;
    stopDictation();
    S.current = chat;
    if (E.input) { E.input.value = chat.draft.text || ""; autoGrow(); }
    S.stick = true;
    renderThread();
    renderAttachments();
    emit("chat:current", { id: chat.id, title: chat.title });
  }

  async function loadChat(chat) {
    chat.loading = true;
    chat.loadError = "";
    if (S.current === chat) { renderThread(); updateComposer(); }
    try {
      const data = await T.api.get(`/api/chats/${encodeURIComponent(chat.id)}`);
      if (data && Array.isArray(data.messages)) {
        hydrate(chat, data);
        if (chat.titled) emit("chat:title", { id: chat.id, title: chat.title });
      }
      // {} or 404: a chat that was never saved (e.g. an empty "New chat" tab); it starts empty.
    } catch (err) {
      if (!err || err.status !== 404) chat.loadError = errText(err);
    }
    chat.loading = false;
    if (S.current === chat) { renderThread(); updateComposer(); }
    drainQueue(chat);
  }

  // ---------------------------------------------------------------------------------------------
  // Public: chats
  // ---------------------------------------------------------------------------------------------
  function newChat() {
    if (!S.inited) init();
    const chat = makeChat(rid("c"));
    S.chats.set(chat.id, chat);
    setCurrent(chat);
    focusComposer();
    return chat.id;
  }

  function openChat(id) {
    if (!S.inited) init();
    if (!id) return Promise.resolve(newChat());
    let chat = S.chats.get(id);
    if (chat && !chat.loadError) {
      setCurrent(chat);
      return Promise.resolve(id);
    }
    if (!chat) { chat = makeChat(String(id)); S.chats.set(chat.id, chat); }
    setCurrent(chat);
    return loadChat(chat).then(() => id);
  }

  // [{id, title, updated}] newest first: the server list plus chats only this page knows about yet.
  async function list() {
    const rows = await T.api.get("/api/chats");
    const out = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id).map((r) => {
      const mem = S.chats.get(r.id);
      return { id: r.id, title: (mem && mem.titled && mem.title) || r.title || "Untitled chat", updated: r.updated };
    });
    const seen = new Set(out.map((r) => r.id));
    for (const c of S.chats.values()) if (!seen.has(c.id) && c.messages.length) out.push({ id: c.id, title: c.title, updated: c.updated || c.created });
    return out.sort((a, b) => toMs(b.updated) - toMs(a.updated));
  }

  async function deleteChat(chat) {
    const ok = await confirmBox(`Delete “${chat.title}”? This can't be undone.`, { ok: "Delete", cancel: "Cancel" });
    if (!ok) return;
    if (chat.run) stop(chat);
    clearTimeout(chat.saveTimer);
    try {
      await chat.saveChain;
      await T.api.del(`/api/chats/${encodeURIComponent(chat.id)}`);
    } catch (err) {
      if (!err || err.status !== 404) { toast(`Couldn't delete the chat: ${err.message || err}`, "error"); return; }
    }
    S.chats.delete(chat.id);
    S.queue = S.queue.filter((q) => q.chat !== chat);
    emit("chat:deleted", { id: chat.id });
    if (S.current === chat) { S.current = null; newChat(); }
  }

  function openAsTab() {
    const chat = ensureCurrent();
    emit("chat:open-as-tab", { id: chat.id, title: chat.title });
  }

  // ---------------------------------------------------------------------------------------------
  // DOM: the shared panel (thread + suggestion chips + composer)
  // ---------------------------------------------------------------------------------------------
  function iconBtn(name, title, onClick, extra) {
    return h("button", { class: "chat-ibtn" + (extra ? " " + extra : ""), type: "button", title, "aria-label": title, html: icon(name, 16), onclick: onClick });
  }
  function chip(name, label, onClick) {
    return h("button", { class: "chat-chip", type: "button", onclick: onClick },
      h("span", { class: "chat-chip-ic", html: icon(name, 14) }), h("span", { text: label }));
  }

  function buildPanel() {
    E.panel = h("div", { class: "chat-panel" });
    E.col = h("div", { class: "chat-col" });
    E.emptyHint = h("div", { class: "chat-empty-hint", hidden: true });
    // The empty state sits inside the thread so it stays centred in the space above the chips
    // and composer, however tall the composer grows.
    E.empty = h("div", { class: "chat-empty" }, h("div", { class: "chat-empty-title", text: "Ready when you are!" }), E.emptyHint);
    E.thread = h("div", { class: "chat-thread", role: "log", "aria-label": "Chat messages" }, E.col, E.empty);
    E.suggest = h("div", { class: "chat-suggest" },
      chip("file-plus", "Add File", (e) => pickFile(e.currentTarget)),
      chip("upload", "Upload File", () => chooseUploads()),
      chip("doc", "Summarize", () => ask(SUMMARIZE)));

    E.thumbs = h("div", { class: "chat-thumbs", hidden: true });
    E.chips = h("div", { class: "chat-chips", hidden: true });
    E.attach = h("div", { class: "chat-attach", hidden: true }, E.thumbs, E.chips);
    E.input = h("textarea", { class: "chat-input", rows: "1", "aria-label": "Message the AI", spellcheck: "true",
      // keep grammar-checker extensions from overlaying their badge on the composer's icons
      "data-gramm": "false", "data-gramm_editor": "false", "data-enable-grammarly": "false" });
    E.fileImage = h("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", multiple: true, hidden: true });
    E.btnImage = iconBtn("image", "Attach image", () => E.fileImage.click());
    E.btnMic = iconBtn("wave", "Dictate", toggleDictation, "chat-mic");
    E.btnSend = iconBtn("send", "Send", onSendClick, "chat-send");
    E.composer = h("div", { class: "chat-composer" },
      E.attach,
      h("div", { class: "chat-row" }, E.input, h("div", { class: "chat-tools" }, E.btnImage, E.btnMic, E.btnSend)),
      E.fileImage);
    E.toBottom = h("button", { class: "chat-to-bottom", type: "button", title: "Scroll to the latest message", "aria-label": "Scroll to the latest message", html: icon("chevron-down", 16), hidden: true, onclick: () => scrollToBottom(true) });
    E.bottom = h("div", { class: "chat-bottom" }, E.toBottom, E.suggest, E.composer);
    E.panel.append(E.thread, E.bottom);

    // Composer behaviour
    E.input.addEventListener("input", () => { autoGrow(); updateComposer(); });
    E.input.addEventListener("keydown", onInputKey);
    E.input.addEventListener("paste", onPaste);
    E.fileImage.addEventListener("change", () => {
      const files = Array.from(E.fileImage.files || []);
      E.fileImage.value = "";
      addImageFiles(files);
    });
    E.composer.addEventListener("mousedown", (e) => {
      // Clicking the composer's padding focuses the textarea, like a single input.
      if (e.target === E.composer || e.target.classList.contains("chat-row")) { e.preventDefault(); E.input.focus(); }
    });
    // Drag-and-drop of images anywhere on the panel lands in the composer.
    const isFileDrag = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes("Files");
    E.panel.addEventListener("dragover", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      E.composer.classList.add("is-drop");
    });
    E.panel.addEventListener("dragleave", (e) => { if (!e.relatedTarget || !E.panel.contains(e.relatedTarget)) E.composer.classList.remove("is-drop"); });
    E.panel.addEventListener("drop", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      E.composer.classList.remove("is-drop");
      const files = Array.from(e.dataTransfer.files || []);
      const images = files.filter((f) => IMAGE_EXT[f.type]);
      if (images.length) addImageFiles(images);
      if (images.length < files.length) toast("Only PNG, JPEG, GIF and WebP images can be attached here. Use Upload File for other files.", "info");
    });

    // Thread behaviour
    E.thread.addEventListener("scroll", onThreadScroll, { passive: true });
    E.thread.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("a.chat-file-link");
      if (!a) return;
      e.preventDefault();
      const ref = parseFileRef(a.getAttribute("data-path") || "");
      openFile(ref.path, ref.line);
    });
    if (window.ResizeObserver) {
      // Re-measure when the mount point becomes visible or the dock/window is resized. The work
      // runs next frame: resizing the textarea inside the callback would re-trigger the observer.
      let queued = false;
      new ResizeObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; autoGrow(); if (S.stick) scrollToBottom(); });
      }).observe(E.thread);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // DOM: the docked sheet chrome (#dock-chat)
  // ---------------------------------------------------------------------------------------------
  function buildDock() {
    const d = E.dock;
    d.textContent = "";
    d.classList.add("chat-dock");
    E.handle = h("div", { class: "chat-dock-handle", role: "separator", "aria-orientation": "horizontal", "aria-label": "Resize the chat panel", tabindex: "0", title: "Drag to resize" });
    E.btnHistory = iconBtn("history", "Chat history", (e) => openHistory(e.currentTarget));
    E.btnTab = iconBtn("dock", "Open this chat as a tab", openAsTab);
    E.btnCollapse = iconBtn("collapse", "Collapse", () => setCollapsed(!S.dock.collapsed));
    E.btnCollapse.setAttribute("aria-expanded", "true");
    E.dockHead = h("div", { class: "chat-dock-head" }, E.btnHistory, E.btnTab, E.btnCollapse);
    E.dockBody = h("div", { class: "chat-dock-body" });
    d.append(E.handle, E.dockHead, E.dockBody);
    wireHandle();
    if (window.ResizeObserver) new ResizeObserver(() => reportDock()).observe(d);
  }

  function loadDockPrefs() {
    const p = storageGet(DOCK_KEY);
    if (p && typeof p === "object") {
      if (Number.isFinite(p.ratio)) S.dock.ratio = clamp(p.ratio, 0.15, DOCK_MAX);
      S.dock.collapsed = !!p.collapsed;
    }
  }
  const persistDock = () => storageSet(DOCK_KEY, { ratio: S.dock.ratio, collapsed: S.dock.collapsed });

  function applyDock() {
    const d = E.dock;
    d.style.setProperty("--chat-dock-h", `${(S.dock.ratio * 100).toFixed(2)}%`);
    d.classList.toggle("is-collapsed", S.dock.collapsed);
    const label = S.dock.collapsed ? "Expand" : "Collapse";
    E.btnCollapse.innerHTML = icon(S.dock.collapsed ? "expand" : "collapse", 16);
    E.btnCollapse.title = label;
    E.btnCollapse.setAttribute("aria-label", label);
    E.btnCollapse.setAttribute("aria-expanded", String(!S.dock.collapsed));
  }

  // Collapse to just the composer (or expand back), with a short height transition.
  function setCollapsed(collapsed) {
    collapsed = !!collapsed;
    if (!S.inited || S.dock.collapsed === collapsed) return;
    const d = E.dock;
    const animate = S.mode === "dock" && isVisible(d) && !reducedMotion();
    const from = animate ? d.getBoundingClientRect().height : 0;
    S.dock.collapsed = collapsed;
    applyDock();
    if (animate) {
      const to = d.getBoundingClientRect().height;
      clearTimeout(S.dockAnim);
      d.classList.remove("is-animating");
      d.style.height = `${from}px`;
      void d.offsetHeight; // commit the start height before transitioning
      d.classList.add("is-animating");
      d.style.height = `${to}px`;
      S.dockAnim = setTimeout(() => { d.classList.remove("is-animating"); d.style.height = ""; reportDock(); }, 180);
    }
    if (!collapsed) requestAnimationFrame(() => { if (S.stick) scrollToBottom(); });
    persistDock();
    reportDock();
  }

  function wireHandle() {
    const hd = E.handle;
    hd.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const d = E.dock;
      const parentH = (d.parentElement && d.parentElement.clientHeight) || window.innerHeight;
      const maxH = parentH * DOCK_MAX;
      const startY = e.clientY;
      const startH = d.getBoundingClientRect().height;
      let moved = false;
      let want = startH;
      try { hd.setPointerCapture(e.pointerId); } catch (_) { /* old browsers */ }
      d.classList.add("is-dragging");
      const move = (ev) => {
        const dy = ev.clientY - startY;
        if (!moved && Math.abs(dy) < 3) return;
        if (!moved) {
          moved = true;
          if (S.dock.collapsed) { S.dock.collapsed = false; applyDock(); }
        }
        want = startH - dy;
        // Let the sheet follow a little below the minimum so a downward fling reads as "collapse".
        d.style.height = `${clamp(want, DOCK_MIN * 0.7, maxH)}px`;
      };
      const up = () => {
        hd.removeEventListener("pointermove", move);
        hd.removeEventListener("pointerup", up);
        hd.removeEventListener("pointercancel", up);
        d.classList.remove("is-dragging");
        d.style.height = "";
        if (moved) {
          if (want < DOCK_MIN * 0.8) S.dock.collapsed = true; // the previous ratio is kept for expanding
          else S.dock.ratio = clamp(want, DOCK_MIN, maxH) / parentH;
          applyDock();
          persistDock();
          if (S.stick) scrollToBottom();
        }
        reportDock();
      };
      hd.addEventListener("pointermove", move);
      hd.addEventListener("pointerup", up);
      hd.addEventListener("pointercancel", up);
    });
    hd.addEventListener("dblclick", () => setCollapsed(!S.dock.collapsed));
    hd.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      if (S.dock.collapsed) { if (e.key === "ArrowUp") setCollapsed(false); return; }
      S.dock.ratio = clamp(S.dock.ratio + (e.key === "ArrowUp" ? 0.05 : -0.05), 0.2, DOCK_MAX);
      applyDock();
      persistDock();
    });
  }

  // Let the editor (or anyone) know how much of the column the sheet covers.
  function reportDock() {
    const active = S.mode === "dock" && isVisible(E.dock);
    const px = active ? Math.round(E.dock.getBoundingClientRect().height) : 0;
    if (px === S.dockPx) return;
    S.dockPx = px;
    document.documentElement.style.setProperty("--chat-dock-px", `${px}px`);
    emit("chat:dock", { height: px, collapsed: S.dock.collapsed });
  }

  // ---------------------------------------------------------------------------------------------
  // Public: mode switching
  // ---------------------------------------------------------------------------------------------
  function setMode(mode) {
    if (!S.inited) init();
    const m = mode === "dock" ? "dock" : "full";
    const top = E.thread.scrollTop;
    const follow = S.stick;
    closePopover();
    S.mode = m;
    const host = m === "dock" ? E.dockBody : E.full;
    if (host && E.panel.parentNode !== host) host.append(E.panel);
    E.panel.classList.toggle("is-dock", m === "dock");
    E.panel.classList.toggle("is-full", m === "full");
    E.dock.classList.toggle("is-active", m === "dock");
    if (m === "dock") refreshSelection();
    renderAttachments();
    // Moving the panel resets its scroll position, and scrollHeight is 0 while a mount is hidden.
    requestAnimationFrame(() => {
      autoGrow();
      if (follow) scrollToBottom(true);
      else E.thread.scrollTop = top;
      reportDock();
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Thread rendering
  // ---------------------------------------------------------------------------------------------
  function renderThread() {
    if (!E.col) return;
    const chat = S.current;
    S.nodes = new Map();
    S.dirty.clear();
    E.col.textContent = "";
    if (chat && chat.loading && !chat.messages.length) {
      E.col.append(h("div", { class: "chat-state" }, h("span", { class: "chat-spinner" }), "Loading chat…"));
    } else if (chat && chat.loadError) {
      E.col.append(errorRow(`Couldn't load this chat. ${chat.loadError}`, () => loadChat(chat)));
    }
    if (chat) for (const msg of chat.messages) appendNode(chat, msg);
    updateEmpty();
    requestAnimationFrame(() => scrollToBottom(true));
  }

  function appendNode(chat, msg) {
    const node = h("div", { class: `chat-msg chat-msg--${msg.role === "user" ? "user" : "ai"}`, "data-mid": msg.id });
    if (msg.role === "user") fillUser(node, msg);
    else fillAssistant(node, chat, msg);
    S.nodes.set(msg.id, node);
    E.col.append(node);
    return node;
  }

  function updateEmpty() {
    if (!E.panel) return;
    const chat = S.current;
    const empty = !chat || (!chat.messages.length && !chat.loading && !chat.loadError);
    E.panel.classList.toggle("is-empty", empty);
    const cfg = aiConfigSync();
    E.emptyHint.textContent = cfg.problem || "";
    E.emptyHint.hidden = !cfg.problem;
    if (empty) E.toBottom.hidden = true;
  }

  // Re-render one message on the next animation frame (streaming deltas coalesce here).
  function scheduleRender(chat, msg) {
    if (S.current !== chat) return;
    S.dirty.add(msg);
    if (S.frame) return;
    const flush = () => {
      cancelAnimationFrame(S.frame);
      clearTimeout(S.frameTimer);
      S.frame = 0;
      const list = Array.from(S.dirty);
      S.dirty.clear();
      for (const m of list) refreshMsg(S.current, m);
    };
    S.frame = requestAnimationFrame(flush);
    S.frameTimer = setTimeout(flush, 120); // rAF is paused in background tabs
  }

  function refreshMsg(chat, msg) {
    if (!chat || S.current !== chat) return;
    const node = S.nodes.get(msg.id);
    if (!node || !node.isConnected) { if (chat.messages.includes(msg)) renderThread(); return; }
    if (msg.role === "user") { node.textContent = ""; fillUser(node, msg); }
    else fillAssistant(node, chat, msg);
    if (S.stick) scrollToBottom();
  }

  function fillUser(node, msg) {
    const box = h("div", { class: "chat-user" });
    if (msg.context && msg.context.length) {
      box.append(h("div", { class: "chat-ref" }, msg.context.map((c) =>
        h("button", { class: "chat-ref-item", type: "button", title: `Open ${c.path}`, text: ctxLabel(c), onclick: () => openFile(c.path, c.from && c.from.line) }))));
    }
    if (msg.images && msg.images.length) {
      box.append(h("div", { class: "chat-user-imgs" }, msg.images.map((p) => {
        const u = rawUrl(p);
        return h("a", { href: u, target: "_blank", rel: "noopener", title: basename(p) }, h("img", { src: u, alt: "Attached image", loading: "lazy" }));
      })));
    }
    if (msg.content) box.append(h("div", { class: "chat-user-text", text: msg.content }));
    node.append(box);
  }

  function fillAssistant(node, chat, msg) {
    node.textContent = "";
    const run = chat.run && chat.run.msg === msg ? chat.run : null;
    const hasText = !!(msg.content && msg.content.trim());
    if (hasText) {
      const body = h("div", { class: "chat-md" });
      renderReply(body, chat, msg, !!run);
      node.append(body);
    }
    if (run && (run.waiting || !hasText)) node.append(thinkingRow(run.status));
    if (msg.notices && msg.notices.length) {
      node.append(h("div", { class: "chat-notices" }, msg.notices.map((t) =>
        h("div", { class: "chat-notice" }, h("span", { class: "chat-notice-ic", html: icon("alert", 13) }), h("span", { text: t })))));
    }
    const last = isLastReply(chat, msg) && !chat.run;
    if (msg.error) {
      node.append(errorRow(msg.error, last ? () => retry(chat, msg) : null));
    } else if (msg.stopped) {
      node.append(h("div", { class: "chat-stopped" }, h("span", { text: "Stopped" }),
        last ? h("button", { class: "chat-link-btn", type: "button", text: "Retry", onclick: () => retry(chat, msg) }) : null));
    } else if (!run && !hasText && msg.phase === "done") {
      node.append(h("div", { class: "chat-stopped", text: "The AI sent an empty reply." }));
    }
    if (!run && hasText && !msg.error) {
      node.append(h("div", { class: "chat-actions" }, copyButton(() => visibleText(msg), "Copy reply")));
    }
  }

  function isLastReply(chat, msg) {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === "assistant") return chat.messages[i] === msg;
    }
    return false;
  }

  function thinkingRow(status) {
    const text = !status || /^thinking/i.test(status) ? "Thinking ..." : status;
    return h("div", { class: "chat-thinking", role: "status" }, h("span", { class: "chat-thinking-dot" }), h("span", { class: "chat-thinking-text", text }));
  }

  function errorRow(message, onRetry) {
    return h("div", { class: "chat-error", role: "alert" },
      h("span", { class: "chat-error-ic", html: icon("alert", 15) }),
      h("span", { class: "chat-error-text", text: message }),
      onRetry ? h("button", { class: "chat-retry", type: "button", text: "Retry", onclick: onRetry }) : null);
  }

  function copyButton(getText, title) {
    const b = h("button", { class: "chat-copy", type: "button", title: title || "Copy", "aria-label": title || "Copy", html: icon("copy", 14) });
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await copyText(getText());
      b.innerHTML = icon(ok ? "check" : "close", 14);
      b.classList.toggle("is-done", ok);
      clearTimeout(b._reset);
      b._reset = setTimeout(() => { b.innerHTML = icon("copy", 14); b.classList.remove("is-done"); }, 1400);
      if (!ok) toast("Couldn't copy to the clipboard.", "error");
    });
    return b;
  }

  const visibleText = (msg) => String(msg.content || "").replace(EDIT_RE, "").replace(/\n{3,}/g, "\n\n").trim();

  // ---------------------------------------------------------------------------------------------
  // Markdown + math
  // ---------------------------------------------------------------------------------------------
  function renderReply(body, chat, msg, streaming) {
    const { parts } = splitEdits(msg.content, streaming);
    const { md, groups } = composeMarkdown(parts);
    renderMarkdown(body, md, (el) => replaceGroups(el, groups, (group) => buildCards(chat, msg, group, streaming)));
  }

  // marked + DOMPurify, with math swapped for placeholders while marked runs, then KaTeX.
  function renderMarkdown(el, md, beforeMath) {
    if (!window.DOMPurify || typeof window.DOMPurify.sanitize !== "function") {
      el.textContent = md.replace(/[-]\d*[]?/g, ""); // never inject unsanitised markup
      return;
    }
    const { text, store } = protectMath(md);
    let html = mdToHtml(text);
    html = html
      .replace(MATH_TOKEN, (_, k) => esc(store[+k] || ""))
      // marked percent-encodes link targets; restore placeholders there too.
      .replace(/%EE%80%80(\d+)%EE%80%81/g, (_, k) => encodeURIComponent(store[+k] || ""))
      .replace(/%EE%80%82/g, "%24");
    el.innerHTML = window.DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["style", "form", "button", "textarea", "select", "iframe"],
      FORBID_ATTR: ["style"],
    });
    neutralizeDollars(el);
    if (beforeMath) beforeMath(el);
    if (typeof window.renderMathInElement === "function") {
      try { window.renderMathInElement(el, KATEX_OPTS); } catch (err) { console.warn("[chat] KaTeX failed", err); }
    }
    enhance(el);
  }

  function mdToHtml(src) {
    const mk = window.marked;
    if (mk) {
      try {
        if (!S.md && typeof mk.Marked === "function") S.md = new mk.Marked({ gfm: true, breaks: false });
        return S.md ? S.md.parse(src) : mk.parse(src, { gfm: true, breaks: false });
      } catch (err) {
        console.warn("[chat] markdown failed", err);
      }
    }
    return src.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  }

  // Swap math spans ($$..$$, \[..\], \(..\), $..$) for placeholders, outside code. A "$" that
  // doesn't open math becomes the DOLLAR mark so KaTeX auto-render can't pair it up later.
  function protectMath(src) {
    const store = [];
    const keep = (s) => MATH_OPEN + (store.push(s) - 1) + MATH_CLOSE;
    const n = src.length;
    let out = "";
    let i = 0;
    let fence = null; // the ``` or ~~~ run of the fenced code block we are in
    let lineStart = true;
    while (i < n) {
      if (lineStart) {
        const nl = src.indexOf("\n", i);
        const end = nl < 0 ? n : nl + 1;
        const line = src.slice(i, end);
        const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
          if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.slice(f[0].length).trim()) fence = null;
          out += line;
          i = end;
          continue;
        }
        if (f) { fence = f[1]; out += line; i = end; continue; }
        lineStart = false;
      }
      const c = src[i];
      if (c === "\n") { out += c; i++; lineStart = true; continue; }
      if (c === "`") { // inline code span: copy verbatim
        let j = i;
        while (src[j] === "`") j++;
        const close = codeSpanEnd(src, j, j - i);
        if (close >= 0) { out += src.slice(i, close); i = close; } else { out += src.slice(i, j); i = j; }
        continue;
      }
      if (c === "\\") {
        const d = src[i + 1];
        if (d === "$") { out += DOLLAR; i += 2; continue; }
        if (d === "\\") { out += "\\\\"; i += 2; continue; }
        if (d === "[" || d === "(") {
          const k = src.indexOf(d === "[" ? "\\]" : "\\)", i + 2);
          if (k >= 0) { out += keep(src.slice(i, k + 2)); i = k + 2; continue; }
        }
        out += c;
        i++;
        continue;
      }
      if (c === "$") {
        if (src[i + 1] === "$") {
          const k = src.indexOf("$$", i + 2);
          if (k >= 0 && src.slice(i + 2, k).trim()) { out += keep(src.slice(i, k + 2)); i = k + 2; continue; }
          out += DOLLAR + DOLLAR;
          i += 2;
          continue;
        }
        const k = inlineMathEnd(src, i + 1);
        if (k > 0) { out += keep(src.slice(i, k + 1)); i = k + 1; continue; }
        out += DOLLAR;
        i++;
        continue;
      }
      out += c;
      i++;
    }
    return { text: out, store };
  }

  // End (exclusive) of an inline code span whose opening run has `len` backticks, or -1.
  function codeSpanEnd(src, from, len) {
    for (let k = from; k < src.length;) {
      if (src[k] === "\n" && /^\n[ \t]*\n/.test(src.slice(k, k + 40))) return -1;
      if (src[k] !== "`") { k++; continue; }
      let e = k;
      while (src[e] === "`") e++;
      if (e - k === len) return e;
      k = e;
    }
    return -1;
  }

  // Index of the "$" closing inline math opened just before `start`, or -1. Pandoc's rule: the
  // opener is followed by a non-space, the closer preceded by a non-space and not followed by a
  // digit, so "$5 and $10" stays text. The first unescaped "$" decides.
  function inlineMathEnd(src, start) {
    if (start >= src.length || /\s/.test(src[start])) return -1;
    for (let k = start; k < src.length; k++) {
      const ch = src[k];
      if (ch === "\\") { k++; continue; }
      if (ch === "`") return -1;
      if (ch === "\n" && /^\n[ \t]*\n/.test(src.slice(k, k + 40))) return -1;
      if (ch === "$") return /\s/.test(src[k - 1]) || /\d/.test(src[k + 1] || "") ? -1 : k;
    }
    return -1;
  }

  // DOLLAR marks become a "$" in its own <span>, so auto-render never pairs it with another "$".
  function neutralizeDollars(root) {
    const hits = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) if (walker.currentNode.nodeValue.indexOf(DOLLAR) >= 0) hits.push(walker.currentNode);
    for (const tn of hits) {
      const parent = tn.parentElement;
      if (parent && parent.closest("pre, code")) { tn.nodeValue = tn.nodeValue.split(DOLLAR).join("$"); continue; }
      const nodes = [];
      tn.nodeValue.split(DOLLAR).forEach((piece, i) => {
        if (i) nodes.push(h("span", { class: "chat-dollar", text: "$" }));
        if (piece) nodes.push(document.createTextNode(piece));
      });
      tn.replaceWith(...nodes);
    }
    for (const node of root.querySelectorAll("*")) {
      for (const a of Array.from(node.attributes)) if (a.value.indexOf(DOLLAR) >= 0) node.setAttribute(a.name, a.value.split(DOLLAR).join("$"));
    }
  }

  // Code blocks get a header with the language and a copy button; links open in a new tab, or in
  // the editor when they point at a project file; relative images load through /api/raw.
  function enhance(root) {
    for (const pre of Array.from(root.querySelectorAll("pre"))) {
      if (pre.parentElement && pre.parentElement.classList.contains("chat-code")) continue;
      const code = pre.querySelector("code");
      const m = code && /(?:^|\s)language-([\w+#.-]+)/.exec(code.className);
      const box = h("div", { class: "chat-code" });
      pre.replaceWith(box);
      box.append(h("div", { class: "chat-code-head" }, h("span", { class: "chat-code-lang", text: m ? m[1] : "" }),
        copyButton(() => (code || pre).textContent.replace(/\n$/, ""), "Copy code")), pre);
    }
    for (const a of root.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("/") && !href.startsWith("#")) {
        a.classList.add("chat-file-link");
        a.setAttribute("data-path", href);
        a.title = `Open ${safeDecode(href)}`;
      } else {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
    }
    for (const img of root.querySelectorAll("img[src]")) {
      const src = img.getAttribute("src") || "";
      if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("/")) img.src = rawUrl(safeDecode(src));
      img.loading = "lazy";
    }
    for (const t of Array.from(root.querySelectorAll("table"))) {
      if (t.parentElement && t.parentElement.classList.contains("chat-table")) continue;
      const wrap = h("div", { class: "chat-table" });
      t.replaceWith(wrap);
      wrap.append(t);
    }
  }

  function safeDecode(s) { try { return decodeURI(s); } catch (_) { return s; } }

  // "sections/intro.tex#L12", "main.tex:12" or "main.tex" -> {path, line}
  function parseFileRef(ref) {
    let s = safeDecode(String(ref || ""));
    let line = 0;
    const m = /(?:#L?|:)(\d+)(?:[:-]\d+)*$/.exec(s);
    if (m) { line = +m[1]; s = s.slice(0, m.index); }
    return { path: fmtPath(s.replace(/#.*$/, "")), line };
  }

  // ---------------------------------------------------------------------------------------------
  // Edit blocks and change cards
  // ---------------------------------------------------------------------------------------------
  // Split the reply into text, complete edit blocks and (while streaming) a trailing partial block.
  function splitEdits(text, streaming) {
    const parts = [];
    let last = 0;
    let index = 0;
    let m;
    EDIT_RE.lastIndex = 0;
    while ((m = EDIT_RE.exec(text))) {
      if (m.index > last) parts.push({ type: "text", text: text.slice(last, m.index) });
      parts.push({ type: "edit", index: index++, path: m[1], search: m[2], replace: m[3] });
      last = EDIT_RE.lastIndex;
    }
    EDIT_RE.lastIndex = 0;
    let rest = text.slice(last);
    const k = rest.indexOf(EDIT_START);
    if (k >= 0) {
      if (k > 0) parts.push({ type: "text", text: rest.slice(0, k) });
      const after = rest.slice(k + EDIT_START.length);
      const nl = after.indexOf("\n");
      parts.push({ type: "partial", path: nl >= 0 ? after.slice(0, nl) : "", named: nl >= 0 });
    } else {
      if (streaming) {
        // Hide a marker that is still arriving ("<<<", "<<<<<<< SEA", ...).
        const nl = rest.lastIndexOf("\n");
        const tail = rest.slice(nl + 1).trim();
        if (tail && tail[0] === "<" && EDIT_START.startsWith(tail)) rest = rest.slice(0, nl + 1);
      }
      if (rest) parts.push({ type: "text", text: rest });
    }
    return { parts, edits: parts.filter((p) => p.type === "edit") };
  }

  // Markdown with one placeholder paragraph per run of consecutive edit blocks.
  function composeMarkdown(parts) {
    let md = "";
    const groups = [];
    let cur = null;
    for (const p of parts) {
      if (p.type === "text") {
        if (cur && !p.text.trim()) continue; // blank lines between blocks keep one card list
        cur = null;
        md += p.text;
      } else {
        if (!cur) {
          cur = [];
          groups.push(cur);
          md += `\n\n${GROUP_OPEN}${groups.length - 1}${GROUP_CLOSE}\n\n`;
        }
        cur.push(p);
      }
    }
    // Models sometimes wrap edit blocks in a code fence despite the instructions: drop the fence.
    md = md.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n\s*(\d+)\s*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, "$1$3");
    return { md, groups };
  }

  // Replace group placeholders with card lists. A paragraph holding only the token is replaced
  // whole, so no empty <p> margins are left around the cards.
  function replaceGroups(root, groups, build) {
    if (!groups.length) return;
    const hits = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) if (walker.currentNode.nodeValue.indexOf(GROUP_OPEN) >= 0) hits.push(walker.currentNode);
    for (const tn of hits) {
      if (!root.contains(tn)) continue;
      const parent = tn.parentElement;
      const block = parent && (parent.closest("pre") || parent.closest("p"));
      const lift = !!(block && root.contains(block) && !block.textContent.replace(GROUP_TOKEN, "").trim());
      const nodes = [];
      const v = tn.nodeValue;
      let pos = 0;
      let m;
      GROUP_TOKEN.lastIndex = 0;
      while ((m = GROUP_TOKEN.exec(v))) {
        if (m.index > pos) nodes.push(document.createTextNode(v.slice(pos, m.index)));
        const g = groups[+m[1]];
        if (g) nodes.push(build(g));
        pos = GROUP_TOKEN.lastIndex;
      }
      GROUP_TOKEN.lastIndex = 0;
      if (pos < v.length) nodes.push(document.createTextNode(v.slice(pos)));
      if (lift) block.replaceWith(...nodes.filter((x) => x.nodeType === 1));
      else tn.replaceWith(...nodes);
    }
  }

  // Path of an edit block: empty means the file that was active when the message was sent.
  function editPath(raw, msg) {
    let p = fmtPath(String(raw || "").replace(/^[`'"*]+|[`'"*]+$/g, ""));
    const root = T.state && T.state.project && T.state.project.root;
    if (p && root && p.startsWith(String(root).replace(/\/+$/, "") + "/")) p = p.slice(String(root).replace(/\/+$/, "").length + 1);
    return p || fmtPath(msg.active_path) || fmtPath(T.state && T.state.main);
  }

  function buildCards(chat, msg, group, streaming) {
    const list = h("div", { class: "chat-changes" });
    for (const part of group) list.append(cardRow(msg, part, streaming));
    return list;
  }

  function cardRow(msg, part, streaming) {
    const path = editPath(part.path, msg);
    const name = basename(path) || "file";
    if (part.type === "partial") {
      if (streaming) return changeRow({ name: `Editing ${part.named ? name : "file"}…`, title: path, muted: true });
      return changeRow({ name, path, title: "The edit block was incomplete.", label: "Couldn't apply", labelKind: "error" });
    }
    if (streaming) return changeRow({ name: `Editing ${name}…`, title: path, muted: true });
    const r = msg.edits && msg.edits[part.index];
    if (!r) {
      if (msg.phase === "applying") return changeRow({ name, path, loc: "Applying…", muted: true });
      return changeRow({ name, path, label: "Not applied", title: "This edit was not applied because the reply did not finish." });
    }
    const rpath = fmtPath(r.path) || path;
    const rname = basename(rpath) || name;
    if (!r.ok) {
      return changeRow({ name: rname, path: rpath, loc: r.location, label: "Couldn't apply", labelKind: "error", title: r.reason || "Couldn't apply this edit." });
    }
    const label = r.status === "kept" ? "Kept" : r.status === "undone" ? "Undone" : "";
    return changeRow({ name: rname, path: rpath, line: r.line, loc: r.location, label, added: num(r.added), removed: num(r.removed), title: `${rpath}${r.location ? " — " + r.location : ""}` });
  }

  function changeRow(o) {
    const clickable = !!o.path;
    const row = h(clickable ? "button" : "div", { class: "chat-change" + (o.muted ? " is-muted" : ""), type: clickable ? "button" : null, title: o.title || null },
      h("span", { class: "chat-change-ic", html: icon("code", 14) }),
      h("span", { class: "chat-change-file", text: o.name }),
      o.loc ? h("span", { class: "chat-change-loc", text: o.loc }) : null,
      h("span", { class: "chat-change-gap" }),
      o.label ? h("span", { class: "chat-change-label" + (o.labelKind ? " is-" + o.labelKind : ""), text: o.label }) : null,
      o.added != null ? h("span", { class: "chat-change-add", text: `+${o.added}` }) : null,
      o.added != null ? h("span", { class: "chat-change-del", text: `−${o.removed}` }) : null);
    if (clickable) row.addEventListener("click", () => openFile(o.path, o.line));
    return row;
  }

  // On `done`: hand the complete edit blocks to the editor and store its results on the message.
  async function applyEdits(chat, msg) {
    const { edits } = splitEdits(msg.content, false);
    if (!edits.length) { msg.edits = []; return; }
    const payload = edits.map((e) => ({ id: editId(chat, msg, e.index), path: editPath(e.path, msg), search: e.search, replace: e.replace }));
    msg.edits = [];
    msg.phase = "applying";
    refreshMsg(chat, msg);
    let results;
    let timer = 0;
    try {
      if (!T.editor || typeof T.editor.reviewEdits !== "function") throw new Error("The editor isn't ready.");
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The editor didn't respond.")), 30000); });
      results = await Promise.race([Promise.resolve(T.editor.reviewEdits(payload)), timeout]);
      if (!Array.isArray(results)) throw new Error("The editor returned no results.");
    } catch (err) {
      const reason = (err && err.message) || String(err);
      results = payload.map((p) => ({ id: p.id, path: p.path, ok: false, reason }));
    }
    clearTimeout(timer);
    const byId = new Map(results.filter(Boolean).map((r) => [r.id, r]));
    msg.edits = payload.map((p, i) => {
      const r = byId.get(p.id) || results[i] || { ok: false, reason: "The editor didn't report on this edit." };
      const ok = !!r.ok;
      const early = S.earlyResolved.get(p.id);
      S.earlyResolved.delete(p.id);
      return {
        id: p.id,
        path: fmtPath(r.path || p.path),
        ok,
        reason: ok ? "" : String(r.reason || "Couldn't apply this edit."),
        added: num(r.added),
        removed: num(r.removed),
        location: String(r.location || ""),
        line: num(r.line),
        status: ok ? early || "pending" : "failed",
      };
    });
    indexEdits(chat, msg);
  }

  function onEditsResolved(ev) {
    if (!ev || !ev.id) return;
    const status = ev.kept ? "kept" : "undone";
    const hit = S.editIndex.get(ev.id);
    if (!hit) { S.earlyResolved.set(ev.id, status); return; }
    const e = hit.msg.edits && hit.msg.edits[hit.i];
    if (!e || e.id !== ev.id || !e.ok) return;
    e.status = status;
    if (!(hit.chat.run && hit.chat.run.msg === hit.msg)) refreshMsg(hit.chat, hit.msg);
    saveSoon(hit.chat);
  }

  // ---------------------------------------------------------------------------------------------
  // AI settings
  // ---------------------------------------------------------------------------------------------
  function aiConfigSync() {
    const st = (T.state && T.state.settings) || S.settings;
    if (!st) return { pending: true };
    const id = st.provider || "off";
    if (id === "off") return { problem: `AI is turned off. ${PICK_PROVIDER}` };
    const ai = (T.state && (T.state.ai || (T.state.project && T.state.project.ai))) || null;
    const providers = Array.isArray(ai) ? ai : ai && Array.isArray(ai.providers) ? ai.providers : null;
    const info = providers ? providers.find((p) => p && p.id === id) : null;
    if (providers && !info) return { problem: `The AI provider “${id}” isn't known. ${PICK_PROVIDER}` };
    if (info && info.available === false) return { problem: `${info.label || id} isn't available on this Mac. ${PICK_PROVIDER}` };
    const m = st.model;
    let model = typeof m === "string" ? m : m && typeof m === "object" ? m[id] : "";
    if (!model && info) model = info.default_model || (Array.isArray(info.models) && info.models[0]) || "";
    return { provider: id, model: model || "", effort: st.effort || "medium" };
  }

  async function aiConfig() {
    let cfg = aiConfigSync();
    if (cfg.pending) {
      try { S.settings = await T.api.get("/api/settings"); } catch (_) { /* reported below */ }
      cfg = aiConfigSync();
      if (cfg.pending) cfg = { problem: `Couldn't read the AI settings. ${PICK_PROVIDER}` };
    }
    return cfg;
  }

  function activePath() {
    let p = "";
    try { p = (T.editor && typeof T.editor.current === "function" && T.editor.current()) || ""; } catch (_) { p = ""; }
    return fmtPath(p || (T.state && T.state.main) || "");
  }

  // ---------------------------------------------------------------------------------------------
  // Sending and streaming
  // ---------------------------------------------------------------------------------------------
  function sendMessage(chat, m) {
    const userMsg = { id: rid("m"), role: "user", content: String(m.text || ""), context: normContext(m.context), images: (m.images || []).filter((p) => typeof p === "string" && p), ts: now() };
    const aiMsg = { id: rid("m"), role: "assistant", content: "", edits: [], notices: [], error: "", stopped: false, active_path: activePath(), ts: now(), phase: "streaming" };
    chat.messages.push(userMsg, aiMsg);
    setTitleFrom(chat);
    if (S.mode === "dock" && S.dock.collapsed) setCollapsed(false);
    if (S.current === chat) {
      appendNode(chat, userMsg);
      appendNode(chat, aiMsg);
      updateEmpty();
      scrollToBottom(true);
    }
    startRun(chat, userMsg, aiMsg);
  }

  async function startRun(chat, userMsg, aiMsg) {
    const run = { id: rid("r"), msg: aiMsg, text: "", status: "Thinking…", waiting: true, finished: false, stopped: false, handle: null };
    chat.run = run;
    Object.assign(aiMsg, { phase: "streaming", error: "", stopped: false, notices: [], edits: [] });
    updateComposer();
    refreshMsg(chat, aiMsg);
    const cfg = await aiConfig();
    if (run.finished) return; // stopped while the settings were being read
    if (cfg.problem) { finishRun(chat, run, { error: cfg.problem }); return; }
    const body = {
      request_id: run.id,
      provider: cfg.provider,
      model: cfg.model,
      effort: cfg.effort,
      history: buildHistory(chat, userMsg),
      message: {
        text: userMsg.content || (userMsg.images.length ? "Please look at the attached image." : ""),
        context: userMsg.context,
        images: userMsg.images,
      },
      active_path: aiMsg.active_path || "",
    };
    try {
      run.handle = T.api.stream("/api/ai", body, (name, data) => onStreamEvent(chat, run, name, data));
    } catch (err) {
      finishRun(chat, run, { error: errText(err) });
      return;
    }
    run.handle.done.then(
      () => finishRun(chat, run, { eof: true }),
      (err) => finishRun(chat, run, run.stopped || (err && err.name === "AbortError") ? { stopped: true } : { error: errText(err) })
    );
  }

  function onStreamEvent(chat, run, name, data) {
    if (run.finished) return;
    const msg = run.msg;
    const d = data && typeof data === "object" ? data : { text: typeof data === "string" ? data : "" };
    if (name === "status") {
      run.status = d.text || "Thinking…";
      run.waiting = true;
      scheduleRender(chat, msg);
    } else if (name === "delta") {
      const t = typeof d.text === "string" ? d.text : "";
      if (!t) return;
      run.text += t;
      msg.content = run.text;
      run.waiting = false;
      scheduleRender(chat, msg);
    } else if (name === "notice") {
      if (d.text) { msg.notices.push(String(d.text)); scheduleRender(chat, msg); }
    } else if (name === "done") {
      finishRun(chat, run, { done: true, text: typeof d.text === "string" ? d.text : "", usage: d.usage });
    } else if (name === "error") {
      finishRun(chat, run, { error: d.message || d.error || d.text || "The AI request failed." });
    }
  }

  // Deltas vs. the `done` text: Codex sends whole items (done joins them properly); Claude's done
  // may hold only the last turn when it used a tool. Keep the streamed text when it contains done's.
  function pickFinal(streamed, doneText) {
    if (!doneText || !doneText.trim()) return streamed;
    if (!streamed || !streamed.trim()) return doneText;
    return streamed.includes(doneText.trim()) ? streamed : doneText;
  }

  async function finishRun(chat, run, out) {
    if (run.finished) return;
    run.finished = true;
    const msg = run.msg;
    if (out.done) {
      msg.content = pickFinal(run.text, out.text);
      if (out.usage) msg.usage = out.usage;
      if (chat.run === run) chat.run = null; // the composer can send again while edits are applied
      updateComposer();
      await applyEdits(chat, msg);
      msg.phase = "done";
    } else if (out.stopped) {
      msg.stopped = true;
      msg.phase = "stopped";
    } else if (out.error) {
      msg.error = String(out.error);
      msg.phase = "error";
    } else {
      // The stream ended without `done` or `error`.
      msg.error = run.text ? "The connection closed before the reply finished." : "The AI ended without a reply.";
      msg.phase = "error";
    }
    if (chat.run === run) chat.run = null;
    S.dirty.delete(msg);
    refreshMsg(chat, msg);
    updateComposer();
    save(chat);
    drainQueue(chat);
  }

  function stop(chat) {
    const run = chat && chat.run;
    if (!run) return;
    run.stopped = true;
    try { if (run.handle) run.handle.abort(); } catch (_) { /* already closed */ }
    if (T.api) T.api.post("/api/ai/cancel", { request_id: run.id }).catch(() => {});
    finishRun(chat, run, { stopped: true });
  }

  // Re-run the last exchange in place (only the last reply offers Retry).
  function retry(chat, aiMsg) {
    if (chat.run || chat.loading) return;
    const idx = chat.messages.indexOf(aiMsg);
    let u = idx - 1;
    while (u >= 0 && chat.messages[u].role !== "user") u--;
    if (idx < 0 || u < 0) return;
    const userMsg = chat.messages[u];
    const fresh = { id: rid("m"), role: "assistant", content: "", edits: [], notices: [], error: "", stopped: false, active_path: aiMsg.active_path || activePath(), ts: now(), phase: "streaming" };
    chat.messages.splice(idx, 1, fresh);
    if (S.current === chat) {
      const old = S.nodes.get(aiMsg.id);
      S.nodes.delete(aiMsg.id);
      if (old && old.isConnected) {
        const node = h("div", { class: "chat-msg chat-msg--ai", "data-mid": fresh.id });
        old.replaceWith(node);
        S.nodes.set(fresh.id, node);
      } else renderThread();
      scrollToBottom(true);
    }
    startRun(chat, userMsg, fresh);
  }

  // Prior turns as {role, content}. Assistant text keeps its edit blocks plus a note on what
  // happened to them, so the model knows which of its edits are in the file.
  function buildHistory(chat, userMsg) {
    const out = [];
    for (const m of chat.messages) {
      if (m === userMsg) break;
      if (m.role === "user") {
        const refs = (m.context || []).map(ctxLabel).join(" ");
        const text = [refs, m.content].filter(Boolean).join("\n");
        if (text || (m.images && m.images.length)) out.push({ role: "user", content: text || "(sent an image)" });
      } else if (m.content && m.content.trim()) {
        out.push({ role: "assistant", content: m.content + editNote(m) });
      }
    }
    return out;
  }

  function editNote(m) {
    const edits = (m.edits || []).filter(Boolean);
    if (!edits.length) return "";
    const words = { kept: "kept", undone: "undone by the user", pending: "awaiting review", failed: "couldn't be applied" };
    const items = edits.map((e) => `${e.path || "file"}${e.location ? " (" + e.location + ")" : ""}: ${words[e.status] || e.status}${e.status === "failed" && e.reason ? " — " + e.reason : ""}`);
    return `\n\n[Edit results: ${items.join("; ")}]`;
  }

  function drainQueue(chat) {
    if (chat.run || chat.loading) return;
    const i = S.queue.findIndex((q) => q.chat === chat);
    if (i < 0) return;
    const q = S.queue.splice(i, 1)[0];
    sendMessage(chat, q);
  }

  // ---------------------------------------------------------------------------------------------
  // Composer
  // ---------------------------------------------------------------------------------------------
  function onSendClick() {
    const chat = S.current;
    if (chat && chat.run) stop(chat);
    else sendFromComposer();
  }

  function onInputKey(e) {
    if (e.key !== "Enter" || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.isComposing || e.keyCode === 229) return; // an IME is committing a composition
    e.preventDefault();
    sendFromComposer();
  }

  function sendFromComposer() {
    const chat = ensureCurrent();
    if (chat.run) return;
    if (chat.loading) { toast("The chat is still loading.", "info"); return; }
    if (chat.loadError) { toast("This chat couldn't be loaded. Retry loading it first.", "error"); return; }
    const d = chat.draft;
    if (d.images.some((i) => i.state === "uploading") || d.context.some((c) => c.uploading)) {
      toast("Wait for the uploads to finish.", "info");
      return;
    }
    const text = E.input.value.trim();
    const images = d.images.filter((i) => i.state === "done").map((i) => i.path);
    if (!text && !images.length) return;
    const context = d.context.slice();
    if (S.mode === "dock") {
      refreshSelection();
      const sel = pendingSelection();
      if (sel) {
        if (!context.some((c) => ctxLabel(c) === ctxLabel(sel))) context.push(sel);
        S.usedSelKey = selKey(S.selection);
      }
    }
    stopDictation();
    for (const img of d.images) if (img.preview) URL.revokeObjectURL(img.preview);
    E.input.value = "";
    d.text = "";
    d.context = [];
    d.images = [];
    autoGrow();
    renderAttachments();
    sendMessage(chat, { text, context, images });
  }

  function autoGrow() {
    const ta = E.input;
    if (!ta || !isVisible(ta)) return; // scrollHeight is 0 while the mount point is hidden
    ta.style.height = "auto";
    const cs = getComputedStyle(ta);
    const line = parseFloat(cs.lineHeight) || 20;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const max = line * 8 + pad;
    const want = Math.min(ta.scrollHeight, max);
    ta.style.height = `${Math.max(want, line + pad)}px`;
    ta.style.overflowY = ta.scrollHeight > max + 1 ? "auto" : "hidden";
  }

  function updateComposer() {
    if (!E.btnSend) return;
    const chat = S.current;
    const busy = !!(chat && chat.run);
    const label = busy ? "Stop" : "Send";
    E.btnSend.innerHTML = icon(busy ? "stop" : "send", 16);
    E.btnSend.title = label;
    E.btnSend.setAttribute("aria-label", label);
    E.btnSend.classList.toggle("is-stop", busy);
    const can = !!(E.input.value.trim() || (chat && chat.draft.images.some((i) => i.state === "done")));
    E.btnSend.classList.toggle("is-ready", busy || can);
    E.btnSend.disabled = !busy && !can;
  }

  function focusComposer(caretToEnd) {
    if (!E.input) return;
    requestAnimationFrame(() => {
      if (!isVisible(E.input)) return;
      E.input.focus({ preventScroll: true });
      if (caretToEnd) { const n = E.input.value.length; E.input.setSelectionRange(n, n); }
    });
  }

  function renderAttachments() {
    if (!E.attach) return;
    const chat = S.current;
    const d = chat ? chat.draft : { context: [], images: [] };
    E.thumbs.textContent = "";
    E.chips.textContent = "";
    for (const img of d.images) E.thumbs.append(thumb(chat, img));
    for (const c of d.context) {
      E.chips.append(ctxChip(c.uploading ? `Uploading ${basename(c.path)}…` : ctxLabel(c), () => {
        d.context = d.context.filter((x) => x !== c);
        renderAttachments();
      }, c.uploading ? "is-uploading" : ""));
    }
    const sel = S.mode === "dock" ? pendingSelection() : null;
    if (sel && !d.context.some((c) => ctxLabel(c) === ctxLabel(sel))) {
      const chipEl = ctxChip(ctxLabel(sel), () => { S.usedSelKey = selKey(S.selection); renderAttachments(); }, "is-pending");
      chipEl.title = "The editor selection is attached when you send";
      E.chips.append(chipEl);
    }
    E.thumbs.hidden = !E.thumbs.childNodes.length;
    E.chips.hidden = !E.chips.childNodes.length;
    E.attach.hidden = E.thumbs.hidden && E.chips.hidden;
    updateComposer();
  }

  function ctxChip(label, onRemove, extra) {
    return h("span", { class: "chat-ctx" + (extra ? " " + extra : ""), title: label },
      h("span", { class: "chat-ctx-label", text: label }),
      h("button", { class: "chat-ctx-x", type: "button", title: "Remove", "aria-label": `Remove ${label}`, html: icon("close", 11), onclick: onRemove }));
  }

  function thumb(chat, img) {
    const src = img.preview || (img.state === "done" ? rawUrl(img.path) : "");
    const title = img.state === "error" ? `Upload failed: ${img.error}` : img.state === "uploading" ? "Uploading…" : img.name || basename(img.path);
    return h("div", { class: `chat-thumb is-${img.state}`, title },
      src ? h("img", { src, alt: "" }) : null,
      img.state === "uploading" ? h("span", { class: "chat-spinner" }) : null,
      img.state === "error" ? h("span", { class: "chat-thumb-err", html: icon("alert", 16) }) : null,
      h("button", { class: "chat-thumb-x", type: "button", title: "Remove", "aria-label": "Remove image", html: icon("close", 11), onclick: () => {
        chat.draft.images = chat.draft.images.filter((x) => x !== img);
        if (img.preview) URL.revokeObjectURL(img.preview);
        renderAttachments();
      } }));
  }

  function onPaste(e) {
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    const files = items.filter((it) => it.kind === "file" && IMAGE_EXT[it.type]).map((it) => it.getAsFile()).filter(Boolean);
    if (!files.length) return;
    // Screenshots paste as an image only; rich copies also carry text, which still pastes.
    if (!items.some((it) => it.kind === "string" && it.type === "text/plain")) e.preventDefault();
    addImageFiles(files);
  }

  // Attach pictures: upload each to .texc/uploads/<random>.<ext> and show a thumbnail.
  async function addImageFiles(files) {
    const chat = ensureCurrent();
    const jobs = [];
    for (const file of files) {
      const ext = IMAGE_EXT[file.type];
      if (!ext) { toast(`${file.name || "That file"} isn't a PNG, JPEG, GIF or WebP image.`, "error"); continue; }
      if (file.size > MAX_UPLOAD) { toast(`${file.name || "The image"} is larger than 25 MB.`, "error"); continue; }
      const item = {
        key: rid("i"),
        name: file.name || `image.${ext}`,
        path: `.texc/uploads/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`,
        preview: window.URL && URL.createObjectURL ? URL.createObjectURL(file) : "",
        state: "uploading",
        error: "",
      };
      chat.draft.images.push(item);
      jobs.push(uploadImage(item, file));
    }
    if (S.current === chat) renderAttachments();
    await Promise.all(jobs);
    if (S.current === chat) renderAttachments();
    focusComposer();
  }

  async function uploadImage(item, file) {
    try {
      const data_base64 = await fileToBase64(file);
      const res = await T.api.post("/api/upload", { path: item.path, data_base64 });
      item.path = fmtPath((res && res.path) || item.path);
      item.state = "done";
    } catch (err) {
      item.state = "error";
      item.error = errText(err);
      toast(`Couldn't attach ${item.name}: ${item.error}`, "error");
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Suggestion chips: Add File, Upload File, Summarize
  // ---------------------------------------------------------------------------------------------
  function projectFiles() {
    const files = S.files || (T.state && T.state.project && T.state.project.files) || [];
    return Array.isArray(files) ? files : [];
  }
  const textFilePaths = () => projectFiles().filter((f) => f && f.type !== "dir" && f.text !== false && f.path).map((f) => fmtPath(f.path));

  async function refreshFiles() {
    try {
      const p = await T.api.get("/api/project");
      if (p && Array.isArray(p.files)) S.files = p.files;
    } catch (_) { /* keep what we have */ }
    return projectFiles();
  }

  function addContext(item) {
    const chat = ensureCurrent();
    const c = normContext([item])[0];
    if (!c) return;
    if (!chat.draft.context.some((x) => ctxLabel(x) === ctxLabel(c))) chat.draft.context.push(c);
    renderAttachments();
  }

  // "Add File": a small filterable picker of the project's text files.
  function pickFile(anchor) {
    if (S.pop && S.pop.anchor === anchor) { closePopover(); return; }
    openPopover(anchor, "chat-pop--files", (pop, close) => {
      const filter = h("input", { class: "chat-pop-filter", type: "text", placeholder: "Find a file…", "aria-label": "Find a file", spellcheck: "false" });
      const listEl = h("div", { class: "chat-pop-list", role: "listbox", "aria-label": "Project files" });
      pop.append(filter, listEl);
      let active = 0;
      let shown = [];
      const main = fmtPath(T.state && T.state.main);
      const choose = (path) => { close(); addContext({ path }); focusComposer(); };
      const paint = (loading) => {
        const q = filter.value.trim().toLowerCase();
        const all = textFilePaths().sort((a, b) => (a === main ? -1 : b === main ? 1 : a.localeCompare(b)));
        shown = (q ? all.filter((p) => p.toLowerCase().includes(q)) : all).slice(0, 200);
        active = clamp(active, 0, Math.max(0, shown.length - 1));
        listEl.textContent = "";
        if (!shown.length) {
          listEl.append(h("div", { class: "chat-pop-empty", text: loading ? "Loading files…" : q ? "No matching files" : "No text files in this project" }));
          return;
        }
        shown.forEach((p, i) => {
          const slash = p.lastIndexOf("/");
          const ic = /\.(tex|ltx|sty|cls)$/i.test(p) ? "file-tex" : /\.bib$/i.test(p) ? "file-bib" : "file";
          listEl.append(h("button", { class: "chat-pop-item" + (i === active ? " is-active" : ""), type: "button", role: "option", "aria-selected": String(i === active), title: p, onclick: () => choose(p), onmousemove: () => { if (active !== i) { active = i; mark(); } } },
            h("span", { class: "chat-pop-ic", html: icon(ic, 15) }),
            h("span", { class: "chat-pop-label", text: slash >= 0 ? p.slice(slash + 1) : p }),
            slash >= 0 ? h("span", { class: "chat-pop-hint", text: p.slice(0, slash) }) : null));
        });
      };
      const mark = () => Array.from(listEl.children).forEach((el, i) => {
        el.classList.toggle("is-active", i === active);
        el.setAttribute("aria-selected", String(i === active));
        if (i === active) el.scrollIntoView({ block: "nearest" });
      });
      filter.addEventListener("input", () => { active = 0; paint(); });
      filter.addEventListener("keydown", (e) => {
        if (e.isComposing || e.keyCode === 229) return; // WebKit: the IME's own Enter/arrows
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          if (!shown.length) return;
          active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
          mark();
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (shown[active]) choose(shown[active]);
        }
      });
      const hadFiles = textFilePaths().length > 0;
      paint(!hadFiles);
      setTimeout(() => filter.focus(), 0);
      refreshFiles().then(() => { if (pop.isConnected) { paint(false); reposition(); } });
    });
  }

  // "Upload File": copy files into the project (images into figures/) and attach them as context.
  function chooseUploads() {
    const input = h("input", { type: "file", multiple: true, hidden: true });
    input.addEventListener("change", async () => {
      const files = Array.from(input.files || []);
      input.remove();
      for (const f of files) await uploadToProject(f);
    });
    E.panel.append(input);
    input.click();
  }

  function safeName(name) {
    const n = String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim();
    return n || "upload";
  }

  function uniquePath(path) {
    const taken = new Set(projectFiles().map((f) => fmtPath(f.path)).concat(Array.from(S.uploaded)));
    if (!taken.has(path)) return path;
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    const stem = dot > slash + 1 ? path.slice(0, dot) : path;
    const ext = dot > slash + 1 ? path.slice(dot) : "";
    for (let i = 2; i < 1000; i++) if (!taken.has(`${stem}-${i}${ext}`)) return `${stem}-${i}${ext}`;
    return `${stem}-${Date.now().toString(36)}${ext}`;
  }

  async function uploadToProject(file) {
    if (file.size > MAX_UPLOAD) { toast(`${file.name} is larger than 25 MB.`, "error"); return; }
    const chat = ensureCurrent();
    const isImage = /^image\//.test(file.type) || FIGURE_RE.test(file.name);
    const path = uniquePath((isImage ? "figures/" : "") + safeName(file.name));
    const pending = { path, uploading: true };
    S.uploaded.add(path);
    chat.draft.context.push(pending);
    renderAttachments();
    try {
      const data_base64 = await fileToBase64(file);
      const res = await T.api.post("/api/upload", { path, data_base64 });
      pending.path = fmtPath((res && res.path) || path);
      delete pending.uploading;
      S.uploaded.add(pending.path);
      if (pending.path !== safeName(file.name)) toast(`Uploaded ${file.name} as ${pending.path}`, "info");
    } catch (err) {
      chat.draft.context = chat.draft.context.filter((c) => c !== pending);
      S.uploaded.delete(path);
      toast(`Couldn't upload ${file.name}: ${errText(err)}`, "error");
    }
    if (S.current === chat) renderAttachments();
  }

  // ---------------------------------------------------------------------------------------------
  // History menu (↺)
  // ---------------------------------------------------------------------------------------------
  async function openHistory(anchor) {
    if (S.pop && S.pop.anchor === anchor) { closePopover(); return; }
    let rows = null;
    let error = "";
    try { rows = await list(); } catch (err) { error = errText(err); }
    const cur = S.current;
    const items = [{ label: "New chat", icon: "compose", onClick: () => newChat() }];
    if (rows && rows.length) {
      items.push("-");
      for (const r of rows.slice(0, 40)) {
        items.push({ label: r.title || "Untitled chat", hint: timeAgo(r.updated), icon: cur && r.id === cur.id ? "check" : "chat", onClick: () => openChat(r.id) });
      }
    } else if (error) {
      items.push("-", { label: "Couldn't load past chats — retry", icon: "refresh", onClick: () => openHistory(anchor) });
    } else {
      items.push("-", { label: "No past chats yet", icon: "history", onClick: () => {} });
    }
    if (cur && cur.messages.length) items.push("-", { label: "Delete this chat", icon: "trash", danger: true, onClick: () => deleteChat(cur) });
    if (T.app && typeof T.app.menu === "function") {
      T.app.menu(anchor, items.map((it) => (it === "-" ? it : { label: it.label, icon: it.icon, danger: it.danger, onClick: it.onClick })));
      return;
    }
    openPopover(anchor, "chat-pop--menu", (pop, close) => renderMenu(pop, items, close));
  }

  function renderMenu(pop, items, close) {
    const listEl = h("div", { class: "chat-pop-list", role: "menu" });
    for (const it of items) {
      if (it === "-") { listEl.append(h("div", { class: "chat-pop-sep", role: "separator" })); continue; }
      listEl.append(h("button", { class: "chat-pop-item" + (it.danger ? " is-danger" : ""), type: "button", role: "menuitem", onclick: () => { close(); if (it.onClick) it.onClick(); } },
        it.icon ? h("span", { class: "chat-pop-ic", html: icon(it.icon, 15) }) : null,
        h("span", { class: "chat-pop-label", text: it.label }),
        it.hint ? h("span", { class: "chat-pop-hint", text: it.hint }) : null));
    }
    pop.append(listEl);
    listEl.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const btns = Array.from(listEl.querySelectorAll(".chat-pop-item"));
      const i = btns.indexOf(document.activeElement);
      const next = btns[(i + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length];
      if (next) next.focus();
    });
    setTimeout(() => { const first = listEl.querySelector(".chat-pop-item"); if (first) first.focus({ preventScroll: true }); }, 0);
  }

  // A small popover that lives inside CHAT's own region (#chat-view or #dock-chat), positioned
  // fixed next to its anchor. Closes on Esc or an outside click; follows its anchor on resize.
  function openPopover(anchor, className, build) {
    closePopover();
    const host = S.mode === "dock" ? E.dock : E.full;
    const pop = h("div", { class: `chat-pop ${className || ""}` });
    host.append(pop);
    const onDown = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); } };
    const onResize = () => { if (anchor.isConnected && isVisible(anchor)) placePopover(pop, anchor); else close(); };
    function close(refocus) {
      if (!S.pop || S.pop.el !== pop) return;
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      pop.remove();
      S.pop = null;
      if (refocus && anchor.isConnected) anchor.focus({ preventScroll: true });
    }
    S.pop = { el: pop, anchor, close };
    build(pop, close);
    placePopover(pop, anchor);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    return S.pop;
  }
  function closePopover() { if (S.pop) S.pop.close(); }
  function reposition() { if (S.pop) placePopover(S.pop.el, S.pop.anchor); }

  function placePopover(pop, anchor) {
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 6;
    pop.style.maxHeight = "";
    pop.style.left = "0px";
    pop.style.top = "0px";
    const below = vh - r.bottom - gap - 8;
    const above = r.top - gap - 8;
    const up = below < 220 && above > below;
    const room = Math.max(120, Math.min(up ? above : below, 420));
    pop.style.maxHeight = `${room}px`;
    const pw = pop.offsetWidth;
    const ph = Math.min(pop.offsetHeight, room);
    // Keep the popover over CHAT's own column: right-align it with anchors on the right half of
    // the column (the dock header buttons), left-align it otherwise.
    const region = (pop.parentElement || document.body).getBoundingClientRect();
    const lo = region.width >= pw + 16 ? region.left + 8 : 8;
    const hi = region.width >= pw + 16 ? region.right - pw - 8 : vw - pw - 8;
    let left = r.left + r.width / 2 > region.left + region.width / 2 ? r.right - pw : r.left;
    left = clamp(left, lo, Math.max(lo, hi));
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(up ? r.top - gap - ph : r.bottom + gap)}px`;
    pop.classList.toggle("is-up", up);
  }

  // ---------------------------------------------------------------------------------------------
  // Dictation (webkitSpeechRecognition; the button is hidden when unavailable)
  // ---------------------------------------------------------------------------------------------
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

  function toggleDictation() {
    if (S.rec) { stopDictation(); return; }
    if (!SpeechRec) return;
    const rec = new SpeechRec();
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    const base = E.input.value;
    const sep = base && !/\s$/.test(base) ? " " : "";
    let finalText = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      E.input.value = base + sep + finalText + interim;
      autoGrow();
      updateComposer();
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") toast("Microphone access is blocked. Allow it in the browser to dictate.", "error");
      else if (e.error !== "no-speech" && e.error !== "aborted") toast(`Dictation stopped (${e.error}).`, "error");
    };
    rec.onend = () => {
      if (S.rec === rec) S.rec = null;
      E.btnMic.classList.remove("is-on");
      E.btnMic.title = "Dictate";
      E.btnMic.setAttribute("aria-label", "Dictate");
    };
    try {
      rec.start();
      S.rec = rec;
      E.btnMic.classList.add("is-on");
      E.btnMic.title = "Stop dictation";
      E.btnMic.setAttribute("aria-label", "Stop dictation");
      E.input.focus();
    } catch (err) {
      toast(`Couldn't start dictation: ${err.message || err}`, "error");
    }
  }

  function stopDictation() {
    if (!S.rec) return;
    const rec = S.rec;
    S.rec = null;
    try { rec.stop(); } catch (_) { /* already stopped */ }
    if (E.btnMic) E.btnMic.classList.remove("is-on");
  }

  // ---------------------------------------------------------------------------------------------
  // Scrolling
  // ---------------------------------------------------------------------------------------------
  function onThreadScroll() {
    const t = E.thread;
    S.stick = t.scrollHeight - t.scrollTop - t.clientHeight < 48;
    E.toBottom.hidden = S.stick || !(S.current && S.current.messages.length);
  }
  function scrollToBottom(force) {
    if (!E.thread) return;
    if (force) S.stick = true;
    E.thread.scrollTop = E.thread.scrollHeight;
    E.toBottom.hidden = true;
  }

  // ---------------------------------------------------------------------------------------------
  // Public: ask / attachSelection
  // ---------------------------------------------------------------------------------------------
  // Put text (and context/images) in front of the AI. With send (default) the message goes out
  // at once (queued if a reply is streaming) and the user's own draft is left untouched; with
  // send:false it is placed in the composer for editing.
  function ask(text, opts) {
    if (!S.inited) init();
    const o = opts || {};
    const chat = ensureCurrent();
    const context = normContext(o.context);
    const images = (Array.isArray(o.images) ? o.images : []).filter((p) => typeof p === "string" && p);
    if (S.mode === "dock" && S.dock.collapsed) setCollapsed(false);
    if (o.send === false) {
      E.input.value = String(text || "");
      for (const c of context) if (!chat.draft.context.some((x) => ctxLabel(x) === ctxLabel(c))) chat.draft.context.push(c);
      for (const p of images) chat.draft.images.push({ key: rid("i"), name: basename(p), path: fmtPath(p), preview: "", state: "done", error: "" });
      autoGrow();
      renderAttachments();
      focusComposer(true);
      return chat.id;
    }
    if (chat.loadError) {
      toast("This chat couldn't be loaded, so it can't take new messages. Retry loading it or start a new chat.", "error");
      return chat.id;
    }
    const msg = { chat, text: String(text || ""), context, images };
    if (chat.run || chat.loading) {
      S.queue.push(msg);
      toast("Your request will be sent when the current reply finishes.", "info");
    } else sendMessage(chat, msg);
    return chat.id;
  }

  // Add the editor selection as a context chip. Without an argument, the latest selection is used.
  function attachSelection(sel) {
    if (!S.inited) init();
    if (sel === undefined) { refreshSelection(); sel = S.selection; }
    const chat = ensureCurrent();
    if (S.mode === "dock" && S.dock.collapsed) setCollapsed(false);
    if (validSel(sel)) {
      const c = normContext([sel])[0];
      if (c && !chat.draft.context.some((x) => ctxLabel(x) === ctxLabel(c))) chat.draft.context.push(c);
      S.usedSelKey = selKey(sel);
      renderAttachments();
    }
    focusComposer(true);
    return validSel(sel);
  }

  function onSelection(sel) {
    S.selection = validSel(sel) ? sel : null;
    if (!S.selection) S.usedSelKey = ""; // selecting the same range again later attaches it again
    if (S.mode === "dock") renderAttachments();
  }

  // ---------------------------------------------------------------------------------------------
  // init
  // ---------------------------------------------------------------------------------------------
  function init() {
    if (S.inited) return T.chat;
    S.inited = true;
    E.full = document.getElementById("chat-view");
    E.dock = document.getElementById("dock-chat");
    if (!E.full || !E.dock) console.error("[chat] #chat-view or #dock-chat is missing from the page");
    if (!E.full) E.full = h("section", { id: "chat-view" });
    if (!E.dock) E.dock = h("div", { id: "dock-chat" });
    E.full.textContent = "";
    E.full.classList.add("chat-full");
    buildPanel();
    buildDock();
    loadDockPrefs();
    applyDock();
    if (!SpeechRec) E.btnMic.hidden = true;
    if (T.bus) {
      T.bus.on("editor:selection", onSelection);
      T.bus.on("edits:resolved", onEditsResolved);
      T.bus.on("settings:changed", () => updateEmpty());
    }
    setMode(S.mode);
    renderThread();
    renderAttachments();
    return T.chat;
  }

  T.chat = {
    init,
    newChat,
    openChat,
    list,
    setMode,
    ask,
    attachSelection,
    // Extra helpers:
    current: () => (S.current ? S.current.id : null),
    isBusy: () => !!(S.current && S.current.run),
    stop: () => stop(S.current),
    focus: () => { if (S.mode === "dock" && S.dock.collapsed) setCollapsed(false); focusComposer(true); },
    setCollapsed,
  };
})();
