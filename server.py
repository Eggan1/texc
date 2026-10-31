#!/usr/bin/env python3
"""texc GUI server: a local, single-user HTTP server for the texc LaTeX workspace.

It serves the browser front-end in ./gui, a JSON API over one project folder (files, compile,
SyncTeX, chats, settings, arXiv, citations, word count), a Server-Sent Events channel for
file-system and compile events, and a streaming bridge to the Claude Code and Codex CLIs.

Run it through `texc gui [FOLDER | file.tex] [--app]`, or standalone for testing:

    python3 server.py [FOLDER | path/to/main.tex] [--port N] [--no-browser] [--app]

A process serves exactly one of: a lobby (the Welcome screen, no folder) or one project folder.
--app is how texc.app runs it: an ephemeral port, one `TEXC_READY {...}` (or `TEXC_ERROR {...}`)
line on stdout, logs on stderr, and a clean exit when stdin reaches EOF. The config dir
($TEXC_CONFIG_DIR or ~/.config/texc) holds settings.json, recent.json, ui-state/ and servers/.

Security model: binds 127.0.0.1 only, rejects foreign Host headers (DNS rebinding), and
requires a random per-run token on every /api/* request. Python standard library only
(3.9+). See docs/ARCHITECTURE.md sections 3 and 4 and docs/ARCHITECTURE.md sections 2 and 3.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import hmac
import importlib.util
import inspect
import json
import os
import posixpath
import queue
import re
import secrets
import select
import shlex
import shutil
import signal
import socket
import stat as statmod
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET
from contextlib import contextmanager, nullcontext
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    import fcntl                   # cross-process locks for recent.json and servers/<key>.json
except ImportError:                # pragma: no cover (not macOS/Linux)
    fcntl = None
try:
    import pwd
except ImportError:                # pragma: no cover
    pwd = None

HERE = Path(__file__).resolve().parent
GUI_DIR = HERE / "gui"
DEFAULT_PORT = 8765

# App mode (docs/ARCHITECTURE.md): config dir, Recent list, per-folder UI state, one server per folder.
RECENT_MAX = 30
UI_STATE_CAP = 512 * 1024
UI_KEY_MAX = 200
HANDSHAKE_TIMEOUT_S = 20
NO_MAIN_NOTE = "This folder has no main .tex file yet."
NO_FOLDER = "No folder is open."
MAIN_EXTS = ("tex", "ltx")

BUILD_DIR = ".texc"
TEXT_EXTS = frozenset(
    "tex ltx sty cls bst bib bbx cbx lbx def cfg dtx ins txt md tikz csv dat json yaml yml lua py r m".split())
IMAGE_EXTS = frozenset("png jpg jpeg gif webp".split())
ENGINES = ("pdf", "xe", "lua")
SKIP_DIRS = frozenset(("node_modules", "__pycache__"))

MAX_LISTING = 3000                 # /api/project file list
MAX_WATCHED = 20000                # watcher stops scanning past this many entries
MAX_BODY = 40 * 1024 * 1024        # request bodies (a 25 MB upload is ~34 MB of base64)
MAX_UPLOAD = 25 * 1024 * 1024
MAX_TEXT_READ = 20 * 1024 * 1024
WATCH_BINARY_LIMIT = 50 * 1024 * 1024
HASH_LIMIT = 20 * 1024 * 1024
SSE_PING_S = 15
AI_TIMEOUT_S = 600
# Connection-level failures (no HTTP status) after which a claude run stops retrying and reports
# the offline error (the CLI's own 10 retries take ~3 minutes; attempt 4 comes ~4 s in).
CLAUDE_OFFLINE_AFTER = 4
PROMPT_TOTAL_CAP = 300 * 1024
PROMPT_BIB_CAP = 40 * 1024
PROMPT_CONTEXT_CAP = 100 * 1024
HISTORY_TURNS = 12
HISTORY_TURN_CAP = 6 * 1024

CLAUDE_MODELS = ["default", "opus", "sonnet", "haiku"]
EFFORTS = ("low", "medium", "high")
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,99}$")
CHAT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,100}$")
BIB_KEY_RE = re.compile(r"^[^\s,{}()=\"#%'\\~]{1,200}$")

SYSTEM_PROMPT = """You are the AI assistant built into texc, a local LaTeX editor. You help researchers
write, revise and debug LaTeX papers. The project's files are included below.
Reply in GitHub-flavoured Markdown. Write math as $...$ or $$...$$ (it is rendered with KaTeX).
When the user asks for a change to the document, or a change is clearly the right answer
(fixing a compile error, proofreading, inserting a figure), make it with edit blocks:

<<<<<<< SEARCH path/relative/to/project.tex
exact text copied from the current file
=======
replacement text
>>>>>>> REPLACE

Rules for edit blocks:
- SEARCH must match the file exactly, including whitespace. Keep it short but unique.
- Prefer several small blocks to one large block. Never put edit blocks inside code fences.
- To create a new file, leave the SEARCH section empty.
- After the blocks, say in one or two sentences what you changed.
Do not run commands or use tools."""

STATIC_MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".bmp": "image/bmp",
    ".tif": "image/tiff", ".tiff": "image/tiff", ".pdf": "application/pdf",
    ".eps": "application/postscript", ".ps": "application/postscript",
    ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
    ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm",
}

TOOL_DIRS = ("~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/Library/TeX/texbin", "/usr/bin", "/bin")


# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------

def silent() -> bool:
    """TEXC_SILENT=1 (texc.app's automation mode, tests): never open Finder, Preview, a browser
    or a dialog on the user's screen."""
    return os.environ.get("TEXC_SILENT") == "1"


def log(msg: str) -> None:
    try:
        print(f"texc: {msg}", file=sys.stderr, flush=True)
    except (OSError, ValueError):
        pass


class ApiError(Exception):
    """An error that becomes a JSON {"error": message, **extra} reply with the given status."""

    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


@contextmanager
def fs_errors():
    """Turn file-system exceptions into readable API errors."""
    try:
        yield
    except ApiError:
        raise
    except FileNotFoundError as e:
        raise ApiError(404, f"Not found: {e.filename or 'file'}")
    except FileExistsError as e:
        raise ApiError(409, f"Already exists: {e.filename or 'file'}")
    except IsADirectoryError:
        raise ApiError(400, "That path is a folder.")
    except NotADirectoryError:
        raise ApiError(400, "A parent of that path is a file, not a folder.")
    except PermissionError:
        raise ApiError(403, "Permission denied.")
    except OSError as e:
        raise ApiError(500, f"File system error: {e.strerror or e}")


def ext_of(path) -> str:
    return os.path.splitext(str(path))[1][1:].lower()


def is_text_path(path) -> bool:
    return ext_of(path) in TEXT_EXTS


def nbytes(s: str) -> int:
    return len(s.encode("utf-8", "replace"))


def cap_bytes(s: str, limit: int, note: str = "\n[… truncated]") -> str:
    data = s.encode("utf-8", "replace")
    if len(data) <= limit:
        return s
    return data[:limit].decode("utf-8", "ignore") + note


def fence(text: str, lang: str = "latex") -> str:
    """A Markdown code fence that can't be closed early by backticks inside the text."""
    ticks = "```"
    while ticks in text:
        ticks += "`"
    return f"{ticks}{lang}\n{text.rstrip(chr(10))}\n{ticks}"


def to_int(v, default: int = 0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def jsonable(v):
    if isinstance(v, Path):
        return str(v)
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set)):
        return [jsonable(x) for x in v]
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    return str(v)


def sse_bytes(name: str, data) -> bytes:
    payload = json.dumps(jsonable(data), ensure_ascii=False, separators=(",", ":"))
    return f"event: {name}\ndata: {payload}\n\n".encode("utf-8")


def file_digest(path) -> bytes | None:
    try:
        if os.stat(path).st_size > HASH_LIMIT:
            return None
        h = hashlib.blake2b(digest_size=16)
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.digest()
    except OSError:
        return None


def atomic_write(path, data: bytes) -> Path:
    """Write via a temp file + rename in the target's folder; keeps the file mode and writes
    through a symlink to its (already validated) target."""
    target = Path(os.path.realpath(path))
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        mode = statmod.S_IMODE(os.stat(target).st_mode)
    except FileNotFoundError:
        mode = 0o644
    fd, tmp = tempfile.mkstemp(prefix=".texc-", suffix=".tmp", dir=str(target.parent))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return target


def find_tool(name: str, env_var: str | None = None) -> str | None:
    """Locate an executable even when the server was started with a minimal PATH."""
    if env_var and os.environ.get(env_var):
        p = os.path.expanduser(os.environ[env_var])
        return p if os.path.isfile(p) and os.access(p, os.X_OK) else None
    found = shutil.which(name)
    if found:
        return found
    dirs = list(TOOL_DIRS)
    if name == "claude":
        dirs.append("~/.claude/local")
    if name == "codex":
        dirs.append("~/.codex/packages/standalone/current/bin")
    for d in dirs:
        cand = os.path.join(os.path.expanduser(d), name)
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None


_codex_models_cache: dict = {"stamp": None, "models": ["gpt-6-luna"]}


def codex_models() -> list[str]:
    """Slugs from ~/.codex/models_cache.json with visibility "list", in file order."""
    home = Path(os.environ.get("CODEX_HOME") or (Path.home() / ".codex"))
    path = home / "models_cache.json"
    try:
        st = path.stat()
    except OSError:
        return ["gpt-6-luna"]
    stamp = (st.st_mtime_ns, st.st_size)
    if _codex_models_cache["stamp"] == stamp:
        return list(_codex_models_cache["models"])
    slugs: list[str] = []
    try:
        data = json.loads(path.read_text("utf-8"))
        for m in data.get("models", []) if isinstance(data, dict) else []:
            if isinstance(m, dict) and m.get("visibility") == "list" and isinstance(m.get("slug"), str) and m["slug"]:
                if m["slug"] not in slugs:
                    slugs.append(m["slug"])
    except (OSError, ValueError):
        slugs = []
    slugs = slugs or ["gpt-6-luna"]
    _codex_models_cache.update(stamp=stamp, models=slugs)
    return list(slugs)


def ai_providers() -> list[dict]:
    models = codex_models()
    return [
        {"id": "claude", "label": "Claude Code", "available": find_tool("claude", "TEXC_CLAUDE") is not None,
         "models": list(CLAUDE_MODELS), "default_model": "default"},
        {"id": "codex", "label": "Codex", "available": find_tool("codex", "TEXC_CODEX") is not None,
         "models": models, "default_model": models[0], "efforts": list(EFFORTS)},
    ]


def child_env() -> dict:
    """os.environ minus Claude Code session variables (they would leak this session's sockets
    into the child), with the usual tool folders on PATH."""
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("CLAUDE_CODE_") and k not in ("CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT")}
    parts = [p for p in env.get("PATH", "").split(os.pathsep) if p]
    for d in ("~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/Library/TeX/texbin"):
        d = os.path.expanduser(d)
        if d not in parts and os.path.isdir(d):
            parts.append(d)
    env["PATH"] = os.pathsep.join(parts)
    return env


COMMENT_RE = re.compile(r"(?<!\\)%.*")


def strip_comments(text: str) -> str:
    return COMMENT_RE.sub("", text)


# ---------------------------------------------------------------------------------------------
# Config dir (docs/ARCHITECTURE.md): settings.json, recent.json, ui-state/<key>.json, servers/<key>.json.
# Writes are atomic; a corrupt or missing file reads as empty.
# ---------------------------------------------------------------------------------------------

def config_dir() -> Path:
    env = os.environ.get("TEXC_CONFIG_DIR")
    return Path(os.path.expanduser(env)) if env else Path.home() / ".config" / "texc"


# The Welcome screen's background image ("theme"): <config>/welcome-background.<ext> plus
# welcome-background.json {file, opacity}. Any image the user picks; nothing ships by default.
BG_MAX = 20 * 1024 * 1024
BG_EXTS = ("png", "jpg", "gif", "webp")
BG_DEFAULT_OPACITY = 0.35


@contextmanager
def fs_errors_quiet():
    """Ignore OSError (a file that is already gone)."""
    try:
        yield
    except OSError:
        pass


def background_kind(data: bytes):
    """png/jpg/gif/webp from the file's magic bytes, or None."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def background_state():
    """{"path", "opacity", "version"} for the current background image, or None."""
    meta = read_json_file(config_dir() / "welcome-background.json", {})
    name = meta.get("file") if isinstance(meta, dict) else None
    if not isinstance(name, str) or not re.fullmatch(r"welcome-background\.(png|jpg|gif|webp)", name):
        return None
    path = config_dir() / name
    try:
        st = path.stat()
    except OSError:
        return None
    try:
        opacity = float(meta.get("opacity", BG_DEFAULT_OPACITY))
    except (TypeError, ValueError):
        opacity = BG_DEFAULT_OPACITY
    return {"path": path, "opacity": min(1.0, max(0.05, opacity)), "version": st.st_mtime_ns // 1_000_000}


def background_public():
    st = background_state()
    return {"version": st["version"], "opacity": st["opacity"]} if st else None


def canonical_path(p) -> str:
    """realpath, spelled the way the disk spells it. On macOS, realpath keeps whatever case and
    Unicode normalisation was typed (APFS is case- and normalisation-insensitive), so ~/desktop/X
    and ~/Desktop/x would otherwise count as two folders: two servers, two Recent rows."""
    real = os.path.realpath(os.path.expanduser(str(p)))
    if sys.platform == "darwin" and fcntl is not None and hasattr(fcntl, "F_GETPATH"):
        try:
            fd = os.open(real, os.O_RDONLY)
        except OSError:
            return real
        try:
            got = os.fsdecode(fcntl.fcntl(fd, fcntl.F_GETPATH, bytes(1024)).split(b"\0", 1)[0])
            if got.startswith("/"):
                return got
        except OSError:
            pass
        finally:
            os.close(fd)
    return real


def folder_key(root) -> str:
    """sha1(canonical root).hexdigest()[:16]: names the folder's ui-state and servers files."""
    return hashlib.sha1(os.fsencode(canonical_path(root))).hexdigest()[:16]


def read_json_file(path: Path, default):
    """The parsed file, or `default` when it is missing, unreadable, or not default's JSON type."""
    try:
        with open(path, "rb") as f:
            data = json.loads(f.read(16 * 1024 * 1024).decode("utf-8"))
    except (OSError, ValueError):
        return default
    return data if isinstance(data, type(default)) else default


def write_json_file(path: Path, obj, indent=None) -> None:
    text = json.dumps(jsonable(obj), ensure_ascii=False, indent=indent) + "\n"
    atomic_write(path, text.encode("utf-8"))


@contextmanager
def file_lock(path: Path, timeout: float = 5.0):
    """An advisory lock shared by all texc processes (flock). Best effort: if the lock can't be
    taken within `timeout` (or at all), the body runs unlocked rather than hanging."""
    fd = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o644)
    except OSError:
        fd = None
    if fd is not None and fcntl is not None:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    log(f"couldn't lock {path}; going on without the lock")
                    break
                time.sleep(0.02)
            except OSError:
                break
    try:
        yield
    finally:
        if fd is not None:
            try:
                os.close(fd)            # closing the descriptor releases the flock
            except OSError:
                pass


def display_path(p: str) -> str:
    home = str(Path.home())
    if p == home or p.startswith(home + "/"):
        return "~" + p[len(home):]
    return p


class RecentStore:
    """recent.json: {"version":1,"recent":[{"path","opened","main"}]}, newest first, at most 30,
    de-duplicated by realpath (only realpaths are stored). Never pruned automatically: an
    unplugged drive comes back, so `exists` is computed when the list is read."""

    def __init__(self, folder: Path):
        self.path = folder / "recent.json"
        self.lock_path = folder / "recent.lock"
        self.lock = threading.Lock()

    def entries(self) -> list:
        data = read_json_file(self.path, {})
        raw = data.get("recent")
        out, seen = [], set()
        for e in raw if isinstance(raw, list) else []:
            if not isinstance(e, dict):
                continue
            p = e.get("path")
            if not isinstance(p, str) or not p.startswith("/") or "\x00" in p or p in seen:
                continue
            seen.add(p)
            opened = e.get("opened")
            if isinstance(opened, bool) or not isinstance(opened, (int, float)):
                opened = 0
            main = e.get("main")
            out.append({"path": p, "opened": opened, "main": main if isinstance(main, str) and main else None})
        return out[:RECENT_MAX]

    def _write(self, items: list) -> None:
        try:
            write_json_file(self.path, {"version": 1, "recent": items[:RECENT_MAX]}, indent=1)
        except OSError as e:
            log(f"couldn't save {self.path}: {e}")

    def touch(self, root: str, main) -> None:
        """Add or refresh a folder at the top (a project server does this at startup)."""
        with self.lock, file_lock(self.lock_path):
            items = [e for e in self.entries() if e["path"] != root]
            items.insert(0, {"path": root, "opened": int(time.time()), "main": main})
            self._write(items)

    def set_main(self, root: str, main) -> None:
        with self.lock, file_lock(self.lock_path):
            items = self.entries()
            for e in items:
                if e["path"] == root:
                    if e["main"] != main:
                        e["main"] = main
                        self._write(items)
                    return

    def remembered_main(self, root: str):
        for e in self.entries():
            if e["path"] == root:
                return e["main"]
        return None

    def forget(self, path: str) -> None:
        p = os.path.expanduser(path)
        cands = {path, p, os.path.normpath(p)}
        try:
            cands.add(os.path.realpath(p))
            cands.add(canonical_path(p))
        except (OSError, ValueError):
            pass
        with self.lock, file_lock(self.lock_path):
            items = self.entries()
            kept = [e for e in items if e["path"] not in cands]
            if len(kept) != len(items):
                self._write(kept)

    def public(self) -> list:
        out = []
        for e in self.entries():
            p = e["path"]
            out.append({"path": p, "name": os.path.basename(p.rstrip("/")) or p, "display": display_path(p),
                        "opened": e["opened"], "exists": os.path.isdir(p), "main": e["main"]})
        return out


class UiStateStore:
    """ui-state/<key>.json: a flat {string: string} map of the workspace's UI state for one
    folder (it survives the app's changing ports). Keys ≤200 chars; past 512 KB the largest
    values are dropped."""

    def __init__(self, folder: Path, key: str):
        self.path = folder / "ui-state" / f"{key}.json"
        self.lock = threading.Lock()

    def get(self) -> dict:
        data = read_json_file(self.path, {})
        return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}

    def update(self, set_: dict, remove: list) -> None:
        with self.lock:
            state = self.get()
            before = dict(state)
            for k in remove:
                if isinstance(k, str):
                    state.pop(k, None)
            for k, v in set_.items():
                if isinstance(k, str) and 0 < len(k) <= UI_KEY_MAX and isinstance(v, str):
                    state[k] = v
            size = nbytes(json.dumps(state, ensure_ascii=False))
            if size > UI_STATE_CAP:          # drop the largest values first (one pass, not quadratic)
                for k in sorted(state, key=lambda k: len(state[k]), reverse=True):
                    if size <= UI_STATE_CAP:
                        break
                    size -= nbytes(json.dumps(k, ensure_ascii=False)) + nbytes(json.dumps(state.pop(k), ensure_ascii=False)) + 4
            if state != before:
                write_json_file(self.path, state)


def pid_alive(pid) -> bool:
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:          # alive, but another user's process
        return True
    except OSError:
        return False
    return True


def port_open(port: int, timeout: float = 0.3) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def servers_file(key: str) -> Path:
    return config_dir() / "servers" / f"{key}.json"


def pid_is_texc(pid) -> bool:
    """Whether pid's command line is a texc server (a stale record's pid may have been reused)."""
    try:
        cmd = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True,
                             timeout=2, stdin=subprocess.DEVNULL).stdout
    except (OSError, subprocess.SubprocessError):
        return True                  # can't tell: trust the pid + port checks as before
    return "texc" in cmd


def live_server(key: str):
    """The servers/<key>.json record if it names another live texc server, else None."""
    rec = read_json_file(servers_file(key), {})
    pid, url = rec.get("pid"), rec.get("url")
    if not isinstance(url, str) or pid == os.getpid() or not pid_alive(pid) or not pid_is_texc(pid):
        return None
    try:
        port = urllib.parse.urlsplit(url).port
    except ValueError:
        return None
    return rec if port and port_open(port) else None


# Network-looking failures of the AI CLIs (docs/ARCHITECTURE.md).
OFFLINE_RE = re.compile(r"ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|getaddrinfo|fetch failed|"
                        r"Could not resolve host|Connection error|network|offline", re.I)


def offline_error(provider: str, data: dict) -> dict:
    """An AI `error` event whose message looks like a network failure becomes the friendly
    offline message with code "offline" (the original text is kept as `detail`)."""
    msg = str(data.get("message") or "")
    if data.get("code") == "offline" or not OFFLINE_RE.search(msg):
        return data
    name = "Codex" if provider == "codex" else "Claude"
    out = dict(data)
    out.update(message=f"Can't reach {name} — check your internet connection. Editing and compiling still work offline.",
               code="offline", detail=msg[-2000:])
    return out


def applescript_quote(s: str) -> str:
    """An AppleScript string literal for s: control characters become spaces; \\ and " are escaped."""
    s = "".join(ch if ch >= " " and ch != "\x7f" else " " for ch in s)
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def scan_interval(scan_s: float) -> float:
    """Seconds before the next watcher scan: 1 s; after a slow scan (over 100 ms, a big folder)
    10× the scan time, between 1 and 5 s."""
    if scan_s <= 0.1:
        return 1.0
    return min(5.0, max(1.0, 10.0 * scan_s))


def fallback_author() -> str:
    """The macOS full name (pwd gecos), else `git config user.name`, else ""."""
    if pwd is not None:
        try:
            gecos = pwd.getpwuid(os.getuid()).pw_gecos.split(",")[0].strip()
            if gecos:
                return gecos
        except (KeyError, OSError, AttributeError):
            pass
    git = find_tool("git")
    if git:
        try:
            proc = subprocess.run([git, "config", "user.name"], capture_output=True, timeout=3, stdin=subprocess.DEVNULL)
            name = proc.stdout.decode("utf-8", "replace").strip()
            if proc.returncode == 0 and name:
                return name
        except (OSError, subprocess.SubprocessError):
            pass
    return ""


SUBDOC_RE = re.compile(r"\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*(?:subfiles|standalone)\s*\}")
PREFERRED_MAINS = ("paper", "thesis", "manuscript", "report", "article", "draft")
CHOOSE_SKIP = frozenset((BUILD_DIR, "node_modules", "__pycache__"))


# ---------------------------------------------------------------------------------------------
# Settings (~/.config/texc/settings.json; the file holds only the values the user changed)
# ---------------------------------------------------------------------------------------------

class Settings:
    PROVIDERS = ("claude", "codex", "off")
    RANGES = {"autosaveMs": (100, 60000), "fontSize": (8, 40), "compileTimeout": (5, 3600)}

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self._stamp = None
        self._overrides: dict = {}

    @staticmethod
    def defaults() -> dict:
        prov = {p["id"]: p for p in ai_providers()}
        provider = "claude" if prov["claude"]["available"] else "codex" if prov["codex"]["available"] else "off"
        return {"provider": provider,
                "model": {"claude": "default", "codex": prov["codex"]["default_model"]},
                "effort": "medium", "compileOnSave": True, "autosaveMs": 800, "fontSize": 13,
                "compileTimeout": 120}

    def _load(self) -> None:  # caller holds self.lock
        try:
            st = self.path.stat()
        except OSError:
            self._stamp, self._overrides = None, {}
            return
        stamp = (st.st_mtime_ns, st.st_size)
        if stamp == self._stamp:
            return
        try:
            data = json.loads(self.path.read_text("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("not a JSON object")
            data = self._clean(data, strict=False)
        except (OSError, ValueError) as e:
            log(f"ignoring unreadable settings file {self.path}: {e}")
            data = {}
        self._overrides, self._stamp = {k: v for k, v in data.items() if v is not None}, stamp

    def get(self) -> dict:
        with self.lock:
            self._load()
            over = json.loads(json.dumps(self._overrides))
        out = self.defaults()
        for k, v in over.items():
            if isinstance(v, dict) and isinstance(out.get(k), dict):
                out[k] = {**out[k], **v}
            else:
                out[k] = v
        return out

    def update(self, partial) -> dict:
        cleaned = self._clean(partial, strict=True)
        with self.lock:
            self._load()
            over = dict(self._overrides)
            for k, v in cleaned.items():
                if v is None:                      # null resets a key to its default
                    over.pop(k, None)
                elif isinstance(v, dict) and isinstance(over.get(k), dict):
                    over[k] = {**over[k], **v}
                else:
                    over[k] = v
            text = json.dumps(over, indent=2, ensure_ascii=False) + "\n"
            if len(text) > 256 * 1024:
                raise ApiError(413, "Settings are too large.")
            with fs_errors():
                self.path.parent.mkdir(parents=True, exist_ok=True)
                atomic_write(self.path, text.encode("utf-8"))
                st = self.path.stat()
            self._overrides, self._stamp = over, (st.st_mtime_ns, st.st_size)
        return self.get()

    def _clean(self, partial, strict: bool) -> dict:
        if not isinstance(partial, dict):
            raise ApiError(400, "Settings must be a JSON object.")
        out: dict = {}

        def bad(msg):
            if strict:
                raise ApiError(400, msg)

        for k, v in partial.items():
            if not isinstance(k, str) or not k or len(k) > 64:
                bad("Invalid settings key.")
                continue
            if v is None:
                out[k] = None
            elif k == "provider":
                if v in self.PROVIDERS:
                    out[k] = v
                else:
                    bad("provider must be claude, codex or off.")
            elif k == "model":
                if isinstance(v, str):
                    # A bare string sets the model of the provider chosen in the same update
                    # (or the current provider).
                    prov = partial.get("provider")
                    if prov not in ("claude", "codex") and strict:
                        prov = self.get()["provider"]
                    if prov in ("claude", "codex") and MODEL_RE.match(v):
                        out[k] = {prov: v}
                    else:
                        bad("Invalid model.")
                elif isinstance(v, dict):
                    m = {}
                    for pk, pv in v.items():
                        if pk in ("claude", "codex") and isinstance(pv, str) and MODEL_RE.match(pv):
                            m[pk] = pv
                        else:
                            bad(f"Invalid model for {pk}.")
                    out[k] = m
                else:
                    bad('model must look like {"claude": "default", "codex": "gpt-6-luna"}.')
            elif k == "effort":
                if v in EFFORTS:
                    out[k] = v
                else:
                    bad("effort must be low, medium or high.")
            elif k == "compileOnSave":
                if isinstance(v, bool):
                    out[k] = v
                else:
                    bad("compileOnSave must be true or false.")
            elif k in self.RANGES:
                if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
                    bad(f"{k} must be a number.")
                    continue
                lo, hi = self.RANGES[k]
                val = min(max(v, lo), hi)
                out[k] = int(round(val)) if k != "compileTimeout" or float(val).is_integer() else float(val)
            else:
                out[k] = jsonable(v)   # front-end extras are kept as given
        return out


# ---------------------------------------------------------------------------------------------
# Server-Sent Events hub
# ---------------------------------------------------------------------------------------------

class Subscriber:
    __slots__ = ("q", "dead")

    def __init__(self):
        self.q: queue.Queue = queue.Queue(maxsize=1000)
        self.dead = False


class EventHub:
    def __init__(self):
        self.lock = threading.Lock()
        self.subs: set = set()

    def subscribe(self) -> Subscriber:
        s = Subscriber()
        with self.lock:
            self.subs.add(s)
        return s

    def unsubscribe(self, s: Subscriber) -> None:
        with self.lock:
            self.subs.discard(s)

    def broadcast(self, name: str, data=None) -> None:
        msg = sse_bytes(name, {} if data is None else data)
        with self.lock:
            subs = list(self.subs)
        for s in subs:
            try:
                s.q.put_nowait(msg)
            except queue.Full:          # a client that stopped reading
                s.dead = True
                self.unsubscribe(s)

    def close(self) -> None:
        with self.lock:
            subs, self.subs = list(self.subs), set()
        for s in subs:
            s.dead = True
            try:
                s.q.put_nowait(None)
            except queue.Full:
                pass


# ---------------------------------------------------------------------------------------------
# Build library adapter (texc.py)
# ---------------------------------------------------------------------------------------------

class BuildLib:
    def __init__(self, module):
        self.mod = module
        if module is None:
            self.problem = "texc.py could not be loaded"
        elif not callable(getattr(module, "run_build", None)):
            self.problem = "texc.py has no run_build() (it predates the GUI build API)"
        else:
            self.problem = None

    @property
    def ok(self) -> bool:
        return self.problem is None

    def pick_engine(self, main: Path) -> str:
        fn = getattr(self.mod, "pick_engine", None)
        if callable(fn):
            try:
                eng = fn(main, None)
                if eng in ENGINES:
                    return eng
            except Exception:
                pass
        return "pdf"

    def find_mains(self, folder: Path) -> list[Path]:
        fn = getattr(self.mod, "find_mains", None)
        if callable(fn):
            try:
                return [Path(p) for p in fn(folder)]
            except Exception:
                pass
        found = []
        for p in sorted(folder.glob("*.tex")):
            try:
                text = p.read_text("utf-8", errors="replace")
            except OSError:
                continue
            if re.search(r"^[^%\n]*\\documentclass", text, re.M):
                found.append(p)
        return found

    def run_build(self, main: Path, engine, timeout, cancel) -> dict:
        fn = self.mod.run_build
        kwargs = {"timeout": timeout, "cancel": cancel, "copy_pdf": True}
        try:   # tolerate an older signature instead of failing every compile
            params = inspect.signature(fn).parameters
            if not any(p.kind == p.VAR_KEYWORD for p in params.values()):
                kwargs = {k: v for k, v in kwargs.items() if k in params}
        except (TypeError, ValueError):
            pass
        return fn(main, engine, **kwargs)

    def clean(self, base: Path) -> list[str]:
        fn = getattr(self.mod, "clean", None)
        if not callable(fn):
            raise ApiError(503, "texc.clean() is unavailable.")
        return [str(x) for x in (fn(base) or [])]

    # -- folders and templates (docs/ARCHITECTURE.md; texc.py may predate them, so each has a fallback)

    def choose_main(self, root: Path) -> str | None:
        """The main file of a folder as a root-relative posix path, or None. Uses
        texc.choose_main() when present, else a basic version of the same rules."""
        fn = getattr(self.mod, "choose_main", None)
        got = None
        if callable(fn):
            try:
                got = fn(root)
            except Exception as e:
                log(f"texc.choose_main failed ({e!r}); using the built-in rules")
                got = self._choose_main(root)
        else:
            got = self._choose_main(root)
        return valid_main(root, got)

    def _choose_main(self, root: Path):
        cands = list(self.find_mains(root))
        if not cands:
            try:
                with os.scandir(root) as it:
                    subs = sorted((e for e in it if not e.name.startswith(".") and e.name not in CHOOSE_SKIP
                                   and e.is_dir(follow_symlinks=False)), key=lambda e: e.name.lower())
            except OSError:
                subs = []
            for e in subs[:200]:
                cands += self.find_mains(Path(e.path))
        if not cands:
            return None

        def piece(p) -> bool:
            try:
                with open(p, "r", encoding="utf-8", errors="replace") as f:
                    return bool(SUBDOC_RE.search(f.read(1 << 20)))
            except OSError:
                return False

        cands = [p for p in cands if not piece(p)] or cands

        def newest(ps):
            def mtime(p):
                try:
                    return os.stat(p).st_mtime
                except OSError:
                    return 0.0
            return max(ps, key=mtime)

        named = [p for p in cands if Path(p).name == "main.tex"]
        if named:
            pick = named[0] if len(named) == 1 else newest(named)
        elif len(cands) == 1:
            pick = cands[0]
        else:
            pref = [p for name in PREFERRED_MAINS for p in cands if Path(p).name == name + ".tex"]
            pick = pref[0] if pref else newest(cands)
        try:
            return Path(os.path.abspath(pick)).relative_to(root).as_posix()
        except ValueError:
            return None

    def list_templates(self) -> list[dict]:
        fn = getattr(self.mod, "list_templates", None)
        if not callable(fn):
            return []
        try:
            items = fn() or []
        except Exception as e:
            log(f"texc.list_templates failed: {e!r}")
            return []
        out = []
        for t in items if isinstance(items, (list, tuple)) else []:
            if isinstance(t, dict) and isinstance(t.get("id"), str) and t["id"]:
                out.append({"id": t["id"], "name": str(t.get("name") or t["id"]),
                            "description": str(t.get("description") or ""),
                            "main": str(t.get("main") or "main.tex")})
        return out

    def default_author(self) -> str:
        fn = getattr(self.mod, "default_author", None)
        if callable(fn):
            try:
                name = fn()
                if isinstance(name, str):
                    return name.strip()
            except Exception as e:
                log(f"texc.default_author failed: {e!r}")
        return fallback_author()


def valid_main(root: Path, rel) -> str | None:
    """rel (root-relative, or absolute inside root) as a normalised posix path if it names an
    existing .tex/.ltx file inside root, else None."""
    if isinstance(rel, Path):
        rel = str(rel)
    if not isinstance(rel, str) or not rel.strip() or "\x00" in rel:
        return None
    root_s = os.path.realpath(str(root))
    if os.path.isabs(rel):
        absr = os.path.join(os.path.realpath(os.path.dirname(rel)), os.path.basename(rel))
        if not absr.startswith(root_s + os.sep):
            return None
        rel = absr[len(root_s) + 1:]
    norm = posixpath.normpath(rel.replace(os.sep, "/"))
    if norm in (".", "") or norm == ".." or norm.startswith("../") or ext_of(norm) not in MAIN_EXTS:
        return None
    if norm.split("/")[0].lower() == BUILD_DIR:
        return None
    real = os.path.realpath(os.path.join(root_s, norm))
    if not (real.startswith(root_s + os.sep) and os.path.isfile(real)):
        return None
    return norm


# ---------------------------------------------------------------------------------------------
# Project: paths, validation, listing
# ---------------------------------------------------------------------------------------------

class Project:
    """One opened folder. `root` is the folder itself; the main file may sit in a subfolder
    (`main_rel` is root-relative) or not exist yet (a "virtual" main.tex). TeX runs in the main
    file's folder (base()), so builds go to <base>/.texc while chats stay in <root>/.texc."""

    def __init__(self, root, main_rel: str = "main.tex"):
        self.root = Path(canonical_path(root))
        self.root_s = str(self.root)
        self.main_rel = main_rel
        self.lock = threading.Lock()

    @property
    def main_abs(self) -> Path:
        return self.root / self.main_rel

    def main_exists(self) -> bool:
        return self.main_abs.is_file()

    def base_rel(self) -> str:
        """Folder of the main file relative to the root ("" normally). TeX runs there."""
        return posixpath.dirname(self.main_rel)

    def base(self) -> Path:
        b = self.base_rel()
        return self.root / b if b else self.root

    def stem(self) -> str:
        return posixpath.splitext(posixpath.basename(self.main_rel))[0]

    def build_dir(self) -> Path:
        return self.base() / BUILD_DIR

    def pdf_path(self) -> Path:
        return self.build_dir() / (self.stem() + ".pdf")

    def log_path(self) -> Path:
        return self.build_dir() / (self.stem() + ".log")

    def beside_pdf(self) -> Path:
        return self.base() / (self.stem() + ".pdf")

    def texc_dir(self) -> Path:
        """The root's .texc folder: chats/, trash/ and uploads/ live here."""
        return self.root / BUILD_DIR

    def inside(self, real: str) -> bool:
        return real == self.root_s or real.startswith(self.root_s + os.sep)

    def resolve(self, rel, allow_uploads: bool = False) -> tuple[Path, str]:
        """Validate a project-relative path. Returns (absolute path, normalised relative path).
        Rejects absolute paths, escapes (.. or symlinks) and anything in .texc/ (except
        .texc/uploads/ when allow_uploads)."""
        if not isinstance(rel, str) or not rel.strip():
            raise ApiError(400, "A path is required.")
        if "\x00" in rel:
            raise ApiError(400, "Invalid path.")
        if rel.startswith(("/", "~")) or re.match(r"^[A-Za-z]:[\\/]", rel):
            raise ApiError(400, "Paths must be relative to the project folder.")
        norm = posixpath.normpath(rel)
        if norm in (".", "") or norm == ".." or norm.startswith("../"):
            raise ApiError(400, "That path is outside the project.")
        parts = norm.split("/")

        def texc_ok(ps) -> bool:
            # No .texc component anywhere: a main in a subfolder builds into <sub>/.texc.
            if not any(p.lower() == BUILD_DIR for p in ps):
                return True
            return (allow_uploads and len(ps) >= 3 and ps[0].lower() == BUILD_DIR and ps[1].lower() == "uploads"
                    and not any(p.lower() == BUILD_DIR for p in ps[1:]))

        if not texc_ok(parts):
            raise ApiError(400, "Paths inside .texc/ are not allowed.")
        abs_path = self.root.joinpath(*parts)
        real = os.path.realpath(abs_path)
        if not self.inside(real):
            raise ApiError(400, "That path leaves the project through a symlink.")
        if real == self.root_s:
            raise ApiError(400, "That path is the project folder itself.")
        if not texc_ok(list(Path(real).relative_to(self.root).parts)):
            raise ApiError(400, "Paths inside .texc/ are not allowed.")
        return abs_path, norm

    def try_resolve(self, rel, allow_uploads: bool = False):
        try:
            return self.resolve(rel, allow_uploads)
        except ApiError:
            return None

    def read_text(self, rel: str, limit: int = MAX_TEXT_READ) -> str | None:
        """Text of a project file, or None if it is missing, invalid, binary or too large."""
        hit = self.try_resolve(rel)
        if hit is None or not is_text_path(hit[1]):
            return None
        try:
            if not hit[0].is_file() or hit[0].stat().st_size > limit:
                return None
            return hit[0].read_bytes().decode("utf-8", "replace")
        except OSError:
            return None

    def to_rel(self, real: str) -> str | None:
        real = os.path.realpath(real)
        if not self.inside(real) or real == self.root_s:
            return None
        rel = Path(real).relative_to(self.root).as_posix()
        return None if rel.split("/")[0].lower() == BUILD_DIR else rel

    def walk(self, start_rel: str = "", limit: int = MAX_LISTING, max_binary: int | None = None):
        """Yield (rel, is_dir, stat) in tree order (folders first, case-insensitive), skipping
        hidden entries, node_modules, __pycache__ and symlinks that leave the project. The tree is
        read breadth-first (files before folders at each level) and sorted afterwards, so when
        `limit` cuts a huge folder short (all of ~/Desktop), shallow files such as the main .tex at
        the root are always included."""
        root_s = self.root_s
        out: list = []
        level = [(start_rel, str(self.root / start_rel) if start_rel else root_s)]
        depth = 0
        while level and len(out) < limit and depth <= 40:
            deeper = []
            for rel_dir, abs_dir in level:
                if len(out) >= limit:
                    break
                try:
                    with os.scandir(abs_dir) as it:
                        entries = list(it)
                except OSError:
                    continue
                entries.sort(key=lambda e: (e.name.lower(), e.name))
                dirs, files = [], []
                for e in entries:
                    if e.name.startswith("."):
                        continue
                    try:
                        if e.is_symlink():
                            real = os.path.realpath(e.path)
                            if not (real == root_s or real.startswith(root_s + os.sep)) or os.path.isdir(real):
                                continue          # escapes the project, or a folder link (cycles)
                        if e.is_dir():
                            if e.name not in SKIP_DIRS:
                                dirs.append(e)
                        else:
                            files.append(e)
                    except OSError:
                        continue
                for e in files:
                    if len(out) >= limit:
                        break
                    try:
                        st = e.stat()
                    except OSError:
                        continue
                    if not statmod.S_ISREG(st.st_mode):
                        continue
                    if max_binary is not None and st.st_size > max_binary and not is_text_path(e.name):
                        continue
                    out.append(((f"{rel_dir}/{e.name}" if rel_dir else e.name), False, st))
                for e in dirs:
                    if len(out) >= limit:
                        break
                    try:
                        st = e.stat()
                    except OSError:
                        continue
                    rel = f"{rel_dir}/{e.name}" if rel_dir else e.name
                    out.append((rel, True, st))
                    deeper.append((rel, e.path))
            level = deeper
            depth += 1

        def tree_order(item):
            parts = item[0].split("/")
            return [(0, p.lower(), p) for p in parts[:-1]] + [(0 if item[1] else 1, parts[-1].lower(), parts[-1])]

        out.sort(key=tree_order)
        yield from out

    def listing(self) -> list[dict]:
        out = []
        for rel, is_dir, st in self.walk(limit=MAX_LISTING):
            out.append({"path": rel, "type": "dir" if is_dir else "file",
                        "size": 0 if is_dir else st.st_size, "mtime": st.st_mtime,
                        "text": (not is_dir) and is_text_path(rel)})
        return out


def watchable(rel: str) -> bool:
    parts = rel.split("/")
    return not any(p.startswith(".") or p in SKIP_DIRS for p in parts)


# ---------------------------------------------------------------------------------------------
# Watcher: polls mtimes once a second
# ---------------------------------------------------------------------------------------------

class Watcher(threading.Thread):
    """Broadcasts `files` when the tree changes and `file` when a text file changes on disk
    (not through our own API), and triggers compile-on-save. Compiles are only triggered when
    a text file's *content* changed (hash check), so build tools that rewrite identical files
    (or a `touch`) can't start a rebuild loop."""

    def __init__(self, app: "App"):
        super().__init__(name="texc-watch", daemon=True)
        self.app = app
        self.snap: dict = {}      # rel -> (mtime_ns, size), files only
        self.dirs: set = set()
        self.hashes: dict = {}    # rel -> digest of the last content seen (kept after deletion)
        self.stop_event = threading.Event()
        self.last_scan = 0.0      # seconds the last scan took (sets the next wait, see scan_interval)

    def _scan(self):
        t0 = time.monotonic()
        files, dirs = {}, set()
        for rel, is_dir, st in self.app.project.walk(limit=MAX_WATCHED, max_binary=WATCH_BINARY_LIMIT):
            if is_dir:
                dirs.add(rel)
            else:
                files[rel] = (st.st_mtime_ns, st.st_size, st.st_mtime)
        self.last_scan = time.monotonic() - t0
        return files, dirs

    def prime(self) -> None:
        root = self.app.project.root
        with self.app.fs_lock:
            files, dirs = self._scan()
            self.snap = {k: v[:2] for k, v in files.items()}
            self.dirs = dirs
            budget = 64 * 1024 * 1024
            for rel, (_, size, _) in files.items():
                if budget <= 0:
                    break
                if is_text_path(rel) and size <= 2 * 1024 * 1024:
                    d = file_digest(root / rel)
                    if d is not None:
                        self.hashes[rel] = d
                        budget -= size

    def run(self) -> None:
        # Priming here (not before the server starts) keeps the app's handshake fast on big folders.
        try:
            self.prime()
        except Exception as e:
            log(f"watcher error: {e!r}")
        while not self.stop_event.wait(scan_interval(self.last_scan)):
            try:
                self.tick()
            except Exception as e:     # never let the watcher die
                log(f"watcher error: {e!r}")

    def tick(self) -> None:
        app = self.app
        root = app.project.root
        modified, triggers = [], []
        with app.fs_lock:
            files, dirs = self._scan()
            tree_changed = files.keys() != self.snap.keys() or dirs != self.dirs
            for rel, (mns, size, mtime) in files.items():
                old = self.snap.get(rel)
                if old == (mns, size) or not is_text_path(rel):
                    continue
                digest = file_digest(root / rel)
                if old is not None:
                    modified.append({"path": rel, "mtime": mtime})
                if digest is None or digest != self.hashes.get(rel):
                    triggers.append(rel)
                if digest is not None:
                    self.hashes[rel] = digest
            self.snap = {k: v[:2] for k, v in files.items()}
            self.dirs = dirs
        # Auto-adopt: while the main file doesn't exist, look for one after every change.
        adopted = (tree_changed or bool(triggers)) and app.maybe_adopt_main()
        if tree_changed or adopted:
            app.hub.broadcast("files", {})
        for ev in modified:
            app.hub.broadcast("file", ev)
        if triggers and app.build.ok and app.settings.get().get("compileOnSave", True):
            try:
                app.compiler.request(wait=False)
            except ApiError:
                pass

    # -- our own writes: update the snapshot so the next tick doesn't report them (caller holds fs_lock)

    def note_write(self, rel: str, st, data: bytes | None) -> None:
        if not watchable(rel):
            return
        self.snap[rel] = (st.st_mtime_ns, st.st_size)
        if data is not None and is_text_path(rel):
            self.hashes[rel] = hashlib.blake2b(data, digest_size=16).digest()
        self._add_parents(rel)

    def absorb(self, rels) -> None:
        root = self.app.project.root
        for rel in rels:
            if not watchable(rel):
                continue
            prefix = rel + "/"
            for k in [k for k in self.snap if k == rel or k.startswith(prefix)]:
                del self.snap[k]
            self.dirs = {d for d in self.dirs if d != rel and not d.startswith(prefix)}
            p = root / rel
            try:
                st = os.stat(p)
            except OSError:
                continue
            if statmod.S_ISDIR(st.st_mode):
                if os.path.islink(p):
                    continue
                self.dirs.add(rel)
                for r, is_dir, s in self.app.project.walk(rel, limit=MAX_WATCHED, max_binary=WATCH_BINARY_LIMIT):
                    if is_dir:
                        self.dirs.add(r)
                    else:
                        self.snap[r] = (s.st_mtime_ns, s.st_size)
                        if is_text_path(r):
                            d = file_digest(root / r)
                            if d is not None:
                                self.hashes[r] = d
            elif statmod.S_ISREG(st.st_mode):
                if st.st_size > WATCH_BINARY_LIMIT and not is_text_path(rel):
                    continue
                self.snap[rel] = (st.st_mtime_ns, st.st_size)
                if is_text_path(rel):
                    d = file_digest(p)
                    if d is not None:
                        self.hashes[rel] = d
            self._add_parents(rel)

    def _add_parents(self, rel: str) -> None:
        parent = posixpath.dirname(rel)
        while parent:
            if (self.app.project.root / parent).is_dir():
                self.dirs.add(parent)
            parent = posixpath.dirname(parent)


# ---------------------------------------------------------------------------------------------
# Compile manager: one worker thread, requests serialised
# ---------------------------------------------------------------------------------------------

class Compiler:
    """Builds run one at a time on a worker thread. A request that arrives while a build is
    running waits for, and shares, the *next* build's result; several such requests share one
    build. The last complete PDF is kept in memory so /api/pdf never serves a half-written file."""

    def __init__(self, app: "App"):
        self.app = app
        self.cond = threading.Condition()
        self.pending = False
        self.pending_engine = None
        self.cancel_queued = False
        self.running = False
        self.cleaning = False
        self.stopping = False
        self.started = 0
        self.finished = 0
        self.results: dict = {}
        self.last: dict | None = None
        self.last_output = ""
        self.cancel_event: threading.Event | None = None
        self.pdf_cache = None          # ((mtime_ns, size), mtime, bytes)
        self.thread = threading.Thread(target=self._worker, name="texc-compile", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def request(self, engine: str | None = None, wait: bool = True):
        with self.cond:
            if self.stopping:
                raise ApiError(503, "texc is shutting down.")
            target = self.started + 1
            self.pending = True
            self.cancel_queued = False     # a fresh request supersedes an earlier cancel
            if engine:
                self.pending_engine = engine
            self.cond.notify_all()
            if not wait:
                return None
            while self.finished < target:
                if self.stopping:
                    raise ApiError(503, "texc is shutting down.")
                self.cond.wait(0.5)
            return self.results.get(target) or self.last

    def cancel(self) -> bool:
        with self.cond:
            hit = False
            if self.running and self.cancel_event is not None and not self.cancel_event.is_set():
                self.cancel_event.set()
                hit = True
            if self.pending:
                self.cancel_queued = True
                hit = True
            return hit

    def clean(self) -> list[str]:
        with self.cond:
            while self.running or self.cleaning:
                if self.stopping:
                    raise ApiError(503, "texc is shutting down.")
                self.cond.wait(0.5)
            self.cleaning = True
        try:
            return self.app.build.clean(self.app.project.base())
        finally:
            with self.cond:
                self.cleaning = False
                self.cond.notify_all()

    def reset(self) -> None:
        """Forget results and the cached PDF (the main file changed)."""
        with self.cond:
            self.last = None
            self.last_output = ""
            self.pdf_cache = None

    def stop(self) -> None:
        with self.cond:
            self.stopping = True
            if self.cancel_event is not None:
                self.cancel_event.set()
            self.cond.notify_all()
        if self.thread.is_alive():
            self.thread.join(timeout=5)

    def pdf_bytes(self):
        """(bytes, mtime) of the PDF to serve: the file on disk when no build is writing it and
        it looks complete, otherwise the last complete one from memory."""
        with self.cond:
            running, cache = self.running, self.pdf_cache
        if not running:
            got = self._read_pdf()
            if got is not None:
                return got[2], got[1]
        if cache is not None:
            return cache[2], cache[1]
        return None, None

    def _read_pdf(self):
        pdf = self.app.project.pdf_path()
        try:
            st = pdf.stat()
            if st.st_size > 512 * 1024 * 1024:
                return None
            data = pdf.read_bytes()
        except OSError:
            return None
        if not data.startswith(b"%PDF") or b"%%EOF" not in data[-2048:]:
            return None
        return (st.st_mtime_ns, st.st_size), st.st_mtime, data

    def _cache_pdf(self) -> None:
        pdf = self.app.project.pdf_path()
        try:
            st = pdf.stat()
        except OSError:
            return
        with self.cond:
            if self.pdf_cache is not None and self.pdf_cache[0] == (st.st_mtime_ns, st.st_size):
                return
        got = self._read_pdf()
        if got is not None:
            with self.cond:
                self.pdf_cache = got

    def _worker(self) -> None:
        while True:
            with self.cond:
                while (not self.pending or self.cleaning) and not self.stopping:
                    self.cond.wait()
                if self.stopping:
                    return
                self.pending = False
                engine, self.pending_engine = self.pending_engine, None
                skip, self.cancel_queued = self.cancel_queued, False
                self.started += 1
                bid = self.started
                self.running = True
                self.cancel_event = threading.Event()
                cancel = self.cancel_event
            self.app.hub.broadcast("compile-start", {"id": bid})
            self._cache_pdf()     # keep the last complete PDF servable while the build rewrites it
            try:
                if skip:
                    raw = self._synthetic(engine, "Compile cancelled.", cancelled=True, as_error=False)
                else:
                    raw = self._build(engine, cancel)
            except Exception as e:
                log(f"compile failed: {e!r}")
                traceback.print_exc(file=sys.stderr)
                raw = self._synthetic(engine, f"texc could not run the build: {e}")
            try:
                public, output = self._shape(raw, bid)
            except Exception as e:
                log(f"unexpected compile result: {e!r}")
                public, output = self._shape(self._synthetic(engine, f"Unexpected build result: {e}"), bid)
            with self.cond:
                self.results[bid] = public
                for k in [k for k in self.results if k < bid - 20]:
                    del self.results[k]
                self.last, self.last_output = public, output
                self.finished = bid
                self.running = False
                self.cancel_event = None
                self.cond.notify_all()
            self._cache_pdf()
            self.app.hub.broadcast("compile", public)

    def _build(self, engine, cancel) -> dict:
        proj = self.app.project
        main = proj.main_abs
        if not main.is_file():
            # No main file yet (docs/ARCHITECTURE.md): no latexmk, a normal-shaped result the front
            # end shows as an empty state rather than a red error.
            raw = self._synthetic(engine, NO_MAIN_NOTE, as_error=False)
            raw.update(no_main=True, pdf=None, pdf_mtime=None, log=None)
            return raw
        if not self.app.build.ok:
            return self._synthetic(engine, f"Compiling is unavailable: {self.app.build.problem}.")
        timeout = float(self.app.settings.get().get("compileTimeout") or 120)
        raw = self.app.build.run_build(main, engine, timeout, cancel)
        if not isinstance(raw, dict):
            raise TypeError("run_build() did not return a dict")
        if raw.get("cancelled") or raw.get("timed_out"):
            self._repair_after_kill(proj.build_dir())
        return raw

    @staticmethod
    def _repair_after_kill(out: Path) -> None:
        """After a cancelled or timed-out build. A killed pdflatex can leave a 0-byte .aux; latexmk
        then makes a stub .aux and its database schedules bibtex before *latex ("I found no
        \\citation commands"), so every later build fails until Clean. Remove empty aux-like
        files, pdfTeX's "(busy)" leftovers and the latexmk database, so the next build starts
        from a fresh rule set (a full run)."""
        exts = (".aux", ".toc", ".lof", ".lot", ".out", ".nav", ".snm", ".bcf", ".idx")
        keep = ("chats", "trash", "uploads")
        for root, dirs, files in os.walk(out):
            if root == str(out):
                dirs[:] = [d for d in dirs if d not in keep]
            for f in files:
                fp = os.path.join(root, f)
                try:
                    if (f.endswith(".fdb_latexmk") or f.endswith("(busy)")
                            or (f.endswith(exts) and os.path.getsize(fp) == 0)):
                        os.remove(fp)
                except OSError:
                    pass

    def _synthetic(self, engine, message: str, cancelled: bool = False, as_error: bool = True) -> dict:
        proj = self.app.project
        pdf, log_p = proj.pdf_path(), proj.log_path()
        try:
            pdf_mtime = pdf.stat().st_mtime
        except OSError:
            pdf_mtime = None
        return {"ok": False, "engine": engine or self.app.engine(), "duration": 0.0,
                "main": posixpath.basename(proj.main_rel),
                "pdf": str(pdf) if pdf_mtime is not None else None, "pdf_mtime": pdf_mtime,
                "log": str(log_p) if log_p.is_file() else None,
                "errors": [{"file": "", "line": 0, "message": message, "context": ""}] if as_error else [],
                "warnings": [], "notes": [] if as_error else [message],
                "cancelled": cancelled, "timed_out": False, "output": ""}

    def _shape(self, raw: dict, bid: int):
        """The public compile result: run_build's dict without `output`, paths made relative to
        the project root, plus id, pdf_url and log_tail."""
        proj = self.app.project
        base_rel = proj.base_rel()
        output = raw.get("output") or ""
        if not isinstance(output, str):
            output = str(output)

        def fix(f) -> str:
            if not isinstance(f, str) or not f:
                return ""
            f = f.replace("\\", "/")
            if os.path.isabs(f):
                return proj.to_rel(f) or f
            f = posixpath.normpath(posixpath.join(base_rel, f) if base_rel else f)
            return "" if f == "." else f

        def issue(e, kind: str) -> dict:
            if isinstance(e, dict):
                d = dict(e)
            elif isinstance(e, (list, tuple)):
                keys = ("file", "line", "message", "context")
                d = {k: e[i] for i, k in enumerate(keys) if i < len(e)}
            else:
                d = {"message": str(e)}
            d["file"] = fix(d.get("file"))
            d["line"] = max(0, to_int(d.get("line"), 0))
            d["message"] = str(d.get("message") or "")
            if kind == "error":
                d["context"] = str(d.get("context") or "")
            else:
                d["important"] = bool(d.get("important", False))
            return jsonable(d)

        r = {k: jsonable(v) for k, v in raw.items() if k != "output"}
        r["ok"] = bool(raw.get("ok"))
        r["engine"] = raw.get("engine") or self.app.engine()
        r["duration"] = float(raw.get("duration") or 0.0)
        r["main"] = proj.main_rel
        r["errors"] = [issue(e, "error") for e in (raw.get("errors") or [])]
        r["warnings"] = [issue(w, "warning") for w in (raw.get("warnings") or [])]
        r["notes"] = [str(n) for n in (raw.get("notes") or [])]
        r["cancelled"] = bool(raw.get("cancelled"))
        r["timed_out"] = bool(raw.get("timed_out"))
        r["no_main"] = bool(raw.get("no_main"))
        pdf = raw.get("pdf")
        r["pdf"] = str(pdf) if pdf else None
        if r["pdf"] and r.get("pdf_mtime") is None:
            try:
                r["pdf_mtime"] = os.stat(r["pdf"]).st_mtime
            except OSError:
                r["pdf_mtime"] = None
        r.setdefault("pdf_mtime", None)
        r.setdefault("log", None)
        r["id"] = bid
        r["pdf_url"] = f"/api/pdf?v={r['pdf_mtime']}" if r["pdf"] else None
        r["log_tail"] = "\n".join(output.splitlines()[-40:])
        return r, output


# ---------------------------------------------------------------------------------------------
# AI bridge 
# ---------------------------------------------------------------------------------------------

INPUT_RE = re.compile(r"\\(input|include|subfile)\s*\{([^{}]+)\}")
IMPORT_RE = re.compile(r"\\(sub)?import\*?\s*\{([^{}]*)\}\s*\{([^{}]+)\}")
BIBLIOGRAPHY_RE = re.compile(r"\\bibliography\s*\{([^{}]+)\}")
ADDBIB_RE = re.compile(r"\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}")


def reachable_tex(proj: Project) -> list[str]:
    """The main file, then every file reachable through \\input/\\include/\\subfile (and
    \\import/\\subimport), depth first in order of appearance."""
    base = proj.base_rel()
    order: list[str] = []
    seen: set = set()

    def visit(rel: str, depth: int) -> None:
        if rel in seen or depth > 20 or len(order) >= 300:
            return
        seen.add(rel)
        text = proj.read_text(rel)
        if text is None:
            return
        order.append(rel)
        body = strip_comments(text)
        cur = posixpath.dirname(rel)
        found = [(m.start(), m.group(1), None, m.group(2)) for m in INPUT_RE.finditer(body)]
        found += [(m.start(), "subimport" if m.group(1) else "import", m.group(2), m.group(3))
                  for m in IMPORT_RE.finditer(body)]
        for _, kind, folder, name in sorted(found, key=lambda t: t[0]):
            name = name.strip()
            if not name or "\\" in name or "#" in name:
                continue                       # computed names can't be followed
            if kind == "subimport":
                start = posixpath.join(cur, folder.strip())
            elif kind == "import":
                start = posixpath.join(base, folder.strip())
            else:
                start = base
            cand = posixpath.normpath(posixpath.join(start, name))
            if kind == "include":
                cands = [cand + ".tex"]
            elif cand.endswith(".tex"):
                cands = [cand]
            else:
                cands = [cand + ".tex", cand]
            for c in cands:
                hit = proj.try_resolve(c)
                if hit is not None and is_text_path(hit[1]) and hit[0].is_file():
                    visit(hit[1], depth + 1)
                    break

    visit(proj.main_rel, 0)
    return order


def bib_refs(proj: Project, rels) -> list[str]:
    """Root-relative .bib paths named by \\bibliography{…}/\\addbibresource{…} in these files."""
    base = proj.base_rel()
    out: list[str] = []
    for rel in rels:
        text = proj.read_text(rel)
        if text is None:
            continue
        body = strip_comments(text)
        hits = [(m.start(), "bibliography", m.group(1)) for m in BIBLIOGRAPHY_RE.finditer(body)]
        hits += [(m.start(), "addbibresource", m.group(1)) for m in ADDBIB_RE.finditer(body)]
        for _, kind, arg in sorted(hits):
            names = [n.strip() for n in arg.split(",")] if kind == "bibliography" else [arg.strip()]
            for n in names:
                if not n or "://" in n or "\\" in n:
                    continue
                if kind == "bibliography" and not n.endswith(".bib"):
                    n += ".bib"
                p = posixpath.normpath(posixpath.join(base, n) if base else n)
                if p not in out:
                    out.append(p)
    return out


def pdf_text(path: Path, limit: int = 60 * 1024) -> str | None:
    tool = find_tool("pdftotext")
    if not tool:
        return None
    try:
        proc = subprocess.run([tool, "-layout", "-enc", "UTF-8", str(path), "-"], capture_output=True,
                              timeout=30, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    text = proc.stdout.decode("utf-8", "replace").strip()
    return cap_bytes(text, limit, "\n[… truncated]") if text else None


def build_prompt(proj: Project, provider: str, body: dict):
    """Returns (prompt text, absolute image paths, whether Claude needs its Read tool)."""
    msg = body.get("message")
    if isinstance(msg, str):
        msg = {"text": msg}
    if not isinstance(msg, dict):
        msg = {}
    text = msg.get("text") if isinstance(msg.get("text"), str) else ""
    context = msg.get("context") if isinstance(msg.get("context"), list) else []
    images_in = msg.get("images") if isinstance(msg.get("images"), list) else []
    history = body.get("history") if isinstance(body.get("history"), list) else []
    active = body.get("active_path") if isinstance(body.get("active_path"), str) else ""

    sections: list[str] = []
    if provider == "codex":
        sections.append(SYSTEM_PROMPT)

    # 1. Project files: main, reachable inputs, then .bib files (each bib capped; total capped).
    tex_order = reachable_tex(proj)
    listing = [f for f in proj.listing() if f["type"] == "file"]
    bibs = bib_refs(proj, tex_order)
    bibs += [f["path"] for f in listing if f["path"].endswith(".bib") and f["path"] not in bibs]
    included: list[str] = []
    blocks: list[str] = []
    omitted: list[str] = []
    used = 0
    for rel in tex_order + [b for b in bibs if b not in tex_order]:
        content = proj.read_text(rel)
        if content is None:
            continue
        if rel.endswith(".bib") and nbytes(content) > PROMPT_BIB_CAP:
            content = cap_bytes(content, PROMPT_BIB_CAP, "\n% [texc: truncated, only the first 40 KB are shown]")
        size = nbytes(content)
        if used + size > PROMPT_TOTAL_CAP:
            room = PROMPT_TOTAL_CAP - used
            if room < 4096:
                omitted.append(rel)
                continue
            content = cap_bytes(content, room, "\n% [texc: truncated, the prompt size limit was reached]")
            size = room
        blocks.append(f"## {rel}\n{fence(content)}")
        included.append(rel)
        used += size
    files_md = "# Project files\n\n" + ("\n\n".join(blocks) if blocks else "(The main file could not be read.)")
    if omitted:
        files_md += "\n\nNot included (prompt size limit): " + ", ".join(omitted)
    others = [f["path"] for f in listing if f["text"] and f["path"] not in included]
    if others:
        shown = others[:300]
        files_md += "\n\nOther text files in the project (not included): " + ", ".join(shown)
        if len(others) > len(shown):
            files_md += f", … ({len(others) - len(shown)} more)"
    sections.append(files_md)

    # 2. Attached context and images.
    images: list[str] = []

    def add_image(abs_path: Path) -> None:
        s = str(abs_path)
        if s not in images and len(images) < 10:
            images.append(s)

    ctx: list[str] = []
    for item in context[:50]:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            continue
        hit = proj.try_resolve(item["path"], allow_uploads=True)
        if hit is None:
            ctx.append(f"## {item['path']}\n(Not available: outside the project.)")
            continue
        abs_path, rel = hit
        frm, to = item.get("from"), item.get("to")
        if isinstance(frm, dict) and isinstance(to, dict):
            l1, c1 = max(1, to_int(frm.get("line"), 1)), max(0, to_int(frm.get("ch"), 0))
            l2, c2 = max(1, to_int(to.get("line"), l1)), max(0, to_int(to.get("ch"), 0))
            sel = item.get("text")
            if not isinstance(sel, str):            # no text sent: cut the range from the file
                chunk = (proj.read_text(rel) or "").split("\n")[l1 - 1:l2]
                if chunk:
                    chunk[-1] = chunk[-1][:c2]
                    chunk[0] = chunk[0][c1:]
                sel = "\n".join(chunk)
            ctx.append(f"## {rel}:{l1}:{c1 + 1}-{l2}:{c2 + 1}\n{fence(cap_bytes(sel, PROMPT_CONTEXT_CAP))}")
            continue
        ext = ext_of(rel)
        if rel in included:
            ctx.append(f"## {rel}\n(The whole file is attached; its content is under Project files above.)")
        elif is_text_path(rel):
            content = proj.read_text(rel)
            if content is None:
                ctx.append(f"## {rel}\n(The file could not be read.)")
            else:
                ctx.append(f"## {rel}\n{fence(cap_bytes(content, PROMPT_CONTEXT_CAP))}")
        elif ext in IMAGE_EXTS and abs_path.is_file():
            add_image(abs_path)
            ctx.append(f"## {rel}\n(An image; it is attached.)")
        elif ext == "pdf" and abs_path.is_file():
            extracted = pdf_text(abs_path)
            if extracted:
                ctx.append(f"## {rel} (text extracted from the PDF)\n{fence(extracted, 'text')}")
            else:
                ctx.append(f"## {rel}\n(A PDF whose text could not be extracted.)")
        else:
            ctx.append(f"## {rel}\n(A binary file; its content is not included.)")
    for p in images_in[:10]:
        hit = proj.try_resolve(p, allow_uploads=True) if isinstance(p, str) else None
        if hit and ext_of(hit[1]) in IMAGE_EXTS and hit[0].is_file():
            add_image(hit[0])
    if ctx:
        sections.append("# Attached context\n\n" + "\n\n".join(ctx))

    # 3. Conversation so far (last 12 turns, each capped).
    turns = []
    valid = [h for h in history if isinstance(h, dict) and isinstance(h.get("content"), str) and h["content"].strip()]
    for h in valid[-HISTORY_TURNS:]:
        role = "Assistant" if h.get("role") == "assistant" else "User"
        turns.append(f"{role}:\n{cap_bytes(h['content'].strip(), HISTORY_TURN_CAP)}")
    if turns:
        sections.append("# Conversation so far\n\n" + "\n\n".join(turns))

    # 4. The request.
    req = ["# Request", "", text.strip() or "(No text; see the attached context.)"]
    if active:
        req += ["", f"(The user is currently viewing {active}.)"]
    if images:
        if provider == "claude":
            req += ["", "Attached images: " + ", ".join(images)
                    + ", read them with the Read tool (the only tool you may use, and only for these files)."]
        else:
            req += ["", f"({len(images)} image{'s are' if len(images) > 1 else ' is'} attached.)"]
    sections.append("\n".join(req))
    return "\n\n".join(sections) + "\n", images, bool(images)


def _error_text(m) -> str:
    """Codex error messages are often JSON strings; dig out .error.message when possible."""
    if isinstance(m, dict):
        inner = m.get("error")
        if isinstance(inner, dict) and inner.get("message"):
            return str(inner["message"])
        return str(m.get("message") or json.dumps(m))
    if isinstance(m, str):
        s = m.strip()
        if s.startswith("{"):
            try:
                return _error_text(json.loads(s))
            except ValueError:
                pass
        return s
    return "" if m is None else str(m)


class ClaudeStream:
    """Maps `claude -p --output-format stream-json --include-partial-messages` lines to events.
    Only text deltas are streamed; the final `result` line carries the authoritative text."""

    def __init__(self):
        self.parts: list[str] = []
        self.finished = False
        self.gave_up = False

    def feed(self, obj: dict) -> list:
        t = obj.get("type")
        if self.finished:
            return []                      # gave up on retries (below): ignore the CLI's late lines
        if t == "system" and obj.get("subtype") == "api_retry":
            return self._retry(obj)
        if t == "stream_event":
            ev = obj.get("event") or {}
            et = ev.get("type")
            if et == "content_block_delta":
                d = ev.get("delta") or {}
                if d.get("type") == "text_delta" and d.get("text"):
                    self.parts.append(d["text"])
                    return [("delta", {"text": d["text"]})]
            elif et == "content_block_start":
                cb = ev.get("content_block") or {}
                if cb.get("type") == "tool_use":
                    name = cb.get("name") or "a tool"
                    return [("status", {"text": "Looking at the attached images…" if name == "Read" else f"Using {name}…"})]
                if cb.get("type") in ("thinking", "redacted_thinking"):
                    return [("status", {"text": "Thinking…"})]
            return []
        if t == "result":
            self.finished = True
            if obj.get("is_error") or obj.get("subtype") not in (None, "success"):
                msg = obj.get("result")
                if not isinstance(msg, str) or not msg.strip():
                    errs = obj.get("errors")
                    msg = "; ".join(str(e) for e in errs) if isinstance(errs, list) and errs else \
                        f"Claude Code stopped ({obj.get('subtype') or 'error'})."
                return [("error", {"message": msg.strip()})]
            text = obj.get("result")
            if not isinstance(text, str):
                text = "".join(self.parts)
            done = {"text": text}
            if isinstance(obj.get("usage"), dict):
                done["usage"] = obj["usage"]
            return [("done", done)]
        return []

    def _retry(self, obj: dict) -> list:
        """`{"type":"system","subtype":"api_retry","attempt":n,"max_retries":m,"error_status":…}`.
        The CLI retries ~3 minutes before it reports anything, so show the retries, and when the
        request never got an HTTP answer (error_status null: offline, DNS, refused) give up after
        CLAUDE_OFFLINE_AFTER attempts (~4 s). The message names a connection error, so
        offline_error() turns it into the friendly offline message (code "offline")."""
        try:
            n = int(obj.get("attempt") or 0)
        except (TypeError, ValueError):
            n = 0
        try:
            m = int(obj.get("max_retries") or 0)
        except (TypeError, ValueError):
            m = 0
        of = f" ({n}/{m})" if n and m else (f" ({n})" if n else "")
        if "error_status" not in obj:      # an older/newer CLI without the field: just show it
            return [("status", {"text": f"Retrying{of}…"})]
        status = obj.get("error_status")
        if status is None:
            if n >= CLAUDE_OFFLINE_AFTER:
                self.finished = self.gave_up = True
                why = obj.get("error")
                why = f" ({why})" if isinstance(why, str) and why and why != "unknown" else ""
                return [("error", {"message": f"Connection error: no answer from the Claude API after {n} attempts{why}."})]
            return [("status", {"text": f"Can't reach Claude — retrying{of}…"})]
        return [("status", {"text": f"Claude is busy (error {status}) — retrying{of}…"})]

    def finish(self, returncode, stderr_tail: str) -> list:
        if self.finished:
            return []
        msg = stderr_tail or f"Claude Code exited with code {returncode} without a reply."
        return [("error", {"message": msg})]


class CodexStream:
    """Maps `codex exec --json` lines to events. Codex sends whole messages, not tokens."""

    STATUS = {"reasoning": "Thinking…", "command_execution": "Running a command…",
              "web_search": "Searching the web…", "file_change": "Editing files…",
              "mcp_tool_call": "Using a tool…", "todo_list": "Planning…"}

    def __init__(self):
        self.messages: list[str] = []
        self.last_error: str | None = None
        self.finished = False

    def feed(self, obj: dict) -> list:
        t = obj.get("type")
        if t in ("item.started", "item.updated", "item.completed"):
            item = obj.get("item") or {}
            it = item.get("type")
            if it == "agent_message":
                if t != "item.completed":
                    return []
                text = item.get("text") or ""
                prefix = "\n\n" if self.messages else ""
                self.messages.append(text)
                return [("delta", {"text": prefix + text})] if text else []
            if it == "error":
                if t != "item.completed":
                    return []
                m = _error_text(item.get("message"))
                return [] if not m or "service tier" in m.lower() else [("notice", {"text": m})]
            if it in self.STATUS:
                return [("status", {"text": self.STATUS[it]})]
            return []
        if t == "turn.completed":
            self.finished = True
            done = {"text": "\n\n".join(self.messages)}
            if isinstance(obj.get("usage"), dict):
                done["usage"] = obj["usage"]
            return [("done", done)]
        if t == "turn.failed":
            self.finished = True
            m = _error_text((obj.get("error") or {}).get("message") if isinstance(obj.get("error"), dict) else obj.get("error"))
            return [("error", {"message": m or "Codex failed."})]
        if t == "error":
            # Usually followed by turn.failed; kept in case Codex exits without one (a
            # transient error followed by turn.completed is then simply ignored).
            self.last_error = _error_text(obj.get("message")) or self.last_error
            return []
        return []

    def finish(self, returncode, stderr_tail: str) -> list:
        if self.finished:
            return []
        msg = self.last_error or stderr_tail or f"Codex exited with code {returncode} without a reply."
        return [("error", {"message": msg})]


class AIJob:
    def __init__(self, rid: str, proc: subprocess.Popen, label: str, provider: str = "claude"):
        self.rid = rid
        self.proc = proc
        self.label = label
        self.provider = provider
        self.cancelled = False
        self._killed = False
        self._lock = threading.Lock()

    def kill(self) -> None:
        """SIGTERM the child's process group, then SIGKILL it after a short grace period."""
        with self._lock:
            if self._killed:
                return
            self._killed = True
        pgid = self.proc.pid
        try:
            os.killpg(pgid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            return

        def hard():
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass

        threading.Thread(target=hard, name="texc-ai-kill", daemon=True).start()


# ---------------------------------------------------------------------------------------------
# arXiv search
# ---------------------------------------------------------------------------------------------

ATOM = "{http://www.w3.org/2005/Atom}"
ARXIV_NS = "{http://arxiv.org/schemas/atom}"
ARXIV_API = "https://export.arxiv.org/api/query"
ARXIV_ID_RE = re.compile(r"^(?:arxiv:\s*)?(\d{4}\.\d{4,5}|[a-z][a-z.\-]*/\d{7})(v\d+)?$", re.I)
ARXIV_ADVANCED_RE = re.compile(r"\b(?:ti|au|abs|co|jr|cat|rn|id|all):|\b(?:AND|OR|ANDNOT)\b")
STOPWORDS = frozenset("""a an and are as at be by for from has have how in into is it its of on or that the
their this to was we what when which why with you your all not no do does can via using our""".split())
KEY_SKIP = frozenset("a an the on of in for and to with from at by is are towards toward via".split())


def _ws(s) -> str:
    return " ".join((s or "").split())


def _ascii(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")


def bib_key(authors: list, year: str, title: str) -> str:
    last = ""
    if authors:
        toks = [t for t in re.findall(r"[A-Za-z]+", _ascii(authors[0])) if t.lower() not in ("jr", "sr", "ii", "iii", "iv")]
        last = toks[-1].lower() if toks else ""
    words = [w.lower() for w in re.findall(r"[A-Za-z]+", _ascii(title)) if w.lower() not in KEY_SKIP]
    return (last or "arxiv") + (year or "") + (words[0] if words else "")


def bibtex_entry(it: dict, key: str) -> str:
    def esc(s: str) -> str:
        s = re.sub(r"(?<!\\)([&%#])", r"\\\1", s)
        return s if s.count("{") == s.count("}") else s.replace("{", "").replace("}", "")

    fields = [("title", esc(it["title"])), ("author", " and ".join(esc(a) for a in it["authors"])),
              ("year", it["year"]), ("eprint", it["id"]), ("archivePrefix", "arXiv"),
              ("primaryClass", it["primary"]), ("url", it["url"])]
    if it.get("doi"):
        fields.append(("doi", it["doi"]))
    fields = [(k, v) for k, v in fields if v]
    width = max(len(k) for k, _ in fields)
    body = ",\n".join(f"  {k.ljust(width)} = {{{v}}}" for k, v in fields)
    return f"@misc{{{key},\n{body}\n}}"


def parse_atom(data: bytes) -> list[dict]:
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        raise ApiError(502, "arXiv sent a response texc couldn't read. Try again in a moment.")
    items = []
    for e in root.findall(f"{ATOM}entry"):
        raw_id = _ws(e.findtext(f"{ATOM}id"))
        title = _ws(e.findtext(f"{ATOM}title"))
        if "/api/errors" in raw_id:
            raise ApiError(400, "arXiv: " + (_ws(e.findtext(f"{ATOM}summary")) or "the query was rejected."))
        aid = re.sub(r"v\d+$", "", raw_id.split("/abs/", 1)[-1])
        if not aid:
            continue
        published = _ws(e.findtext(f"{ATOM}published"))
        pc = e.find(f"{ARXIV_NS}primary_category")
        primary = pc.get("term", "") if pc is not None else ""
        if not primary:
            cat = e.find(f"{ATOM}category")
            primary = cat.get("term", "") if cat is not None else ""
        items.append({
            "id": aid, "title": title,
            "authors": [a for a in (_ws(x.findtext(f"{ATOM}name")) for x in e.findall(f"{ATOM}author")) if a],
            "year": published[:4] if re.match(r"\d{4}", published) else "",
            "summary": _ws(e.findtext(f"{ATOM}summary")),
            "url": f"https://arxiv.org/abs/{aid}", "primary": primary,
            "doi": _ws(e.findtext(f"{ARXIV_NS}doi")),
        })
    return items


class Arxiv:
    def __init__(self):
        self.lock = threading.Lock()
        self.fetch_lock = threading.Lock()    # arXiv asks for one connection at a time
        self.cache: dict = {}
        self.last_call = 0.0

    def search(self, q: str, n: int) -> list[dict]:
        key = (q, n)
        with self.lock:
            hit = self.cache.get(key)
            if hit and time.time() - hit[0] < 600:
                return [dict(i) for i in hit[1]]
        items = self._search(q, n)
        used: set = set()
        out = []
        for it in items[:n]:
            base = bib_key(it["authors"], it["year"], it["title"])
            k, i = base, 1
            while k in used:
                k = base + "abcdefghijklmnopqrstuvwxyz"[min(i, 25)]
                i += 1
            used.add(k)
            out.append({"id": it["id"], "title": it["title"], "authors": it["authors"], "year": it["year"],
                        "summary": it["summary"], "url": it["url"], "primary": it["primary"],
                        "key": k, "bibtex": bibtex_entry(it, k)})
        with self.lock:
            self.cache[key] = (time.time(), out)
            while len(self.cache) > 64:
                self.cache.pop(next(iter(self.cache)))
        return [dict(i) for i in out]

    def _search(self, q: str, n: int) -> list[dict]:
        q = " ".join(q.split())
        bare = re.sub(r"^https?://(?:export\.)?arxiv\.org/(?:abs|pdf)/", "", q, flags=re.I)
        bare = re.sub(r"\.pdf$", "", bare, flags=re.I)
        m = ARXIV_ID_RE.match(bare)
        if m:
            return self._fetch({"id_list": m.group(1) + (m.group(2) or ""), "max_results": 1})
        if ARXIV_ADVANCED_RE.search(q):            # the user wrote arXiv query syntax
            return self._fetch({"search_query": q, "max_results": n, "sortBy": "relevance"})
        if len(q) > 2 and q[0] == q[-1] == '"':
            return self._fetch({"search_query": f"all:{q}", "max_results": n, "sortBy": "relevance"})
        words = [w for w in re.split(r'[\s"():]+', q) if w.strip("-'")]
        if not words:
            return []
        # The literal `all:<words>` ORs the words and ranks poorly; an AND of the content words
        # is precise for topics. Phrase queries are often slow on arXiv's side and every extra
        # request risks its rate limit, so we make one request and lift title matches locally.
        content = [w for w in words if w.lower() not in STOPWORDS] or words
        items = self._fetch({"search_query": " AND ".join(f"all:{w}" for w in content),
                             "max_results": min(50, 2 * n), "sortBy": "relevance"})
        phrase = " ".join(re.findall(r"[\w']+", " ".join(words).lower()))
        keys = {w.lower() for w in content}

        def score(it) -> int:
            title = " ".join(re.findall(r"[\w']+", it["title"].lower()))
            hits = sum(1 for w in keys if re.search(r"(?<![\w'])" + re.escape(w) + r"(?![\w'])", title))
            return (len(keys) + 1 if phrase and phrase in title else 0) + hits

        ranked = sorted(enumerate(items), key=lambda p: (-score(p[1]), p[0]))
        return [it for _, it in ranked][:n]

    def _fetch(self, params: dict) -> list[dict]:
        url = ARXIV_API + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"User-Agent": "texc/1.0 (local LaTeX editor)"})
        with self.fetch_lock:
            for attempt in (1, 2):
                wait = self.last_call + 3.0 - time.monotonic()   # arXiv asks for 3 s between calls
                if wait > 0:
                    time.sleep(wait)
                try:
                    with urllib.request.urlopen(req, timeout=15) as resp:
                        data = resp.read(16 * 1024 * 1024)
                    break
                except urllib.error.HTTPError as e:
                    if e.code in (429, 503) and attempt == 1:
                        continue                                  # rate limited: one polite retry
                    if e.code == 429:
                        raise ApiError(502, "arXiv is rate-limiting searches right now. Wait a few seconds and try again.")
                    raise ApiError(502, f"arXiv answered with an error (HTTP {e.code}). Try again in a moment.")
                except (urllib.error.URLError, OSError) as e:
                    reason = getattr(e, "reason", None) or e
                    if isinstance(reason, (socket.timeout, TimeoutError)):
                        raise ApiError(502, "arXiv didn't answer within 15 seconds (it may be busy). Try again in a moment.")
                    raise ApiError(502, f"Couldn't reach arXiv ({reason}). Check your internet connection.")
                finally:
                    self.last_call = time.monotonic()
        return parse_atom(data)


# ---------------------------------------------------------------------------------------------
# Application state
# ---------------------------------------------------------------------------------------------

class FolderChild:
    """A `texc.py gui PATH --app` server started by /api/open-folder (browser mode). We keep its
    stdin pipe open and never write to it: when this server stops (or dies), the pipe closes
    and the child shuts down by itself."""

    def __init__(self, proc: subprocess.Popen):
        self.proc = proc
        self.url = None
        self.already_open = False
        self.lines: queue.Queue = queue.Queue()
        threading.Thread(target=self._read_stdout, name="texc-child-out", daemon=True).start()

    def _read_stdout(self) -> None:
        # Keeps draining after the handshake so the child can never block on a full pipe.
        try:
            for line in iter(self.proc.stdout.readline, b""):
                if self.lines is not None:
                    self.lines.put(line)
        except (OSError, ValueError):
            pass
        finally:
            q = self.lines
            if q is not None:
                q.put(None)

    def handshake(self, timeout: float):
        """("ready", payload) | ("error", message) | ("eof", None) | ("timeout", None)"""
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                return "timeout", None
            try:
                line = self.lines.get(timeout=left)
            except queue.Empty:
                return "timeout", None
            if line is None:
                return "eof", None
            text = line.decode("utf-8", "replace").strip()
            kind, _, payload = text.partition(" ")
            if kind not in ("TEXC_READY", "TEXC_ERROR"):
                continue
            try:
                obj = json.loads(payload)
            except ValueError:
                obj = {}
            self.lines = None                      # stop queueing; the reader keeps draining
            if kind == "TEXC_ERROR":
                return "error", str((obj or {}).get("error") or "The folder couldn't be opened.")
            return ("ready", obj) if isinstance(obj, dict) and isinstance(obj.get("url"), str) else ("error", "Bad handshake.")

    def alive(self) -> bool:
        return self.proc.poll() is None

    def close_stdin(self) -> None:
        try:
            self.proc.stdin.close()
        except (OSError, ValueError, AttributeError):
            pass

    def stop(self, wait: float = 3.0) -> None:
        self.close_stdin()
        try:
            self.proc.wait(timeout=max(0.1, wait))
            return
        except subprocess.TimeoutExpired:
            pass
        for sig, grace in ((signal.SIGTERM, 2.0), (signal.SIGKILL, 1.0)):
            try:
                os.killpg(self.proc.pid, sig)
            except (ProcessLookupError, PermissionError):
                return
            try:
                self.proc.wait(timeout=grace)
                return
            except subprocess.TimeoutExpired:
                continue

    @staticmethod
    def spawn(arg: str, lobby_url: str) -> "FolderChild":
        env = dict(os.environ)
        env["TEXC_LOBBY_URL"] = lobby_url
        env["PYTHONUNBUFFERED"] = "1"
        cmds = [[sys.executable, str(HERE / "texc.py"), "gui", arg, "--app"],
                # Fallback for a texc.py that predates --app: the server's own standalone mode.
                [sys.executable, str(HERE / "server.py"), "--app", arg]]
        last = "The folder server didn't start."
        for i, cmd in enumerate(cmds):
            try:
                proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None,
                                        env=env, start_new_session=True)
            except OSError as e:
                raise ApiError(500, f"Couldn't start texc for that folder: {e}")
            child = FolderChild(proc)
            status, payload = child.handshake(HANDSHAKE_TIMEOUT_S)
            if status == "ready":
                child.url = payload["url"]
                if payload.get("already_open"):
                    child.stop(wait=5.0)           # it exits by itself after the handshake
                    child.already_open = True
                else:
                    child.already_open = False
                return child
            child.stop(wait=1.0)
            if status == "error":
                raise ApiError(500, payload)
            if status == "timeout":
                raise ApiError(504, "texc didn't start a server for that folder within 20 seconds.")
            # EOF without a handshake. Exit code 2 is an argparse error: try the fallback.
            last = f"texc exited (code {proc.returncode}) before it was ready; see its log in the terminal."
            if i == 0 and proc.returncode == 2:
                log("texc.py doesn't accept --app yet; starting server.py --app instead")
                continue
            break
        raise ApiError(500, last)


class App:
    """One server process: a lobby (Welcome screen, project is None) or one project folder."""

    def __init__(self, project, texc_module, app_mode: bool = False):
        self.token = secrets.token_urlsafe(24)
        self.port = 0
        self.url = ""
        self.app_mode = bool(app_mode)        # the process protocol: handshake, stdin EOF, no browser
        self.lobby_url = os.environ.get("TEXC_LOBBY_URL") or None
        # Shown inside texc.app. A browser-mode child of /api/open-folder also runs with --app
        # (for the handshake), but it has TEXC_LOBBY_URL and its page is in a browser, so the
        # browser-only routes (/api/pick, /api/open-folder) keep working there.
        self.native = self.app_mode and not self.lobby_url
        self.config = config_dir()
        self.build = BuildLib(texc_module)
        self.project: Project | None = project
        self.settings = Settings(self.config / "settings.json")
        self.recent = RecentStore(self.config)
        self.hub = EventHub()
        self.fs_lock = threading.RLock()      # serialises our own writes with the watcher's scans
        self.chats_lock = threading.Lock()
        self.adopt_lock = threading.Lock()
        self.key = folder_key(project.root) if project is not None else None
        self.ui_state = UiStateStore(self.config, self.key) if project is not None else None
        self.compiler = Compiler(self) if project is not None else None
        self.watcher = Watcher(self) if project is not None else None
        self.arxiv = Arxiv()
        self.ai_jobs: dict = {}
        self.ai_lock = threading.Lock()
        self.stopping = threading.Event()
        self.children: dict = {}              # folder realpath -> FolderChild (/api/open-folder)
        self.children_lock = threading.Lock()
        self._author = None

    @property
    def mode(self) -> str:
        return "lobby" if self.project is None else "project"

    def start(self) -> None:
        if self.project is not None:
            self.watcher.start()
            self.compiler.start()

    def shutdown(self) -> None:
        self.stopping.set()
        with self.ai_lock:
            jobs = [j for j in self.ai_jobs.values() if j is not None]
        for j in jobs:
            j.cancelled = True
            j.kill()
        with self.children_lock:
            children, self.children = list(self.children.values()), {}
        for ch in children:                   # EOF on their stdin: they all start stopping now
            ch.close_stdin()
        if self.watcher is not None:
            self.watcher.stop_event.set()
        if self.compiler is not None:
            self.compiler.stop()
        self.hub.close()
        for j in jobs:
            try:
                j.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        for ch in children:
            ch.stop(wait=3.0)

    def author(self) -> str:
        if self._author is None:
            self._author = self.build.default_author()
        return self._author

    def engine(self) -> str:
        if self.project is None:
            return "pdf"
        main = self.project.main_abs
        return self.build.pick_engine(main) if main.is_file() else "pdf"

    def mains(self) -> list[str]:
        """Candidate main files for the drawer: the folder's documents (one level down when
        the folder itself has none) plus the current main if it exists."""
        root = self.project.root
        out: list[str] = []
        try:
            found = list(self.build.find_mains(root))
            if not found:
                with os.scandir(root) as it:
                    subs = sorted((e for e in it if not e.name.startswith(".") and e.name not in CHOOSE_SKIP
                                   and e.is_dir(follow_symlinks=False)), key=lambda e: e.name.lower())
                for e in subs[:200]:
                    found += self.build.find_mains(Path(e.path))
        except Exception:
            found = []
        for p in found:
            rel = self.project.to_rel(os.path.abspath(p))
            if rel and rel not in out:
                out.append(rel)
        if self.project.main_rel not in out and self.project.main_exists():
            out.insert(0, self.project.main_rel)
        return out

    def pdf_state(self):
        if not self.project.main_exists():
            return False, None
        pdf = self.project.pdf_path()
        try:
            return True, pdf.stat().st_mtime
        except OSError:
            cache = self.compiler.pdf_cache
            return (True, cache[1]) if cache is not None else (False, None)

    def set_main(self, rel: str) -> bool:
        """Switch the main file; returns True if it changed (and remembers it in recent.json)."""
        proj = self.project
        with proj.lock:
            changed = proj.main_rel != rel
            proj.main_rel = rel
        if changed:
            self.compiler.reset()
        if proj.main_exists():
            self.recent.set_main(proj.root_s, rel)
        return changed

    def maybe_adopt_main(self) -> bool:
        """While the main file doesn't exist, pick one as soon as the folder has one."""
        proj = self.project
        if proj is None or proj.main_exists():
            return False
        with self.adopt_lock:
            if proj.main_exists():
                return False
            found = self.build.choose_main(proj.root)
            if not found or found == proj.main_rel:
                return False
            log(f"main file: {found}")
            self.set_main(found)
            return True

    def changed(self, tree: bool) -> None:
        """After one of our own file operations: adopt a main if needed, tell the clients."""
        adopted = self.maybe_adopt_main()
        if tree or adopted:
            self.hub.broadcast("files", {})

    def open_folder_child(self, arg: str, folder: str) -> str:
        """URL of a server for `folder`: a running child of ours, or a new one (which may report
        that another texc already serves the folder)."""
        with self.children_lock:
            ch = self.children.get(folder)
            if ch is not None and ch.alive():
                return ch.url
            self.children.pop(folder, None)
            # Close Folder in the child goes back to the Welcome page that started this chain.
            lobby = self.url if self.project is None else (self.lobby_url or self.url)
        # Spawn outside the lock (the handshake can take seconds); a second request for the same
        # folder meanwhile is caught by the child's own one-server-per-folder check (already_open).
        ch = FolderChild.spawn(arg, lobby)
        with self.children_lock:
            other = self.children.get(folder)
            if other is not None and other.alive() and other is not ch:
                if not ch.already_open:
                    ch.stop()
                return other.url
            if not ch.already_open:
                self.children[folder] = ch
        return ch.url


# ---------------------------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------------------------

API_ROUTES = {
    "/api/project": {"GET": "api_project"},
    "/api/file": {"GET": "api_file_get", "PUT": "api_file_put"},
    "/api/file/new": {"POST": "api_file_new"},
    "/api/file/rename": {"POST": "api_file_rename"},
    "/api/file/delete": {"POST": "api_file_delete"},
    "/api/upload": {"POST": "api_upload"},
    "/api/raw": {"GET": "api_raw"},
    "/api/main": {"POST": "api_main"},
    "/api/compile": {"POST": "api_compile"},
    "/api/compile/cancel": {"POST": "api_compile_cancel"},
    "/api/pdf": {"GET": "api_pdf"},
    "/api/log": {"GET": "api_log"},
    "/api/synctex/edit": {"GET": "api_synctex_edit"},
    "/api/synctex/view": {"GET": "api_synctex_view"},
    "/api/events": {"GET": "api_events"},
    "/api/settings": {"GET": "api_settings_get", "PUT": "api_settings_put"},
    "/api/chats": {"GET": "api_chats_list"},
    "/api/ai": {"POST": "api_ai"},
    "/api/ai/cancel": {"POST": "api_ai_cancel"},
    "/api/arxiv": {"GET": "api_arxiv"},
    "/api/cite": {"POST": "api_cite"},
    "/api/wordcount": {"POST": "api_wordcount"},
    "/api/open-pdf": {"POST": "api_open_pdf"},
    "/api/clean": {"POST": "api_clean"},
    # docs/ARCHITECTURE.md
    "/api/lobby": {"GET": "api_lobby"},
    "/api/lobby/new": {"POST": "api_lobby_new"},
    "/api/lobby/background": {"GET": "api_lobby_bg_get", "POST": "api_lobby_bg_set"},
    "/api/recent": {"GET": "api_recent"},
    "/api/recent/forget": {"POST": "api_recent_forget"},
    "/api/ui-state": {"POST": "api_ui_state", "PUT": "api_ui_state"},
    "/api/pick": {"POST": "api_pick"},
    "/api/open-folder": {"POST": "api_open_folder"},
    "/api/scaffold": {"POST": "api_scaffold"},
    "/api/reveal": {"POST": "api_reveal"},
}
# Everything else is project-only and answers 404 "No folder is open." in lobby mode.
BOTH_MODES = frozenset(("/api/recent", "/api/recent/forget", "/api/pick", "/api/open-folder",
                        "/api/settings", "/api/events"))
LOBBY_ONLY = frozenset(("/api/lobby", "/api/lobby/new", "/api/lobby/background"))

LOBBY_PLACEHOLDER = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="texc-token" content="__TEXC_TOKEN__">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>texc</title>
<style>html,body{background:#000;color:#e6e6e6;margin:0;height:100%;font:15px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:18vh 24px}h1{font-size:28px;font-weight:600;margin:0 0 8px}
p{color:#a0a0a0}code{color:#e6e6e6}</style></head>
<body><main><h1>texc</h1><p>No folder is open. Start texc with a folder: <code>texc gui FOLDER</code></p></main></body></html>
"""

QUIET_ERRORS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, socket.timeout, TimeoutError)


class TexcHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    # server_close() must not wait for handler threads: serve() closes the listening socket
    # before app.shutdown() ends the SSE streams (an open page would otherwise hang the quit).
    block_on_close = False
    allow_reuse_address = True
    request_queue_size = 128      # the page fires ~30 requests at once and each closes its connection
    app: App

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, QUIET_ERRORS):
            return
        log(f"connection error: {exc!r}")


class Handler(BaseHTTPRequestHandler):
    server_version = "texc"
    sys_version = ""
    protocol_version = "HTTP/1.0"     # one response per connection; streams end by closing
    timeout = 30
    disable_nagle_algorithm = True

    # -- plumbing ---------------------------------------------------------------------------

    @property
    def app(self) -> App:
        return self.server.app

    def handle(self):
        try:
            super().handle()
        except QUIET_ERRORS:
            pass

    def log_message(self, fmt, *args):   # quiet: we log one line per API call ourselves
        pass

    def version_string(self):
        return "texc"

    def send_response(self, code, message=None):
        self._status = code
        super().send_response(code, message)

    def end_headers(self):
        self._headers_done = True
        super().end_headers()

    def _common_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "SAMEORIGIN")

    def _send_bytes(self, status: int, data: bytes, ctype: str, headers: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self._common_headers()
        self.end_headers()
        if self.command != "HEAD" and data:
            self.wfile.write(data)

    def _send_json(self, status: int, obj) -> None:
        data = json.dumps(jsonable(obj), ensure_ascii=False).encode("utf-8")
        self._send_bytes(status, data, "application/json; charset=utf-8", {"Cache-Control": "no-store"})

    def _send_file(self, path: Path, ctype: str, headers: dict | None = None, cache: str = "no-cache") -> None:
        with open(path, "rb") as f:
            st = os.fstat(f.fileno())
            tag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
            if self.headers.get("If-None-Match") == tag:
                self.send_response(304)
                self.send_header("ETag", tag)
                self.send_header("Cache-Control", cache)
                self._common_headers()
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(st.st_size))
            self.send_header("Cache-Control", cache)
            self.send_header("ETag", tag)
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self._common_headers()
            self.end_headers()
            shutil.copyfileobj(f, self.wfile, 256 * 1024)

    def _start_stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self._common_headers()
        self.end_headers()
        self.close_connection = True

    def _client_gone(self) -> bool:
        """True once the peer has closed its end (EOF is readable without consuming data)."""
        try:
            r, _, x = select.select([self.connection], [], [self.connection], 0)
        except (OSError, ValueError):
            return True
        if x:
            return True
        if not r:
            return False
        try:
            return self.connection.recv(1, socket.MSG_PEEK) == b""
        except (BlockingIOError, InterruptedError, socket.timeout):
            return False
        except OSError:
            return True

    def _json_body(self) -> dict:
        length = to_int(self.headers.get("Content-Length"), 0)
        if length < 0:
            raise ApiError(400, "Invalid Content-Length.")
        if length > MAX_BODY:
            self.close_connection = True
            raise ApiError(413, "The request is too large.")
        raw = self.rfile.read(length) if length else b""
        if not raw.strip():
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ApiError(400, "The request body is not valid JSON.")
        if not isinstance(data, dict):
            raise ApiError(400, "The request body must be a JSON object.")
        return data

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").strip().lower()
        port = self.app.port
        return host in (f"127.0.0.1:{port}", f"localhost:{port}")

    def _token_ok(self, query_token) -> bool:
        given = self.headers.get("X-Texc-Token") or query_token or ""
        return hmac.compare_digest(given.encode("utf-8", "replace"), self.app.token.encode("ascii"))

    # -- dispatch ---------------------------------------------------------------------------

    def do_GET(self):
        self._dispatch()

    def do_POST(self):
        self._dispatch()

    def do_PUT(self):
        self._dispatch()

    def do_DELETE(self):
        self._dispatch()

    def do_HEAD(self):
        self._dispatch()

    def do_OPTIONS(self):
        self._dispatch()

    def do_PATCH(self):
        self._dispatch()

    def _dispatch(self) -> None:
        t0 = time.monotonic()
        self._status = 0
        self._headers_done = False
        method = self.command
        url = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(url.path)
        is_api = path == "/api" or path.startswith("/api/")
        try:
            if not self._host_ok():
                self._send_json(403, {"error": "Forbidden: unexpected Host header."})
                return
            if is_api:
                query = {k: v[-1] for k, v in urllib.parse.parse_qs(url.query, keep_blank_values=True).items()}
                if not self._token_ok(query.get("token")):
                    self._send_json(401, {"error": "Missing or invalid texc token. Reload the page."})
                    return
                self._route_api(method, path, query)
            else:
                self._route_static(method, path)
        except ApiError as e:
            if not self._headers_done:
                self._send_json(e.status, {"error": e.message, **e.extra})
        except QUIET_ERRORS:
            self.close_connection = True
        except Exception as e:
            log(f"internal error in {method} {path}: {e!r}")
            traceback.print_exc(file=sys.stderr)
            if not self._headers_done:
                try:
                    self._send_json(500, {"error": f"Internal server error: {type(e).__name__}: {e}"})
                except OSError:
                    pass
            self.close_connection = True
        finally:
            if is_api and path != "/api/events":
                log(f"{method} {path} {self._status or '-'} {time.monotonic() - t0:.2f}s")

    def _route_api(self, method: str, path: str, query: dict) -> None:
        known = path in API_ROUTES or path.startswith("/api/chats/")
        if known and self.app.project is None and path not in BOTH_MODES and path not in LOBBY_ONLY:
            raise ApiError(404, NO_FOLDER)
        if self.app.project is not None and path in LOBBY_ONLY:
            raise ApiError(404, "That is only available on the Welcome screen.")
        if path.startswith("/api/chats/"):
            cid = path[len("/api/chats/"):]
            fn = {"GET": self.api_chat_get, "PUT": self.api_chat_put, "DELETE": self.api_chat_delete}.get(method)
            if fn is None:
                raise ApiError(405, "Method not allowed.")
            result = fn(cid, self._json_body() if method == "PUT" else {})
        else:
            entry = API_ROUTES.get(path)
            if entry is None:
                raise ApiError(404, f"Unknown API endpoint {path}.")
            name = entry.get(method)
            if name is None:
                raise ApiError(405, "Method not allowed.")
            body = self._json_body() if method in ("POST", "PUT") else {}
            result = getattr(self, name)(query, body)
        if not self._headers_done:
            self._send_json(200, {} if result is None else result)

    def _route_static(self, method: str, path: str) -> None:
        if method != "GET":
            raise ApiError(405, "Method not allowed.")
        lobby = self.app.project is None
        if path in ("/", "/index.html") or (lobby and path == "/welcome.html"):
            page = GUI_DIR / ("welcome.html" if lobby else "index.html")
            try:
                html = page.read_text("utf-8")
            except OSError:
                if not lobby:
                    raise ApiError(500, f"The GUI is missing: {page}")
                html = LOBBY_PLACEHOLDER           # the Welcome page isn't installed
            data = html.replace("__TEXC_TOKEN__", self.app.token).encode("utf-8")
            self._send_bytes(200, data, "text/html; charset=utf-8", {"Cache-Control": "no-store"})
            return
        if path == "/favicon.ico":
            self._send_bytes(204, b"", "image/x-icon", {"Cache-Control": "no-cache"})
            return
        if not path.startswith(("/css/", "/js/", "/vendor/")) or "\x00" in path:
            raise ApiError(404, "Not found.")
        gui_real = os.path.realpath(GUI_DIR)
        target = os.path.realpath(os.path.join(gui_real, path.lstrip("/")))
        if not target.startswith(gui_real + os.sep) or not os.path.isfile(target):
            raise ApiError(404, "Not found.")
        ctype = STATIC_MIME.get(os.path.splitext(target)[1].lower(), "application/octet-stream")
        self._send_file(Path(target), ctype)

    # -- project and files ------------------------------------------------------------------

    def api_project(self, q, body):
        app, proj = self.app, self.app.project
        has_pdf, pdf_mtime = app.pdf_state()
        return {
            "name": proj.root.name, "root": str(proj.root), "main": proj.main_rel,
            "engine": app.engine(), "files": proj.listing(), "settings": app.settings.get(),
            "ai": {"providers": ai_providers()}, "has_pdf": has_pdf,
            "last_result": app.compiler.last,
            # docs/ARCHITECTURE.md
            "mode": "project", "folder": str(proj.root), "main_exists": proj.main_exists(),
            "ui_state": app.ui_state.get(), "app": app.native, "lobby_url": app.lobby_url,
            # extras: the URL of the current PDF, and candidate main files for the drawer selector
            "pdf_url": f"/api/pdf?v={pdf_mtime}" if has_pdf else None,
            "mains": app.mains(),
        }

    def api_file_get(self, q, body):
        abs_path, rel = self.app.project.resolve(q.get("path"))
        with fs_errors():
            if abs_path.is_dir():
                raise ApiError(400, "That path is a folder.")
            if not abs_path.exists():
                raise ApiError(404, f"No such file: {rel}")
            if not is_text_path(rel):
                raise ApiError(415, f"{rel} is a binary file; use /api/raw.")
            with open(abs_path, "rb") as f:
                st = os.fstat(f.fileno())      # the mtime that matches exactly what we read
                if st.st_size > MAX_TEXT_READ:
                    raise ApiError(413, f"{rel} is too large to edit here.")
                data = f.read()
        return {"path": rel, "content": data.decode("utf-8", "replace"), "mtime": st.st_mtime}

    def api_file_put(self, q, body):
        app = self.app
        abs_path, rel = app.project.resolve(body.get("path"))
        content = body.get("content")
        if not isinstance(content, str):
            raise ApiError(400, "content must be a string.")
        base = body.get("base_mtime")
        if base is not None and (isinstance(base, bool) or not isinstance(base, (int, float))):
            try:
                base = float(base)
            except (TypeError, ValueError):
                raise ApiError(400, "base_mtime must be a number.")
        data = content.encode("utf-8", "replace")
        with fs_errors(), app.fs_lock:
            if abs_path.is_dir():
                raise ApiError(400, "That path is a folder.")
            existed = abs_path.exists()
            if existed and not is_text_path(rel):
                raise ApiError(415, f"{rel} is a binary file; it can't be overwritten with text.")
            if base is not None and existed:
                disk = abs_path.stat().st_mtime
                if disk > float(base) + 1e-6:
                    raise ApiError(409, "changed on disk", mtime=disk)
            atomic_write(abs_path, data)
            st = abs_path.stat()
            app.watcher.note_write(rel, st, data)
        app.changed(tree=not existed)
        return {"path": rel, "mtime": st.st_mtime}

    def api_file_new(self, q, body):
        app = self.app
        abs_path, rel = app.project.resolve(body.get("path"))
        kind = body.get("type") or "file"
        if kind not in ("file", "dir"):
            raise ApiError(400, 'type must be "file" or "dir".')
        with fs_errors(), app.fs_lock:
            if abs_path.exists() or abs_path.is_symlink():
                raise ApiError(409, f"{rel} already exists.")
            if kind == "dir":
                abs_path.mkdir(parents=True)
            else:
                abs_path.parent.mkdir(parents=True, exist_ok=True)
                with open(abs_path, "x", encoding="utf-8"):
                    pass
            app.watcher.absorb([rel])
        app.changed(tree=True)
        return {"path": rel}

    def api_file_rename(self, q, body):
        app, proj = self.app, self.app.project
        src_abs, src = proj.resolve(body.get("from"))
        dst_abs, dst = proj.resolve(body.get("to"))
        with fs_errors(), app.fs_lock:
            if not (src_abs.exists() or src_abs.is_symlink()):
                raise ApiError(404, f"No such file: {src}")
            if src == dst:
                return {"path": dst}
            if dst.startswith(src + "/"):
                raise ApiError(400, "A folder can't be moved into itself.")
            if dst_abs.exists() or dst_abs.is_symlink():
                # Allow case-only renames on case-insensitive disks (intro.tex -> Intro.tex).
                same = src.lower() == dst.lower() and dst_abs.exists() and os.path.samefile(src_abs, dst_abs)
                if not same:
                    raise ApiError(409, f"{dst} already exists.")
            dst_abs.parent.mkdir(parents=True, exist_ok=True)
            os.rename(src_abs, dst_abs)
            app.watcher.absorb([src, dst])
        new_main = None
        with proj.lock:
            if proj.main_rel == src or proj.main_rel.startswith(src + "/"):
                cand = dst + proj.main_rel[len(src):]
                if ext_of(cand) in MAIN_EXTS:
                    proj.main_rel = new_main = cand
        if new_main is not None and proj.main_exists():
            app.recent.set_main(proj.root_s, new_main)
        app.changed(tree=True)
        return {"path": dst}

    def api_file_delete(self, q, body):
        app, proj = self.app, self.app.project
        abs_path, rel = proj.resolve(body.get("path"))
        if proj.main_rel == rel or proj.main_rel.startswith(rel + "/"):
            raise ApiError(409, f"{rel} is (or contains) the main file. Set another main file first.")
        with fs_errors(), app.fs_lock:
            if not (abs_path.exists() or abs_path.is_symlink()):
                raise ApiError(404, f"No such file: {rel}")
            trashed = self._trash(abs_path)
            app.watcher.absorb([rel])
        app.changed(tree=True)
        return {"trashed": trashed}

    def _trash(self, abs_path: Path, prefix: str = "") -> str:
        """Move a file or folder to .texc/trash/<stamp>-<name>; returns the root-relative path."""
        trash = self.app.project.texc_dir() / "trash"
        trash.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        name = f"{stamp}-{prefix}{abs_path.name}"
        n = 2
        while (trash / name).exists() or (trash / name).is_symlink():
            name = f"{stamp}-{n}-{prefix}{abs_path.name}"
            n += 1
        shutil.move(str(abs_path), str(trash / name))
        return f"{BUILD_DIR}/trash/{name}"

    def api_upload(self, q, body):
        app = self.app
        abs_path, rel = app.project.resolve(body.get("path"), allow_uploads=True)
        b64 = body.get("data_base64")
        if not isinstance(b64, str):
            raise ApiError(400, "data_base64 must be a string.")
        if b64.startswith("data:") and "," in b64[:200]:
            b64 = b64.split(",", 1)[1]          # tolerate a data: URL
        if len(b64) > (MAX_UPLOAD // 3 + 2) * 4 + 1024:
            raise ApiError(413, "Uploads are limited to 25 MB.")
        try:
            data = base64.b64decode(b64, validate=False)
        except (binascii.Error, ValueError):
            raise ApiError(400, "data_base64 is not valid base64.")
        if len(data) > MAX_UPLOAD:
            raise ApiError(413, "Uploads are limited to 25 MB.")
        with fs_errors(), app.fs_lock:
            if abs_path.is_dir():
                raise ApiError(409, f"{rel} is a folder.")
            if abs_path.exists() and not rel.lower().startswith(f"{BUILD_DIR}/uploads/"):
                self._trash(abs_path)            # replacing a file keeps the old one recoverable
            atomic_write(abs_path, data)
        # Not recorded as our own write: the watcher reports it (so an open editor tab reloads).
        return {"path": rel}

    def api_raw(self, q, body):
        abs_path, rel = self.app.project.resolve(q.get("path"), allow_uploads=True)
        if not abs_path.is_file():
            raise ApiError(404, f"No such file: {rel}")
        if is_text_path(rel):
            ctype = "text/plain; charset=utf-8"
        else:
            ctype = STATIC_MIME.get("." + ext_of(rel), "application/octet-stream")
            if ctype.startswith(("text/html", "text/javascript")):
                ctype = "text/plain; charset=utf-8"
        headers = {
            # Project files are untrusted: never let them run script in our origin.
            "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
            "Content-Disposition": f"inline; filename*=UTF-8''{urllib.parse.quote(abs_path.name)}",
        }
        try:
            self._send_file(abs_path, ctype, headers)
        except (FileNotFoundError, PermissionError, IsADirectoryError):
            raise ApiError(404, f"Can't read {rel}.")

    def api_main(self, q, body):
        app, proj = self.app, self.app.project
        abs_path, rel = proj.resolve(body.get("path"))
        if not abs_path.is_file():
            raise ApiError(404, f"No such file: {rel}")
        if ext_of(rel) not in MAIN_EXTS:
            raise ApiError(400, "The main file must be a .tex file.")
        app.set_main(rel)          # also remembered as the folder's main in recent.json
        return {"main": rel}

    # -- compile ------------------------------------------------------------------------------

    def api_compile(self, q, body):
        app = self.app
        if not app.build.ok and app.project.main_exists():   # a missing main still answers no_main
            raise ApiError(503, f"Compiling is unavailable: {app.build.problem}.")
        engine = body.get("engine")
        if engine in (None, "", "auto"):
            engine = None
        elif engine not in ENGINES:
            raise ApiError(400, "engine must be pdf, xe or lua.")
        return app.compiler.request(engine, wait=True)

    def api_compile_cancel(self, q, body):
        return {"cancelled": self.app.compiler.cancel()}

    def api_pdf(self, q, body):
        data, _ = self.app.compiler.pdf_bytes()
        if data is None:
            raise ApiError(404, "No PDF yet — press Compile.")
        headers = {"Cache-Control": "no-store"}
        if q.get("download") in ("1", "true", "yes"):
            name = self.app.project.stem() + ".pdf"
            ascii_name = name.encode("ascii", "replace").decode("ascii").replace('"', "_")
            headers["Content-Disposition"] = (f'attachment; filename="{ascii_name}"; '
                                              f"filename*=UTF-8''{urllib.parse.quote(name)}")
        self._send_bytes(200, data, "application/pdf", headers)

    def api_log(self, q, body):
        p = self.app.project.log_path()
        try:
            data = p.read_bytes()[-(16 * 1024 * 1024):] if p.is_file() else b""
        except OSError:
            data = b""
        return {"text": data.decode("utf-8", "replace"), "output": self.app.compiler.last_output}

    def api_clean(self, q, body):
        app = self.app
        if not app.build.ok:
            raise ApiError(503, f"Cleaning is unavailable: {app.build.problem}.")
        with fs_errors():
            removed = app.compiler.clean()
        return {"removed": removed}

    # -- SyncTeX ------------------------------------------------------------------------------

    def _synctex(self, args: list) -> str:
        tool = find_tool("synctex")
        if not tool:
            raise ApiError(501, "synctex is not installed (it ships with TeX Live).")
        try:
            proc = subprocess.run([tool] + args, capture_output=True, timeout=15, stdin=subprocess.DEVNULL,
                                  cwd=str(self.app.project.base()))
        except subprocess.TimeoutExpired:
            raise ApiError(504, "synctex took too long.")
        except OSError as e:
            raise ApiError(500, f"Couldn't run synctex: {e}")
        return proc.stdout.decode("utf-8", "replace")

    def _source_rel(self, input_path: str) -> str | None:
        """Map a SyncTeX Input: path to a project file. Handles projects that were moved or
        copied since the last build (SyncTeX then still records the old absolute path)."""
        proj = self.app.project
        raw = input_path.strip()
        if not os.path.isabs(raw):
            raw = os.path.join(str(proj.base()), raw)
        if "/./" in raw:
            # TeX records files it opened by a relative name as <cwd>/./<name>; <cwd> is the
            # folder of the main file, so the tail locates the file even after a move or copy.
            tail = posixpath.normpath(raw.split("/./", 1)[1])
            cand = posixpath.normpath(posixpath.join(proj.base_rel(), tail)) if proj.base_rel() else tail
            hit = proj.try_resolve(cand)
            if hit is not None and hit[0].is_file():
                return hit[1]
        norm = posixpath.normpath(raw)
        rel = proj.to_rel(norm)
        if rel is not None:
            return rel if os.path.isfile(proj.root / rel) else None
        if os.path.exists(norm):
            return None                                  # a real file outside the project (a .sty)
        parts = [p for p in norm.split("/") if p]
        for i in range(1, len(parts)):                   # longest suffix that exists in the project
            cand = "/".join(parts[i:])
            if proj.try_resolve(cand) and (proj.root / cand).is_file():
                return cand
        return None

    def api_synctex_edit(self, q, body):
        proj = self.app.project
        try:
            page = int(q.get("page", ""))
            x = float(q.get("x", ""))
            y = float(q.get("y", ""))
        except ValueError:
            raise ApiError(400, "page, x and y are required numbers.")
        if page < 1 or x != x or y != y:
            raise ApiError(400, "Invalid position.")
        pdf = proj.pdf_path()
        if not pdf.is_file():
            raise ApiError(404, "No PDF yet.")
        out = self._synctex(["edit", "-o", f"{page}:{x:.3f}:{y:.3f}:{pdf}", "-d", str(proj.build_dir())])
        rec: dict = {}
        for line in out.splitlines():
            key, sep, val = line.partition(":")
            if not sep:
                continue
            if key == "Input" and "Input" in rec:
                break                                    # only the first record
            if key in ("Input", "Line", "Column") and key not in rec:
                rec[key] = val
        if "Input" not in rec:
            raise ApiError(404, "No source location for that spot.")
        rel = self._source_rel(rec["Input"])
        if rel is None:
            raise ApiError(404, "That spot comes from a file outside the project.")
        return {"path": rel, "line": max(1, to_int(rec.get("Line"), 1)), "column": max(0, to_int(rec.get("Column"), 0))}

    def api_synctex_view(self, q, body):
        proj = self.app.project
        abs_path, rel = proj.resolve(q.get("path"))
        line = to_int(q.get("line"), 0)
        column = max(0, to_int(q.get("column"), 0))
        if line < 1:
            raise ApiError(400, "line must be a 1-based line number.")
        pdf = proj.pdf_path()
        if not pdf.is_file():
            raise ApiError(404, "No PDF yet.")
        out = self._synctex(["view", "-i", f"{line}:{column}:{abs_path}", "-o", str(pdf)])
        rec: dict = {}
        for ln in out.splitlines():
            key, sep, val = ln.partition(":")
            if not sep:
                continue
            if key == "Page" and "Page" in rec:
                break
            if key in ("Page", "x", "y", "h", "v", "W", "H") and key not in rec:
                rec[key] = val.strip()
        if "Page" not in rec:
            raise ApiError(404, "That line has no position in the PDF.")
        result = {"page": to_int(rec["Page"], 1)}
        for k in ("x", "y", "h", "v", "W", "H"):
            try:
                result[k] = float(rec.get(k, "0"))
            except ValueError:
                result[k] = 0.0
        return result

    # -- events -------------------------------------------------------------------------------

    def api_events(self, q, body):
        app = self.app
        sub = app.hub.subscribe()
        try:
            self._start_stream()
            self.wfile.write(sse_bytes("hello", {}))
            while not app.stopping.is_set():
                try:
                    msg = sub.q.get(timeout=SSE_PING_S)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    continue
                if msg is None or sub.dead:
                    break
                self.wfile.write(msg)
        except (OSError, ValueError):
            pass
        finally:
            app.hub.unsubscribe(sub)

    # -- settings and chats -------------------------------------------------------------------

    def api_settings_get(self, q, body):
        return self.app.settings.get()

    def api_settings_put(self, q, body):
        return self.app.settings.update(body)

    def _chat_path(self, cid: str) -> Path:
        if not CHAT_ID_RE.match(cid or ""):
            raise ApiError(400, "Invalid chat id.")
        return self.app.project.texc_dir() / "chats" / f"{cid}.json"

    def api_chats_list(self, q, body):
        folder = self.app.project.texc_dir() / "chats"
        out = []
        with self.app.chats_lock:
            try:
                paths = sorted(folder.glob("*.json"))
            except OSError:
                paths = []
            for p in paths:
                if not CHAT_ID_RE.match(p.stem):
                    continue
                try:
                    data = json.loads(p.read_text("utf-8"))
                    if not isinstance(data, dict):
                        continue
                    updated = data.get("updated")
                    if isinstance(updated, bool) or not isinstance(updated, (int, float)):
                        updated = p.stat().st_mtime
                except (OSError, ValueError):
                    continue
                out.append({"id": p.stem, "title": str(data.get("title") or "New chat"), "updated": updated})
        out.sort(key=lambda c: c["updated"], reverse=True)
        return out

    def api_chat_get(self, cid, body):
        p = self._chat_path(cid)
        with self.app.chats_lock:
            try:
                data = json.loads(p.read_text("utf-8"))
            except FileNotFoundError:
                return {}
            except (OSError, ValueError):
                raise ApiError(500, "That chat file is unreadable.")
        return data if isinstance(data, dict) else {}

    def api_chat_put(self, cid, body):
        p = self._chat_path(cid)
        messages = body.get("messages", [])
        if not isinstance(messages, list):
            raise ApiError(400, "messages must be a list.")
        chat = dict(body)
        chat["id"] = cid
        chat["title"] = str(body.get("title") or "New chat")[:200]
        chat["messages"] = messages
        now = time.time()
        with self.app.chats_lock:
            if not isinstance(chat.get("created"), (int, float)) or isinstance(chat.get("created"), bool):
                try:
                    old = json.loads(p.read_text("utf-8"))
                    chat["created"] = old.get("created", now) if isinstance(old, dict) else now
                except (OSError, ValueError):
                    chat["created"] = now
            chat["updated"] = now          # seconds since the epoch, like every mtime in this API
            data = json.dumps(jsonable(chat), ensure_ascii=False).encode("utf-8")
            if len(data) > 20 * 1024 * 1024:
                raise ApiError(413, "That chat is too large to save.")
            with fs_errors():
                atomic_write(p, data)
        return chat

    def api_chat_delete(self, cid, body):
        p = self._chat_path(cid)
        with self.app.chats_lock, fs_errors():
            if p.exists():
                self._trash(p, prefix="chat-")
        return {}

    # -- AI -----------------------------------------------------------------------------------

    def api_ai(self, q, body):
        app = self.app
        settings = app.settings.get()
        provider = body.get("provider") or settings.get("provider")
        if provider == "off":
            raise ApiError(400, "AI is turned off. Choose a provider in Settings.")
        if provider not in ("claude", "codex"):
            raise ApiError(400, "provider must be claude or codex.")
        label = "Claude Code" if provider == "claude" else "Codex"
        tool = find_tool(provider, "TEXC_" + provider.upper())
        if not tool:
            raise ApiError(503, f"The {label} CLI ({provider}) was not found. Install it or choose another provider in Settings.")
        model = body.get("model") or (settings.get("model") or {}).get(provider)
        if provider == "codex" and (not model or model == "default"):
            model = codex_models()[0]
        model = model or "default"
        if not isinstance(model, str) or not MODEL_RE.match(model):
            raise ApiError(400, "Invalid model name.")
        effort = body.get("effort") or settings.get("effort") or "medium"
        if effort not in EFFORTS:
            raise ApiError(400, "effort must be low, medium or high.")
        rid = body.get("request_id") or ("r-" + secrets.token_hex(6))
        if not isinstance(rid, str) or not REQUEST_ID_RE.match(rid):
            raise ApiError(400, "Invalid request_id.")
        proj = app.project
        prompt, images, use_read = build_prompt(proj, provider, body)

        if provider == "claude":
            cmd = [tool, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
            cmd += ["--tools", "Read", "--allowedTools", "Read"] if use_read else ["--tools", ""]
            cmd += ["--strict-mcp-config", "--no-session-persistence", "--system-prompt", SYSTEM_PROMPT]
            if model != "default":
                cmd += ["--model", model]
            parser = ClaudeStream()
        else:
            cmd = [tool, "exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only",
                   "-C", str(proj.root), "-m", model, "-c", f"model_reasoning_effort={effort}"]
            for img in images:
                cmd += ["-i", img]
            parser = CodexStream()

        with app.ai_lock:
            if rid in app.ai_jobs:
                raise ApiError(409, "A request with this id is already running.")
            app.ai_jobs[rid] = None            # reserve the id while spawning
        job = None
        try:
            try:
                proc = subprocess.Popen(cmd, cwd=str(proj.root), env=child_env(), stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            except OSError as e:
                raise ApiError(500, f"Couldn't start {label}: {e}")
            job = AIJob(rid, proc, label, provider)
            with app.ai_lock:
                app.ai_jobs[rid] = job
            self._stream_ai(job, prompt.encode("utf-8", "replace"), parser)
        finally:
            with app.ai_lock:
                app.ai_jobs.pop(rid, None)
            if job is not None:
                if job.proc.poll() is None:
                    job.kill()
                else:
                    try:                       # reap helpers the CLI may have left in its group
                        os.killpg(job.proc.pid, signal.SIGTERM)
                    except (ProcessLookupError, PermissionError):
                        pass
                for pipe in (job.proc.stdin, job.proc.stdout, job.proc.stderr):
                    try:
                        pipe.close()
                    except (OSError, ValueError):
                        pass
                try:
                    job.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
        return None

    def _stream_ai(self, job: AIJob, prompt: bytes, parser) -> None:
        proc = job.proc
        lines: queue.Queue = queue.Queue()
        err_tail = bytearray()
        debug_path = os.environ.get("TEXC_DEBUG_AI")   # optional: append raw CLI output here

        def feed_stdin():
            try:
                proc.stdin.write(prompt)
            except (OSError, ValueError):
                pass
            finally:
                try:
                    proc.stdin.close()
                except (OSError, ValueError):
                    pass

        def read_stdout():
            try:
                for line in iter(proc.stdout.readline, b""):
                    lines.put(line)
            except (OSError, ValueError):
                pass
            finally:
                lines.put(None)

        def read_stderr():
            try:
                for chunk in iter(lambda: proc.stderr.read1(8192), b""):
                    err_tail.extend(chunk)
                    if len(err_tail) > 65536:
                        del err_tail[:-32768]
            except (OSError, ValueError):
                pass

        for fn in (feed_stdin, read_stdout, read_stderr):
            threading.Thread(target=fn, name="texc-ai-io", daemon=True).start()

        self._start_stream()
        alive = True
        last_write = time.monotonic()

        def emit(name: str, data) -> bool:
            nonlocal alive, last_write
            if not alive:
                return False
            if name == "error" and isinstance(data, dict):
                data = offline_error(job.provider, data)     # "Can't reach Claude — …", code "offline"
            try:
                self.wfile.write(sse_bytes(name, data))
                last_write = time.monotonic()
                return True
            except (OSError, ValueError):
                alive = False
                return False

        finished = False
        timed_out = False
        last_status = "Thinking…"
        if not emit("status", {"text": last_status}):
            job.kill()
        deadline = time.monotonic() + AI_TIMEOUT_S
        while True:
            try:
                item = lines.get(timeout=0.5)
            except queue.Empty:
                if alive and self._client_gone():
                    alive = False
                if not alive:
                    job.kill()                 # client disconnected: stop the CLI
                    break
                if not timed_out and time.monotonic() > deadline:
                    timed_out = True
                    job.kill()
                elif time.monotonic() - last_write > 10:
                    try:
                        self.wfile.write(b": ping\n\n")
                        last_write = time.monotonic()
                    except (OSError, ValueError):
                        alive = False
                continue
            if item is None:
                break
            if debug_path:
                try:
                    with open(debug_path, "ab") as f:
                        f.write(item)
                except OSError:
                    pass
            text = item.decode("utf-8", "replace").strip()
            if not text.startswith("{"):
                continue
            try:
                obj = json.loads(text)
            except ValueError:
                continue
            if not isinstance(obj, dict):
                continue
            for name, data in parser.feed(obj):
                if finished:
                    break
                if name == "status":
                    if data.get("text") == last_status:
                        continue                   # Codex repeats statuses per item update
                    last_status = data.get("text")
                elif name == "delta":
                    last_status = None
                if name in ("done", "error"):
                    finished = True
                if not emit(name, data):
                    job.kill()
                    break
            if not alive:
                break
            if getattr(parser, "gave_up", False):
                if proc.poll() is None:
                    job.kill()                 # we stopped waiting on the CLI's retries: stop it too
                break
        try:
            rc = proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            job.kill()
            rc = None
        if alive and not finished:
            if job.cancelled:
                emit("error", {"message": "Cancelled."})
            elif timed_out:
                emit("error", {"message": f"{job.label} took longer than {AI_TIMEOUT_S // 60} minutes and was stopped."})
            else:
                tail = err_tail.decode("utf-8", "replace")
                tail = "\n".join(l for l in tail.splitlines() if l.strip() and "Reading prompt from stdin" not in l)
                for name, data in parser.finish(rc, tail[-2000:].strip()):
                    emit(name, data)

    def api_ai_cancel(self, q, body):
        rid = body.get("request_id")
        with self.app.ai_lock:
            job = self.app.ai_jobs.get(rid) if isinstance(rid, str) else None
        if job is None:
            return {"cancelled": False}
        job.cancelled = True
        job.kill()
        return {"cancelled": True}

    # -- literature, citations, tools ----------------------------------------------------------

    def api_arxiv(self, q, body):
        query = (q.get("q") or "").strip()
        if not query:
            raise ApiError(400, "Type something to search for.")
        if len(query) > 500:
            raise ApiError(400, "That search is too long.")
        n = min(max(to_int(q.get("max"), 15), 1), 50)
        return {"items": self.app.arxiv.search(query, n)}

    def api_cite(self, q, body):
        app, proj = self.app, self.app.project
        bibtex = body.get("bibtex")
        if not isinstance(bibtex, str) or not bibtex.strip():
            raise ApiError(400, "bibtex is required.")
        if len(bibtex) > 200 * 1024:
            raise ApiError(413, "That BibTeX entry is too large.")
        entry = bibtex.strip()
        m = re.match(r"@\s*(\w+)\s*([{(])\s*([^,\s]*)\s*,", entry)
        if not m:
            raise ApiError(400, "bibtex must be one entry like @article{key, ...}.")
        key = body.get("key") or m.group(3)
        if not isinstance(key, str) or not BIB_KEY_RE.match(key):
            raise ApiError(400, "Invalid citation key.")
        if m.group(3) != key:                    # make the entry use the requested key
            entry = entry[:m.start(3)] + key + entry[m.end(3):]
        refs = bib_refs(proj, [proj.main_rel]) or bib_refs(proj, reachable_tex(proj))
        rel = refs[0] if refs else posixpath.normpath(posixpath.join(proj.base_rel(), "refs.bib"))
        hit = proj.try_resolve(rel)
        if hit is None:
            raise ApiError(400, f"The bibliography {rel} is outside the project.")
        abs_path, rel = hit
        with fs_errors(), app.fs_lock:
            created = not abs_path.exists()
            current = "" if created else abs_path.read_bytes().decode("utf-8", "replace")
            dup = re.search(r"@\s*\w+\s*[{(]\s*" + re.escape(key) + r"\s*,", current, re.I)
            if dup:
                return {"bib": rel, "key": key, "created": False, "existed": True, "added": False}
            text = current
            if text and not text.endswith("\n"):
                text += "\n"
            if text.strip():
                text += "\n"
            text += entry + "\n"
            atomic_write(abs_path, text.encode("utf-8"))
        # Not recorded as our own write: the watcher sends `file` (open refs.bib tabs reload)
        # and compile-on-save picks the new entry up.
        return {"bib": rel, "key": key, "created": created, "existed": False, "added": True}

    def api_wordcount(self, q, body):
        proj = self.app.project
        tool = find_tool("texcount")
        if not tool:
            raise ApiError(501, "texcount is not installed (it ships with TeX Live).")
        if not proj.main_abs.is_file():
            raise ApiError(404, f"The main file {proj.main_rel} doesn't exist.")
        try:
            proc = subprocess.run([tool, "-utf8", "-inc", "-total", "-sum", "-merge", posixpath.basename(proj.main_rel)],
                                  cwd=str(proj.base()), capture_output=True, timeout=60, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            raise ApiError(504, "texcount took too long.")
        except OSError as e:
            raise ApiError(500, f"Couldn't run texcount: {e}")
        text = proc.stdout.decode("utf-8", "replace").strip()
        if proc.returncode != 0 and not text:
            raise ApiError(500, "texcount failed: " + proc.stderr.decode("utf-8", "replace").strip()[-500:])
        m = re.search(r"^Words in text:\s*(\d+)", text, re.M) or re.search(r"^Sum count:\s*(\d+)", text, re.M)
        return {"words": int(m.group(1)) if m else 0, "text": text}

    def api_open_pdf(self, q, body):
        proj = self.app.project
        pdf = proj.beside_pdf() if proj.beside_pdf().is_file() else proj.pdf_path()
        if not pdf.is_file():
            raise ApiError(404, "No PDF yet — press Compile.")
        # TEXC_PDF_OPENER picks another viewer, e.g. "open -a Skim".
        custom = os.environ.get("TEXC_PDF_OPENER")
        if custom:
            cmd = shlex.split(custom)
        else:
            cmd = ["open"] if sys.platform == "darwin" else ["xdg-open"]
        if silent():
            log(f"silent: not opening {pdf}")
            return {"silent": True}
        try:
            subprocess.Popen(cmd + [str(pdf)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError as e:
            raise ApiError(500, f"Couldn't open the PDF: {e}")
        return {}

    # -- folders: lobby, recent, UI state, pickers (docs/ARCHITECTURE.md) --------------------------

    def api_lobby(self, q, body):
        app = self.app
        recent = app.recent.public()
        parent = next((os.path.dirname(r["path"]) for r in recent if r["exists"]), None)
        return {
            "mode": "lobby", "app": app.native, "recent": recent,
            "templates": [{k: t[k] for k in ("id", "name", "description")} for t in app.build.list_templates()],
            "defaults": {"parent": parent or str(Path.home() / "Documents"), "author": app.author(),
                         "home": str(Path.home())},
            "background": background_public(),
            "tools": {"latexmk": find_tool("latexmk") is not None,
                      "claude": find_tool("claude", "TEXC_CLAUDE") is not None,
                      "codex": find_tool("codex", "TEXC_CODEX") is not None},
        }

    def api_lobby_bg_get(self, q, body):
        st = background_state()
        if st is None:
            raise ApiError(404, "No background image.")
        ctype = STATIC_MIME.get(st["path"].suffix.lower(), "application/octet-stream")
        try:
            self._send_file(st["path"], ctype, {"Content-Security-Policy": "sandbox; default-src 'none'"})
        except (FileNotFoundError, PermissionError, IsADirectoryError):
            raise ApiError(404, "No background image.")

    def api_lobby_bg_set(self, q, body):
        """{data: base64, name} sets the image, {opacity: 0..1} its strength, {clear: true} removes it."""
        cdir = config_dir()
        meta_path = cdir / "welcome-background.json"
        st = background_state()
        if body.get("clear"):
            for ext in BG_EXTS:
                with fs_errors_quiet():
                    (cdir / f"welcome-background.{ext}").unlink()
            with fs_errors_quiet():
                meta_path.unlink()
            return {"background": None}
        opacity = st["opacity"] if st else BG_DEFAULT_OPACITY
        if "opacity" in body:
            try:
                opacity = min(1.0, max(0.05, float(body["opacity"])))
            except (TypeError, ValueError):
                raise ApiError(400, "opacity must be a number between 0 and 1.")
        name = st["path"].name if st else None
        data = body.get("data")
        if data is not None:
            if not isinstance(data, str):
                raise ApiError(400, "data must be base64 text.")
            if len(data) > BG_MAX * 4 // 3 + 16:
                raise ApiError(413, "That image is too large (20 MB at most).")
            try:
                raw = base64.b64decode(data, validate=True)
            except (binascii.Error, ValueError):
                raise ApiError(400, "That isn't a valid image upload.")
            if len(raw) > BG_MAX:
                raise ApiError(413, "That image is too large (20 MB at most).")
            kind = background_kind(raw)
            if kind is None:
                raise ApiError(415, "Use a PNG, JPEG, WebP or GIF image.")
            cdir.mkdir(parents=True, exist_ok=True)
            name = f"welcome-background.{kind}"
            atomic_write(cdir / name, raw)
            for ext in BG_EXTS:
                if ext != kind:
                    with fs_errors_quiet():
                        (cdir / f"welcome-background.{ext}").unlink()
        if name is None:
            raise ApiError(400, "Choose an image first.")
        cdir.mkdir(parents=True, exist_ok=True)
        atomic_write(meta_path, json.dumps({"file": name, "opacity": round(opacity, 3)}).encode("utf-8"))
        return {"background": background_public()}

    def api_lobby_new(self, q, body):
        app = self.app
        parent, name, template = body.get("parent"), body.get("name"), body.get("template") or "article"
        if not isinstance(parent, str) or not parent.strip() or "\x00" in parent:
            raise ApiError(400, "Choose where to create the project.")
        parent_abs = os.path.expanduser(parent.strip())
        if not os.path.isabs(parent_abs):
            raise ApiError(400, "The location must be an absolute folder path.")
        if not os.path.isdir(parent_abs):
            raise ApiError(400, f"The folder {parent.strip()} doesn't exist.")
        if not isinstance(name, str) or not name.strip():
            raise ApiError(400, "Give the project a name.")
        name = name.strip()
        if len(name) > 100:
            raise ApiError(400, "The name can be at most 100 characters.")
        if "/" in name or "\x00" in name or name in (".", "..") or name.startswith("."):
            raise ApiError(400, "The name can't contain “/” or start with a dot.")
        if any(ch < " " or ch == "\x7f" for ch in name):
            raise ApiError(400, "The name can't contain line breaks or other control characters.")
        if name.endswith("\\"):            # latexmk turns "\\" into "/" and then builds in "/.texc"
            raise ApiError(400, "The name can't end with a backslash (\\): LaTeX can't build in such a folder.")
        if not isinstance(template, str):
            raise ApiError(400, "Unknown template.")
        fn = getattr(app.build.mod, "new_project", None)
        templates = {t["id"]: t for t in app.build.list_templates()}
        if not callable(fn) or not templates:
            raise ApiError(503, "Templates are unavailable.")
        if template not in templates:
            raise ApiError(400, f"Unknown template: {template}")
        target = os.path.join(parent_abs, name)
        exists_msg = f"A folder named “{name}” already exists there."
        if os.path.lexists(target):
            if not os.path.isdir(target):
                raise ApiError(409, exists_msg)
            with fs_errors():
                if [n for n in os.listdir(target) if n != ".DS_Store"]:
                    raise ApiError(409, exists_msg)
        try:
            with fs_errors():
                main_path = fn(Path(target), template, title=name, author=app.author())
        except ApiError as e:
            raise ApiError(409, exists_msg) if e.status == 409 else e
        except ValueError as e:
            raise ApiError(400, str(e) or f"Unknown template: {template}")
        folder = canonical_path(target)
        main = valid_main(Path(folder), str(main_path) if main_path else None) or templates[template]["main"]
        log(f"new project: {folder} ({template})")
        return {"folder": folder, "main": main}

    def api_recent(self, q, body):
        return {"recent": self.app.recent.public()}

    def api_recent_forget(self, q, body):
        path = body.get("path")
        if not isinstance(path, str) or not path.strip() or "\x00" in path:
            raise ApiError(400, "path is required.")
        self.app.recent.forget(path.strip())
        return {"recent": self.app.recent.public()}

    def api_ui_state(self, q, body):
        set_ = body.get("set")
        remove = body.get("remove")
        set_ = {} if set_ is None else set_
        remove = [] if remove is None else remove
        if not isinstance(set_, dict) or not isinstance(remove, list):
            raise ApiError(400, 'Send {"set": {key: value}, "remove": [key]}.')
        with fs_errors():
            self.app.ui_state.update(set_, remove)
        return {"ok": True}

    def api_pick(self, q, body):
        if self.app.native:
            raise ApiError(400, "The texc app chooses folders itself.")
        if body.get("kind", "folder") != "folder":
            raise ApiError(400, 'kind must be "folder".')
        prompt = body.get("prompt")
        prompt = prompt if isinstance(prompt, str) and prompt.strip() else "Choose a folder"
        if silent():
            return {"path": None}
        osa = shutil.which("osascript") or ("/usr/bin/osascript" if os.path.isfile("/usr/bin/osascript") else None)
        if sys.platform != "darwin" or not osa:
            raise ApiError(501, "No folder picker is available here; type the folder's path instead.")
        script = f"POSIX path of (choose folder with prompt {applescript_quote(prompt[:200])})"
        try:
            proc = subprocess.run([osa, "-e", script], capture_output=True, timeout=900, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            return {"path": None}
        except OSError as e:
            raise ApiError(501, f"The folder picker couldn't start: {e}")
        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", "replace").strip()
            if "-128" in err or "cancel" in err.lower():
                return {"path": None}
            raise ApiError(500, f"The folder picker failed: {err[-300:] or proc.returncode}")
        path = proc.stdout.decode("utf-8", "replace").strip()
        if len(path) > 1:
            path = path.rstrip("/")
        return {"path": path or None}

    def api_open_folder(self, q, body):
        app = self.app
        if app.native:
            raise ApiError(400, "The texc app opens folders itself.")
        raw = body.get("path")
        if not isinstance(raw, str) or not raw.strip() or "\x00" in raw:
            raise ApiError(400, "A folder path is required.")
        p = os.path.expanduser(raw.strip())
        if not os.path.isabs(p):
            raise ApiError(400, "Type the folder's full path (~ is fine).")
        if os.path.isdir(p):
            folder = canonical_path(p)
        elif os.path.isfile(p) and ext_of(p) in MAIN_EXTS:
            folder = canonical_path(os.path.dirname(os.path.abspath(p)))
        elif os.path.exists(p):
            raise ApiError(400, "That is not a folder or a .tex file.")
        else:
            raise ApiError(404, f"No such folder: {raw.strip()}")
        if app.project is not None and folder == app.project.root_s:
            return {"url": app.url}
        return {"url": app.open_folder_child(os.path.abspath(p), folder)}

    def api_scaffold(self, q, body):
        app, proj = self.app, self.app.project
        template = body.get("template") or "article"
        fn = getattr(app.build.mod, "scaffold", None)
        templates = {t["id"]: t for t in app.build.list_templates()}
        if not callable(fn) or not templates:
            raise ApiError(503, "Templates are unavailable.")
        if not isinstance(template, str) or template not in templates:
            raise ApiError(400, f"Unknown template: {template}")
        with fs_errors(), app.fs_lock:
            try:
                made = fn(proj.root, template, title=proj.root.name, author=app.author()) or []
            except ValueError as e:
                raise ApiError(400, str(e) or f"Unknown template: {template}")
            created = []
            for c in made:
                c = str(c)
                rel = proj.to_rel(c) if os.path.isabs(c) else posixpath.normpath(c.replace(os.sep, "/"))
                if rel and rel not in created:
                    created.append(rel)
            app.watcher.absorb(created)      # our own files: no `file` events or compile for them
        if not proj.main_exists():
            tmain = valid_main(proj.root, templates[template]["main"])
            if tmain:
                app.set_main(tmain)
        app.changed(tree=True)
        return {"created": created, "main": proj.main_rel}

    def api_reveal(self, q, body):
        proj = self.app.project
        rel = body.get("path") or ""
        if not isinstance(rel, str):
            raise ApiError(400, "path must be a string.")
        if rel.strip():
            abs_path, rel = proj.resolve(rel)
            if not (abs_path.exists() or abs_path.is_symlink()):
                raise ApiError(404, f"No such file: {rel}")
            cmd = ["open", "-R", str(abs_path)] if sys.platform == "darwin" else ["xdg-open", str(abs_path.parent)]
        else:
            cmd = ["open" if sys.platform == "darwin" else "xdg-open", str(proj.root)]
        if silent():
            log(f"silent: not revealing {cmd[-1]}")
            return {"ok": True, "silent": True}
        try:
            subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError as e:
            raise ApiError(500, f"Couldn't show it in the Finder: {e}")
        return {"ok": True}


# ---------------------------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------------------------

def resolve_target(target, build: BuildLib, recent: RecentStore):
    """(root realpath, main_rel) for a folder or .tex file (docs/ARCHITECTURE.md). The main
    is the explicit .tex > the folder's remembered main (if it still exists) > choose_main >
    the virtual "main.tex". Raises ValueError for a missing path or a non-.tex file."""
    p = Path(os.path.expanduser(str(target)))
    if not p.exists() and p.suffix.lower() not in (".tex", ".ltx"):
        for alt in (Path(str(p) + ".tex"), p.with_suffix(".tex")):   # `texc gui paper` -> paper.tex
            if alt.is_file():
                p = alt
                break
    if p.is_dir():
        root = canonical_path(p)
        main = valid_main(Path(root), recent.remembered_main(root)) or build.choose_main(Path(root)) or "main.tex"
        return root, main
    if p.is_file():
        if ext_of(p) not in MAIN_EXTS:
            raise ValueError(f"{target} is not a folder or a .tex file")
        p = Path(os.path.abspath(str(p)))
        return canonical_path(p.parent), p.name
    raise ValueError(f"no such file or folder: {target}")


def _make_server(app: App, port, app_mode: bool = False) -> TexcHTTPServer:
    if port is not None and int(port) != 0:
        candidates = [int(port)]
    elif port is not None or app_mode:              # --port 0, or the app: an ephemeral port
        candidates = [0]
    else:
        candidates = list(range(DEFAULT_PORT, DEFAULT_PORT + 20)) + [0]
    last: OSError | None = None
    for p in candidates:
        try:
            httpd = TexcHTTPServer(("127.0.0.1", p), Handler)
        except OSError as e:
            last = e
            if len(candidates) == 1 and p:
                raise OSError(f"can't listen on 127.0.0.1:{p} ({e.strerror or e}); try another --port")
            continue
        httpd.app = app
        return httpd
    raise OSError(f"no free port found ({last})")


def _stdout_line(kind: str, payload: dict) -> None:
    """The app handshake: exactly one line on stdout, flushed (ASCII-only JSON)."""
    try:
        sys.stdout.write(f"{kind} {json.dumps(payload, separators=(',', ':'))}\n")
        sys.stdout.flush()
    except (OSError, ValueError, AttributeError):
        pass


def _watch_stdin(on_eof) -> None:
    """App mode: the shell keeps our stdin open and never writes to it; EOF means it's gone."""
    def run():
        try:
            fd = sys.stdin.fileno()
        except (AttributeError, OSError, ValueError):
            fd = 0
        try:
            while os.read(fd, 65536):
                pass
        except OSError:
            pass
        log("stdin closed; stopping")
        on_eof()

    threading.Thread(target=run, name="texc-stdin", daemon=True).start()


def serve(target=None, texc_module=None, port=None, open_browser=True, app_mode=False) -> int:
    """Run the GUI server until Ctrl-C/SIGTERM (or, with app_mode, stdin EOF). `target` is None
    for the Welcome screen (lobby) or a folder / .tex file. Returns a process exit code."""
    app_mode = bool(app_mode)
    if app_mode:
        open_browser = False

    def fail(msg: str, code: int) -> int:
        print(f"texc: {msg}", file=sys.stderr, flush=True)
        if app_mode:                       # a TEXC_ERROR line, then exit 1 (whatever the cause)
            _stdout_line("TEXC_ERROR", {"error": msg})
            return 1
        return code

    if texc_module is None:
        texc_module = _load_texc()
    build = BuildLib(texc_module)
    project = None
    if target is not None and str(target).strip():
        try:
            root, main_rel = resolve_target(target, build, RecentStore(config_dir()))
        except ValueError as e:
            return fail(str(e), 2)
        project = Project(root, main_rel)
        if not (GUI_DIR / "index.html").is_file():
            return fail(f"the GUI files are missing ({GUI_DIR / 'index.html'})", 1)
    app = App(project, texc_module, app_mode)
    reg = servers_file(app.key) if project is not None else None

    # One server per folder: check, bind and register under one cross-process lock (a
    # single servers/.lock: the critical section is short, and no lock file piles up per folder).
    with (file_lock(reg.parent / ".lock") if reg is not None else nullcontext()):
        other = live_server(app.key) if reg is not None else None
        if other is not None:
            url = other["url"]
            if app_mode:
                _stdout_line("TEXC_READY", {"already_open": True, "url": url, "mode": "project", "folder": project.root_s})
            else:
                print(f"texc: {project.root_s} is already open at {url}", flush=True)
                if open_browser and not silent():
                    webbrowser.open(url)
            return 0
        try:
            httpd = _make_server(app, port, app_mode)
        except OSError as e:
            return fail(str(e), 1)
        app.port = httpd.server_address[1]
        app.url = url = f"http://127.0.0.1:{app.port}/"
        if reg is not None:
            try:
                write_json_file(reg, {"pid": os.getpid(), "url": url, "root": project.root_s, "started": int(time.time())})
            except OSError as e:
                log(f"couldn't write {reg}: {e}")
    if project is not None:
        app.recent.touch(project.root_s, project.main_rel if project.main_exists() else None)
    app.start()
    if not app.build.ok:
        log(f"warning: {app.build.problem}; compiling is disabled")

    saved_stdout = sys.stdout
    if app_mode:
        _stdout_line("TEXC_READY", {"url": url, "port": app.port, "pid": os.getpid(), "token": app.token,
                                    "mode": app.mode, "folder": project.root_s if project else None,
                                    "main": project.main_rel if project else None,
                                    "main_exists": project.main_exists() if project else False})
        sys.stdout = sys.stderr              # nothing else may reach the shell's stdout pipe
        log(f"{app.mode} server at {url}" + (f" for {project.root_s}" if project else ""))
        _watch_stdin(httpd.shutdown)         # safe: it's never the serve_forever thread
    else:
        print(f"texc GUI: {url}  (Ctrl-C to stop)", flush=True)
        if project is None:
            print("texc: no folder given; showing the Welcome screen", flush=True)
    if open_browser and not silent():
        opener = threading.Timer(0.3, lambda: webbrowser.open(url))
        opener.daemon = True
        opener.start()

    in_main = threading.current_thread() is threading.main_thread()
    old_handlers = {}
    if in_main:
        def on_term(signum, frame):
            raise KeyboardInterrupt
        for sig in (signal.SIGTERM, signal.SIGHUP):
            try:
                old_handlers[sig] = signal.signal(sig, on_term)
            except (ValueError, OSError):
                pass
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        if in_main:   # a second Ctrl-C must not interrupt the cleanup with a traceback
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            for sig in old_handlers:
                signal.signal(sig, signal.SIG_IGN)
        try:
            if app_mode:
                log("stopped.")
            else:
                print("\ntexc GUI: stopped.", flush=True)
        except (OSError, ValueError):
            pass
        if reg is not None and read_json_file(reg, {}).get("pid") == os.getpid():
            try:
                reg.unlink()
            except OSError:
                pass
        httpd.server_close()                 # first, so nobody mistakes us for a live server
        try:
            app.shutdown()
        except Exception as e:
            log(f"error while stopping: {e!r}")
        sys.stdout = saved_stdout
        if in_main:
            signal.signal(signal.SIGINT, signal.default_int_handler)
            for sig, old in old_handlers.items():
                signal.signal(sig, old if old is not None else signal.SIG_DFL)
    return 0


def _load_texc():
    """Standalone mode: load texc.py from this folder without running its CLI."""
    path = HERE / "texc.py"
    if not path.is_file():
        log(f"warning: {path} not found")
        return None
    added = "texc" not in sys.modules
    try:
        spec = importlib.util.spec_from_file_location("texc", str(path))
        mod = importlib.util.module_from_spec(spec)
        if added:
            sys.modules["texc"] = mod
        spec.loader.exec_module(mod)
        return mod
    except BaseException as e:      # includes SystemExit from a misbehaving import
        if isinstance(e, KeyboardInterrupt):
            raise
        if added:
            sys.modules.pop("texc", None)
        log(f"warning: couldn't load {path}: {e!r}")
        return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="server.py", description="texc GUI server (standalone mode).")
    ap.add_argument("path", nargs="?", help="project folder or main .tex file (default: the current folder "
                                            "if it has a main file, else the Welcome screen)")
    ap.add_argument("--port", type=int, default=None, help=f"port to listen on (default: {DEFAULT_PORT} or the next free one)")
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser window")
    ap.add_argument("--app", action="store_true", help="texc.app mode: ephemeral port, handshake line on stdout, "
                                                       "exit when stdin closes")
    a = ap.parse_args(argv)
    mod = _load_texc()
    target = a.path
    if target is None:                      # the CLI's rule: the cwd if it has a main file, else the lobby
        try:
            cwd = Path.cwd()
            target = str(cwd) if BuildLib(mod).find_mains(cwd) else None
        except OSError:
            target = None
    return serve(target, mod, a.port, not a.no_browser, app_mode=a.app)


if __name__ == "__main__":
    sys.exit(main())
