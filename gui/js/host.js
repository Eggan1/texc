/* texc host bridge: one API for the texc Mac app (native shell) and a plain browser. See docs/ARCHITECTURE.md. */
(function () {
  "use strict";
  const T = (window.T = window.T || {});
  const mh = window.webkit && window.webkit.messageHandlers;
  const bridge = mh && mh.texc ? mh.texc : null;
  const handlers = new Map();   // native menu command -> fn(arg)
  const closers = [];           // fns run before the window closes or changes folder

  // JS -> native. Resolves with the shell's reply (WKScriptMessageHandlerWithReply).
  function call(cmd, args) {
    if (!bridge) return Promise.reject(Object.assign(new Error("Not running in the texc app"), { code: "not_native" }));
    try {
      return Promise.resolve(bridge.postMessage(Object.assign({ cmd }, args || {})));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  // Runs every beforeClose handler in order; any `false` cancels. Then flushes UI state.
  // A second request while one runs (⌘Q during a ⌘W confirm) shares it instead of stacking dialogs.
  let closing = null;
  function runBeforeClose() {
    return closing || (closing = runBeforeCloseOnce().finally(() => { closing = null; }));
  }
  async function runBeforeCloseOnce() {
    for (const fn of closers.slice()) {
      try {
        if ((await fn()) === false) return false;
      } catch (e) {
        console.error("[host] beforeClose handler failed", e);
      }
    }
    try { if (T.store && T.store.flush) await T.store.flush(); } catch (_) { /* best effort */ }
    return true;
  }

  T.host = {
    native: !!bridge,
    lobbyUrl: null,   // browser mode: the Welcome page that started this server (set from /api/project)
    call,

    // Absolute folder path, or null if cancelled. Rejects with err.code "no_picker" when no
    // picker works (browser mode without the macOS chooser), so the caller can ask for a typed path.
    async pickFolder(prompt) {
      if (bridge) {
        const p = await call("pickFolder", { prompt: prompt || "" });
        return typeof p === "string" && p ? p : null;
      }
      let r;
      try {
        r = await T.api.post("/api/pick", { kind: "folder", prompt: prompt || "Choose a folder" });
      } catch (e) {
        throw Object.assign(new Error(e.message || "No folder picker available"), { code: "no_picker", cause: e });
      }
      return r && typeof r.path === "string" && r.path ? r.path : null;
    },

    // App: this window (or a new one) switches to the folder; the shell asks beforeClose first.
    // Browser: a server for that folder is started (or reused) and this tab goes there.
    async openFolder(path, opts) {
      opts = opts || {};
      if (!path) return false;
      if (bridge) return call("openFolder", { path: String(path), newWindow: !!opts.newWindow });
      if (!(await runBeforeClose())) return false;
      const r = await T.api.post("/api/open-folder", { path: String(path) });
      if (r && r.url) { location.assign(r.url); return true; }
      return false;
    },

    // Back to the Welcome screen. Browser mode only works when a Welcome page started us.
    get canCloseFolder() { return !!bridge || !!T.host.lobbyUrl; },
    async closeFolder() {
      if (bridge) return call("closeFolder", {});
      if (!T.host.lobbyUrl) return false;
      if (!(await runBeforeClose())) return false;
      location.assign(T.host.lobbyUrl);
      return true;
    },

    newWindow(path) {
      if (!bridge) return Promise.resolve(false);
      return call("newWindow", path ? { path: String(path) } : {});
    },

    // Finder: project-relative path, or "" for the folder itself (server does it in both modes).
    reveal(path) { return T.api.post("/api/reveal", { path: path || "" }); },

    openExternal(url) {
      if (bridge) return call("openExternal", { url: String(url) });
      window.open(String(url), "_blank", "noopener");
      return Promise.resolve(true);
    },

    // Tell the shell what this window shows (title bar, proxy icon, Open Recent).
    notify(state) {
      if (!bridge) return Promise.resolve(false);
      return call("state", state || {}).catch(() => false);
    },

    // Native menu commands (see: T.host.on("settings", fn). fn may return a value or a Promise.
    on(cmd, fn) { handlers.set(cmd, fn); return () => { if (handlers.get(cmd) === fn) handlers.delete(cmd); }; },
    onBeforeClose(fn) {
      closers.push(fn);
      return () => { const i = closers.indexOf(fn); if (i >= 0) closers.splice(i, 1); };
    },
    runBeforeClose,

    // native -> JS entry point (the shell uses callAsyncJavaScript). Returns true/false, or null
    // when nothing here handles `cmd`.
    async _native(cmd, arg) {
      if (cmd === "beforeClose") return runBeforeClose();
      const fn = handlers.get(cmd);
      if (!fn) return null;
      const r = await fn(arg);
      return r === undefined ? true : r;
    },
  };
})();
