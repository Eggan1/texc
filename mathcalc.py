#!/usr/bin/env python3
"""texc math results: the value of a LaTeX formula, for the editor's "=" suggestions.

Type `\\int_0^1 x^2\\,dx =` in the editor and texc offers `\\frac{1}{3}` as ghost text. This module
does the math. `compute(latex)` parses the left-hand side with a small recursive-descent LaTeX
parser that builds SymPy objects directly, so document text never goes through sympify/eval.
It returns the result as LaTeX, or None when there is nothing worth showing (plain names like
`f(x)` or `y`, text, or anything it can't read).

`python3 mathcalc.py --worker` is the long-lived JSON-lines process the GUI server talks to:
one {"id", "latex"} object per line in, one {"id", "ok", "result"} line out. It needs SymPy
(https://www.sympy.org); the rest of texc doesn't. `python3 mathcalc.py '2^{10}'` prints a result.
Python 3.9+.
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
MAX_INPUT = 4000
MAX_LATEX_OUT = 600            # longer exact results are dropped (a decimal may still be shown)
MAX_POW_BITS = 200_000         # bigger integer powers stay unevaluated and are shown as decimals
MAX_FACTORIAL = 3000


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
    "lvert": ("sym", "|"), "rvert": ("sym", "|"), "vert": ("sym", "|"), "mid": ("sym", "|"),
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


class Frame:
    __slots__ = ("kind", "var", "closed")

    def __init__(self, kind):
        self.kind, self.var, self.closed = kind, None, False


class Parser:
    def __init__(self, toks):
        self.t = toks
        self.i = 0
        self.frames = []           # open integrals (their differential ends them) and groups
        self.bound = []            # names bound by \sum / \prod indices (then i and e are plain)
        self.abs_depth = 0
        self.limit_point = 0
        self.limit_dir = None
        self.flags = set()         # decimal, calculus, indefinite, matrix-op, huge
        self.env = None            # the matrix environment of the input, for the output

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
        while not self.closed(frame):
            tk = self.peek()
            if tk.is_("sym", "+"):
                self.next()
                node = node + self.term()
            elif tk.is_("sym", "-"):
                self.next()
                node = node - self.term()
            else:
                break
        return node

    def term(self):
        frame = self.top()
        node = self.unary()
        while not self.closed(frame):
            tk = self.peek()
            if tk.is_("sym", "*") or (tk.kind == "cmd" and tk.val in ("cdot", "times", "ast")):
                self.next()
                node = self.mul(node, self.unary())
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
            return tk.val in "([{" or (tk.val == "|" and self.abs_depth == 0)
        return tk.kind == "cmd" and tk.val in FACTOR_CMDS

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
            elif tk.is_("sym", "!"):
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

    def symbol(self, name, applied_ok=False):
        """A variable, with an optional subscript: x, x_1, a_{ij}, \\alpha_0.

        Refuses what would be read wrongly: x_i under \\sum_i (the index is bound, a plain symbol
        x_i would not change with it) and names applied to brackets, f(x), \\phi(x), x(t)."""
        sym_name = name
        if self.at("sym", "_"):
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
            if name in FUNCNAMES or name in GREEK or name.startswith("\\") or (single and self.at("sym", closer, 2)):
                raise Refuse(f"{name}(...) reads as a function")
        return sp.Symbol(sym_name)

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
            if v == "d" and not script:
                d = self.differential()
                if d is not None:
                    return d
            if v == "e" and "e" not in self.bound and not self.at("sym", "_"):
                return sp.E
            if v == "i" and "i" not in self.bound and not self.at("sym", "_"):
                return sp.I
            return self.symbol(v)
        if k == "sym":
            if v == "(":
                return self.grouped("sym", ")")
            if v == "[":
                return self.grouped("sym", "]")
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
            return self.symbol(v)
        if v in DECORATIONS:
            inner = self.raw_group()
            return self.symbol(f"\\{v}{{{inner}}}")
        if v in ROMAN:
            name = self.raw_group().replace(" ", "")
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


def compute(latex: str, budget: float = TOTAL_SECONDS):
    """The result for the left-hand side `latex`, or None.

    {"latex": shown/inserted LaTeX, "approx": True when it is a rounded decimal (the "=" then
     becomes \\approx), "alt": {"latex", "approx"} or None (the decimal of an exact number),
     "note": e.g. "assuming a > 0" or None}"""
    load()
    src = (latex or "").strip()
    if not src or len(src) > MAX_INPUT:
        return None
    try:
        with deadline(budget):
            return _compute(src)
    except Timeout:
        raise
    except (ParseError, RecursionError):
        return None
    except Exception:  # noqa: BLE001 - anything SymPy can't do is "no result"
        return None


def _compute(src):
    toks = tokenize(src)
    if not toks:
        return None
    parser = Parser(list(toks))
    p = parser.parse()
    flags, env = parser.flags, parser.env
    if isinstance(p, sp.MatrixBase):
        if "matrix-op" not in flags:
            return None
        r = p.applyfunc(lambda x: step(sp.simplify, x, fallback=x))
        out = to_latex(r, env)
        if norm(out) == norm(src) or len(out) > MAX_LATEX_OUT * 2:
            return None
        return {"latex": out, "approx": False, "alt": None, "note": None}
    p = sp.sympify(p)
    if len(toks) == 1:
        return None
    if p.is_Relational or isinstance(p, sp.logic.boolalg.Boolean):
        return None
    try:
        with sp.evaluate(False):
            p0 = sp.sympify(Parser(list(toks)).parse())
        computed = leaves(p0) != leaves(p)
    except Exception:  # noqa: BLE001
        computed = True
    if flags & {"calculus", "matrix-op", "huge"}:
        computed = True

    r, note = p, None
    if "calculus" in flags:
        r, note = evaluate(p)
        if r is None:
            return None
    unevaluated = r.has(sp.Integral, sp.Sum, sp.Product, sp.Limit, sp.Derivative)
    if unevaluated and r.free_symbols:
        return None

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
        return {"latex": dec, "approx": not dec_exact, "alt": None, "note": note}
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
            res = compute(str(req.get("latex") or ""), float(req.get("budget") or TOTAL_SECONDS))
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
    for a in argv:
        try:
            print(f"{a}  =>  {json.dumps(compute(a), ensure_ascii=False)}")
        except Timeout:
            print(f"{a}  =>  timeout")
    return 0


if __name__ == "__main__":
    sys.exit(main())
