#!/usr/bin/python3
"""Checks for the editor's "=" results (mathcalc.py, /api/calc, the ghost text). Silent: headless
Chrome, a scratch copy of the demo, a scratch config dir.
Run: /usr/bin/python3 app/test/calc_check.py   (needs SymPy for /usr/bin/python3)"""
import json, os, re, shutil, subprocess, sys, tempfile, time, urllib.request

TOOLS = os.path.dirname(os.path.abspath(__file__))
TEXC = os.path.dirname(os.path.dirname(TOOLS))
sys.path.insert(0, TEXC)
import mathcalc  # noqa: E402

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""), flush=True)


# 1. The math: (input, expected LaTeX, or None for "no suggestion"). The expected values are the
#    textbook answers, not SymPy's own output.
TABLE = [
    (r"2+2", "4"),
    (r"2^{10}", "1024"),
    (r"2^10", None),                                   # renders as 2¹0: refuse to guess
    (r"\frac{1}{3}+\frac{1}{6}", r"\frac{1}{2}"),
    (r"\frac{6}{4}", r"\frac{3}{2}"),
    (r"0.1+0.2", "0.3"),
    (r"15\% \cdot 80", "12"),
    (r"\sqrt{8}", r"2 \sqrt{2}"),
    (r"\sqrt[3]{27}", "3"),
    (r"\sin\frac{\pi}{6}", r"\frac{1}{2}"),
    (r"\sin 30^\circ", r"\frac{1}{2}"),
    (r"\cos \pi", "-1"),
    (r"e^{i\pi}", "-1"),
    (r"(1+i)(1-i)", "2"),
    (r"\ln e", "1"),
    (r"\log_2 8", "3"),
    (r"5!", "120"),
    (r"\binom{5}{2}", "10"),
    (r"\left| -3 \right|", "3"),
    (r"\lfloor 3.7 \rfloor", "3"),
    (r"\int_0^1 x^2\,dx", r"\frac{1}{3}"),
    (r"\int x^2 \, dx", r"\frac{x^{3}}{3} + C"),
    (r"\int_0^\pi \sin x \, dx", "2"),
    (r"\int_0^{2\pi} \sin^2\theta \, d\theta", r"\pi"),
    (r"\int_0^\infty e^{-x^2} dx", r"\frac{\sqrt{\pi}}{2}"),
    (r"\int_0^1 \int_0^2 xy \, dx \, dy", "1"),
    (r"\int_0^1 \frac{1}{1+x^2} \mathrm{d}x", r"\frac{\pi}{4}"),
    (r"\int_1^e \ln x \, dx", "1"),
    (r"\frac{d}{dx} x^3", r"3 x^{2}"),
    (r"\frac{d}{dx} \sin(x^2)", r"2 x \cos(x^{2})"),
    (r"\frac{d^2}{dx^2} x^4", r"12 x^{2}"),
    (r"\frac{\partial^2}{\partial x \partial y} x^2 y^3", r"6 x y^{2}"),
    (r"\frac{dy}{dx}", None),
    (r"\lim_{x \to 0} \frac{\sin x}{x}", "1"),
    (r"\lim_{n \to \infty} \left(1 + \frac{1}{n}\right)^n", "e"),
    (r"\lim_{x\to 0^+} \frac{1}{x}", r"\infty"),
    (r"\lim_{x\to 0} \frac{1}{x}", None),              # the two sides disagree
    (r"\sum_{k=1}^{n} k", r"\frac{n (n + 1)}{2}"),
    (r"\sum_{k=1}^{n} k^2", r"\frac{n (n + 1) (2 n + 1)}{6}"),
    (r"\sum_{k=1}^{\infty} \frac{1}{k^2}", r"\frac{\pi^{2}}{6}"),
    (r"\sum_{i=1}^{10} i", "55"),
    (r"\det\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}", "-2"),
    (r"\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}^{-1}", r"\begin{pmatrix}-2 & 1\\\frac{3}{2} & - \frac{1}{2}\end{pmatrix}"),
    (r"\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}\begin{bmatrix} 5 \\ 6 \end{bmatrix}", r"\begin{bmatrix}17\\39\end{bmatrix}"),
    (r"x + x", "2 x"),
    (r"(x+1)^2", r"x^{2} + 2 x + 1"),
    (r"x^2 + 2x + 1", r"(x + 1)^{2}"),
    (r"\frac{x^2-1}{x-1}", "x + 1"),
    (r"\sin^2 x + \cos^2 x", "1"),
    # plain names and already-simple forms: nothing to suggest
    (r"x", None), (r"2", None), (r"f(x)", None), (r"P(A)", None), (r"mc^2", None),
    (r"\frac{1}{2}mv^2", None), (r"x - 1", None), (r"c + b + a", None), (r"\sin x", None),
    (r"\text{speed}", None), (r"\begin{pmatrix} 1 & 2 \end{pmatrix}", None), (r"0.50", None),
    (r"\frac{1}{0}", None),
    (r"\pi", None), (r"e", None),                     # lone constants: probably a name being defined
    # names, not values: refuse rather than guess (f(x) is not f times x, x_i under \sum_i depends on i)
    (r"\int_0^1 f(x)\,dx", None), (r"\frac{d}{dx} f(x)", None), (r"f(2)+f(3)", None),
    (r"\int p(x)\log p(x)\,dx", None), (r"\phi(x)+\phi(x)", None), (r"g(x)h(x)", None),
    (r"\sigma(z)(1-\sigma(z))", None), (r"\int_0^1 x(t)\,dt", None),
    (r"\mathbb{E}[X^2] - \mathbb{E}[X]^2", None), (r"\sum_{i=1}^{n} x_i", None),
    (r"\frac{1}{n}\sum_{i=1}^n x_i", None), (r"\prod_{i=1}^n p_i", None), (r"\lim_{n\to\infty} a_n", None),
    (r"\frac{d}{dt} x_t", None), (r"\mathbf{x}^T\mathbf{x}", None), (r"x^T x", None), (r"e^x^2", None),
    # ...while brackets that multiply still work
    (r"\frac{d}{dx} x^2 + \frac{d}{dx} x^3", r"3 x^{2} + 2 x"),
    (r"x(x+1)", r"x^{2} + x"), (r"2\pi(r+h)", r"2 \pi h + 2 \pi r"), (r"\Gamma(5)", "24"),
]
APPROX = [  # (input, decimal shown, inserted with \approx?)
    (r"\sin 1", "0.8414709848", True),
    (r"2\pi", "6.283185307", True),
    (r"\int_0^1 x^x dx", "0.7834305107", True),
    (r"1.5^{2.5}", "2.755675961", True),
    (r"2^{1000000}", r"9.900656229 \times 10^{301029}", True),
]
ALTS = [  # (input, exact, decimal alternative)
    (r"\frac{1}{3}+\frac{1}{6}", r"\frac{1}{2}", "0.5"),
    (r"\int_0^1 e^{-x^2} dx", r"\frac{\sqrt{\pi} \operatorname{erf}(1)}{2}", "0.7468241328"),
]
mathcalc.load()
bad = []
t0 = time.time()
for src, want in TABLE:
    r = mathcalc.compute(src)
    got = r and r["latex"]
    if got != want or (r and r["approx"]):
        bad.append(f"{src} -> {got!r} (want {want!r})")
for src, want, approx in APPROX:
    r = mathcalc.compute(src)
    if not r or r["latex"] != want or r["approx"] is not approx:
        bad.append(f"{src} -> {r!r} (want ≈ {want})")
for src, exact, dec in ALTS:
    r = mathcalc.compute(src)
    if not r or r["latex"] != exact or not r["alt"] or r["alt"]["latex"] != dec:
        bad.append(f"{src} -> {r!r}")
r = mathcalc.compute(r"\int_0^\infty e^{-ax} dx")
if not r or r["latex"] != r"\frac{1}{a}" or r["note"] != "assuming a > 0":
    bad.append(f"e^(-ax) -> {r!r}")
check(f"math table ({len(TABLE) + len(APPROX) + len(ALTS) + 1} formulas)", not bad, "; ".join(bad))
check("the table runs fast", time.time() - t0 < 20, f"{time.time() - t0:.1f}s")
t1 = time.time()
try:
    r = mathcalc.compute(r"9^{9^{9^9}}")
except mathcalc.Timeout:
    r = None
check("a runaway power gives up in time", r is None and time.time() - t1 < 4.5, f"{time.time() - t1:.1f}s {r!r}")
check("nothing is eval'd: an injection attempt is just unreadable",
      mathcalc.compute(r"\operatorname{__import__}('os')") is None and mathcalc.compute("__import__('os').system('true')") is None)

# 1b. Probability, statistics and ML. Expected values are table values and closed forms
#     (Φ(1.96) = 0.9750021049, t_{0.025,10} = 2.228138852, P(X−Y > 0) = Φ(2/3), Bin(10000, ½) summed
#     exactly), not this module's output. Declarations are what the editor sends: the text either
#     side of each \sim before the "=", oldest first.
def N(name, dist):
    return {"name": name, "dist": dist}


STATS = [  # (input, declarations, shown, approx?, ⌥Tab alternative)
    (r"P(Z \le 1.96)", [], "0.9750021049", True, "0.9750"),
    (r"P(|Z| > 1.96)", [], "0.0499957903", True, "0.0500"),
    (r"\Phi^{-1}(0.975)", [], "1.959963985", True, "1.960"),
    (r"z_{0.025}", [], "1.959963985", True, "1.960"),
    (r"t_{0.025,10}", [], "2.228138852", True, "2.228"),
    (r"\chi^2_{0.05,3}", [], "7.814727903", True, "7.815"),
    (r"F_{0.05,2,10}", [], "4.102821015", True, "4.103"),
    (r"P(X > 130)", [N("Let X", r"N(100, 15^2)")], "0.02275013195", True, "0.0228"),
    (r"P(X = 3)", [N("X", r"\text{Bin}(10, 0.3)")], "0.266827932", False, "0.2668"),
    (r"P(X \le 3)", [N("X", r"B(10, 0.3)")], "0.6496107184", False, "0.6496"),
    (r"P(X < 2.5)", [N("X", r"\text{Bin}(10, 0.3)")], "0.3827827864", False, "0.3828"),
    (r"P(X > 2)", [N("X", r"\text{Pois}(3)")], "0.5768099189", True, "0.5768"),
    (r"P(X > 1 \mid X > 0.5)", [N("X", r"\text{Exp}(2)")], "0.3678794412", True, "0.3679"),
    (r"P(T > 2.3)", [N("T", "t_{10}")], "0.02212715664", True, "0.0221"),
    (r"P(C > 7.815)", [N("C", r"\chi^2_3")], "0.04999390297", True, "0.0500"),
    (r"P(W > 4.1)", [N("W", "F_{2,10}")], "0.05007754848", True, "0.0501"),
    (r"P(X - Y > 0)", [N("X", "N(10, 4)"), N("Y", "N(8, 5)")], "0.7475074625", True, "0.7475"),
    (r"P(X \le 5000)", [N("X", r"\text{Bin}(10000, 0.5)")], "0.5039893231", True, "0.5040"),
    (r"P(X > 1)", [N("X", "N(0,1)"), N("X", r"\text{Pois}(3)")], "0.8008517265", True, "0.8009"),  # nearest wins
    (r"\mathbb{E}[X^2]", [N("X", r"N(100, 15^2)")], "10225", False, None),
    (r"\operatorname{Var}(2X+3)", [N("X", r"\text{Bin}(10, 0.3)")], "8.4", False, None),
    (r"\operatorname{Var}(3X+1)", [N("X", r"N(\mu, \sigma^2)")], r"9 \sigma^{2}", False, None),
    (r"Var(X)", [N("X", r"\text{Bin}(n, p)")], "n p (1 - p)", False, None),
    (r"\operatorname{Var}(T)", [N("T", "t_{10}")], "1.25", False, None),
    (r"\operatorname{mean}(2, 4, 4, 4, 5, 5, 7, 9)", [], "5", False, None),
    (r"\operatorname{sd}(2, 4, 4, 4, 5, 5, 7, 9)", [], "2.138089935", True, "2.138"),
    (r"\operatorname{sigmoid}(1)", [], "0.7310585786", True, "0.7311"),
    (r"\operatorname{ReLU}(-2)", [], "0", False, None),
    (r"\operatorname{softmax}(1, 2, 3)", [], "(0.09003057317, 0.2447284711, 0.6652409558)", True, None),
    (r"\|(3, 4)\|", [], "5", False, None),
    (r"(1, 2) \cdot (3, 4)", [], "11", False, None),
    (r"(1,0,0) \times (0,1,0)", [], "(0, 0, 1)", False, None),
    (r"52 \pm 1.96 \cdot \frac{8}{\sqrt{64}}", [], "(50.04, 53.96)", False, None),
    (r"P(X > 1)", [N("X", "N(0,1)"), N("X, Y", r"\text{Pois}(3)")], "0.8008517265", True, "0.8009"),  # X, Y \sim …
    (r"P(X = 300)", [N("X", r"\text{Bin}(2000, 0.123456)")], r"5.332752661 \times 10^{-5}", True, r"5.333 \times 10^{-5}"),
    (r"\int_0^1 \operatorname{sigmoid}(x)\,dx", [], "0.620114507", True, "0.6201"),
    (r"\int \operatorname{sigmoid}(x)\,dx", [], r"x + \ln(1 + e^{- x}) + C", False, None),
]
STATS_NONE = [  # still nothing: undeclared variables, events without relations, unknown functions
    (r"P(A)", []), (r"P(X > 1)", []), (r"E[X]", []), (r"\sigma(0)", []), (r"x(1, 2)", []),
    (r"P(2|Z| > 1)", []), (r"z_{\alpha/2}", []), (r"\|A\|", []), (r"E[e^X]", [N("X", "N(0,1)")]),
    (r"P(X > 1)", [N("% X", "N(0,1)")]), (r"P(X > 1)", [N("__import__('os')", "N(0,1)")]),
    (r"P(X > 1)", [N("X", "__import__('os')")]), (r"P(X > 1)", ["junk", {"name": 1, "dist": None}]),
    # a redeclaration texc can't read blocks the old one (and the Z default); undeclared capitals block too
    (r"P(X > 1)", [N("X", "N(0,1)"), N("X", r"\text{Gamma}(2,3)")]), (r"P(Z > 1)", [N("Z", r"\text{Gamma}(2,3)")]),
    (r"P(Z > 1)", [N("Z", r"\mathcal{N}(0, I)")]), (r"\operatorname{Var}(X + Y)", [N("X", "N(0,1)")]),
    (r"P(X > Y)", [N("X", "N(0,1)")]),
]
bad = []
t0 = time.time()
for src, decls, want, approx, alt in STATS:
    r = mathcalc.compute(src, decls=decls)
    if not r or r["latex"] != want or r["approx"] is not approx or (r["alt"] or {}).get("latex") != alt:
        bad.append(f"{src} -> {r!r}")
for src, decls in STATS_NONE:
    r = mathcalc.compute(src, decls=decls)
    if r is not None:
        bad.append(f"{src} -> {r!r} (want nothing)")
check(f"statistics and ML ({len(STATS) + len(STATS_NONE)} formulas)", not bad, "; ".join(bad))
check("the statistics table runs fast", time.time() - t0 < 20, f"{time.time() - t0:.1f}s")
r = mathcalc.compute(r"P(X > 130)", decls=[N("X", "N(100, 15)")])
check("N(100, 15) is read as variance 15, and the note says so",
      r and r["note"] == r"$X$ normal, mean $100$, sd $\sqrt{15}$", json.dumps(r))

# 2. Worker protocol (the process server.py runs)
w = subprocess.Popen(["/usr/bin/python3", os.path.join(TEXC, "mathcalc.py"), "--worker"], stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, text=True)
hello = json.loads(w.stdout.readline())
w.stdin.write(json.dumps({"id": 7, "latex": r"\int_0^1 x\,dx"}) + "\n")
w.stdin.flush()
reply = json.loads(w.stdout.readline())
w.stdin.close()
w.wait(5)
check("worker: hello, answer, exit on EOF", hello.get("ready") and reply.get("id") == 7
      and (reply.get("result") or {}).get("latex") == r"\frac{1}{2}" and w.returncode == 0, json.dumps([hello, reply]))
w = subprocess.run(["/usr/bin/python3", os.path.join(TEXC, "mathcalc.py"), "--worker"], capture_output=True, text=True, timeout=60,
                   input=json.dumps({"id": 8, "latex": "P(X > 130)", "decls": [N("X", r"N(100, 15^2)")]}) + "\n")
reply = json.loads(w.stdout.splitlines()[1]) if len(w.stdout.splitlines()) > 1 else {}
check("worker: declarations come with the request", (reply.get("result") or {}).get("latex") == "0.02275013195", w.stdout[-300:])
w = subprocess.run(["/usr/bin/python3", os.path.join(TEXC, "mathcalc.py"), "--worker"], input="", capture_output=True,
                   text=True, env=dict(os.environ, PYTHONNOUSERSITE="1"), timeout=30)
hello = json.loads(w.stdout.splitlines()[0]) if w.stdout.strip() else {}
check("worker without SymPy says so", hello.get("ready") is False and "SymPy" in hello.get("error", ""), w.stdout[:200])

# 3. The server and the editor, in headless Chrome
BASE = os.environ.get("TEXC_TEST_DIR") or tempfile.mkdtemp(prefix="texc-calc-")
CONF, PROJ = os.path.join(BASE, "config"), os.path.join(BASE, "demo")
shutil.rmtree(PROJ, ignore_errors=True)
os.makedirs(CONF, exist_ok=True)
subprocess.run(["rsync", "-a", "--exclude", ".texc", "--exclude", "*.pdf", "--exclude", "*.synctex.gz",
                os.path.join(TEXC, "examples/demo") + "/", PROJ + "/"], check=True)


def serve(port, extra_env=None):
    env = dict(os.environ, TEXC_SILENT="1", TEXC_CONFIG_DIR=CONF, **(extra_env or {}))
    env.pop("TEXC_MATH_PYTHON", None)
    p = subprocess.Popen(["/usr/bin/python3", os.path.join(TEXC, "texc.py"), "gui", PROJ, "--no-browser", "--port", str(port)],
                         env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            html = urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1).read().decode()
            return p, re.search(r'name="texc-token" content="([^"]+)"', html).group(1)
        except Exception:  # noqa: BLE001
            time.sleep(0.25)
    raise SystemExit("server did not start")


def api(port, token, method, path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"X-Texc-Token": token, "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


def stop(p):
    p.terminate()
    try:
        p.wait(8)
    except subprocess.TimeoutExpired:
        p.kill()


srv, tok = serve(18873)
try:
    st = api(18873, tok, "GET", "/api/calc")
    check("GET /api/calc: SymPy available", st.get("available") is True and st.get("sympy"), json.dumps(st))
    r = api(18873, tok, "POST", "/api/calc", {"latex": r"\sum_{k=1}^{100} k"})
    check("POST /api/calc computes", r.get("ok") and (r.get("result") or {}).get("latex") == "5050", json.dumps(r))
    r = api(18873, tok, "POST", "/api/calc", {"latex": "y"})
    check("POST /api/calc: nothing for a bare name", r.get("ok") and r.get("result") is None, json.dumps(r))
    r = api(18873, tok, "POST", "/api/calc", {"latex": "P(X > 130)", "decls": [N("X", r"N(100, 15^2)"), "junk", {"name": 1}]})
    check("POST /api/calc with declarations", r.get("ok") and (r.get("result") or {}).get("latex") == "0.02275013195", json.dumps(r))
    r = api(18873, tok, "POST", "/api/calc", {"latex": "P(X > 130)", "decls": "not a list"})
    check("POST /api/calc ignores malformed declarations", r.get("ok") and r.get("result") is None, json.dumps(r))

    # Typed for real: key events into the editor, then Tab / ⌥Tab / Escape.
    SETUP = r"""await T.app.ready; await T.app.openFile('main.tex');
const cm = T.editor.cm; const doc = cm.getDoc();
const end = doc.getValue().indexOf('\\end{document}');
window.__line = (s) => { const p = doc.posFromIndex(doc.getValue().indexOf('\\end{document}'));
  doc.replaceRange('\n' + s + '\n', p); const at = doc.posFromIndex(doc.getValue().indexOf('\\end{document}') - 1);
  doc.setCursor(at); cm.focus(); return at.line; };
window.__get = (l) => doc.getLine(l);
window.__state = () => ({ s: T.editor.calcSuggestion(), ghost: !!document.querySelector('.texc-calc-ghost'),
  card: !!document.querySelector('.texc-calc-card'), focus: cm.hasFocus(),
  note: (document.querySelector('.texc-calc-note') || {}).innerText || null,
  noteMath: !!document.querySelector('.texc-calc-note .katex') });
return end > 0;"""
    steps = ["--eval", SETUP,
             # a: definite integral, Tab inserts the exact value
             "--eval", r"window.__a = __line('$\\int_0^1 x^2\\,dx $'); T.editor.cm.setCursor({line: __a, ch: T.editor.cm.getLine(__a).length - 1}); return __a;",
             "--type", "=", "--sleep", "1800",
             "--eval", "return __state();",
             "--shot", os.path.join(BASE, "calc-ghost.png"),
             "--key", "Tab", "--sleep", "200",
             "--eval", "return {line: __get(__a), st: __state()};",
             "--eval", "T.editor.cm.undo(); return __get(__a);",
             # b: Escape dismisses and leaves the text alone
             "--eval", r"window.__b = __line('\\[ 2+2 \\]'); T.editor.cm.setCursor({line: __b, ch: 7}); return __b;",
             "--type", "=", "--sleep", "1200",
             "--eval", "return __state();",
             "--key", "Escape", "--sleep", "150",
             "--eval", "return {line: __get(__b), st: __state()};",
             # c: a rounded decimal turns = into \approx
             "--eval", r"window.__c = __line('$\\sqrt{2} $'); T.editor.cm.setCursor({line: __c, ch: 10}); return __c;",
             "--type", "=", "--sleep", "1200", "--key", "Tab", "--sleep", "200",
             "--eval", "return __get(__c);",
             # d: ⌥Tab takes the decimal alternative
             "--eval", r"window.__d = __line('\\begin{equation}\n\\frac{1}{3}+\\frac{1}{6} \n\\end{equation}') - 1; T.editor.cm.setCursor({line: __d, ch: T.editor.cm.getLine(__d).length}); return __d;",
             "--type", "=", "--sleep", "1200", "--key", "Alt+Tab", "--sleep", "200",
             "--eval", "return __get(__d);",
             # e: not in math, and a bare name: nothing
             "--eval", r"window.__e = __line('2+2 '); T.editor.cm.setCursor({line: __e, ch: 4}); return __e;",
             "--type", "=", "--sleep", "1000",
             "--eval", "return __state();",
             "--eval", r"window.__f = __line('$y $'); T.editor.cm.setCursor({line: __f, ch: 3}); return __f;",
             "--type", "=", "--sleep", "1000",
             "--eval", "return __state();",
             # g: typing on continues normally (the ghost goes, the typed text stays)
             "--eval", r"window.__g = __line('$3 \\cdot 4 $'); T.editor.cm.setCursor({line: __g, ch: 11}); return __g;",
             "--type", "=", "--sleep", "1200", "--type", " 1",
             "--eval", "return {line: __get(__g), st: __state(), errors: window.__texcErrors || []};",
             # h: align, "&=" uses the part before the &
             "--eval", r"window.__h = __line('\\begin{align}\n\\int_0^1 2x\\,dx &\n\\end{align}') - 1; T.editor.cm.setCursor({line: __h, ch: T.editor.cm.getLine(__h).length}); return __h;",
             "--type", "=", "--sleep", "1200",
             "--eval", "const st = __state(); T.editor.cm.execCommand('undo'); return st;",
             # j: P(X > 130) reads "X \sim N(100, 15^2)" written before it; ⌥Tab takes the 4-place value
             "--eval", r"window.__j = __line('Let $X \\sim N(100, 15^2)$ and $P(X > 130) $.'); T.editor.cm.setCursor({line: __j, ch: T.editor.cm.getLine(__j).lastIndexOf('$')}); return __j;",
             "--type", "=", "--sleep", "1500",
             "--eval", "return __state();",
             "--shot", os.path.join(BASE, "calc-stats.png"),
             "--key", "Alt+Tab", "--sleep", "200",
             "--eval", "return __get(__j);",
             # k: \Pr[…] in display math: the [ ] bracket keeps the event whole
             "--eval", r"window.__k = __line('\\[ \\Pr[Z > 1.96] \\]'); T.editor.cm.setCursor({line: __k, ch: T.editor.cm.getLine(__k).length - 2}); return __k;",
             "--type", "=", "--sleep", "1200",
             "--eval", "return __state();",
             "--key", "Escape", "--sleep", "150",
             # l: a \pm b is an interval
             "--eval", r"window.__l = __line('$52 \\pm 1.96 \\cdot 1 $'); T.editor.cm.setCursor({line: __l, ch: T.editor.cm.getLine(__l).length - 1}); return __l;",
             "--type", "=", "--sleep", "1200",
             "--eval", "return __state();",
             "--key", "Escape", "--sleep", "150",
             # m: a commented-out declaration doesn't count
             "--eval", r"window.__m = __line('% $Y \\sim N(0,1)$\n$P(Y > 0) $'); T.editor.cm.setCursor({line: __m, ch: T.editor.cm.getLine(__m).length - 1}); return __m;",
             "--type", "=", "--sleep", "1200",
             "--eval", "return __state();",
             # n: a distribution named with \text{…}
             "--eval", r"window.__n = __line('$B \\sim \\text{Bin}(10, 0.3)$, so $P(B = 3) $.'); T.editor.cm.setCursor({line: __n, ch: T.editor.cm.getLine(__n).lastIndexOf('$')}); return __n;",
             "--type", "=", "--sleep", "1200",
             "--eval", "return __state();",
             "--key", "Escape", "--sleep", "150",
             # i: Settings has the switch, and turning it off stops the suggestions
             "--eval", r"""T.app.openSettings(); await new Promise(r => setTimeout(r, 800));
const sw = document.querySelector('#set-calc'); const hint = sw && sw.closest('.app-set-row').innerText;
const save = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save');
sw.checked = false; save.click(); await new Promise(r => setTimeout(r, 800));
window.__i = __line('$2+3 $'); T.editor.cm.setCursor({line: __i, ch: 5});
return {exists: !!sw, hint, setting: T.state.settings.mathResults};""",
             "--type", "=", "--sleep", "1000",
             "--eval", r"""const st = __state(); await T.api.put('/api/settings', {mathResults: null}); return st;""",
             ]
    out = subprocess.run(["node", os.path.join(TOOLS, "cdp.mjs"), f"http://127.0.0.1:18873/", "--wait", "3000", *steps],
                         capture_output=True, text=True, timeout=180).stdout
    o = json.loads(out)
    ev = [e.get("value", e) for e in o["evals"]]
    ok_setup = ev[0] is True
    check("editor opens main.tex", ok_setup, json.dumps(ev[:1]))
    st = ev[2]
    check("typing = after an integral shows the ghost and preview",
          isinstance(st, dict) and st.get("ghost") and st.get("card") and (st.get("s") or {}).get("latex") == r"\frac{1}{3}", json.dumps(st))
    r = ev[3]
    check("Tab inserts the result", isinstance(r, dict) and r.get("line") == r"$\int_0^1 x^2\,dx = \frac{1}{3}$"
          and not r["st"]["ghost"] and not r["st"]["card"], json.dumps(r))
    check("one undo takes the insertion back", ev[4] == r"$\int_0^1 x^2\,dx =$", json.dumps(ev[4]))
    check("display math \\[…\\] works", (ev[6].get("s") or {}).get("latex") == "4", json.dumps(ev[6]))
    check("Escape dismisses without changing the text", ev[7]["line"] == r"\[ 2+2 =\]" and not ev[7]["st"]["ghost"], json.dumps(ev[7]))
    check("a rounded decimal is inserted with \\approx", ev[9] == r"$\sqrt{2} \approx 1.414213562$", json.dumps(ev[9]))
    check("⌥Tab inserts the decimal alternative (equation env)", ev[11] == r"\frac{1}{3}+\frac{1}{6} = 0.5", json.dumps(ev[11]))
    check("no suggestion outside math", not ev[13]["ghost"] and not ev[13]["s"], json.dumps(ev[13]))
    check("no suggestion for a bare name", not ev[15]["ghost"] and not ev[15]["s"], json.dumps(ev[15]))
    g = ev[17]
    check("typing on dismisses it and keeps what was typed", g["line"] == r"$3 \cdot 4 = 1$" and not g["st"]["ghost"]
          and not g["errors"], json.dumps(g))
    check("align: &= takes the left-hand side before the &", (ev[19].get("s") or {}).get("latex") == "1", json.dumps(ev[19]))
    j = ev[21]
    check("P(X > 130) uses the declaration X ~ N(100, 15^2) before it, and the note shows it",
          (j.get("s") or {}).get("latex") == "0.02275013195" and "normal, mean" in (j.get("note") or "") and j.get("noteMath"), json.dumps(j))
    check("⌥Tab inserts the 4-place value with \\approx", ev[22] == r"Let $X \sim N(100, 15^2)$ and $P(X > 130) \approx 0.0228$.", json.dumps(ev[22]))
    check("\\Pr[…] in display math", (ev[24].get("s") or {}).get("latex") == "0.02499789515", json.dumps(ev[24]))
    check("a \\pm b gives the interval", (ev[26].get("s") or {}).get("latex") == "(50.04, 53.96)", json.dumps(ev[26]))
    check("a commented-out declaration doesn't count", not ev[28]["s"] and not ev[28]["ghost"], json.dumps(ev[28]))
    check("a \\text{Bin}(10, 0.3) declaration", (ev[30].get("s") or {}).get("latex") == "0.266827932", json.dumps(ev[30]))
    i = ev[31]
    check("Settings has the 'Results after =' switch", isinstance(i, dict) and i.get("exists") and "Results after =" in (i.get("hint") or "")
          and i.get("setting") is False, json.dumps(i))
    check("switched off: no suggestion", not ev[32]["ghost"] and not ev[32]["s"], json.dumps(ev[32]))
    check("no page errors", not o["exceptions"] and not [c for c in o["console"] if c.startswith("error")],
          json.dumps(o["exceptions"] + o["console"])[:300])
finally:
    stop(srv)

# 4. Without SymPy the feature is off and quiet
srv, tok = serve(18874, {"PYTHONNOUSERSITE": "1"})
try:
    st = api(18874, tok, "GET", "/api/calc")
    r = api(18874, tok, "POST", "/api/calc", {"latex": "2+2"})
    check("without SymPy: unavailable, with an install hint", st.get("available") is False and "pip install" in st.get("install", "")
          and r.get("ok") is False and r.get("available") is False, json.dumps([st, r])[:300])
finally:
    stop(srv)
time.sleep(1)
ps = subprocess.run(["ps", "-axo", "pid=,ppid=,command="], capture_output=True, text=True).stdout.splitlines()
left = "\n".join(l for l in ps if "mathcalc.py --worker" in l and l.split()[1] == "1")   # orphaned workers
check("no math worker is left running", not left, left)

nbad = [n for n, ok, _ in results if not ok]
print(f"\n{len(results) - len(nbad)}/{len(results)} passed" + (f"; failed: {nbad}" if nbad else ""))
sys.exit(1 if nbad else 0)
