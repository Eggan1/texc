# texc architecture

texc has three layers. Each one is small and works on its own.

```
texc.app (Swift, AppKit + WKWebView)       one window = one folder (or the Welcome screen)
   │  spawns per window, stdin pipe        handshake: TEXC_READY {json} on stdout
   ▼
server.py (Python stdlib HTTP server)      127.0.0.1 only, per-process token, one folder per process
   │  imports
   ▼
texc.py (CLI + build library)              latexmk front end: engine detection, log parsing, watch mode
```

The front end (`gui/`) is plain JavaScript with no build step. It runs in the app's WKWebView or in
any browser (`texc gui FOLDER`).

## 1. Files

| Path | What it is |
|---|---|
| `texc.py` | The CLI (`texc file.tex`, `-w`, `--clean`, `gui`, `new`, `app`, `install-app`) and the build library the server imports |
| `server.py` | The HTTP server: files, compiles, PDF, SyncTeX, AI bridge, Welcome screen, settings and state |
| `gui/index.html`, `gui/js/*.js`, `gui/css/*.css` | The workspace: editor (CodeMirror 5), PDF preview (PDF.js), AI chat, file drawer |
| `gui/welcome.html`, `gui/js/welcome.js`, `gui/css/welcome.css` | The Welcome screen: Recent folders, Open Folder, New Project, background image |
| `gui/js/api.js` | Event bus (`T.bus`), HTTP/SSE helpers (`T.api`), per-folder UI state (`T.store`) |
| `gui/js/host.js` | `T.host`: one API for the native app (bridge) and a plain browser |
| `gui/vendor/` | Bundled third-party libraries (see THIRD_PARTY_NOTICES.md) |
| `templates/` | New Project templates (`blank`, `article`) with `{{title}}` / `{{author}}` placeholders |
| `app/texc.swift`, `app/build.sh` | The macOS app shell and its build/install script |
| `app/test/` | Silent test tools: `auto.py`, `winprobe.swift`, `cdp.mjs`, `final_check.py` |
| `examples/demo/` | A small paper used for trying things out and for tests |

## 2. Processes

- `texc gui [PATH] [--port N] [--no-browser] [--app]`:
  - a folder PATH is project mode on that folder;
  - a `.tex` PATH is project mode with that main file;
  - no PATH uses the current folder if it has a main `.tex`, otherwise the Welcome screen ("lobby" mode).
- A server process is **either** the Welcome screen **or** one project folder for its whole life. Opening
  another folder means another process. The app replaces the window's process; a browser goes to a child server.
- `--app` is used by texc.app:
  - an ephemeral port, no browser;
  - one line on stdout once listening: `TEXC_READY {"url","port","pid","token","mode","folder","main","main_exists"}`;
  - `TEXC_READY {"already_open":true,"url":…}` if another texc already serves the folder;
  - `TEXC_ERROR {"error":…}` (exit 1) on failure;
  - the server exits when stdin reaches EOF (the app died) or on SIGTERM.
- One server per folder: `servers/<key>.json` in the config dir records the live server, so a second one
  defers to it. Paths are canonicalised (realpath plus the on-disk spelling on macOS).

## 3. HTTP API

Every `/api` route needs the session token, sent as the `X-Texc-Token` header or `?token=`, and a
`Host` of 127.0.0.1/localhost. The token is put into the served HTML page.

| Route | Mode | Purpose |
|---|---|---|
| `GET /api/project` | project | Files, main file (`main`, `main_exists`), settings, providers, last compile, `ui_state` |
| `GET/PUT /api/file` | project | Read/write a project file (`base_mtime` conflict check → 409) |
| `POST /api/file/new`, `/rename`, `/delete` | project | File operations (delete moves to `.texc/trash`) |
| `POST /api/upload`, `GET /api/raw` | project | Uploads and raw file access |
| `POST /api/main` | project | Choose the main `.tex` |
| `POST /api/compile`, `/api/compile/cancel` | project | Build with latexmk; result `{ok, errors, warnings, notes, no_main?}` |
| `GET /api/pdf`, `/api/log` | project | Latest PDF and log |
| `GET /api/synctex/edit`, `/view` | project | PDF ↔ source jumps |
| `GET /api/events` | both | Server-sent events: `hello`, `files`, `file`, `compile-start`, `compile` |
| `GET/PUT /api/settings` | both | Global settings (provider, model, font size, autosave) |
| `GET /api/chats`, `/api/chats/<id>` | project | Saved chats in `.texc/chats/` |
| `POST /api/ai`, `/api/ai/cancel` | project | AI request streamed as SSE: `status`, `delta`, `notice`, `done`, `error` |
| `GET /api/arxiv`, `POST /api/cite` | project | Literature search and BibTeX entries |
| `POST /api/wordcount`, `/api/open-pdf`, `/api/clean` | project | Tools |
| `GET /api/lobby`, `POST /api/lobby/new` | lobby | Welcome data (recent, templates, defaults, tools, background); create a project |
| `GET/POST /api/lobby/background` | lobby | Welcome background image: `{data: base64}`, `{opacity}`, `{clear: true}` |
| `GET /api/recent`, `POST /api/recent/forget` | both | Recent folders |
| `POST /api/ui-state` | project | Per-folder UI state `{set:{k:v}, remove:[k]}` |
| `POST /api/scaffold`, `/api/reveal` | project | Create main.tex from a template; show in Finder |
| `POST /api/pick`, `/api/open-folder` | both (browser only) | macOS folder chooser; start or reuse a child server for a folder |

## 4. AI

- **Claude Code (default):**
  - Runs `claude -p --output-format stream-json --verbose --include-partial-messages --tools "" --strict-mcp-config --no-session-persistence --system-prompt …`.
  - The prompt goes on stdin.
  - Claude Code session variables are stripped from the child environment.
- **Codex (optional):** `codex exec --json --ephemeral -s read-only`.
- **Edits:** the model answers with SEARCH/REPLACE blocks. The editor applies them as inline red/green hunks with **Keep ⌥Y / Undo ⌥N**.
- **Offline:** network failures turn into a friendly "Can't reach Claude" message. Editing and compiling don't need the internet.

## 5. Front end

- **Plain scripts:** classic `<script>` files attach modules to `window.T`:
  - `T.bus`, `T.api`, `T.store` and `T.host`;
  - `T.editor`, `T.pdf`, `T.chat` and `T.app`.
- **State:** `T.store` keeps per-folder UI state (split, tabs, zoom) on the server, so it survives the app's changing ports.
- **`T.host` (host.js):** works both in the app and in a browser:
  - `pickFolder`, `openFolder`, `closeFolder`, `newWindow`, `reveal`, `openExternal`, `notify`;
  - `on(cmd, fn)` for native menu commands;
  - `onBeforeClose(fn)`; any `false` cancels closing or switching folders.
- **Bridge, page → app:** `window.webkit.messageHandlers.texc.postMessage({cmd, …})` takes these commands:
  `pickFolder`, `openFolder`, `closeFolder`, `newWindow`, `newProject`, `openExternal`, `reveal`, `state`.
- **Bridge, app → page:** `T.host._native(cmd, arg)` with `beforeClose`, `newProject`, `settings`, `closeTab`, `undo`, `redo`.

## 6. The macOS app (`app/texc.swift`)

- **Windows:** each one has a WKWebView and its own child server, launched as `/usr/bin/python3 texc.py gui [FOLDER] --app`.
  - Finder-launched apps get a minimal `PATH`, so the app builds `PATH` from the build-time `PATH` plus the usual TeX and Homebrew folders.
- **Menus:** File (New Project ⌘N, New Window ⇧⌘N, Open Folder ⌘O, Open Recent, Close Tab ⌘W, Close Window ⇧⌘W,
  Close Folder, Reveal in Finder ⌥⌘R), plus a standard Edit menu. The page keeps ⌘S, ⌘F, ⌘K, ⌘↵, ⌥Y and ⌥N.
- **Closing, quitting and reloading:** each one asks the page first (`beforeClose`), so unreviewed AI edits are never dropped
  silently. Closing then stops the window's server (SIGTERM, then SIGKILL after a grace period).
- **Delegates:** external links open in the default browser. Downloads use a Save panel, and `<input type=file>` uses an Open panel.
- **Building:** `app/build.sh` compiles with `swiftc` (Command Line Tools are enough), draws the icon, ad-hoc signs, and
  installs to `~/Applications/texc.app`. Set `TEXC_BUILD_QUIT=1` to ask a running copy to quit.

## 7. Settings and state

Everything lives in `~/.config/texc/`, or `$TEXC_CONFIG_DIR` if set. Nothing goes into the project folder except its `.texc/` build folder:
- `settings.json`;
- `recent.json`;
- `ui-state/<key>.json`;
- `servers/<key>.json`;
- `welcome-background.*`.

`<key>` = `sha1(canonical folder path)[:16]`.

## 8. Testing without disturbing the desktop

The app has an automation mode (`--automation DIR --config-dir DIR`) that runs completely silently:
- **Windows:** kept off-screen, with no Dock icon and no focus changes.
- **Panels:** never shown; stage `pick` and `save` first.
- **External opens:** recorded instead of performed. Servers get `TEXC_SILENT=1`.

Run it through the tools in `app/test/`:
- `auto.py launch AUTODIR CONFIGDIR` and `auto.py cmd AUTODIR '<json>'`. Commands: `windows`, `open`, `lobby`, `eval`, `snapshot`, `key`, `menu`, `pasteboard`, `pick`, `save`, `close`, `quit`, `events`.
- `winprobe PID` checks that no window is visible. Build it with `swiftc -O app/test/winprobe.swift -o app/test/winprobe`.
- `node cdp.mjs URL --eval '…' --shot out.png` drives headless Chrome for browser-mode checks.
- `python3 app/test/final_check.py` is the end-to-end acceptance check.
