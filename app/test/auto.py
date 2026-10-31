#!/usr/bin/python3
"""texc.app automation client (docs/ARCHITECTURE.md), silent by design.

  auto.py launch AUTODIR CONFIGDIR      start the app off-screen (no Dock icon, no focus), Finder-like env
  auto.py cmd AUTODIR '{"cmd":"windows"}' [timeout]   run one command, print the JSON result
  auto.py quit AUTODIR                  quit the app (then SIGKILL after 10 s if it's still there)

Always launch through this script (or the same env -i … binary line), never `open -a texc`:
LaunchServices activates the app and puts it over the user's work."""
import json, os, subprocess, sys, time, itertools

APP = os.path.expanduser("~/Applications/texc.app/Contents/MacOS/texc")

def launch(autodir, configdir):
    os.makedirs(autodir, exist_ok=True); os.makedirs(configdir, exist_ok=True)
    env = {"HOME": os.environ["HOME"], "USER": os.environ.get("USER", ""), "LOGNAME": os.environ.get("USER", ""),
           "TMPDIR": os.environ.get("TMPDIR", "/tmp/"), "SHELL": "/bin/zsh",
           "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}          # what Finder/launchd gives an app
    log = open(os.path.join(autodir, "app.log"), "ab")
    p = subprocess.Popen([APP, "--automation", autodir, "--config-dir", configdir], env=env,
                         stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    open(os.path.join(autodir, "app.pid"), "w").write(str(p.pid))
    print(json.dumps({"ok": True, "pid": p.pid}))

_seq = itertools.count()

def cmd(autodir, payload, timeout=60):
    name = f"{int(time.time()*1000):013d}-{os.getpid()}-{next(_seq)}"
    tmp = os.path.join(autodir, name + ".tmp")
    with open(tmp, "w") as f:
        f.write(payload if isinstance(payload, str) else json.dumps(payload))
    os.rename(tmp, os.path.join(autodir, name + ".cmd.json"))
    res = os.path.join(autodir, name + ".res.json")
    end = time.time() + timeout
    while time.time() < end:
        if os.path.exists(res):
            data = open(res).read()
            os.remove(res)
            return json.loads(data)
        time.sleep(0.05)
    return {"ok": False, "error": f"no result within {timeout}s"}

def quit_app(autodir):
    pidf = os.path.join(autodir, "app.pid")
    pid = int(open(pidf).read()) if os.path.exists(pidf) else None
    r = cmd(autodir, {"cmd": "quit"}, timeout=15)
    for _ in range(100):
        if pid is None or subprocess.call(["kill", "-0", str(pid)], stderr=subprocess.DEVNULL) != 0:
            break
        time.sleep(0.1)
    else:
        subprocess.call(["kill", "-9", str(pid)])
        r = {"ok": False, "error": "had to SIGKILL the app", "quit_result": r}
    print(json.dumps(r))

if __name__ == "__main__":
    a = sys.argv[1:]
    if a[0] == "launch": launch(a[1], a[2])
    elif a[0] == "cmd": print(json.dumps(cmd(a[1], a[2], float(a[3]) if len(a) > 3 else 60), indent=1))
    elif a[0] == "quit": quit_app(a[1])
