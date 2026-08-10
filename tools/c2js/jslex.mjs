// jslex.mjs — a small, exact-enough lexer for the machine-generated JS in
// js/generated/, plus the hand-written runtime modules it imports.
//
// Why a lexer and not a full parser: the coloring analysis and the yield
// transform both need exactly three facts about a source file —
//   (1) where each top-level function definition begins and ends,
//   (2) where each call site is (direct `foo(`, namespaced `ns.foo(`, or
//       indirect `<expr>(`), and
//   (3) which module each free identifier resolves to (the import map).
// All three are lexical. c2js output is regular by construction (one
// statement per line, no minification, no `with`, no `eval`), so a token
// scanner that correctly skips comments/strings/templates/regexes is exact
// for this corpus. Anything it cannot classify it reports rather than
// guesses — see the `oddities` array on the result.
//
// Not a general JS lexer. It knows only the constructs c2js emits and the
// ones the hand-written runtime uses.

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$]/;

// tokens after which a `/` starts a regex literal rather than a division
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '=>', '+', '-',
  '*', '%', '<', '>', '~', '^', '&&', '||', '??', '===', '!==', '==', '!=',
  '<=', '>=', '+=', '-=', '*=', '/=', 'return', 'typeof', 'instanceof', 'in',
  'of', 'new', 'delete', 'void', 'do', 'else', 'case', 'yield',
]);

/**
 * Tokenize `src`. Returns { tokens, oddities }.
 *
 * A token is { t, v, i, j } where `t` is one of:
 *   'id'   identifier or keyword   (v = text)
 *   'num'  numeric literal
 *   'str'  string / template literal (whole literal, templates included)
 *   'regex'
 *   'punc' everything else (v = the operator text, longest-match)
 * `i`/`j` are [start, end) byte offsets into src. Comments are dropped but
 * recorded as gaps; call sites never span a comment in c2js output.
 */
export function tokenize(src) {
  const tokens = [];
  const oddities = [];
  const n = src.length;
  let i = 0;
  let lastSig = null; // last significant token, for regex disambiguation

  const push = (t, v, s, e) => {
    const tok = { t, v, i: s, j: e };
    tokens.push(tok);
    lastSig = tok;
    return tok;
  };

  while (i < n) {
    const c = src[i];

    // whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    // comments
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) { oddities.push({ at: i, why: 'unterminated block comment' }); i = n; continue; }
      i = e + 2;
      continue;
    }

    // strings
    if (c === '"' || c === "'") {
      const s = i;
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') i++;
        else if (src[i] === '\n') { oddities.push({ at: s, why: 'newline in string' }); break; }
        i++;
      }
      i++; // closing quote
      push('str', src.slice(s, i), s, i);
      continue;
    }

    // template literals (with ${} nesting — the runtime uses them)
    if (c === '`') {
      const s = i;
      i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (depth === 0 && src[i] === '`') { i++; break; }
        if (depth === 0 && src[i] === '$' && src[i + 1] === '{') { depth++; i += 2; continue; }
        if (depth > 0) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') depth--;
          else if (src[i] === '`') {
            // nested template inside ${} — rare; scan it crudely
            i++;
            while (i < n && src[i] !== '`') { if (src[i] === '\\') i++; i++; }
          }
        }
        i++;
      }
      push('str', src.slice(s, i), s, i);
      continue;
    }

    // regex literal or division
    if (c === '/') {
      const prev = lastSig;
      const isRegex = !prev
        || (prev.t === 'punc' && REGEX_PRECEDERS.has(prev.v))
        || (prev.t === 'id' && REGEX_PRECEDERS.has(prev.v));
      if (isRegex) {
        const s = i;
        i++;
        let inClass = false;
        while (i < n) {
          const d = src[i];
          if (d === '\\') { i += 2; continue; }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { i++; break; }
          else if (d === '\n') { oddities.push({ at: s, why: 'newline in regex' }); break; }
          i++;
        }
        while (i < n && ID_PART.test(src[i])) i++; // flags
        push('regex', src.slice(s, i), s, i);
        continue;
      }
      // division
      const s = i;
      i += src[i + 1] === '=' ? 2 : 1;
      push('punc', src.slice(s, i), s, i);
      continue;
    }

    // numbers (including BigInt `123n` and hex)
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const s = i;
      while (i < n && /[0-9a-fA-FxXoObBnN._]/.test(src[i])) {
        // exponent sign
        if ((src[i] === 'e' || src[i] === 'E') && /[+-]/.test(src[i + 1] || '')) i++;
        i++;
      }
      push('num', src.slice(s, i), s, i);
      continue;
    }

    // identifiers
    if (ID_START.test(c)) {
      const s = i;
      while (i < n && ID_PART.test(src[i])) i++;
      push('id', src.slice(s, i), s, i);
      continue;
    }

    // punctuation, longest match first
    const s = i;
    const three = src.substr(i, 3);
    const four = src.substr(i, 4);
    if (four === '>>>=') i += 4;
    else if (['===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??='].includes(three)) i += 3;
    else if (['==', '!=', '<=', '>=', '&&', '||', '??', '?.', '=>', '++', '--',
      '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**'].includes(src.substr(i, 2))) i += 2;
    else i += 1;
    push('punc', src.slice(s, i), s, i);
  }

  return { tokens, oddities };
}

/** keywords whose following `( ... )` is a statement head, not an expression */
const STATEMENT_HEAD_KEYWORDS = new Set(['if', 'while', 'for', 'switch', 'catch', 'function', 'with']);

const KEYWORDS_BEFORE_PAREN = new Set([
  'if', 'while', 'for', 'switch', 'catch', 'return', 'typeof', 'function',
  'new', 'delete', 'void', 'throw', 'do', 'else', 'case', 'in', 'of', 'yield',
  'await', 'instanceof', 'with', 'super', 'import', 'export', 'const', 'let',
  'var', 'class', 'extends', 'try', 'finally', 'default', 'break', 'continue',
]);

/**
 * Structural scan of a tokenized module.
 *
 * Returns {
 *   imports:  Map(localName -> { module, imported })   // named imports
 *   nsImports: Map(localName -> module)                // `import * as ns`
 *   exports:  Set(name)
 *   funcs:    [{ name, exported, tokStart, tokEnd, bodyStart, bodyEnd, depthAtDecl }]
 *   calls:    [{ kind, name, ns, tokIdx, i, j, inFunc, inArrow }]
 *   arrows:   [{ tokStart, tokEnd }]
 * }
 *
 * `calls[].kind` is 'direct' (bare identifier), 'ns' (`ns.f(`), 'member'
 * (`obj.f(` where obj is not an import namespace) or 'indirect' (`)(` — a
 * call through a computed callee, i.e. a C function pointer).
 */
export function scanModule(src, { file } = {}) {
  const { tokens, oddities } = tokenize(src);
  // Names bound locally (parameters, let/const/var) and at module scope.
  // A call `p(x)` where `p` is one of these is NOT a call to a module
  // function — it is a call through a C function pointer held in a variable,
  // which is syntactically indistinguishable from a direct call and is the
  // single easiest thing to get wrong here. getobj's `obj_ok` parameter is
  // the canonical case: it holds wear_ok/ring_ok/..., and treating it as an
  // unresolved global silently loses every one of those edges.
  const { localsByFunc, moduleVars } = collectBindings(tokens);
  const imports = new Map();
  const nsImports = new Map();
  const exports = new Set();
  const funcs = [];
  const calls = [];
  const arrows = [];

  // ---- imports ----
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].t !== 'id' || tokens[k].v !== 'import') continue;
    // `import * as NS from 'mod';`
    if (tokens[k + 1]?.v === '*' && tokens[k + 2]?.v === 'as') {
      const local = tokens[k + 3]?.v;
      const from = tokens[k + 5];
      if (local && from?.t === 'str') nsImports.set(local, unquote(from.v));
      continue;
    }
    // `import { a, b as c } from 'mod';`
    if (tokens[k + 1]?.v === '{') {
      let m = k + 2;
      const names = [];
      while (m < tokens.length && tokens[m].v !== '}') {
        if (tokens[m].t === 'id') {
          if (tokens[m + 1]?.v === 'as') { names.push([tokens[m + 2].v, tokens[m].v]); m += 3; continue; }
          names.push([tokens[m].v, tokens[m].v]);
        }
        m++;
      }
      // `from 'mod'`
      const from = tokens[m + 2];
      const mod = from?.t === 'str' ? unquote(from.v) : null;
      for (const [local, imported] of names) imports.set(local, { module: mod, imported });
      continue;
    }
  }

  // ---- brace tracking + function bodies + arrows + calls ----
  // A stack of open scopes; each entry is { kind: 'fn'|'arrow'|'block', fnIdx }
  const scope = [];
  let depth = 0;
  let pendingFn = null; // a `function NAME(...)` awaiting its `{`

  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];

    // --- function declarations ---
    if (tk.t === 'id' && tk.v === 'function') {
      const nameTok = tokens[k + 1];
      const exported = tokens[k - 1]?.v === 'export'
        || (tokens[k - 1]?.v === 'default' && tokens[k - 2]?.v === 'export');
      if (nameTok?.t === 'id') {
        pendingFn = {
          name: nameTok.v,
          exported,
          tokStart: k,
          declStart: exported ? k - 1 : k,
          depthAtDecl: depth,
          nested: scope.some((s) => s.kind === 'fn' || s.kind === 'arrow'),
        };
      }
      continue;
    }

    // --- arrow functions: `) =>` or `x =>` ---
    if (tk.t === 'punc' && tk.v === '=>') {
      // body is either a block `{...}` or an expression up to the next
      // comma/`)` at the current depth
      const bodyTok = tokens[k + 1];
      if (bodyTok?.v === '{') {
        arrows.push({ tokStart: k, tokEnd: matchBrace(tokens, k + 1) });
      } else {
        arrows.push({ tokStart: k, tokEnd: exprEnd(tokens, k + 1) });
      }
      continue;
    }

    if (tk.t === 'punc' && (tk.v === '{')) {
      if (pendingFn) {
        const end = matchBrace(tokens, k);
        const f = {
          ...pendingFn,
          bodyOpenTok: k,
          bodyCloseTok: end,
          i: tokens[pendingFn.declStart].i,
          j: tokens[end]?.j ?? src.length,
        };
        funcs.push(f);
        scope.push({ kind: 'fn', fnIdx: funcs.length - 1, closeTok: end });
        pendingFn = null;
      } else {
        scope.push({ kind: 'block', closeTok: matchBrace(tokens, k) });
      }
      depth++;
      continue;
    }
    if (tk.t === 'punc' && tk.v === '}') {
      scope.pop();
      depth--;
      continue;
    }

    // --- call sites ---
    if (tk.t === 'punc' && tk.v === '(') {
      const prev = tokens[k - 1];
      if (!prev) continue;
      const enclosing = enclosingFn(scope, funcs);
      const inArrow = arrows.some((a) => a.tokStart < k && k < a.tokEnd);
      // `function NAME(` — the parameter list of a definition, not a call
      if (prev.t === 'id' && tokens[k - 2]?.t === 'id' && tokens[k - 2].v === 'function') continue;
      // `i` must be the start of the WHOLE callee expression, not of its last
      // token: a rewrite that wraps from the wrong place turns
      // `cptr.ldPtro3(t, i, 24, 16)(a)` into `cptr.ldPtro3` applied to nothing.
      const ci = (t) => tokens[calleeStart(tokens, k)].i;
      if (prev.t === 'id' && !KEYWORDS_BEFORE_PAREN.has(prev.v)) {
        // `ns.f(` / `obj.f(`
        if (tokens[k - 2]?.v === '.' && tokens[k - 3]?.t === 'id') {
          const ns = tokens[k - 3].v;
          calls.push({
            kind: nsImports.has(ns) ? 'ns' : 'member',
            name: prev.v, ns, tokIdx: k, i: ci(), j: tk.j,
            inFunc: enclosing, inArrow,
          });
        } else if (tokens[k - 2]?.v === '.') {
          calls.push({ kind: 'member', name: prev.v, ns: null, tokIdx: k, i: ci(), j: tk.j, inFunc: enclosing, inArrow });
        } else {
          const isLocal = (enclosing && localsByFunc.get(enclosing)?.has(prev.v)) || moduleVars.has(prev.v);
          calls.push({
            kind: isLocal ? 'indirect' : 'direct',
            name: prev.v, ns: null, tokIdx: k, i: prev.i, j: tk.j,
            inFunc: enclosing, inArrow, viaVar: isLocal ? prev.v : undefined,
          });
        }
      } else if (prev.t === 'punc' && (prev.v === ')' || prev.v === ']')) {
        // `<expr>(` — call through a computed callee: a C function pointer.
        const open = prev.v === ')' ? matchParenBack(tokens, k - 1) : matchBracketBack(tokens, k - 1);
        const beforeOpen = tokens[open - 1];
        // `if (...) (` and friends are not calls
        const isControl = beforeOpen?.t === 'id' && ['if', 'while', 'for', 'switch', 'catch'].includes(beforeOpen.v);
        // `(function () { ... })()` — an IIFE the emitter uses for aggregate
        // initialisers, not a C function-pointer call.
        const isIife = prev.v === ')' && tokens[open + 1]?.t === 'id' && tokens[open + 1].v === 'function';
        if (!isControl && !isIife) {
          calls.push({ kind: 'indirect', name: null, ns: null, tokIdx: k, i: ci(), j: tk.j, inFunc: enclosing, inArrow, openTok: open });
        }
      }
      continue;
    }

    // --- exports of consts/lets ---
    if (tk.t === 'id' && tk.v === 'export' && tokens[k + 1]?.t === 'id'
        && ['const', 'let', 'var'].includes(tokens[k + 1].v) && tokens[k + 2]?.t === 'id') {
      exports.add(tokens[k + 2].v);
    }
  }

  for (const f of funcs) if (f.exported) exports.add(f.name);

  return { file, src, tokens, imports, nsImports, exports, funcs, calls, arrows, oddities };
}

/**
 * Collect locally-bound names per top-level function, plus module-scope
 * `let`/`const`/`var` names.
 *
 * Deliberately over-collects: every declaration anywhere inside a function
 * body lands in that function's set regardless of block scope. Over-collecting
 * only ever reclassifies a call as indirect, which is the conservative
 * direction (an indirect call is `yield*`-delegated through a shim that
 * handles both plain functions and generators). Under-collecting is what
 * silently breaks the engine.
 */
function collectBindings(tokens) {
  const localsByFunc = new Map();
  const moduleVars = new Set();
  let cur = null;        // name of the top-level function being scanned
  let curSet = null;
  let fnDepth = -1;      // brace depth at which the current function opened
  let depth = 0;
  let pendingName = null;

  const declare = (name, k) => {
    if (curSet) curSet.add(name);
    else moduleVars.add(name);
  };

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t === 'id' && t.v === 'function' && tokens[k + 1]?.t === 'id') {
      pendingName = tokens[k + 1].v;
      // parameters: identifiers inside the decl's parentheses
      const open = k + 2;
      if (tokens[open]?.v === '(') {
        const set = new Set();
        for (let m = open + 1; m < tokens.length && tokens[m].v !== ')'; m++) {
          if (tokens[m].t === 'id') set.add(tokens[m].v);
        }
        localsByFunc.set(pendingName, set);
      }
      continue;
    }
    if (t.t === 'punc' && t.v === '{') {
      if (pendingName && curSet === null) {
        cur = pendingName;
        curSet = localsByFunc.get(cur) || new Set();
        localsByFunc.set(cur, curSet);
        fnDepth = depth;
      }
      pendingName = null;
      depth++;
      continue;
    }
    if (t.t === 'punc' && t.v === '}') {
      depth--;
      if (curSet !== null && depth === fnDepth) { cur = null; curSet = null; fnDepth = -1; }
      continue;
    }
    if (t.t === 'id' && (t.v === 'let' || t.v === 'const' || t.v === 'var')) {
      // `let a, b = f(), c;` — take the identifier after the keyword and
      // after each top-level comma, stopping at the statement's `;`.
      let m = k + 1;
      let d = 0;
      let expectName = true;
      for (; m < tokens.length; m++) {
        const x = tokens[m];
        const v = x.t === 'punc' ? x.v : null;
        if (v === '(' || v === '[' || v === '{') { d++; continue; }
        if (v === ')' || v === ']' || v === '}') { if (d === 0) break; d--; continue; }
        if (d === 0 && v === ';') break;
        if (d === 0 && v === ',') { expectName = true; continue; }
        if (d === 0 && expectName && x.t === 'id') { declare(x.v, m); expectName = false; continue; }
        if (d === 0 && v === '=') expectName = false;
      }
      continue;
    }
    if (t.t === 'id' && t.v === 'catch' && tokens[k + 1]?.v === '(' && tokens[k + 2]?.t === 'id') {
      declare(tokens[k + 2].v, k + 2);
    }
  }
  return { localsByFunc, moduleVars };
}

function unquote(s) { return s.slice(1, -1); }

/** index of the `}` matching the `{` at tokens[k] */
function matchBrace(tokens, k) {
  let d = 0;
  for (let m = k; m < tokens.length; m++) {
    const v = tokens[m].t === 'punc' ? tokens[m].v : null;
    if (v === '{') d++;
    else if (v === '}') { d--; if (d === 0) return m; }
  }
  return tokens.length - 1;
}

/**
 * Index of the first token of the callee expression of the call whose opening
 * `(` is at tokens[callParen].
 *
 * Walks left over a member/call/index chain: `a.b.c[i](x)(y)(` all belong to
 * one callee. Stops at anything that cannot continue a primary expression, and
 * never absorbs a keyword (`return (f)(x)` must not start at `return`).
 */
function calleeStart(tokens, callParen) {
  let start = callParen;
  let k = callParen - 1;
  for (;;) {
    const tk = tokens[k];
    if (!tk) break;
    if (tk.t === 'id') {
      if (KEYWORDS_BEFORE_PAREN.has(tk.v)) break;
      start = k;
    } else if (tk.t === 'punc' && (tk.v === ')' || tk.v === ']')) {
      const open = tk.v === ')' ? matchParenBack(tokens, k) : matchBracketBack(tokens, k);
      const before = tokens[open - 1];
      // `for (...) (f)(x)` — a STATEMENT head's parens are not part of the
      // callee. Prefix operators are a different matter: in `void (p)()` and
      // `return (p)(x)` the group is exactly the callee, so only the true
      // statement heads terminate the walk.
      if (before && before.t === 'id' && STATEMENT_HEAD_KEYWORDS.has(before.v)) break;
      start = open;
      k = open;
    } else break;
    // keep going left only through what can continue a primary expression
    const p = tokens[k - 1];
    if (!p) break;
    if (p.t === 'punc' && p.v === '.' && tokens[k - 2]) { k -= 2; continue; }
    if (p.t === 'id' && !KEYWORDS_BEFORE_PAREN.has(p.v)) { k -= 1; continue; }
    if (p.t === 'punc' && (p.v === ')' || p.v === ']')) { k -= 1; continue; }
    break;
  }
  return start;
}

/** index of the `[` matching the `]` at tokens[k] */
function matchBracketBack(tokens, k) {
  let d = 0;
  for (let m = k; m >= 0; m--) {
    const v = tokens[m].t === 'punc' ? tokens[m].v : null;
    if (v === ']') d++;
    else if (v === '[') { d--; if (d === 0) return m; }
  }
  return 0;
}

/** index of the `(` matching the `)` at tokens[k] */
function matchParenBack(tokens, k) {
  let d = 0;
  for (let m = k; m >= 0; m--) {
    const v = tokens[m].t === 'punc' ? tokens[m].v : null;
    if (v === ')') d++;
    else if (v === '(') { d--; if (d === 0) return m; }
  }
  return 0;
}

/** end of a comma/paren-delimited expression starting at tokens[k] */
function exprEnd(tokens, k) {
  let d = 0;
  for (let m = k; m < tokens.length; m++) {
    const v = tokens[m].t === 'punc' ? tokens[m].v : null;
    if (v === '(' || v === '[' || v === '{') d++;
    else if (v === ')' || v === ']' || v === '}') { if (d === 0) return m; d--; }
    else if (v === ',' && d === 0) return m;
    else if (v === ';' && d === 0) return m;
  }
  return tokens.length - 1;
}

/** innermost enclosing top-level function name, or null */
function enclosingFn(scope, funcs) {
  for (let m = scope.length - 1; m >= 0; m--) {
    if (scope[m].kind === 'fn') return funcs[scope[m].fnIdx].name;
  }
  return null;
}
