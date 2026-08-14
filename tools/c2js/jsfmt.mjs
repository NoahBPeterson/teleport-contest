// jsfmt.mjs — line splitting for the emitted expressions, in dart_style's shape.
//
// THE PROBLEM
// -----------
// The emitter writes one statement per line and lets it run. 708 lines in
// js/generated were over 400 characters and the longest was 5,090 — a NetHack
// condition with six `||` arms, each a struct-field load, all on one ribbon.
// Every tier of the readability work so far gave the code back a *vocabulary*
// (enum names, field names, sizes, string names, the C's own comments); none of
// them gave it back a *shape*, and a 5,000-character line has none.
//
// THE MODEL: dart_style
// ---------------------
// Dart's formatter is the one to copy here because it solves exactly this
// problem — deeply nested expression code, machine-generated as often as not —
// and its rules are stateable in a paragraph:
//
//   1. A construct is written on one line if it fits the column budget.
//   2. When it does not, it splits at the OUTERMOST boundary first. "Outermost"
//      is operator precedence read backwards: the lowest-precedence operator at
//      the top level of the span is the one that binds the construct together
//      most loosely, so breaking there separates the largest ideas.
//   3. Once an argument list splits, EVERY argument goes on its own line — a
//      half-split list reads worse than either whole.
//   4. A continuation is indented, consistently, so the eye can tell a wrapped
//      line from a new statement.
//
// This module is that, over the token stream, on one emitted line at a time.
//
// THE COLUMN BUDGET IS 100. NetHack's own C is written to 80, but the port
// spends characters the C did not have: `cptr.ldI32o(mtmp, $monst_female)` is
// the transpiled spelling of `mtmp->female`, and 80 columns would split lines
// that say one thing. 100 leaves the common two-load comparison unsplit and
// still fits two windows side by side. `C2JS_FMT_COLS` moves it.
//
// WHERE THE BREAKS GO, AND WHY NONE OF THEM CAN CHANGE THE PROGRAM
// ----------------------------------------------------------------
// A break is only ever inserted at one of five positions:
//
//   * after a binary operator (`a &&` / `b`) — dart_style's rule: the operator
//     stays with the line it continues from, so a line that ends in `||` is
//     visibly unfinished;
//   * before `?` and before `:` of a conditional — dart_style's other rule, and
//     the one that makes a nested condition read as an indented decision tree;
//   * after `(`, `[`, `{` and after the `,` (or the `;` of a `for` header) that
//     separates a list's items, with the closing bracket alone on the last line;
//   * never between `return`/`throw` and their operand, and never before a
//     postfix `++`/`--`.
//
// The last clause is the whole automatic-semicolon-insertion argument. ASI
// inserts a `;` only before a token the grammar cannot accept there; every
// position above continues an expression (a line ending in an operator, a comma
// or an open bracket cannot be terminated, and a line beginning with `?`, `:`
// or a closing bracket cannot start a statement), and the two restricted
// productions JS actually has — `return [no LineTerminator] expr` and
// `expr [no LineTerminator] ++` — are excluded by construction.
//
// That is the argument. The AUDIT is stronger and is what actually ships: every
// reformatted line is re-tokenized and its token sequence compared to the
// original's, value for value. The formatter only ever writes back exact source
// slices with whitespace between them, so a mismatch is impossible in theory
// and fatal in practice — a line that fails is emitted unchanged and counted.
//
// WHY THIS IS WORTH BYTES (the Phase 2 argument)
// ----------------------------------------------
// A 5,090-character line is a single diff hunk. Change one field offset inside
// it and the entire line is rewritten: 5,090 characters of churn for a
// four-character change. Wrapped, the same edit touches one 60-character line.
// Phase 2 scores a merge by the complexity of the diff it takes; every line
// this splits is a line that can be diffed against 5.1 instead of re-read.
//
// `C2JS_FMT=0` restores the one-line-per-statement emission byte-for-byte.

import { tokenize } from './jslex.mjs';

export const FMT_ON = process.env.C2JS_FMT !== '0';
export const FMT_COLS = Number(process.env.C2JS_FMT_COLS || 100);
const UNIT = 4;
const MAX_DEPTH = 60;

export const FMT_STATS = {
  linesSeen: 0, linesWrapped: 0, linesEmitted: 0, unsplittable: 0,
  auditFailed: 0, skippedOddity: 0, trailingCarried: 0, docsWrapped: 0,
  strandedDropped: 0, strandedLevels: 0,
};

// THE STRANDED TAIL, AND THE COST RULE THAT FORBIDS IT
// ----------------------------------------------------
// dart_style does not take the first split it can reach; it takes the one whose
// layout costs least, and a split that buys a whole line for two characters of
// remainder costs more than the over-budget line it was avoiding.  Without that
// rule this formatter produced, in botl.js:
//
//     result = (u32div(
//         (Math.imul(100, uval) >>> 0),
//         (cptr.ldI32(cptr.ldPtro(maxbl, $istat_s_a)))
//     )) |
//             0;
//
// It had already split inside the argument list, then split again at the `|`
// and stranded `0;` on a line of its own at a deeper indent.  The `| 0` is the
// int32 normalization — the least informative token pair in the tree — and it
// belongs on the line it normalizes.
//
// TAIL_MIN is the budget below which a remainder does not earn a line: eight
// characters, which is shorter than every field, enum and helper name the
// vocabulary tiers produce (`$obj_otyp` is 10, `NHC.ROOM` is 8), so the rule
// can only ever fire on punctuation and single short operands.  A candidate
// whose line would carry less than that is dropped, and if that empties a
// precedence level the splitter moves OUTWARD to the next one — which is the
// cost preference, expressed as the thing it actually changes.
//
// Two shapes are short but not stranded and are exempt: a ternary arm (`? 1`,
// `: 0`), which is one branch of a decision and is marked as such, and a line
// that ends in an operator, comma or open bracket, which is visibly unfinished.
//
// `C2JS_FMT_TAILCOST=0` restores the old one-token-of-four-characters filter
// (the A/B baseline), which is also what the last-resort pass uses.
const TAIL_COST = process.env.C2JS_FMT_TAILCOST !== '0';
const TAIL_MIN = 8;

/** would this laid-out line be a stranded tail — a line that says nothing? */
function stranded(line) {
  const t = line.trim();
  if (!t) return false;
  if (/^[?:)\]}]/.test(t)) return false;              // ternary arm, or a closing bracket
  if (/[-+*/%&|^<>=,([{]$/.test(t)) return false;     // ends unfinished: the split is doing work
  return t.length < TAIL_MIN;
}

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '<<=', '>>=', '>>>=', '**=', '&&=', '||=', '??=']);

// lowest precedence first — the order in which a span is asked to split
const BIN_LEVELS = [
  ['||', '??'],
  ['&&'],
  ['|'],
  ['^'],
  ['&'],
  ['==', '!=', '===', '!=='],
  ['<', '>', '<=', '>=', 'instanceof', 'in'],
  ['<<', '>>', '>>>'],
  ['+', '-'],
  ['*', '/', '%'],
];

// keywords that are followed by an operand, so a `+`/`-`/`&` after one of them
// is unary rather than binary
const KEYWORD_NOT_OPERAND = new Set(['return', 'typeof', 'case', 'new', 'delete',
  'void', 'in', 'of', 'instanceof', 'yield', 'await', 'do', 'else', 'throw',
  'let', 'const', 'var', 'export', 'import', 'default']);

const OPEN = { '(': ')', '[': ']', '{': '}' };

const sp = (n) => ' '.repeat(n);

/** does `tok` end an operand? (i.e. is the operator after it binary?) */
function endsOperand(tok) {
  if (!tok) return false;
  if (tok.t === 'num' || tok.t === 'str' || tok.t === 'regex') return true;
  if (tok.t === 'id') return !KEYWORD_NOT_OPERAND.has(tok.v);
  return tok.v === ')' || tok.v === ']' || tok.v === '}' || tok.v === '++' || tok.v === '--';
}

/**
 * A splitter for one line's token range.
 *
 * `src` is the whole text; ranges are token indices and every emitted fragment
 * is an exact `src` slice, which is what makes the audit trivially true.
 */
class Splitter {
  constructor(src, tokens, cols) {
    this.src = src;
    this.tok = tokens;
    this.cols = cols;
  }

  /** exact source text of tokens [a..b]; '' when the range is empty */
  txt(a, b) { return a <= b ? this.src.slice(this.tok[a].i, this.tok[b].j) : ''; }

  /**
   * Bracket pairs fully inside [a..b], and each token's nesting depth.
   * A bracket whose partner is outside the range (the `{` that opens a block at
   * the end of an `if` line, the `}` that closes one at the start of an `else`
   * line) is not a pair and encloses nothing — it is simply a top-level token.
   */
  scan(a, b) {
    const match = new Map();
    const stack = [];
    for (let i = a; i <= b; i++) {
      const t = this.tok[i];
      if (t.t !== 'punc') continue;
      if (OPEN[t.v]) stack.push(i);
      else if (t.v === ')' || t.v === ']' || t.v === '}') {
        // only pair with an open whose partner character agrees
        while (stack.length && OPEN[this.tok[stack[stack.length - 1]].v] !== t.v) stack.pop();
        if (stack.length) { const o = stack.pop(); match.set(o, i); match.set(i, o); }
      }
    }
    const depth = new Array(b - a + 1).fill(0);
    let d = 0;
    for (let i = a; i <= b; i++) {
      const t = this.tok[i];
      const closing = t.t === 'punc' && match.has(i) && match.get(i) < i;
      if (closing) d--;
      depth[i - a] = d;
      if (t.t === 'punc' && match.has(i) && match.get(i) > i) d++;
    }
    return { match, depth: (i) => depth[i - a] };
  }

  /**
   * Lay out tokens [a..b] as one or more lines.
   *
   * `ind`   column of the first line
   * `cont`  column of this construct's continuation lines
   * `pre`   glued to the front of the first line (a peeled head: `if (`, `x = `)
   * `suf`   glued to the end of the last line (a peeled tail: `) {`, `;`)
   */
  lay(a, b, ind, cont, pre = '', suf = '', depth = 0) {
    const flat = pre + this.txt(a, b) + suf;
    if (ind + flat.length <= this.cols || depth > MAX_DEPTH || a > b) return [sp(ind) + flat];
    const s = this.scan(a, b);
    return this.splitStatements(a, b, ind, cont, pre, suf, depth, s)
      ?? this.splitComma(a, b, ind, cont, pre, suf, depth, s)
      ?? this.splitAssign(a, b, ind, cont, pre, suf, depth, s)
      ?? this.splitTernary(a, b, ind, cont, pre, suf, depth, s)
      ?? this.splitBinary(a, b, ind, cont, pre, suf, depth, s)
      ?? this.splitGroup(a, b, ind, cont, pre, suf, depth, s)
      // last resort: a binary split the cost rule would rather not take, but
      // nothing else can break this line at all (see TAIL_MIN)
      ?? this.splitBinary(a, b, ind, cont, pre, suf, depth, s, false)
      ?? [sp(ind) + flat];
  }

  /** top-level indices in [a..b] whose token satisfies `pred` */
  tops(a, b, s, pred) {
    const out = [];
    for (let i = a; i <= b; i++) if (s.depth(i) === 0 && pred(this.tok[i], i)) out.push(i);
    return out;
  }

  /**
   * Several statements sharing one line — the emitter writes an aggregate
   * initializer as a run of `cptr.st*` stores, and `roleabils`' run is 935
   * characters of them. This is not a continuation: each statement goes back to
   * the line's own indent, because that is what it is.
   */
  splitStatements(a, b, ind, cont, pre, suf, depth, s) {
    const at = this.tops(a, b, s, (t, i) => t.t === 'punc' && t.v === ';' && i < b);
    if (!at.length) return null;
    const out = [];
    let from = a;
    for (const p of at) {
      out.push(...this.lay(from, p, ind, ind + 2 * UNIT, from === a ? pre : '', '', depth + 1));
      from = p + 1;
    }
    out.push(...this.lay(from, b, ind, ind + 2 * UNIT, '', suf, depth + 1));
    return out;
  }

  /** `f(a), g(b)` — the comma operator, JS's loosest binding */
  splitComma(a, b, ind, cont, pre, suf, depth, s) {
    const at = this.tops(a, b, s, (t) => t.t === 'punc' && t.v === ',');
    if (!at.length) return null;
    return this.bySeparator(a, b, ind, cont, pre, suf, depth, at, ',');
  }

  /**
   * `lhs = rhs` — the assignment stays on the first line and the RHS is laid out
   * from there, rather than breaking after the `=`. dart_style does the same,
   * and for the same reason: `x =` alone on a line spends a line to say nothing.
   */
  splitAssign(a, b, ind, cont, pre, suf, depth, s) {
    const at = this.tops(a, b, s, (t) => t.t === 'punc' && ASSIGN_OPS.has(t.v));
    if (!at.length) return null;
    const p = at[0]; // assignment is right-associative: peel the leftmost
    if (p >= b) return null;
    return this.lay(p + 1, b, ind, cont, `${pre}${this.txt(a, p)} `, suf, depth + 1);
  }

  /**
   * `cond ? then : else`, as an indented decision tree:
   *
   *     ttyp != NHC.TRAPPED_CHEST
   *         ? one_thing()
   *         : other_thing()
   */
  splitTernary(a, b, ind, cont, pre, suf, depth, s) {
    let q = -1;
    for (let i = a; i <= b; i++) {
      if (s.depth(i) === 0 && this.tok[i].t === 'punc' && this.tok[i].v === '?') { q = i; break; }
    }
    if (q < 0) return null;
    // its `:` is the next top-level one not claimed by a nested `?`
    let pending = 0;
    let c = -1;
    for (let i = q + 1; i <= b; i++) {
      if (s.depth(i) !== 0 || this.tok[i].t !== 'punc') continue;
      if (this.tok[i].v === '?') pending++;
      else if (this.tok[i].v === ':') { if (pending) pending--; else { c = i; break; } }
    }
    if (c < 0 || c === q + 1 || c === b) return null;
    return [
      ...this.lay(a, q - 1, ind, ind + UNIT, pre, '', depth + 1),
      ...this.lay(q + 1, c - 1, cont, cont + UNIT, '? ', '', depth + 1),
      ...this.lay(c + 1, b, cont, cont + UNIT, ': ', suf, depth + 1),
    ];
  }

  /**
   * The lowest-precedence binary operator present at the top level wins — but
   * only if splitting there is worth a line.  See TAIL_MIN above: a candidate
   * whose continuation would carry less than that is dropped, and a level that
   * loses every candidate is skipped in favour of the next one out.
   *
   * `strict` is the cost rule.  `lay()` asks for it first; if neither it nor
   * the bracket split can lay the line out, it asks again without it, so a line
   * that can *only* be split badly is still split rather than left whole — but
   * a line that has a better split waiting one strategy over gets that instead.
   */
  splitBinary(a, b, ind, cont, pre, suf, depth, s, want = true) {
    const strict = want && TAIL_COST;
    for (const ops of BIN_LEVELS) {
      const all = this.tops(a, b, s, (t, i) => {
        if (t.t === 'id' ? !ops.includes(t.v) : (t.t !== 'punc' || !ops.includes(t.v))) return false;
        if (i === a || i === b) return false;              // nothing to split off
        return endsOperand(this.tok[i - 1]);               // binary, not unary
      });
      // the text each candidate's continuation line would carry: its operand,
      // plus the operator that ends it (a middle segment) or the peeled `;`/`)`
      // suffix (the last one).  The `;` is inside the range, which is why the
      // old one-token-of-four-characters test never saw the `| 0;` case at all.
      const at = all.filter((p, k) => {
        const to = k + 1 < all.length ? all[k + 1] - 1 : b;
        if (!strict) return !(to === p + 1 && this.tok[p + 1].j - this.tok[p + 1].i <= 4);
        return !stranded(this.txt(p + 1, to) + (k + 1 < all.length ? ` ${this.tok[all[k + 1]].v}` : suf));
      });
      if (!at.length) { if (strict && all.length) FMT_STATS.strandedLevels++; continue; }
      if (strict) FMT_STATS.strandedDropped += all.length - at.length;
      return this.layBinary(a, b, ind, cont, pre, suf, depth, at);
    }
    return null;
  }

  /** lay [a..b] out broken at each of `at`, the operator ending its own line */
  layBinary(a, b, ind, cont, pre, suf, depth, at) {
    const out = [];
    let from = a;
    for (let k = 0; k < at.length; k++) {
      const p = at[k];
      out.push(...this.lay(from, p - 1, k === 0 ? ind : cont, (k === 0 ? ind : cont) + UNIT,
        k === 0 ? pre : '', ` ${this.tok[p].v}`, depth + 1));
      from = p + 1;
    }
    out.push(...this.lay(from, b, cont, cont + UNIT, '', suf, depth + 1));
    return out;
  }

  /**
   * Break inside the widest bracketed group at the top level: an argument list,
   * an `if`/`while` condition, a `for` header, an array or record literal.
   *
   * A group holding top-level separators becomes one item per line with the
   * closing bracket alone on the last line (rule 3). A group holding a single
   * expression keeps its bracket on the head line and lays the expression out
   * beneath it, so `if (` is never orphaned from its condition.
   */
  splitGroup(a, b, ind, cont, pre, suf, depth, s) {
    let best = -1;
    let bestLen = -1;
    for (let i = a; i <= b; i++) {
      if (s.depth(i) !== 0 || !OPEN[this.tok[i].v] || !s.match.has(i)) continue;
      const c = s.match.get(i);
      if (c <= i + 1) continue; // empty group: nothing to break
      const len = this.tok[c].j - this.tok[i].i;
      if (len > bestLen) { bestLen = len; best = i; }
    }
    if (best < 0) return null;
    const o = best;
    const c = s.match.get(o);
    const head = `${pre}${this.txt(a, o)}`;                 // ... up to and including the open
    const tail = `${this.txt(c, b)}${suf}`;                 // the close and anything after it
    const inner = this.scan(o + 1, c - 1);
    const seps = this.tops(o + 1, c - 1, inner,
      (t) => t.t === 'punc' && (t.v === ',' || t.v === ';'));
    if (!seps.length) {
      return this.lay(o + 1, c - 1, ind, cont, head, tail, depth + 1);
    }
    // one item per line, closing bracket alone at the head line's indent
    const out = [sp(ind) + head];
    let from = o + 1;
    for (const p of seps) {
      out.push(...this.lay(from, p - 1, ind + UNIT, ind + 2 * UNIT, '', this.tok[p].v, depth + 1));
      from = p + 1;
    }
    if (from <= c - 1) out.push(...this.lay(from, c - 1, ind + UNIT, ind + 2 * UNIT, '', '', depth + 1));
    out.push(sp(ind) + tail);
    return out;
  }

  /** items separated by `sep` at the top level, the separator ending each line */
  bySeparator(a, b, ind, cont, pre, suf, depth, at, sep) {
    const out = [];
    let from = a;
    for (let k = 0; k < at.length; k++) {
      const p = at[k];
      out.push(...this.lay(from, p - 1, k === 0 ? ind : cont, (k === 0 ? ind : cont) + UNIT,
        k === 0 ? pre : '', sep, depth + 1));
      from = p + 1;
    }
    out.push(...this.lay(from, b, cont, cont + UNIT, '', suf, depth + 1));
    return out;
  }
}

/**
 * A flat list of names, filled to the budget like a paragraph.
 *
 * dart_style's rule 3 — one item per line once a list breaks — earns its keep
 * on an ARGUMENT list, where each item is an expression the reader has to take
 * in on its own. A list of 150 bare identifiers is not that: it is a paragraph,
 * and one name per line makes it 150 screens of nothing. The field-offset
 * preamble has filled its names since roadmap 1.11 for the same reason; this is
 * that, shared, so the import lists and the reset blocks read the same way.
 */
export function fillItems(items, indent, cols = FMT_COLS, sep = ',') {
  const lines = [];
  let cur = '';
  for (let i = 0; i < items.length; i++) {
    const piece = items[i] + (i === items.length - 1 ? '' : sep);
    if (cur && indent + cur.length + 1 + piece.length > cols) { lines.push(sp(indent) + cur); cur = piece; }
    else cur = cur ? `${cur} ${piece}` : piece;
  }
  if (cur) lines.push(sp(indent) + cur);
  return lines;
}

/** `import { a, b, ... } from './x.js';`, filled when it does not fit */
export function wrapImport(line, cols = FMT_COLS) {
  if (!FMT_ON || line.length <= cols) return line;
  const m = line.match(/^import \{ (.*) \} from ('[^']*');$/);
  if (!m) return line;
  return [`import {`, ...fillItems(m[1].split(', '), UNIT, cols), `} from ${m[2]};`].join('\n');
}

// Our own `/** C ref: ... */` marker, which the JSDoc tiers have grown into a
// full signature: artifact.c:1249's is 237 characters of `@param`. It is the
// one comment in the tree this formatter may reflow, because it is the one
// comment the emitter wrote — the C author's comments carry their author's own
// layout (§9's `do_entity` staircase) and are never touched.
const DOC_MARKER = /^\/\*\*\s*(C ref:[\s\S]*?)\s*\*\/$/;

/** collapse a doc comment to its words, for the reflow audit */
// The em-dash is the marker's own punctuation between the C reference and the
// signature; once the two are on separate lines it has nothing left to join, so
// the audit ignores it on both sides rather than preserving a dangling one.
const docWords = (s) => s.replace(/^\/\*\*|\*\/$/g, '').replace(/^\s*\*/gm, '')
  .split(/\s+/).filter((w) => w && w !== '—').join(' ');

/**
 * Break a one-line `/** C ref: ... *\/` marker into a JSDoc block: the C
 * reference, then one `@param`/`@returns` tag per line, each word-wrapped.
 */
function reflowDoc(raw, indent, cols) {
  const m = raw.trim().match(DOC_MARKER);
  if (!m || raw.includes('*/', raw.indexOf('*/') + 2)) return null;
  const segs = [];
  for (const part of m[1].split(/\s+(?=@)/)) {
    const seg = part.trim().replace(/\s*—$/, '');
    if (seg) segs.push(seg);
  }
  const pad = sp(indent);
  const out = [`${pad}/**`];
  for (const seg of segs) {
    const words = seg.split(/\s+/);
    let line = `${pad} * ${words.shift()}`;
    for (const w of words) {
      if (line.length + 1 + w.length > cols) { out.push(line); line = `${pad} *     ${w}`; }
      else line += ` ${w}`;
    }
    out.push(line);
  }
  out.push(`${pad} */`);
  return docWords(out.join('\n')) === docWords(raw.trim()) ? out : null;
}

/** the (t, v) sequence of `text`, for the audit */
function shape(text) {
  const { tokens, oddities } = tokenize(text);
  if (oddities.length) return null;
  return tokens.map((t) => `${t.t} ${t.v}`).join('');
}

/**
 * Wrap every over-budget line in `text` to `cols`.
 *
 * Everything that is not a run of code tokens on one line is passed through
 * byte-for-byte: blank lines, whole-line comments (which is every comment the
 * C's author wrote and every `C ref:` marker), and any line the lexer could not
 * read cleanly. A TRAILING comment is detached, the code is wrapped, and the
 * comment is re-attached to the LAST line the statement produced — the same
 * rule §9 used to place it, so the `do_entity` staircase survives wrapping.
 */
export function formatSource(text, { cols = FMT_COLS, where = '<text>' } = {}) {
  if (!FMT_ON) return text;
  const { tokens, oddities } = tokenize(text);
  if (oddities.length) { FMT_STATS.skippedOddity++; return text; }

  // line index of each offset, and each line's [start, end) in `text`
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lineOf = (off) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= off) lo = m; else hi = m - 1; }
    return lo;
  };

  // tokens grouped by the line they start on; a token that spans lines (none in
  // this corpus, but a template literal could) marks its lines untouchable
  const first = new Array(starts.length).fill(-1);
  const last = new Array(starts.length).fill(-1);
  const frozen = new Uint8Array(starts.length);
  for (let k = 0; k < tokens.length; k++) {
    const ls = lineOf(tokens[k].i);
    const le = lineOf(tokens[k].j - 1);
    if (le !== ls) { for (let L = ls; L <= le; L++) frozen[L] = 1; continue; }
    if (first[ls] < 0) first[ls] = k;
    last[ls] = k;
  }

  const sput = new Splitter(text, tokens, cols);
  const out = [];
  for (let L = 0; L < starts.length; L++) {
    const end = L + 1 < starts.length ? starts[L + 1] - 1 : text.length;
    const raw = text.slice(starts[L], end);
    if (frozen[L] || first[L] < 0) {
      const doc = raw.length > cols ? reflowDoc(raw, raw.length - raw.trimStart().length, cols) : null;
      if (doc) { FMT_STATS.docsWrapped++; out.push(...doc); } else out.push(raw);
      continue;
    }
    FMT_STATS.linesSeen++;
    if (raw.length <= cols) { out.push(raw); continue; }

    const a = first[L];
    const b = last[L];
    const head = text.slice(starts[L], tokens[a].i);
    const tail = text.slice(tokens[b].j, end);
    // a comment BEFORE the code on a line is not something §9 emits; if one
    // ever appears, leave the line alone rather than guess where it belongs
    if (head.trim() !== '') { out.push(raw); continue; }

    const lines = sput.lay(a, b, head.length, head.length + 2 * UNIT);
    if (lines.length < 2) { FMT_STATS.unsplittable++; out.push(raw); continue; }
    // the audit: same tokens, same order, same text — only whitespace moved
    const want = shape(sput.txt(a, b));
    const got = shape(lines.join('\n'));
    if (want === null || want !== got) {
      FMT_STATS.auditFailed++;
      process.stderr.write(`jsfmt: audit failed, line left unwrapped (${where}:${L + 1})\n`);
      out.push(raw);
      continue;
    }
    if (tail.trimEnd() !== '') FMT_STATS.trailingCarried++;
    lines[lines.length - 1] += tail;
    FMT_STATS.linesWrapped++;
    FMT_STATS.linesEmitted += lines.length;
    out.push(...lines);
  }
  return out.join('\n');
}
