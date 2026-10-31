#!/usr/bin/env python3
"""texc - a small, fast local LaTeX compiler front-end, and the build library behind `texc --gui`.

Wraps latexmk (from your TeX Live install) so you get:
  * one command to build a PDF, with only the needed reruns/bibtex passes
  * short error reports (file:line, message, offending source line)
  * build junk kept in a hidden .texc/ folder; the PDF (and its .synctex.gz) lands next to the .tex
  * a watch mode that rebuilds whenever any file the document uses changes
  * a local GUI (editor, live PDF preview, AI chat) with `texc --gui`

Usage:
  texc [file.tex | folder]   build (file optional if the folder has one main .tex)
  texc -w [file.tex]         watch and rebuild on save
  texc -o [file.tex]         open the PDF after building
  texc -e xe|lua|pdf ...     force an engine (default: auto-detect)
  texc -v ...                also show all warnings
  texc --clean [file.tex]    delete the build files in .texc/ (keeps chats/, trash/, uploads/)
  texc gui [folder|file.tex] open the GUI in the browser (same as `texc --gui`; --port N, --no-browser).
                             No argument: this folder if it has a main .tex, else the Welcome screen.
  texc new FOLDER            start a project from a template (-t blank|article, --title, --author, --open)
  texc app [folder|file.tex] open the texc Mac app (builds ~/Applications/texc.app on first use)
  texc install-app           rebuild and reinstall ~/Applications/texc.app

Library API (used by server.py): BUILD_DIR, KEEP_DIRS, pick_engine(), find_mains(), run_build(),
clean(), print_result(), watched_files()/snapshot() for watchers, and for project folders:
choose_main(), list_templates(), scaffold(), new_project(), default_author(), tex_escape().
"""

from __future__ import annotations

import argparse
import atexit
import html
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent          # the real folder, even when run via ~/.local/bin/texc
BUILD_DIR = ".texc"
# latexmk turns every "\\" in a path into "/" (an MS-Windows habit, on every OS), so in a folder
# whose own name ends with "\\" its -outdir comes out as "/.texc" and nothing can be written.
_BACKSLASH_DIR = "a folder whose name ends with a backslash (\\) can't be built: latexmk can't write its .texc folder"
KEEP_DIRS = ("chats", "trash", "uploads")         # GUI data inside .texc; clean() never touches them
ENGINES = {"pdf": "-pdf", "xe": "-xelatex", "lua": "-lualatex"}
ENGINE_NAMES = {"pdf": "pdflatex", "xe": "xelatex", "lua": "lualatex"}

# latexmk flags shared by every build. -file-line-error gives "./file.tex:12: message" errors.
# $bibtex_fudge=0 runs bibtex from the project folder, so \bibliography{../refs} resolves like it
# does for plain pdflatex; bibtex then has to write .texc/main.bbl, which TeX Live's default
# openout_any=p refuses for a dot-folder, so openout_any=a is granted to bibtex alone.
_LMK_FLAGS = [
    "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-synctex=1", "-recorder",
    f"-outdir={BUILD_DIR}", f"-auxdir={BUILD_DIR}", "-pv-", "-pvc-",
    "-e", "$bibtex_fudge=0",
    "-e", r'$bibtex = "openout_any=a $bibtex" unless $bibtex =~ /openout_any|^\s*internal/;',
]
# Where TeX usually lives when a GUI app or launchd job runs us with a minimal PATH.
_TEX_BIN_DIRS = ("/Library/TeX/texbin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/texbin")
# Folders never mirrored into .texc or searched for sources.
_SKIP_DIRS = {"node_modules", "__pycache__", "venv", "env"}

USE_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def c(code, s):
    return f"\033[{code}m{s}\033[0m" if USE_COLOR else s


class TexcError(Exception):
    """A user-facing problem (bad argument, missing file): the CLI prints it and exits 2."""


# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------

def _read(path, limit=None):
    """Text of a file, or "" if it can't be read. Universal newlines (\\r\\n, \\r -> \\n) match how
    TeX counts lines; callers split with split("\\n"), never splitlines() (which also breaks on
    form feeds, U+2028 and friends and so shifts line numbers)."""
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
            return f.read() if limit is None else f.read(limit)
    except OSError:
        return ""


def _source_lines(path, cache=None):
    if cache is not None and path in cache:
        return cache[path]
    lines = _read(path).split("\n")
    if cache is not None:
        cache[path] = lines
    return lines


def _norm(base, name):
    """A TeX-printed file name as a project-relative path ("./a/b.tex" -> "a/b.tex"); files outside
    the project keep a relative "../x" form, system files stay absolute."""
    name = name.strip()
    if not name:
        return ""
    if os.path.isabs(name):
        full = os.path.normpath(name)
        rel = os.path.relpath(full, base)
        return full if _outside(rel) else rel
    return os.path.normpath(name)


def _outside(rel):
    """True for a relative path that leaves its folder ("..", "../x")."""
    return rel == os.pardir or rel.startswith(os.pardir + os.sep)


def _abs(base, rel):
    return Path(rel) if os.path.isabs(rel) else Path(base) / rel


def _display(path):
    """A path as the CLI shows it: relative to the caller's cwd unless that needs '../../'."""
    p = str(path)
    try:
        cwd = os.getcwd()
        rel = os.path.relpath(p, cwd)
    except (ValueError, OSError):
        return p
    if cwd == os.sep or rel.startswith(os.pardir + os.sep + os.pardir):
        return p
    return rel


def _stat(path):
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


def _sync_copy(src, dst):
    """Copy src over dst unless dst already is that file (same size and mtime_ns: copy2 keeps the
    mtime, so an unchanged rebuild copies nothing). The temp file + os.replace makes it atomic, so
    an auto-reloading viewer never sees half a PDF, and a read-only dst is simply replaced."""
    s = os.stat(src)
    d = _stat(dst)
    if d is not None and d == (s.st_mtime_ns, s.st_size):
        return False
    tmp = Path(dst).with_name(f".{Path(dst).name}.texc-tmp")
    try:
        shutil.copy2(src, tmp)
        os.replace(tmp, dst)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    return True


def _tex_env():
    """Environment for TeX tools: long unwrapped log lines, and TeX's bin dir on PATH if missing."""
    env = dict(os.environ, max_print_line="10000", error_line="254", half_error_line="238")
    path = env.get("PATH", "")
    if not shutil.which("latexmk", path=path):
        for d in _TEX_BIN_DIRS:
            if os.access(os.path.join(d, "latexmk"), os.X_OK):
                env["PATH"] = d + (os.pathsep + path if path else "")
                break
    return env


def _which(tool, env):
    return shutil.which(tool, path=env.get("PATH"))


_KPSE_CACHE = {}


def _kpsewhich(name, env, cwd):
    """Find a file in TeX's search path. Hits are cached; misses are retried next time, so a file
    installed while the GUI runs is found."""
    key = (str(cwd), name)
    if key not in _KPSE_CACHE:
        found = ""
        exe = _which("kpsewhich", env)
        if exe:
            try:
                found = subprocess.run([exe, name], cwd=str(cwd), env=env, capture_output=True,
                                       text=True, timeout=10).stdout.strip()
            except (OSError, subprocess.SubprocessError):
                found = ""
        if not found:
            return ""
        _KPSE_CACHE[key] = found
    return _KPSE_CACHE[key]


_TEX_ROOTS = None


def _tex_roots():
    """TeX's own trees (never worth watching), from kpsewhich, cached."""
    global _TEX_ROOTS
    if _TEX_ROOTS is None:
        roots = set()
        env = _tex_env()
        exe = _which("kpsewhich", env)
        if exe:
            try:
                out = subprocess.run([exe, "-expand-var=$TEXMFROOT|$TEXMFSYSVAR|$TEXMFVAR"],
                                     env=env, capture_output=True, text=True, timeout=10).stdout
            except (OSError, subprocess.SubprocessError):
                out = ""
            for v in out.strip().split("|"):
                v = v.strip()
                if v and not v.startswith("$") and os.path.isabs(v):
                    roots.add(os.path.normpath(v))
                    roots.add(os.path.realpath(v))
        _TEX_ROOTS = sorted(roots)
    return _TEX_ROOTS


def _under(path, roots):
    return any(path == r or path.startswith(r + os.sep) for r in roots)


# ---------------------------------------------------------------------------------------------
# Engine detection
# ---------------------------------------------------------------------------------------------

COMMENT = re.compile(r"(?<!\\)((?:\\\\)*)%.*")         # a % not escaped by an odd number of \
_PKG = r"\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*?\b(?:%s)\b"
LUA_PKGS = re.compile(_PKG % (r"luacode|luatexja(?:-[\w-]+)?|luacolor|lua-ul|luaotfload|lualatex-math|"
                               r"luamplib|emoji|lua-visual-debug|luavlna|selnolig"))
XE_PKGS = re.compile(_PKG % r"fontspec|polyglossia|unicode-math|fontsetup|xeCJK|xltxtra|xunicode|mathspec")
LUA_CLASS = re.compile(r"\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*ltj")
LUA_CALL = re.compile(r"\\(?:directlua|luaexec|luadirect)\s*\{")
MAGIC = re.compile(r"^[ \t]*%+\s*!\s*TeX\s+(?:TS-)?program\s*=\s*([\w.-]+)", re.I | re.M)
BEGIN_DOC = re.compile(r"\\begin\s*\{document\}")
_LOCAL_INPUT = re.compile(r"\\(?:input|include|subfile)\s*\{([^}]+)\}|\\input\s+([^\s{}\\]+)")
_USEPKG = re.compile(r"\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}")
# Log messages that mean "wrong engine": the first match in the log decides the retry.
_NEEDS = [
    (re.compile(r"LuaTeX is required|requires Lua\(HB\)\(La\)TeX|may only be run using LuaTeX|"
                r"LuaLaTeX required|package requires LuaTeX|ltluatex\.tex:\d+: Undefined control sequence",
                re.I), "lua"),
    (re.compile(r"requires either XeTeX or|cannot-use-pdftex|Cannot be run with pdftex|requires XeTeX|"
                r"XeTeX is required|Use Unicode-compliant TeX-engines", re.I), "xe"),
]


def _norm_engine(name):
    s = str(name).strip().lower()
    if s in ("latex", "pdftex"):
        return "pdf"
    for suffix in ("latex", "tex"):
        if s.endswith(suffix) and len(s) > len(suffix):
            s = s[: -len(suffix)]
            break
    s = {"luahb": "lua"}.get(s, s)
    if s not in ENGINES:
        raise ValueError(f"unknown engine {name!r} (choose from pdf, xe, lua)")
    return s


def _engine_from_program(prog):
    p = prog.lower()
    return "xe" if p.startswith("xe") else "lua" if p.startswith("lua") else "pdf"


def _strip_comments(text):
    return [COMMENT.sub(r"\1", ln) for ln in text.split("\n")]


def pick_engine(main, forced=None):
    """'pdf', 'xe' or 'lua' for this main file: a forced choice, else a % !TEX program magic
    comment, else the packages the preamble really loads (comments ignored, BOM stripped)."""
    if forced:
        return _norm_engine(forced)
    main = Path(main)
    raw = _read(main)
    lines = raw.split("\n")
    code = _strip_comments(raw)
    end = next((i for i, ln in enumerate(code) if BEGIN_DOC.search(ln)), len(code) - 1)
    m = MAGIC.search("\n".join(lines[: end + 1]))       # magic comments are comments: raw text
    if m:
        return _engine_from_program(m.group(1))
    head = "\n".join(code[: end + 1])
    # One level of local preamble files (\input{preamble}, a project .sty/.cls) is checked too.
    extra = []
    for mm in _LOCAL_INPUT.finditer(head):
        name = (mm.group(1) or mm.group(2) or "").strip()
        for cand in (name, name + ".tex"):
            p = main.parent / cand
            if name and p.is_file():
                extra.append(p)
                break
    for mm in _USEPKG.finditer(head):
        for name in mm.group(1).split(","):
            p = main.parent / (name.strip() + ".sty")
            if name.strip() and p.is_file():
                extra.append(p)
    scan = head + "\n" + "\n".join("\n".join(_strip_comments(_read(p, 1 << 20))) for p in extra[:10])
    if LUA_PKGS.search(scan) or LUA_CLASS.search(head) or LUA_CALL.search("\n".join(code)):
        return "lua"
    if XE_PKGS.search(scan):
        return "xe"
    return "pdf"


def _engine_needed(log_text, current):
    """(engine, why) when a failed log asks for another engine (fontspec under pdflatex -> 'xe'),
    else (None, "")."""
    if current == "xe":
        # xelatex finds fonts through the system only; luaotfload also sees TeX Live's own fonts
        fm = re.search(r'The font "([^"]+)" cannot be found', log_text)   # may follow "(fontspec)"
        if fm and "fontspec" in log_text[max(0, fm.start() - 200): fm.start()]:
            return "lua", f'xelatex could not find the font "{fm.group(1)}"'
    best = None
    for rx, eng in _NEEDS:
        m = rx.search(log_text)
        if m and (best is None or m.start() < best[0]):
            best = (m.start(), eng)
    if best is None or best[1] == current:
        return None, ""
    line_start = log_text.rfind("\n", 0, best[0]) + 1
    line = log_text[line_start: log_text.find("\n", best[0])]
    pm = re.search(r"Package (\S+) Error|^.*/([\w-]+)\.sty:\d+:", line)
    what = (pm.group(1) or pm.group(2)) if pm else "the document"
    return best[1], f"{what} can't be built with {ENGINE_NAMES[current]}"


# ---------------------------------------------------------------------------------------------
# Main-file discovery
# ---------------------------------------------------------------------------------------------

DOCCLASS = re.compile(r"^[^%\n]*\\documentclass", re.M)   # \documentclass before any % on its line


def find_mains(folder):
    """The .tex files directly in folder that have a real (uncommented) \\documentclass. Skips
    dotfiles (editor lock files), dangling symlinks, folders named *.tex and unreadable files."""
    folder = Path(folder)
    try:
        entries = sorted(folder.iterdir(), key=lambda p: p.name)
    except OSError:
        return []
    mains = []
    for p in entries:
        if p.suffix.lower() != ".tex" or p.name.startswith("."):
            continue
        try:
            if not p.is_file():
                continue
            with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
                text = f.read(1 << 20)
        except OSError:
            continue
        if DOCCLASS.search(text):
            mains.append(p)
    return mains


def _single_main(folder, here):
    mains = find_mains(folder)
    if len(mains) > 1:   # prefer real documents over subfiles/standalone pieces
        real = [p for p in mains if not re.search(r"\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*(?:subfiles|standalone)\s*\}",
                                                   _read(p, 1 << 20))]
        mains = real or mains
    where = "here" if here else f"in {_display(folder)}"
    if len(mains) == 1:
        return mains[0].resolve()
    if not mains:
        raise TexcError(f"no .tex file with \\documentclass {where}; pass one: texc file.tex")
    raise TexcError(f"several main files {where}, pick one: " + ", ".join(p.name for p in mains))


def find_main(arg=None):
    """CLI main-file lookup. 'paper.v2' -> paper.v2.tex (the suffix is appended, never replaced),
    'main.pdf' -> main.tex, a folder -> the single main inside it, nothing -> the cwd's main."""
    if not arg:
        return _single_main(Path.cwd(), True)
    p = Path(arg).expanduser()
    if p.suffix.lower() == ".pdf":            # tab-completion slip: never feed the PDF to TeX
        p = p.with_suffix(".tex")
    if p.suffix.lower() in (".tex", ".ltx") and p.is_file():
        return p.resolve()
    if p.name and p.name not in (".", ".."):
        q = p.with_name(p.name + ("tex" if p.name.endswith(".") else ".tex"))
        if q.is_file():
            return q.resolve()
    if p.is_file():
        return p.resolve()
    if p.is_dir():
        return _single_main(p, p.resolve() == Path.cwd().resolve())
    raise TexcError(f"no such file: {arg}")


# ---------------------------------------------------------------------------------------------
# Project folders: the main-file choice, templates, new projects (the GUI's Welcome screen)
# ---------------------------------------------------------------------------------------------

TEMPLATES_DIR = HERE / "templates"
_PIECE_CLASS = re.compile(r"\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*(?:subfiles|standalone)\s*\}")
_MAIN_NAMES = ("paper.tex", "thesis.tex", "manuscript.tex", "report.tex", "article.tex", "draft.tex")
_SUBDIR_SKIP = {BUILD_DIR, "node_modules", "__pycache__"}
_EMPTY_OK = {".DS_Store"}                     # Finder litter: such a folder still counts as empty
_TEMPLATE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_PLACEHOLDER = re.compile(r"\{\{(title|author)\}\}")
_TEX_SPECIAL = {"\\": r"\textbackslash{}", "{": r"\{", "}": r"\}", "$": r"\$", "&": r"\&", "#": r"\#",
                "%": r"\%", "_": r"\_", "^": r"\textasciicircum{}", "~": r"\textasciitilde{}",
                "<": r"\textless{}", ">": r"\textgreater{}", "|": r"\textbar{}"}
# Letters only Vietnamese uses (ơ, ư and the Latin Extended Additional block) have no T1 glyphs, so
# scaffold() makes a template's [T1] font encoding [T1,T5] (T5 active) when the title or author has one.
_VIET_RE = re.compile("[\u01a0\u01a1\u01af\u01b0\u1ea0-\u1ef9]")
_T1_LINE, _T5_LINE = r"\usepackage[T1]{fontenc}", r"\usepackage[T1,T5]{fontenc}"


def _is_piece(path):
    """True for a subfiles/standalone document (a part of a bigger one, not a main)."""
    return bool(_PIECE_CLASS.search("\n".join(_strip_comments(_read(path, 1 << 20)))))


def choose_main(folder, remembered=None):
    """The main .tex a project folder opens with, as a folder-relative posix path, or None.
    remembered (an earlier choice) wins while that file exists. Otherwise the candidates are the
    folder's find_mains(), or, if it has none, those of each non-hidden subfolder one level down;
    subfiles/standalone pieces drop out when a real document exists. Then the first rule that
    decides: main.tex, a single candidate, paper/thesis/manuscript/report/article/draft.tex, the
    most recently modified."""
    folder = Path(os.path.abspath(os.path.expanduser(str(folder))))
    if remembered:
        rel = PurePosixPath(str(remembered))
        if not rel.is_absolute() and ".." not in rel.parts and (folder / rel).is_file():
            return rel.as_posix()
    cands = find_mains(folder)
    if not cands:
        try:
            subs = sorted(d for d in folder.iterdir()
                          if not d.name.startswith(".") and d.name not in _SUBDIR_SKIP
                          and d.is_dir() and not d.is_symlink())
        except OSError:
            subs = []
        for d in subs[:500]:
            cands.extend(find_mains(d))
    if not cands:
        return None
    cands = [p for p in cands if not _is_piece(p)] or cands
    pool = [p for p in cands if p.name.lower() == "main.tex"] or cands
    if len(pool) > 1:
        for name in _MAIN_NAMES:
            named = [p for p in pool if p.name.lower() == name]
            if named:
                pool = named
                break
    best = max(pool, key=lambda p: (_stat(p) or (0, 0))[0])    # ties: the first by name
    return best.relative_to(folder).as_posix()


def default_author():
    """The author for new documents: the account's full name (pwd gecos), else
    `git config user.name`, else ""."""
    try:
        import pwd
        name = (pwd.getpwuid(os.getuid()).pw_gecos or "").split(",")[0].strip()
    except (ImportError, KeyError, AttributeError, OSError):
        name = ""
    git = None if name else shutil.which("git")
    if git:
        try:
            name = subprocess.run([git, "config", "--get", "user.name"], stdin=subprocess.DEVNULL,
                                  capture_output=True, encoding="utf-8", errors="replace",
                                  timeout=5).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            name = ""
    return name


def tex_escape(text):
    """text as LaTeX source that prints it: NFC (LaTeX can't typeset combining accents), control
    characters dropped, whitespace runs (newlines too: a blank line ends \\title{...} with an
    error) collapsed to one space, and the special characters escaped."""
    s = unicodedata.normalize("NFC", str(text))
    s = "".join(" " if unicodedata.category(ch) == "Cc" else ch for ch in s
                if unicodedata.category(ch) != "Cf")
    return "".join(_TEX_SPECIAL.get(ch, ch) for ch in " ".join(s.split()))


def _templates():
    """The usable entries of templates/templates.json ([] when it's missing or unreadable)."""
    try:
        with open(TEMPLATES_DIR / "templates.json", "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    out, seen = [], set()
    for t in data if isinstance(data, list) else []:
        if not isinstance(t, dict) or not isinstance(t.get("files"), list) or not t["files"]:
            continue
        tid, files = str(t.get("id") or ""), [str(f) for f in t["files"]]
        main = str(t.get("main") or files[0])
        if (not _TEMPLATE_ID.match(tid) or tid in seen or main not in files
                or any(not f or f.startswith("/") or ".." in f.split("/") for f in files)):
            continue
        seen.add(tid)
        out.append({"id": tid, "name": str(t.get("name") or tid), "description": str(t.get("description") or ""),
                    "main": main, "files": files})
    return out


def _template(template):
    found = [t for t in _templates() if t["id"] == template]
    if not found:
        ids = ", ".join(t["id"] for t in _templates()) or f"none installed in {TEMPLATES_DIR}"
        raise ValueError(f"unknown template {template!r} (choose from {ids})")
    return found[0]


def _pdflatex_ok(c: str) -> bool:
    """Whether pdflatex (utf8 inputenc, T1/T5 fonts) can typeset c in a template title or author."""
    o = ord(c)
    return (o < 0x250 or 0x1EA0 <= o <= 0x1EF9 or 0x2010 <= o <= 0x203A or o in (0x20AC, 0x2122)
            or 0x0300 <= o <= 0x036F)


def list_templates():
    """[{id, name, description, main}] of the templates in templates/, for New Project."""
    return [{k: t[k] for k in ("id", "name", "description", "main")} for t in _templates()]


def scaffold(folder, template, title=None, author=None):
    """Write the template's files that folder doesn't have yet (never touching an existing one) and
    return their folder-relative paths. {{title}} and {{author}} become TeX-escaped text; title
    defaults to the folder's name, author to default_author(). ValueError for an unknown template."""
    t = _template(template)
    folder = Path(os.path.abspath(os.path.expanduser(str(folder))))
    values = {"title": tex_escape(folder.name if title is None else title),
              "author": tex_escape(default_author() if author is None else author)}
    vietnamese = bool(_VIET_RE.search(values["title"] + values["author"]))
    needs_xelatex = any(not _pdflatex_ok(c) for c in values["title"] + values["author"])
    src = TEMPLATES_DIR / t["id"]
    folder.mkdir(parents=True, exist_ok=True)
    created = []
    for rel in t["files"]:
        dst = folder / rel
        if os.path.lexists(dst):
            continue
        data = (src / rel).read_bytes()
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            text = None                          # not text: copied as it is
        if text is not None:
            text = _PLACEHOLDER.sub(lambda m: values[m.group(1)], text)
            if vietnamese and rel.lower().endswith(".tex"):
                text = text.replace(_T1_LINE, _T5_LINE)
            if needs_xelatex and rel == t["main"] and "% !TEX program" not in text:
                # pdflatex stops on these characters; xelatex compiles (missing glyphs only warn).
                text = "% !TEX program = xelatex\n" + text
            data = text.encode("utf-8")
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            with open(dst, "xb") as f:           # x: a file created meanwhile is never overwritten
                f.write(data)
        except FileExistsError:
            continue
        created.append(rel)
    return created


def new_project(folder, template="article", title=None, author=None):
    """Create folder (and its parents) holding a fresh copy of the template; returns the main .tex
    (absolute). FileExistsError if folder exists and isn't an empty folder (a lone .DS_Store
    doesn't count), ValueError for an unknown template (checked before anything is created)."""
    t = _template(template)
    folder = Path(os.path.abspath(os.path.expanduser(str(folder))))
    if folder.name.endswith("\\"):
        raise ValueError(_BACKSLASH_DIR)
    if any(ord(c) < 32 or ord(c) == 127 for c in folder.name):
        raise ValueError("The name can't contain line breaks or other control characters.")
    if os.path.lexists(folder):
        if not folder.is_dir():
            raise FileExistsError(f"{folder} already exists and is not a folder")
        if any(name not in _EMPTY_OK for name in os.listdir(folder)):
            raise FileExistsError(f"{folder} already exists and is not empty")
    folder.mkdir(parents=True, exist_ok=True)
    scaffold(folder, t["id"], title, author)
    return folder.resolve() / t["main"]


# ---------------------------------------------------------------------------------------------
# Log parsing
# ---------------------------------------------------------------------------------------------

# TeX prints file names as it opened them (./x, ../x, /abs/x), so anchoring there keeps echoed
# document text such as "train.py:12: UserWarning" from being taken for an error.
ERR_RE = re.compile(r"^((?:\.{1,2}/|/|\.texc/)[^:\n]*?\.[A-Za-z0-9]+):(\d+): (.*)$")
CONT_PKG = re.compile(r"^\(([\w@.\-]+)\)(?:\s|$)")          # "(fontspec)      LuaTeX." continuation
RUNAWAY_RE = re.compile(r"^Runaway (argument|definition|preamble|text)\?\s*$")
WARN_RE = re.compile(r"^(?:LaTeX|Package|Class|Module)\b[^:]{0,60}?\bWarning\b")
BOX_RE = re.compile(r"^(?:Overfull|Underfull) \\[hv]box\b")
NOFILE_RE = re.compile(r"^No file (.+\.tex)\.\s*$")
INPUT_LINE_RE = re.compile(r"on input line (\d+)")
BOX_LINE_RE = re.compile(r"at lines? (\d+)")
CS_RE = re.compile(r"\\(?:[^\W\d_]|@)+|\\.")
FILE_NOT_FOUND = re.compile(r"File `([^']+)' not found")
IMPORTANT = re.compile(r"(?:reference|citation)s?\b.*\bundefined|there were undefined|multiply[- ]defined|"
                       r"rerun|^No file |^Missing character", re.I)
CITE_UNDEF = re.compile(r"citation\b.*\bundefined|there were undefined (?:citations|references)", re.I)
END_MISSING = "file ended without \\end{document}"
_CTX_START = ("l.", "<", "\\")


def _err(file, line, message, context=""):
    return {"file": file, "line": int(line or 0), "message": message, "context": context}


def _warn(file, line, message):
    return {"file": file, "line": int(line or 0), "message": message,
            "important": bool(IMPORTANT.search(message))}


class _FileStack:
    """Tracks TeX's open-file stack from the '(' and ')' in the log, to tell which file a warning
    came from. Best effort: document text can hold unbalanced parens, so parse_log drops any
    attribution whose line number doesn't fit in the file (the warning then has file '')."""

    def __init__(self, base):
        self.base = str(base)
        self.stack = []
        self.cache = {}

    def _isfile(self, name):
        if name not in self.cache:
            p = name if os.path.isabs(name) else os.path.join(self.base, name)
            self.cache[name] = os.path.isfile(p)
        return self.cache[name]

    def _file_at(self, line, j):
        rest = line[j:]
        if not rest or rest[0] in " ()":
            return None
        if rest[0] == '"':                       # some engines quote names with spaces
            k = rest.find('"', 1)
            if k > 1 and self._isfile(rest[1:k]):
                return rest[: k + 1]
            return None
        cut = len(rest)
        for ch in "()":
            k = rest.find(ch)
            if k != -1:
                cut = min(cut, k)
        words = rest[:cut].split(" ")[:8]
        for k in range(len(words), 0, -1):       # names can contain spaces: longest match wins
            cand = " ".join(words[:k]).rstrip()
            if ("." in cand or "/" in cand) and self._isfile(cand):
                return cand
        return None

    def feed(self, line):
        i, n = 0, len(line)
        while i < n:
            ch = line[i]
            if ch == "(":
                name = self._file_at(line, i + 1)
                if name is not None:
                    self.stack.append(name.strip('"'))
                    i += 1 + len(name)
                    continue
                self.stack.append(None)
            elif ch == ")" and self.stack:
                self.stack.pop()
            i += 1

    def current(self):
        """The innermost open file that isn't in the build folder (an .aux being read at
        \\begin{document} belongs to the document that reads it)."""
        for name in reversed(self.stack):
            if name is not None and not name.startswith(BUILD_DIR + "/") and f"/{BUILD_DIR}/" not in name:
                return name
        return ""


def _stop_reason(lines, k):
    """Why TeX made an emergency stop: its '*** (...)' line, an iftex-style banner, or LuaTeX's
    '<*>' context (which means the input ran out before \\end{document})."""
    why = ""
    for ln in lines[k + 1: k + 10]:
        if ln.startswith("*** ("):
            why = ln[4:].strip()
            why = why[1:-1] if why.startswith("(") and why.endswith(")") else why
            break
    if "no legal \\end found" in why:
        return END_MISSING
    # \RequireXeTeX and friends print a " * XeTeX is required ..." box just before stopping
    banner = [ln.strip().strip("* ").strip() for ln in lines[max(0, k - 12): k]
              if re.match(r"^ \* +\S", ln) and ln.strip().strip("* ")]
    if banner:
        return " ".join(banner) + " (Emergency stop)"
    if why:
        return f"Emergency stop ({why})"
    if k + 1 < len(lines) and lines[k + 1].startswith("<*>"):
        return END_MISSING
    return "Emergency stop."


def parse_log(text, base):
    """Errors and warnings from a TeX log (written with -file-line-error and max_print_line=10000).
    Returns (errors, warnings) as result dicts; file paths are relative to base when inside it."""
    base = str(base)
    lines = [ln[:-1] if ln.endswith("\r") else ln for ln in text.split("\n")]
    n = len(lines)
    errors, warnings = [], []
    files = _FileStack(base)
    runaway = None          # (kind, preview, index) of a "Runaway argument?" waiting for its error
    in_block = False        # inside an error context or box dump: parens there are document text
    exist = {}

    def isfile(name):
        if name not in exist:
            exist[name] = os.path.isfile(name if os.path.isabs(name) else os.path.join(base, name))
        return exist[name]

    def add_error(i, fname, lineno, msg):
        nonlocal runaway
        j = i + 1
        parts = [msg]
        # \MessageBreak continuations: "(pkg)   more text" or space-indented lines, up to a blank
        while j < n and j <= i + 20 and lines[j].strip():
            mm = CONT_PKG.match(lines[j])
            if mm:
                parts.append(lines[j][mm.end():].strip())
            elif lines[j][0] in " \t":
                parts.append(lines[j].strip())
            else:
                break
            j += 1
        msg = " ".join(" ".join(parts).split())
        msg = re.sub(r"(\\[A-Za-z@]+) \.$", r"\1.", msg)          # "use of \textbf ." -> "\textbf."
        first_ctx = lines[j] if j < n else ""
        ctx = ""
        for k in range(j, min(j + 12, n)):
            if re.match(r"^l\.\d+ ", lines[k]) or re.match(r"^l\.\d+$", lines[k]):
                ctx = lines[k].rstrip()
                break
            if k > j and (lines[k].startswith("! ") or ERR_RE.match(lines[k])):
                break
        if msg.startswith("Emergency stop"):
            if errors:                 # a consequence of the error already reported (missing file)
                if not errors[-1]["file"] and fname:
                    errors[-1]["file"], errors[-1]["line"] = _norm(base, fname), lineno
                return j
            msg = _stop_reason(lines, i)
            if msg == END_MISSING:
                fname, lineno = "", 0          # run_build points this at the end of the main file
        elif msg.startswith("Undefined control sequence"):
            # TeX breaks the first context line right after the culprit
            if first_ctx.startswith(_CTX_START):
                cs = CS_RE.findall(first_ctx)
                if cs:
                    msg = f"Undefined control sequence {cs[-1]}"
        if runaway and i - runaway[2] <= 4:
            kind, preview = runaway[0], runaway[1]
            short = preview if len(preview) <= 60 else preview[:60].rstrip() + "…"
            msg = f"{msg} Runaway {kind}: {short}"
            ctx = f"Runaway {kind}? {preview}"
            runaway = None
        errors.append(_err(_norm(base, fname) if fname else "", lineno, msg, ctx))
        return j

    i = 0
    while i < n:
        ln = lines[i]
        if not ln.strip():
            in_block = False
            i += 1
            continue
        m = ERR_RE.match(ln)
        if m and not isfile(m.group(1)):
            m = None
        if m:
            msg = m.group(3).strip()
            if msg.startswith("==> Fatal error"):
                i += 1
                continue
            i = add_error(i, m.group(1), int(m.group(2)), msg)
            in_block = True
            continue
        if ln.startswith("! "):
            msg = ln[2:].strip()
            if msg.startswith("==> Fatal error"):
                i += 1
                continue
            i = add_error(i, "", 0, msg)
            in_block = True
            continue
        rm = RUNAWAY_RE.match(ln)
        if rm:
            preview = lines[i + 1].strip() if i + 1 < n else ""
            runaway = (rm.group(1), preview, i)
            i += 2
            in_block = True
            continue
        if WARN_RE.match(ln):
            parts, j = [ln.strip()], i + 1
            while j < n and lines[j].strip():
                mm = CONT_PKG.match(lines[j])
                if mm:
                    parts.append(lines[j][mm.end():].strip())
                elif lines[j].startswith("    "):
                    parts.append(lines[j].strip())
                else:
                    break
                j += 1
            msg = " ".join(" ".join(parts).split())
            nums = INPUT_LINE_RE.findall(msg)
            warnings.append(_warn(_norm(base, files.current()), nums[-1] if nums else 0, msg))
            i = j
            continue
        if BOX_RE.match(ln):
            bm = BOX_LINE_RE.search(ln)
            warnings.append(_warn(_norm(base, files.current()), bm.group(1) if bm else 0, ln.strip()))
            in_block = True              # the box contents follow, up to a blank line
            i += 1
            continue
        if ln.startswith("Missing character:"):
            warnings.append(_warn("", 0, ln.strip()))
            i += 1
            continue
        if NOFILE_RE.match(ln):
            warnings.append(_warn("", 0, ln.strip()))
            i += 1
            continue
        if ln.startswith(("pdfTeX warning", "LuaTeX warning")):
            warnings.append(_warn("", 0, ln.strip()))
            i += 1
            continue
        if not in_block:
            files.feed(ln)
        i += 1

    # TeX can repeat an error; keep the first of each.
    seen, uniq = set(), []
    for e in errors:
        key = (e["file"], e["line"], e["message"])
        if key not in seen:
            seen.add(key)
            uniq.append(e)
    # A warning attributed to a project file must fit in it, else the paren tracking slipped.
    sizes = {}
    for w in warnings:
        if w["file"] and not os.path.isabs(w["file"]) and w["line"]:
            if w["file"] not in sizes:
                p = os.path.join(base, w["file"])
                sizes[w["file"]] = len(_read(p).split("\n")) if os.path.isfile(p) else 0
            if w["line"] > sizes[w["file"]]:
                w["file"] = ""
    # "Missing character" can appear hundreds of times: one warning per font, with the glyphs.
    lost, rest = {}, []
    for w in warnings:
        mc = re.match(r"Missing character: There is no (.+?)(?: \([^)]*\))? in font (.+?)!$", w["message"])
        if not mc:
            rest.append(w)
            continue
        if mc.group(2) not in lost:
            lost[mc.group(2)] = [[], 0, len(rest)]
            rest.append(None)                        # placeholder keeps the log order
        entry = lost[mc.group(2)]
        if mc.group(1) not in entry[0]:
            entry[0].append(mc.group(1))
        entry[1] += 1
    for font, (chars, total, pos) in lost.items():
        shown = ", ".join(chars[:15]) + (", …" if len(chars) > 15 else "")
        times = f" ({total} times)" if total > 1 else ""
        rest[pos] = _warn("", 0, f"Missing character: There is no {shown} in font {font}!{times}")
    warnings = rest
    # Collapse other exact repeats.
    counts, order = {}, []
    for w in warnings:
        key = (w["file"], w["line"], w["message"])
        if key not in counts:
            counts[key] = 0
            order.append(w)
        counts[key] += 1
    out = []
    for w in order:
        k = counts[(w["file"], w["line"], w["message"])]
        if k > 1:
            w = dict(w, message=f"{w['message']} ({k} times)")
        out.append(w)
    return uniq, out


# ---------------------------------------------------------------------------------------------
# Bibliography helpers
# ---------------------------------------------------------------------------------------------

BLG_LINE = re.compile(r"^(.*?)---line (\d+) of file (.+?)\s*$")
BLG_WHILE = re.compile(r"^(.+?)---while reading file (.+?)\s*$")


def _bib_names(base, out, stem, main_code):
    """(name, kind) for every bibliography the document names: \\bibdata in the .aux (bibtex),
    the .bcf datasources or \\addbibresource (biblatex)."""
    names = []
    aux = _read(out / f"{stem}.aux")
    for m in re.finditer(r"\\bibdata\{([^}]*)\}", aux):
        for nm in m.group(1).split(","):
            nm = nm.strip()
            if nm:
                names.append((nm if nm.lower().endswith(".bib") else nm + ".bib", "bibliography"))
    bcf = _read(out / f"{stem}.bcf")
    srcs = re.findall(r"<bcf:datasource[^>]*>([^<]+)</bcf:datasource>", bcf)
    if not srcs:
        srcs = [s for m in re.finditer(r"\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}", main_code)
                for s in [m.group(1)]]
    for s in srcs:
        s = html.unescape(s).strip()
        if s and "://" not in s and not any(ch in s for ch in "*?"):
            names.append((s, "addbibresource"))
    seen, uniq = set(), []
    for item in names:
        if item[0] not in seen:
            seen.add(item[0])
            uniq.append(item)
    return uniq


def _find_bib(base, name, env):
    """Where bibtex/biber will find a database: the project folder, the build folder (biblatex's
    <job>-blx.bib), or TeX's search path. None if nowhere."""
    if os.path.isabs(name):
        return Path(name) if os.path.isfile(name) else None
    for p in (base / name, base / BUILD_DIR / name):
        if p.is_file():
            return p
    found = _kpsewhich(name, env, base)
    return Path(found) if found else None


def _find_in_sources(base, sources, pattern, cache):
    """(rel path, line) of the first source line matching pattern (comments ignored)."""
    rx = re.compile(pattern)
    for rel in sources:
        for k, ln in enumerate(_source_lines(base / rel, cache), 1):
            if rx.search(COMMENT.sub(r"\1", ln)):
                return rel, k
    return "", 0


def _parse_blg(text, base, sources, cache):
    """BibTeX/biber errors from the .blg as contract error dicts, plus BibTeX warnings."""
    errors, warnings = [], []
    lines = text.split("\n")
    for k, ln in enumerate(lines):
        m = BLG_LINE.match(ln)
        if m:
            msg = m.group(1).strip() or (lines[k - 1].strip() if k else "")
            fname, lineno = m.group(3), int(m.group(2))
            for nxt in lines[k + 1: k + 6]:          # after BibTeX's " : " context lines
                if nxt.startswith("(Error may have been on previous line)"):
                    msg += " (the error may be on the line before)"
                    break
                if not nxt.startswith(" : "):
                    break
            if fname.lower().endswith(".aux"):
                # BibTeX blames the .aux; point at the TeX command that caused it instead
                dm = re.search(r"database file (.+)$", msg)
                if dm:
                    stem = re.escape(Path(dm.group(1).strip()).stem)
                    rel, line = _find_in_sources(base, sources, r"\\bibliography\s*\{[^}]*" + stem, cache)
                elif "style file" in msg:
                    rel, line = _find_in_sources(base, sources, r"\\bibliographystyle\s*\{", cache)
                else:
                    rel, line = _find_in_sources(base, sources, r"\\bibliography\s*\{", cache)
                errors.append(_err(rel, line, "BibTeX: " + msg))
            else:
                errors.append(_err(_norm(str(base), fname), lineno, msg))
            continue
        m = BLG_WHILE.match(ln)
        if m and m.group(1).startswith("I found no"):
            what = m.group(1)
            pattern = r"\\bibliographystyle\s*\{" if "bibstyle" in what else r"\\bibliography\s*\{"
            rel, line = _find_in_sources(base, sources, pattern, cache)
            hint = {"\\bibstyle": " (add \\bibliographystyle{plain} or another style)",
                    "\\citation": " (nothing is cited: add a \\cite or \\nocite{*})",
                    "\\bibdata": " (add \\bibliography{yourfile})"}
            extra = next((h for key, h in hint.items() if key in what), "")
            errors.append(_err(rel, line, "BibTeX: " + what + extra))
            continue
        if ln.startswith("Warning--"):
            w = _warn("", 0, "BibTeX " + ln.strip())
            if w not in warnings:
                warnings.append(w)
            continue
        bm = re.search(r"\bERROR - (.+)$", ln)            # biber
        if bm:
            msg = bm.group(1).strip()
            lm = re.search(r"([^/\s]+\.bib)_\d+\.utf8, line (\d+)", msg)
            errors.append(_err(lm.group(1) if lm else "", lm.group(2) if lm else 0, "biber: " + msg))
            continue
        wm = re.search(r"\bWARN - (.+)$", ln)
        if wm:
            warnings.append(_warn("", 0, "biber: " + wm.group(1).strip()))
    return errors, warnings


# ---------------------------------------------------------------------------------------------
# Running latexmk
# ---------------------------------------------------------------------------------------------

_ACTIVE = set()                    # process groups of running builds, killed if we exit early
_ACTIVE_LOCK = threading.Lock()


def _kill_active():
    with _ACTIVE_LOCK:
        pids = list(_ACTIVE)
    for pid in pids:
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass


atexit.register(_kill_active)


def _kill_group(proc):
    """SIGTERM latexmk's whole process group (latexmk, pdflatex, bibtex...), then SIGKILL what is
    left, and reap latexmk so no zombie stays behind."""
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except OSError:
        pass
    try:
        proc.wait(1.0)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except OSError:
        pass
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        pass


def _run_latexmk(cmd, base, env, deadline, cancel):
    """One latexmk run in its own process group. Output goes to a temp file, so a long transcript
    can't block on a full pipe while we poll for cancel/timeout. Returns (rc, status, output)."""
    with tempfile.TemporaryFile() as out:
        proc = subprocess.Popen(cmd, cwd=str(base), env=env, stdin=subprocess.DEVNULL, stdout=out,
                                stderr=subprocess.STDOUT, start_new_session=True)
        with _ACTIVE_LOCK:
            _ACTIVE.add(proc.pid)
        status = ""
        try:
            while True:
                try:
                    proc.wait(0.1)
                    break
                except subprocess.TimeoutExpired:
                    pass
                if cancel is not None and cancel.is_set():
                    status = "cancelled"
                elif deadline is not None and time.monotonic() >= deadline:
                    status = "timed_out"
                if status:
                    _kill_group(proc)
                    break
        except BaseException:          # Ctrl-C, SIGTERM: never leave pdflatex running behind us
            _kill_group(proc)
            raise
        finally:
            with _ACTIVE_LOCK:
                _ACTIVE.discard(proc.pid)
        out.seek(0)
        text = out.read().decode("utf-8", "replace")
    return proc.returncode, status, text


def _mirror_dirs(base, out, depth=4, max_dirs=3000):
    """Create .texc/<sub> for every source folder holding .tex files, so \\include{sub/x} can write
    .texc/sub/x.aux (TeX can't create folders, and latexmk's own fix is disabled by
    -file-line-error). Anything missed here is caught by the "can't write" retry."""
    for visited, (root, dirs, files) in enumerate(os.walk(base)):
        if visited >= max_dirs:
            break
        rel = os.path.relpath(root, base)
        parts = [] if rel == "." else rel.split(os.sep)
        if len(parts) >= depth:
            dirs[:] = []
        else:
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in _SKIP_DIRS]
        if parts and any(f.endswith(".tex") for f in files):
            os.makedirs(os.path.join(out, rel), exist_ok=True)


def _cant_write_dirs(log_text, out):
    """Subfolders of .texc that TeX said it couldn't write into ("I can't write on file `d/x.aux'")."""
    dirs = set()
    out_r = os.path.realpath(out)
    for m in re.finditer(r"I can't write on file `(.+)/[^/']+'", log_text):
        d = os.path.realpath(os.path.join(out, m.group(1)))
        if d.startswith(out_r + os.sep) and not os.path.isdir(d):
            dirs.add(d)
    return dirs


_AUX_CUT = re.compile(r"File ended while scanning use of \\(?:@writefile|newlabel|@newl@bel|bibcite|"
                      r"contentsline|BOOKMARK|abx@aux@\w+|beamer@\w+|@input)\b")
_AUXLIKE = {".aux", ".toc", ".lof", ".lot", ".loa", ".out", ".nav", ".snm", ".bbl", ".brf"}


def _balanced_end(data, unbalanced_only=False):
    """Offset just after the last newline at brace depth 0 (escaped braces don't count). With
    unbalanced_only, a file whose braces are balanced at the end is left whole (len(data))."""
    depth, last, i, n = 0, 0, 0, len(data)
    while i < n:
        b = data[i]
        if b == 0x5C:              # backslash: skip the escaped character
            i += 2
            continue
        if b == 0x7B:
            depth += 1
        elif b == 0x7D:
            depth -= 1
        elif b == 0x0A and depth <= 0:
            last, depth = i + 1, 0
        i += 1
    if unbalanced_only and depth <= 0:
        return n
    return last


def _trim_aux(out, since_ns=0, unbalanced_only=False):
    """Trim .aux/.toc/... files in the build folder back to their last complete entry. A killed
    pdflatex leaves them cut mid-entry, which makes every later run fail with "File ended while
    scanning use of \\@writefile". Returns True if a file was changed."""
    changed = False
    for root, dirs, files in os.walk(out):
        if root == str(out):
            dirs[:] = [d for d in dirs if d not in KEEP_DIRS]
        for f in files:
            if os.path.splitext(f)[1] not in _AUXLIKE:
                continue
            p = os.path.join(root, f)
            try:
                if os.stat(p).st_mtime_ns < since_ns:
                    continue
                with open(p, "rb") as fh:
                    data = fh.read()
                cut = _balanced_end(data, unbalanced_only)
                if cut < len(data):
                    with open(p, "r+b") as fh:
                        fh.truncate(cut)
                    changed = True
            except OSError:
                pass
    return changed


def _restore_good(out, stem, since_ns=None):
    """Put the last good PDF (and its SyncTeX file) back when this run deleted it, or, after a
    kill (since_ns given), when this run may have left it half-written. pdfTeX deletes the PDF of
    a failed run; the GUI keeps showing (and syncing) the previous one."""
    for name, good in ((f"{stem}.pdf", f"{stem}.texc-good.pdf"),
                       (f"{stem}.synctex.gz", f"{stem}.texc-good.synctex.gz")):
        cur, bak = out / name, out / good
        st = _stat(cur)
        if bak.is_file() and (st is None or (since_ns is not None and st[0] >= since_ns)):
            try:
                shutil.copy2(bak, cur)
            except OSError:
                pass


def _repair_after_kill(out, stem, since_ns):
    """After killing a build: fix the aux files it was writing and put the last good PDF back
    over a half-written one."""
    _trim_aux(out, since_ns)
    _restore_good(out, stem, since_ns)


def _project_sources(base, out, stem, main):
    """Project .tex files the last build read, main first (from the .fls recorder file)."""
    srcs = [main.name]
    fls = _read(out / f"{stem}.fls")
    pwd = str(base)
    for ln in fls.split("\n"):
        if ln.startswith("PWD "):
            pwd = ln[4:].strip()
        elif ln.startswith("INPUT ") and ln.rstrip().lower().endswith(".tex"):
            full = os.path.normpath(os.path.join(pwd, ln[6:].strip()))
            rel = os.path.relpath(full, base)
            if not _outside(rel) and not rel.startswith(BUILD_DIR + os.sep) and rel not in srcs:
                srcs.append(rel)
    return srcs


def _relocate(errors, warnings, base, main, sources, cache):
    """Point errors at the line that caused them rather than where TeX noticed:
    - "File `x.sty' not found": \\usepackage reads ahead for [date], so TeX's line is one too far;
    - "file ended without \\end{document}": the end of the main file;
    - runaway arguments: the line where the unclosed argument begins."""
    for e in errors:
        msg = e["message"]
        fm = FILE_NOT_FOUND.search(msg)
        if fm:
            name = fm.group(1)
            stem = name.rsplit(".", 1)[0] if "." in name.rsplit("/", 1)[-1] else name
            if e["file"] and e["line"]:
                src = _source_lines(_abs(base, e["file"]), cache)
                for k in range(min(e["line"], len(src)), max(0, e["line"] - 40), -1):
                    if stem in src[k - 1]:
                        e["line"] = k
                        break
            elif not e["file"]:
                rel, line = _find_in_sources(base, sources, re.escape(stem), cache)
                if rel:
                    e["file"], e["line"] = rel, line
            continue
        if msg == END_MISSING and not e["file"]:
            src = _source_lines(main, cache)
            last = max((k for k, ln in enumerate(src, 1) if ln.strip()), default=0)
            e["file"], e["line"] = main.name, last
            continue
        if e["context"].startswith("Runaway"):
            preview = e["context"].split("?", 1)[1].strip().lstrip("{").strip()
            words = preview.split("\\", 1)[0].split()[:8]
            # TeX's preview joins source lines with spaces: try the longest prefix on one line
            snippets = [s for s in (" ".join(words[:k]) for k in range(len(words), 0, -1)) if len(s) >= 6]
            if not snippets:
                continue
            if e["file"] and e["line"] and not os.path.isabs(e["file"]):
                src = _source_lines(base / e["file"], cache)
                lo = max(0, e["line"] - 60)
                hit = next((k for snip in snippets for k in range(min(e["line"], len(src)), lo, -1)
                            if snip in src[k - 1]), 0)
                if hit:
                    e["line"] = hit
                    continue
            for snip in snippets:
                hits = [(rel, k) for rel in sources
                        for k, ln in enumerate(_source_lines(base / rel, cache), 1) if snip in ln]
                if hits:
                    if not e["file"] or len(hits) == 1:
                        e["file"], e["line"] = hits[0]
                    break
    for w in warnings:
        nm = NOFILE_RE.match(w["message"])
        if nm and not w["file"]:
            stem = nm.group(1)[:-4]
            rel, line = _find_in_sources(base, sources, r"\\(?:include|input)\s*\{\s*" + re.escape(stem), cache)
            w["file"], w["line"] = rel, line


_DECISIVE = re.compile(r"command not found|Error return from|Could not find|No pages of output|Failure to make|Bibtex errors|"
                       r"^\s*\*\*\* |^! |not found in search path|Permission denied|Can't exec|Bad option|"
                       r"unknown option|gave return code", re.I)


def _decisive_lines(output):
    """The lines of a latexmk transcript that say why it failed, and its error summary."""
    lines = [ln.rstrip() for ln in output.split("\n")]
    key, seen = [], set()
    for ln in lines:
        s = ln.strip()
        if s and _DECISIVE.search(ln) and s not in seen and not s.startswith("Latexmk: Sometimes"):
            seen.add(s)
            key.append(s)
    tail = []
    if "Collected error summary (may duplicate other messages):" in lines:
        k = lines.index("Collected error summary (may duplicate other messages):") + 1
        while k < len(lines) and not lines[k].startswith("Latexmk: Sometimes") and len(tail) < 6:
            s = lines[k].strip()
            if s and not s.startswith("Refer to") and s not in seen:
                tail.append(s)
            k += 1
    if not tail:
        tail = [s for s in (ln.strip() for ln in lines) if s and s not in seen][-6:]
    return key[:6], tail


def _result(main, base, engine):
    out = base / BUILD_DIR
    return {
        "ok": False, "engine": engine, "duration": 0.0,
        "main": main.name, "root": str(base),
        "pdf": None, "pdf_mtime": None, "log": str(out / f"{main.stem}.log"),
        "errors": [], "warnings": [], "notes": [],
        "cancelled": False, "timed_out": False,
        "output": "", "beside_pdf": None, "copy_error": None,
    }


def run_build(main, engine=None, *, timeout=None, cancel=None, copy_pdf=True):
    """Build main with latexmk into main.parent/.texc and return the result dict (see
    docs/ARCHITECTURE.md). Never prints, never exits; every problem ends up in errors/notes. engine None = auto
    (with one automatic retry when the log asks for XeTeX/LuaTeX). timeout (seconds) and cancel
    (a threading.Event) kill the whole latexmk process group."""
    t0 = time.monotonic()
    start_ns = time.time_ns() - 1_000_000_000        # slack for coarse filesystem timestamps
    main = Path(main).expanduser()
    try:
        main = main.resolve()
    except OSError:
        main = main.absolute()
    base, stem = main.parent, main.stem
    out = base / BUILD_DIR
    res = _result(main, base, None)

    def finish():
        res["duration"] = round(time.monotonic() - t0, 2)
        pdf = out / f"{stem}.pdf"
        st = _stat(pdf)
        if st is not None:
            res["pdf"], res["pdf_mtime"] = str(pdf), os.stat(pdf).st_mtime
        if not (out / f"{stem}.log").is_file():
            res["log"] = None
        return res

    def fail(msg):
        res["errors"].append(_err("", 0, msg))
        return finish()

    if not main.is_file():
        return fail(f"no such file: {main}")
    if base.name.endswith("\\"):
        return fail(f"{_BACKSLASH_DIR}; rename the folder “{base.name}”")
    try:
        eng = pick_engine(main, engine)
    except ValueError as e:
        return fail(str(e))
    res["engine"] = eng
    env = _tex_env()
    lmk = _which("latexmk", env)
    if not lmk:
        return fail("latexmk not found; install TeX Live (https://tug.org/mactex/ or brew install texlive)")
    try:
        out.mkdir(exist_ok=True)
        _mirror_dirs(base, out)
    except OSError as e:
        return fail(f"cannot create {BUILD_DIR}/ in {base}: {e.strerror or e}")
    if cancel is not None and cancel.is_set():
        res["cancelled"] = True
        return finish()

    blg = out / f"{stem}.blg"
    blg_before = _stat(blg)
    deadline = t0 + timeout if timeout else None
    outputs, extra = [], []
    tried, regenerated, switched, healed = set(), False, False, False
    rc, status, text = 1, "", ""
    for _attempt in range(8):
        cmd = [lmk, ENGINES[eng], *_LMK_FLAGS, *extra, "./" + main.name]   # ./ : a leading '-' is no option
        try:
            rc, status, text = _run_latexmk(cmd, base, env, deadline, cancel)
        except OSError as e:
            return fail(f"cannot run latexmk: {e.strerror or e}")
        outputs.append(text)
        if status or rc == 0:
            break
        log_text = _read(out / f"{stem}.log")
        # \include{dir/x} in a folder the mirror didn't create: make it and force a rerun
        new_dirs = _cant_write_dirs(log_text, out) - tried
        if new_dirs:
            try:
                for d in new_dirs:
                    os.makedirs(d, exist_ok=True)
            except OSError:
                break
            tried |= new_dirs
            extra = ["-g"]
            continue
        if engine is None and not switched:
            need, why = _engine_needed(log_text, eng)
            if need:
                res["notes"].append(f"{why}, so texc rebuilt it with {ENGINE_NAMES[need]} (add "
                                    f"'% !TEX program = {ENGINE_NAMES[need]}' as the first line to choose it "
                                    f"directly).")
                eng, switched, extra = need, True, ["-g"]
                res["engine"] = eng
                continue
        # an .aux cut short by an earlier kill (Ctrl-C, kill -9) fails every run: trim it and retry
        if not healed and _AUX_CUT.search(log_text) and _trim_aux(out, 0, unbalanced_only=True):
            healed, extra = True, ["-g"]
            res["notes"].append("A build file in .texc/ was cut short (an interrupted earlier build); "
                                "texc repaired it and rebuilt.")
            continue
        # latexmk won't rerun a rule that failed on unchanged sources; the fix may be outside them
        # (a package installed, a folder created), so force one fresh run
        if not regenerated and "gave an error in previous invocation" in text:
            regenerated, extra = True, ["-g"]
            continue
        break
    res["output"] = "\n".join(outputs)
    if status:
        res[status] = True
        _repair_after_kill(out, stem, start_ns)
        if status == "cancelled":
            return finish()

    pdf_built = out / f"{stem}.pdf"
    ok = rc == 0 and not status and pdf_built.is_file()
    res["ok"] = ok
    log_text = _read(out / f"{stem}.log")
    errors, warnings = parse_log(log_text, base) if log_text else ([], [])
    cache = {}
    sources = _project_sources(base, out, stem, main)
    _relocate(errors, warnings, base, main, sources, cache)
    main_code = "\n".join(_strip_comments(_read(main)))

    # BibTeX/biber problems (only from a .blg written by this build)
    blg_now = _stat(blg)
    bib_errors = []
    if blg_now is not None and blg_now != blg_before:
        bib_errors, bib_warnings = _parse_blg(_read(blg), base, sources, cache)
        warnings.extend(bib_warnings)
        if not ok:
            errors.extend(bib_errors)
    if bib_errors and not ok:     # valid entries look undefined only because bibtex stopped
        for w in warnings:
            if CITE_UNDEF.search(w["message"]):
                w["important"] = False
    if not ok and not _which("biber", env) and (
            re.search(r"biber: (?:command )?not found|Error return from 'biber|Could not open biber log", text)
            or ((out / f"{stem}.bcf").is_file() and re.search(r"\(re\)run Biber", log_text))):
        rel, line = _find_in_sources(base, sources, r"\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*biblatex", cache)
        errors.append(_err(rel or main.name, line, "biblatex needs biber, which is not installed"))
        for w in warnings:
            if CITE_UNDEF.search(w["message"]):
                w["important"] = False
        res["notes"].append("biber is not installed, but biblatex is set to use it (backend=biber is its "
                            "default). Install it (brew install biber, or sudo tlmgr install biber) or use "
                            "\\usepackage[backend=bibtex]{biblatex}.")
    # A \bibliography{name} whose file doesn't exist: latexmk silently skips bibtex then.
    for name, kind in _bib_names(base, out, stem, main_code):
        if _find_bib(base, name, env) is None and not any(name in e["message"] for e in errors):
            pattern = (r"\\bibliography\s*\{[^}]*" if kind == "bibliography" else r"\\addbibresource\s*(?:\[[^\]]*\])?\s*\{[^}]*") \
                + re.escape(Path(name).stem)
            rel, line = _find_in_sources(base, sources, pattern, cache)
            where = f" (\\{kind}{{...}} at {rel}:{line})" if rel else ""
            hint = "check the name and that the file exists"
            if kind == "bibliography" and re.search(r"\\bibliography\s*\{[^}]*\s[^}]*\}", main_code):
                hint = "LaTeX drops spaces from \\bibliography{...} names, so rename the .bib without spaces"
            res["notes"].append(f"bibliography file {name} not found{where}, so the citations stay undefined; "
                                f"{hint}.")
    if eng == "pdf" and any("not set up for use with LaTeX" in e["message"] for e in errors):
        res["notes"].append("pdflatex has no glyph for that character in the current font encoding: load one "
                            "that has it (Vietnamese: \\usepackage[T5]{fontenc}) or use a Unicode engine "
                            "(texc -e xe, or '% !TEX program = xelatex' as the first line).")
    if res["timed_out"]:
        errors.append(_err(main.name, 0, f"the build was stopped after {timeout:g} s (timeout); "
                                         f"the document may loop forever"))
    if not ok and not errors:
        key, tail = _decisive_lines(text)
        if not key:
            key = [f"latexmk failed (exit code {rc})"]
        errors = [_err("", 0, k) for k in key]
        res["tail"] = tail
    res["errors"], res["warnings"] = errors, warnings

    if ok:
        try:                                     # kept so a failed run can't take the PDF away
            _sync_copy(pdf_built, out / f"{stem}.texc-good.pdf")
            if (out / f"{stem}.synctex.gz").is_file():
                _sync_copy(out / f"{stem}.synctex.gz", out / f"{stem}.texc-good.synctex.gz")
        except OSError:
            pass
        if copy_pdf:
            beside = base / f"{stem}.pdf"
            try:
                _sync_copy(pdf_built, beside)
                syn = out / f"{stem}.synctex.gz"
                if syn.is_file():                # viewers look for it next to the PDF they show
                    _sync_copy(syn, base / syn.name)
                res["beside_pdf"] = str(beside)
            except OSError as e:
                res["copy_error"] = f"could not update {beside.name}: {e.strerror or e}"
                res["notes"].append(f"The build succeeded, but {beside.name} could not be updated "
                                    f"({e.strerror or e}); the new PDF is {BUILD_DIR}/{pdf_built.name}.")
    elif not status:
        _restore_good(out, stem)
    return finish()


def clean(base):
    """Remove the build files in base/.texc, keeping KEEP_DIRS (GUI chats, trash, uploads).
    Returns the removed names (sorted); [] if there was nothing. Raises OSError when an entry
    can't be removed (after trying all of them)."""
    target = Path(base) / BUILD_DIR
    if not target.is_dir():
        return []
    removed, failure = [], None
    with os.scandir(target) as it:
        entries = sorted(it, key=lambda e: e.name)
    for entry in entries:
        try:
            is_dir = entry.is_dir(follow_symlinks=False)
            if is_dir and entry.name in KEEP_DIRS:
                continue
            if is_dir:
                shutil.rmtree(entry.path)
            else:
                os.unlink(entry.path)
            removed.append(entry.name)
        except OSError as e:
            if failure is None:
                failure = OSError(e.errno, f"cannot remove {BUILD_DIR}/{entry.name}: {e.strerror or e}")
    if failure is not None:
        raise failure
    return removed


# ---------------------------------------------------------------------------------------------
# CLI rendering
# ---------------------------------------------------------------------------------------------

def _clip(src, message):
    """A long source line cut to the part around the culprit (e.g. the undefined macro)."""
    src = src.rstrip()
    if len(src) <= 200:
        return src
    m = re.search(r"(\\\S+)$", message)
    k = src.find(m.group(1)) if m else -1
    if k < 0:
        return src[:200] + " …"
    a, b = max(0, k - 80), min(len(src), k + len(m.group(1)) + 80)
    return ("… " if a else "") + src[a:b] + (" …" if b < len(src) else "")


def print_result(result, verbose=False):
    """Render a run_build() result the way the texc CLI always has."""
    root = Path(result.get("root") or ".")
    eng = ENGINE_NAMES.get(result.get("engine"), result.get("engine") or "?")
    dur = f"({result.get('duration') or 0:.1f}s, {eng})"
    main_path = root / result.get("main", "")
    main_disp = _display(main_path)
    if result.get("cancelled"):
        print(c("33", "✗ ") + f"{main_disp} cancelled  {dur}")
        return
    if result.get("timed_out"):
        print(c("31", "✗ ") + f"{main_disp} timed out  {dur}")
    elif result.get("ok") and result.get("copy_error"):
        print(c("31", "✗ ") + f"{main_disp} built, but {result['copy_error']}  {dur}")
    elif result.get("ok"):
        print(c("32", "✓ ") + f"{_display(result.get('beside_pdf') or result.get('pdf') or main_path)}  {dur}")
    else:
        print(c("31", "✗ ") + f"{main_disp} failed  {dur}")

    fallback = result.get("tail") is not None
    cache = {}
    for e in result.get("errors", []):
        if fallback:                        # not a TeX error: show what latexmk said
            print(c("2", "  | ") + e["message"])
            continue
        path = _abs(root, e["file"]) if e.get("file") else main_path
        where = _display(path) + (f":{e['line']}" if e.get("line") else "")
        print(f"  {c('1', where)}: {c('31', e['message'])}")
        src = None
        if e.get("file") and e.get("line"):
            lines = _source_lines(path, cache)
            if 0 < e["line"] <= len(lines) and path.is_file():
                src = lines[e["line"] - 1]
        if src is not None:
            print(c("2", f"  {e['line']:>5} | ") + _clip(src, e["message"]))
        elif e.get("context"):
            print(c("2", f"        {e['context']}"))
    if fallback:
        for ln in result["tail"]:
            print(c("2", "  | ") + ln)

    warnings = result.get("warnings", [])
    shown = warnings if verbose else [w for w in warnings if w.get("important")]
    for w in shown:
        print(c("33", "  ! ") + w["message"])
    hidden = len(warnings) - len(shown)
    if hidden:
        print(c("2", f"  ({hidden} more warning{'s' * (hidden != 1)}; -v to show)"))
    for note in result.get("notes", []):
        if result.get("copy_error") and note.startswith("The build succeeded, but"):
            continue                        # already said in the header line
        print(c("36", "  note: ") + note)


# ---------------------------------------------------------------------------------------------
# Watch mode
# ---------------------------------------------------------------------------------------------

_MISSING_RE = re.compile(r"File `([^']+)' not found|^No file (.+\.tex)\.$|I can't find file `([^']+)'", re.M)
_GRAPHIC_EXTS = (".tex", ".pdf", ".png", ".jpg", ".jpeg", ".eps")


def watched_files(main):
    """Every file the last build of main used (from the .fls), wherever it lives, except TeX's own
    trees, the build folder and files the build itself wrote; plus the .bib/.bst files bibtex or
    biber read, and the files the last log said were missing (so creating them triggers a build)."""
    main = Path(main).resolve()
    base, stem = main.parent, main.stem
    out = base / BUILD_DIR
    skip = [os.path.normpath(str(out)), os.path.realpath(str(out))] + _tex_roots()

    def keep(path):
        return not _under(path, skip) and not path.startswith("/dev/")

    files = {main}
    fls = _read(out / f"{stem}.fls")
    if fls:
        pwd, inputs, outputs = str(base), [], set()
        for ln in fls.split("\n"):
            if ln.startswith("PWD "):
                pwd = ln[4:].strip()
            elif ln.startswith("INPUT "):
                inputs.append(os.path.normpath(os.path.join(pwd, ln[6:].strip())))
            elif ln.startswith("OUTPUT "):
                outputs.add(os.path.normpath(os.path.join(pwd, ln[7:].strip())))
        for p in inputs:
            if p not in outputs and keep(p):
                files.add(Path(p))
    for m in _MISSING_RE.finditer(_read(out / f"{stem}.log")):
        name = next(g for g in m.groups() if g)
        p = os.path.normpath(os.path.join(str(base), name))
        if not keep(p):
            continue
        files.add(Path(p))
        if "." not in os.path.basename(p):
            files.update(Path(p + ext) for ext in _GRAPHIC_EXTS)
    env = _tex_env()
    main_code = "\n".join(_strip_comments(_read(main)))
    for name, _kind in _bib_names(base, out, stem, main_code):
        found = _find_bib(base, name, env)
        p = os.path.normpath(str(found if found else (Path(name) if os.path.isabs(name) else base / name)))
        if keep(p):
            files.add(Path(p))
    for m in re.finditer(r"\\bibstyle\{([^}]*)\}", _read(out / f"{stem}.aux")):
        bst = base / (m.group(1).strip() + ".bst")
        if bst.is_file():
            files.add(bst)
    return files


def snapshot(files):
    """{path: (mtime_ns, size) or None if missing}"""
    return {p: _stat(p) for p in files}


def _stamp():
    return c("2", time.strftime("[%H:%M:%S] "))


def _build_watched(main, forced, snap):
    """run_build in a worker thread while this thread keeps polling the sources; a change cancels
    the build (an infinite-loop document can't block the watcher). Ctrl-C cancels it too."""
    cancel = threading.Event()
    box = {}

    def work():
        try:
            box["result"] = run_build(main, forced, cancel=cancel)
        except BaseException as exc:      # handed to the main thread
            box["error"] = exc

    th = threading.Thread(target=work, name="texc-build", daemon=True)
    th.start()
    try:
        while True:
            th.join(0.3)
            if not th.is_alive():
                break
            if not cancel.is_set() and snapshot(snap.keys()) != snap:
                cancel.set()
    except BaseException:
        cancel.set()
        th.join(10)
        raise
    if "error" in box:
        raise box["error"]
    return box["result"]


def watch(main, forced=None, verbose=False, open_pdf=False):
    """Rebuild main whenever a file it uses changes. The engine is re-detected before every build
    unless forced. The baseline snapshot is taken before each build, so a save at any moment is
    seen; a save during a build restarts it."""
    main = Path(main).resolve()
    print(c("2", f"watching {_display(main)} (Ctrl-C to stop)"))
    files = watched_files(main)
    snap = snapshot(files)
    opened = False
    while True:
        t_build = time.time_ns()
        result = _build_watched(main, forced, snap)
        if result.get("cancelled"):
            print(_stamp() + "change detected, restarting the build")
            time.sleep(0.15)
            files = watched_files(main) | set(snap)
            snap = snapshot(files)
            continue
        print_result(result, verbose)
        if open_pdf and not opened and result.get("ok"):
            open_file(result.get("beside_pdf") or result.get("pdf"))
            opened = True
        fresh = watched_files(main)
        # a failed run stops early and records fewer inputs: keep watching the earlier ones
        files = fresh if result.get("ok") else fresh | set(snap)
        for p in files - snap.keys():            # inputs this build discovered
            st = _stat(p)
            snap[p] = st if st is None or st[0] < t_build else ("edited during the build",)
        for p in set(snap) - files:
            del snap[p]
        while snapshot(snap.keys()) == snap:
            time.sleep(0.3)
        time.sleep(0.15)                          # let the editor finish writing
        print(_stamp() + "change detected")
        snap = snapshot(files)                    # the baseline for the next build, taken before it


def open_file(path):
    if not path or not Path(path).exists():
        return
    opener = "open" if sys.platform == "darwin" else "xdg-open"
    if os.environ.get("TEXC_SILENT") == "1":      # tests: never open a viewer on the user's screen
        print(f"(silent: not opening {path})")
        return
    try:
        subprocess.Popen([opener, str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass


# ---------------------------------------------------------------------------------------------
# GUI entry
# ---------------------------------------------------------------------------------------------

def _free_port(preferred=8765, tries=20):
    import socket
    for port in range(preferred, preferred + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return preferred


def gui_target(arg=None, app_mode=False):
    """What `texc gui [PATH]` opens: an absolute folder or file path, or None for the Welcome
    screen (lobby). A folder is opened as it is (the server picks its main file); anything else
    goes through find_main's conveniences (paper -> paper.tex, main.pdf -> main.tex). No PATH: the
    cwd if it has a main .tex, else the lobby; in app mode always the lobby, because texc.app
    names every folder it wants and its children's cwd isn't the user's (e.g. ~ with a stray .tex)."""
    if not arg:
        if app_mode:
            return None
        cwd = Path.cwd()
        return str(cwd.resolve()) if find_mains(cwd) else None
    p = Path(arg).expanduser()
    if p.is_dir():
        return str(p.resolve())
    return str(find_main(arg))


def _handshake_error(msg):
    """App mode: a startup failure is one TEXC_ERROR line on stdout (texc.app reads it), exit 1."""
    print(f"texc: {msg}", file=sys.stderr, flush=True)
    sys.stdout.write("TEXC_ERROR " + json.dumps({"error": msg}, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    return 1


def run_gui(arg, port, open_browser, app_mode=False):
    """`texc gui`: server.serve() on a folder, a .tex file or the lobby. app_mode (texc.app): no
    browser, the server's ephemeral port unless one is given, and any failure before the server's
    own handshake is a TEXC_ERROR line, so the app never waits for a handshake that can't come."""
    if not app_mode:
        return _run_gui(arg, port, open_browser, False)
    try:
        return _run_gui(arg, port, False, True)
    except TexcError as e:
        return _handshake_error(str(e))
    except Exception as e:                       # a broken server.py, a bug: the app shows it
        import traceback
        traceback.print_exc()
        return _handshake_error(f"the texc server couldn't start: {e!r}")


def _run_gui(arg, port, open_browser, app_mode):
    for need in (HERE / "server.py", HERE / "gui" / "index.html"):
        if not need.is_file():
            if app_mode:
                raise TexcError(f"GUI files missing: {need}")
            print(f"GUI files missing: {need}", file=sys.stderr)
            return 2
    import importlib.util
    import inspect
    target = gui_target(arg, app_mode)
    spec = importlib.util.spec_from_file_location("texc_server", str(HERE / "server.py"))
    server = importlib.util.module_from_spec(spec)
    sys.modules["texc_server"] = server
    spec.loader.exec_module(server)
    try:
        params = inspect.signature(server.serve).parameters
    except (TypeError, ValueError):
        params = {}
    if app_mode:
        if "app_mode" not in params:
            raise TexcError(f"{HERE / 'server.py'} can't run for texc.app (its serve() has no app_mode)")
        rc = server.serve(target, sys.modules[__name__], port, False, app_mode=True)
        return rc if isinstance(rc, int) else 0
    if port is None:
        default = params["port"].default if "port" in params else inspect.Parameter.empty
        if default is None or (isinstance(default, int) and not isinstance(default, bool)):
            port = default
        else:
            port = _free_port()
    rc = server.serve(target, sys.modules[__name__], port, open_browser)
    return rc if isinstance(rc, int) else 0


# ---------------------------------------------------------------------------------------------
# The Mac app and new projects (texc app / install-app / new)
# ---------------------------------------------------------------------------------------------

def _app_bundle():
    return Path.home() / "Applications" / "texc.app"


def _build_app(why=""):
    """bash app/build.sh: builds texc.app and installs it as ~/Applications/texc.app. Its exit code."""
    if sys.platform != "darwin":
        raise TexcError("texc.app is a Mac app; use texc gui instead")
    script = HERE / "app" / "build.sh"
    if not script.is_file():
        raise TexcError(f"{why}can't build texc.app: {script} is missing; use texc gui for now")
    if why:
        print(f"texc: {why}building it (bash app/build.sh)", file=sys.stderr, flush=True)
    try:
        return subprocess.call(["bash", os.path.join("app", "build.sh")], cwd=str(HERE))
    except OSError as e:
        raise TexcError(f"can't run bash app/build.sh: {e.strerror or e}")


def _cmd_app(path=None):
    """`texc app [PATH]`: open texc.app (on PATH, made absolute), building it first if it's missing."""
    if sys.platform != "darwin":
        raise TexcError("texc.app is a Mac app; use texc gui instead")
    target = gui_target(path) if path else None
    app = _app_bundle()
    if not app.is_dir():
        rc = _build_app(f"{app} isn't installed yet; ")
        if rc != 0:
            raise TexcError(f"building texc.app failed (app/build.sh exited with {rc})")
        if not app.is_dir():
            raise TexcError(f"app/build.sh finished, but {app} isn't there")
    if os.environ.get("TEXC_SILENT") == "1":      # tests: never launch the app on the user's screen
        print("(silent: would run: open -a " + " ".join([str(app)] + ([target] if target else [])) + ")")
        return 0
    try:
        return subprocess.call(["open", "-a", str(app)] + ([target] if target else []))
    except OSError as e:
        raise TexcError(f"can't run open: {e.strerror or e}")


def _cmd_new(argv):
    ids = [t["id"] for t in list_templates()]
    ap = argparse.ArgumentParser(prog="texc new", description="Start a LaTeX project folder from a template.")
    ap.add_argument("folder", metavar="FOLDER", help="the folder to create (an existing one must be empty)")
    ap.add_argument("-t", "--template", default="article", metavar="|".join(ids) or "TEMPLATE",
                    help="the template (default: article)")
    ap.add_argument("--title", help="the document's title (default: the folder's name)")
    ap.add_argument("--author", help="the author (default: your account's full name)")
    ap.add_argument("--open", action="store_true", help="then open it: in texc.app if it's installed, "
                                                       "else in the browser GUI")
    a = ap.parse_args(argv)
    try:
        main_tex = new_project(a.folder, a.template, a.title, a.author)
    except FileExistsError:
        raise TexcError(f"{a.folder} already exists and isn't empty; pick a new folder name")
    except ValueError as e:
        raise TexcError(str(e))
    except OSError as e:
        raise TexcError(f"can't create {a.folder}: {e.strerror or e}")
    folder = main_tex.parent
    files = [f for f in _template(a.template)["files"] if (folder / f).is_file()]
    print(c("32", "✓ ") + ", ".join(_display(folder / f) for f in files) + f"  ({a.template})")
    if a.open:
        if sys.platform == "darwin" and _app_bundle().is_dir():
            return _cmd_app(str(folder))
        return run_gui(str(folder), None, True)
    import shlex
    print(c("2", f"  open it: texc gui {shlex.quote(_display(folder))}"))
    return 0


# ---------------------------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------------------------

def die(msg):
    print(c("31", "error: ") + msg, file=sys.stderr)
    sys.exit(2)


def _engine_arg(s):
    try:
        return _norm_engine(s)
    except ValueError:
        raise argparse.ArgumentTypeError(f"invalid choice: {s!r} (choose from pdf, xe, lua)")


def _raise_interrupt(signum, frame):
    raise KeyboardInterrupt


def _cmd_clean(arg):
    if arg:
        p = Path(arg).expanduser()
        base = p if p.is_dir() else find_main(arg).parent
    else:
        base = Path.cwd()
    base = base.resolve()
    target = base / BUILD_DIR
    try:
        removed = clean(base)
    except OSError as e:
        die(f"could not clean {_display(target)}: {e.strerror or e}")
    if not removed:
        print(f"nothing to clean in {_display(target)}")
        return 0
    kept = [d for d in KEEP_DIRS if (target / d).is_dir()]
    if not kept:
        try:
            target.rmdir()
        except OSError:
            pass
    what = f"{len(removed)} build file{'s' * (len(removed) != 1)}"
    print(f"removed {what} from {_display(target)}" + (f" (kept {', '.join(kept)})" if kept else ""))
    return 0


def _setup_process():
    try:
        sys.stdout.reconfigure(line_buffering=True)     # watch output reaches pipes and logs live
    except (AttributeError, ValueError):
        pass
    for sig in (signal.SIGTERM, signal.SIGHUP):          # clean up the build like on Ctrl-C
        try:
            signal.signal(sig, _raise_interrupt)
        except (ValueError, OSError):
            pass


def _subcommand(cmd, rest):
    """texc new / app / install-app (each with its own small parser)."""
    if cmd == "new":
        return _cmd_new(rest)
    if cmd == "app":
        ap = argparse.ArgumentParser(prog="texc app", description="Open the texc Mac app (builds "
                                     "~/Applications/texc.app first if it isn't installed).")
        ap.add_argument("path", nargs="?", metavar="PATH", help="a folder or .tex file to open in it")
        return _cmd_app(ap.parse_args(rest).path)
    ap = argparse.ArgumentParser(prog="texc install-app",
                                 description="Build texc.app and (re)install it as ~/Applications/texc.app.")
    ap.parse_args(rest)
    return _build_app()


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] in ("new", "app", "install-app"):
        _setup_process()
        try:
            return _subcommand(argv[0], argv[1:])
        except TexcError as e:
            die(str(e))
    if argv and argv[0] == "gui":            # `texc gui [file]` == `texc --gui [file]`
        argv[0] = "--gui"
    ap = argparse.ArgumentParser(
        prog="texc", description="Compile LaTeX to PDF (latexmk front-end).",
        epilog="more: texc gui [folder|file.tex] (the GUI), texc new FOLDER (a project from a template), "
               "texc app [PATH] (the Mac app), texc install-app. Each has -h.")
    ap.add_argument("file", nargs="?", help="main .tex file or its folder (optional if the folder has one main)")
    ap.add_argument("-w", "--watch", action="store_true", help="rebuild whenever a source file changes")
    ap.add_argument("-o", "--open", action="store_true", help="open the PDF after building")
    ap.add_argument("-e", "--engine", type=_engine_arg, metavar="{pdf,xe,lua}",
                    help="pdf, xe or lua (also pdflatex, xelatex, lualatex; default: auto)")
    ap.add_argument("-v", "--verbose", action="store_true", help="show all warnings")
    ap.add_argument("--clean", action="store_true", help="delete the build files in .texc/")
    ap.add_argument("--gui", action="store_true", help="open the texc GUI in the browser (a folder, a "
                    ".tex file, or nothing: this folder if it has a main .tex, else the Welcome screen)")
    ap.add_argument("--port", type=int, help="GUI port (default: the first free one from 8765)")
    ap.add_argument("--no-browser", action="store_true", help="GUI: don't open a browser window")
    ap.add_argument("--app", action="store_true", help="GUI, for texc.app: no browser, an ephemeral port, "
                    "a TEXC_READY/TEXC_ERROR line on stdout, stop when stdin closes")
    a = ap.parse_args(argv)
    _setup_process()
    try:
        if a.clean:
            return _cmd_clean(a.file)
        if a.app and not a.gui:
            die("--app is how texc.app runs `texc gui --app`; to open the app, run: texc app")
        if a.gui:
            if a.watch:
                die("--gui has its own watcher; drop -w")
            return run_gui(a.file, a.port, not a.no_browser, a.app)
        if not _which("latexmk", _tex_env()):
            die("latexmk not found; install TeX Live (https://tug.org/mactex/ or brew install texlive)")
        main_file = find_main(a.file)
    except TexcError as e:
        die(str(e))
    if a.watch:
        watch(main_file, a.engine, a.verbose, a.open)
        return 0
    result = run_build(main_file, a.engine)
    print_result(result, a.verbose)
    if result["ok"] and a.open:
        open_file(result.get("beside_pdf") or result.get("pdf"))
    return 0 if result["ok"] and not result.get("copy_error") else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print()
        sys.exit(130)
    except BrokenPipeError:                       # e.g. `texc -v | head`
        try:
            sys.stdout = open(os.devnull, "w")
        except OSError:
            pass
        sys.exit(1)
