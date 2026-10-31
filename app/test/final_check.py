#!/usr/bin/python3
"""Final acceptance check for texc.app. Silent: off-screen app, headless Chrome, scratch config.
Run: /usr/bin/python3 app/test/final_check.py   (writes into $TEXC_TEST_DIR or a new temp dir)"""
import json, os, shutil, subprocess, sys, tempfile, time

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
import auto  # noqa: E402

HOME = os.path.expanduser("~")
TEXC = os.path.join(HOME, ".local/share/texc")
BASE = os.environ.get("TEXC_TEST_DIR") or tempfile.mkdtemp(prefix="texc-final-")
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def ev(win, js, timeout=60):
    r = auto.cmd(AUTO, {"cmd": "eval", "window": win, "js": js, "timeout": timeout}, timeout + 10)
    return r.get("result") if r.get("ok") else {"__error": r.get("error")}


shutil.rmtree(BASE, ignore_errors=True)
AUTO, CONF, F = (os.path.join(BASE, d) for d in ("auto", "config", "folders"))
for d in (AUTO, CONF, F):
    os.makedirs(d)
subprocess.run(["rsync", "-a", "--exclude", ".texc", "--exclude", "*.pdf", "--exclude", "*.synctex.gz",
                os.path.join(TEXC, "examples/demo") + "/", os.path.join(F, "demo") + "/"], check=True)
os.makedirs(os.path.join(F, "empty"))

# 1. Python 3.9 still imports both modules
r = subprocess.run(["/usr/bin/python3", "-m", "py_compile", os.path.join(TEXC, "server.py"), os.path.join(TEXC, "texc.py")],
                   capture_output=True, text=True)
check("py_compile under /usr/bin/python3 (3.9)", r.returncode == 0, r.stderr.strip()[:200])

# 2. Silent app: Welcome → Open Folder → compile/PDF → Close Folder → no-main folder
auto.launch(AUTO, CONF)
pid = int(open(os.path.join(AUTO, "app.pid")).read())
time.sleep(3)
w = auto.cmd(AUTO, {"cmd": "windows"}, 20)
wins = w.get("windows") or []
check("app starts with a Welcome window", wins and wins[0].get("mode") == "lobby", json.dumps(wins)[:200])
vis = json.loads(subprocess.run([os.path.join(TOOLS, "winprobe"), str(pid)], capture_output=True, text=True).stdout)
check("nothing visible on screen", vis.get("anyVisible") is False)
win = wins[0]["id"] if wins else 1
r = auto.cmd(AUTO, {"cmd": "open", "path": os.path.join(F, "demo")}, 60)
check("open demo folder", r.get("ok"), r.get("error", ""))
res = ev(win, """await T.app.ready; const t0 = Date.now();
while (!document.querySelector('#pdf-pages canvas') && Date.now() - t0 < 40000) await new Promise(r => setTimeout(r, 250));
return {canvases: document.querySelectorAll('#pdf-pages canvas').length, errors: window.__texcErrors || [], title: document.title};""", 60)
check("project boots and the PDF renders", isinstance(res, dict) and res.get("canvases", 0) > 0 and not res.get("errors"), json.dumps(res)[:300])
res = ev(win, """const p = await T.api.get('/api/project'); return {main: p.main, main_exists: p.main_exists, app: p.app, has_ui_state: typeof p.ui_state === 'object'};""")
check("/api/project has the new fields", isinstance(res, dict) and res.get("main_exists") is True and res.get("app") is True and res.get("has_ui_state"), json.dumps(res))
r = auto.cmd(AUTO, {"cmd": "open", "path": os.path.join(F, "empty"), "newWindow": True}, 60)
w2 = r.get("window")
res = ev(w2, """await T.app.ready; await new Promise(r => setTimeout(r, 1500));
const p = await T.api.get('/api/project');
return {main_exists: p.main_exists, dot: (document.querySelector('#btn-status') || {}).className || '', text: document.body.innerText.includes('no main .tex file'), errors: window.__texcErrors || []};""", 40) if w2 else None
check("empty folder shows the no-main state", isinstance(res, dict) and res.get("main_exists") is False and res.get("text") and not res.get("errors"), json.dumps(res)[:300])
r = auto.cmd(AUTO, {"cmd": "close", "window": w2}, 30) if w2 else {"ok": False}
check("close the second window", r.get("ok"), r.get("error", ""))

# Welcome background + New Project modal stacking (regression: the background shade once reused the
# modal backdrop's class and drew the page over the dialog).
PNG1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
r = auto.cmd(AUTO, {"cmd": "lobby"}, 60)
w3 = r.get("window")
res = ev(w3, """await new Promise(r => setTimeout(r, 600));
await T.api.post('/api/lobby/background', {data: '%s'}); location.reload(); return true;""" % PNG1, 20) if w3 else None
time.sleep(2)
res = ev(w3, """const t0 = Date.now();
while (!document.body.classList.contains('has-bg') && Date.now() - t0 < 6000) await new Promise(r => setTimeout(r, 200));
await T.host._native('newProject'); await new Promise(r => setTimeout(r, 600));
const card = document.querySelector('.wl-modal'); const b = card.getBoundingClientRect();
const top = document.elementFromPoint(b.left + b.width / 2, b.top + 40);
const vw = document.documentElement.clientWidth;   // a classic scrollbar takes width from innerWidth
const out = {hasBg: document.body.classList.contains('has-bg'), centered: Math.abs((b.left + b.width / 2) - vw / 2) < 2,
  onTop: !!(top && top.closest('.wl-modal')), noScroll: document.documentElement.scrollHeight <= innerHeight + 1,
  errors: window.__texcErrors || []};
await T.api.post('/api/lobby/background', {clear: true}); return out;""", 30) if w3 else None
check("New Project modal sits on top of a background image", isinstance(res, dict) and res.get("hasBg") and res.get("centered") and res.get("onTop") and not res.get("errors"), json.dumps(res))
check("Welcome with a background doesn't scroll", isinstance(res, dict) and res.get("noScroll"), json.dumps(res))
if w3:
    auto.cmd(AUTO, {"cmd": "close", "window": w3}, 30)
vis = json.loads(subprocess.run([os.path.join(TOOLS, "winprobe"), str(pid)], capture_output=True, text=True).stdout)
check("still nothing visible on screen", vis.get("anyVisible") is False)
auto.quit_app(AUTO)
time.sleep(1.5)
left = subprocess.run(["pgrep", "-fl", "texc.py gui|MacOS/texc"], capture_output=True, text=True).stdout.strip()
left = "\n".join(l for l in left.splitlines() if BASE in l or "MacOS/texc --automation " + AUTO in l)
check("quit leaves no app or servers", not left, left[:200])

# 3. Browser mode in headless Chrome
env = dict(os.environ, TEXC_SILENT="1", TEXC_CONFIG_DIR=CONF)
srv = subprocess.Popen(["/usr/bin/python3", os.path.join(TEXC, "texc.py"), "gui", os.path.join(F, "demo"), "--no-browser", "--port", "18871"],
                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2.5)
out = subprocess.run(["node", os.path.join(TOOLS, "cdp.mjs"), "http://127.0.0.1:18871/", "--wait", "6000", "--eval",
                      "await T.app.ready; return {canvases: document.querySelectorAll('#pdf-pages canvas').length, title: document.title}"],
                     capture_output=True, text=True, timeout=90).stdout
srv.terminate()
try:
    srv.wait(5)
except subprocess.TimeoutExpired:
    srv.kill()
try:
    o = json.loads(out)
    v = o["evals"][0].get("value") or {}
    check("browser mode boots with the PDF (headless Chrome)", v.get("canvases", 0) > 0 and not o["exceptions"], json.dumps(v))
except Exception as e:  # noqa: BLE001
    check("browser mode boots with the PDF (headless Chrome)", False, f"{e}: {out[:200]}")

# 4. CLI: texc new + compile
proj = os.path.join(F, "cli-paper")
r = subprocess.run(["/usr/bin/python3", os.path.join(TEXC, "texc.py"), "new", proj, "-t", "article", "--title", "CLI Paper"],
                   env=env, capture_output=True, text=True)
check("texc new", r.returncode == 0 and os.path.isfile(os.path.join(proj, "main.tex")), (r.stdout + r.stderr).strip()[:200])
r = subprocess.run(["/usr/bin/python3", os.path.join(TEXC, "texc.py"), os.path.join(proj, "main.tex")], env=env, capture_output=True, text=True)
check("article template compiles", r.returncode == 0 and os.path.isfile(os.path.join(proj, "main.pdf")), (r.stdout + r.stderr).strip()[-200:])

bad = [n for n, ok, _ in results if not ok]
print(f"\n{len(results) - len(bad)}/{len(results)} passed" + (f"; failed: {bad}" if bad else ""))
sys.exit(1 if bad else 0)
