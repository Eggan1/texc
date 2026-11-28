#!/usr/bin/env python3
"""texc math results: the value of a LaTeX formula, for the editor's "=" suggestions.

Type `\\int_0^1 x^2\\,dx =` in the editor and texc offers `\\frac{1}{3}` as ghost text. This module
does the math. `compute(latex)` parses the left-hand side with a small recursive-descent LaTeX
parser that builds SymPy objects directly, so document text never goes through sympify/eval.
It returns the result as LaTeX, or None when there is nothing worth showing (plain names like
`f(x)` or `y`, text, or anything it can't read).

`python3 mathcalc.py --worker` is the long-lived JSON-lines process the GUI server talks to:
one {"id", "latex", "decls"?, "chain"?} object per line in, one {"id", "ok", "result"} line out.
"decls" are the document's distribution declarations before the cursor ({"name": "X", "dist":
"N(0, 1)"}, from `X \\sim N(0, 1)`), so `P(X \\le 1.96)` and `\\operatorname{Var}(2X)` have values.
"chain" holds the earlier sides of a chain of equalities, `A = B = C =` sends C with ["A", "B"]:
the result is still C's value, or A's when C can't be read, with a warning when the two differ.
It needs SymPy (https://www.sympy.org); the rest of texc doesn't. `python3 mathcalc.py '2^{10}'`
prints a result; `--chain 'A'` before a formula gives it an earlier side, `--decl 'X \\sim N(0, 1)'`
a declaration. Python 3.9+.
"""

from __future__ import annotations

import json
import re
import signal
import sys
import time
from collections import Counter

sp = None                      # sympy, imported by load()

STEP_SECONDS = 2.5             # each heavy step (doit, simplify, N) stops after this long
TOTAL_SECONDS = 4.0            # and a whole request after this long (the server kills at 6 s)
CHAIN_SECONDS = 2.0            # the earlier sides of a chain get this long once the last has a result,
CHAIN_MARGIN = 0.3             # and always stop this long before the request would
MAX_CHAIN = 8                  # earlier sides kept
CHAIN_TRIES = 4                # ... and how many of them are tried for a value
MAX_INPUT = 4000
MAX_LATEX_OUT = 600            # longer exact results are dropped (a decimal may still be shown)
MAX_POW_BITS = 200_000         # bigger integer powers stay unevaluated and are shown as decimals
MAX_FACTORIAL = 3000
MAX_ALT_DENOMINATOR = 10000    # a decimal result also offers its fraction up to this denominator


def load():
    global sp
    if sp is None:
        import sympy
        sp = sympy
    return sp


class ParseError(Exception):
    pass


class Timeout(Exception):
    pass


class Refuse(ParseError):
    """Readable, but not something to compute (dy/dx of an unknown y): no fallback reading."""


# ---------------------------------------------------------------------------------------------
# Tokens
# ---------------------------------------------------------------------------------------------

GREEK = {
    "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta",
    "iota", "kappa", "lambda", "mu", "nu", "xi", "rho", "varrho", "sigma", "varsigma", "tau",
    "upsilon", "phi", "varphi", "chi", "psi", "omega", "Gamma", "Delta", "Theta", "Lambda", "Xi",
    "Sigma", "Upsilon", "Phi", "Psi", "Omega",
}
UNICODE = {
    "×": ("cmd", "times"), "·": ("cmd", "cdot"), "⋅": ("cmd", "cdot"), "−": ("sym", "-"),
    "÷": ("cmd", "div"), "π": ("cmd", "pi"), "∞": ("cmd", "infty"), "√": ("cmd", "sqrt"),
    "∫": ("cmd", "int"), "∑": ("cmd", "sum"), "∏": ("cmd", "prod"), "°": ("cmd", "degree"),
    "α": ("cmd", "alpha"), "β": ("cmd", "beta"), "γ": ("cmd", "gamma"), "δ": ("cmd", "delta"),
    "ε": ("cmd", "epsilon"), "θ": ("cmd", "theta"), "λ": ("cmd", "lambda"), "μ": ("cmd", "mu"),
    "σ": ("cmd", "sigma"), "τ": ("cmd", "tau"), "φ": ("cmd", "phi"), "ω": ("cmd", "omega"),
    "≤": ("cmd", "le"), "≥": ("cmd", "ge"), "≠": ("cmd", "ne"), "±": ("cmd", "pm"), "∓": ("cmd", "mp"),
    "Φ": ("cmd", "Phi"), "χ": ("cmd", "chi"), "∣": ("cmd", "mid"), "‖": ("cmd", "|"),
}
# Spacing and sizing that don't change the math.
SKIP = {
    ",", ";", ":", "!", " ", ">", "quad", "qquad", "displaystyle", "textstyle", "scriptstyle",
    "scriptscriptstyle", "limits", "nolimits", "left", "right", "big", "Big", "bigg", "Bigg",
    "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr", "Biggl", "Biggr", "nonumber", "notag",
    "thinspace", "medspace", "thickspace", "negthinspace", "negmedspace", "negthickspace",
    "enspace", "mathstrut", "strut", "allowbreak", "nobreak", "mathop", "mathord", "mathbin",
    "mathrel", "mathclose", "mathopen", "relax",
}
SKIP_WITH_ARG = {"label", "tag", "hspace", "vspace", "phantom", "hphantom", "vphantom", "color"}
ALIASES = {
    "lvert": ("sym", "|"), "rvert": ("sym", "|"), "vert": ("sym", "|"), "mid": ("cmd", "mid"),
    "Vert": ("cmd", "|"), "lVert": ("cmd", "|"), "rVert": ("cmd", "|"), "lt": ("sym", "<"), "gt": ("sym", ">"),
    "lbrace": ("cmd", "{"), "rbrace": ("cmd", "}"), "lbrack": ("sym", "["), "rbrack": ("sym", "]"),
    "cdotp": ("cmd", "cdot"), "dfrac": ("cmd", "frac"), "tfrac": ("cmd", "frac"),
    "cfrac": ("cmd", "frac"), "dbinom": ("cmd", "binom"), "tbinom": ("cmd", "binom"),
    "intop": ("cmd", "int"), "smallint": ("cmd", "int"), "rightarrow": ("cmd", "to"),
    "longrightarrow": ("cmd", "to"), "dotsb": ("cmd", "cdots"), "intercal": ("cmd", "top"),
    "arcsinh": ("cmd", "arsinh"), "arccosh": ("cmd", "arcosh"), "arctanh": ("cmd", "artanh"),
}


class Tok:
    __slots__ = ("kind", "val", "split")

    def __init__(self, kind, val, split=False):
        self.kind, self.val = kind, val       # kind: num | let | cmd | sym
        self.split = split                    # the rest of a number after TeX took one digit

    def is_(self, kind, val=None):
        return self.kind == kind and (val is None or self.val == val)

    def __repr__(self):
        return f"{self.kind}:{self.val}"


def _skip_group(s, i):
    """i is just past a command; skip an optional * and one {...} group."""
    n = len(s)
    while i < n and s[i] in " \t\n":
        i += 1
    if i < n and s[i] == "*":
        i += 1
    while i < n and s[i] in " \t\n":
        i += 1
    if i < n and s[i] == "{":
        depth = 0
        while i < n:
            if s[i] == "\\":
                i += 2
                continue
            if s[i] == "{":
                depth += 1
            elif s[i] == "}":
                depth -= 1
                if depth == 0:
                    return i + 1
            i += 1
        raise ParseError("unbalanced group")
    return i


def tokenize(s: str) -> list:
    out, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if c in " \t\r\n~":
            i += 1
        elif c == "%":                                   # a comment runs to the end of the line
            j = s.find("\n", i)
            i = n if j < 0 else j + 1
        elif c == "\\":
            if i + 1 >= n:
                raise ParseError("lone backslash")
            m = re.match(r"[A-Za-z]+", s[i + 1:])
            if m:
                name = m.group(0)
                i += 1 + len(name)
            else:
                name = s[i + 1]
                i += 2
            if name in SKIP:
                if name in ("left", "right", "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr", "Biggl", "Biggr", "big", "Big", "bigg", "Bigg"):
                    while i < n and s[i] in " \t\n":
                        i += 1
                    if i < n and s[i] == ".":            # \left. and \right. are invisible
                        i += 1
                continue
            if name in SKIP_WITH_ARG:
                i = _skip_group(s, i)
                continue
            kind, val = ALIASES.get(name, ("cmd", name))
            out.append(Tok(kind, val))
        elif c.isdigit() or (c == "." and i + 1 < n and s[i + 1].isdigit()):
            m = re.match(r"\d*\.?\d+|\d+\.?", s[i:])
            text = m.group(0)
            if text.endswith("."):                       # "2." at the end of a sentence
                text = text[:-1]
            out.append(Tok("num", text))
            i += len(text)
        elif c.isascii() and c.isalpha():
            out.append(Tok("let", c))
            i += 1
        elif c in UNICODE:
            out.append(Tok(*UNICODE[c]))
            i += 1
        else:
            out.append(Tok("sym", c))
            i += 1
    return out


# ---------------------------------------------------------------------------------------------
# Parser: tokens -> SymPy objects
# ---------------------------------------------------------------------------------------------

FUNCS = {
    "sin": "sin", "cos": "cos", "tan": "tan", "cot": "cot", "sec": "sec", "csc": "csc",
    "arcsin": "asin", "arccos": "acos", "arctan": "atan", "arccot": "acot", "arcsec": "asec",
    "arccsc": "acsc", "sinh": "sinh", "cosh": "cosh", "tanh": "tanh", "coth": "coth",
    "sech": "sech", "csch": "csch", "arsinh": "asinh", "arcosh": "acosh", "artanh": "atanh",
    "exp": "exp", "ln": "log", "arg": "arg", "sgn": "sign", "erf": "erf", "erfc": "erfc",
}
INVERSE = {"sin": "asin", "cos": "acos", "tan": "atan", "cot": "acot", "sec": "asec", "csc": "acsc",
           "sinh": "asinh", "cosh": "acosh", "tanh": "atanh"}
OPERATOR_NAMES = dict(FUNCS, sign="sign", lcm="lcm", gcd="gcd", tr="trace", Tr="trace",
                      rank="rank", floor="floor", ceil="ceiling", Re="re", Im="im",
                      arcsinh="asinh", arccosh="acosh", arctanh="atanh", li="li", Ei="Ei",
                      Si="Si", Ci="Ci", sinc="sinc")
MULTI = {"max": "Max", "min": "Min", "gcd": "gcd", "lcm": "lcm"}
MATRIX_ENVS = {"matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "smallmatrix", "array"}
DECORATIONS = {"mathbf", "boldsymbol", "bm", "vec", "hat", "bar", "tilde", "dot", "ddot",
               "mathcal", "mathbb", "mathsf", "mathfrak", "overline", "widehat", "widetilde",
               "mathscr"}
ROMAN = {"mathrm", "mathit", "rm", "operatorname", "textrm", "mathnormal"}
TEXT = {"text", "textit", "textbf", "textsf", "texttt", "mbox", "hbox", "intertext", "emph"}
# Letters people use as function names: `f(x)` is a function, not f times x (and it is refused,
# since its value is unknown). Other letters before brackets multiply, x(x+1), unless the bracket
# holds a single token, x(t). Greek letters and decorated names before a bracket are functions too.
FUNCNAMES = set("fghpquvwyFGHLNPQEVTR")
TRANSPOSE = {"T", "\\top", "\\intercal", "\\mathsf{T}", "\\mathrm{T}"}
FACTOR_CMDS = (set(FUNCS) | GREEK | set(MULTI) | DECORATIONS | ROMAN | {
    "frac", "sqrt", "binom", "int", "sum", "prod", "lim", "{", "begin", "lfloor", "lceil",
    "pi", "infty", "degree", "abs", "log", "lg", "det", "partial", "imath", "jmath", "ell",
    "choose", "cdots", "ldots", "dots",
} | TEXT)


# Probability, statistics and ML: names that take an argument in brackets.
STAT_WORDS = {
    "P": "prob", "Pr": "prob", "Prob": "prob", "E": "expect",
    "Var": "var", "var": "var", "Variance": "var", "V": "var", "SD": "sd", "sd": "sd", "Std": "sd",
    "std": "sd", "stdev": "sd", "Cov": "cov", "cov": "cov", "Corr": "corr", "corr": "corr", "Cor": "corr",
    "mean": "mean", "Mean": "mean", "avg": "mean", "median": "median", "Median": "median",
    "mode": "mode", "Mode": "mode",
    "sigmoid": "sigmoid", "Sigmoid": "sigmoid", "logistic": "sigmoid", "ReLU": "relu", "relu": "relu",
    "ReLu": "relu", "softmax": "softmax", "Softmax": "softmax", "softplus": "softplus",
    "Softplus": "softplus", "logit": "logit",
}
# Spelled with plain letters (Var(X), mean(1, 2, 3)): only these, and only right before a bracket.
LETTER_WORDS = {w for w in STAT_WORDS if len(w) > 1 and w not in ("Prob", "Variance")}
ML_OPS = {"sigmoid", "relu", "softplus", "logit", "softmax"}
DATA_OPS = {"mean", "median", "mode"}
REL_CMDS = {"le": "le", "leq": "le", "leqslant": "le", "leqq": "le", "ge": "ge", "geq": "ge",
            "geqslant": "ge", "geqq": "ge", "ne": "ne", "neq": "ne"}
# Distribution names after \sim: N(0, 1), \mathcal{N}, \text{Bin}(10, 0.3), t_{10}, \chi^2_3, F_{2,10} …
DIST_WORDS = {
    "normal": "normal", "gaussian": "normal", "gauss": "normal", "bin": "binomial", "binom": "binomial",
    "binomial": "binomial", "po": "poisson", "poi": "poisson", "pois": "poisson", "poisson": "poisson",
    "exp": "exponential", "expo": "exponential", "exponential": "exponential", "unif": "uniform",
    "uniform": "uniform", "ber": "bernoulli", "bern": "bernoulli", "bernoulli": "bernoulli",
    "geo": "geometric", "geom": "geometric", "geometric": "geometric", "beta": "beta", "student": "t",
}
DIST_LETTERS = {"N": "normal", "B": "binomial", "U": "uniform", "F": "f", "t": "t"}
DIST_ARITY = {"normal": 2, "binomial": 2, "poisson": 1, "exponential": 1, "uniform": 2, "bernoulli": 1,
              "geometric": 1, "t": 1, "chi2": 1, "f": 2, "beta": 2}
MAX_DECLS = 40


class Frame:
    __slots__ = ("kind", "var", "closed")

    def __init__(self, kind):
        self.kind, self.var, self.closed = kind, None, False


class Parser:
    def __init__(self, toks, decls=None):
        self.t = toks
        self.i = 0
        self.frames = []           # open integrals (their differential ends them) and groups
        self.bound = []            # names bound by \sum / \prod indices (then i and e are plain)
        self.abs_depth = 0
        self.limit_point = 0
        self.limit_dir = None
        self.flags = set()         # decimal, calculus, indefinite, matrix-op, huge, stats, numeric, evaluated
        self.env = None            # the matrix environment of the input, for the output
        self.decls = decls or {}   # random variables declared in the document: name -> Dist
        self.rv_mode = 0           # inside P(…), E[…], Var(…): declared names are random variables
        self.event_depth = 0       # inside P(…): a bare | after an operand is "given"
        self.norm_depth = 0        # inside \| … \|
        self.used = {}             # the random variables read so far: name -> Dist
        self.notes = []            # what the result assumes, shown under it
        self.pm = None             # a \pm b at the top level: (a, b)

    def note(self, text):
        if text not in self.notes:
            self.notes.append(text)

    def at_bracket(self, k=0):
        return self.at("sym", "(", k) or self.at("sym", "[", k)

    # -- token helpers
    def peek(self, k=0):
        j = self.i + k
        return self.t[j] if j < len(self.t) else Tok("end", None)

    def next(self):
        tk = self.peek()
        self.i += 1
        return tk

    def at(self, kind, val=None, k=0):
        return self.peek(k).is_(kind, val)

    def one_digit(self):
        """TeX reads one digit as a macro argument or script: x^23 is x^2 3, \\frac12 is 1/2."""
        tk = self.peek()
        if tk.kind == "num" and len(tk.val) > 1 and tk.val[0].isdigit():
            self.t[self.i:self.i + 1] = [Tok("num", tk.val[0], tk.split), Tok("num", tk.val[1:], True)]

    def at_differential(self):
        if self.open_integral() is None:
            return False
        tk, nx = self.peek(), self.peek(1)
        if tk.is_("let", "d"):
            return (nx.kind == "let" and nx.val != "d") or (nx.kind == "cmd" and nx.val in GREEK)
        return tk.kind == "cmd" and tk.val in ROMAN and self.at("sym", "{", 1) and self.at("let", "d", 2) and self.at("sym", "}", 3)

    def expect(self, kind, val=None):
        tk = self.next()
        if not tk.is_(kind, val):
            raise ParseError(f"expected {val or kind}, got {tk}")
        return tk

    def closed(self, frame):
        return frame is not None and frame.closed

    def top(self):
        return self.frames[-1] if self.frames else None

    def open_integral(self):
        for f in reversed(self.frames):
            if f.kind == "int" and not f.closed:
                return f
        return None

    # -- entry
    def parse(self):
        e = self.expr()
        if self.at("cmd", "pm") or self.at("cmd", "mp"):        # 52 \pm 1.96: an interval
            self.next()
            self.pm = (e, self.expr())
        if self.peek().kind != "end":
            raise ParseError(f"unexpected {self.peek()}")
        return e

    def grouped(self, closer_kind, closer_val):
        self.frames.append(Frame("group"))
        try:
            e = self.expr()
        finally:
            self.frames.pop()
        self.expect(closer_kind, closer_val)
        return e

    # -- grammar
    def expr(self):
        frame = self.top()
        node = self.term()
        done = None                                       # once a bar has come: everything up to the last term
        while not self.closed(frame):
            tk = self.peek()
            if tk.is_("sym", "+") or tk.is_("sym", "-"):
                self.next()
                rhs = self.term()
                if isinstance(node, sp.MatrixBase) or isinstance(rhs, sp.MatrixBase):
                    self.flags.add("matrix-op")
                if done is None:
                    node = node + rhs if tk.val == "+" else node - rhs
                else:                                     # F|_a^b + G|_a^b: a later bar takes its own term
                    done, node = done + node, (rhs if tk.val == "+" else -rhs)
            elif self.at_bar():                           # t^2 + t \Big|_0^1: all of it, between the bounds
                self.next()
                value = self.between(node)
                done, node = (value if done is None else done + value), sp.Integer(0)
            else:
                break
        return node if done is None else done + node

    def term(self):
        frame = self.top()
        node = self.unary()
        while not self.closed(frame):
            tk = self.peek()
            if tk.is_("sym", "*") or (tk.kind == "cmd" and tk.val in ("cdot", "times", "ast")):
                self.next()
                rhs = self.unary()
                u, v = _vector(node), _vector(rhs)
                if u is not None and v is not None and len(u) == len(v):
                    self.flags.add("matrix-op")
                    if tk.val == "cdot":                 # u · v of two vectors: the dot product
                        node = sum((a * b for a, b in zip(u, v)), sp.Integer(0))
                        continue
                    if tk.val == "times" and len(u) == 3:   # u × v: the cross product
                        node = sp.Matrix(u).cross(sp.Matrix(v))
                        continue
                node = self.mul(node, rhs)
            elif tk.is_("sym", "/") or tk.is_("cmd", "div"):
                self.next()
                rhs = self.unary()
                if isinstance(rhs, sp.MatrixBase):
                    raise ParseError("division by a matrix")
                node = node / rhs
            elif tk.kind == "cmd" and tk.val in ("bmod", "mod"):
                self.next()
                node = sp.Mod(node, self.unary())
            elif self.starts_factor(tk):
                if tk.kind == "num":
                    raise ParseError("a number right after a factor is ambiguous")
                node = self.mul(node, self.postfix(self.primary()))
            else:
                break
        return node

    def mul(self, a, b):
        if isinstance(a, sp.MatrixBase) or isinstance(b, sp.MatrixBase):
            self.flags.add("matrix-op")
        return a * b

    def starts_factor(self, tk):
        if tk.kind in ("num", "let"):
            return True
        if tk.kind == "sym":
            return tk.val in "([{" or (tk.val == "|" and self.abs_depth == 0 and not self.event_depth
                                       and not self.at_bar())
        if tk.is_("cmd", "|"):
            return not self.norm_depth
        return tk.kind == "cmd" and (tk.val in FACTOR_CMDS or tk.val == "Pr")

    # -- evaluation between bounds: [F]_a^b and F \Big|_a^b are F(b) - F(a)
    def at_bar(self):
        """At a | with a script after it, outside |…| and P(… | …): an evaluation bar, not an absolute value."""
        return (self.at("sym", "|") and self.abs_depth == 0 and not self.event_depth
                and (self.at("sym", "_", 1) or self.at("sym", "^", 1)))

    def at_bounds(self):
        """At _a^b or ^b_a after a ]: both scripts. A lone ^ is a power, [x+1]^2."""
        if self.at("sym", "_"):
            return True
        if not self.at("sym", "^"):
            return False
        k = 1
        if self.at("sym", "{", k):
            depth = 0
            while True:
                tk = self.peek(k)
                if tk.kind == "end":
                    return False
                if tk.is_("sym", "{"):
                    depth += 1
                elif tk.is_("sym", "}"):
                    depth -= 1
                    if depth == 0:
                        break
                k += 1
        elif self.peek(k).kind == "end" or (self.peek(k).kind == "num" and len(self.peek(k).val) > 1):
            return False
        return self.at("sym", "_", k + 1)

    def one_bound(self):
        """One bound: (variable or None, value). _{t=0} names the variable, _0 leaves it open."""
        named = self.at("let", None, 1) or (self.peek(1).kind == "cmd" and self.peek(1).val in GREEK)
        if self.at("sym", "{") and named and self.at("sym", "=", 2):
            var = sp.Symbol(self.peek(1).val)
            self.i += 3
            return var, self.grouped("sym", "}")
        return None, self.script()

    def between(self, f):
        """The bounds after [F] or F|, and F at the upper one minus F at the lower one."""
        lo = hi = var = None
        for _ in range(2):
            if self.at("sym", "_") and lo is None:
                self.next()
                v, lo = self.one_bound()
            elif self.at("sym", "^") and hi is None:
                self.next()
                v, hi = self.one_bound()
            else:
                break
            if v is not None:
                if var is not None and v != var:
                    raise Refuse("the two bounds name different variables")
                var = v
        if lo is None or hi is None:
            raise ParseError("an evaluation needs both bounds")
        if any(isinstance(x, sp.MatrixBase) for x in (f, lo, hi)):
            raise Refuse("a matrix between bounds")
        f, lo, hi = sp.sympify(f), sp.sympify(lo), sp.sympify(hi)
        if not all(isinstance(x, sp.Expr) for x in (f, lo, hi)):
            raise Refuse("not an expression between bounds")
        pending = (sp.Integral, sp.Derivative, sp.Sum, sp.Product, sp.Limit)
        if f.has(*pending):                              # [\int_0^t 2s\,ds]_0^x: do the inner one first
            if any(len(lim) == 1 for g in f.atoms(sp.Integral) for lim in g.limits):
                raise Refuse("an antiderivative (+ C) between bounds")
            f = step(f.doit)
            if f is None or f.has(*pending):
                raise Refuse("the expression between the bounds has no closed form")
        if var is None:
            free = sorted(f.free_symbols, key=lambda s: s.name)
            if len(free) > 1:                            # [x t^2]_0^x: the one the bounds don't use
                used = lo.free_symbols | hi.free_symbols
                free = [s for s in free if s not in used]
            if len(free) != 1:
                raise Refuse("which variable the bounds are for isn't clear")
            var = free[0]
        self.check_indexed(f, [var])
        self.flags.add("evaluated")
        return self.value_at(f, var, hi, "-") - self.value_at(f, var, lo, "+")

    def value_at(self, f, var, point, side):
        v = f.subs(var, point)
        if v.has(sp.nan, sp.zoo, sp.AccumBounds):        # t e^{-t} at infinity, \sin(t)/t at 0: the limit
            if point in (sp.oo, -sp.oo):
                v = step(lambda: sp.limit(f, var, point))
            else:
                v = step(lambda: sp.limit(f, var, point, side))
            if v is None or v.has(sp.nan, sp.zoo, sp.AccumBounds, sp.Limit):
                raise Refuse("no value at the bound")
        return v

    def unary(self):
        if self.at("sym", "-"):
            self.next()
            return -self.unary()
        if self.at("sym", "+"):
            self.next()
            return self.unary()
        return self.postfix(self.primary())

    def postfix(self, base):
        while True:
            tk = self.peek()
            if tk.is_("sym", "^"):
                self.next()
                base = self.superscript(base)
                if self.at("sym", "^"):
                    raise ParseError("double superscript")
            elif tk.is_("sym", "!") and not self.at("sym", "=", 1):
                self.next()
                if self.at("sym", "!"):
                    self.next()
                    base = self.guard_factorial(base, double=True)
                else:
                    base = self.guard_factorial(base)
            elif tk.is_("cmd", "%"):
                self.next()
                base = base / 100
            elif tk.is_("sym", "'") or tk.is_("sym", "_"):
                raise ParseError("primes and subscripts on expressions aren't supported")
            else:
                return base

    def superscript(self, base):
        tk = self.peek()
        # degrees: 30^\circ, 30^{\circ}
        if tk.is_("cmd", "circ") or (tk.is_("sym", "{") and self.at("cmd", "circ", 1) and self.at("sym", "}", 2)):
            self.i += 1 if tk.kind == "cmd" else 3
            return base * sp.pi / 180
        # one-sided limits: x \to 0^+
        if self.limit_point and (tk.is_("sym", "+") or tk.is_("sym", "-")
                                 or (tk.is_("sym", "{") and (self.at("sym", "+", 1) or self.at("sym", "-", 1)) and self.at("sym", "}", 2))):
            sign = tk.val if tk.kind == "sym" and tk.val in "+-" else self.peek(1).val
            self.i += 1 if tk.val in "+-" else 3
            self.limit_dir = sign
            return base
        is_t = tk.is_("let", "T") or tk.is_("cmd", "top") or (
            tk.is_("sym", "{") and (self.at("let", "T", 1) or self.at("cmd", "top", 1)) and self.at("sym", "}", 2))
        if is_t and not isinstance(base, sp.MatrixBase):
            raise Refuse("^T of something that isn't a matrix")
        if isinstance(base, sp.MatrixBase):
            if is_t:
                self.i += 1 if tk.kind != "sym" else 3
                self.flags.add("matrix-op")
                return base.T
            self.flags.add("matrix-op")
        exp = self.script()
        return self.guard_pow(base, exp)

    def guard_pow(self, base, exp):
        if isinstance(exp, sp.MatrixBase):
            raise ParseError("matrix exponent")
        if isinstance(base, sp.MatrixBase):
            if not (exp.is_Integer):
                raise ParseError("matrix power must be an integer")
            return base ** int(exp)
        b, e = sp.sympify(base), sp.sympify(exp)
        if "huge" in self.flags and e.has(sp.Pow) and e.is_number and not e.is_Number and b.is_number and b != 1:
            raise ParseError("a power tower too large to compute")      # 9^{9^{9^9}}
        if b.is_Number and e.is_Number and e.is_Integer and b != 0:
            bits = abs(int(e)) * max(1, int(abs(b)).bit_length() if b.is_Integer else 64)
            if bits > MAX_POW_BITS:
                self.flags.add("huge")
                return sp.Pow(b, e, evaluate=False)
        return b ** e

    def guard_factorial(self, base, double=False):
        b = sp.sympify(base)
        if b.is_Integer and int(b) > MAX_FACTORIAL:
            self.flags.add("huge")
            return (sp.factorial2 if double else sp.factorial)(b, evaluate=False)
        return (sp.factorial2 if double else sp.factorial)(b)

    def script(self):
        """The argument of ^ or _ : a {group} or exactly one token, as in TeX (x^23 is x^2 times 3)."""
        tk = self.peek()
        if tk.is_("sym", "{"):
            self.next()
            return self.grouped("sym", "}")
        if tk.kind == "num":
            self.one_digit()
            return self.number(self.next().val)
        if tk.kind == "let" or tk.kind == "cmd":
            return self.primary(script=True)
        raise ParseError(f"bad script {tk}")

    def number(self, text):
        if "." in text:
            self.flags.add("decimal")
        return sp.Rational(text)

    def raw_group(self):
        """The letters and digits inside {...} (for \\mathrm{d}, subscripts and names)."""
        if not self.at("sym", "{"):
            tk = self.next()
            if tk.kind in ("let", "num"):
                return tk.val
            if tk.kind == "cmd":
                return "\\" + tk.val
            raise ParseError("expected a name")
        self.next()
        parts, depth = [], 0
        while True:
            tk = self.next()
            if tk.kind == "end":
                raise ParseError("unclosed group")
            if tk.is_("sym", "{"):
                depth += 1
            elif tk.is_("sym", "}"):
                if depth == 0:
                    break
                depth -= 1
            parts.append(tk.val if tk.kind != "cmd" else "\\" + tk.val + " ")
        return "".join(str(p) for p in parts).strip()

    def symbol(self, name, applied_ok=False, sub=True):
        """A variable, with an optional subscript: x, x_1, a_{ij}, \\alpha_0 (sub=False: never one).

        Refuses what would be read wrongly: x_i under \\sum_i (the index is bound, a plain symbol
        x_i would not change with it) and names applied to brackets, f(x), \\phi(x), x(t)."""
        sym_name = name
        if sub and self.at("sym", "_"):
            self.next()
            sub = self.raw_group().replace(" ", "")
            if not sub:
                raise ParseError("empty subscript")
            for b in self.bound:
                if (len(b) == 1 and b in re.sub(r"\\[A-Za-z]+", "", sub)) or ("\\" + b) in sub:
                    raise Refuse(f"{name}_{sub} is indexed by the bound {b}")
            sym_name = f"{name}_{sub}"
        if not applied_ok and (self.at("sym", "(") or self.at("sym", "[")):
            closer = ")" if self.at("sym", "(") else "]"
            single = self.peek(1).kind in ("let", "num") or (self.peek(1).kind == "cmd" and self.peek(1).val in GREEK)
            if name in FUNCNAMES or name in GREEK or name.startswith("\\") or (single and self.at("sym", closer, 2)) \
                    or self.comma_ahead():
                raise Refuse(f"{name}(...) reads as a function")
        if self.rv_mode:
            if sym_name in self.decls and self.decls[sym_name] is None:
                raise Refuse(f"{sym_name} is declared with a distribution texc doesn't know")
            if sym_name in self.decls or sym_name == "Z":
                self.use_rv(sym_name)
            elif re.match(r"(?:\\[A-Za-z]+\{)?[A-Z]", sym_name):
                raise Refuse(f"{sym_name} looks like a random variable but has no declaration")
        return sp.Symbol(sym_name)

    def comma_ahead(self):
        """The bracket at the cursor holds a top-level comma: x(1, 2) is a function call, not x·(1, 2)."""
        depth, k = 0, 0
        while True:
            tk = self.peek(k)
            if tk.kind == "end":
                return False
            if tk.kind == "sym" and tk.val in "([{":
                depth += 1
            elif tk.kind == "sym" and tk.val in ")]}":
                depth -= 1
                if depth == 0:
                    return False
            elif depth == 1 and tk.is_("sym", ","):
                return True
            k += 1

    def use_rv(self, name):
        if name not in self.used:
            dist = self.decls.get(name)
            if dist is None:                                  # Z: the standard normal, by convention
                dist = Dist("normal", [sp.Integer(0), sp.Integer(1)])
                self.note("$Z$ standard normal")
            else:
                self.note(dist.describe(name))
            self.used[name] = dist

    # -- probability, statistics, ML
    def letter_word(self):
        """Var(X), mean(1, 2, 3), ReLU(-2): a known word in plain letters, right before a bracket."""
        start = self.i - 1
        letters, k = [], start
        while k < len(self.t) and self.t[k].kind == "let" and len(letters) < 8:
            letters.append(self.t[k].val)
            k += 1
        for n in range(len(letters), 1, -1):
            w = "".join(letters[:n])
            if w in LETTER_WORDS and self.at_bracket(start + n - self.i):
                self.i = start + n
                return w
        return None

    def comma_exprs(self, closer_kind, closer_val):
        self.frames.append(Frame("group"))
        try:
            items = [self.expr()]
            while self.at("sym", ","):
                self.next()
                items.append(self.expr())
        finally:
            self.frames.pop()
        self.expect(closer_kind, closer_val)
        return items

    def paren(self):
        """(…), or a tuple (1, 2, 3), which is a vector."""
        items = self.comma_exprs("sym", ")")
        if len(items) == 1:
            return items[0]
        if any(isinstance(x, sp.MatrixBase) for x in items):
            raise ParseError("a tuple of matrices")
        if self.env is None:
            self.env = "tuple"
        return sp.Matrix(items)

    def skip_param_name(self):
        """n = 10 or p{=}0.3 inside a distribution's brackets: skip the name."""
        depth, k = 0, 0
        while k < 12:
            tk = self.peek(k)
            if tk.kind == "end":
                return
            if tk.is_("sym", "{") and self.at("sym", "=", k + 1) and self.at("sym", "}", k + 2) and depth == 0:
                self.i += k + 3
                return
            if tk.kind == "sym" and tk.val in "([{":
                depth += 1
            elif tk.kind == "sym" and tk.val in ")]}":
                if depth == 0:
                    return
                depth -= 1
            elif depth == 0 and tk.is_("sym", ","):
                return
            elif depth == 0 and tk.is_("sym", "="):
                self.i += k + 1
                return
            k += 1

    def arg_list(self, rv=False, named=False):
        """(a, b, …) or [a, b, …]."""
        opener = self.next()
        if not (opener.is_("sym", "(") or opener.is_("sym", "[")):
            raise ParseError("expected a bracket")
        closer = ")" if opener.val == "(" else "]"
        args = []
        self.frames.append(Frame("group"))
        self.rv_mode += rv
        try:
            while True:
                if named:
                    self.skip_param_name()
                args.append(self.expr())
                if self.at("sym", ","):
                    self.next()
                    continue
                break
        finally:
            self.frames.pop()
            self.rv_mode -= rv
        self.expect("sym", closer)
        return args

    def named_op(self, word):
        op = STAT_WORDS[word]
        if op == "prob":
            return self.probability()
        if op == "expect":
            return self.expectation()
        if op in ML_OPS:
            return self.ml_op(op)
        args = self.arg_list(rv=True)
        if op in DATA_OPS:
            return self.data_op(op, args)
        return self.moment_op(op, args)

    def probability(self):
        """P(event), P(A | B), \\Pr[…]: from the distributions declared in the document."""
        closer = ")" if self.next().val == "(" else "]"
        self.frames.append(Frame("group"))
        self.rv_mode += 1
        self.event_depth += 1
        try:
            ev = self.event()
            given = None
            if self.at("sym", "|") or self.at("cmd", "mid"):
                self.next()
                given = self.event()
        finally:
            self.frames.pop()
            self.rv_mode -= 1
            self.event_depth -= 1
        self.expect("sym", closer)
        self.flags.add("stats")
        return prob_value(ev, given, self)

    def event(self):
        e = self.relation_chain()
        while True:
            if self.at("sym", ",") or self.at("cmd", "cap") or self.at("cmd", "land") or self.at("cmd", "wedge"):
                self.next()
                e = sp.And(e, self.relation_chain())
            elif self.at("cmd", "cup") or self.at("cmd", "lor") or self.at("cmd", "vee"):
                self.next()
                e = sp.Or(e, self.relation_chain())
            else:
                return e

    def relation_chain(self):
        """a < X \\le b: one or more relations."""
        a = self.expr()
        rels = []
        while True:
            op = self.rel_op()
            if op is None:
                break
            b = self.expr()
            rels.append(_relation(op, a, b))
            a = b
        if not rels:
            raise Refuse("an event needs a relation (P(A) names an event, not a value)")
        return sp.And(*rels) if len(rels) > 1 else rels[0]

    def rel_op(self):
        tk = self.peek()
        if tk.kind == "sym" and tk.val in "<>":
            self.next()
            if self.at("sym", "="):
                self.next()
                return "le" if tk.val == "<" else "ge"
            return "lt" if tk.val == "<" else "gt"
        if tk.is_("sym", "="):
            self.next()
            if self.at("sym", "="):
                self.next()
            return "eq"
        if tk.is_("sym", "!") and self.at("sym", "=", 1):
            self.i += 2
            return "ne"
        if tk.kind == "cmd" and tk.val in REL_CMDS:
            self.next()
            return REL_CMDS[tk.val]
        return None

    def expectation(self):
        closer = ")" if self.next().val == "(" else "]"
        self.frames.append(Frame("group"))
        self.rv_mode += 1
        try:
            g = self.expr()
        finally:
            self.frames.pop()
            self.rv_mode -= 1
        self.expect("sym", closer)
        self.flags.add("stats")
        return expect_value(g, self)

    def rv_names(self, e):
        free = getattr(e, "free_symbols", set())
        return [n for n in self.used if sp.Symbol(n) in free]

    def moment_op(self, op, args):
        if not any(self.rv_names(a) for a in args):
            if op in ("var", "sd") and len(args) >= 2:
                return self.data_op(op, args)                # Var(2, 4, 4, 5): the data's variance
            raise Refuse(f"{op} of something that isn't a declared random variable")
        self.flags.add("stats")
        if op in ("var", "sd"):
            if len(args) != 1:
                raise ParseError(f"{op} takes one argument")
            v = variance_value(args[0], self)
            return v if op == "var" else sp.sqrt(v)
        if len(args) != 2:
            raise ParseError(f"{op} takes two arguments")
        c = expect_value(sp.expand(args[0] * args[1]), self) - expect_value(args[0], self) * expect_value(args[1], self)
        if op == "cov":
            return c
        return c / sp.sqrt(variance_value(args[0], self) * variance_value(args[1], self))

    def data_op(self, op, args):
        """mean, median, mode, and the sample variance and sd (n − 1) of a list of numbers."""
        vals = []
        for a in args:
            vals.extend(list(a) if isinstance(a, sp.MatrixBase) else [a])
        vals = [sp.sympify(v) for v in vals]
        if not vals or not all(v.is_number and v.is_real for v in vals):
            raise Refuse("data must be numbers")
        n = len(vals)
        self.flags.add("stats")
        if op == "mean":
            return sp.Add(*vals) / n
        if op == "median":
            s = sorted(vals, key=lambda v: sp.N(v, 30))
            return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
        if op == "mode":
            counts = Counter(vals)
            top = max(counts.values())
            modes = [v for v, c in counts.items() if c == top]
            if top == 1 or len(modes) != 1:
                raise Refuse("no single mode")
            return modes[0]
        if n < 2:
            raise Refuse("a sample variance needs two numbers")
        m = sp.Add(*vals) / n
        var = sp.Add(*[(v - m) ** 2 for v in vals]) / (n - 1)
        self.note("sample variance (divides by $n-1$)" if op == "var" else "sample sd (divides by $n-1$)")
        return var if op == "var" else sp.sqrt(var)

    def ml_op(self, op):
        args = self.arg_list()
        self.flags.add("numeric")
        if op == "softmax":
            vals = []
            for a in args:
                vals.extend(list(a) if isinstance(a, sp.MatrixBase) else [a])
            if len(vals) < 2:
                raise ParseError("softmax of one number")
            ex = [sp.exp(v) for v in vals]
            total = sp.Add(*ex)
            shape = args[0].shape if len(args) == 1 and isinstance(args[0], sp.MatrixBase) else (len(vals), 1)
            if len(args) > 1 and self.env is None:
                self.env = "tuple"
            self.flags.add("matrix-op")
            return sp.Matrix(shape[0], shape[1], [e / total for e in ex])
        if len(args) != 1:
            raise ParseError(f"{op} takes one argument")
        f = {"sigmoid": lambda v: 1 / (1 + sp.exp(-v)), "relu": lambda v: sp.Max(0, v),
             "softplus": lambda v: sp.log(1 + sp.exp(v)), "logit": lambda v: sp.log(v / (1 - v))}[op]
        x = args[0]
        if isinstance(x, sp.MatrixBase):
            self.flags.add("matrix-op")
            return x.applyfunc(f)
        return f(x)

    def norm(self):
        """\\|v\\|, \\|v\\|_1, \\|v\\|_\\infty (Frobenius for a matrix unless a subscript says otherwise)."""
        self.norm_depth += 1
        try:
            items = self.comma_exprs("cmd", "|")
        finally:
            self.norm_depth -= 1
        v = items[0] if len(items) == 1 else sp.Matrix(items)
        order = None
        if self.at("sym", "_"):
            self.next()
            o = self.script()
            if o == sp.oo:
                order = sp.oo
            elif o in (1, 2):
                order = int(o)
            else:
                raise ParseError("unsupported norm")
        self.flags.add("matrix-op")
        if isinstance(v, sp.MatrixBase):
            return v.norm() if order is None else v.norm(order)
        if not getattr(v, "is_number", False):
            raise Refuse("the norm of a name")                 # \|A\|: A is a matrix we don't know
        return sp.Abs(v)

    def phi(self):
        """\\Phi(1.96) and \\Phi^{-1}(0.975): the standard normal CDF and its inverse."""
        save = self.i
        inverse = False
        if self.at("sym", "^"):
            self.next()
            if self.script() != -1:
                self.i = save
                return None
            inverse = True
        if not self.at_bracket():
            self.i = save
            return None
        x = sp.sympify(self.function_arg())
        if not (x.is_number and x.is_real):
            raise Refuse("\\Phi of a symbol")
        self.flags.add("stats")
        if inverse:
            if not (0 < x < 1):
                raise Refuse("\\Phi^{-1} needs 0 < p < 1")
            return sp.sqrt(2) * sp.erfinv(2 * x - 1)
        return (1 + sp.erf(x / sp.sqrt(2))) / 2

    def num_subscript(self):
        """At "_": a subscript of plain numbers, _{0.05, 3} or _5, as Rationals (consumed); else None."""
        if not self.at("sym", "_"):
            return None
        if self.peek(1).kind == "num":
            if len(self.peek(1).val) > 1 and "." not in self.peek(1).val:
                return None                                   # z_05 is z_0 5 to TeX
            vals, n = [self.peek(1).val], 2
        elif self.at("sym", "{", 1):
            vals, k = [], 2
            while True:
                if self.peek(k).kind != "num":
                    return None
                vals.append(self.peek(k).val)
                k += 1
                if self.at("sym", ",", k):
                    k += 1
                    continue
                if self.at("sym", "}", k):
                    k += 1
                    break
                return None
            n = k
        else:
            return None
        self.i += n
        return [sp.Rational(v) for v in vals]

    def critical(self, v):
        """z_{0.025}, t_{0.025, 10}, \\chi^2_{0.05, 3}, F_{0.05, 2, 10}: upper-tail critical values."""
        if v not in ("z", "t", "F", "chi"):
            return None
        save = self.i
        squared = v != "chi"
        nums = None
        for _ in range(2):
            if not squared and self.at("sym", "^"):
                if self.at("num", "2", 1):
                    self.i += 2
                elif self.at("sym", "{", 1) and self.at("num", "2", 2) and self.at("sym", "}", 3):
                    self.i += 4
                else:
                    break
                squared = True
            elif nums is None and self.at("sym", "_"):
                nums = self.num_subscript()
                if nums is None:
                    break
            else:
                break
        want = {"z": 1, "t": 2, "chi": 2, "F": 3}[v]
        alpha = [j for j, x in enumerate(nums or []) if 0 < x < 1]
        if not squared or nums is None or len(nums) != want or len(alpha) != 1:
            self.i = save
            return None
        a = nums[alpha[0]]
        dfs = [x for j, x in enumerate(nums) if j != alpha[0]]
        if any(d <= 0 for d in dfs):
            self.i = save
            return None
        self.flags.add("stats")
        df = f", ${'$ and $'.join(_nice(d) for d in dfs)}$ df" if dfs else ""
        self.note(f"upper-tail area ${_nice(a)}${df}")
        if v == "z":
            return sp.sqrt(2) * sp.erfinv(1 - 2 * a)
        return Dist({"t": "t", "chi": "chi2", "F": "f"}[v], dfs).upper_quantile(a)

    def dist_spec(self):
        """After \\sim: N(0, 1), \\mathcal{N}(\\mu, \\sigma^2), \\text{Bin}(10, 0.3), t_{10}, \\chi^2_3, F_{2,10} …"""
        tk = self.next()
        if tk.kind == "let":
            letters = [tk.val]
            while self.peek().kind == "let" and len(letters) < 12:
                letters.append(self.next().val)
            word = "".join(letters)
        elif tk.kind == "cmd" and tk.val in DECORATIONS | ROMAN | TEXT:
            word = self.raw_group().replace(" ", "")
        elif tk.kind == "cmd" and tk.val in ("chi", "exp"):
            word = tk.val
        else:
            raise ParseError("not a distribution")
        if word == "chi":
            kind = "chi2"
        elif len(word) == 1:
            kind = DIST_LETTERS.get(word)
        else:
            kind = DIST_WORDS.get(word.lower())
        if kind is None:
            raise ParseError(f"unknown distribution {word}")
        squared = kind != "chi2"
        params = None
        for _ in range(2):
            if not squared and self.at("sym", "^"):
                self.next()
                if self.script() != 2:
                    raise ParseError("chi needs ^2")
                squared = True
            elif params is None and kind in ("t", "chi2", "f") and self.at("sym", "_"):
                self.next()
                if self.at("sym", "{"):
                    self.next()
                    params = self.comma_exprs("sym", "}")
                else:
                    params = [self.script()]
            else:
                break
        if not squared:
            raise ParseError("chi needs ^2")
        if params is None:
            if not self.at_bracket():
                raise ParseError("a distribution needs its parameters")
            params = self.arg_list(named=True)
        if len(params) != DIST_ARITY[kind] or any(isinstance(x, sp.MatrixBase) for x in params):
            raise ParseError("wrong number of parameters")
        if any(re.match(r"(?:\\[A-Za-z]+\{)?[A-Z]", s_.name) for x in params for s_ in sp.sympify(x).free_symbols):
            raise ParseError("a capital parameter (N(0, I), N(\\mu, \\Sigma)) is a matrix or a variable")
        return Dist(kind, params)

    def differential(self):
        """At a 'd' (or \\mathrm{d}) inside an integral: dx closes the innermost open integral."""
        frame = self.open_integral()
        if frame is None:
            return None
        tk = self.peek()
        if tk.kind == "let" and tk.val != "d":
            self.next()
            var = self.symbol(tk.val)
        elif tk.kind == "cmd" and tk.val in GREEK:
            self.next()
            var = self.symbol(tk.val)
        else:
            return None
        frame.var, frame.closed = var, True
        return sp.Integer(1)

    def primary(self, script=False):
        tk = self.next()
        k, v = tk.kind, tk.val
        if k == "num":
            if tk.split:                              # 2^10 renders as 2¹0: don't guess
                raise ParseError("digits after a one-digit script")
            return self.number(v)
        if k == "let":
            if not script:
                w = self.letter_word()
                if w is not None:
                    return self.named_op(w)
                if v in ("P", "E") and self.at_bracket():
                    return self.named_op(v)
                c = self.critical(v)
                if c is not None:
                    return c
            if v == "d" and not script:
                d = self.differential()
                if d is not None:
                    return d
            if v == "e" and "e" not in self.bound and (script or not self.at("sym", "_")):   # e_1 is a name,
                return sp.E                                                                 # ^e_1 two scripts
            if v == "i" and "i" not in self.bound and (script or not self.at("sym", "_")):
                return sp.I
            return self.symbol(v, sub=not script)         # a one-token script: \int^x_0 is ^x and _0
        if k == "sym":
            if v == "(":
                return self.paren()
            if v == "[":
                e = self.grouped("sym", "]")
                return self.between(e) if self.at_bounds() else e
            if v == "{":
                e = self.grouped("sym", "}")
                if self.at("cmd", "choose"):
                    raise ParseError("\\choose")
                return e
            if v == "|":
                self.abs_depth += 1
                try:
                    e = self.grouped("sym", "|")
                finally:
                    self.abs_depth -= 1
                if isinstance(e, sp.MatrixBase):
                    self.flags.add("matrix-op")
                    return e.det()
                return sp.Abs(e)
            raise ParseError(f"unexpected {v}")
        if k != "cmd":
            raise ParseError("unexpected end")
        if v == "{":
            return self.grouped("cmd", "}")
        if v == "Pr":
            if not self.at_bracket():
                raise ParseError("\\Pr needs a bracket")
            return self.named_op("Pr")
        if v == "|":
            return self.norm()
        if v == "chi" and not script:
            c = self.critical("chi")
            if c is not None:
                return c
        if v == "Phi":
            c = self.phi()
            if c is not None:
                return c
        if v == "frac":
            return self.frac()
        if v == "sqrt":
            if self.at("sym", "["):
                self.next()
                n = self.grouped("sym", "]")
                return sp.root(self.arg(), n)
            return sp.sqrt(self.arg())
        if v == "binom":
            n = self.arg()
            return sp.binomial(n, self.arg())
        if v == "int":
            return self.integral()
        if v in ("sum", "prod"):
            return self.bigop(v)
        if v == "lim":
            return self.limit()
        if v in FUNCS or v in ("log", "lg"):
            return self.function(v)
        if v in MULTI:
            return self.multi(MULTI[v])
        if v == "det":
            m = self.function_arg()
            if not isinstance(m, sp.MatrixBase):
                raise ParseError("\\det needs a matrix")
            self.flags.add("matrix-op")
            return m.det()
        if v == "abs":
            return sp.Abs(self.arg())
        if v == "lfloor":
            return sp.floor(self.grouped("cmd", "rfloor"))
        if v == "lceil":
            return sp.ceiling(self.grouped("cmd", "rceil"))
        if v == "pi":
            return sp.Symbol("pi") if "pi" in self.bound else sp.pi
        if v == "infty":
            return sp.oo
        if v == "degree":
            return sp.pi / 180
        if v in ("imath", "jmath"):
            return sp.I
        if v == "ell":
            return self.symbol("ell")
        if v in GREEK:
            if v in ("Gamma", "zeta") and self.at("sym", "("):
                arg = self.grouped_paren()
                return sp.gamma(arg) if v == "Gamma" else sp.zeta(arg)
            return self.symbol(v, sub=not script)
        if v in DECORATIONS:
            inner = self.raw_group()
            if inner.replace(" ", "") in STAT_WORDS and self.at_bracket():     # \mathbb{E}[X], \mathbb{P}(…)
                return self.named_op(inner.replace(" ", ""))
            return self.symbol(f"\\{v}{{{inner}}}")
        if v in TEXT:
            name = self.raw_group().replace(" ", "")
            if name in STAT_WORDS and self.at_bracket():                     # \text{Var}(X)
                return self.named_op(name)
            raise ParseError("text in math")
        if v in ROMAN:
            name = self.raw_group().replace(" ", "")
            if name in STAT_WORDS and self.at_bracket():                     # \operatorname{Var}(X)
                return self.named_op(name)
            if v == "operatorname":
                if name in MULTI:
                    return self.multi(MULTI[name])
                fn = OPERATOR_NAMES.get(name)
                if fn is None:
                    raise ParseError(f"unknown operator {name}")
                return self.apply(fn, self.function_arg())
            if name == "d" and not script:
                d = self.differential()
                if d is not None:
                    return d
            if name == "e":
                return sp.E
            if name == "i":
                return sp.I
            if name in OPERATOR_NAMES and len(name) > 1:
                return self.apply(OPERATOR_NAMES[name], self.function_arg())
            if re.fullmatch(r"[A-Za-z]", name):
                return self.symbol(name)
            raise ParseError(f"unknown name {name}")
        if v == "begin":
            return self.environment()
        raise ParseError(f"unsupported \\{v}")

    def arg(self):
        """A macro argument: a {group} or one token (\\frac12)."""
        if self.at("sym", "{"):
            self.next()
            return self.grouped("sym", "}")
        if self.peek().kind == "num":
            self.one_digit()
            return self.number(self.next().val)
        return self.primary()

    def grouped_paren(self):
        self.expect("sym", "(")
        return self.grouped("sym", ")")

    def frac(self):
        save = self.i
        try:
            d = self.derivative()
        except Refuse:
            raise
        except ParseError:
            d = None
        if d is not None:
            return d
        self.i = save
        if self.at("sym", "{") and self.at("let", "d", 1) and self.open_integral() is None and (
                self.at("let", None, 2) or (self.peek(2).kind == "cmd" and self.peek(2).val in GREEK)):
            raise Refuse("dx/... outside an integral")
        num = self.arg()
        den = self.arg()
        if isinstance(den, sp.MatrixBase):
            raise ParseError("division by a matrix")
        if getattr(num, "is_Integer", False) and getattr(den, "is_Integer", False) and den != 0 \
                and sp.igcd(int(num), int(den)) == 1:
            return sp.Rational(int(num), int(den))      # \frac{1}{2} is a literal, not a computation
        return num / den

    # -- calculus
    def d_marker(self):
        """d, \\mathrm{d} or \\partial, with an optional ^n; returns (kind, order) or None."""
        tk = self.peek()
        if tk.is_("let", "d"):
            self.next()
            kind = "d"
        elif tk.is_("cmd", "partial"):
            self.next()
            kind = "partial"
        elif tk.kind == "cmd" and tk.val in ("mathrm", "operatorname", "mathit") and self.at("sym", "{", 1) \
                and self.at("let", "d", 2) and self.at("sym", "}", 3):
            self.i += 4
            kind = "d"
        else:
            return None
        order = 1
        if self.at("sym", "^"):
            self.next()
            o = self.script()
            if not (getattr(o, "is_Integer", False) and 1 <= int(o) <= 10):
                raise ParseError("bad derivative order")
            order = int(o)
        return kind, order

    def derivative(self):
        """\\frac{d}{dx} f, \\frac{d^2}{dx^2} f, \\frac{\\partial^2}{\\partial x \\partial y} f, \\frac{d(x^2)}{dx}."""
        if not self.at("sym", "{"):
            return None
        self.next()
        mk = self.d_marker()
        if mk is None:
            return None
        operand = None
        if not self.at("sym", "}"):
            operand = self.grouped("sym", "}")
        else:
            self.next()
        self.expect("sym", "{")
        vars_, total = [], 0
        while not self.at("sym", "}"):
            m = self.d_marker()
            if m is None:
                raise ParseError("not a derivative")
            tk = self.next()
            if tk.kind == "let":
                v = self.symbol(tk.val)
            elif tk.kind == "cmd" and tk.val in GREEK:
                v = self.symbol(tk.val)
            else:
                raise ParseError("bad derivative variable")
            n = 1
            if self.at("sym", "^"):
                self.next()
                o = self.script()
                if not (getattr(o, "is_Integer", False) and 1 <= int(o) <= 10):
                    raise ParseError("bad derivative order")
                n = int(o)
            vars_.append((v, n))
            total += n
        self.next()
        if not vars_ or total != mk[1]:
            raise ParseError("derivative orders don't match")
        if operand is None:
            operand = self.derivative_operand()      # d/dx applies to the rest, up to the next d/dx
        if isinstance(operand, sp.Symbol) and all(operand != v for v, _ in vars_):
            raise Refuse("dy/dx of an unknown function")
        self.check_indexed(operand, [v for v, _ in vars_])
        self.flags.add("calculus")
        return sp.Derivative(operand, *vars_)

    def starts_derivative(self, k=0):
        """Tokens at offset k open an operator-form derivative: \\frac{d}{dx}, \\frac{\\partial^2}{…}."""
        if not (self.at("cmd", "frac", k) and self.at("sym", "{", k + 1)):
            return False
        j = k + 2
        if self.at("let", "d", j) or self.at("cmd", "partial", j):
            j += 1
        elif self.peek(j).kind == "cmd" and self.peek(j).val in ROMAN and self.at("let", "d", j + 2):
            j += 4
        else:
            return False
        return self.at("sym", "}", j) or self.at("sym", "^", j)

    def derivative_operand(self):
        frame = self.top()
        node = self.term()
        while not self.closed(frame):
            tk = self.peek()
            if (tk.is_("sym", "+") or tk.is_("sym", "-")) and not self.starts_derivative(1):
                self.next()
                node = node + self.term() if tk.val == "+" else node - self.term()
            else:
                break
        return node

    def check_indexed(self, expr, variables):
        """Refuse x_t under d/dt, \\int … dt or \\lim_{t→…}: a plain symbol x_t wouldn't depend on t."""
        names = {v.name for v in variables}
        for s_ in getattr(expr, "free_symbols", ()):
            if "_" in s_.name:
                sub = s_.name.split("_", 1)[1]
                letters = set(re.sub(r"\\[A-Za-z]+", "", sub))
                if any((len(n) == 1 and n in letters) or ("\\" + n) in sub for n in names):
                    raise Refuse(f"{s_.name} is indexed by {names}")

    def bounds(self):
        lo = hi = None
        for _ in range(2):
            if self.at("sym", "_") and lo is None:
                self.next()
                lo = self.script()
            elif self.at("sym", "^") and hi is None:
                self.next()
                hi = self.script()
        return lo, hi

    def integral(self):
        lo, hi = self.bounds()
        if (lo is None) != (hi is None):
            raise ParseError("an integral needs both bounds or none")
        frame = Frame("int")
        self.frames.append(frame)
        try:
            body = self.expr()
        finally:
            self.frames.pop()
        var = frame.var
        if var is None:
            free = sorted(body.free_symbols, key=lambda s: s.name) if hasattr(body, "free_symbols") else []
            if len(free) != 1:
                raise ParseError("no differential")
            var = free[0]
        self.check_indexed(body, [var])
        self.flags.add("calculus")
        if lo is None:
            self.flags.add("indefinite")
            return sp.Integral(body, var)
        return sp.Integral(body, (var, lo, hi))

    def bigop(self, kind):
        if not self.at("sym", "_"):
            raise ParseError("a sum needs an index")
        self.next()
        self.expect("sym", "{")
        tk = self.next()
        if tk.kind == "let" or (tk.kind == "cmd" and tk.val in GREEK):
            var = self.symbol(tk.val)
        else:
            raise ParseError("bad index")
        self.expect("sym", "=")
        self.bound.append(var.name)
        try:
            lo = self.grouped("sym", "}")
            if not self.at("sym", "^"):
                raise ParseError("a sum needs an upper bound")
            self.next()
            hi = self.script()
            body = self.term()                      # \sum_k a_k + b is (\sum a_k) + b
        finally:
            self.bound.pop()
        self.flags.add("calculus")
        return (sp.Sum if kind == "sum" else sp.Product)(body, (var, lo, hi))

    def limit(self):
        self.expect("sym", "_")
        self.expect("sym", "{")
        tk = self.next()
        if tk.kind == "let" or (tk.kind == "cmd" and tk.val in GREEK):
            var = self.symbol(tk.val)
        else:
            raise ParseError("bad limit variable")
        self.expect("cmd", "to")
        self.limit_point += 1
        self.limit_dir = None
        try:
            point = self.grouped("sym", "}")
        finally:
            self.limit_point -= 1
        direction = {"+": "+", "-": "-"}.get(self.limit_dir or "", "+-")
        if point in (sp.oo, -sp.oo):
            direction = "-" if point == sp.oo else "+"
        body = self.expr()                          # lim applies to the rest of the expression
        self.check_indexed(body, [var])
        self.flags.add("calculus")
        return sp.Limit(body, var, point, dir=direction)

    # -- functions
    def function_arg(self):
        tk = self.peek()
        if tk.is_("sym", "("):
            self.next()
            return self.grouped("sym", ")")
        if tk.is_("sym", "{"):
            self.next()
            return self.grouped("sym", "}")
        if tk.is_("sym", "["):
            self.next()
            return self.grouped("sym", "]")
        # \sin 2x, \sin x^2, \ln \frac{a}{b}: a run of factors up to an operator or another function
        node = self.postfix(self.primary())
        while not self.at_differential():
            tk = self.peek()
            if tk.kind == "let" or (tk.kind == "cmd" and (tk.val in GREEK or tk.val in ("pi", "infty") or tk.val in DECORATIONS)):
                node = node * self.postfix(self.primary())
            else:
                break
        return node

    def apply(self, fname, arg):
        if isinstance(arg, sp.MatrixBase):
            self.flags.add("matrix-op")
            if fname == "trace":
                return arg.trace()
            if fname == "rank":
                return sp.Integer(arg.rank())
            raise ParseError("function of a matrix")
        if fname == "rank":
            raise ParseError("rank needs a matrix")
        return getattr(sp, fname)(arg)

    def function(self, name):
        base = power = None
        for _ in range(2):                           # \log_2^3 x or \log^3_2 x
            if name == "log" and base is None and self.at("sym", "_"):
                self.next()
                base = self.script()
            elif power is None and self.at("sym", "^"):
                self.next()
                power = self.script()
        if power is not None and power == -1 and name in INVERSE:
            return getattr(sp, INVERSE[name])(self.function_arg())     # \sin^{-1} x
        arg = self.function_arg()
        if name == "log":
            f = sp.log(arg, base) if base is not None else sp.log(arg)
        elif name == "lg":
            f = sp.log(arg, 10)
        else:
            f = self.apply(FUNCS[name], arg)
        return f if power is None else f ** power

    def multi(self, fname):
        self.expect("sym", "(")
        args = []
        self.frames.append(Frame("group"))
        try:
            while True:
                args.append(self.expr())
                if self.at("sym", ","):
                    self.next()
                    continue
                break
        finally:
            self.frames.pop()
        self.expect("sym", ")")
        if fname in ("gcd", "lcm"):
            out = args[0]
            for a in args[1:]:
                out = getattr(sp, fname)(out, a)
            return out
        return getattr(sp, fname)(*args)

    def environment(self):
        name = self.raw_group().replace(" ", "")
        if name not in MATRIX_ENVS:
            raise ParseError(f"environment {name}")
        if name == "array":
            self.raw_group()                         # the column spec
        rows, row = [], []
        self.frames.append(Frame("group"))
        try:
            while True:
                if self.at("cmd", "end"):
                    self.next()
                    if self.raw_group().replace(" ", "") != name:
                        raise ParseError("mismatched \\end")
                    break
                row.append(self.expr())
                if self.at("sym", "&"):
                    self.next()
                elif self.at("cmd", "\\"):
                    self.next()
                    rows.append(row)
                    row = []
                elif not self.at("cmd", "end"):
                    raise ParseError(f"unexpected {self.peek()} in a matrix")
        finally:
            self.frames.pop()
        if row:
            rows.append(row)
        if not rows or any(len(r) != len(rows[0]) for r in rows):
            raise ParseError("ragged matrix")
        m = sp.Matrix(rows)
        if name == "vmatrix":
            if m.rows != m.cols:
                raise ParseError("determinant of a non-square matrix")
            self.flags.add("matrix-op")
            return m.det()
        self.env = name if name in ("pmatrix", "bmatrix", "Bmatrix", "matrix") else "pmatrix"
        return m


# ---------------------------------------------------------------------------------------------
# Probability and statistics
# ---------------------------------------------------------------------------------------------

STAT_EXACT = 2000              # exact sums up to this many terms; bigger discrete laws go numeric
EXACT_DIGITS = 2500            # ... and while the exact rationals stay under about this many digits


def _small(x, power):
    """x^power stays a modest exact rational (0.3^2000 does; 0.123456^2000 doesn't)."""
    import math
    x = sp.sympify(x)
    return bool(x.is_Rational) and power * math.log10(max(int(x.q), 2)) <= EXACT_DIGITS


def _mpmath():
    import mpmath
    return mpmath.mp


def _mpf(x):
    return _mpmath().mpf(str(sp.N(x, 40)))


def _mp_float(fn):
    mp = _mpmath()
    with mp.workdps(40):
        return sp.Float(mp.nstr(fn(mp), 35), 35)


def _betainc(mp, a, b, x):
    """The regularized incomplete beta I_x(a, b), by its continued fraction (Numerical Recipes
    betacf). Unlike mpmath's betainc it converges for large a and b (a binomial with n = 10^6)."""
    if x <= 0:
        return mp.mpf(0)
    if x >= 1:
        return mp.mpf(1)
    if x > (a + 1) / (a + b + 2):
        return 1 - _betainc(mp, b, a, 1 - x)
    tiny = mp.mpf(10) ** (-(mp.dps + 30))
    qab, qap, qam = a + b, a + 1, a - 1
    c, d = mp.mpf(1), 1 - qab * x / qap
    d = 1 / (d if abs(d) > tiny else tiny)
    h = d
    for m in range(1, 200000):
        m2 = 2 * m
        for aa in (m * (b - m) * x / ((qam + m2) * (a + m2)), -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))):
            d = 1 + aa * d
            d = 1 / (d if abs(d) > tiny else tiny)
            c = 1 + aa / c
            c = c if abs(c) > tiny else tiny
            h *= d * c
        if abs(d * c - 1) < mp.eps * 4:
            break
    front = mp.exp(mp.loggamma(a + b) - mp.loggamma(a) - mp.loggamma(b) + a * mp.log(x) + b * mp.log(1 - x))
    return front * h / a


def _t_cdf(mp, x, nu):
    if x == 0:
        return mp.mpf(1) / 2
    tail = _betainc(mp, nu / 2, mp.mpf(1) / 2, nu / (nu + x * x)) / 2
    return 1 - tail if x > 0 else tail


def _truth(rel):
    if rel in (sp.true, True):
        return True
    if rel in (sp.false, False):
        return False
    raise Refuse("can't tell where the bound lies")


def _nice(x):
    """A parameter for a note: 0.3 rather than 3/10."""
    x = sp.sympify(x)
    if x.is_Rational:
        d = _rational_decimal(x)
        if d is not None and len(d) <= 12:
            return d
    return to_latex(x)


def _vector(m):
    if isinstance(m, sp.MatrixBase) and 1 in m.shape:
        return list(m)
    return None


def _relation(op, a, b):
    if isinstance(a, sp.MatrixBase) or isinstance(b, sp.MatrixBase):
        raise ParseError("a relation between matrices")
    return {"lt": sp.Lt, "le": sp.Le, "gt": sp.Gt, "ge": sp.Ge, "eq": sp.Eq, "ne": sp.Ne}[op](a, b)


class Dist:
    """A distribution declared in the document (X \\sim N(0, 1)): its CDF, moments and quantiles.

    Conventions (each shown in the result's note): N(mean, variance), Exp(rate), Geom(p) counts
    trials 1, 2, …, U(a, b) is continuous."""

    DISCRETE = {"binomial", "poisson", "bernoulli", "geometric"}
    SCALE = {"normal": [1], "poisson": [0], "exponential": [0], "t": [0], "chi2": [0], "f": [0, 1], "beta": [0, 1]}

    def __init__(self, kind, params, check=True):
        self.kind = kind
        params = [sp.sympify(a) for a in params]
        self.pos_map = {}                       # σ in N(μ, σ²) is positive, so sd = σ
        for j in self.SCALE.get(kind, []):
            for s_ in params[j].free_symbols:
                self.pos_map[s_] = sp.Symbol(s_.name, positive=True)
        self.params = [a.xreplace(self.pos_map) for a in params]
        self.discrete = kind in self.DISCRETE
        if check:
            self.check()

    def check(self):
        a, k = self.params, self.kind

        def num(x):
            return x.is_number and x.is_real

        if any(x.has(sp.I, sp.zoo, sp.nan) for x in a):
            raise ParseError("complex parameters")
        ok = True
        if k == "normal":
            ok = not num(a[1]) or a[1] > 0
        elif k == "binomial":
            ok = (not num(a[0]) or (a[0].is_integer and a[0] >= 0)) and (not num(a[1]) or 0 <= a[1] <= 1)
        elif k in ("poisson", "exponential", "t", "chi2"):
            ok = not num(a[0]) or a[0] > 0
        elif k == "uniform":
            ok = not (num(a[0]) and num(a[1])) or a[0] < a[1]
        elif k == "bernoulli":
            ok = not num(a[0]) or 0 <= a[0] <= 1
        elif k == "geometric":
            ok = not num(a[0]) or 0 < a[0] <= 1
        elif k in ("f", "beta"):
            ok = all(not num(x) or x > 0 for x in a)
        if not ok:
            raise ParseError(f"invalid parameters for {k}")

    def describe(self, name):
        n = f"${to_latex(sp.Symbol(name))}$"
        a = [_nice(x) for x in self.params]
        k = self.kind

        def eq(label, v):                        # "$p = 0.3$", or just "$p$" when p is symbolic
            return f"${label}$" if v == label else f"${label} = {v}$"

        if k == "normal":
            return f"{n} normal, mean ${a[0]}$, sd ${_nice(sp.sqrt(self.params[1]))}$"
        if k == "binomial":
            return f"{n} binomial, {eq('n', a[0])}, {eq('p', a[1])}"
        if k == "poisson":
            return f"{n} Poisson, mean ${a[0]}$"
        if k == "exponential":
            return f"{n} exponential, rate ${a[0]}$ (mean ${_nice(1 / self.params[0])}$)"
        if k == "uniform":
            return f"{n} continuous uniform on $[{a[0]}, {a[1]}]$"
        if k == "bernoulli":
            return f"{n} Bernoulli, {eq('p', a[0])}"
        if k == "geometric":
            return f"{n} geometric, {eq('p', a[0])}, counting trials $1, 2, \\dots$"
        if k == "t":
            return f"{n} Student $t$, ${a[0]}$ df"
        if k == "chi2":
            return f"{n} chi-squared, ${a[0]}$ df"
        if k == "f":
            return f"{n} $F$, ${a[0]}$ and ${a[1]}$ df"
        return f"{n} beta, {eq('a', a[0])}, {eq('b', a[1])}"

    def need_numbers(self):
        if not all(x.is_number for x in self.params):
            raise Refuse("probabilities need numeric parameters")

    # -- moments
    def moment(self, k):
        """E[X^k]."""
        a, kind = self.params, self.kind
        if k == 0:
            return sp.Integer(1)
        t = sp.Dummy("t")
        if kind == "normal":
            mgf = sp.exp(a[0] * t + a[1] * t ** 2 / 2)
        elif kind == "binomial":
            mgf = (1 - a[1] + a[1] * sp.exp(t)) ** a[0]
        elif kind == "poisson":
            mgf = sp.exp(a[0] * (sp.exp(t) - 1))
        elif kind == "geometric":
            mgf = a[0] * sp.exp(t) / (1 - (1 - a[0]) * sp.exp(t))
        elif kind == "bernoulli":
            return a[0]
        elif kind == "exponential":
            return sp.factorial(k) / a[0] ** k
        elif kind == "uniform":
            return (a[1] ** (k + 1) - a[0] ** (k + 1)) / ((k + 1) * (a[1] - a[0]))
        elif kind == "beta":
            return sp.Mul(*[(a[0] + r) / (a[0] + a[1] + r) for r in range(k)])
        elif kind == "chi2":
            return sp.Mul(*[a[0] + 2 * r for r in range(k)])
        elif kind == "t":
            nu = a[0]
            if nu.is_number and k >= nu:
                raise Refuse("that moment of the t distribution doesn't exist")
            if k % 2:
                return sp.Integer(0)
            return nu ** (k // 2) * sp.Mul(*[sp.Integer(2 * j - 1) / (nu - 2 * j) for j in range(1, k // 2 + 1)])
        else:                                     # f
            d1, d2 = a
            if d2.is_number and 2 * k >= d2:
                raise Refuse("that moment of the F distribution doesn't exist")
            return (d2 / d1) ** k * sp.rf(d1 / 2, k) / sp.Mul(*[d2 / 2 - j for j in range(1, k + 1)])
        return sp.simplify(sp.diff(mgf, t, k).subs(t, 0))

    # -- probabilities
    def cdf(self, x):
        """P(X <= x) for a number x or ±oo (an integer for discrete laws)."""
        if x == sp.oo:
            return sp.Integer(1)
        if x == -sp.oo:
            return sp.Integer(0)
        a, k = self.params, self.kind
        if k == "normal":
            return (1 + sp.erf((x - a[0]) / sp.sqrt(2 * a[1]))) / 2
        if k == "exponential":
            return sp.Integer(0) if _truth(x <= 0) else 1 - sp.exp(-a[0] * x)
        if k == "uniform":
            if _truth(x <= a[0]):
                return sp.Integer(0)
            if _truth(x >= a[1]):
                return sp.Integer(1)
            return (x - a[0]) / (a[1] - a[0])
        self.need_numbers()
        if not x.is_number:
            raise Refuse("a symbolic bound")
        if k == "binomial":
            n, p = int(a[0]), a[1]
            if x < 0:
                return sp.Integer(0)
            if x >= n:
                return sp.Integer(1)
            x = int(x)
            if n <= STAT_EXACT and _small(p, n):
                return sp.Add(*[sp.binomial(n, j) * p ** j * (1 - p) ** (n - j) for j in range(x + 1)])
            return _mp_float(lambda mp: _betainc(mp, mp.mpf(n - x), mp.mpf(x + 1), 1 - _mpf(p)))
        if k == "poisson":
            lam = a[0]
            if x < 0:
                return sp.Integer(0)
            x = int(x)
            if x <= 200 and _small(lam, x):
                return sp.exp(-lam) * sp.Add(*[lam ** j / sp.factorial(j) for j in range(x + 1)])
            return _mp_float(lambda mp: mp.gammainc(x + 1, _mpf(lam), mp.inf, regularized=True))
        if k == "bernoulli":
            return sp.Integer(0) if x < 0 else (1 - a[0] if x < 1 else sp.Integer(1))
        if k == "geometric":
            if x < 1:
                return sp.Integer(0)
            x = int(x)
            if x <= STAT_EXACT and _small(a[0], x):
                return 1 - (1 - a[0]) ** x
            return _mp_float(lambda mp: 1 - (1 - _mpf(a[0])) ** x)
        if k == "beta":
            if x <= 0:
                return sp.Integer(0)
            if x >= 1:
                return sp.Integer(1)
            if a[0].is_Integer and a[1].is_Integer and a[0] + a[1] <= STAT_EXACT and _small(x, int(a[0] + a[1])):
                m = int(a[0] + a[1] - 1)
                return sp.Add(*[sp.binomial(m, j) * x ** j * (1 - x) ** (m - j) for j in range(int(a[0]), m + 1)])
        if k in ("chi2", "f") and x <= 0:
            return sp.Integer(0)
        return _mp_float(lambda mp: self._cdf_mp(mp, _mpf(x)))

    def _cdf_mp(self, mp, x):
        a = [_mpf(p) for p in self.params]
        if self.kind == "t":
            return _t_cdf(mp, x, a[0])
        if x <= 0:
            return mp.mpf(0)
        if self.kind == "chi2":
            return mp.gammainc(a[0] / 2, 0, x / 2, regularized=True)
        if self.kind == "f":
            return _betainc(mp, a[0] / 2, a[1] / 2, a[0] * x / (a[0] * x + a[1]))
        if self.kind == "beta":
            return _betainc(mp, a[0], a[1], x)
        raise Refuse("no numeric CDF")

    def upper_quantile(self, alpha):
        """x with P(X > x) = alpha (t, chi-squared and F critical values)."""
        self.need_numbers()
        mp = _mpmath()
        with mp.workdps(40):
            target = 1 - _mpf(alpha)
            lo, hi = (mp.mpf(-1), mp.mpf(1)) if self.kind == "t" else (mp.mpf(0), mp.mpf(1))
            for _ in range(200):
                if self._cdf_mp(mp, hi) >= target:
                    break
                lo, hi = (lo, hi * 2) if self.kind != "t" else (lo, hi * 2)
            for _ in range(200):
                if self.kind != "t" or self._cdf_mp(mp, lo) <= target:
                    break
                lo *= 2
            for _ in range(120):
                mid = (lo + hi) / 2
                if self._cdf_mp(mp, mid) < target:
                    lo = mid
                else:
                    hi = mid
            return sp.Float(mp.nstr((lo + hi) / 2, 30), 30)

    def pmf(self, k):
        a, kind = self.params, self.kind
        k = int(k)
        if kind == "binomial":
            n, p = int(a[0]), a[1]
            if not 0 <= k <= n:
                return sp.Integer(0)
            if n <= STAT_EXACT and _small(p, n):
                return sp.binomial(n, k) * p ** k * (1 - p) ** (n - k)
            return _mp_float(lambda mp: mp.binomial(n, k) * _mpf(p) ** k * (1 - _mpf(p)) ** (n - k))
        if kind == "poisson":
            if k < 0:
                return sp.Integer(0)
            if k <= STAT_EXACT and _small(a[0], k):
                return sp.exp(-a[0]) * a[0] ** k / sp.factorial(k)
            return _mp_float(lambda mp: mp.exp(-_mpf(a[0])) * _mpf(a[0]) ** k / mp.factorial(k))
        if kind == "bernoulli":
            return a[0] if k == 1 else (1 - a[0] if k == 0 else sp.Integer(0))
        if k < 1:
            return sp.Integer(0)
        if k <= STAT_EXACT and _small(a[0], k):
            return (1 - a[0]) ** (k - 1) * a[0]
        return _mp_float(lambda mp: (1 - _mpf(a[0])) ** (k - 1) * _mpf(a[0]))

    def interval(self, lo, hi, lopen, ropen):
        if not self.discrete:
            return self.cdf(hi) - self.cdf(lo)
        self.need_numbers()
        if not (lo.is_number or lo == -sp.oo) or not (hi.is_number or hi == sp.oo):
            raise Refuse("a symbolic bound")
        klo = -sp.oo if lo == -sp.oo else (sp.floor(lo) + 1 if lopen else sp.ceiling(lo))
        khi = sp.oo if hi == sp.oo else (sp.ceiling(hi) - 1 if ropen else sp.floor(hi))
        if klo != -sp.oo and khi != sp.oo and khi < klo:
            return sp.Integer(0)
        return self.cdf(khi) - self.cdf(klo - 1)

    def measure(self, s_):
        total = sp.Integer(0)
        for piece in _pieces(s_):
            if piece[0] == "pt":
                if self.discrete:
                    v = piece[1]
                    self.need_numbers()
                    if not v.is_number:
                        raise Refuse("a symbolic point")
                    if v.is_integer:
                        total += self.pmf(v)
            else:
                total += self.interval(*piece[1:])
        return total


def _pieces(s_):
    if s_ is sp.S.EmptySet:
        return []
    if s_ == sp.S.Reals:
        return [("iv", -sp.oo, sp.oo, True, True)]
    if isinstance(s_, sp.Union):
        return [p for a in s_.args for p in _pieces(a)]
    if isinstance(s_, sp.Interval):
        return [("iv", s_.start, s_.end, s_.left_open, s_.right_open)]
    if isinstance(s_, sp.FiniteSet):
        return [("pt", v) for v in s_]
    raise Refuse("an event that isn't a union of intervals")


def event_set(cond, x):
    """The values of the random variable x where cond holds."""
    if cond in (sp.true, True):
        return sp.S.Reals
    if cond in (sp.false, False):
        return sp.S.EmptySet
    if isinstance(cond, sp.And):
        return sp.Intersection(*[event_set(a, x) for a in cond.args])
    if isinstance(cond, sp.Or):
        return sp.Union(*[event_set(a, x) for a in cond.args])
    if isinstance(cond, sp.Not):
        return sp.Complement(sp.S.Reals, event_set(cond.args[0], x))
    if isinstance(cond, sp.core.relational.Relational):
        if x not in cond.free_symbols:
            raise Refuse("a condition without the random variable")
        s_ = step(lambda: sp.solveset(cond, x, sp.S.Reals))
        if s_ is None or s_.has(sp.ConditionSet) or isinstance(s_, sp.ConditionSet) or s_.has(sp.ImageSet):
            raise Refuse("can't solve the event")
        return s_
    raise Refuse("unsupported event")


def reduce_normals(ev, given, pairs):
    """Events about a linear combination of independent normals (X - Y > 0) are about one normal."""
    if any(d.kind != "normal" for _, d in pairs):
        raise Refuse("events of several variables are only computed for normal ones")
    syms = [s_ for s_, _ in pairs]
    rels = set()
    for c in (ev, given):
        if c is not None:
            rels |= c.atoms(sp.core.relational.Relational)
    w = sp.Dummy("W")
    base, mapping = None, {}
    for r in rels:
        d = sp.expand(r.lhs - r.rhs)
        coeffs = [d.coeff(s_) for s_ in syms]
        rest = sp.expand(d - sum(c * s_ for c, s_ in zip(coeffs, syms)))
        if rest.free_symbols & set(syms) or any(not c.is_number for c in coeffs):
            raise Refuse("not a linear combination")
        if all(c == 0 for c in coeffs):
            raise Refuse("a condition without the random variables")
        if base is None:
            base, k = coeffs, sp.Integer(1)
        else:
            j = next(i for i, c in enumerate(base) if c != 0)
            k = coeffs[j] / base[j]
            if any(sp.simplify(c - k * b) != 0 for c, b in zip(coeffs, base)):
                raise Refuse("different combinations of the variables")
        mapping[r] = r.func(k * w + rest, 0)
    if base is None:
        raise Refuse("no relation")
    mean = sp.Add(*[c * d.params[0] for c, (_, d) in zip(base, pairs)])
    var = sp.Add(*[c ** 2 * d.params[1] for c, (_, d) in zip(base, pairs)])
    dist = Dist("normal", [mean, var], check=False)
    return dist, w, ev.xreplace(mapping), (given.xreplace(mapping) if given is not None else None)


def prob_value(ev, given, parser):
    conds = [c for c in (ev, given) if c is not None]
    names = [n for n in parser.used if any(sp.Symbol(n) in getattr(c, "free_symbols", ()) for c in conds)]
    if not names:
        raise Refuse("no declared random variable in the event")
    pmap = {}
    for n in names:
        pmap.update(parser.used[n].pos_map)
    conds = [c.xreplace(pmap) for c in conds]
    # Other names (mu in N(mu, sigma^2)) are real numbers: X > mu is then an interval.
    free = set().union(*[c.free_symbols for c in conds], *[p.free_symbols for n in names for p in parser.used[n].params])
    rmap = {s_: sp.Symbol(s_.name, real=True) for s_ in free if s_.name not in names and not s_.is_real}
    conds = [c.xreplace(rmap) for c in conds]
    ev, given = conds[0], (conds[1] if given is not None else None)
    dists = {n: Dist(parser.used[n].kind, [p.xreplace(rmap) for p in parser.used[n].params], check=False) for n in names}
    if len(names) == 1:
        dist, x = dists[names[0]], sp.Symbol(names[0])
    else:
        dist, x, ev, given = reduce_normals(ev, given, [(sp.Symbol(n), dists[n]) for n in names])
        parser.note(", ".join(f"${to_latex(sp.Symbol(n))}$" for n in names) + " independent")
    a = event_set(ev, x)
    if given is None:
        return dist.measure(a)
    b = event_set(given, x)
    pb = dist.measure(b)
    if pb == 0:
        raise Refuse("conditioning on an event of probability 0")
    return dist.measure(sp.Intersection(a, b)) / pb


def expect_value(g, parser):
    """E[g] for a polynomial g of declared random variables (independent ones, if several)."""
    if isinstance(g, sp.MatrixBase):
        raise ParseError("the expectation of a matrix")
    g = sp.sympify(g)
    names = parser.rv_names(g)
    if not names:
        raise Refuse("no declared random variable")
    if len(names) > 1:
        parser.note(", ".join(f"${to_latex(sp.Symbol(n))}$" for n in names) + " independent")
    pmap = {}
    for n in names:
        pmap.update(parser.used[n].pos_map)
    g = g.xreplace(pmap)
    syms = [sp.Symbol(n) for n in names]
    try:
        poly = sp.Poly(sp.expand(g), *syms)
    except sp.PolynomialError:
        raise Refuse("only polynomials of random variables") from None
    if poly.total_degree() > 12:
        raise Refuse("too high a moment")
    total = sp.Integer(0)
    for monom, coeff in poly.terms():
        term = coeff
        for s_, k in zip(syms, monom):
            if k:
                term *= parser.used[s_.name].moment(k)
        total += term
    return total


def variance_value(g, parser):
    return expect_value(sp.expand(g ** 2), parser) - expect_value(g, parser) ** 2


def _one_name(toks):
    try:
        e = Parser(list(toks)).parse()
    except Exception:  # noqa: BLE001 - not a name
        return None
    return e.name if isinstance(e, sp.Symbol) else None


def _decl_names(text):
    """The names just before \\sim: "Let X" -> [X], "X, Y" -> [X, Y], "X_1, \\dots, X_n" -> [X_n]."""
    toks = tokenize(text)
    names, end = [], len(toks)
    while end > 0 and len(names) < 8:
        found = None
        for n in range(min(8, end), 0, -1):
            nm = _one_name(toks[end - n:end])
            if nm:
                found = (nm, n)
                break
        if not found:
            break
        names.insert(0, found[0])
        end -= found[1]
        if end > 0 and toks[end - 1].is_("sym", ","):
            end -= 1
            continue
        break
    return names


def parse_decls(items):
    """{"name": "Let X", "dist": "N(100, 15^2), …"} pairs (the text either side of \\sim) -> {name: Dist}.
    Later declarations win. A name declared with something texc can't read maps to None, which blocks
    it (and the Z default): its older declaration no longer applies."""
    out = {}
    if not isinstance(items, list):
        return out
    for it in items[-MAX_DECLS:]:
        if not isinstance(it, dict) or not isinstance(it.get("name"), str) or not isinstance(it.get("dist"), str):
            continue
        try:
            names = _decl_names(it["name"][-120:])
        except Exception:  # noqa: BLE001 - not a name
            continue
        if not names:
            continue
        try:
            dist = Parser(tokenize(it["dist"][:300])).dist_spec()
        except Timeout:
            raise
        except Exception:  # noqa: BLE001 - X \\sim something texc can't read: X has no known law now
            dist = None
        for name in names:
            out[name] = dist
    return out


# ---------------------------------------------------------------------------------------------
# Evaluation and output
# ---------------------------------------------------------------------------------------------

_deadlines: list = []          # absolute time.monotonic() deadlines, innermost last


def _fire(*_):
    raise Timeout()


def _arm(seconds):
    signal.setitimer(signal.ITIMER_REAL, max(0.001, seconds))


class deadline:
    """Raise Timeout when the block runs past `seconds`, or past an enclosing deadline.

    SIGALRM, so the main thread only; elsewhere (tests importing this module) it does nothing."""

    def __init__(self, seconds):
        self.seconds = seconds
        self.armed = False

    def __enter__(self):
        try:
            if not _deadlines:
                self.prev = signal.signal(signal.SIGALRM, _fire)
            now = time.monotonic()
            end = now + self.seconds
            if _deadlines:
                end = min(end, _deadlines[-1])
            _deadlines.append(end)
            self.armed = True
            _arm(end - now)
        except (ValueError, AttributeError):         # not the main thread / no SIGALRM
            pass
        return self

    def __exit__(self, *exc):
        if self.armed:
            _deadlines.pop()
            if _deadlines:                            # the enclosing deadline takes over again
                _arm(_deadlines[-1] - time.monotonic())
            else:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, self.prev)
        return False


def step(fn, *args, fallback=None, seconds=STEP_SECONDS):
    try:
        with deadline(seconds):
            return fn(*args)
    except Timeout:
        return fallback
    except Exception:  # noqa: BLE001 - SymPy raises many kinds of errors; a failed step just skips
        return fallback


def leaves(e) -> Counter:
    """Leaves and non-arithmetic operators, ignoring order and Add/Mul grouping."""
    c = Counter()
    for node in sp.preorder_traversal(e):
        if not node.args:
            c[sp.srepr(node)] += 1
        elif not isinstance(node, (sp.Add, sp.Mul)):
            c["<" + type(node).__name__ + ">"] += 1
    return c


def norm(s: str) -> str:
    s = re.sub(r"\\(?:left|right|[bB]igg?[lr]?)(?![A-Za-z])\.?", "", s)
    s = re.sub(r"\\(?:[,;:! ]|quad|qquad|displaystyle|cdot|times)(?![A-Za-z])|\*", "", s)
    s = re.sub(r"\\[dt]frac", r"\\frac", s)
    s = re.sub(r"\s+", "", s)
    return s.replace("{", "").replace("}", "")


TALL = re.compile(r"\\(?:frac|sum|int|prod|lim|begin|binom|dfrac)")


def _match_right(s, i):
    """i is just past a \\left( ; return the index of its \\right), or -1."""
    depth = 0
    while i < len(s):
        if s.startswith("\\left", i):
            depth += 1
            i += 5
        elif s.startswith("\\right", i):
            if depth == 0:
                return i
            depth -= 1
            i += 6
        else:
            i += 1
    return -1


def tidy(s: str) -> str:
    """SymPy's \\sin{\\left(x \\right)} -> \\sin(x), \\left|{x}\\right| -> |x| when nothing tall is inside."""
    out, i = [], 0
    while i < len(s):
        braced = s.startswith("{\\left(", i)
        if braced or s.startswith("\\left(", i):
            start = i + (7 if braced else 6)
            j = _match_right(s, start)
            if j >= 0 and s.startswith("\\right)", j):
                inner = s[start:j].strip()
                end = j + 7
                if braced and s.startswith("}", end):
                    end += 1
                else:
                    braced = False
                if not TALL.search(inner):
                    out.append("(" + tidy(inner) + ")")
                    i = end
                    continue
                out.append(("{" if braced else "") + "\\left(" + tidy(inner) + " \\right)" + ("}" if braced else ""))
                i = end
                continue
        if s.startswith("\\left|{", i):
            j = s.find("}\\right|", i)
            inner = s[i + 7:j] if j >= 0 else ""
            if j >= 0 and "\\left|" not in inner and not TALL.search(inner):
                out.append("|" + tidy(inner) + "|")
                i = j + 8
                continue
        out.append(s[i])
        i += 1
    return "".join(out)


def to_latex(e, env=None) -> str:
    opts = dict(ln_notation=True, inv_trig_style="full", imaginary_unit="i")
    if isinstance(e, sp.MatrixBase):
        opts.update(mat_str=env or "pmatrix", mat_delim="")
    return tidy(sp.latex(e, **opts))


def decimal(x, digits=10):
    """(latex, exact) for a number: exact when the decimal shown is the number itself."""
    if x.is_Rational:
        d = _rational_decimal(x)
        if d is not None and len(d.replace("-", "").replace(".", "")) <= 15:
            return d, True
    re0, im0 = (step(lambda: sp.re(x)), step(lambda: sp.im(x))) if not x.is_real else (x, 0)
    if im0 != 0 and getattr(re0, "is_Rational", False) and getattr(im0, "is_Rational", False):
        r, i = _rational_decimal(re0), _rational_decimal(im0)      # a Gaussian rational: 2 + 0.5 i
        if r is not None and i is not None:
            i = "" if i == "1" else "-" if i == "-1" else i + " "
            if re0 == 0:
                return f"{i}i".replace(" i", " i"), True
            return f"{r} {'-' if i.startswith('-') else '+'} {i.lstrip('-')}i", True
    v = step(lambda: sp.N(x, digits + 5))
    if v is None or not v.is_number:
        return None, False
    re_, im_ = (v, sp.Integer(0)) if v.is_real else (sp.re(v), sp.im(v))
    try:
        r, i = _fmt(re_, digits), _fmt(im_, digits)
    except (TypeError, ValueError, AttributeError):
        return None, False
    exact = bool(x.is_Rational) and im_ == 0 and _value(r) == x
    if im_ == 0:
        return r, exact
    if re_ == 0:
        return (i + " i" if i not in ("1", "-1") else ("i" if i == "1" else "-i")), False
    return f"{r} {'-' if i.startswith('-') else '+'} {i.lstrip('-')} i", False


def _value(s):
    """The exact value of a formatted decimal ("6.02 \\times 10^{23}")."""
    m = re.fullmatch(r"(-?[\d.]+)(?: \\times 10\^\{(-?\d+)\})?", s)
    if not m or (m.group(2) and abs(int(m.group(2))) > 60):
        return None
    v = sp.Rational(m.group(1))
    return v * sp.Integer(10) ** int(m.group(2)) if m.group(2) else v


def _rational_decimal(x):
    p, q = int(x.p), int(x.q)
    neg = p < 0
    p = abs(p)
    places = 0
    while q != 1 and places < 30:
        if q % 10 == 0:
            q //= 10
        elif q % 2 == 0:
            p *= 5
            q //= 2
        elif q % 5 == 0:
            p *= 2
            q //= 5
        else:
            return None
        places += 1
    s = str(p)
    if places:
        s = s.rjust(places + 1, "0")
        s = s[:-places] + "." + s[-places:]
        s = s.rstrip("0").rstrip(".")
    return ("-" if neg else "") + s


def _fmt(v, digits):
    if v == 0:
        return "0"
    import mpmath
    f = v._to_mpmath(int((digits + 5) * 3.33) + 10)
    s = mpmath.nstr(f, digits, min_fixed=-5, max_fixed=13)
    if "e" in s:
        mant, ex = s.split("e")
        mant = mant[:-2] if mant.endswith(".0") else mant
        return f"{mant} \\times 10^{{{int(ex)}}}"
    return s[:-2] if s.endswith(".0") else s


def is_plain_number(e):
    return isinstance(e, sp.Basic) and bool(e.is_number) and not e.has(sp.zoo, sp.nan, sp.AccumBounds)


def evaluate(expr):
    """(value, note): expr with its integrals, sums, limits and derivatives done, or (None, None).

    A result that only holds under conditions (a Piecewise) is retried with the free symbols
    positive, and kept with a note ("assuming a > 0") if that gives one clean answer."""
    r = step(lambda: expr.doit())
    if r is None:
        return None, None
    note = None
    if r.has(sp.Piecewise):
        params = sorted(expr.free_symbols, key=lambda s: s.name)
        if params:
            pos = {s: sp.Symbol(s.name, positive=True) for s in params}
            r2 = step(lambda: expr.xreplace(pos).doit())
            if r2 is not None and not r2.has(sp.Piecewise):
                r = r2.xreplace({v: k for k, v in pos.items()})
                note = "assuming " + ", ".join(to_latex(s) for s in params) + " > 0"
        if r.has(sp.Piecewise):
            return None, None
    return r, note


def compute(latex: str, budget: float = TOTAL_SECONDS, decls=None, chain=None):
    """The result for the left-hand side `latex`, or None. `decls`: see parse_decls.

    {"latex": shown/inserted LaTeX, "approx": True when it is a rounded decimal (the "=" then
     becomes \\approx), "alt": {"latex", "approx"} or None (the decimal of an exact number),
     "note": e.g. "assuming a > 0", or what a statistics result assumes, with math in $…$; or None}

    `chain`: the earlier sides of a chain of equalities, oldest first (`A = B = C =`: latex C,
    chain [A, B]). The result is still C's. The first earlier side that has a value of its own
    stands for the chain: its value is the result when C is empty or can't be read (the note says
    whose value it is), and when C surely differs from it the note warns. Without `chain` nothing
    changes, and whatever goes wrong in the chain part leaves C's own result."""
    load()
    src = (latex or "").strip()
    sides = [x.strip() for x in chain if isinstance(x, str) and x.strip() and len(x) <= MAX_INPUT // 2] \
        if isinstance(chain, (list, tuple)) else []
    sides = sides[-MAX_CHAIN:]
    if len(src) > MAX_INPUT or not (src or sides):
        return None
    t0 = time.monotonic()
    try:
        with deadline(budget):
            dists = parse_decls(decls) if decls else {}
            if not sides:
                return _compute(src, dists)
            last, state, info = None, "empty", {}
            if src:
                try:
                    last, state = _compute(src, dists, info), "ok"
                except (ParseError, RecursionError):
                    state = "unreadable"
            # The last side's result is in hand; the chain gets what is left of the budget, less
            # a margin so that its own deadline fires first and this request never ends as a timeout.
            left = budget - (time.monotonic() - t0) - CHAIN_MARGIN
            if last is not None:
                left = min(left, CHAIN_SECONDS)
            if left < 0.05:
                return last
            try:
                with deadline(left):
                    return _chained(sides, dists, last, state, info)
            except Exception:  # noqa: BLE001 - a Timeout too: the chain is an extra
                return last
    except Timeout:
        raise
    except (ParseError, RecursionError):
        return None
    except Exception:  # noqa: BLE001 - anything SymPy can't do is "no result"
        return None


def _chained(sides, dists, last, state, info):
    """compute() for a chain: `last`, the last side's result (state "ok", or "empty"/"unreadable")."""
    first = None
    for side in sides[:CHAIN_TRIES]:                     # names (p_x, y) and final forms have no result
        finfo = {}
        try:
            res = _compute(side, dists, finfo)
        except Timeout:
            raise
        except Exception:  # noqa: BLE001
            continue
        if res is not None:
            first = side
            break
    if first is None:
        return last
    echo = re.sub(r"\s+", " ", first)
    echo = f"${echo}$" if len(echo) <= 70 and not re.search(r"[$%&\n]|\\\\", echo) else "the expression before it"
    if state != "ok":
        return res if state == "empty" else _noted(res, "the value of " + echo)
    if not _surely_different(finfo, info):
        return last
    if last is None:                                     # \int_0^1 2x\,dx = 2 = : the last side is a final form
        return _noted(res, f"⚠ the value of {echo}; the last step isn't equal to it")
    value = ""
    if len(res["latex"]) <= 60 and "$" not in res["latex"]:
        value = f", which is {'about ' if res['approx'] else ''}${res['latex']}$"
    return _noted(last, f"⚠ doesn't match {echo}{value}")


def _noted(res, text):
    """res with one more note; "assuming a > 0" is all math, so it gets its $…$ before text joins it."""
    note = res.get("note")
    if note and "$" not in note and note.startswith("assuming "):
        note = "assuming $" + note[len("assuming "):] + "$"
    return dict(res, note=f"{note}; {text}" if note else text)


SAMPLES = (("0.37", "1.61", "2.9"), ("1.83", "0.59", "4.7"), ("7.3", "12.9", "0.21"), ("3", "5", "2"), ("12", "7", "23"))
UNSURE = {"indefinite", "huge", "stats", "numeric"}


def _surely_different(first, last):
    """Two sides of a chain (what _compute noted about each) have values that can't be equal.

    False whenever that isn't certain, since a wrong warning is worse than a missed one:
    - different variables on the two sides (x^2 + x = 3^2 + 3 puts a value in; 2x + 3x = 10 is an
      equation), antiderivatives, statistics, matrices, anything not fully evaluated;
    - decimals in the last side, which may be rounded (\\sqrt{2} + 1 = 1.414 + 1), unless the first
      side is decimal arithmetic whose every intermediate value fits the last side's decimal places;
    - with variables: unless the two are real, finite and different at every sample point."""
    a, b = first.get("value"), last.get("value")
    if a is None or b is None or (first["flags"] | last["flags"]) & UNSURE:
        return False
    open_ = (sp.Integral, sp.Sum, sp.Product, sp.Limit, sp.Derivative, sp.Subs, sp.Piecewise, sp.Float,
             sp.oo, -sp.oo, sp.zoo, sp.nan, sp.AccumBounds)
    if not all(isinstance(v, sp.Expr) and not v.has(*open_) for v in (a, b)):
        return False
    names = sorted(a.free_symbols, key=lambda s_: s_.name)
    if a.free_symbols != b.free_symbols or len(names) > len(SAMPLES[0]):
        return False
    places = [len(t.val.partition(".")[2]) for t in last["toks"] if t.kind == "num" and "." in t.val]
    if places and (names or not _fits_decimals(first.get("plain"), max(places))):
        return False

    def apart(x, y):                                     # two numbers; None when they can't be compared
        if x.is_Rational and y.is_Rational:
            return x != y
        x, y = sp.N(x, 30), sp.N(y, 30)
        if not (x.is_Float and y.is_Float and x.is_finite and y.is_finite):
            return None                                  # complex ((-8)^{1/3} has a real reading too) or infinite
        return bool(abs(x - y) > sp.Float("1e-9") * max(1, abs(x), abs(y)))

    if not names:
        return apart(a, b) is True
    for point in SAMPLES:
        at = {n: sp.Rational(v) for n, v in zip(names, point)}
        if apart(a.xreplace(at), b.xreplace(at)) is not True:
            return False
    return True


def _fits_decimals(plain, places):
    """`plain` (a side as written, nothing combined) is numbers with + - × ÷ and powers, and every
    value computed on the way is a decimal of at most `places` places: nothing there needed rounding."""
    if plain is None:
        return False
    scale = sp.Integer(10) ** places
    for node in sp.preorder_traversal(plain):
        if node.is_Atom:
            if not (node.is_Rational and _rational_decimal(node) is not None):
                return False
        elif not isinstance(node, (sp.Add, sp.Mul, sp.Pow)):
            return False
        else:
            v = node.doit()
            if not (v.is_Rational and (v * scale).is_Integer):
                return False
    return True


def _compute(src, decls=None, info=None):
    """The result for src, or None. `info` (a dict) is filled with what a chain comparison needs:
    "toks", "flags", and for an ordinary formula "value" (its evaluated SymPy value) and "plain"
    (the formula as written, nothing combined, or None)."""
    info = {} if info is None else info
    toks = tokenize(src)
    if not toks:
        return None
    parser = Parser(list(toks), decls)
    p = parser.parse()
    flags, env = parser.flags, parser.env
    info.update(toks=toks, flags=flags)
    snote = "; ".join(parser.notes) or None
    if parser.pm is not None:
        return _pm_result(parser)
    if isinstance(p, sp.MatrixBase):
        if "matrix-op" not in flags:
            return None
        return _matrix_result(p, env, flags, snote, src)
    if flags & {"stats", "numeric"}:
        q = sp.sympify(p)
        if "calculus" in flags:                       # \\int_0^1 \\operatorname{sigmoid}(x)\\,dx
            q, cnote = evaluate(q)
            if q is None or (q.has(sp.Integral, sp.Sum, sp.Product, sp.Limit, sp.Derivative) and q.free_symbols):
                return None
            snote = "; ".join(x for x in (snote, cnote) if x) or None
        res = _stats_result(q, snote, src)
        if res and "indefinite" in flags:
            res = dict(res, latex=res["latex"] + " + C", alt=None)
        return res
    p = sp.sympify(p)
    if len(toks) == 1:
        info.update(value=p, plain=p)
        return None
    if p.is_Relational or isinstance(p, sp.logic.boolalg.Boolean):
        return None
    try:
        with sp.evaluate(False):
            p0 = sp.sympify(Parser(list(toks)).parse())
        computed = leaves(p0) != leaves(p)
        info["plain"] = p0
    except Exception:  # noqa: BLE001
        computed = True
    if flags & {"calculus", "matrix-op", "huge", "evaluated"}:
        computed = True

    r, note = p, None
    if "calculus" in flags:
        r, note = evaluate(p)
        if r is None:
            return None
    unevaluated = r.has(sp.Integral, sp.Sum, sp.Product, sp.Limit, sp.Derivative)
    if unevaluated and r.free_symbols:
        return None
    if not unevaluated:
        info["value"] = r

    def trivial(c):
        return c is None or norm(to_latex(c)) == norm(src)

    cands = []
    if not unevaluated and "huge" not in flags:
        if computed:
            s_ = step(sp.simplify, r, fallback=r)
            if p.has(sp.Sum, sp.Product) and s_.free_symbols and step(lambda: s_.is_rational_function(), fallback=False):
                f_ = step(sp.factor, s_)                 # n(n+1)(2n+1)/6 rather than n(2n^2+3n+1)/6
                if f_ is not None and len(to_latex(f_)) <= len(to_latex(s_)):
                    s_ = f_
            elif s_.free_symbols and step(lambda: s_.is_polynomial(), fallback=False):
                e_ = step(sp.expand, s_, fallback=s_)    # 3x^2 + 2x rather than simplify's x(3x + 2),
                if len(to_latex(e_)) <= len(to_latex(s_)) + 4:   # but 6x(x^2+1)^2 stays compact
                    s_ = e_
            cands.append(s_)
        if "calculus" not in flags:
            for fn in (sp.simplify, sp.expand, sp.factor):
                c = step(fn, p, fallback=None)
                if c is not None and c != p and (fn is not sp.factor or _really_factored(c)):
                    cands.append(c)
    exact = next((c for c in cands if not trivial(c) and not c.has(sp.zoo, sp.nan, sp.AccumBounds)), None)

    if exact is not None and not is_plain_number(exact):
        if exact.has(sp.Integral, sp.Sum, sp.Product, sp.Limit, sp.Derivative):
            return None
        out = to_latex(exact)
        if len(out) > MAX_LATEX_OUT:
            return None
        if "indefinite" in flags:
            out += " + C"
        return {"latex": out, "approx": False, "alt": None, "note": note}

    # numbers
    num = exact if exact is not None else (p if unevaluated else r)   # N() can't do NonElementaryIntegral
    if not is_plain_number(num) or num.free_symbols:
        return None
    if num.has(sp.oo, -sp.oo) or num in (sp.oo, -sp.oo):
        if exact is None:
            return None
        return {"latex": to_latex(exact), "approx": False, "alt": None, "note": note}
    if exact is None and "decimal" in flags and getattr(p, "is_Rational", False) and not computed:
        return None                                  # 0.5 = ... : already a plain decimal
    dec, dec_exact = decimal(num)
    if "decimal" in flags or "huge" in flags or exact is None or unevaluated:
        if dec is None or norm(dec) == norm(src):
            return None
        alt = None                                   # 0.7 also as \frac{7}{10}, 0.0333… as \frac{1}{30}
        if num.is_Rational and not num.is_Integer and abs(num.q) <= MAX_ALT_DENOMINATOR and "huge" not in flags:
            alt = {"latex": to_latex(num), "approx": False}
        return {"latex": dec, "approx": not dec_exact, "alt": alt, "note": note}
    out = to_latex(exact)
    alt = None
    if dec is not None and norm(dec) != norm(out) and not exact.is_Integer:
        alt = {"latex": dec, "approx": not dec_exact}
    if exact.is_Integer and len(out) > 40 and dec is not None:      # 100! : the decimal first
        return {"latex": dec, "approx": True, "alt": None if len(out) > MAX_LATEX_OUT else {"latex": out, "approx": False}, "note": note}
    if len(out) > MAX_LATEX_OUT:
        if dec is None:
            return None
        return {"latex": dec, "approx": not dec_exact, "alt": None, "note": note}
    return {"latex": out, "approx": False, "alt": alt, "note": note}


def _short(v):
    """The rounded value people write in statistics: 0.9750, 1.960, 2.277 × 10^{-7}."""
    v = sp.N(v, 20)
    if v == 0 or not v.is_real:
        return None
    av = abs(float(v))
    if 1e-4 <= av < 1:
        return f"{float(v):.4f}"
    if 1 <= av < 1000:
        import math
        return f"{float(v):.{3 - int(math.floor(math.log10(av)))}f}"
    if av < 1e-4:
        return _fmt(v, 4)
    return None


def _mat_tex(shape, cells, env):
    r, c = shape
    if env == "tuple" and 1 in (r, c):
        return "(" + ", ".join(cells) + ")"
    env = env if env in ("pmatrix", "bmatrix", "Bmatrix", "matrix") else "pmatrix"
    rows = [" & ".join(cells[i * c:(i + 1) * c]) for i in range(r)]
    return f"\\begin{{{env}}}" + "\\\\".join(rows) + f"\\end{{{env}}}"


def _matrix_result(p, env, flags, note, src):
    r = p.applyfunc(lambda x: step(sp.simplify, x, fallback=x))
    if "numeric" in flags or "stats" in flags or any(sp.sympify(x).has(sp.Float) for x in r):
        cells, approx = [], False
        for x in r:
            d, exact = decimal(sp.sympify(x)) if sp.sympify(x).is_number else (None, False)
            if d is None:
                return None
            cells.append(d)
            approx = approx or not exact
        return {"latex": _mat_tex(r.shape, cells, env), "approx": approx, "alt": None, "note": note}
    out = _mat_tex(r.shape, [to_latex(x) for x in r], env) if env == "tuple" else to_latex(r, env)
    if norm(out) == norm(src) or len(out) > MAX_LATEX_OUT * 2:
        return None
    return {"latex": out, "approx": False, "alt": None, "note": note}


def _pm_result(parser):
    """52 \\pm 1.96 -> the interval (50.04, 53.96)."""
    a, b = parser.pm
    if isinstance(a, sp.MatrixBase) or isinstance(b, sp.MatrixBase):
        return None
    vals = []
    for v in (sp.sympify(a) - sp.sympify(b), sp.sympify(a) + sp.sympify(b)):
        if "calculus" in parser.flags:
            v, _ = evaluate(v)
            if v is None:
                return None
        v = step(sp.simplify, v, fallback=v)
        if not is_plain_number(v) or v.is_real is False or step(lambda: sp.im(sp.N(v, 20)) != 0, fallback=True):
            return None
        vals.append(v)
    vals.sort(key=lambda v: sp.N(v, 30))
    cells, approx = [], False
    for v in vals:
        d, exact = decimal(v)
        if v.is_Rational and not exact:
            d, exact = to_latex(v), True                # 1/3 stays a fraction
        if d is None:
            return None
        cells.append(d)
        approx = approx or not exact
    return {"latex": f"({cells[0]}, {cells[1]})", "approx": approx, "alt": None,
            "note": "; ".join(parser.notes) or None}


def _stats_result(p, note, src):
    """Probabilities, moments, critical values, data summaries, ML functions: decimal first."""
    r = sp.sympify(p)
    if r.free_symbols:                                    # Var(2X + 3) = 4 \\sigma^2, n p (1 - p)
        s_ = step(sp.simplify, r, fallback=r)
        forms = [s_] + [f for f in (step(sp.factor, s_), step(sp.expand, s_)) if f is not None]
        s_ = min(forms, key=lambda f: len(to_latex(f)))
        out = to_latex(s_)
        if norm(out) == norm(src) or len(out) > MAX_LATEX_OUT or s_.has(sp.Integral, sp.Sum):
            return None
        return {"latex": out, "approx": False, "alt": None, "note": note}
    if not is_plain_number(r) or not (r.is_real or r.is_real is None):
        return None
    if r.is_Rational and len(to_latex(r)) <= 40:
        d = _rational_decimal(r)
        if d is not None and len(d.replace("-", "").replace(".", "")) <= 12:
            short = _short(r)
            alt = {"latex": short, "approx": True} if short and _value(short) != r else None
            return {"latex": d, "approx": False, "alt": alt, "note": note}
        dec, exact = decimal(r)
        return {"latex": to_latex(r), "approx": False, "alt": dec and {"latex": dec, "approx": not exact}, "note": note}
    dec, exact = decimal(r)
    if dec is None:
        return None
    short = _short(r)
    alt = {"latex": short, "approx": True} if short and short != dec else None
    return {"latex": dec, "approx": not exact, "alt": alt, "note": note}


def _really_factored(c):
    """A factorisation worth showing: at least two non-constant factors, or a power of a sum."""
    if isinstance(c, sp.Pow):
        return isinstance(c.base, sp.Add)
    if isinstance(c, sp.Mul):
        return sum(1 for a in c.args if not a.is_number) >= 2 or any(
            isinstance(a, sp.Pow) and isinstance(a.base, sp.Add) for a in c.args)
    return False


# ---------------------------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------------------------

def worker() -> int:
    try:
        load()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ready": False, "error": f"SymPy isn't installed for {sys.executable} ({type(e).__name__})"}), flush=True)
        return 1
    sys.setrecursionlimit(max(sys.getrecursionlimit(), 4000))
    print(json.dumps({"ready": True, "sympy": sp.__version__, "python": sys.version.split()[0]}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            rid = req.get("id")
        except ValueError:
            continue
        try:
            res = compute(str(req.get("latex") or ""), float(req.get("budget") or TOTAL_SECONDS), req.get("decls"),
                          req.get("chain"))
            out = {"id": rid, "ok": True, "result": res}
        except Timeout:
            out = {"id": rid, "ok": False, "error": "timeout"}
        except Exception as e:  # noqa: BLE001
            out = {"id": rid, "ok": False, "error": f"{type(e).__name__}"}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()
    return 0


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv == ["--worker"]:
        return worker()
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    decls = []                                   # --decl 'X \\sim N(100, 15^2)' before the formulas
    chain = []                                   # --chain 'A' --chain 'B' 'C' is A = B = C = (one formula's worth)
    it = iter(argv)
    for a in it:
        if a == "--decl":
            name, _, dist = next(it, "").partition("\\sim")
            decls.append({"name": name, "dist": dist})
            continue
        if a == "--chain":
            chain.append(next(it, ""))
            continue
        shown = " = ".join(chain + [a])
        try:
            print(f"{shown}  =>  {json.dumps(compute(a, decls=decls, chain=chain), ensure_ascii=False)}")
        except Timeout:
            print(f"{shown}  =>  timeout")
        chain = []
    return 0


if __name__ == "__main__":
    sys.exit(main())
