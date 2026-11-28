/* texc editor (T.editor). One CodeMirror 5 instance with one CodeMirror.Doc per file, LaTeX
   highlighting, autosave with conflict handling, completion, and the inline review of AI edits:
   the proposed text is applied tentatively (green lines), the old text sits above it in a red
   read-only block, and Undo ⌥N / Keep ⌥Y pills resolve each hunk. */
(function () {
  "use strict";
  const T = (window.T = window.T || {});
  const CM = window.CodeMirror;
  if (!CM) {
    console.error("[editor] CodeMirror is not loaded");
    return;
  }
  const Pos = CM.Pos;
  const cmp = CM.cmpPos;
  const IS_MAC = T.util && typeof T.util.isMac === "boolean" ? T.util.isMac : /Mac|iPhone|iPad/.test(navigator.platform);
  const KEYS = IS_MAC ? { undo: "⌥N", keep: "⌥Y" } : { undo: "Alt+N", keep: "Alt+Y" };
  const TAB_SIZE = 4;
  const INDENT_UNIT = 2;
  const BASE_PAD = 4; // px, the left padding of .cm-s-texc pre.CodeMirror-line (editor.css)
  const MAX_HANG_COLS = 48; // wrapped lines never hang further in than this
  const MAX_DIFF_CELLS = 1500000; // word-level LCS budget; bigger hunks get line tints only
  const LIST_ENVS = new Set(["itemize", "enumerate", "description"]);

  // ------------------------------------------------------------------ small helpers
  const nl = (s) => String(s == null ? "" : s).replace(/\r\n?/g, "\n");
  const errText = (e) => (e && e.message) || String(e || "unknown error");
  const baseName = (p) => String(p || "").split("/").pop();
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function normPath(p) {
    let s = String(p == null ? "" : p).trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    while (s.startsWith("./")) s = s.slice(2);
    return s.replace(/\/\.(?=\/)/g, "").replace(/^\/+/, "");
  }
  function debounce(fn, ms) {
    let t = 0;
    const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    d.cancel = () => clearTimeout(t);
    return d;
  }
  function toast(text, kind) {
    try { if (T.app && typeof T.app.toast === "function") return T.app.toast(text, kind); } catch (e) { console.error(e); }
    (kind === "error" ? console.error : console.warn)("[editor]", text);
  }
  async function confirmBox(text, opts) {
    try { if (T.app && typeof T.app.confirm === "function") return !!(await T.app.confirm(text, opts)); } catch (e) { console.error(e); }
    console.warn("[editor] no T.app.confirm; treating as Cancel:", text);
    return false; // never a native dialog
  }
  function docEnd(doc) { const l = doc.lastLine(); return Pos(l, doc.getLine(l).length); }
  function docLength(doc) { return doc.indexFromPos(docEnd(doc)); }
  function countLines(text) {
    if (!text) return 0;
    const n = text.split("\n").length;
    return text.endsWith("\n") ? n - 1 : n;
  }
  // Removes a % comment (an unescaped %) from one line of LaTeX.
  function stripComment(t) {
    for (let i = t.indexOf("%"); i >= 0; i = t.indexOf("%", i + 1)) {
      let k = i - 1, bs = 0;
      while (k >= 0 && t[k] === "\\") { bs++; k--; }
      if (bs % 2 === 0) return t.slice(0, i);
    }
    return t;
  }

  // ------------------------------------------------------------------ LaTeX mode
  // stex tags generic command arguments as plain text and treats math environments as text, so
  // texc uses its own small tokenizer. The colours follow VS Code's dark theme with its LaTeX
  // grammar. Token classes (cm-*):
  //   tex-cmd      a command; plus tex-ctl (\usepackage, \label, \ref, \\), tex-kw (\item,
  //                \newcommand) or tex-esc (\%) where VS Code uses another colour
  //   tex-arg      text in a command argument; plus tex-env, tex-name, tex-const, tex-type,
  //                tex-bold, tex-ital or tex-link when the command colours its argument
  //   tex-math     everything in math; plus tex-const (\frac), tex-sym (\int, \alpha), tex-number
  //   tex-brace    { } and argument [ ]
  //   tex-b1..b3   any paired bracket, by nesting depth
  //   tex-comment, tex-verb
  const MATH_ENV = /^(?:equation|align|alignat|flalign|xalignat|xxalignat|gather|multline|eqnarray|displaymath|math|dmath|dgroup|darray|IEEEeqnarray|IEEEeqnarraybox)\*?$/;
  const VERB_ENV = /^(?:verbatim|Verbatim|BVerbatim|LVerbatim|lstlisting|minted|alltt|comment|filecontents)\*?$/;
  const CMD_CTL = /^(?:documentclass|usepackage|z?label|input|include|includeonly|newline|pagebreak|clearpage|linebreak|pause|backmatter|frontmatter|mainmatter|csname|endcsname|else|fi|unless|if(?:case|cat|csname|defined|dim|eof|false|fontchar|hbox|hmode|inner|mmode|num|odd|true|vbox|vmode|void|x)?)$/;
  const CMD_KW = /^(?:item|(?:re)?newcommand|providecommand|(?:re)?newrobustcmd|DeclareRobustCommand|(?:re)?newenvironment|(?:New|Re[Nn]ew|Provide|Declare)Document(?:Command|Environment))$/;
  const CMD_REF = /^(?!h(?:yper)?ref$)[A-Za-z]*[rR]ef(?:range)?$/; // \ref, \eqref, \cref; not \href
  const CMD_CITE = /^[A-Za-z]*[cC]ite[A-Za-z]*$/;
  const CMD_SEC = /^(?:part|chapter|(?:sub){0,2}section|(?:sub)?paragraph|addpart|addchap|addsec|minisec|frametitle)$/;
  // \left( and \bigl( open a bracket, \right) and \bigr) close one; plain \big( does neither.
  const MATH_BIG = /^(?:left|right|(?:big|Big|bigg|Bigg)([lrm]?))$/;
  const MATH_DELIM = /^(?:[()[\]<>.|]|\\[{}|]|\\[lr]?[Vv]ert(?![A-Za-z])|\\[lr]angle(?![A-Za-z]))/;
  // Named symbols (Greek letters, big operators, relations, arrows) take the symbol colour;
  // every other command in math takes the constant colour.
  const MATH_SYM = new Set((
    "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa varkappa lambda mu nu xi pi varpi " +
    "rho varrho sigma varsigma tau upsilon phi varphi chi psi omega digamma " +
    "Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega " +
    "sum prod coprod int oint bigcap bigcup bigsqcup bigvee bigwedge bigodot bigotimes bigoplus biguplus " +
    "le leq leqq leqslant ge geq geqq geqslant neq ll gg sim simeq approx approxeq cong equiv propto doteq asymp " +
    "prec succ preceq succeq mid nmid parallel nparallel perp models vdash dashv in ni " +
    "subset supset subseteq supseteq subsetneq supsetneq sqsubset sqsupset sqsubseteq sqsupseteq " +
    "times div cdot cdots ldots vdots ddots pm mp cup cap sqcup sqcap uplus setminus smallsetminus " +
    "oplus ominus otimes oslash odot circ bullet star ast dagger ddagger wedge vee neg wr amalg diamond " +
    "mapsto longmapsto leftarrow rightarrow leftrightarrow Leftarrow Rightarrow Leftrightarrow " +
    "longleftarrow longrightarrow longleftrightarrow Longleftarrow Longrightarrow Longleftrightarrow " +
    "uparrow downarrow updownarrow Uparrow Downarrow Updownarrow nearrow searrow swarrow nwarrow " +
    "hookleftarrow hookrightarrow leftharpoonup rightharpoonup leftharpoondown rightharpoondown rightleftharpoons " +
    "leadsto " +
    "infty partial nabla forall exists nexists emptyset varnothing ell hbar imath jmath wp Re Im aleph beth " +
    "angle measuredangle triangle triangleleft triangleright bigtriangleup bigtriangledown square Box blacksquare " +
    "top bot prime backslash surd flat natural sharp clubsuit diamondsuit heartsuit spadesuit " +
    "therefore because complement lfloor rfloor lceil rceil langle rangle"
  ).split(" "));
  const endReCache = new Map();
  function endEnvRe(name) {
    let re = endReCache.get(name);
    if (!re) { re = new RegExp("^\\\\end\\s*\\{" + reEsc(name) + "\\}"); endReCache.set(name, re); }
    return re;
  }

  CM.defineMode("texc-latex", function () {
    // state.stack holds brace frames: "arg" / "opt" (command arguments), "grp" (bare group),
    // "mgrp" (group inside math). An argument frame may carry the colour its command asks for,
    // as "arg:name"; "opt:name" keeps it for the argument after the optional one.
    // state.expect: 1 right after a command (spaces allowed before its argument), 2 right after
    // an argument (only an immediately following { or [ continues).
    // state.br lists the open brackets for the depth colours: "c" for { and "r" for ( and [,
    // which may close each other as in [0, 1).
    const top = (s) => s.stack[s.stack.length - 1];
    const isArg = (f) => f !== undefined && f.charCodeAt(0) === 97; // "arg…"
    const isOpt = (f) => f !== undefined && f.charCodeAt(0) === 111; // "opt…"
    const kindOf = (f) => (f.length > 3 ? f.slice(4) : null);
    // Style of plain text here: the nearest argument that has a colour, else plain "tex-arg".
    function argStyle(s) {
      let any = false;
      for (let i = s.stack.length - 1; i >= 0; i--) {
        const f = s.stack[i];
        if (isArg(f)) { if (f.length > 3) return "tex-arg tex-" + f.slice(4); any = true; }
        else if (isOpt(f)) any = true;
      }
      return any ? "tex-arg" : null;
    }
    function openB(s, kind) { const d = s.br.length; s.br += kind; return " tex-b" + (d % 3 + 1); }
    // "" when nothing matches: the bracket then keeps the colour of the text around it.
    function closeB(s, kind) {
      const i = kind === "c" ? s.br.lastIndexOf("c") : s.br.charAt(s.br.length - 1) === "r" ? s.br.length - 1 : -1;
      if (i < 0) return "";
      s.br = s.br.slice(0, i);
      return " tex-b" + (i % 3 + 1);
    }
    function enterMath(s, end, env) { s.math = { end, env: env || null, depth: s.stack.length, br: s.br.length }; s.expect = 0; s.envCmd = null; s.argKind = null; }
    function leaveMath(s) { s.stack.length = s.math.depth; s.br = s.br.slice(0, s.math.br); s.math = null; s.expect = 0; }
    // The colour of a command in text, and (in state.argKind) of its first argument.
    function cmdStyle(s, name) {
      s.argKind = null;
      if (name === "begin" || name === "end") { s.argKind = "env"; return "tex-cmd"; }
      if (CMD_KW.test(name)) return "tex-cmd tex-kw";
      if (CMD_CTL.test(name)) {
        if (/label$/.test(name)) s.argKind = "name";
        else if (name === "documentclass" || name === "usepackage") s.argKind = "type";
        return "tex-cmd tex-ctl";
      }
      if (CMD_REF.test(name) || CMD_CITE.test(name)) { s.argKind = "const"; return "tex-cmd tex-ctl"; }
      if (CMD_SEC.test(name)) s.argKind = "name";
      else if (name === "textbf") s.argKind = "bold";
      else if (name === "emph" || name === "textit") s.argKind = "ital";
      else if (name === "url" || name === "href") s.argKind = "link";
      return "tex-cmd";
    }

    function tokenText(stream, s) {
      const A = argStyle(s);
      if (stream.eatSpace()) { if (s.expect === 2) s.expect = 0; return A; }
      const ch = stream.next();
      if (ch === "%") { stream.skipToEnd(); return "tex-comment"; }
      if (ch === "\\") {
        if (stream.match(/^[A-Za-z@]+\*?/)) {
          const name = stream.current().slice(1).replace(/\*$/, "");
          s.envCmd = name === "begin" || name === "end" ? name : null;
          const style = cmdStyle(s, name);
          if (name === "verb") {
            const d = stream.peek();
            if (d && !/[\sA-Za-z*]/.test(d)) { stream.next(); s.verbDelim = d; s.expect = 0; return style; }
          }
          s.expect = 1;
          return style;
        }
        const c2 = stream.next();
        if (c2 === "(") { enterMath(s, "\\)"); return "tex-math"; }
        if (c2 === "[") { enterMath(s, "\\]"); return "tex-math"; }
        s.envCmd = null;
        s.argKind = null;
        s.expect = c2 === "\\" ? 1 : 0; // \\[2pt]
        if (c2 === "\\") return "tex-cmd tex-ctl";
        if (c2 === "{") return "tex-cmd" + openB(s, "r");
        if (c2 === "}") return "tex-cmd" + (closeB(s, "r") || " tex-esc");
        return c2 === "," || c2 === ";" ? "tex-cmd" : "tex-cmd tex-esc";
      }
      if (ch === "$") { enterMath(s, stream.eat("$") ? "$$" : "$"); return "tex-math"; }
      if (ch === "{") {
        if (s.expect) {
          s.stack.push(s.argKind ? "arg:" + s.argKind : "arg");
          s.argKind = null;
          if (s.envCmd) s.env = { cmd: s.envCmd, depth: s.stack.length, name: "" };
          s.envCmd = null;
          s.expect = 0;
          return "tex-brace" + openB(s, "c");
        }
        s.envCmd = null;
        s.stack.push("grp");
        return "tex-brace" + openB(s, "c");
      }
      if (ch === "}") {
        const t = top(s);
        const style = "tex-brace" + closeB(s, "c");
        s.envCmd = null;
        if (isArg(t)) {
          s.stack.pop();
          const env = s.env;
          if (env && env.depth === s.stack.length + 1) {
            s.env = null;
            const name = env.name.trim();
            if (env.cmd === "begin") {
              if (MATH_ENV.test(name)) { enterMath(s, "env", name); return style; }
              if (VERB_ENV.test(name)) { s.verbPending = name; s.verbStyle = /^comment/.test(name) ? "tex-comment" : "tex-verb"; }
            }
          }
          s.expect = 2;
          return style;
        }
        if (t === "grp") s.stack.pop();
        else s.expect = 0;
        return style;
      }
      if (ch === "[") {
        if (s.expect) { s.stack.push(s.argKind ? "opt:" + s.argKind : "opt"); s.expect = 0; return "tex-brace" + openB(s, "r"); }
        s.envCmd = null;
        return openB(s, "r").slice(1);
      }
      if (ch === "]") {
        if (isOpt(top(s))) { s.argKind = kindOf(s.stack.pop()); s.expect = 2; return "tex-brace" + closeB(s, "r"); }
        s.expect = 0;
        return closeB(s, "r").slice(1) || A;
      }
      s.expect = 0;
      if (ch === "(") return openB(s, "r").slice(1);
      if (ch === ")") return closeB(s, "r").slice(1) || A;
      if (ch === "&") return "tex-cmd tex-ctl";
      if ("~^_#".indexOf(ch) >= 0) return A;
      stream.eatWhile(/[^\s\\{}[\]()$%&~^_#]/);
      if (s.env && s.env.depth === s.stack.length) s.env.name += stream.current();
      return A;
    }

    function tokenMath(stream, s) {
      const m = s.math;
      if (m.end === "env") {
        if (stream.match(/^\\end\s*\{/, false)) {
          const mm = /^\\end\s*\{\s*([^}\s]+)\s*\}/.exec(stream.string.slice(stream.pos));
          if (mm && mm[1] === m.env) { leaveMath(s); return tokenText(stream, s); }
        }
      } else if (stream.match(m.end)) {
        leaveMath(s);
        return "tex-math";
      }
      const ch = stream.next();
      if (ch === "%") { stream.skipToEnd(); return "tex-comment"; }
      if (ch === "\\") {
        if (stream.match(/^[A-Za-z@]+/)) {
          const name = stream.current().slice(1);
          const big = MATH_BIG.exec(name);
          if (big) {
            const side = name === "left" || big[1] === "l" ? 1 : name === "right" || big[1] === "r" ? -1 : 0;
            if (!side) return stream.match(MATH_DELIM, false) ? "tex-math" : "tex-math tex-const";
            if (!stream.match(MATH_DELIM)) return "tex-math tex-const";
            return "tex-math" + (side > 0 ? openB(s, "r") : closeB(s, "r"));
          }
          // an environment inside math (cases, pmatrix) reads as it does outside
          if (name === "begin" || name === "end") { if (stream.peek() === "{") s.argKind = "env"; return "tex-math tex-cmd"; }
          if (name === "langle" || name === "lvert" || name === "lVert") return "tex-math" + openB(s, "r");
          if (name === "rangle" || name === "rvert" || name === "rVert") return "tex-math" + (closeB(s, "r") || " tex-sym");
          return MATH_SYM.has(name) ? "tex-math tex-sym" : "tex-math tex-const";
        }
        const c2 = stream.next();
        if (c2 === "\\") return "tex-math tex-ctl";
        if (c2 === "{") return "tex-math" + openB(s, "r");
        if (c2 === "}") return "tex-math" + (closeB(s, "r") || " tex-esc");
        return c2 === "," || c2 === ";" ? "tex-math tex-cmd" : "tex-math tex-esc";
      }
      if (ch === "{") { s.stack.push(s.argKind === "env" ? "mgrp:env" : "mgrp"); s.argKind = null; return "tex-math tex-brace" + openB(s, "c"); }
      if (ch === "}") { if (s.stack.length > m.depth) s.stack.pop(); return "tex-math tex-brace" + closeB(s, "c"); }
      if (top(s) === "mgrp:env" && /[A-Za-z*]/.test(ch)) { stream.eatWhile(/[A-Za-z*]/); return "tex-math tex-env"; }
      if (ch === "(" || ch === "[") return "tex-math" + openB(s, "r");
      if (ch === ")" || ch === "]") return "tex-math" + closeB(s, "r");
      if (ch === "&") return "tex-math tex-ctl";
      if (/\d/.test(ch)) { stream.match(/^\d*(?:\.\d+)?/); return "tex-math tex-number"; }
      if (ch === "." && stream.match(/^\d+/)) return "tex-math tex-number";
      stream.eatWhile(/[^\\{}$%()[\]&.\d]/);
      return "tex-math";
    }

    return {
      startState: () => ({ stack: [], br: "", math: null, expect: 0, argKind: null, envCmd: null, env: null, verb: null, verbPending: null, verbStyle: null, verbDelim: null }),
      copyState: (s) => ({
        stack: s.stack.slice(), br: s.br, math: s.math && Object.assign({}, s.math), expect: s.expect, argKind: s.argKind, envCmd: s.envCmd,
        env: s.env && Object.assign({}, s.env), verb: s.verb, verbPending: s.verbPending, verbStyle: s.verbStyle, verbDelim: s.verbDelim,
      }),
      token(stream, s) {
        if (stream.sol()) {
          s.expect = 0;
          s.argKind = null;
          s.verbDelim = null; // \verb cannot span lines
          if (s.verbPending) { s.verb = s.verbPending; s.verbPending = null; }
        }
        if (s.verbDelim) {
          const i = stream.string.indexOf(s.verbDelim, stream.pos);
          if (i < 0) stream.skipToEnd(); else stream.pos = i + 1;
          s.verbDelim = null;
          return "tex-verb";
        }
        if (s.verb) {
          if (stream.match(endEnvRe(s.verb), false)) { s.verb = null; return tokenText(stream, s); }
          stream.next();
          stream.eatWhile((c) => c !== "\\");
          return s.verbStyle;
        }
        return s.math ? tokenMath(stream, s) : tokenText(stream, s);
      },
      blankLine(s) {
        s.expect = 0; s.argKind = null; s.envCmd = null; s.env = null; s.verbDelim = null;
        if (s.verbPending) { s.verb = s.verbPending; s.verbPending = null; }
        if (s.verb) return;
        if (s.math && s.math.end !== "env") { s.br = s.br.slice(0, s.math.br); s.math = null; } // inline/display math cannot span paragraphs
        if (!s.math) s.stack.length = 0; // a paragraph break also ends stray groups
        s.br = s.br.replace(/r/g, ""); // and stray ( [, but a { } group may hold several paragraphs
        if (s.math) s.math.br = Math.min(s.math.br, s.br.length);
      },
      lineComment: "%",
    };
  });
  CM.defineMIME("text/x-texc-latex", "texc-latex");

  // A small BibTeX mode: @type, key, field names, values.
  CM.defineMode("texc-bib", function () {
    return {
      startState: () => ({ depth: 0, head: false, key: false, quote: false }),
      copyState: (s) => Object.assign({}, s),
      token(stream, s) {
        if (stream.eatSpace()) return null;
        if (s.depth === 0) {
          if (stream.match(/^@[A-Za-z]+/)) { s.head = true; return "tex-cmd tex-kw"; }
          if (s.head && stream.eat(/[{(]/)) { s.depth = 1; s.head = false; s.key = true; return "tex-brace"; }
          stream.next();
          stream.eatWhile((c) => c !== "@");
          return "tex-comment"; // bibtex ignores text between entries
        }
        if (s.key) { s.key = false; if (stream.match(/^[^,\s{}()]+/)) return "tex-arg tex-name"; }
        const ch = stream.next();
        if (ch === "{") { s.depth++; return "tex-brace"; }
        if (ch === "}" || (ch === ")" && s.depth === 1)) { s.depth = Math.max(0, s.depth - 1); s.quote = false; return "tex-brace"; }
        if (s.depth === 1) {
          if (ch === '"') { s.quote = !s.quote; return null; }
          if (s.quote) { stream.eatWhile(/[^"{}]/); return null; }
          if (/\d/.test(ch)) { stream.eatWhile(/\d/); return "tex-number"; }
          if (/[A-Za-z]/.test(ch)) { stream.eatWhile(/[\w\-:.]/); return "tex-const"; }
          return null;
        }
        stream.eatWhile(/[^{}]/);
        return null;
      },
      lineComment: "%",
    };
  });

  function modeFor(path) {
    const ext = ((/\.([A-Za-z0-9]+)$/.exec(path) || [])[1] || "").toLowerCase();
    if (/^(tex|ltx|sty|cls|dtx|ins|def|cfg|bbx|cbx|lbx|tikz|clo)$/.test(ext)) return "texc-latex";
    if (ext === "bib") return "texc-bib";
    return "text/plain";
  }

  // ------------------------------------------------------------------ state
  let cm = null, host = null, wrapper = null, stateEl = null, blankDoc = null;
  let current = null; // the entry shown in the editor
  let viewSeq = 0; // the latest open/show request wins
  const docs = new Map(); // path -> entry
  const loading = new Map(); // path -> Promise<entry>
  let charWidth = 7.8, layoutRev = 0, autosaveDelay = 800, fontSize = 13;
  let dockInset = -1, lastHostW = 0, lastHostH = 0, pendingReveal = null;
  let lastSelKey = "", strayCharUntil = 0;

  /* entry = { path, doc, mode, eol, mtime, cleanGen, hunks[], decorated:Set<lineHandle>, dirty,
               needsCheck, needsDirty, autosaveTimer, saveChain, conflict, closed } */
  function createEntry(path, content, mtime) {
    const text = String(content == null ? "" : content);
    const mode = modeFor(path);
    // CodeMirror splits on CRLF/CR/LF and works in LF; we write CRLF files back as CRLF.
    const doc = new CM.Doc(text, mode);
    const entry = {
      path, doc, mode, eol: /\r\n/.test(text) ? "\r\n" : "\n", mtime: mtime || 0, cleanGen: doc.changeGeneration(true),
      hunks: [], decorated: new Set(), dirty: false, needsCheck: false, needsDirty: false,
      autosaveTimer: 0, saveChain: null, conflict: false, closed: false, saveErrorShown: false,
    };
    doc.on("change", (_d, change) => onDocChange(entry, change));
    docs.set(path, entry);
    return entry;
  }

  function load(path) {
    if (docs.has(path)) return Promise.resolve(docs.get(path));
    if (loading.has(path)) return loading.get(path);
    const p = T.api.get("/api/file", { path }).then((data) => {
      if (docs.has(path)) return docs.get(path);
      return createEntry(path, data && data.content, data && data.mtime);
    });
    loading.set(path, p);
    const done = () => loading.delete(path);
    p.then(done, done);
    return p;
  }

  const isUnsaved = (entry) => !entry.doc.isClean(entry.cleanGen);
  function updateDirty(entry) {
    entry.needsDirty = false;
    const dirty = !entry.closed && (isUnsaved(entry) || entry.hunks.length > 0);
    if (dirty === entry.dirty) return;
    entry.dirty = dirty;
    T.bus.emit("file:dirty", { path: entry.path, dirty, pending: entry.hunks.length });
  }
  function runOp(entry, fn) {
    if (cm && current === entry) return cm.operation(fn);
    return fn();
  }

  // Every change (typing, AI edits, undo, reloads) lands here; checks run once per tick.
  let flushQueued = false;
  function onDocChange(entry, change) {
    if (entry.closed) return;
    if (entry.hunks.length) entry.needsCheck = true;
    entry.needsDirty = true;
    if (change.origin !== "texc-reload") scheduleAutosave(entry);
    if (!flushQueued) { flushQueued = true; Promise.resolve().then(flushChecks); }
  }
  function flushChecks() {
    flushQueued = false;
    for (const entry of docs.values()) {
      if (entry.needsCheck) revalidate(entry, false);
      if (entry.needsDirty) updateDirty(entry);
    }
  }

  // ------------------------------------------------------------------ view: open / show / close
  function ensureInit() {
    if (!cm) init();
  }
  function showState(kind, path, err) {
    if (!stateEl) return;
    stateEl.hidden = false;
    stateEl.className = "texc-ed-state is-" + kind;
    stateEl.textContent = "";
    const line = document.createElement("div");
    if (kind === "loading") {
      const sp = document.createElement("span");
      sp.className = "texc-spinner";
      stateEl.appendChild(sp);
      line.textContent = `Loading ${baseName(path)}…`;
      stateEl.appendChild(line);
    } else if (kind === "error") {
      const why = err && err.status === 415 ? "it isn't a text file" : err && err.status === 404 ? "it no longer exists" : errText(err);
      line.className = "texc-ed-err";
      line.textContent = `Couldn't open ${baseName(path)}: ${why}`;
      stateEl.appendChild(line);
      if (!err || (err.status !== 415 && err.status !== 404 && err.status !== 400)) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = "Try again";
        b.addEventListener("click", () => { open(path).catch(() => {}); });
        stateEl.appendChild(b);
      }
    } else {
      line.textContent = "No file open";
      stateEl.appendChild(line);
    }
  }
  function hideState() { if (stateEl) stateEl.hidden = true; }

  function showEntry(entry) {
    hideState();
    if (calc) hideCalc();
    if (isTexPath(entry.path)) warmCalc();
    if (current !== entry) {
      current = entry;
      cm.swapDoc(entry.doc);
      // highlighting state and hanging indent of the red blocks depend on the live view
      if (entry.hunks.length) revalidate(entry, true);
    }
    scheduleSelection();
  }

  async function open(path, pos) {
    ensureInit();
    path = normPath(path);
    if (!path) throw new Error("no file given");
    const seq = ++viewSeq;
    let entry = docs.get(path);
    if (!entry) {
      const t = setTimeout(() => { if (seq === viewSeq) showState("loading", path); }, 120);
      try {
        entry = await load(path);
      } catch (err) {
        clearTimeout(t);
        if (seq === viewSeq) {
          showState("error", path, err);
          current = null;
          if (cm.getDoc() !== blankDoc) cm.swapDoc(blankDoc);
        }
        throw err;
      }
      clearTimeout(t);
      if (seq !== viewSeq || entry.closed) return path; // a later open/show took over
    }
    showEntry(entry);
    if (pos && pos.line > 0) jumpTo(entry, pos.line - 1, pos.ch || 0, true);
    return path;
  }

  function show(path) {
    ensureInit();
    path = normPath(path);
    const entry = docs.get(path);
    if (!entry) return open(path);
    ++viewSeq;
    showEntry(entry);
    return Promise.resolve(path);
  }

  function close(path) {
    const entry = docs.get(normPath(path));
    if (!entry) return false;
    // Pending hunks end with the doc. They count as kept when the buffer (with them) is on disk.
    const kept = !isUnsaved(entry);
    const hs = entry.hunks.slice();
    runOp(entry, () => { for (const h of hs) detachHunk(h); syncLineClasses(entry); });
    for (const h of hs) emitResolved(h, kept, "closed");
    clearTimeout(entry.autosaveTimer);
    entry.closed = true;
    if (current === entry) {
      current = null;
      cm.swapDoc(blankDoc);
      showState("empty");
      scheduleSelection();
    }
    docs.delete(entry.path);
    if (entry.dirty) { entry.dirty = false; T.bus.emit("file:dirty", { path: entry.path, dirty: false, pending: 0 }); }
    return true;
  }

  function jumpTo(entry, line, ch, flashIt) {
    const doc = entry.doc;
    const l = clamp(line, doc.firstLine(), doc.lastLine());
    const c = clamp(ch || 0, 0, doc.getLine(l).length);
    doc.setCursor(Pos(l, c));
    if (current === entry) {
      revealLine(l);
      cm.focus();
    }
    if (flashIt) flashLine(entry, l);
  }
  function revealLine(line) {
    if (!host || !host.getClientRects().length) { pendingReveal = line; return; } // applied when shown
    const info = cm.getScrollInfo();
    const top = cm.heightAtLine(line, "local", true); // includes the hunk widget above the line
    const bottom = cm.heightAtLine(line, "local") + cm.defaultTextHeight();
    if (top >= info.top + 24 && bottom <= info.top + info.clientHeight - 24) return; // already visible
    cm.scrollTo(null, Math.max(0, top - Math.round(info.clientHeight * 0.3)));
  }
  function flashLine(entry, line) {
    const doc = entry.doc;
    const handle = doc.addLineClass(line, "background", "texc-flash");
    setTimeout(() => doc.removeLineClass(handle, "background", "texc-flash"), 1300);
  }

  async function goto(path, line, ch) {
    ensureInit();
    const p = path ? normPath(path) : current && current.path;
    if (!p) return null;
    await open(p, { line: Math.max(1, Number(line) || 1), ch: Number(ch) || 0 });
    return p;
  }

  // ------------------------------------------------------------------ saving
  function scheduleAutosave(entry) {
    clearTimeout(entry.autosaveTimer);
    entry.autosaveTimer = setTimeout(() => {
      entry.autosaveTimer = 0;
      // Files with pending AI hunks are saved once the last hunk is kept or undone.
      if (entry.closed || entry.conflict || entry.hunks.length || !isUnsaved(entry)) return;
      queueSave(entry, "auto");
    }, autosaveDelay);
  }

  // Saves run one after another per file; a save that finds nothing to write returns at once.
  function queueSave(entry, reason) {
    clearTimeout(entry.autosaveTimer);
    const run = () => writeEntry(entry, reason);
    const p = (entry.saveChain || Promise.resolve()).then(run, run);
    entry.saveChain = p.catch(() => false);
    return p;
  }

  async function writeEntry(entry, reason) {
    if (entry.closed || !isUnsaved(entry)) return true;
    if (entry.conflict) return false;
    const gen = entry.doc.changeGeneration(true);
    const text = entry.doc.getValue();
    entry.writing = true;
    try {
      const res = await T.api.put("/api/file", {
        path: entry.path,
        content: entry.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text,
        base_mtime: entry.mtime || undefined,
      });
      entry.writing = false;
      markSaved(entry, gen, res, reason);
      return true;
    } catch (err) {
      entry.writing = false;
      if (entry.closed) return false; // closed while the write was in flight: nobody to ask
      if (err && err.status === 409) return resolveConflict(entry);
      if (!entry.saveErrorShown) {
        entry.saveErrorShown = true;
        toast(`Couldn't save ${baseName(entry.path)}: ${errText(err)}`, "error");
      }
      // try again a little later while the changes are still unsaved
      clearTimeout(entry.autosaveTimer);
      entry.autosaveTimer = setTimeout(() => { if (!entry.closed && !entry.hunks.length && isUnsaved(entry)) queueSave(entry, "retry"); }, 5000);
      return false;
    }
  }

  function markSaved(entry, gen, res, reason) {
    if (res && res.mtime) entry.mtime = res.mtime;
    entry.cleanGen = gen;
    entry.saveErrorShown = false;
    updateDirty(entry);
    T.bus.emit("file:saved", { path: entry.path, mtime: entry.mtime, reason });
  }

  // 409 from PUT /api/file: the file changed on disk after we loaded it.
  async function resolveConflict(entry) {
    entry.conflict = true;
    const name = baseName(entry.path);
    try {
      const overwrite = await confirmBox(
        `${name} was changed on disk by another program. Overwrite it with the version in the editor, or reload it from disk?`,
        { ok: "Overwrite", cancel: "Reload from disk", title: "File changed on disk" }
      );
      if (entry.closed) return false;
      if (overwrite) {
        const gen = entry.doc.changeGeneration(true);
        const text = entry.doc.getValue();
        const res = await T.api.put("/api/file", { path: entry.path, content: entry.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text });
        markSaved(entry, gen, res, "overwrite");
        return true;
      }
      const data = await T.api.get("/api/file", { path: entry.path });
      applyDiskText(entry, data);
      toast(`Reloaded ${name} from disk. ${IS_MAC ? "⌘Z" : "Ctrl+Z"} brings your version back.`, "info");
      return false;
    } catch (err) {
      toast(`Couldn't resolve the conflict on ${name}: ${errText(err)}`, "error");
      return false;
    } finally {
      entry.conflict = false;
    }
  }

  function save(path) {
    const entry = path ? docs.get(normPath(path)) : current;
    if (!entry) return Promise.resolve(false);
    return queueSave(entry, "manual");
  }
  async function saveAll() {
    // Files with pending AI hunks are not written here (compile and other files' saves call this);
    // they are saved once their last hunk is kept or undone, or by an explicit save(path).
    const list = [...docs.values()].filter((e) => !e.closed && !e.hunks.length && isUnsaved(e));
    const res = await Promise.all(list.map((e) => queueSave(e, "manual").catch(() => false)));
    return res.every(Boolean);
  }

  // ------------------------------------------------------------------ external changes
  // Replaces only the region that differs, so the cursor, scroll, undo history and hunks outside
  // the region survive. The reload is one undoable step.
  function replaceDiffering(entry, text) {
    const doc = entry.doc;
    const cur = doc.getValue();
    if (cur === text) return false;
    let a = 0;
    const max = Math.min(cur.length, text.length);
    while (a < max && cur.charCodeAt(a) === text.charCodeAt(a)) a++;
    let b = 0;
    while (b < max - a && cur.charCodeAt(cur.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++;
    const from = doc.posFromIndex(a), to = doc.posFromIndex(cur.length - b);
    runOp(entry, () => doc.replaceRange(text.slice(a, text.length - b), from, to, "texc-reload"));
    return true;
  }
  function applyDiskText(entry, data) {
    const raw = String((data && data.content) || "");
    if (/\r\n/.test(raw)) entry.eol = "\r\n";
    replaceDiffering(entry, nl(raw));
    entry.cleanGen = entry.doc.changeGeneration(true);
    if (data && data.mtime) entry.mtime = data.mtime;
    updateDirty(entry);
  }
  function setContent(path, text, opts) {
    const entry = docs.get(normPath(path));
    if (!entry) return false;
    replaceDiffering(entry, nl(text));
    if (!opts || opts.clean !== false) entry.cleanGen = entry.doc.changeGeneration(true);
    if (opts && opts.mtime) entry.mtime = opts.mtime;
    updateDirty(entry);
    return true;
  }

  async function onFileChanged(d) {
    const path = normPath(d && d.path);
    if (!path) return;
    invalidateCache(path);
    const entry = docs.get(path);
    if (!entry || entry.conflict) return;
    if (entry.writing && entry.saveChain) await entry.saveChain; // our own write may be the change
    if (entry.closed || entry.conflict) return;
    if (d.mtime && entry.mtime && d.mtime <= entry.mtime) return; // nothing newer than what we have
    const busy = () => isUnsaved(entry) || entry.hunks.length > 0;
    const warn = () => {
      if (entry.warnedMtime === d.mtime) return;
      entry.warnedMtime = d.mtime;
      toast(`${baseName(path)} changed on disk. Your unsaved edits are kept; saving will ask before overwriting.`, "warn");
    };
    if (busy()) { warn(); return; }
    try {
      const data = await T.api.get("/api/file", { path });
      if (entry.closed) return;
      if (busy()) { warn(); return; }
      applyDiskText(entry, data);
    } catch (err) {
      if (err && err.status === 404) toast(`${baseName(path)} was moved or deleted on disk. The editor keeps its text; saving recreates the file.`, "warn");
    }
  }

  // ------------------------------------------------------------------ AI edits: matching
  function findMatch(entry, search, replace) {
    const doc = entry.doc;
    const text = doc.getValue();
    const name = baseName(entry.path);
    // 1. exact
    const idx = text.indexOf(search);
    if (idx >= 0) {
      if (text.indexOf(search, idx + 1) >= 0) {
        return { ok: false, reason: `The SEARCH text matches ${countOccurrences(text, search)} places in ${name}; it must match exactly one` };
      }
      return { ok: true, from: doc.posFromIndex(idx), to: doc.posFromIndex(idx + search.length), replace };
    }
    // 2. whitespace-tolerant: words in order, any run of whitespace between them
    const core = search.trim();
    if (!core) return { ok: false, reason: "The SEARCH text is only whitespace" };
    const re = new RegExp(core.split(/\s+/).map(reEsc).join("\\s+"), "g");
    const hits = [];
    let m;
    while ((m = re.exec(text)) && hits.length < 100) hits.push(m);
    if (hits.length === 1) {
      const lead = /^\s*/.exec(search)[0], trail = /\s*$/.exec(search)[0];
      return {
        ok: true,
        from: doc.posFromIndex(hits[0].index),
        to: doc.posFromIndex(hits[0].index + hits[0][0].length),
        replace: stripShared(replace, lead, trail),
      };
    }
    if (hits.length > 1) {
      return { ok: false, reason: `The SEARCH text matches ${hits.length} places in ${name} (ignoring whitespace); it must match exactly one` };
    }
    // 3. not found: say so more helpfully when it matches the text under a pending AI edit
    if (entry.hunks.length) {
      const base = baseText(entry);
      re.lastIndex = 0;
      if (base.indexOf(search) >= 0 || re.test(base)) {
        return { ok: false, reason: `The SEARCH text overlaps an AI edit in ${name} that is still pending; keep or undo that edit first` };
      }
    }
    return { ok: false, reason: `The SEARCH text was not found in ${name}` };
  }
  function countOccurrences(text, s) {
    let n = 0;
    for (let i = text.indexOf(s); i >= 0 && n < 1000; i = text.indexOf(s, i + 1)) n++;
    return n;
  }
  // When the whitespace-tolerant match drops the SEARCH's own leading/trailing whitespace, the
  // same whitespace is dropped from the replacement, so it is not inserted twice.
  function stripShared(rep, lead, trail) {
    if (lead) {
      if (rep.startsWith(lead)) rep = rep.slice(lead.length);
      else { const rl = /^\s*/.exec(rep)[0]; if (rl && lead.startsWith(rl)) rep = rep.slice(rl.length); }
    }
    if (trail) {
      if (rep.endsWith(trail)) rep = rep.slice(0, rep.length - trail.length);
      else { const rt = /\s*$/.exec(rep)[0]; if (rt && trail.endsWith(rt)) rep = rep.slice(0, rep.length - rt.length); }
    }
    return rep;
  }
  // The document text with every pending hunk replaced by its old text.
  function baseText(entry) {
    const doc = entry.doc;
    let out = "", at = Pos(doc.firstLine(), 0);
    for (const h of sortedHunks(entry)) {
      const r = h.marker.find();
      if (!r) continue;
      out += doc.getRange(at, r.from) + h.oldText;
      at = r.to;
    }
    return out + doc.getRange(at, docEnd(doc));
  }

  // ------------------------------------------------------------------ AI edits: applying
  /* hunk = { ids[], entry, oldText, marker (TextMarker over the whole lines it covers), widget,
              widgetAbove, insMarks[], model, sig, resolved } */
  function rangesOverlap(a1, a2, b1, b2) {
    if (cmp(b1, b2) === 0) return cmp(a1, b1) <= 0 && cmp(b1, a2) <= 0;
    return cmp(a1, b2) < 0 && cmp(b1, a2) < 0;
  }

  // Applies one replacement and turns it into a hunk. The hunk tracks whole lines, from the start
  // of the first changed line to the start of the line after the last one. That keeps its marker
  // non-empty, so edits at the edges or Undo of a neighbour can never collapse or swallow it.
  // A change whose lines overlap a pending hunk is merged into it (the ids are combined).
  function hunkSpan(doc, from, to, text) {
    const lastLine = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
    let ea = Pos(from.line, 0);
    let eb = lastLine < doc.lastLine() ? Pos(lastLine + 1, 0) : docEnd(doc);
    if (!text && cmp(ea, from) === 0 && cmp(eb, to) === 0) {
      // Deleting whole lines would leave nothing to track: take in the next line too, or the
      // previous one at the end of the file.
      if (eb.line < doc.lastLine()) eb = Pos(eb.line + 1, 0);
      else if (cmp(eb, docEnd(doc)) < 0) eb = docEnd(doc);
      else if (ea.line > doc.firstLine()) ea = Pos(ea.line - 1, 0);
    }
    return [ea, eb];
  }

  function applyChange(entry, from, to, text, id) {
    const doc = entry.doc;
    const [ea, eb] = hunkSpan(doc, from, to, text);
    let u1 = ea, u2 = eb;
    const overlapping = [];
    for (const h of entry.hunks) {
      const r = h.marker.find();
      if (!r || !rangesOverlap(ea, eb, r.from, r.to)) continue;
      overlapping.push({ h, r });
      if (cmp(r.from, u1) < 0) u1 = r.from;
      if (cmp(r.to, u2) > 0) u2 = r.to;
    }
    overlapping.sort((x, y) => cmp(x.r.from, y.r.from));
    let oldText = "", at = u1;
    for (const { h, r } of overlapping) { oldText += doc.getRange(at, r.from) + h.oldText; at = r.to; }
    oldText += doc.getRange(at, u2);
    const startIdx = doc.indexFromPos(u1);
    const tail = docLength(doc) - doc.indexFromPos(u2);
    const ids = [];
    for (const { h } of overlapping) { ids.push(...h.ids); detachHunk(h); }
    ids.push(id);
    doc.changeGeneration(true); // its own undo step, never merged with typing
    doc.replaceRange(text, from, to, "texc-ai");
    doc.changeGeneration(true);
    const n1 = doc.posFromIndex(startIdx), n2 = doc.posFromIndex(docLength(doc) - tail);
    const empty = cmp(n1, n2) === 0; // only when the whole file became empty
    const marker = doc.markText(n1, n2, { inclusiveLeft: empty, inclusiveRight: empty, clearWhenEmpty: false });
    const hunk = { ids, entry, oldText, marker, widget: null, widgetAbove: true, insMarks: [], model: null, sig: "", resolved: false };
    entry.hunks.push(hunk);
    return hunk;
  }

  function applyEdit(entry, edit, res, meta) {
    const doc = entry.doc;
    const search = nl(edit.search);
    let replace = nl(edit.replace);
    meta.entry = entry;
    let from, to;
    if (search.trim() === "") {
      if (doc.getValue().trim() !== "") {
        res.reason = `An empty SEARCH only creates new files, and ${baseName(entry.path)} already exists`;
        return;
      }
      from = Pos(doc.firstLine(), 0);
      to = docEnd(doc);
    } else {
      const m = findMatch(entry, search, replace);
      if (!m.ok) { res.reason = m.reason; return; }
      from = m.from; to = m.to; replace = m.replace;
    }
    const before = doc.getRange(from, to);
    const pre = doc.getLine(from.line).slice(0, from.ch), post = doc.getLine(to.line).slice(to.ch);
    const stats = lineStats((pre + before + post).split("\n"), (pre + replace + post).split("\n"));
    res.added = stats.added;
    res.removed = stats.removed;
    meta.line0 = from.line;
    res.ok = true;
    if (before === replace) { meta.noChange = true; return; }
    applyChange(entry, from, to, replace, res.id);
  }

  async function createFile(path, content) {
    try {
      await T.api.post("/api/file/new", { path, type: "file" });
    } catch (err) {
      if (err && err.status === 409) throw new Error("it was created by someone else in the meantime");
      throw err;
    }
    const res = await T.api.put("/api/file", { path, content });
    invalidateCache(path);
    T.bus.emit("file:saved", { path, mtime: res && res.mtime, reason: "create" });
    return res;
  }

  /* reviewEdits([{id, path, search, replace}]) -> [{id, path, ok, reason?, added, removed, location, line}]
     Edits are applied in order; each SEARCH is matched against the text as left by the previous ones. */
  async function reviewEdits(edits) {
    ensureInit();
    const list = (Array.isArray(edits) ? edits : edits ? [edits] : []).map((e) => e || {});
    const results = list.map((e, i) => ({
      id: e.id != null ? e.id : `edit-${Date.now().toString(36)}-${i}`,
      path: normPath(e.path), ok: false, reason: "", added: 0, removed: 0, location: "", line: 0,
    }));
    const meta = list.map(() => ({ entry: null, line0: -1, created: false, noChange: false }));
    // 1. load each file once, in order of first use; an empty SEARCH on a missing file creates it
    const prepared = new Map();
    for (let i = 0; i < list.length; i++) {
      const path = results[i].path;
      if (prepared.has(path)) continue;
      if (!path) { prepared.set(path, { error: "The edit names no file" }); continue; }
      try {
        prepared.set(path, { entry: await load(path) });
      } catch (err) {
        if (err && err.status === 404) {
          const replace = nl(list[i].replace);
          if (nl(list[i].search).trim() !== "") { prepared.set(path, { error: `The file ${path} does not exist` }); continue; }
          try {
            await createFile(path, replace);
            Object.assign(results[i], { ok: true, location: "new file", line: 1, added: countLines(replace), removed: 0 });
            meta[i].created = true;
            try { prepared.set(path, { entry: await load(path) }); } catch (e2) { prepared.set(path, { error: `Couldn't read ${baseName(path)}: ${errText(e2)}` }); }
          } catch (e3) {
            prepared.set(path, { error: `Couldn't create ${path}: ${errText(e3)}` });
          }
        } else if (err && err.status === 415) {
          prepared.set(path, { error: `Can't edit ${baseName(path)}: it is not a text file` });
        } else {
          prepared.set(path, { error: `Couldn't read ${baseName(path)}: ${errText(err)}` });
        }
      }
    }
    // 2. apply in order, synchronously (one CodeMirror operation for the visible file)
    const touched = new Set();
    const applyAll = () => {
      list.forEach((e, i) => {
        if (meta[i].created) return;
        const prep = prepared.get(results[i].path);
        if (!prep || !prep.entry) { results[i].reason = (prep && prep.error) || "File not found"; return; }
        if (prep.entry.closed) { results[i].reason = `${baseName(prep.entry.path)} was closed while the edits were applied`; return; }
        try {
          applyEdit(prep.entry, e, results[i], meta[i]);
          touched.add(prep.entry);
        } catch (err) {
          console.error("[editor] edit failed", err);
          results[i].ok = false;
          results[i].reason = `Couldn't apply the edit: ${errText(err)}`;
        }
      });
    };
    if (cm) cm.operation(applyAll); else applyAll();
    // 3. draw the review UI, then report where each change ended up
    for (const entry of touched) { revalidate(entry, true); updateDirty(entry); }
    const marks = new Map();
    results.forEach((r, i) => {
      if (!r.ok || meta[i].created) return;
      const entry = meta[i].entry;
      const h = findHunk(r.id);
      const reg = h && hunkRegion(h);
      const line0 = reg ? reg.start : Math.max(0, Math.min(meta[i].line0, entry.doc.lastLine()));
      if (!marks.has(entry)) marks.set(entry, landmarks(entry.doc));
      r.line = line0 + 1;
      r.location = locationAt(marks.get(entry), line0);
      if (meta[i].noChange) r.reason = "No change"; // nothing to review
    });
    // Created files and no-op edits have nothing to review: report them as kept. (A hunk that
    // retired while being drawn has already reported itself.)
    results.forEach((r, i) => {
      if (r.ok && (meta[i].created || meta[i].noChange)) T.bus.emit("edits:resolved", { id: r.id, path: r.path, kept: true, reason: meta[i].created ? "created" : "unchanged" });
    });
    return results;
  }

  // ------------------------------------------------------------------ AI edits: diffing
  const TOKEN_RE = /\\[A-Za-z@]+|[\p{L}\p{N}_]+|[ \t]+|\n|[^]/gu;
  function wordDiff(aStr, bStr) {
    const A = aStr.match(TOKEN_RE) || [], B = bStr.match(TOKEN_RE) || [];
    let pre = 0;
    while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
    let suf = 0;
    while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
    const n = A.length - pre - suf, m = B.length - pre - suf;
    const keepA = new Uint8Array(A.length).fill(1), keepB = new Uint8Array(B.length).fill(1);
    for (let i = pre; i < pre + n; i++) keepA[i] = 0;
    for (let j = pre; j < pre + m; j++) keepB[j] = 0;
    if (n > 0 && m > 0) {
      if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null;
      const ids = new Map();
      const intern = (t) => { let v = ids.get(t); if (v === undefined) { v = ids.size; ids.set(t, v); } return v; };
      const a = new Int32Array(n), b = new Int32Array(m);
      for (let i = 0; i < n; i++) a[i] = intern(A[pre + i]);
      for (let j = 0; j < m; j++) b[j] = intern(B[pre + j]);
      const W = m + 1, L = new Uint16Array((n + 1) * W); // L[i][j] = LCS of a[i..], b[j..]
      for (let i = n - 1; i >= 0; i--) {
        const row = i * W, next = row + W;
        for (let j = m - 1; j >= 0; j--) {
          L[row + j] = a[i] === b[j] ? L[next + j + 1] + 1 : L[next + j] >= L[row + j + 1] ? L[next + j] : L[row + j + 1];
        }
      }
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (a[i] === b[j]) { keepA[pre + i] = 1; keepB[pre + j] = 1; i++; j++; }
        else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++;
        else j++;
      }
    }
    return { del: changedRanges(aStr, A, keepA), ins: changedRanges(bStr, B, keepB) };
  }
  // Char ranges of the changed tokens; ranges separated only by blanks merge into one highlight,
  // and a range that starts with a blank slides right ("␣small" -> "small␣") when the text allows.
  function changedRanges(str, toks, keep) {
    const out = [];
    let off = 0;
    for (let i = 0; i < toks.length; i++) {
      const len = toks[i].length;
      if (!keep[i] && toks[i] !== "\n") {
        const last = out[out.length - 1];
        if (last && (last[1] === off || /^[ \t]+$/.test(str.slice(last[1], off)))) last[1] = off + len;
        else out.push([off, off + len]);
      }
      off += len;
    }
    for (const r of out) {
      while (r[1] < str.length && /[ \t]/.test(str[r[0]]) && str[r[1]] === str[r[0]]) { r[0]++; r[1]++; }
    }
    return out;
  }
  // Splits [from, to) offsets of lines.join("\n") into per-line [from, to) pairs.
  function rangesByLine(lines, ranges) {
    const per = lines.map(() => []);
    const starts = [];
    let off = 0;
    for (const l of lines) { starts.push(off); off += l.length + 1; }
    for (const [a, b] of ranges) {
      let li = 0;
      while (li + 1 < starts.length && starts[li + 1] <= a) li++;
      for (; li < lines.length && starts[li] < b; li++) {
        const s0 = Math.max(a, starts[li]) - starts[li], e0 = Math.min(b, starts[li] + lines[li].length) - starts[li];
        if (e0 > s0) per[li].push([s0, e0]);
      }
    }
    return per;
  }
  // Line counts for the change cards (+added / -removed), like a line diff.
  function lineStats(oldLines, newLines) {
    let p = 0;
    while (p < oldLines.length && p < newLines.length && oldLines[p] === newLines[p]) p++;
    let s = 0;
    while (s < oldLines.length - p && s < newLines.length - p && oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]) s++;
    const a = oldLines.slice(p, oldLines.length - s), b = newLines.slice(p, newLines.length - s);
    if (!a.length || !b.length || a.length * b.length > 250000) return { added: b.length, removed: a.length };
    let prev = new Uint32Array(b.length + 1), cur = new Uint32Array(b.length + 1);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) cur[j] = a[i] === b[j] ? prev[j + 1] + 1 : Math.max(prev[j], cur[j + 1]);
      [prev, cur] = [cur, prev];
    }
    return { added: b.length - prev[0], removed: a.length - prev[0] };
  }

  // ------------------------------------------------------------------ AI edits: rendering
  // The model compares the hunk's current lines with what Undo would produce (current prefix and
  // suffix of the first/last line around the old text), minus the lines both share.
  function buildModel(entry, h) {
    const r = h.marker.find();
    if (!r) return null;
    const doc = entry.doc;
    const F = r.from, E = r.to;
    const oldLines = (doc.getLine(F.line).slice(0, F.ch) + h.oldText + doc.getLine(E.line).slice(E.ch)).split("\n");
    const newLines = [];
    for (let l = F.line; l <= E.line; l++) newLines.push(doc.getLine(l));
    let p = 0;
    while (p < oldLines.length && p < newLines.length && oldLines[p] === newLines[p]) p++;
    let s = 0;
    while (s < oldLines.length - p && s < newLines.length - p && oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]) s++;
    return {
      p,
      oldCh: oldLines.slice(p, oldLines.length - s),
      newCh: newLines.slice(p, newLines.length - s),
      sig: `${F.ch}:${E.ch}:${newLines.join("\n")}`,
    };
  }
  function hunkRegion(h) {
    if (!h.model || h.resolved) return null;
    const r = h.marker.find();
    if (!r) return null;
    const start = r.from.line + h.model.p;
    return { start, end: start + Math.max(1, h.model.newCh.length) - 1, count: h.model.newCh.length };
  }

  // Draws (or redraws) one hunk. Returns "gone" when its text was deleted, "noop" when the lines
  // read the same as before the edit, else "ok".
  function renderHunk(entry, h, force) {
    const model = buildModel(entry, h);
    if (!model) return "gone";
    if (!model.oldCh.length && !model.newCh.length) return "noop";
    const sig = `${model.sig}|${layoutRev}|${entry === current ? 1 : 0}`;
    if (!force && sig === h.sig && h.widget) { h.model = model; return "ok"; }
    h.sig = sig;
    h.model = model;
    const doc = entry.doc;
    const start = h.marker.find().from.line + model.p;
    const oldBlock = model.oldCh.join("\n"), newBlock = model.newCh.join("\n");
    // word-level highlights only where both sides exist (pure insertions/deletions just get tints)
    const diff = model.oldCh.length && model.newCh.length ? wordDiff(oldBlock, newBlock) : null;
    for (const mk of h.insMarks) mk.clear();
    h.insMarks = [];
    if (diff) {
      rangesByLine(model.newCh, diff.ins).forEach((segs, i) => {
        for (const [a, b] of segs) {
          h.insMarks.push(doc.markText(Pos(start + i, a), Pos(start + i, b), { className: "texc-ins", startStyle: "texc-ins-s", endStyle: "texc-ins-e" }));
        }
      });
    }
    const node = buildWidget(entry, h, model, start, diff ? rangesByLine(model.oldCh, diff.del) : null);
    let anchor = start, above = true;
    if (!model.newCh.length && start > doc.lastLine()) { anchor = doc.lastLine(); above = false; }
    const handle = doc.getLineHandle(anchor);
    if (h.widget && h.widget.line === handle && h.widgetAbove === above && h.widgetNode) {
      h.widgetNode.replaceChildren(...node.childNodes);
      h.widget.changed();
    } else {
      if (h.widget) h.widget.clear();
      h.widgetNode = node;
      h.widget = doc.addLineWidget(handle, node, { above, coverGutter: false });
      h.widgetAbove = above;
    }
    return "ok";
  }

  function buildWidget(entry, h, model, start, delPer) {
    const root = document.createElement("div");
    root.className = "texc-hunk";
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "Proposed AI edit");
    const bar = document.createElement("div");
    bar.className = "texc-hunk-bar";
    bar.appendChild(pill("Undo", KEYS.undo, "texc-pill-undo", () => resolveHunk(h, false)));
    bar.appendChild(pill("Keep", KEYS.keep, "texc-pill-keep", () => resolveHunk(h, true)));
    root.appendChild(bar);
    if (model.oldCh.length) {
      const old = document.createElement("div");
      old.className = "texc-old";
      old.setAttribute("aria-label", "Original text");
      const toks = highlightLines(model.oldCh, entry.mode, modeStateBefore(entry, start));
      model.oldCh.forEach((text, i) => {
        const ln = document.createElement("div");
        ln.className = "texc-old-line";
        const off = hangPx(text);
        if (off) { ln.style.textIndent = `-${off}px`; ln.style.paddingLeft = `${BASE_PAD + off}px`; }
        renderTokens(ln, text, toks[i], delPer ? delPer[i] : []);
        old.appendChild(ln);
      });
      root.appendChild(old);
    }
    return root;
  }
  function pill(label, key, cls, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `texc-pill ${cls}`;
    b.tabIndex = -1;
    b.title = `${label} this change (${key})`;
    b.innerHTML = `${label} <span class="texc-kbd">${key}</span>`;
    b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor focused
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    return b;
  }
  function modeStateBefore(entry, line) {
    if (cm && current === entry && line > 0) {
      try { return cm.getStateAfter(line - 1, true); } catch (_) { /* fall back to the start state */ }
    }
    return null;
  }
  // A tiny runMode: tokens of each line, continuing the mode state across lines.
  function highlightLines(lines, modeSpec, startState) {
    const mode = CM.getMode({ indentUnit: INDENT_UNIT, tabSize: TAB_SIZE }, modeSpec);
    const state = startState ? CM.copyState(mode, startState) : CM.startState(mode);
    return lines.map((text) => {
      const toks = [];
      if (!text) { if (mode.blankLine) mode.blankLine(state); return toks; }
      const stream = new CM.StringStream(text, TAB_SIZE);
      while (!stream.eol()) {
        const style = mode.token(stream, state);
        if (stream.pos <= stream.start) stream.pos = stream.start + 1;
        toks.push({ from: stream.start, to: stream.pos, style });
        stream.start = stream.pos;
      }
      return toks;
    });
  }
  // Old-text line: syntax-coloured tokens; each removed run is wrapped in one span.texc-del.
  function renderTokens(el, text, toks, dels) {
    const del = new Uint8Array(text.length);
    for (const [a, b] of dels) del.fill(1, a, b);
    // merge neighbouring tokens of the same style (like CodeMirror's flattenSpans)
    const flat = [];
    for (const t of toks.length ? toks : [{ from: 0, to: text.length, style: null }]) {
      const last = flat[flat.length - 1];
      if (last && last.style === t.style && last.to === t.from) last.to = t.to;
      else flat.push({ from: t.from, to: t.to, style: t.style });
    }
    let wrap = null; // current .texc-del wrapper
    for (const t of flat) {
      for (let i = t.from; i < t.to;) {
        const d = del[i];
        let j = i + 1;
        while (j < t.to && del[j] === d) j++;
        const piece = text.slice(i, j);
        let node;
        if (t.style) {
          node = document.createElement("span");
          node.className = t.style.split(" ").map((c) => "cm-" + c).join(" ");
          node.textContent = piece;
        } else {
          node = document.createTextNode(piece);
        }
        if (d) {
          if (!wrap) { wrap = document.createElement("span"); wrap.className = "texc-del"; el.appendChild(wrap); }
          wrap.appendChild(node);
        } else {
          wrap = null;
          el.appendChild(node);
        }
        i = j;
      }
    }
  }

  // Green tint + green line numbers for the new lines of every pending hunk in a doc.
  function syncLineClasses(entry) {
    const doc = entry.doc;
    const want = new Set();
    for (const h of entry.hunks) {
      const reg = hunkRegion(h);
      if (!reg) continue;
      for (let k = 0; k < reg.count; k++) if (reg.start + k <= doc.lastLine()) want.add(doc.getLineHandle(reg.start + k));
    }
    for (const lh of entry.decorated) {
      if (want.has(lh)) continue;
      doc.removeLineClass(lh, "background", "texc-hunk-bg");
      doc.removeLineClass(lh, "wrap", "texc-hunk-line");
    }
    for (const lh of want) {
      if (entry.decorated.has(lh)) continue;
      doc.addLineClass(lh, "background", "texc-hunk-bg");
      doc.addLineClass(lh, "wrap", "texc-hunk-line");
    }
    entry.decorated = want;
  }

  // Re-checks every hunk of a doc after changes: redraws those whose lines changed and retires
  // those whose text was deleted or now reads exactly as before.
  function revalidate(entry, force) {
    entry.needsCheck = false;
    const done = [];
    runOp(entry, () => {
      for (const h of entry.hunks.slice()) {
        const st = renderHunk(entry, h, force);
        if (st !== "ok") { detachHunk(h); done.push([h, st]); }
      }
      syncLineClasses(entry);
    });
    for (const [h, st] of done) emitResolved(h, false, st === "gone" ? "removed" : "unchanged");
    if (done.length) {
      updateDirty(entry);
      if (!entry.hunks.length) scheduleAutosave(entry);
    }
  }

  // ------------------------------------------------------------------ AI edits: resolving
  function detachHunk(h) {
    h.resolved = true;
    if (h.widget) { h.widget.clear(); h.widget = null; h.widgetNode = null; }
    for (const mk of h.insMarks) mk.clear();
    h.insMarks = [];
    if (h.marker) h.marker.clear();
    const list = h.entry.hunks, i = list.indexOf(h);
    if (i >= 0) list.splice(i, 1);
  }
  function emitResolved(h, kept, reason) {
    for (const id of h.ids) T.bus.emit("edits:resolved", { id, path: h.entry.path, kept: !!kept, reason });
  }
  function resolveHunk(h, keep, opts) {
    if (!h || h.resolved) return false;
    const entry = h.entry;
    runOp(entry, () => {
      const r = h.marker.find();
      detachHunk(h);
      if (!keep && r) {
        entry.doc.changeGeneration(true);
        entry.doc.replaceRange(h.oldText, r.from, r.to, "texc-undo");
        entry.doc.changeGeneration(true);
      }
      syncLineClasses(entry);
    });
    emitResolved(h, keep, keep ? "keep" : "undo");
    updateDirty(entry);
    if (!(opts && opts.noSave) && !entry.hunks.length) saveResolved(entry);
    return true;
  }
  // "When a file has no pending hunks left, it autosaves."
  function saveResolved(entry) {
    if (!entry.closed && !entry.conflict && isUnsaved(entry)) queueSave(entry, "resolve");
  }
  function sortedHunks(entry) {
    return entry.hunks
      .map((h) => ({ h, r: h.marker.find() }))
      .filter((x) => x.r)
      .sort((x, y) => cmp(x.r.from, y.r.from))
      .map((x) => x.h);
  }
  function findHunk(id) {
    for (const entry of docs.values()) for (const h of entry.hunks) if (h.ids.indexOf(id) >= 0) return h;
    return null;
  }
  function nearestHunk(entry) {
    const line = entry.doc.getCursor().line;
    let best = null, bestD = Infinity;
    for (const h of sortedHunks(entry)) {
      const reg = hunkRegion(h);
      if (!reg) continue;
      const d = line < reg.start ? reg.start - line : line > reg.end ? line - reg.end : 0;
      if (d < bestD) { best = h; bestD = d; }
    }
    return best;
  }
  function resolve(id, keep) {
    const h = findHunk(id);
    return h ? resolveHunk(h, !!keep) : false;
  }
  function resolveAll(path, keep) {
    if (typeof path === "boolean") { keep = path; path = undefined; }
    const entries = path ? [docs.get(normPath(path))].filter(Boolean) : [...docs.values()];
    let n = 0;
    for (const entry of entries) {
      const hs = sortedHunks(entry);
      if (!hs.length) continue;
      runOp(entry, () => { for (const h of hs) if (resolveHunk(h, !!keep, { noSave: true })) n++; });
      saveResolved(entry);
    }
    return n;
  }
  function pending(path) {
    const entries = path ? [docs.get(normPath(path))].filter(Boolean) : [...docs.values()];
    const ids = [];
    for (const entry of entries) for (const h of sortedHunks(entry)) ids.push(...h.ids);
    return ids;
  }
  async function revealHunk(id) {
    const h = findHunk(id);
    if (!h) return false;
    await show(h.entry.path);
    const reg = hunkRegion(h);
    if (!reg) return false;
    jumpTo(h.entry, reg.start, 0, false);
    return true;
  }

  // ------------------------------------------------------------------ location labels
  // "abstract line 3" inside a named environment, "<section title> line N" below a sectioning
  // command, otherwise "line N" (all lines 1-based).
  const NAMED_ENV = /^(?:abstract|keywords|acknowledg(?:e)?ments?|titlepage|frame)$/;
  const SECTION_RE = /\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/;
  function landmarks(doc) {
    const out = [];
    doc.eachLine((lh) => {
      if (lh.text.indexOf("\\") < 0) return;
      const t = stripComment(lh.text);
      const line = doc.getLineNumber(lh);
      const re = /\\(begin|end)\s*\{\s*([^}\s]+)\s*\}/g;
      let m;
      while ((m = re.exec(t))) if (NAMED_ENV.test(m[2])) out.push({ line, kind: m[1], name: m[2] });
      const sm = SECTION_RE.exec(t);
      if (sm) out.push({ line, kind: "section", title: cleanTitle(readBraced(t, sm.index + sm[0].length)) });
    });
    return out;
  }
  function locationAt(marks, line0) {
    const envs = [];
    let sec = null;
    for (const mk of marks) {
      if (mk.line >= line0) break;
      if (mk.kind === "begin") envs.push(mk);
      else if (mk.kind === "end") { for (let i = envs.length - 1; i >= 0; i--) if (envs[i].name === mk.name) { envs.splice(i); break; } }
      else sec = mk;
    }
    const env = envs[envs.length - 1];
    if (env && (!sec || env.line >= sec.line)) return `${env.name} line ${line0 - env.line}`;
    if (sec) return `${sec.title} line ${line0 - sec.line}`;
    return `line ${line0 + 1}`;
  }
  function readBraced(t, i) {
    let depth = 1, out = "";
    for (; i < t.length; i++) {
      const c = t[i];
      if (c === "\\" && i + 1 < t.length) { out += c + t[++i]; continue; }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
      out += c;
    }
    return out;
  }
  function cleanTitle(s) {
    let t = s.replace(/\\label\s*\{[^}]*\}/g, "").replace(/\\[A-Za-z@]+\*?\s*/g, "").replace(/\\(.)/g, "$1").replace(/[{}$~]/g, " ").replace(/\s+/g, " ").trim();
    if (!t) t = "Section";
    return t.length > 40 ? t.slice(0, 38).trimEnd() + "…" : t;
  }

  // ------------------------------------------------------------------ completion data
  // [name, snippet]; "#" marks the caret, "!" means "open the next completion afterwards".
  const COMMANDS = [
    "section{#}", "subsection{#}", "subsubsection{#}", "paragraph{#}", "chapter{#}", "part{#}", "section*{#}", "subsection*{#}",
    "begin{#}!", "end{#}!", "item ", "label{#}", "ref{#}!", "eqref{#}!", "cref{#}!", "Cref{#}!", "autoref{#}!", "pageref{#}!",
    "cite{#}!", "citep{#}!", "citet{#}!", "citealp{#}!", "citeauthor{#}!", "citeyear{#}!", "parencite{#}!", "textcite{#}!", "autocite{#}!", "nocite{#}!",
    "textbf{#}", "textit{#}", "emph{#}", "texttt{#}", "textsc{#}", "textsf{#}", "textrm{#}", "underline{#}", "footnote{#}", "caption{#}",
    "includegraphics[width=\\linewidth]{#}!", "input{#}!", "include{#}!", "usepackage{#}!", "documentclass{#}",
    "frac{#}{}", "dfrac{#}{}", "sqrt{#}", "sum", "prod", "int", "oint", "lim", "infty", "partial", "nabla", "cdot", "cdots", "ldots", "dots", "times", "pm", "mp",
    "leq", "geq", "neq", "approx", "equiv", "sim", "simeq", "propto", "ll", "gg", "in", "notin", "subset", "subseteq", "cup", "cap", "setminus", "emptyset",
    "forall", "exists", "to", "mapsto", "rightarrow", "leftarrow", "Rightarrow", "Leftarrow", "Leftrightarrow", "iff", "implies", "left", "right",
    "langle", "rangle", "hat{#}", "bar{#}", "tilde{#}", "widetilde{#}", "widehat{#}", "vec{#}", "dot{#}", "ddot{#}", "overline{#}", "underbrace{#}", "overbrace{#}", "binom{#}{}",
    "mathrm{#}", "mathbf{#}", "mathit{#}", "mathcal{#}", "mathbb{#}", "mathsf{#}", "mathfrak{#}", "mathscr{#}", "boldsymbol{#}", "operatorname{#}", "text{#}",
    "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi", "pi",
    "rho", "varrho", "sigma", "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega", "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Phi", "Psi", "Omega",
    "ell", "hbar", "circ", "star", "dagger", "perp", "parallel", "mid", "quad", "qquad", "log", "ln", "exp", "sin", "cos", "tan", "max", "min", "sup", "inf", "det",
    "title{#}", "author{#}", "date{#}", "today", "maketitle", "tableofcontents", "appendix", "thanks{#}", "abstract",
    "bibliography{#}!", "bibliographystyle{#}", "addbibresource{#}!", "printbibliography",
    "newcommand{#}{}", "renewcommand{#}{}", "newenvironment{#}{}{}", "DeclareMathOperator{#}{}", "newtheorem{#}{}",
    "url{#}", "href{#}{}", "mbox{#}", "textcolor{#}{}", "centering", "noindent", "newpage", "clearpage", "newline", "linebreak", "pagebreak",
    "vspace{#}", "hspace{#}", "vfill", "hfill", "smallskip", "medskip", "bigskip", "footnotesize", "scriptsize", "small", "normalsize", "large", "Large", "LARGE", "huge",
    "hline", "toprule", "midrule", "bottomrule", "cline{#}", "multicolumn{#}{}{}", "multirow{#}{}{}", "linewidth", "textwidth", "columnwidth", "LaTeX", "TeX",
  ].map((s) => {
    const chain = s.endsWith("!");
    const snippet = chain ? s.slice(0, -1) : s;
    const name = /^[A-Za-z@]+\*?/.exec(snippet)[0];
    return { name, snippet, chain, label: "\\" + snippet.replace("#", "") };
  });
  const ENVIRONMENTS = [
    "itemize", "enumerate", "description", "equation", "equation*", "align", "align*", "gather", "gather*", "multline", "split", "cases",
    "figure", "figure*", "table", "table*", "tabular", "center", "abstract", "theorem", "lemma", "proposition", "corollary", "definition",
    "proof", "remark", "example", "quote", "quotation", "verbatim", "minipage", "array", "matrix", "pmatrix", "bmatrix", "vmatrix",
    "subfigure", "tikzpicture", "algorithm", "algorithmic", "lstlisting", "frame", "columns", "column", "block", "thebibliography",
    "document", "titlepage", "flushleft", "flushright", "wrapfigure",
  ];
  const PACKAGES = [
    "amsmath", "amssymb", "amsthm", "mathtools", "graphicx", "hyperref", "cleveref", "geometry", "natbib", "biblatex", "booktabs", "xcolor",
    "tikz", "pgfplots", "siunitx", "subcaption", "caption", "float", "enumitem", "listings", "minted", "algorithm", "algpseudocode",
    "algorithm2e", "multirow", "array", "tabularx", "longtable", "microtype", "fontenc", "inputenc", "lmodern", "babel", "csquotes", "url",
    "physics", "bm", "wrapfig", "setspace", "fancyhdr", "titlesec", "xspace", "lipsum", "todonotes", "authblk", "makecell", "threeparttable", "pdfpages",
  ];

  const cache = { files: null, tex: new Map(), bib: new Map(), loadedAt: 0, stale: true, loading: null };
  const CACHE_TTL = 20000; // the project file list is re-read at most this often while completing
  const cacheFresh = () => !cache.stale && !!cache.files && Date.now() - cache.loadedAt < CACHE_TTL;
  // Marks the completion data stale; the next refresh re-reads only files whose mtime changed.
  function invalidateCache() {
    cache.stale = true;
  }
  // Waits for a refresh when the data is stale (at most `ms`, then uses what is there).
  function freshCache(ms) {
    if (cacheFresh()) return null;
    const p = ensureCache().catch(() => {});
    return Promise.race([p, new Promise((r) => setTimeout(r, cache.files ? ms : 2500))]);
  }
  // Fetches the project file list plus every .tex and .bib file (only the ones that changed).
  function ensureCache() {
    if (cacheFresh()) return Promise.resolve();
    if (cache.loading) return cache.loading;
    cache.loading = (async () => {
      try {
        const proj = await T.api.get("/api/project");
        const files = ((proj && proj.files) || []).filter((f) => f && f.type === "file");
        cache.files = files;
        const want = new Set();
        const jobs = [];
        for (const f of files) {
          const isTex = /\.(tex|ltx)$/i.test(f.path), isBib = /\.bib$/i.test(f.path);
          if (!isTex && !isBib) continue;
          if ((f.size || 0) > (isBib ? 8e6 : 2e6)) continue;
          const store = isBib ? cache.bib : cache.tex;
          want.add(f.path);
          const have = store.get(f.path);
          if (have && have.mtime === f.mtime) continue;
          if (jobs.length < 250) jobs.push({ f, store });
        }
        for (const store of [cache.tex, cache.bib]) for (const p of [...store.keys()]) if (!want.has(p)) store.delete(p);
        let next = 0;
        const worker = async () => {
          while (next < jobs.length) {
            const { f, store } = jobs[next++];
            try {
              const d = await T.api.get("/api/file", { path: f.path });
              store.set(f.path, { mtime: f.mtime, text: nl(d && d.content), parsed: null });
            } catch (_) { /* unreadable: skip it */ }
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        cache.loadedAt = Date.now();
        cache.stale = false;
      } finally {
        cache.loading = null;
      }
    })();
    return cache.loading;
  }
  function liveTexts(re) {
    // text of every loaded doc (fresher than disk) plus cached files that aren't loaded
    const out = [];
    for (const e of docs.values()) if (re.test(e.path)) out.push([e.path, e.doc.getValue()]);
    for (const store of [cache.tex, cache.bib]) for (const [p, c] of store) if (re.test(p) && !docs.has(p)) out.push([p, c.text, c]);
    return out;
  }
  function collectLabels() {
    const out = [], seen = new Set();
    for (const [path, text] of liveTexts(/\.(tex|ltx)$/i)) {
      if (text.indexOf("\\label") < 0) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf("\\label") < 0) continue;
        const re = /\\label\s*\{([^{}]+)\}/g;
        const t = stripComment(lines[i]);
        let m;
        while ((m = re.exec(t))) {
          const key = m[1].trim();
          if (key && !seen.has(key)) { seen.add(key); out.push({ key, sub: `${baseName(path)}:${i + 1}` }); }
        }
      }
    }
    return out;
  }
  function collectBibKeys() {
    const out = [], seen = new Set();
    for (const [path, text, c] of liveTexts(/\.bib$/i)) {
      let parsed = c && c.parsed;
      if (!parsed) { parsed = parseBib(text); if (c) c.parsed = parsed; }
      for (const it of parsed) if (!seen.has(it.key)) { seen.add(it.key); out.push(it); }
      void path;
    }
    return out;
  }
  function parseBib(text) {
    const out = [];
    const re = /@\s*([A-Za-z]+)\s*[{(]\s*([^,\s{}()"#%'=]+)\s*,/g;
    let m;
    while ((m = re.exec(text))) {
      const type = m[1].toLowerCase();
      if (type === "string" || type === "comment" || type === "preamble") continue;
      const next = text.indexOf("\n@", re.lastIndex);
      const body = text.slice(re.lastIndex, Math.min(next < 0 ? text.length : next, re.lastIndex + 4000));
      const field = (name) => {
        const fm = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*([^\\n]*)`, "i").exec(body);
        return fm ? fm[1].replace(/[{}"]/g, "").replace(/,\s*$/, "").trim() : "";
      };
      const title = field("title"), year = (field("year") || field("date")).slice(0, 4);
      const who = shortAuthor(field("author") || field("editor"));
      out.push({ key: m[2], sub: [who, year].filter(Boolean).join(" ") + (title ? ` — ${title}` : "") });
    }
    return out;
  }
  function shortAuthor(a) {
    if (!a) return "";
    const names = a.split(/\s+and\s+/i);
    const first = names[0].trim();
    const last = first.indexOf(",") >= 0 ? first.split(",")[0].trim() : first.split(/\s+/).pop();
    return last + (names.length > 1 ? " et al." : "");
  }
  function userCommands() {
    const out = [], seen = new Set();
    for (const [, text] of liveTexts(/\.(tex|ltx|sty|cls)$/i)) {
      const re = /\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator|DeclareRobustCommand)\*?\s*\{?\\([A-Za-z@]+)\}?|\\def\\([A-Za-z@]+)/g;
      let m;
      while ((m = re.exec(text))) {
        const name = m[1] || m[2];
        if (name && !seen.has(name)) { seen.add(name); out.push({ name, snippet: name, chain: false, label: "\\" + name, sub: "macro" }); }
      }
    }
    return out;
  }
  function userEnvironments() {
    const out = [];
    for (const [, text] of liveTexts(/\.(tex|ltx|sty|cls)$/i)) {
      const re = /\\(?:newenvironment|newtheorem)\*?\s*\{([A-Za-z*]+)\}/g;
      let m;
      while ((m = re.exec(text))) out.push(m[1]);
    }
    return out;
  }

  // ------------------------------------------------------------------ completion
  const REF_CTX = /\\(?:[cCvV]?ref|eqref|autoref|pageref|nameref|labelcref|cpageref|[cC]refrange|subref)\*?\{([^{}]*)$/;
  const CITE_CTX = /\\[A-Za-z]*cite[A-Za-z]*\*?(?:\[[^\]]*\]){0,2}\{([^{}]*)$/;
  const ENV_CTX = /\\(begin|end)\s*\{([A-Za-z*]*)$/;
  const PKG_CTX = /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^{}]*)$/;
  const INPUT_CTX = /\\(input|include|subfile|includeonly)\{([^{}]*)$/;
  const GRAPHICS_CTX = /\\includegraphics\*?(?:\[[^\]]*\])?\{([^{}]*)$/;
  const BIBFILE_CTX = /\\(bibliography|addbibresource)(?:\[[^\]]*\])?\{([^{}]*)$/;
  const CMD_CTX = /\\([A-Za-z@]*)$/;
  const ARG_CONTEXTS = [REF_CTX, CITE_CTX, ENV_CTX, PKG_CTX, INPUT_CTX, GRAPHICS_CTX, BIBFILE_CTX];
  const HINT_OPTIONS = {
    hint: texHint,
    completeSingle: false,
    alignWithWord: true,
    closeOnUnfocus: true,
    closeCharacters: /[\s()[\]{};$,%]/, // not ":" (labels like sec:intro)
  };

  function rank(items, typed, keyOf, limit) {
    if (!typed) return items.slice(0, limit);
    const tl = typed.toLowerCase();
    const a = [], b = [], c = [];
    for (const it of items) {
      const k = keyOf(it);
      if (k.startsWith(typed)) a.push(it);
      else {
        const kl = k.toLowerCase();
        if (kl.startsWith(tl)) b.push(it);
        else if (kl.indexOf(tl) >= 0) c.push(it);
      }
    }
    return a.concat(b, c).slice(0, limit);
  }
  function renderHint(el, _data, item) {
    const main = document.createElement("span");
    main.className = "texc-hint-main";
    main.textContent = item.displayText || item.text;
    el.appendChild(main);
    if (item.sub) {
      const s = document.createElement("span");
      s.className = "texc-hint-sub";
      s.textContent = item.sub;
      el.appendChild(s);
    }
  }
  function extendOver(cmi, pos, re) {
    const line = cmi.getLine(pos.line);
    let e = pos.ch;
    while (e < line.length && re.test(line[e])) e++;
    return Pos(pos.line, e);
  }
  // Inside an argument, a pick replaces the rest of the key under the cursor, but only when the
  // argument visibly continues to a "," or "}" (otherwise the text after the cursor isn't ours).
  function keyEnd(cmi, pos) {
    const end = extendOver(cmi, pos, /[^,}\s]/);
    const c = cmi.getLine(pos.line).charAt(end.ch);
    return c === "}" || c === "," ? end : pos;
  }

  function texHint(cmi) {
    const cur = cmi.getCursor();
    const before = cmi.getLine(cur.line).slice(0, cur.ch);
    const type = cmi.getTokenTypeAt(cur) || "";
    if (/tex-comment|tex-verb/.test(type)) return null;
    let m;
    if ((m = REF_CTX.exec(before))) return keyHint(cmi, cur, m[1], "label");
    if ((m = CITE_CTX.exec(before))) return keyHint(cmi, cur, m[1], "cite");
    if ((m = ENV_CTX.exec(before))) return envHint(cmi, cur, m[1], m[2]);
    if ((m = PKG_CTX.exec(before))) {
      const typed = m[1].slice(m[1].lastIndexOf(",") + 1).replace(/^\s+/, "");
      return listHint(Pos(cur.line, cur.ch - typed.length), extendOver(cmi, cur, /[\w-]/), rank(PACKAGES, typed, (s) => s, 80).map((s) => ({ text: s })));
    }
    if ((m = INPUT_CTX.exec(before))) return fileHint(cmi, cur, m[2], /\.(tex|ltx)$/i, true);
    if ((m = GRAPHICS_CTX.exec(before))) return fileHint(cmi, cur, m[1], /\.(png|jpe?g|pdf|eps|svg|gif)$/i, false);
    if ((m = BIBFILE_CTX.exec(before))) return fileHint(cmi, cur, m[2], /\.bib$/i, m[1] === "bibliography");
    if ((m = CMD_CTX.exec(before))) {
      const bs = before.length - m[0].length;
      if (bs > 0 && before[bs - 1] === "\\" && !(bs > 1 && before[bs - 2] === "\\")) return null; // "\\" is a line break
      return cmdHint(cmi, cur, m[1]);
    }
    return null;
  }
  function listHint(from, to, list) {
    return list.length ? { list: list.map((it) => Object.assign({ render: renderHint }, it)), from, to } : null;
  }
  function cmdHint(cmi, cur, prefix) {
    const from = Pos(cur.line, cur.ch - prefix.length - 1);
    const to = extendOver(cmi, cur, /[A-Za-z@*]/);
    const items = COMMANDS.concat(userCommands().filter((u) => !COMMANDS.some((c) => c.name === u.name)));
    const ranked = rank(items, prefix, (it) => it.name, 150);
    if (!ranked.length || (ranked.length === 1 && ranked[0].name === prefix)) return null;
    return listHint(from, to, ranked.map((it) => ({ text: "\\" + it.name, displayText: it.label, sub: it.sub, item: it, hint: applyCommand })));
  }
  function applyCommand(cmi, data, c) {
    const it = c.item;
    const next = cmi.getLine(data.to.line).charAt(data.to.ch);
    let snippet = it.snippet;
    if ((next === "{" || next === "[") && /[{[]/.test(snippet)) snippet = it.name; // arguments are already there
    const caret = snippet.indexOf("#");
    cmi.replaceRange("\\" + snippet.replace("#", ""), data.from, data.to, "complete");
    if (caret >= 0) cmi.setCursor(Pos(data.from.line, data.from.ch + 1 + caret));
    if (it.chain && caret >= 0) setTimeout(() => startHint(cmi), 0);
  }
  function envHint(cmi, cur, kind, typed) {
    const from = Pos(cur.line, cur.ch - typed.length);
    let to = extendOver(cmi, cur, /[A-Za-z*]/);
    if (cmi.getLine(cur.line).charAt(to.ch) === "}") to = Pos(to.line, to.ch + 1);
    let names = ENVIRONMENTS.concat(userEnvironments().filter((n) => ENVIRONMENTS.indexOf(n) < 0));
    if (kind === "end") {
      const open = openEnvironment(cmi, cur);
      if (open) names = [open].concat(names.filter((n) => n !== open));
    }
    return listHint(from, to, rank(names, typed, (s) => s, 80).map((name) => ({ text: name, name, kind, hint: applyEnvironment })));
  }
  function applyEnvironment(cmi, data, c) {
    const lineText = cmi.getLine(data.from.line);
    const rest = lineText.slice(data.to.ch);
    const nextLine = data.from.line < cmi.lastLine() ? cmi.getLine(data.from.line + 1) : "";
    const indent = /^\s*/.exec(lineText)[0];
    const already = new RegExp(`^${reEsc(indent)}\\\\end\\s*\\{`).test(nextLine);
    if (c.kind === "end" || rest.trim() !== "" || already) {
      cmi.replaceRange(c.name + "}", data.from, data.to, "complete");
      return;
    }
    const unit = " ".repeat(cmi.getOption("indentUnit"));
    const body = LIST_ENVS.has(c.name) ? "\\item " : "";
    cmi.replaceRange(`${c.name}}\n${indent}${unit}${body}\n${indent}\\end{${c.name}}`, data.from, data.to, "complete");
    cmi.setCursor(Pos(data.from.line + 1, indent.length + unit.length + body.length));
  }
  // Innermost environment that is open at the cursor (for \end{ completion).
  function openEnvironment(cmi, cur) {
    const stack = [];
    for (let l = Math.max(0, cur.line - 800); l <= cur.line; l++) {
      const t = stripComment(l === cur.line ? cmi.getLine(l).slice(0, cur.ch) : cmi.getLine(l));
      const re = /\\(begin|end)\s*\{([^}]*)\}/g;
      let m;
      while ((m = re.exec(t))) {
        if (m[1] === "begin") stack.push(m[2]);
        else { const i = stack.lastIndexOf(m[2]); if (i >= 0) stack.length = i; }
      }
    }
    return stack[stack.length - 1] || null;
  }
  function keyHint(cmi, cur, inside, kind) {
    const typed = inside.slice(inside.lastIndexOf(",") + 1).replace(/^\s+/, "");
    const build = () => {
      const c = cmi.getCursor();
      if (c.line !== cur.line || c.ch !== cur.ch) return null; // the user moved on meanwhile
      const items = kind === "label" ? collectLabels() : collectBibKeys();
      const list = rank(items, typed, (it) => it.key, 200).map((it) => ({ text: it.key, sub: it.sub }));
      return listHint(Pos(cur.line, cur.ch - typed.length), keyEnd(cmi, cur), list);
    };
    const wait = freshCache(600);
    return wait ? wait.then(build) : build();
  }
  function fileHint(cmi, cur, inside, re, stripExt) {
    const typed = inside.slice(inside.lastIndexOf(",") + 1).replace(/^\s+/, "");
    const build = () => {
      const paths = (cache.files || (T.state && T.state.project && T.state.project.files) || [])
        .filter((f) => f && f.type !== "dir" && re.test(f.path)).map((f) => f.path);
      const names = paths.map((p) => (stripExt ? p.replace(/\.[^./]+$/, "") : p));
      return listHint(Pos(cur.line, cur.ch - typed.length), keyEnd(cmi, cur), rank(names, typed, (s) => s, 100).map((s) => ({ text: s })));
    };
    const wait = freshCache(600);
    return wait ? wait.then(build) : build();
  }
  function startHint(cmi) {
    if (!cmi.state.completionActive) cmi.showHint(HINT_OPTIONS);
  }
  // Open the completion list while typing a command, or right after { / , in an argument that
  // takes labels, citation keys, environments, packages or files.
  function onChangesForHint(cmi, changes) {
    const last = changes[changes.length - 1];
    if (!last || cmi.state.completionActive || cmi.somethingSelected()) return;
    if (last.origin !== "+input" && last.origin !== "*compose") return;
    const text = last.text.join("\n");
    if (!text || text.length > 2 || !/^[\\{,A-Za-z@:*]/.test(text)) return;
    const cur = cmi.getCursor();
    const before = cmi.getLine(cur.line).slice(0, cur.ch);
    if (CMD_CTX.test(before) || ARG_CONTEXTS.some((re) => re.test(before))) startHint(cmi);
  }

  // ------------------------------------------------------------------ "=" results
  // Typing "=" after a formula in math ($…$, \(…\), \[…\], $$…$$ or an equation/align-like
  // environment) asks the server for the value of the left-hand side (SymPy, mathcalc.py) and
  // shows it as ghost text after the cursor, with a rendered preview below the line.
  // Tab inserts it, ⌥Tab the decimal alternative; any other key, click or edit dismisses it.
  // Nothing is written into the document until it is accepted.
  const CALC_ENVS = new Set(["equation", "equation*", "align", "align*", "gather", "gather*", "multline",
    "multline*", "flalign", "flalign*", "alignat", "alignat*", "eqnarray", "eqnarray*", "math",
    "displaymath", "dmath", "dmath*", "split", "aligned", "gathered"]);
  const CALC_TEXT = new Set(["text", "textrm", "textit", "textbf", "textsf", "texttt", "mbox", "hbox",
    "intertext", "shortintertext", "label", "tag", "ref", "eqref", "cite", "emph"]);
  // relations and breaks that end a left-hand side (top level only)
  const CALC_SEP_CMDS = new Set(["le", "leq", "ge", "geq", "ne", "neq", "approx", "equiv", "sim", "simeq",
    "cong", "propto", "implies", "iff", "Rightarrow", "Leftrightarrow", "Longrightarrow", "longrightarrow",
    "Leftarrow", "mapsto", "quad", "qquad", "colon", "coloneqq", "in", "notin", "subset", "subseteq",
    "supset", "land", "lor", "wedge", "vee", "leqslant", "geqslant", "ll", "gg", "text",
    "not"]); // not \pm: "52 \pm 1.96 =" asks for the interval
  // after the "=", only the end of the formula may follow on the line
  const CALC_AFTER = /^\s*(?:$|\$|\\\]|\\\)|\\\\|&|%|\\end\b|\\label\b|\\tag\b|\\nonumber\b|\\notag\b|[.,;]\s*(?:$|\$|\\\]|\\\)))/;
  let calc = null; // { entry, pos, bm, card, r, spaced }
  let calcSeq = 0, calcRev = 0, calcAvailable = null, calcWarm = false;

  function calcEnabled() {
    const s = T.state && T.state.settings;
    return !(s && s.mathResults === false) && calcAvailable !== false;
  }
  function isTexPath(p) { return /\.(tex|ltx)$/i.test(p || ""); }

  // Where the math the cursor is in starts (a document index), or -1 if it is not in math.
  // Math never spans a blank line, so the scan starts at the paragraph.
  function mathStart(doc, pos) {
    let l = pos.line;
    const stop = Math.max(0, pos.line - 300);
    while (l > stop && doc.getLine(l - 1).trim() !== "") l--;
    const text = doc.getRange(Pos(l, 0), pos);
    const base = doc.indexFromPos(Pos(l, 0));
    const stack = [];
    const inMath = () => stack.length > 0 && stack[stack.length - 1].math;
    const n = text.length;
    let i = 0;
    while (i < n) {
      const c = text[i];
      if (c === "%") {
        const j = text.indexOf("\n", i);
        if (j < 0) return -1; // the cursor is in a comment
        i = j + 1;
        continue;
      }
      if (c === "\\") {
        const m = /^\\([A-Za-z]+|[^A-Za-z]?)/.exec(text.slice(i, i + 64));
        const name = m[1];
        let j = i + m[0].length;
        if (name === "(" || name === "[") {
          if (!inMath()) stack.push({ math: true, close: name === "(" ? ")" : "]", start: j });
        } else if (name === ")" || name === "]") {
          const top = stack[stack.length - 1];
          if (top && top.close === name) stack.pop();
        } else if (name === "begin" || name === "end") {
          const em = /^\s*\{([^{}]*)\}/.exec(text.slice(j, j + 80));
          if (em) {
            const env = em[1].trim();
            j += em[0].length;
            if (name === "begin" && CALC_ENVS.has(env) && !inMath()) {
              if (/^alignat\*?$/.test(env)) { const a = /^\s*\{[^{}]*\}/.exec(text.slice(j, j + 20)); if (a) j += a[0].length; }
              stack.push({ math: true, close: "env:" + env, start: j });
            } else if (name === "end") {
              const top = stack[stack.length - 1];
              if (top && top.close === "env:" + env) stack.pop();
            }
          }
        } else if (inMath() && CALC_TEXT.has(name)) {
          // \text{…} inside math: skip it, or stop if the cursor is inside it
          let k = j;
          while (k < n && /\s/.test(text[k])) k++;
          if (text[k] === "{") {
            let depth = 0;
            for (; k < n; k++) {
              if (text[k] === "\\") { k++; continue; }
              if (text[k] === "{") depth++;
              else if (text[k] === "}" && --depth === 0) break;
            }
            if (k >= n) return -1;
            j = k + 1;
          }
        }
        i = j;
        continue;
      }
      if (c === "$") {
        const dbl = text[i + 1] === "$";
        const close = dbl ? "$$" : "$";
        const top = stack[stack.length - 1];
        if (top && top.close === close) stack.pop();
        else if (!inMath()) stack.push({ math: true, close, start: i + close.length });
        i += close.length;
        continue;
      }
      i++;
    }
    return inMath() ? base + stack[stack.length - 1].start : -1;
  }

  // What the "=" asks about: { latex, chain }. latex is the formula after the last top-level "=",
  // relation, comma or \text{}; chain holds the sides before it when it ends a chain of equalities
  // (A = B = C: C with [A, B]), oldest first, so mathcalc can fall back on them and check the step.
  // A chain runs on through "=", an "&" next to one ("&=") and a "\\" that the next "=" continues
  // ("… \\ &="); anything else ends it: another relation, "," ";" \text{} \quad, a lone "&", and a
  // "\\" that starts a new formula. Sides that are only a name or a number are left out.
  const CALC_BLANK = /\\(?:nonumber|notag)(?![A-Za-z])|\\(?:label|tag)\*?\s*\{[^{}]*\}/g;
  const CALC_NAME = /^(?:[A-Za-z]|\\[A-Za-z]+)(?:_\{?\w+\}?)?$/, CALC_NUMBER = /^\d+(?:\.\d+)?$/;
  function calcParts(src) {
    src = src.replace(CALC_BLANK, (m) => " ".repeat(m.length));
    src = src.replace(/&\s*$/, ""); // align: "\int_0^1 x\,dx &=" means the part before the &
    const marks = []; // top level only: { t: "=", "&", "\\" or "!" (the chain ends here), a, b }
    let depth = 0;
    const n = src.length;
    const group = (k) => { // past the {…} that starts at or after k
      let d = 0;
      while (k < n && /\s/.test(src[k])) k++;
      if (src[k] !== "{") return k;
      for (; k < n; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) break; }
      return Math.min(n, k + 1);
    };
    for (let i = 0; i < n; i++) {
      const c = src[i];
      if (c === "%") { const j = src.indexOf("\n", i); if (j < 0) break; i = j; continue; }
      if (c === "\\") {
        const m = /^\\([A-Za-z]+|[^A-Za-z]?)/.exec(src.slice(i, i + 64));
        const name = m[1];
        let end = i + m[0].length;
        if (name === "begin" || name === "left") depth++;
        else if ((name === "end" || name === "right") && depth > 0) depth--;
        else if (name === "\\" && depth === 0) {
          end += /^\*?(?:\[\s*-?[\d.]+\s*[A-Za-z]{2}\s*\])?/.exec(src.slice(end, end + 24))[0].length; // \\[2pt]
          marks.push({ t: "\\", a: i, b: end });
        } else if (depth === 0 && (CALC_SEP_CMDS.has(name) || CALC_TEXT.has(name))) {
          if (CALC_TEXT.has(name)) end = group(end);
          marks.push({ t: "!", a: i, b: end });
        }
        if (name === "begin" || name === "end") { const em = /^\s*\{[^{}]*\}/.exec(src.slice(end, end + 80)); if (em) end += em[0].length; }
        i = end - 1;
        continue;
      }
      if (c === "{" || c === "(" || c === "[") depth++; // P[X > 1], \mathbb{E}[X \mid …] stay whole
      else if ((c === "}" || c === ")" || c === "]") && depth > 0) depth--;
      else if (depth !== 0) continue;
      else if (c === "=") marks.push({ t: /(?:[!<>:=]|\\not)\s*$/.test(src.slice(Math.max(0, i - 12), i)) ? "!" : "=", a: i, b: i + 1 }); // not !=, <=, :=, ==
      else if (c === "&") marks.push({ t: "&", a: i, b: i + 1 });
      else if ("<>,;".includes(c)) marks.push({ t: "!", a: i, b: i + 1 });
    }
    const blank = (from, to) => /^\s*$/.test(src.slice(from, to));
    const eqAfter = (k) => { const m = marks[k + 1]; return !!m && m.t === "=" && blank(marks[k].b, m.a); };
    const eqBefore = (k) => { const m = marks[k - 1]; return !!m && m.t === "=" && blank(m.b, marks[k].a); };
    let cut = 0, from = 0, side = "";
    const sides = [];
    marks.forEach((m, k) => {
      let soft = m.t === "=";
      if (m.t === "&") soft = eqAfter(k) || eqBefore(k);
      else if (m.t === "\\") { // … \\ &=   … \\ =   and the "\\" (or "\\ &") the typed "=" comes right after
        const nx = marks[k + 1];
        soft = nx ? eqAfter(k) || (nx.t === "&" && blank(m.b, nx.a) && eqAfter(k + 1)) : blank(m.b, n);
      }
      if (!soft) { cut = from = m.b; side = ""; sides.length = 0; return; }
      side += src.slice(from, m.a) + " ";
      from = m.b;
      if (m.t === "=") { sides.push(side.trim()); side = ""; }
    });
    const latex = (side + src.slice(from)).trim();
    const chain = sides.filter((x) => x && x.length <= 2000 && !CALC_NAME.test(x) && !CALC_NUMBER.test(x)).slice(0, 8);
    return { latex, chain };
  }

  function onChangesForCalc(cmi, changes) {
    calcRev++;
    if (calc) hideCalc();
    if (!current || !isTexPath(current.path) || !calcEnabled()) return;
    if (changes.length !== 1) return;
    const ch = changes[0];
    if ((ch.origin !== "+input" && ch.origin !== "*compose") || ch.text.length !== 1 || ch.text[0] !== "=") return;
    if (cmi.listSelections().length !== 1 || cmi.somethingSelected()) return;
    const cur = cmi.getCursor();
    const line = cmi.getLine(cur.line);
    if (line[cur.ch - 1] !== "=") return;
    const prev = line[cur.ch - 2] || "";
    if (/[=<>!:\\]/.test(prev)) return; // ==, <=, :=, \= …
    const doc = current.doc;
    const eq = Pos(cur.line, cur.ch - 1);
    const start = mathStart(doc, eq);
    if (start < 0) {
      // outside math: plain arithmetic written as text, "$p_x$ = 0.2 + 0.1 + 2(0.05 + 0.05) ="
      if (!CALC_AFTER_TEXT.test(line.slice(cur.ch)) || inPreamble(doc, cur.line)) return;
      const before = line.slice(0, cur.ch - 1);
      // right after inline math, "$f_x = \int_0^x 2\,dy$ =": that formula's value, in its own $…$
      const shut = /(\$\$|\$|\\\))\s*$/.exec(before);
      if (shut && before[shut.index - 1] !== "\\") {
        const close = Pos(cur.line, shut.index);
        const ms = mathStart(doc, close);
        if (ms >= 0) {
          const parts = calcParts(doc.getRange(doc.posFromIndex(ms), close));
          if (parts.latex.length <= 3000 && !CALC_NAME.test(parts.latex) && (parts.chain.length || (parts.latex && !CALC_NUMBER.test(parts.latex)))) {
            requestCalc(current, Pos(cur.line, cur.ch), parts.latex, /\s/.test(prev), calcDecls(doc, doc.indexFromPos(close)), "wrap", parts.chain);
            return;
          }
        }
      }
      const t = textArith(before);
      if (t) requestCalc(current, Pos(cur.line, cur.ch), t, /\s/.test(prev), null, true, textChain(before));
      return;
    }
    if (!CALC_AFTER.test(line.slice(cur.ch))) return;
    const { latex: lhs, chain } = calcParts(doc.getRange(doc.posFromIndex(start), eq));
    // a bare name or number (x =, y_1 =, 2 =) has nothing to compute; after a chain (2 + 3 = 6 =)
    // a number can still be checked against it, and an empty side ("… = \\ =") takes its value
    if (lhs.length > 3000 || CALC_NAME.test(lhs) || (!chain.length && (!lhs || CALC_NUMBER.test(lhs)))) return;
    requestCalc(current, Pos(cur.line, cur.ch), lhs, /\s/.test(prev), calcDecls(doc, doc.indexFromPos(eq)), false, chain);
  }

  // Plain arithmetic typed as text, outside math: the numbers, + - * / ^ × ÷ · and brackets just
  // before the "=", set apart from the words before them (x2+3 and f(2+3) stay quiet), with at least
  // one operation. Returned as LaTeX mathcalc reads (2^10 → 2^{10}, * → \cdot), or null.
  const TEXT_ARITH = /(?:^|[\s=:${}~\]&])((?:[-+−(]\s*)*(?:\d|\.\d)[\d.\s+\-*/^()×÷·−]*)$/;
  const TEXT_OPS = { "*": "\\cdot ", "·": "\\cdot ", "×": "\\times ", "÷": "\\div ", "−": "-", "**": "^" };
  // after the "=": the end of the line, a cell or line break, or a closing comment/period
  const CALC_AFTER_TEXT = /^\s*(?:$|%|&|\\\\|\\(?:end|par|newline|hfill)\b|[.,;:]\s*(?:$|%))/;
  const isNum = (t) => /^[\d.]/.test(t || "");
  // whole: `before` must be arithmetic from its first character on, and a lone number will do
  function textArith(before, whole) {
    before = whole ? before.trim() : before.slice(-400);
    if (/(?:^|[^\\])%/.test(before)) return null; // in a comment
    const m = TEXT_ARITH.exec(before);
    if (!m || (whole && m[1] !== before)) return null;
    const s = m[1].trimEnd();
    const toks = [];
    const re = /\s*(\d+(?:\.\d+)?|\.\d+|\*\*|[-+*/^()×÷·−])/y;
    for (let i = 0; i < s.length;) {
      re.lastIndex = i;
      const t = re.exec(s);
      if (!t) return null;
      toks.push(t[1]);
      i = re.lastIndex;
    }
    let depth = 0, op = false;
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k], after = isNum(toks[k - 1]) || toks[k - 1] === ")";
      if (isNum(t) && isNum(toks[k - 1])) return null; // "2 3": two numbers, not arithmetic
      if (t === "(") { depth++; if (after) op = true; } // 2(…)
      else if (t === ")") { if (--depth < 0) return null; }
      else if (!isNum(t) && after) op = true; // a binary operator, not a sign
    }
    if (depth !== 0 || !(op || whole)) return null;
    return arithLatex(toks);
  }
  // The earlier sides of a chain written as text, "… = 0.2 + 0.1 + 2(0.05 + 0.05) = 0.5 + 0.2 =",
  // oldest first: only when everything between the "=" signs is arithmetic, back to the first
  // side that isn't (the name being defined). The line's first side may follow words.
  function textChain(before) {
    const cutOff = before.length > 400;
    const parts = before.slice(-400).split("=");
    const chain = [];
    if (parts.length < 2 || !textArith(parts[parts.length - 1], true)) return chain;
    for (let k = parts.length - 2; k >= (cutOff ? 1 : 0); k--) {
      if (/[<>!:]\s*$/.test(parts[k])) break; // <=, !=, :=
      const t = k > 0 ? textArith(parts[k], true) : textArith(parts[k]);
      if (!t) break;
      if (!CALC_NUMBER.test(t)) chain.unshift(t);
    }
    return chain.slice(-8);
  }
  function arithLatex(toks) {
    let out = "", k = 0;
    const exponent = () => { // after ^: signs, then a number or (…), then maybe ^ again (2^3^2)
      const st = k;
      while (/^[-+−]$/.test(toks[k] || "")) k++;
      if (toks[k] === "(") {
        for (let d = 0; k < toks.length; k++) { if (toks[k] === "(") d++; else if (toks[k] === ")" && --d === 0) break; }
      } else if (!isNum(toks[k])) return null;
      if (++k > toks.length) return null;
      if ((toks[k] === "^" || toks[k] === "**") && (k++, !exponent())) return null;
      return toks.slice(st, k);
    };
    while (k < toks.length) {
      const t = toks[k++];
      if (t === "^" || t === "**") {
        const e = exponent();
        const inner = e && arithLatex(e);
        if (!inner) return null;
        out += "^{" + inner + "}";
      } else out += TEXT_OPS[t] || t;
    }
    return out;
  }
  // A result to write as text: 0.7, 3/2, or $1.2 \times 10^{-5}$; null for anything else.
  function textForm(latex) {
    const t = String(latex || "").trim();
    if (/^-?\d+(?:\.\d+)?$/.test(t)) return t;
    const f = /^(-\s*)?\\frac\{(\d+)\}\{(\d+)\}$/.exec(t);
    if (f) return (f[1] ? "-" : "") + f[2] + "/" + f[3];
    if (/^-?\d+(?:\.\d+)? \\times 10\^\{-?\d+\}$/.test(t)) return "$" + t + "$";
    return null;
  }
  function textResult(r, note) { // note: kept only for a chain, whose warning it is
    const main = textForm(r.latex), alt = r.alt ? textForm(r.alt.latex) : null;
    if (main) return Object.assign({}, r, { text: main, note, alt: alt ? Object.assign({}, r.alt, { text: alt }) : null });
    if (alt) return Object.assign({}, r.alt, { text: alt, alt: null, note }); // 2^(1/2): its decimal
    return null;
  }
  // A result written after inline math has closed: a plain number as text, anything else in $…$.
  const wrapForm = (l) => (/^-?\d+(?:\.\d+)?$/.test(String(l).trim()) ? String(l).trim() : "$" + l + "$");
  function wrapResult(r) {
    return Object.assign({}, r, { text: wrapForm(r.latex), alt: r.alt ? Object.assign({}, r.alt, { text: wrapForm(r.alt.latex) }) : null });
  }
  // Before \begin{document} (when the file has one), "=" is settings, not arithmetic.
  function inPreamble(doc, line) {
    const begin = /^[^%]*\\begin\s*\{document\}/;
    for (let l = line; l >= doc.firstLine(); l--) if (begin.test(doc.getLine(l))) return false;
    for (let l = line + 1; l <= doc.lastLine(); l++) if (begin.test(doc.getLine(l))) return true;
    return false;
  }

  // The distributions declared before the "=" (X \sim N(100, 15^2)), so P(X > 130) has a value:
  // for each \sim, the text just before it (the name) and after it (the distribution), oldest
  // first, so the nearest declaration wins. Commented-out ones are skipped.
  function calcDecls(doc, upto) {
    const text = doc.getRange(Pos(doc.firstLine(), 0), doc.posFromIndex(upto));
    const re = /\\sim(?![A-Za-z])/g;
    re.lastIndex = Math.max(0, text.length - 300000);
    const out = [];
    let m;
    while ((m = re.exec(text))) {
      const i = m.index;
      const lineStart = text.lastIndexOf("\n", i) + 1;
      if (/(^|[^\\])%/.test(text.slice(lineStart, i))) continue;
      const name = text.slice(Math.max(lineStart, i - 60), i).replace(/^[\s\S]*(?:\$|\\\[|\\\(|\\\\|&)/, "");
      let dist = text.slice(i + 4, i + 4 + 200);
      // (not at \text: \text{Bin}(10, 0.3) is the distribution; mathcalc stops after it anyway)
      const end = dist.search(/\n|\$|\\\]|\\\)|\\\\|&|;|\\(?:end|quad|qquad|label|tag)\b/);
      if (end >= 0) dist = dist.slice(0, end);
      if (name.trim() && dist.trim()) out.push({ name, dist });
    }
    return out.slice(-40);
  }

  function requestCalc(entry, pos, lhs, spaced, decls, text, chain) {
    const id = ++calcSeq;
    const rev = calcRev;
    const body = decls && decls.length ? { latex: lhs, decls } : { latex: lhs };
    if (chain && chain.length) body.chain = chain;
    T.api.post("/api/calc", body).then((res) => {
      if (!res) return;
      if (res.available === false) { calcAvailable = false; return; }
      if (id !== calcSeq || rev !== calcRev || current !== entry || !cm || !res.ok || !res.result) return;
      if (cmp(entry.doc.getCursor(), pos) !== 0 || entry.doc.somethingSelected() || !cm.hasFocus()) return;
      const r = text === "wrap" ? wrapResult(res.result)
        : text ? textResult(res.result, body.chain ? res.result.note || null : null) : res.result;
      if (r) showCalc(entry, pos, r, spaced);
    }).catch(() => {});
  }

  function renderMath(el, tex) {
    if (window.katex) {
      try { window.katex.render(tex, el, { throwOnError: false, displayMode: false, output: "html" }); return; } catch (_) { /* plain text below */ }
    }
    el.textContent = tex;
  }

  function showCalc(entry, pos, r, spaced) {
    hideCalc();
    const lead = spaced ? " " : "";
    const ghost = document.createElement("span");
    ghost.className = "texc-calc-ghost" + (r.approx ? " is-approx" : "");
    ghost.textContent = (r.approx ? " ≈ " : lead) + (r.text != null ? r.text : r.latex);
    ghost.title = "Tab to insert";
    const bm = entry.doc.setBookmark(pos, { widget: ghost, insertLeft: true, handleMouseEvents: true });

    const card = document.createElement("div");
    card.className = "texc-calc-card";
    const main = document.createElement("button");
    main.type = "button";
    main.className = "texc-calc-opt";
    const mathEl = document.createElement("span");
    mathEl.className = "texc-calc-math";
    renderMath(mathEl, "\\displaystyle " + (r.approx ? "\\approx " : "= ") + r.latex);
    const opts = [{ el: main, kbd: kbdEl("⇥") }];
    main.append(mathEl, opts[0].kbd);
    card.append(main);
    if (r.alt) {
      const alt = document.createElement("button");
      alt.type = "button";
      alt.className = "texc-calc-opt texc-calc-alt";
      const am = document.createElement("span");
      am.className = "texc-calc-math";
      renderMath(am, "\\displaystyle " + (r.alt.approx ? "\\approx " : "= ") + r.alt.latex);
      opts.push({ el: alt, kbd: kbdEl("↓") });
      alt.append(am, opts[1].kbd);
      alt.addEventListener("mousedown", (e) => { e.preventDefault(); acceptCalc(true); });
      card.append(alt);
    }
    if (r.note) {
      const note = document.createElement("div");
      note.className = "texc-calc-note";
      const m = /^assuming ([^$]+)$/.exec(String(r.note));
      if (m) renderMath(note, "\\text{assuming }" + m[1]);
      else {
        // text with $…$ math: "$X$ normal, mean $100$, sd $15$", "⚠ doesn't match $2 + 3$, which is $5$"
        String(r.note).split("$").forEach((part, i) => {
          if (!part) return;
          const span = document.createElement("span");
          if (i % 2) renderMath(span, part);
          else span.textContent = part;
          note.append(span);
        });
      }
      card.append(note);
    }
    main.addEventListener("mousedown", (e) => { e.preventDefault(); acceptCalc(false); });
    ghost.addEventListener("mousedown", (e) => { e.preventDefault(); acceptCalc(); });
    card.addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor focused
    cm.addWidget(pos, card, false, "near");
    // Below the line unless that is out of sight (the docked chat covers the editor's bottom).
    const wr = wrapper.getBoundingClientRect(), cr = card.getBoundingClientRect();
    if (cr.bottom > wr.bottom - 4) {
      card.remove();
      card.classList.add("is-above");
      cm.addWidget(pos, card, false, "above");
    }
    calc = { entry, pos, bm, card, r, spaced, ghost, opts, sel: 0, moved: false };
    selectCalc(0);
  }
  // Which of the two results (the first, or the other way of writing it) Tab inserts: ↑ ↓ choose.
  function selectCalc(i) {
    const c = calc;
    if (!c || (i && !c.r.alt)) return;
    c.sel = i ? 1 : 0;
    const pick = c.sel ? c.r.alt : c.r;
    c.ghost.className = "texc-calc-ghost" + (pick.approx ? " is-approx" : "");
    c.ghost.textContent = (pick.approx ? " ≈ " : c.spaced ? " " : "") + (pick.text != null ? pick.text : pick.latex);
    c.opts.forEach((o, k) => {
      o.el.classList.toggle("is-selected", k === c.sel);
      o.kbd.textContent = k === c.sel ? "⇥" : k > c.sel ? "↓" : "↑";
    });
    try { c.bm.changed(); } catch (_) { /* the ghost keeps its old width */ }
  }
  function kbdEl(text) {
    const k = document.createElement("span");
    k.className = "texc-kbd";
    k.textContent = text;
    return k;
  }

  function hideCalc() {
    const c = calc;
    if (!c) return;
    calc = null;
    try { c.bm.clear(); } catch (_) { /* the doc is gone */ }
    if (c.card.parentNode) c.card.parentNode.removeChild(c.card);
  }

  function acceptCalc(useAlt) { // no argument: the selected one
    const c = calc;
    if (!c) return false;
    if (useAlt === undefined) useAlt = c.sel === 1;
    const pick = useAlt ? c.r.alt : c.r;
    if (!pick) return false;
    hideCalc();
    const doc = c.entry.doc;
    if (c.entry !== current || cmp(doc.getCursor(), c.pos) !== 0) return false;
    const eq = Pos(c.pos.line, c.pos.ch - 1);
    const lead = c.spaced ? " " : "";
    const text = pick.text != null; // outside math: written as text, \approx in its own $…$
    const out = text ? pick.text : pick.latex;
    if (pick.approx && doc.getRange(eq, c.pos) === "=") {
      // a rounded decimal: the "=" becomes \approx
      doc.replaceRange((text ? "$\\approx$" : "\\approx") + lead + out, eq, c.pos, "+calc");
    } else {
      doc.replaceRange(lead + out, c.pos, c.pos, "+calc");
    }
    T.bus.emit("editor:calc", { latex: pick.latex, approx: !!pick.approx });
    return true;
  }

  function warmCalc() {
    if (calcWarm || !calcEnabled()) return;
    calcWarm = true;
    setTimeout(() => {
      T.api.post("/api/calc", { warm: true }).then((s) => { if (s) calcAvailable = !!s.available; }).catch(() => {});
    }, 1500);
  }

  // ------------------------------------------------------------------ keyboard
  function onCmKeyDown(cmi, e) {
    if (calc && e.key === "Escape") {
      e.preventDefault();
      hideCalc();
      return;
    }
    if (calc && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      // two results: ↑ ↓ choose between them; Enter inserts once one has been chosen that way
      if (calc.r.alt && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        calc.moved = true;
        selectCalc(calc.sel ? 0 : 1);
        return;
      }
      if (calc.moved && e.key === "Enter") {
        e.preventDefault();
        acceptCalc();
        return;
      }
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey && (e.code === "KeyY" || e.code === "KeyN")) {
      if (!current || !current.hunks.length) return; // nothing to review: let the key type
      e.preventDefault();
      handleHunkKey(e);
      if (e.key === "Dead") {
        // ⌥N on a US Mac layout is a dead key (˜); blurring the input drops the pending accent.
        const input = cmi.getInputField();
        input.blur();
        cmi.focus();
      }
      return;
    }
    const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (mod && !e.altKey && !e.shiftKey && (e.code === "KeyS" || (e.key || "").toLowerCase() === "s")) {
      if (e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      const entry = current;
      (entry ? queueSave(entry, "manual") : Promise.resolve(true)).finally(() => T.bus.emit("compile:request", {}));
    }
  }
  function handleHunkKey(e) {
    const h = nearestHunk(current);
    if (!h) return;
    strayCharUntil = Date.now() + 80;
    resolveHunk(h, e.code === "KeyY");
  }
  // ⌥Y/⌥N while the editor is visible but not focused (e.g. after clicking a hunk).
  function onDocKeyDown(e) {
    if (!(e.altKey && !e.metaKey && !e.ctrlKey && (e.code === "KeyY" || e.code === "KeyN"))) return;
    if (e.defaultPrevented || !cm || cm.hasFocus() || !current || !current.hunks.length) return;
    if (!host || !host.getClientRects().length || host.closest("[hidden]")) return;
    const ae = document.activeElement;
    if (ae && ae !== document.body && !host.contains(ae)) return; // typing elsewhere (e.g. the chat)
    if (ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable)) return;
    e.preventDefault();
    handleHunkKey(e);
  }
  // Drops the character a just-handled ⌥Y/⌥N may still type on a Mac layout (¥, or the ˜ of the
  // ⌥N dead key). Only those characters, and only right after the shortcut, so normal typing
  // that follows a Keep/Undo is never eaten.
  const STRAY_CHARS = new Set(["¥", "˜", "\u02dc", "\u0303"]);
  function onBeforeChange(_cmi, change) {
    if (Date.now() > strayCharUntil) return;
    if (change.origin !== "+input" && change.origin !== "*compose") return;
    if (STRAY_CHARS.has(change.text.join("\n"))) change.cancel();
  }
  function toggleComment(cmi) {
    cmi.operation(() => {
      for (const r of cmi.listSelections()) {
        const a = Math.min(r.anchor.line, r.head.line);
        let b = Math.max(r.anchor.line, r.head.line);
        const end = cmp(r.anchor, r.head) > 0 ? r.anchor : r.head;
        if (b > a && end.ch === 0) b--;
        let all = true, minIndent = Infinity;
        for (let l = a; l <= b; l++) {
          const t = cmi.getLine(l);
          if (!t.trim()) continue;
          if (!/^\s*%/.test(t)) all = false;
          minIndent = Math.min(minIndent, /^\s*/.exec(t)[0].length);
        }
        if (minIndent === Infinity) continue;
        for (let l = a; l <= b; l++) {
          const t = cmi.getLine(l);
          if (all) {
            const m = /^(\s*)% ?/.exec(t);
            if (m) cmi.replaceRange("", Pos(l, m[1].length), Pos(l, m[0].length), "+comment");
          } else if (t.trim()) {
            cmi.replaceRange("% ", Pos(l, minIndent), Pos(l, minIndent), "+comment");
          }
        }
      }
    });
  }
  function buildKeys() {
    const k = {
      "Ctrl-Space": (cmi) => cmi.showHint(HINT_OPTIONS),
      Tab: (cmi) => {
        if (acceptCalc()) return;
        if (cmi.somethingSelected() && cmi.getSelection().indexOf("\n") >= 0) cmi.indentSelection("add");
        else cmi.replaceSelection(" ".repeat(cmi.getOption("indentUnit")), "end", "+input");
      },
      "Shift-Tab": "indentLess",
      "Alt-Tab": (cmi) => (acceptCalc(true) ? undefined : CM.Pass),
    };
    if (IS_MAC) {
      Object.assign(k, { "Cmd-F": "findPersistent", "Cmd-G": "findPersistentNext", "Shift-Cmd-G": "findPersistentPrev", "Cmd-Alt-F": "replace", "Cmd-/": toggleComment, "Ctrl-G": "jumpToLine" });
    } else {
      Object.assign(k, { "Ctrl-F": "findPersistent", "Ctrl-G": "findPersistentNext", "Shift-Ctrl-G": "findPersistentPrev", "Shift-Ctrl-F": "replace", "Ctrl-/": toggleComment });
    }
    return k;
  }

  // ------------------------------------------------------------------ layout
  // Wrapped lines hang at their own indentation (the CodeMirror "indentwrap" trick).
  function hangPx(text) {
    const ws = text.search(/\S|$/);
    if (ws <= 0) return 0;
    return Math.min(CM.countColumn(text, ws, TAB_SIZE), MAX_HANG_COLS) * charWidth;
  }
  function onRenderLine(_cmi, line, elt) {
    const off = hangPx(line.text);
    if (off) { elt.style.textIndent = `-${off}px`; elt.style.paddingLeft = `${BASE_PAD + off}px`; }
    else if (elt.style.textIndent) { elt.style.textIndent = ""; elt.style.paddingLeft = ""; }
  }
  function remeasure(force) {
    const w = cm.defaultCharWidth();
    if (w > 0 && (force || Math.abs(w - charWidth) > 0.01)) {
      charWidth = w;
      layoutRev++;
      cm.refresh();
      if (current && current.hunks.length) revalidate(current, true);
    }
  }
  // The docked chat overlays the bottom of #editor-view; the editor ends where the dock begins so
  // no line hides behind it.
  function updateDockInset(hr) {
    const dock = document.getElementById("dock-chat");
    let inset = 0;
    if (dock && !dock.hidden && host.parentNode && host.parentNode.contains(dock)) {
      const dr = dock.getBoundingClientRect();
      const cs = getComputedStyle(dock);
      if (dr.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && dr.top < hr.bottom && dr.bottom > hr.top + 1) {
        inset = Math.round(hr.bottom - dr.top);
      }
    }
    inset = clamp(inset, 0, Math.max(0, hr.height - 60));
    if (inset === dockInset) return false;
    dockInset = inset;
    wrapper.style.bottom = `${inset}px`;
    if (stateEl) stateEl.style.bottom = `${inset}px`;
    return true;
  }
  let layoutQueued = false;
  function scheduleLayout(again) {
    if (!layoutQueued) {
      layoutQueued = true;
      requestAnimationFrame(() => { layoutQueued = false; layout(); });
    }
    if (again) setTimeout(() => scheduleLayout(), 220); // after the dock's CSS transition
  }
  function layout(force) {
    if (!cm || !host) return;
    const hr = host.getBoundingClientRect();
    if (!hr.width || !hr.height) return; // hidden
    const insetChanged = updateDockInset(hr);
    if (force || insetChanged || hr.width !== lastHostW || hr.height !== lastHostH) {
      lastHostW = hr.width;
      lastHostH = hr.height;
      cm.refresh();
      remeasure(false);
    }
    if (pendingReveal != null && current) {
      const l = pendingReveal;
      pendingReveal = null;
      revealLine(clamp(l, 0, current.doc.lastLine()));
    }
  }

  // ------------------------------------------------------------------ selection
  function getSelection() {
    if (!cm || !current) return null;
    const doc = current.doc;
    const from = doc.getCursor("from"), to = doc.getCursor("to");
    if (cmp(from, to) === 0) return null;
    return { path: current.path, from: { line: from.line + 1, ch: from.ch }, to: { line: to.line + 1, ch: to.ch }, text: doc.getRange(from, to) };
  }
  const scheduleSelection = debounce(() => {
    const sel = getSelection();
    const key = sel ? `${sel.path}:${sel.from.line}:${sel.from.ch}:${sel.to.line}:${sel.to.ch}:${sel.text.length}` : "";
    if (key === lastSelKey) return;
    lastSelKey = key;
    T.bus.emit("editor:selection", sel);
  }, 150);

  // ------------------------------------------------------------------ settings
  function setOptions(o) {
    ensureInit();
    o = o || {};
    if (o.fontSize != null && isFinite(+o.fontSize)) {
      const fs = clamp(Math.round(+o.fontSize), 9, 32);
      if (fs !== fontSize) {
        fontSize = fs;
        wrapper.style.fontSize = `${fs}px`;
        cm.refresh();
        remeasure(true);
      }
    }
    if (o.autosaveMs != null && isFinite(+o.autosaveMs)) autosaveDelay = clamp(+o.autosaveMs, 150, 60000);
    if (o.lineWrapping != null) cm.setOption("lineWrapping", !!o.lineWrapping);
  }
  function applySettings(s) {
    if (!s) return;
    setOptions({ fontSize: s.fontSize, autosaveMs: s.autosaveMs });
  }

  // ------------------------------------------------------------------ init
  function init(hostEl) {
    if (cm) return api;
    host = hostEl || document.getElementById("editor-host");
    if (!host) throw new Error("#editor-host not found");
    host.classList.add("texc-editor-host");
    blankDoc = new CM.Doc("", null);
    cm = CM(host, {
      value: blankDoc,
      theme: "texc",
      lineNumbers: true,
      lineWrapping: true,
      styleActiveLine: true,
      matchBrackets: true,
      autoCloseBrackets: { pairs: "()[]{}", explode: "[]{}" },
      tabSize: TAB_SIZE,
      indentUnit: INDENT_UNIT,
      indentWithTabs: false,
      smartIndent: true,
      electricChars: false,
      cursorScrollMargin: 24,
      viewportMargin: 24,
      spellcheck: false,
      autocorrect: false,
      autocapitalize: false,
      search: { bottom: false },
      placeholder: "Empty file",
      extraKeys: buildKeys(),
      hintOptions: HINT_OPTIONS,
      showCursorWhenSelecting: true,
    });
    wrapper = cm.getWrapperElement();
    stateEl = document.createElement("div");
    stateEl.className = "texc-ed-state";
    host.appendChild(stateEl);
    showState("empty");

    cm.on("renderLine", onRenderLine);
    cm.on("keydown", onCmKeyDown);
    cm.on("beforeChange", onBeforeChange);
    cm.on("changes", onChangesForHint);
    cm.on("changes", onChangesForCalc);
    cm.on("cursorActivity", () => { if (calc && (calc.entry !== current || cmp(cm.getCursor(), calc.pos) !== 0 || cm.somethingSelected())) hideCalc(); });
    cm.on("blur", () => hideCalc());
    cm.on("cursorActivity", () => scheduleSelection());
    document.addEventListener("keydown", onDocKeyDown, true);

    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(() => scheduleLayout());
      ro.observe(host);
      const dock = document.getElementById("dock-chat");
      if (dock) ro.observe(dock);
    }
    const dock = document.getElementById("dock-chat");
    if (dock) {
      new MutationObserver(() => scheduleLayout(true)).observe(dock, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
      dock.addEventListener("transitionend", () => scheduleLayout());
    }
    window.addEventListener("resize", () => scheduleLayout());
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (cm) remeasure(false); });

    T.bus.on("file:changed", onFileChanged);
    T.bus.on("settings:changed", (d) => applySettings(Object.assign({}, (T.state && T.state.settings) || {}, d || {})));
    T.bus.on("files", () => invalidateCache());
    T.bus.on("project:changed", () => invalidateCache());
    applySettings(T.state && T.state.settings);
    setTimeout(() => { ensureCache().catch(() => {}); }, 2000); // warm up completion data
    scheduleLayout();
    return api;
  }

  // ------------------------------------------------------------------ public API (docs/ARCHITECTURE.md)
  const api = {
    init,
    open,
    show,
    close,
    has: (path) => docs.has(normPath(path)),
    current: () => (current ? current.path : null),
    isDirty: (path) => {
      const e = path ? docs.get(normPath(path)) : current;
      return !!e && (isUnsaved(e) || e.hunks.length > 0);
    },
    save,
    saveAll,
    getContent: (path) => {
      const e = docs.get(normPath(path));
      return e ? e.doc.getValue() : null;
    },
    setContent,
    goto,
    getSelection,
    insertAtCursor(text) {
      if (!cm || !current) return false;
      cm.replaceSelection(String(text == null ? "" : text), "end", "+input");
      cm.focus();
      return true;
    },
    reviewEdits,
    resolve,
    resolveAll,
    pending,
    setOptions,
    refresh() {
      if (!cm) return;
      layout(true);
    },
    // extras
    revealHunk,
    calcSuggestion: () => (calc ? { latex: calc.r.latex, text: calc.r.text != null ? calc.r.text : null, approx: !!calc.r.approx,
      alt: calc.r.alt || null, note: calc.r.note || null, sel: calc.sel } : null),
    acceptCalc,
    calcParts, textChain, // how a formula / a text line splits into the last side and its chain (for the checks)
    focus() { if (cm) cm.focus(); },
    get cm() { return cm; },
  };
  T.editor = api;
})();
