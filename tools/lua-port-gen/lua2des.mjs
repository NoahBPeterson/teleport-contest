#!/usr/bin/env node
// lua2des.mjs — generator: a NetHack .lua level script -> a readable JS port
// module.
//
// WHY A SECOND GENERATOR. tools/lua-port-gen/lua2js.mjs handles the two
// *read-back* scripts, whose whole body is one table constructor. The level
// scripts are the other shape: a stream of `des.*` calls. Between the 49 T0
// files alone there are 917 des.monster() calls, 601 des.object() calls and 34
// maps; transcribing that by hand is exactly the kind of work that produces a
// one-character error the corpus would never notice. So the transcription is
// mechanical and the *result* is reviewed and re-checked.
//
// WHAT IT PARSES.
//   * comments (kept, in place, so the JS mirrors the .lua line for line)
//   * `des.NAME(args)` and `sel:method(args)` statements
//   * `local NAME = exp`, and a bare `NAME = exp` (NetHack has one script that
//     forgets the `local`)
//   * literals, long strings, table constructors, `a.b`, `a[k]`, `a:m(args)`,
//     nested calls (`selection.area(...)`, `nh.eckey(...)`), `..` and `#`
//   * S3: `if cond then … elseif … else … end`, `percent(n)`, `shuffle(t)`,
//     `math.random(…)`, `d(…)` and `function() … end` closures
//   * S4: numeric `for i = a, b[, step] do … end`, `repeat … until e`,
//     `function NAME(…) … end` and `return`, `local x` with no initialiser and
//     assignment to an already-declared name, the arithmetic operators
//     `+ - * / // %`, the comparisons `== ~= < <= > >=`, `and`/`or`/`not`,
//     parentheses, and the selection algebra operators `|` and `&`
// Anything else — `while`, `break`, `goto`, a generic `for k,v in …`, `^`,
// `<<`/`>>`/`~` (bitwise xor and not) — is a hard error, so a 5.1 script that
// grows one fails loudly rather than being quietly mistranslated.
//
// LUA SEMANTICS vs JS SEMANTICS. The two disagree in three places this file
// has to be careful about, and in each case the *emitter* writes the natural
// JS while the *--check interpreter* implements Lua's rule, so a script that
// lands in the gap is caught by the check rather than mistranslated silently:
//
//   * truthiness. Lua's only false values are `false` and `nil`; JS also has
//     0, "" and NaN. `a and b`/`a or b`/`not a` emit `&&`/`||`/`!`, and
//     evalNode() below uses Lua's rule, so `0 or 5` would diverge. The
//     emitter additionally refuses an `and`/`or` operand that is literally
//     `0` or `""`, which is where the difference actually shows up.
//   * `%`. Lua's is floor-modulo, JS's is truncated; they differ only when an
//     operand is negative. The emitter writes `a % b` and the interpreter
//     computes Lua's, so a negative operand diverges instead of passing.
//   * `//`. Lua's floor division becomes `Math.floor(a / b)`, which is what it
//     means for the integer operands this corpus uses.
//
// WHAT IT EMITS. A module whose default export is the ported script, keeping
// the source's statement order, its comments and its line breaks, so a Phase-2
// reviewer diffing a 5.1 .lua against this .mjs sees the same shape twice:
//
//     export default function Arc_goal({ des, selection }) {
//         des.level_init({ style: 'solidfill', fg: ' ' });
//         // Dungeon Description
//         des.region(selection.area(0, 0, 75, 19), 'lit');
//     }
//
// HOW IT IS CHECKED. `--check` imports the emitted module, runs it against a
// recording stub API driven by a *deterministic* RNG, and compares the
// resulting call stream — every call name, every argument, every table key in
// order — against the stream the same stub produces when this file's own
// interpreter walks the .lua. Both sides share one RNG object and one copy of
// nhlib's percent/shuffle/math.random (js/lua-js/nhlib.mjs), so the comparison
// also pins the *number and order* of draws the script itself spends: a port
// that took the other branch of an `if percent(…)`, or shuffled a list of the
// wrong length, desynchronises the shared counter and every later call differs.
//
// The check runs several RNG settings, including one that forces every
// `percent()` true and one that forces every `percent()` false, so both sides
// of every branch are transcribed-checked rather than only the one a random
// draw happened to pick. test/lua-port-scripts.test.mjs runs it over every
// generated port on every `node --test`.
//
// Usage:
//   node tools/lua-port-gen/lua2des.mjs <in.lua> <out.mjs>
//   node tools/lua-port-gen/lua2des.mjs --check <in.lua> <out.mjs>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { luaLen, luaList, makeNhlib } from '../../js/lua-js/nhlib.mjs';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

const PUNCT3 = [];
const PUNCT2 = ['..', '==', '~=', '<=', '>=', '//'];
const PUNCT1 = ['{', '}', '[', ']', '(', ')', '=', ',', ';', '.', ':', '#',
    '+', '-', '*', '/', '%', '<', '>', '|', '&'];

const KEYWORDS = new Set(['true', 'false', 'nil', 'local',
    'if', 'then', 'elseif', 'else', 'end', 'function',
    'for', 'do', 'repeat', 'until', 'return', 'and', 'or', 'not']);
/**
 * Lua keywords this subset still refuses outright. `while` and `break` appear
 * nowhere in the 131-file corpus; `in` would mean a generic `for k,v in …`,
 * which only the two library files use. A script that grows one must fail here
 * rather than be quietly mistranslated.
 */
const REJECTED = new Set(['while', 'break', 'goto', 'in']);

/**
 * @param {string} src
 * @returns {{k: string, v: any, line: number}[]} tokens; k is one of
 *   'punct' | 'name' | 'str' | 'num' | 'kw' | 'comment' | 'eof'
 */
export function lex(src) {
    const toks = [];
    let i = 0, line = 1;
    const err = (m) => { throw new Error(`lua2des: line ${line}: ${m}`); };

    // `[[ ... ]]` / `[==[ ... ]==]`; returns the body or null if `i` is not a
    // long bracket. Lua drops one newline immediately after the opener.
    const longBracket = () => {
        let j = i + 1, eq = 0;
        while (src[j] === '=') { eq++; j++; }
        if (src[j] !== '[') return null;
        j++;
        if (src[j] === '\r') j++;
        if (src[j] === '\n') { j++; line++; }
        const close = ']' + '='.repeat(eq) + ']';
        const end = src.indexOf(close, j);
        if (end < 0) err('unterminated long bracket');
        const body = src.slice(j, end);
        for (const c of body) if (c === '\n') line++;
        i = end + close.length;
        return body;
    };

    while (i < src.length) {
        const c = src[i];
        if (c === '\n') { line++; i++; continue; }
        if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
        if (c === '-' && src[i + 1] === '-') {
            const startLine = line;
            i += 2;
            if (src[i] === '[') {
                const body = longBracket();
                if (body !== null) { toks.push({ k: 'comment', v: body, line: startLine, long: true }); continue; }
            }
            let j = i;
            while (j < src.length && src[j] !== '\n') j++;
            toks.push({ k: 'comment', v: src.slice(i, j), line: startLine });
            i = j;
            continue;
        }
        if (c === '[' && (src[i + 1] === '[' || src[i + 1] === '=')) {
            const startLine = line;
            const body = longBracket();
            if (body !== null) { toks.push({ k: 'str', v: body, line: startLine, long: true }); continue; }
        }
        if (c === '"' || c === "'") {
            const q = c, startLine = line;
            let out = '';
            i++;
            for (;;) {
                if (i >= src.length) err('unterminated string');
                const d = src[i];
                if (d === q) { i++; break; }
                if (d === '\n') err('newline in short string');
                if (d === '\\') {
                    const e = src[i + 1];
                    const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };
                    if (e in simple) { out += simple[e]; if (e === '\n') line++; i += 2; continue; }
                    err(`unsupported string escape \\${e}`);
                }
                out += d; i++;
            }
            toks.push({ k: 'str', v: out, line: startLine });
            continue;
        }
        // Numbers are unsigned here; a leading '-' is the unary operator, which
        // the parser folds back into the literal when it emits (`-1` stays
        // `-1`). Gluing it on in the lexer would break `x-1`.
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
            const m = /^(0[xX][0-9a-fA-F]+|[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?)/.exec(src.slice(i));
            if (!m) err('bad number');
            toks.push({ k: 'num', v: Number(m[0]), line });
            i += m[0].length;
            continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            const w = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))[0];
            i += w.length;
            if (REJECTED.has(w)) err(`'${w}' is outside the supported subset — port this script by hand`);
            toks.push({ k: KEYWORDS.has(w) ? 'kw' : 'name', v: w, line });
            continue;
        }
        const three = src.slice(i, i + 3), two = src.slice(i, i + 2);
        if (PUNCT3.includes(three)) { toks.push({ k: 'punct', v: three, line }); i += 3; continue; }
        if (PUNCT2.includes(two)) { toks.push({ k: 'punct', v: two, line }); i += 2; continue; }
        if (PUNCT1.includes(c)) { toks.push({ k: 'punct', v: c, line }); i++; continue; }
        err(`unexpected character ${JSON.stringify(c)}`);
    }
    toks.push({ k: 'eof', v: null, line });
    return toks;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------
//
// AST node kinds:
//   {t:'lit',   v, long, line}          literal (number/string/boolean/nil)
//   {t:'name',  v, line}                a variable reference
//   {t:'field', obj, name, line}        a.b
//   {t:'index', obj, key, line}         a[k]
//   {t:'len',   obj, line}              #a
//   {t:'call',  fn, args, line}         f(...)
//   {t:'method',obj, name, args, line}  a:m(...)
//   {t:'table', entries, positional, line}
//   {t:'concat',parts, line}            a .. b .. c
//   {t:'func',  params, body, line}     function(...) ... end
//   {t:'binop', op, l, r, line}         a + b, a == b, a and b, a | b, …
//   {t:'unop',  op, e, line}            -a, not a
//   {t:'paren', e, line}                ( a )   — kept so the port's shape
//                                       matches the .lua's line for line
// Statements:
//   {s:'comment', text, long, line}
//   {s:'local',   name, value, line}    local x = e   (global:true if no `local`;
//                                       value null for a bare `local x`)
//   {s:'assign',  name, value, line}    x = e, where x is already in scope
//   {s:'call',    call, line}
//   {s:'if',      clauses:[{cond, body}], otherwise, line}
//   {s:'for',     name, from, to, step, body, line}   numeric for
//   {s:'repeat',  body, cond, line}     repeat … until e
//   {s:'return',  value, line}
//   {s:'funcdecl',name, params, body, line}   function NAME(…) … end

export function parse(src) {
    const toks = lex(src);
    let p = 0;
    const peek = () => toks[p];
    const err = (m) => { throw new Error(`lua2des: line ${peek().line}: ${m}`); };
    const at = (k, v) => peek().k === k && (v === undefined || peek().v === v);
    const eat = (k, v) => {
        const t = toks[p];
        if (t.k !== k || (v !== undefined && t.v !== v)) err(`expected ${v ?? k}, got ${JSON.stringify(t.v)}`);
        p++;
        return t;
    };

    function table() {
        const line = peek().line;
        eat('punct', '{');
        const node = { t: 'table', entries: [], positional: 0, line, endLine: line };
        while (!at('punct', '}')) {
            const eline = peek().line;
            // dat/bigrm-13.lua numbers its eight pillar-filter closures with a
            // comment above each. Keeping them in the entry list keeps them in
            // the emitted JS, above the same closure.
            if (at('comment')) {
                const c = toks[p++];
                node.entries.push({ comment: String(c.v), line: c.line });
                continue;
            }
            if (at('name') && toks[p + 1].k === 'punct' && toks[p + 1].v === '=') {
                const k = eat('name').v; eat('punct', '=');
                node.entries.push({ key: k, value: exp(), line: eline });
            } else if (at('punct', '[')) {
                eat('punct', '[');
                const kt = peek();
                if (kt.k !== 'str' && kt.k !== 'num') err('only string/number table keys are supported');
                p++;
                eat('punct', ']'); eat('punct', '=');
                node.entries.push({ key: kt.v, value: exp(), line: eline, bracketed: true });
            } else {
                node.positional++;
                node.entries.push({ key: null, value: exp(), line: eline });
            }
            if (at('punct', ',') || at('punct', ';')) p++;
            else break;
        }
        node.endLine = peek().line;
        eat('punct', '}');
        return node;
    }

    /** args := '(' [explist] ')' | tablector | string */
    function args() {
        if (at('punct', '{')) return [table()];
        if (at('str')) return [primary()];
        eat('punct', '(');
        const out = [];
        while (!at('punct', ')')) {
            out.push(exp());
            if (at('punct', ',')) p++;
            else break;
        }
        eat('punct', ')');
        return out;
    }

    /** `function ( [names] ) block end` — always anonymous in this corpus. */
    function funcBody(line) {
        eat('punct', '(');
        const params = [];
        while (!at('punct', ')')) {
            params.push(eat('name').v);
            if (at('punct', ',')) p++;
            else break;
        }
        eat('punct', ')');
        const body = block();
        const endLine = peek().line;
        eat('kw', 'end');
        return { t: 'func', params, body, line, endLine };
    }

    function primary() {
        const t = peek();
        if (t.k === 'str' || t.k === 'num') { p++; return { t: 'lit', v: t.v, long: !!t.long, line: t.line }; }
        if (t.k === 'kw') {
            if (t.v === 'function') { p++; return funcBody(t.line); }
            if (t.v !== 'true' && t.v !== 'false' && t.v !== 'nil') err(`'${t.v}' is not a value`);
            p++;
            return { t: 'lit', v: t.v === 'true' ? true : t.v === 'false' ? false : null, line: t.line };
        }
        if (at('punct', '{')) return table();
        // `( e )` — a parenthesised sub-expression. Kept as its own node so
        // the emitted JS carries the same parentheses the .lua wrote, and can
        // still be called or indexed: `(f)(x)`, `filters[idx](x, y)`.
        if (at('punct', '(')) {
            p++;
            const e = exp();
            eat('punct', ')');
            return suffixed({ t: 'paren', e, line: t.line });
        }
        if (t.k === 'name') { p++; return suffixed({ t: 'name', v: t.v, line: t.line }); }
        return err(`expected a value, got ${JSON.stringify(t.v)}`);
    }

    /** The `.name` / `[exp]` / `:name(args)` / `(args)` chain after a name. */
    function suffixed(node) {
        for (;;) {
            const line = peek().line;
            if (at('punct', '.')) { p++; node = { t: 'field', obj: node, name: eat('name').v, line }; }
            else if (at('punct', '[')) { p++; const k = exp(); eat('punct', ']'); node = { t: 'index', obj: node, key: k, line }; }
            else if (at('punct', ':')) { p++; const m = eat('name').v; node = { t: 'method', obj: node, name: m, args: args(), line }; }
            else if (at('punct', '(') || at('punct', '{') || at('str')) { node = { t: 'call', fn: node, args: args(), line, endLine: toks[p - 1].line }; }
            else return node;
        }
    }

    /**
     * Lua 5.4's binary priorities, left and right. `..` is right-associative
     * (hence right < left); everything else this subset accepts is left.
     * Deliberately absent: `^`, `<<`, `>>` and `~` (binary xor), none of which
     * the corpus uses — they fall through to the lexer's punct table and then
     * to a parse error, which is the behaviour we want.
     */
    const BINPRI = {
        or: [1, 1], and: [2, 2],
        '<': [3, 3], '>': [3, 3], '<=': [3, 3], '>=': [3, 3], '~=': [3, 3], '==': [3, 3],
        '|': [4, 4], '&': [6, 6],
        '..': [9, 8],
        '+': [10, 10], '-': [10, 10],
        '*': [11, 11], '/': [11, 11], '//': [11, 11], '%': [11, 11],
    };
    /** `not`, unary `-` and `#` all bind tighter than any binary operator. */
    const UNARY_PRI = 12;

    /** The operator at the cursor, whether it is spelled as punct or keyword. */
    function binOp() {
        const t = peek();
        if (t.k === 'punct' && t.v in BINPRI) return t.v;
        if (t.k === 'kw' && (t.v === 'and' || t.v === 'or')) return t.v;
        return null;
    }

    /** Precedence climbing, exactly luaparser's subexpr(). */
    function exp(limit = 0) {
        let left;
        const t = peek();
        if (at('punct', '#') || at('punct', '-') || at('kw', 'not')) {
            const op = t.v === 'not' ? 'not' : t.v;
            p++;
            const e = exp(UNARY_PRI);
            left = op === '#' ? { t: 'len', obj: e, line: t.line } : { t: 'unop', op, e, line: t.line };
        } else {
            left = primary();
        }
        for (;;) {
            const op = binOp();
            if (!op || BINPRI[op][0] <= limit) break;
            const line = peek().line;
            p++;
            const right = exp(BINPRI[op][1]);
            // `a .. b .. c` stays one flat concat node so the emitter can join
            // it with a single chain of `+`, as it did before S4.
            if (op === '..') {
                left = {
                    t: 'concat',
                    parts: [left, ...(right.t === 'concat' ? right.parts : [right])],
                    line: left.line,
                };
            } else {
                left = { t: 'binop', op, l: left, r: right, line };
            }
        }
        return left;
    }

    /** `if e then … {elseif e then …} [else …] end` */
    function ifStat() {
        const line = eat('kw', 'if').line;
        const clauses = [];
        for (;;) {
            const cond = exp();
            eat('kw', 'then');
            clauses.push({ cond, body: block() });
            if (!at('kw', 'elseif')) break;
            p++;
        }
        let otherwise = null;
        if (at('kw', 'else')) { p++; otherwise = block(); }
        const endLine = peek().line;
        eat('kw', 'end');
        return { s: 'if', clauses, otherwise, line, endLine };
    }

    /** `for NAME = e1, e2 [, e3] do block end` — the only loop form in play. */
    function forStat() {
        const line = eat('kw', 'for').line;
        const name = eat('name').v;
        // A generic `for k, v in …` would show up as a comma here; `in` is in
        // REJECTED so the lexer has already refused it, but be explicit.
        if (at('punct', ',')) err('generic for (`for k, v in …`) is outside the supported subset');
        eat('punct', '=');
        const from = exp();
        eat('punct', ',');
        const to = exp();
        let step = null;
        if (at('punct', ',')) { p++; step = exp(); }
        eat('kw', 'do');
        const body = block();
        const endLine = peek().line;
        eat('kw', 'end');
        return { s: 'for', name, from, to, step, body, line, endLine };
    }

    /** `repeat block until e` — nhlib.lua's hell_tweaks() river loop. */
    function repeatStat() {
        const line = eat('kw', 'repeat').line;
        const body = block();
        eat('kw', 'until');
        const cond = exp();
        if (at('punct', ';')) p++;
        return { s: 'repeat', body, cond, line, endLine: toks[p - 1].line };
    }

    /** Statements up to `end` / `else` / `elseif` / `until` / eof. */
    function block() {
        const items = [];
        for (;;) {
            const t = peek();
            if (t.k === 'eof') return items;
            if (t.k === 'kw' && (t.v === 'end' || t.v === 'else' || t.v === 'elseif' || t.v === 'until')) return items;
            // Lua's empty statement. dat/bigrm-8.lua and dat/bigrm-10.lua both
            // write `end;` at the end of an `if`.
            if (t.k === 'punct' && t.v === ';') { p++; continue; }
            if (t.k === 'comment') { p++; items.push({ s: 'comment', text: t.v, long: !!t.long, line: t.line }); continue; }
            if (t.k === 'kw' && t.v === 'if') { items.push(ifStat()); continue; }
            if (t.k === 'kw' && t.v === 'for') { items.push(forStat()); continue; }
            if (t.k === 'kw' && t.v === 'repeat') { items.push(repeatStat()); continue; }
            if (t.k === 'kw' && t.v === 'return') {
                p++;
                // `return` with no value, or `return e`. A `return` is always
                // the last statement of its block in Lua.
                const bare = at('punct', ';') || at('kw', 'end') || at('eof');
                const value = bare ? null : exp();
                if (at('punct', ';')) p++;
                items.push({ s: 'return', value, line: t.line, endLine: toks[p - 1].line });
                continue;
            }
            // `function NAME(…) … end` — a *global* function in the
            // interpreter, but nothing ever reads it back out of the script
            // state, so the port makes it an ordinary declaration.
            if (t.k === 'kw' && t.v === 'function' && toks[p + 1].k === 'name') {
                p++;
                const name = eat('name').v;
                const f = funcBody(t.line);
                items.push({ s: 'funcdecl', name, params: f.params, body: f.body, line: t.line, endLine: f.endLine });
                continue;
            }
            if (t.k === 'kw' && t.v === 'local') {
                p++;
                const name = eat('name').v;
                // `local darkness;` — declared here, assigned in a branch
                // below. Lua initialises it to nil.
                let value = { t: 'lit', v: null, line: t.line, implicitNil: true };
                if (at('punct', '=')) { p++; value = exp(); }
                if (at('punct', ';')) p++;
                items.push({ s: 'local', name, value, line: t.line, endLine: toks[p - 1].line });
                continue;
            }
            if (t.k !== 'name') err(`expected a statement, got ${JSON.stringify(t.v)}`);
            const e = primary();
            // `place = selection.new()` — dat/soko1-1.lua forgets the `local`.
            // Whether this declares or re-assigns is a scope question the
            // emitter answers; the parser only records that it is an
            // assignment to a bare name.
            if (e.t === 'name' && at('punct', '=')) {
                p++;
                const value = exp();
                if (at('punct', ';')) p++;
                items.push({ s: 'assign', name: e.v, value, line: t.line, endLine: toks[p - 1].line });
                continue;
            }
            if (e.t !== 'call' && e.t !== 'method') err('a statement must be a function call or an assignment');
            if (at('punct', ';')) p++;
            items.push({ s: 'call', call: e, line: t.line, endLine: toks[p - 1].line });
        }
    }

    const items = block();
    if (!at('eof')) err(`unexpected ${JSON.stringify(peek().v)}`);
    return items;
}

// ---------------------------------------------------------------------------
// Walking the tree (used by both the emitter and the --check interpreter)
// ---------------------------------------------------------------------------

/** Call `visit` on every expression node reachable from `items`. */
function walkExprs(items, visit) {
    const node = (n) => {
        if (!n || typeof n !== 'object') return;
        visit(n);
        for (const k of ['obj', 'key', 'fn', 'value', 'cond', 'l', 'r', 'e']) if (n[k]) node(n[k]);
        for (const k of ['args', 'parts']) if (n[k]) for (const x of n[k]) node(x);
        if (n.entries) for (const e of n.entries) node(e.value);
        if (n.body && n.t === 'func') stmts(n.body);
    };
    const stmts = (list) => {
        for (const it of list) {
            if (it.s === 'call') node(it.call);
            else if (it.s === 'local' || it.s === 'assign' || it.s === 'return') node(it.value);
            else if (it.s === 'if') {
                for (const c of it.clauses) { node(c.cond); stmts(c.body); }
                if (it.otherwise) stmts(it.otherwise);
            } else if (it.s === 'for') {
                node(it.from); node(it.to); node(it.step); stmts(it.body);
            } else if (it.s === 'repeat') {
                stmts(it.body); node(it.cond);
            } else if (it.s === 'funcdecl') {
                stmts(it.body);
            }
        }
    };
    stmts(items);
}

/** Every name a block and its nested blocks bind — locals, loop variables. */
function boundNames(list, into = new Set()) {
    for (const it of list) {
        if (it.s === 'local') into.add(it.name);
        if (it.s === 'funcdecl') { into.add(it.name); boundNames(it.body, into); }
        if (it.s === 'for') { into.add(it.name); boundNames(it.body, into); }
        if (it.s === 'repeat') boundNames(it.body, into);
        if (it.s === 'if') {
            for (const c of it.clauses) boundNames(c.body, into);
            if (it.otherwise) boundNames(it.otherwise, into);
        }
    }
    return into;
}

/**
 * True when `name` holds a Lua list the script treats as 1-based — it either
 * indexes it (`object[1]`) or shuffles it (whereupon `#list` decides how many
 * rn2() draws are spent). Both need luaList(); see js/lua-js/nhlib.mjs.
 */
function needsLuaList(items, name) {
    let yes = false;
    walkExprs(items, (n) => {
        if (n.t === 'index' && n.obj.t === 'name' && n.obj.v === name) yes = true;
        if (n.t === 'len' && n.obj.t === 'name' && n.obj.v === name) yes = true;
        if (n.t === 'call' && n.fn.t === 'name' && n.fn.v === 'shuffle'
            && n.args.length === 1 && n.args[0].t === 'name' && n.args[0].v === name) yes = true;
    });
    return yes;
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(['default', 'class', 'function', 'return', 'new', 'delete',
    'in', 'of', 'do', 'if', 'else', 'for', 'while', 'var', 'let', 'const', 'typeof']);

/**
 * Words JS will not accept as a variable name in a module (strict mode) but
 * Lua is perfectly happy with. dat/asmodeus.lua and the four wizard levels all
 * write `local protected = …`.
 */
const JS_KEYWORDS = new Set([
    'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
    'finally', 'for', 'function', 'if', 'implements', 'import', 'in',
    'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private',
    'protected', 'public', 'return', 'static', 'super', 'switch', 'this',
    'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
    'arguments', 'eval',
]);

/**
 * A Lua identifier as a JS one. Only the reserved words move, and they move by
 * one underscore, so a reviewer diffing the .lua against the port still reads
 * the same name.
 */
function jsName(n) { return JS_KEYWORDS.has(n) ? `${n}_` : n; }

/**
 * A single-quoted JS string, or a template literal for a Lua *long* string.
 *
 * Only `[[ … ]]` becomes a template literal: those are the maps, where the
 * layout is the content and a reviewer has to be able to see it. A short
 * string that merely contains an escaped newline — nhlib.lua's
 * `selection.match(".\nw\n.")` — stays a one-line quoted string, because
 * spreading it over three lines would put its bytes at the mercy of any
 * editor that trims trailing whitespace.
 */
function jsString(s, long) {
    if (long) {
        // A Lua long string keeps every byte including trailing spaces, and
        // has no leading newline (Lua ate it), so the first line goes right
        // after the backtick.
        return '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
    }
    const b = s.replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    if (b.includes("'") && !b.includes('"')) return `"${b}"`;
    return `'${b.replace(/'/g, "\\'")}'`;
}

function jsKey(k) {
    if (typeof k === 'number') return `[${k}]`;
    return IDENT.test(k) && !RESERVED.has(k) ? k : jsString(k, false);
}

const MAXCOL = 108;
const PAD = '    ';

/**
 * Render one expression. Returns either a single string (no newlines) or, for
 * a value that has to span lines, a string containing newlines already
 * indented to `pad`.
 */
function expr(node, pad) {
    switch (node.t) {
        case 'lit':
            if (typeof node.v === 'string') return jsString(node.v, node.long);
            if (node.v === null) return 'null';
            return String(node.v);
        case 'name': return jsName(node.v);
        case 'field': return `${expr(node.obj, pad)}.${node.name}`;
        case 'index': return `${expr(node.obj, pad)}[${expr(node.key, pad)}]`;
        // Lua's `#t`. luaLen() knows that a luaList()'s slot 0 is not an
        // element, so `#place` counts what the .lua counts.
        case 'len': return `luaLen(${expr(node.obj, pad)})`;
        case 'concat': return node.parts.map((x) => expr(x, pad)).join(' + ');
        case 'call': return `${expr(node.fn, pad)}(${argList(node.args, pad)})`;
        // `sel:filter_mapchar('.')` is sugar for the same C function with the
        // selection as argument 1 — nhlsel.c registers one table and points
        // the metatable's __index at it — so the port spells it out.
        case 'method': return `selection.${node.name}(${argList([node.obj, ...node.args], pad)})`;
        case 'table': return tableLit(node, pad);
        case 'func': return funcLit(node, pad);
        case 'paren': return `(${expr(node.e, pad)})`;
        case 'unop': return unopJs(node, pad);
        case 'binop': return binopJs(node, pad);
        default: throw new Error(`lua2des: cannot emit ${node.t}`);
    }
}

/**
 * `-a`, `not a`.
 *
 * `-<number literal>` folds back into the literal, because that is how the
 * .lua reads and the lexer only split them apart so that `x-1` would work.
 */
function unopJs(node, pad) {
    if (node.op === '-' && node.e.t === 'lit' && typeof node.e.v === 'number') return String(-node.e.v);
    if (node.op === 'not') {
        if (luaTrueJsFalse(node.e)) {
            throw new Error(`lua2des: line ${node.line}: \`not ${JSON.stringify(node.e.v)}\`, `
                + 'and that value is true in Lua but false in JS — port this expression by hand');
        }
        return `!${expr(node.e, pad)}`;
    }
    return `-${expr(node.e, pad)}`;
}

/** Lua binary operator -> JS. See the header for the three semantic gaps. */
const BINOP_JS = {
    or: '||', and: '&&',
    '==': '===', '~=': '!==',
    '<': '<', '>': '>', '<=': '<=', '>=': '>=',
    '+': '+', '-': '-', '*': '*', '/': '/', '%': '%',
};

/** A literal that is true in Lua and false in JS. See the header. */
function luaTrueJsFalse(n) {
    return n.t === 'lit' && (n.v === 0 || n.v === '');
}

/**
 * The `selection.*` methods that hand back something *other* than a selection:
 * two integers, a coord table, a bounds table and a string. Everything else in
 * nhlsel.c's method table returns the selection userdata.
 */
const SELECTION_SCALARS = new Set(['numpoints', 'get', 'rndcoord', 'bounds', 'describe_size']);

/**
 * Is this expression a selection?
 *
 * It has to be answerable, because `+` and `-` are overloaded: nhlsel.c aliases
 * `__add` to l_selection_or and `__sub` to l_selection_sub, so
 * `validtraps - (a + b)` in dat/Tou-loca.lua is set difference and union, while
 * `bnds.hy - 1` two files away is ordinary subtraction. Emitting JS `-` for the
 * first produces NaN, and NaN reaches lspo_trap as a coordinate — which is
 * exactly the bug this function exists to make impossible.
 *
 * The rule is syntactic and conservative: a selection is what `selection.*`
 * returns (minus the scalar methods above), what a `:method()` on one returns,
 * and what an operator between two of them returns. `scope` supplies the answer
 * for a bare name; anything it does not know is not a selection.
 */
function isSelectionExpr(node, scope) {
    if (!node) return false;
    switch (node.t) {
        case 'paren': return isSelectionExpr(node.e, scope);
        case 'name': return !!scope?.isSelection(node.v);
        case 'method': return !SELECTION_SCALARS.has(node.name);
        case 'call': {
            if (node.fn.t !== 'field' || node.fn.obj.t !== 'name') return false;
            // lspo_map() returns a selection of the squares it wrote; the seven
            // Gehennom levels union three of those into hell_tweaks()'s
            // protected area. It is the only des.* whose result the corpus reads.
            if (node.fn.obj.v === 'des') return node.fn.name === 'map';
            return node.fn.obj.v === 'selection' && !SELECTION_SCALARS.has(node.fn.name);
        }
        case 'binop':
            return '|&+-'.includes(node.op)
                && (isSelectionExpr(node.l, scope) || isSelectionExpr(node.r, scope));
        default: return false;
    }
}

function binopJs(node, pad) {
    const l = () => expr(node.l, pad);
    const r = () => expr(node.r, pad);
    // The selection algebra. `|` and `&` are metamethods on the selection
    // userdata (nhlsel.c's l_selection_meta[]: __bor -> l_selection_or,
    // __band -> l_selection_and), and the port spells out the C function the
    // VM's OP_BOR / OP_BAND would have dispatched to. bridge.mjs's
    // selection.bor / selection.band drive that dispatch with lua_arith(),
    // which reaches luaT_trybinTM() by the identical path.
    if (node.op === '|') return `selection.bor(${l()}, ${r()})`;
    if (node.op === '&') return `selection.band(${l()}, ${r()})`;
    if (node.op === '+' || node.op === '-') {
        const ls = isSelectionExpr(node.l, curScope), rs = isSelectionExpr(node.r, curScope);
        if (ls !== rs) {
            throw new Error(`lua2des: line ${node.line}: \`${node.op}\` between a selection and `
                + 'something else — port this expression by hand');
        }
        if (ls) return `selection.${node.op === '+' ? 'add' : 'sub'}(${l()}, ${r()})`;
    }
    // Lua's floor division. Every operand pair in this corpus is a
    // non-negative integer, for which this is exact.
    if (node.op === '//') return `Math.floor(${l()} / ${r()})`;
    if (node.op === 'and' || node.op === 'or') {
        // JS's && / || use JS truthiness, which differs from Lua's for 0 and
        // "". Both operators return an *operand*, chosen by testing the left
        // one, so only the left one can expose the difference: `0 or 5` is 0
        // in Lua and 5 in JS, while `x or 0` agrees whatever x is. Refuse the
        // case that differs rather than emit a silently-wrong port. (This is
        // why dat/minetn-1.lua's `(i == 1) and 3 or 0` is fine.)
        if (luaTrueJsFalse(node.l)) {
            throw new Error(`lua2des: line ${node.line}: \`${JSON.stringify(node.l.v)} ${node.op}\`, `
                + 'and that value is true in Lua but false in JS — port this expression by hand');
        }
    }
    const op = BINOP_JS[node.op];
    if (!op) throw new Error(`lua2des: line ${node.line}: cannot emit operator '${node.op}'`);
    return `${l()} ${op} ${r()}`;
}

/**
 * Names that are neither a local nor an nhlib global, i.e. nil at runtime.
 * dat/Wiz-goal.lua has 19 copies of `{ class = "B",random, peaceful = 0 }` —
 * a stray token in NetHack's own source. Lua evaluates the bare `random` to
 * nil and stores it at index 1, which stores nothing; lspo_monster() reads
 * `class` and `peaceful` by name and nothing ever walks the table, so the
 * entry has no effect at all. The port drops it and the module header says so.
 */
const NIL_GLOBALS = new Set(['random']);

/** Quirks the emitted module's header reports. Reset per emitModule(). */
let quirks = null;

/** A table's real entries, i.e. all of them except the interleaved comments. */
function tableValues(node) { return node.entries.filter((e) => e.comment === undefined); }

/** Strip positional entries that are a bare reference to a nil global. */
function dropNilPositional(node) {
    const isNil = (e) => e.comment === undefined && e.key === null
        && e.value.t === 'name' && NIL_GLOBALS.has(e.value.v);
    if (!node.entries.some(isNil)) return node;
    const dropped = node.entries.filter(isNil).map((e) => e.value.v);
    if (quirks) for (const d of dropped) quirks.nils.add(d);
    return {
        ...node,
        entries: node.entries.filter((e) => !isNil(e)),
        positional: node.positional - dropped.length,
    };
}

function argList(args, pad) {
    return args.map((a) => expr(a, pad)).join(', ');
}

/**
 * `function() … end` -> an arrow function.
 *
 * The bridge pushes it with lua_pushcclosure(), and in this transpile a C
 * function pointer *is* a JS function object, so lspo_room()/lspo_monster()
 * call it through nhl_pcall_handle() exactly where they would have called the
 * Lua closure.
 */
function funcLit(node, pad) {
    const inner = new Scope(curScope);
    for (const p of node.params) inner.declare(p);
    const lines = renderBlock(node.body, pad + PAD, inner);
    // dat/bigrm-13.lua passes `contents=function() end` to des.map(): the
    // closure exists so lspo_map() has something to call, and does nothing.
    if (!lines.length) return `(${node.params.map(jsName).join(', ')}) => {}`;
    return `(${node.params.map(jsName).join(', ')}) => {\n${lines.join('\n')}\n${pad}}`;
}

/**
 * A table constructor. Entries keep their source line grouping, so a table
 * the .lua wrote across four lines is written across the same four lines here.
 */
function tableLit(node, pad) {
    node = dropNilPositional(node);
    const values = tableValues(node);
    if (values.length === 0) return node.positional ? '[]' : '{}';
    const arrayLike = node.positional === values.length;
    if (node.positional > 0 && !arrayLike) {
        throw new Error(`lua2des: line ${node.line}: mixed array/record table is not supported`);
    }
    const [open, close] = arrayLike ? ['[', ']'] : ['{', '}'];
    const padIn = pad + PAD;
    const render = (e) => (arrayLike ? expr(e.value, padIn) : `${jsKey(e.key)}: ${expr(e.value, padIn)}`);
    if (values.length === node.entries.length) {
        const gap = arrayLike ? '' : ' ';
        const oneLine = `${open}${gap}${values.map(render).join(', ')}${gap}${close}`;
        const sameLine = values.every((e) => e.line === node.line) && node.endLine === node.line;
        if (sameLine && !oneLine.includes('\n') && oneLine.length + pad.length <= MAXCOL) return oneLine;
    }
    return `${open}\n${entryLines(node, padIn, render).join('\n')}\n${pad}${close}`;
}

/**
 * Is this `local x = { … }` one of the lists the port has to keep 1-based?
 *
 * Positional, non-empty, and the script either indexes it, measures it with
 * `#` or shuffles it — the three things that make Lua's element 1 observable.
 */
function isLuaList(value, items, name) {
    if (value.t !== 'table') return false;
    const values = tableValues(value);
    return values.length > 0 && value.positional === values.length && needsLuaList(items, name);
}

/** `luaList(a, b, c)`, wrapped over the .lua's own lines when it needs to be. */
function luaListLit(node, pad) {
    const padIn = pad + PAD;
    const values = tableValues(node);
    const oneLine = `luaList(${values.map((e) => expr(e.value, pad)).join(', ')})`;
    if (values.length === node.entries.length && !oneLine.includes('\n')
        && oneLine.length + pad.length <= MAXCOL) {
        return oneLine;
    }
    const lines = entryLines(node, padIn, (e) => expr(e.value, padIn));
    return `luaList(\n${lines.join('\n')}\n${pad})`;
}

/**
 * A table's entries, one .lua line per JS line, with any comments the .lua put
 * between them in the same places. Shared by tableLit() and the luaList() form
 * (dat/bigrm-13.lua's eight pillar filters are a commented positional table
 * that the script also indexes, so it needs both).
 */
function entryLines(node, padIn, render) {
    // Group by source line, exactly as the .lua broke it.
    const rows = [];
    for (const e of node.entries) {
        if (e.comment !== undefined) { rows.push({ comment: e.comment, line: e.line }); continue; }
        const text = render(e);
        const last = rows[rows.length - 1];
        if (last && last.line === e.line && last.texts) last.texts.push(text);
        else rows.push({ line: e.line, texts: [text] });
    }
    return rows.map((r) => (r.comment !== undefined
        ? `${padIn}//${r.comment.replace(/\s+$/, '')}`
        : `${padIn}${r.texts.join(', ')},`));
}

/** Turn a .lua basename into a JS function identifier. */
export function fnName(base) {
    const id = base.replace(/[^A-Za-z0-9_$]/g, '_');
    return /^[0-9]/.test(id) ? `_${id}` : id;
}

/**
 * Everything a ported script can be handed, in the order bridge.mjs's api
 * declares it. `percent`, `shuffle`, `d` and `math.random` are nhlib.lua's RNG
 * helpers; `align` and `monkfoodshop` are the two other pieces of the Lua
 * prelude a level script reaches for.
 */
const API_FIELDS = ['des', 'selection', 'nh', 'percent', 'shuffle', 'd', 'math',
    'align', 'monkfoodshop', 'hell_tweaks', 'u', 'nhc', 'luaList', 'luaLen'];

/** nhlib.lua globals a script may call as a bare function. */
const NHLIB_FUNCS = new Set(['monkfoodshop', 'percent', 'shuffle', 'd', 'hell_tweaks']);

/** The api fields a script actually uses, in the order the api declares them. */
function apiFields(items) {
    const used = new Set();
    walkExprs(items, (n) => {
        if (n.t === 'name') used.add(n.v);
        if (n.t === 'field' && n.obj.t === 'name') used.add(n.obj.v);
        if (n.t === 'method') used.add('selection');
        if (n.t === 'len') used.add('luaLen');
        // `a | b` and `a & b` on selections dispatch to the same C functions
        // the metatable's __bor / __band entries name; the bridge spells them
        // out (see expr()), so the script needs `selection` in scope.
        if (n.t === 'binop' && (n.op === '|' || n.op === '&')) used.add('selection');
    });
    const locals = boundNames(items);
    walkExprs(items, (n) => { if (n.t === 'func') boundNames(n.body, locals); });
    return API_FIELDS.filter((f) => used.has(f) && !locals.has(f));
}

/** The whole parsed file, for needsLuaList(). Set by emitModule(). */
let rootItems = null;

/**
 * Emit the whole module.
 * @param {object[]} items  parsed statements
 * @param {string} base     the .lua basename, e.g. "Arc-goal"
 */
export function emitModule(items, base) {
    // The .lua's own leading comment block is provenance; it becomes the
    // module header rather than the first statements of the body.
    let h = 0;
    while (h < items.length && items[h].s === 'comment' && items[h].line <= h + 1) h++;
    const head = items.slice(0, h), body = items.slice(h);

    // Body first: rendering it is what discovers the quirks the header reports
    // and which helpers the module ends up needing.
    quirks = { nils: new Set(), globals: new Set(), funcs: new Set(), used: new Set(), listed: new Set() };
    rootItems = body;
    const lines = renderBlock(body, PAD);
    const { nils, globals, funcs, used } = quirks;
    quirks = null;
    rootItems = null;

    const fields = new Set([...apiFields(body), ...used]);
    const params = API_FIELDS.filter((f) => fields.has(f));

    const hasClosure = params.length && lines.some((l) => l.includes('=> {'));
    const hasRng = params.some((p) => p === 'percent' || p === 'shuffle' || p === 'd'
        || p === 'math' || p === 'hell_tweaks')
        || lines.some((l) => l.includes('nh.rn2('));
    const hasAlgebra = lines.some((l) => l.includes('selection.bor(') || l.includes('selection.band('));

    const out = [];
    out.push(`// ${base}.mjs — port of dat/${base}.lua.`);
    out.push('//');
    out.push('// GENERATED by tools/lua-port-gen/lua2des.mjs from');
    out.push(`// nethack-c/recorder/dat/${base}.lua. Regenerate rather than hand-edit; the`);
    out.push('// call stream is re-checked against the .lua by');
    out.push('// test/lua-port-scripts.test.mjs on every run.');
    out.push('//');
    if (hasRng) {
        out.push('// The script spends RNG of its own — percent(), shuffle() or math.random(),');
        out.push("// all of which are nhlib.lua's shims over NetHack's rn2(). Equivalence is");
        out.push('// therefore "the same des.* calls with the same arguments *and* the same');
        out.push('// rn2() draws in the same order"; js/lua-js/nhlib.mjs is where the draw');
        out.push('// sequences are defined, and --check pins them against the .lua.');
    } else {
        out.push('// The script issues a stream of des.* calls and spends no RNG of its own,');
        out.push('// so equivalence is exactly "the same des.* calls in the same order with');
        out.push('// the same arguments". All randomness is inside the C bindings themselves.');
    }
    if (hasClosure) {
        out.push('//');
        out.push('// `contents`/`inventory` closures become arrow functions. The bridge pushes');
        out.push('// them with lua_pushcclosure(), and a C function pointer is a JS function');
        out.push('// object in this transpile, so the C binding calls back into the port at');
        out.push('// exactly the point it would have called the Lua closure.');
    }
    if (nils.size) {
        out.push('//');
        out.push(`// The .lua has a stray positional \`${[...nils].join('`, `')}\` inside some of its`);
        out.push('// argument tables — a bare reference to a global NetHack never defines, so');
        out.push('// Lua stores nil at index 1, which stores nothing. Every lspo_* reads its');
        out.push('// fields by name and nothing walks the table, so it is dropped here.');
    }
    if (hasAlgebra) {
        out.push('//');
        out.push('// `a | b` / `a & b` on two selections are metamethods, not operators the VM');
        out.push('// evaluates itself: nhlsel.c:1009 points __bor at l_selection_or and __band');
        out.push('// at l_selection_and. selection.bor / selection.band in the bridge reach the');
        out.push('// same C function by the same dispatch (lua_arith -> luaT_trybinTM).');
    }
    if (globals.size) {
        out.push('//');
        out.push(`// The .lua assigns \`${[...globals].join('`, `')}\` without \`local\`, so in the interpreter it`);
        out.push("// lands in the script state's globals. Nothing ever reads it back — the state");
        out.push('// is torn down when the level is finished — so the port makes it an ordinary');
        out.push('// binding.');
    }
    if (funcs.size) {
        out.push('//');
        out.push(`// \`function ${[...funcs].join('()`, `function ')}()\` is a *global* function in the`);
        out.push('// interpreter, for the same reason and with the same consequence: the script');
        out.push('// state dies with the level, so a plain JS declaration is exact.');
    }
    if (head.length) {
        out.push('//');
        out.push('// Original header:');
        for (const c of head) {
            for (const l of String(c.text).split('\n')) out.push(`//  ${l}`.replace(/\s+$/, ''));
        }
    }
    out.push('');
    out.push(`/** @param {{des: object}} api */`);
    out.push(`export default function ${fnName(base)}({ ${params.join(', ')} }) {`);
    out.push(...lines);
    out.push('}');
    out.push('');
    return out.join('\n');
}

/**
 * A lexical scope, so the emitter can tell `local x = …` (a declaration) from
 * `x = …` where x is already in scope (an assignment). dat/bigrm-2.lua's
 * `local darkness;` followed by `darkness = selection.area(…)` inside three
 * `if` branches is the case that needs it: emitting `const` in the branches
 * would be three different variables and a level with no dark region.
 */
class Scope {
    constructor(parent) {
        this.names = new Set();
        /** Names currently bound to a selection — see isSelectionExpr(). */
        this.selections = new Set();
        this.parent = parent ?? null;
    }
    declare(n, isSel = false) {
        this.names.add(n);
        if (isSel) this.selections.add(n); else this.selections.delete(n);
    }
    has(n) { return this.names.has(n) || (this.parent ? this.parent.has(n) : false); }
    isSelection(n) {
        if (this.names.has(n)) return this.selections.has(n);
        return this.parent ? this.parent.isSelection(n) : false;
    }
    /** `x = e` where x lives further out: update the flag where it lives. */
    reassign(n, isSel) {
        for (let s = this; s; s = s.parent) {
            if (s.names.has(n)) { if (isSel) s.selections.add(n); else s.selections.delete(n); return; }
        }
    }
}

/**
 * The scope expr() is rendering in, for isSelectionExpr(). A module-level
 * cursor rather than a parameter on every expr() call, the way `quirks` and
 * `rootItems` already are.
 */
let curScope = null;

/**
 * Is `name` assigned again after statement `idx` of this block?
 *
 * Only a bare `x = …` counts, and it counts however deeply nested it is — a
 * nested `local x` is a different variable and must not force the outer one to
 * `let`. Used to choose `const` vs `let`, which is the one place the emitted
 * JS has to know something Lua does not distinguish.
 */
function reassignedLater(body, idx, name) {
    let found = false;
    const scanStmts = (list, shadowed) => {
        if (found || shadowed) return;
        for (const it of list) {
            if (found) return;
            if (it.s === 'assign' && it.name === name) { found = true; return; }
            if (it.s === 'local' || it.s === 'assign' || it.s === 'return') scanExpr(it.value);
            else if (it.s === 'call') scanExpr(it.call);
            else if (it.s === 'if') {
                for (const c of it.clauses) { scanExpr(c.cond); scanStmts(c.body); }
                if (it.otherwise) scanStmts(it.otherwise);
            } else if (it.s === 'for') {
                scanExpr(it.from); scanExpr(it.to); scanExpr(it.step);
                scanStmts(it.body, it.name === name);
            } else if (it.s === 'repeat') { scanStmts(it.body); scanExpr(it.cond); }
            else if (it.s === 'funcdecl') scanStmts(it.body, it.name === name);
        }
    };
    const scanExpr = (n) => {
        if (found || !n || typeof n !== 'object') return;
        if (n.t === 'func') { scanStmts(n.body, n.params.includes(name)); return; }
        for (const k of ['obj', 'key', 'fn', 'value', 'cond', 'l', 'r', 'e']) if (n[k]) scanExpr(n[k]);
        for (const k of ['args', 'parts']) if (n[k]) for (const x of n[k]) scanExpr(x);
        if (n.entries) for (const e of n.entries) scanExpr(e.value);
    };
    scanStmts(body.slice(idx + 1));
    return found;
}

/**
 * Slice one `function NAME(…) … end` out of a library .lua.
 *
 * dat/nhlib.lua is not a level script and most of it is outside this subset —
 * varargs, `pairs`, `string.format`, `error`. But one function in it,
 * hell_tweaks(), *is* in the subset and is called by seven Gehennom level
 * scripts, so it has to be ported alongside them. Taking it by line range
 * rather than parsing the file is the narrowest thing that works: the opening
 * line is `function NAME(` at column 0 and the closing one is `end` at column
 * 0, which is nhlib.lua's own layout throughout.
 *
 * @param {string} src @param {string} name
 * @returns {string} the function's source, `function` line through `end`
 */
export function extractFunction(src, name) {
    const lines = src.split('\n');
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    if (start < 0) throw new Error(`lua2des: no top-level 'function ${name}(' found`);
    const end = lines.findIndex((l, i) => i > start && l === 'end');
    if (end < 0) throw new Error(`lua2des: 'function ${name}' has no closing 'end' at column 0`);
    return lines.slice(start, end + 1).join('\n');
}

/**
 * Emit a *library* function — one that a level script calls rather than one
 * that replaces a level script.
 *
 * The shape differs from emitModule() in exactly one way: the api arrives as a
 * parameter instead of being destructured in the signature, because the
 * function also has the .lua's own parameters to carry. Everything else — the
 * statement order, the comments, the line breaks — is emitModule()'s.
 *
 * @param {string} luaSrc  the function's .lua source (see extractFunction)
 * @param {string} name    its name, e.g. "hell_tweaks"
 * @param {string} from    provenance for the header, e.g. "dat/nhlib.lua"
 */
export function emitLibFn(luaSrc, name, from) {
    const items = parse(luaSrc);
    const decl = items.find((it) => it.s === 'funcdecl' && it.name === name);
    if (!decl) throw new Error(`lua2des: ${name} did not parse as a function declaration`);

    quirks = { nils: new Set(), globals: new Set(), funcs: new Set(), used: new Set(), listed: new Set() };
    rootItems = decl.body;
    const lines = renderBlock(decl.body, PAD, new Scope(null));
    const { used } = quirks;
    quirks = null;
    rootItems = null;

    const fields = new Set([...apiFields(decl.body), ...used]);
    const params = API_FIELDS.filter((f) => fields.has(f));

    return [
        `// nhlib-fns.mjs — port of ${name}() from ${from}.`,
        '//',
        '// GENERATED by tools/lua-port-gen/lua2des.mjs. Regenerate rather than',
        '// hand-edit; the call stream is re-checked against the .lua by',
        '// test/lua-port-scripts.test.mjs on every run.',
        '//',
        '// WHY THIS IS NOT A LEVEL SCRIPT PORT. nhlib.lua is loaded into every',
        '// lua_State nhl_init() builds, so its functions are in scope for every',
        `// script. ${name}() is the one a *ported* script still has to be able to`,
        '// call: seven Gehennom levels end with it, and it is 60 lines of selection',
        '// algebra with its own percent() and math.random() draws. Porting it once',
        '// here is what lets those seven be ports at all.',
        '//',
        '// The api arrives as a parameter rather than a destructured signature',
        "// because the function has the .lua's own parameters to carry too.",
        '',
        `/** @param {object} api @returns {void} */`,
        `export default function ${fnName(name)}(api, ${decl.params.map(jsName).join(', ')}) {`,
        `${PAD}const { ${params.join(', ')} } = api;`,
        '',
        ...lines,
        '}',
        '',
    ].join('\n');
}

/**
 * One block of statements, one .lua line mapped to one JS line.
 * @param {object[]} body @param {string} pad @param {Scope} [outer]
 * @returns {string[]}
 */
function renderBlock(body, pad, outer = null) {
    const out = [];
    const scope = new Scope(outer);
    const savedScope = curScope;
    curScope = scope;
    try {
        return renderStmts(body, pad, scope, out);
    } finally {
        curScope = savedScope;
    }
}

function renderStmts(body, pad, scope, out) {
    // Lua's `local x` shadows; JS's `const x` is an error. Sam-goal.lua
    // redeclares `place` four times, so a name declared more than once in one
    // block becomes a `let` plus plain assignments.
    const counts = new Map();
    for (const it of body) if (it.s === 'local') counts.set(it.name, (counts.get(it.name) || 0) + 1);
    const seen = new Set();
    const listed = quirks ? quirks.listed : new Set();

    /** Emit `const`/`let`/nothing for a binding of `name` at statement `i`. */
    const keyword = (name, i) => {
        if (seen.has(name)) return '';
        return (counts.get(name) > 1 || reassignedLater(body, i, name)) ? 'let ' : 'const ';
    };

    let prevLine = body.length ? body[0].line : 0;
    body.forEach((it, i) => {
        if (it.line - prevLine > 1) out.push('');
        prevLine = it.endLine ?? it.line;
        if (it.s === 'comment') {
            for (const l of String(it.text).split('\n')) out.push(`${pad}//${l.replace(/\s+$/, '')}`);
            return;
        }
        if (it.s === 'if') { renderIf(it, pad, out, scope); return; }
        if (it.s === 'for') { renderFor(it, pad, out, scope); return; }
        if (it.s === 'repeat') { renderRepeat(it, pad, out, scope); return; }
        if (it.s === 'funcdecl') {
            // A Lua `function NAME(…)` statement is a global assignment. The
            // script state is torn down with the level and nothing reads it
            // back, so an ordinary JS declaration is exact.
            if (quirks) quirks.funcs.add(it.name);
            scope.declare(it.name);
            out.push(`${pad}function ${jsName(it.name)}(${it.params.map(jsName).join(', ')}) {`);
            const inner = new Scope(scope);
            for (const p of it.params) inner.declare(p);
            out.push(...renderBlock(it.body, pad + PAD, inner));
            out.push(`${pad}}`);
            return;
        }
        if (it.s === 'return') {
            out.push(`${pad}return${it.value ? ` ${expr(it.value, pad)}` : ''};`);
            return;
        }
        if (it.s === 'local' || it.s === 'assign') {
            const declares = it.s === 'local' || !scope.has(it.name);
            if (it.s === 'assign' && declares && quirks) quirks.globals.add(it.name);
            const isList = isLuaList(it.value, rootItems ?? body, it.name);
            const v = isList ? luaListLit(it.value, pad) : expr(it.value, pad);
            if (isList) {
                if (quirks) quirks.used.add('luaList');
                // Say why once per name; Sam-goal.lua redeclares `place` four times.
                if (!listed.has(it.name)) {
                    listed.add(it.name);
                    out.push(`${pad}// luaList keeps Lua's 1-based indices, so ${it.name}[n] means the same here.`);
                }
            }
            const isSel = isSelectionExpr(it.value, scope);
            const kw = declares ? keyword(it.name, i) : '';
            if (declares) { seen.add(it.name); scope.declare(it.name, isSel); }
            else scope.reassign(it.name, isSel);
            pushWrapped(out, `${pad}${kw}${jsName(it.name)} = ${v};`, pad);
            return;
        }
        pushWrapped(out, `${pad}${expr(it.call, pad)};`, pad);
    });
    return out;
}

/**
 * A condition, without the parentheses JS is about to add anyway. Half the
 * corpus writes `if (percent(50)) then` and half writes `if percent(50) then`;
 * this makes both come out as `if (percent(50)) {`.
 */
function cond(node, pad) {
    return expr(node.t === 'paren' ? node.e : node, pad);
}

/** `if … then … else … end` -> `if (…) { … } else { … }`, same shape. */
function renderIf(node, pad, out, scope) {
    node.clauses.forEach((c, i) => {
        out.push(`${pad}${i === 0 ? 'if' : '} else if'} (${cond(c.cond, pad)}) {`);
        out.push(...renderBlock(c.body, pad + PAD, scope));
    });
    if (node.otherwise) {
        out.push(`${pad}} else {`);
        out.push(...renderBlock(node.otherwise, pad + PAD, scope));
    }
    out.push(`${pad}}`);
}

/**
 * `for i = a, b[, step] do … end`.
 *
 * Lua evaluates all three control expressions **once**, before the first
 * iteration. That is not a detail here: `for i = 1, math.random(10,19)` spends
 * exactly one rn2() draw, and a JS loop that re-evaluated the limit each turn
 * would spend one per iteration and desynchronise the RNG immediately. So a
 * non-literal limit is hoisted into a second loop variable.
 */
function renderFor(node, pad, out, scope) {
    const inner = new Scope(scope);
    inner.declare(node.name);
    const n = jsName(node.name);
    const from = expr(node.from, pad);
    const stepLit = node.step === null ? 1 : null;
    let step = stepLit;
    if (node.step !== null) {
        const s = node.step.t === 'unop' && node.step.op === '-' && node.step.e.t === 'lit'
            ? -node.step.e.v : (node.step.t === 'lit' ? node.step.v : null);
        if (typeof s !== 'number' || s === 0) {
            throw new Error(`lua2des: line ${node.line}: numeric for step must be a non-zero literal`);
        }
        step = s;
    }
    const simpleLimit = node.to.t === 'lit' || node.to.t === 'name'
        || (node.to.t === 'len' && node.to.obj.t === 'name');
    const limitVar = `${n}End`;
    const limit = simpleLimit ? expr(node.to, pad) : limitVar;
    const init = simpleLimit ? `let ${n} = ${from}` : `let ${n} = ${from}, ${limitVar} = ${expr(node.to, pad)}`;
    const test = step > 0 ? `${n} <= ${limit}` : `${n} >= ${limit}`;
    const inc = step === 1 ? `${n}++` : step === -1 ? `${n}--` : `${n} += ${step}`;
    out.push(`${pad}for (${init}; ${test}; ${inc}) {`);
    out.push(...renderBlock(node.body, pad + PAD, inner));
    out.push(`${pad}}`);
}

/**
 * `repeat … until e` -> `do { … } while (!(e));`.
 *
 * Lua's `until` expression can see locals declared in the loop body; JS's
 * `while` cannot. Nothing in the corpus does that (nhlib.lua's hell_tweaks()
 * keeps its loop counters outside), and a script that started to would be a
 * silent mistranslation, so it is a hard error.
 */
function renderRepeat(node, pad, out, scope) {
    const inner = new Scope(scope);
    const bodyNames = boundNames(node.body);
    walkExprs([{ s: 'call', call: node.cond }], (e) => {
        if (e.t === 'name' && bodyNames.has(e.v)) {
            throw new Error(`lua2des: line ${node.line}: \`until\` reads \`${e.v}\`, `
                + 'a local of the loop body — port this loop by hand');
        }
    });
    out.push(`${pad}do {`);
    out.push(...renderBlock(node.body, pad + PAD, inner));
    out.push(`${pad}} while (!(${cond(node.cond, pad)}));`);
}

/**
 * Push a statement, breaking a too-long single-line call at its argument
 * commas rather than letting it run off the page.
 */
function pushWrapped(out, text, pad = PAD) {
    if (text.length <= MAXCOL || text.includes('\n')) { out.push(text); return; }
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if (open < 0 || close < open) { out.push(text); return; }
    const head = text.slice(0, open + 1), tail = text.slice(close);
    const args = splitTop(text.slice(open + 1, close));
    const padIn = pad + PAD;
    const rows = [];
    let row = '';
    for (const a of args) {
        const next = row ? `${row}, ${a}` : a;
        if (next.length + padIn.length > MAXCOL && row) { rows.push(row + ','); row = a; }
        else row = next;
    }
    if (row) rows.push(row);
    out.push(head);
    for (const r of rows) out.push(padIn + r);
    out.push(pad + tail);
}

/** Split an argument list on top-level commas. */
function splitTop(s) {
    const out = [];
    let depth = 0, cur = '', q = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) { cur += c; if (c === '\\') { cur += s[++i] ?? ''; } else if (c === q) q = null; continue; }
        if (c === "'" || c === '`') { q = c; cur += c; continue; }
        if ('([{'.includes(c)) depth++;
        if (')]}'.includes(c)) depth--;
        if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

// ---------------------------------------------------------------------------
// --check: the emitted module's call stream, against the .lua's
// ---------------------------------------------------------------------------

/**
 * Values a stub API hands back for things only the real game can produce.
 * Anything that could end up inside a `..` concatenation is represented by a
 * *string* placeholder, so JS `+` and Lua `..` produce the same thing on both
 * sides of the comparison; everything else is a tagged object compared
 * structurally.
 */
const placeholder = (s) => `\u0000${s}\u0000`;

/**
 * A deterministic rn2 for the check.
 *
 * Three settings matter. `low` returns 0, so every `percent(t)` with t > 0 is
 * true; `high` returns n-1, so every `percent(t)` with t <= 99 is false;
 * together they transcription-check *both* arms of every branch in the script,
 * which a random draw would only do by luck. The numbered settings are an
 * ordinary xorshift and exist so shuffles land in several different orders.
 *
 * Both sides of the comparison share one of these objects, so it doubles as a
 * draw-order check: a port that spends a draw the .lua does not spend (a
 * shuffle over the wrong list, an `if` on the wrong side) shifts every
 * subsequent value and the streams diverge.
 *
 * @param {'low'|'high'|number} mode
 */
export function stubRng(mode) {
    if (mode === 'low') return { rn2: () => 0 };
    if (mode === 'high') return { rn2: (n) => (n > 0 ? n - 1 : 0) };
    let s = (mode * 2654435761) >>> 0 || 1;
    return {
        rn2: (n) => {
            s ^= s << 13; s >>>= 0;
            s ^= s >>> 17;
            s ^= s << 5; s >>>= 0;
            return n > 0 ? s % n : 0;
        },
    };
}

/** The RNG settings --check runs. Both branch arms, then several shuffles. */
const CHECK_RNGS = ['low', 'high', 1, 2, 3, 4, 5, 6];

/**
 * The `u.depth` each setting reports. Only hell_tweaks() reads it, for
 * `percent(20 + u.depth)` and `math.random(u.depth)`; running the settings at
 * different depths covers the shallow case where the pool branch is a coin
 * flip and the deep case where it is nearly certain.
 */
const DEPTHS = [1, 45, 26, 33, 40, 47, 52, 30];

/** Repo root, for the generated modules --check has to import. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Replace every function in an argument for recording, and collect the
 * functions so they can be invoked *after* the call is recorded — which is
 * where lspo_room()/lspo_monster() invoke `contents`/`inventory`, so the
 * nested calls land in the stream in the right place.
 */
function sanitize(v, pending) {
    if (typeof v === 'function') { pending.push(v); return { __func: pending.length }; }
    if (Array.isArray(v)) return v.map((x) => sanitize(x, pending));
    if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v)) o[k] = sanitize(v[k], pending);
        return o;
    }
    return v;
}

/**
 * A stub api whose `des` and `selection` calls are recorded instead of executed,
 * and whose nhlib helpers draw from `rng`.
 *
 * The same object drives both sides of --check: the emitted module is called
 * with it, and this file's own interpreter walks the .lua against it. That is
 * what makes the two streams comparable at all.
 */
export function recordingApi(rng = stubRng(1), opts = {}) {
    const { depth = 30, hellTweaks = null } = opts;
    const calls = [];
    /**
     * Selection methods that hand a *value* back to the script rather than
     * another selection. The stub has to produce something, and it has to
     * produce the same something on both sides of the comparison, so each is
     * a pure function of how many times it has been called. That is enough to
     * drive the loops and branches that read them — hell_tweaks()'s
     * `until (rpts > reqpts or rivertries > 7)`, `a.x`/`a.y` from rndcoord —
     * without pretending to model NetHack's geometry.
     */
    let reads = 0;
    const readback = {
        // Grows, so a loop testing it against a threshold terminates.
        numpoints: () => { reads++; return reads * 137 % 1600; },
        get: () => { reads++; return reads % 2; },
        rndcoord: () => { reads++; return { x: reads * 7 % 76, y: reads * 5 % 19 }; },
        // The Gehennom levels read all four fields and do arithmetic on them
        // (`selection.fillrect(bnds.lx, bnds.ly + 1, bnds.hx - 2, bnds.hy - 1)`),
        // so these have to be real numbers with lx < hx and ly < hy.
        bounds: () => { reads++; return { lx: 2, ly: 1, hx: 2 + reads % 60, hy: 4 + reads % 14 }; },
        describe_size: () => placeholder(`describe_size#${++reads}`),
    };
    const record = (fn, args) => {
        const pending = [];
        const clean = args.map((a) => sanitize(a, pending));
        calls.push({ fn, args: clean });
        // lspo_room()/lspo_monster() invoke `contents`/`inventory` with no
        // arguments; l_selection_iterate() invokes its callback once per point
        // with (x, y). Three points is enough to check the body transcribes,
        // and both sides iterate identically because this is the same stub.
        for (const f of pending) {
            if (fn === 'selection.iterate') for (let k = 1; k <= 3; k++) f(k * 11 % 76, k * 7 % 19);
            else f();
        }
        const method = fn.startsWith('selection.') ? fn.slice(10) : null;
        if (method && method in readback) return readback[method]();
        return { __call: fn, args: clean };
    };
    const table = (tbl) => new Proxy({}, {
        get: (_, name) => (...args) => record(`${tbl}.${String(name)}`, args),
    });
    const { mathRandom, percent, d, shuffle } = makeNhlib(rng.rn2);
    const nh = {
        eckey: (c) => placeholder(`nh.eckey(${c})`),
        rn2: (n) => rng.rn2(n),
        random: (a, b) => (b === undefined ? rng.rn2(a) : (a + rng.rn2(b)) | 0),
        // The real nhl_is_genocided() spends no RNG. The stub draws so that
        // the `low` and `high` settings take opposite branches of
        // dat/tower1.lua's `if (not Vgenod)`; both sides share the counter, so
        // the extra draw cancels out of the comparison.
        is_genocided: () => rng.rn2(2) === 0,
    };
    const align = luaList(placeholder('align[1]'), placeholder('align[2]'), placeholder('align[3]'));
    const api = {
        des: table('des'), selection: table('selection'), nh,
        percent, shuffle, d, math: { random: mathRandom },
        align, monkfoodshop: () => placeholder('monkfoodshop()'),
        // nhc's constants are the real ones; u.depth is a setting of the check
        // (hell_tweaks() reads it for two thresholds and a die roll).
        nhc: { COLNO: 80, ROWNO: 21 },
        u: { depth },
        luaList, luaLen,
    };
    // hell_tweaks() is itself a port (js/lua-js/nhlib-fns.mjs), generated from
    // dat/nhlib.lua the same way the level scripts are. A level script's check
    // therefore exercises the library port too, on the same shared RNG. It is
    // injected rather than imported so that this file can *generate* it
    // without already depending on it.
    if (hellTweaks) api.hell_tweaks = (protectedArea) => hellTweaks(api, protectedArea);
    return { calls, api };
}

/** The generated hell_tweaks() port, imported once and only when needed. */
let hellTweaksMod = null;
async function loadHellTweaks(root) {
    if (!hellTweaksMod) {
        const p = path.join(root, 'js/lua-js/nhlib-fns.mjs');
        hellTweaksMod = (await import(`file://${fs.realpathSync(p)}`)).default;
    }
    return hellTweaksMod;
}

/** Lexical scope for the interpreter: locals shadow the api, api shadows nothing. */
class Env {
    constructor(parent, api) { this.vars = new Map(); this.parent = parent; this.api = api ?? parent.api; }
    has(n) { return this.vars.has(n) || (this.parent ? this.parent.has(n) : n in this.api); }
    get(n) {
        if (this.vars.has(n)) return this.vars.get(n);
        if (this.parent) return this.parent.get(n);
        if (n in this.api) return this.api[n];
        throw new Error(`lua2des --check: unknown name ${n}`);
    }
    /** `local x = v` / a loop variable: bind in *this* scope. */
    set(n, v) { this.vars.set(n, v); }
    /** `x = v`: assign wherever x already lives, else make it a global. */
    assign(n, v) {
        for (let e = this; e; e = e.parent) {
            if (e.vars.has(n)) { e.vars.set(n, v); return; }
            if (!e.parent) { e.vars.set(n, v); return; }
        }
    }
}

/**
 * Lua's truth: everything except `false` and `nil` is true — 0 and "" included.
 * The emitter writes JS `&&`/`||`/`!`, which disagree; keeping Lua's rule here
 * is what turns that disagreement into a --check failure instead of a silently
 * wrong port. See the module header.
 */
function luaTrue(v) { return v !== false && v !== null && v !== undefined; }

/** Lua's `%` is floor-modulo; JS's `%` truncates. They differ on negatives. */
function luaMod(a, b) { return a - Math.floor(a / b) * b; }

/** Evaluate a parsed expression against the stub api. */
function evalNode(node, env) {
    switch (node.t) {
        case 'lit': return node.v;
        case 'name': return env.get(node.v);
        case 'paren': return evalNode(node.e, env);
        case 'index': return evalNode(node.obj, env)[evalNode(node.key, env)];
        case 'field': return evalNode(node.obj, env)[node.name];
        case 'len': return luaLen(evalNode(node.obj, env));
        case 'concat': return node.parts.map((x) => evalNode(x, env)).join('');
        case 'unop': {
            if (node.op === 'not') return !luaTrue(evalNode(node.e, env));
            return -evalNode(node.e, env);
        }
        case 'binop': {
            const { op } = node;
            // `and` / `or` short-circuit, and yield an *operand*, not a
            // boolean — `percent(50) and "I" or "C"` depends on that.
            if (op === 'and') {
                const l = evalNode(node.l, env);
                return luaTrue(l) ? evalNode(node.r, env) : l;
            }
            if (op === 'or') {
                const l = evalNode(node.l, env);
                return luaTrue(l) ? l : evalNode(node.r, env);
            }
            const a = evalNode(node.l, env), b = evalNode(node.r, env);
            // Lua dispatches `+` and `-` on a non-number to __add / __sub, and
            // nhlsel.c gives selections both. Doing that here rather than
            // JS-adding two stub objects is what makes --check able to catch a
            // port that emitted plain arithmetic for a set operation — which is
            // a mistranslation JS reports as NaN rather than as an error.
            if (op === '+' || op === '-') {
                const obj = (v) => typeof v === 'object' && v !== null;
                if (obj(a) || obj(b)) return env.api.selection[op === '+' ? 'add' : 'sub'](a, b);
                if (typeof a !== 'number' || typeof b !== 'number') {
                    throw new Error(`lua2des --check: line ${node.line}: `
                        + `'${op}' on ${typeof a} and ${typeof b} — the stub api is missing a value`);
                }
            }
            switch (op) {
                case '+': return a + b;
                case '-': return a - b;
                case '*': return a * b;
                case '/': return a / b;
                case '//': return Math.floor(a / b);
                case '%': return luaMod(a, b);
                case '==': return a === b;
                case '~=': return a !== b;
                case '<': return a < b;
                case '>': return a > b;
                case '<=': return a <= b;
                case '>=': return a >= b;
                // The selection algebra. In the interpreter these are the same
                // stub calls the emitted port makes, so the check compares two
                // transcriptions rather than two implementations.
                case '|': return env.api.selection.bor(a, b);
                case '&': return env.api.selection.band(a, b);
                default: throw new Error(`lua2des --check: cannot evaluate '${op}' at line ${node.line}`);
            }
        }
        case 'table': {
            const t = dropNilPositional(node);
            const values = tableValues(t);
            if (t.positional === values.length) return values.map((e) => evalNode(e.value, env));
            const o = {};
            for (const e of values) o[e.key] = evalNode(e.value, env);
            return o;
        }
        case 'func': return (...args) => {
            const inner = new Env(env);
            node.params.forEach((p, i) => inner.set(p, args[i]));
            const r = execBlock(node.body, inner);
            return r === undefined ? undefined : r.value;
        };
        case 'method': {
            const obj = evalNode(node.obj, env);
            return env.api.selection[node.name](obj, ...node.args.map((a) => evalNode(a, env)));
        }
        case 'call': {
            const fn = evalNode(node.fn, env);
            if (typeof fn !== 'function') throw new Error(`lua2des --check: not a function at line ${node.line}`);
            return fn(...node.args.map((a) => evalNode(a, env)));
        }
        default: throw new Error(`lua2des --check: cannot evaluate ${node.t}`);
    }
}

/**
 * Execute one block of statements against the stub api.
 * @returns {{value: *}|undefined} set when the block hit a `return`
 */
function execBlock(items, env) {
    for (const it of items) {
        if (it.s === 'comment') continue;
        if (it.s === 'local' || it.s === 'assign') {
            const v = evalNode(it.value, env);
            // Mirror the emitter: a positional table the script indexes,
            // measures with `#` or shuffles is emitted through luaList().
            const isList = isLuaList(it.value, rootItems ?? items, it.name);
            const val = isList ? luaList(...v) : v;
            if (it.s === 'local') env.set(it.name, val);
            else env.assign(it.name, val);
            continue;
        }
        if (it.s === 'funcdecl') {
            env.set(it.name, (...args) => {
                const inner = new Env(env);
                it.params.forEach((p, i) => inner.set(p, args[i]));
                const r = execBlock(it.body, inner);
                return r === undefined ? undefined : r.value;
            });
            continue;
        }
        if (it.s === 'return') {
            return { value: it.value ? evalNode(it.value, env) : undefined };
        }
        if (it.s === 'if') {
            let done = false;
            for (const c of it.clauses) {
                if (luaTrue(evalNode(c.cond, env))) {
                    const r = execBlock(c.body, new Env(env));
                    if (r) return r;
                    done = true;
                    break;
                }
            }
            if (!done && it.otherwise) {
                const r = execBlock(it.otherwise, new Env(env));
                if (r) return r;
            }
            continue;
        }
        if (it.s === 'for') {
            // Lua evaluates all three control expressions once, before the
            // loop. `for i = 1, math.random(10,19)` therefore spends exactly
            // one draw; see renderFor().
            const from = evalNode(it.from, env);
            const to = evalNode(it.to, env);
            const step = it.step === null ? 1 : evalNode(it.step, env);
            for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
                const inner = new Env(env);
                inner.set(it.name, i);
                const r = execBlock(it.body, inner);
                if (r) return r;
            }
            continue;
        }
        if (it.s === 'repeat') {
            for (;;) {
                const inner = new Env(env);
                const r = execBlock(it.body, inner);
                if (r) return r;
                if (luaTrue(evalNode(it.cond, inner))) break;
            }
            continue;
        }
        evalNode(it.call, env);
    }
    return undefined;
}

/**
 * The call stream the .lua produces, as plain comparable values.
 * @param {object[]} items @param {object} rng
 */
export function luaCallStream(items, rng = stubRng(1), opts = {}) {
    const { calls, api } = recordingApi(rng, opts);
    const saved = rootItems;
    rootItems = items;
    try {
        execBlock(items, new Env(null, api));
    } finally {
        rootItems = saved;
    }
    return calls;
}

/** Order-sensitive deep comparison. @returns {string|null} first difference */
export function diff(a, b, path = '$') {
    if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array/object mismatch`;
    if (a === null || typeof a !== 'object') {
        return Object.is(a, b) ? null : `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
    }
    if (b === null || typeof b !== 'object') return `${path}: object != ${JSON.stringify(b)}`;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return `${path}: ${ka.length} keys (${ka}) != ${kb.length} keys (${kb})`;
    for (let i = 0; i < ka.length; i++) {
        if (ka[i] !== kb[i]) return `${path}: key ${i} is ${ka[i]} != ${kb[i]}`;
        const d = diff(a[ka[i]], b[kb[i]], `${path}.${ka[i]}`);
        if (d) return d;
    }
    return null;
}

/**
 * Compare a generated port module against its .lua source, under every RNG
 * setting in CHECK_RNGS.
 * @param {string} luaPath @param {string} modPath
 * @returns {Promise<string|null>} the first difference, or null
 */
export async function checkPort(luaPath, modPath, root = ROOT) {
    const items = parse(fs.readFileSync(luaPath, 'utf8'));
    const mod = await import(`file://${fs.realpathSync(modPath)}`);
    const hellTweaks = await loadHellTweaks(root);
    for (const mode of CHECK_RNGS) {
        // u.depth varies with the setting so hell_tweaks()'s two
        // depth-dependent thresholds are exercised at more than one value.
        const opts = { hellTweaks, depth: DEPTHS[CHECK_RNGS.indexOf(mode)] };
        const want = luaCallStream(items, stubRng(mode), opts);
        const { calls, api } = recordingApi(stubRng(mode), opts);
        mod.default(api);
        const where = `rng=${mode} `;
        if (calls.length !== want.length) {
            return `${where}call count: lua=${want.length} js=${calls.length}`;
        }
        for (let i = 0; i < want.length; i++) {
            const d = diff(want[i], calls[i], `${where}call[${i}] ${want[i].fn}`);
            if (d) return d;
        }
    }
    return null;
}

/**
 * The same comparison for a *library* function port (js/lua-js/nhlib-fns.mjs).
 *
 * The .lua side is this file's interpreter running the function's body out of
 * dat/nhlib.lua; the JS side is the generated module. Both are handed the same
 * stub argument and the same RNG, so the comparison pins hell_tweaks()'s draw
 * order — which is the only mechanical check there is on a library function
 * that seven level scripts depend on.
 *
 * @param {string} luaPath @param {string} modPath @param {string} name
 * @returns {Promise<string|null>}
 */
export async function checkLibFn(luaPath, modPath, name, root = ROOT) {
    const src = extractFunction(fs.readFileSync(luaPath, 'utf8'), name);
    const decl = parse(src).find((it) => it.s === 'funcdecl' && it.name === name);
    const mod = await import(`file://${fs.realpathSync(modPath)}`);
    const arg = placeholder(`${decl.params[0]}`);
    for (const mode of CHECK_RNGS) {
        const opts = { depth: DEPTHS[CHECK_RNGS.indexOf(mode)] };
        const lua = recordingApi(stubRng(mode), opts);
        const saved = rootItems;
        rootItems = decl.body;
        try {
            const env = new Env(null, lua.api);
            decl.params.forEach((p, i) => env.set(p, i === 0 ? arg : undefined));
            execBlock(decl.body, env);
        } finally {
            rootItems = saved;
        }
        const js = recordingApi(stubRng(mode), opts);
        mod.default(js.api, arg);
        const where = `${name} rng=${mode} `;
        if (js.calls.length !== lua.calls.length) {
            return `${where}call count: lua=${lua.calls.length} js=${js.calls.length}`;
        }
        for (let i = 0; i < lua.calls.length; i++) {
            const d = diff(lua.calls[i], js.calls[i], `${where}call[${i}] ${lua.calls[i].fn}`);
            if (d) return d;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main(argv) {
    const check = argv.includes('--check');
    const [inPath, outPath] = argv.filter((a) => !a.startsWith('--'));
    if (!inPath || !outPath) {
        process.stderr.write('usage: lua2des.mjs [--check] <in.lua> <out.mjs>\n');
        process.exit(2);
    }
    if (check) {
        const d = await checkPort(inPath, outPath);
        if (d) { process.stderr.write(`lua2des --check FAIL ${outPath}: ${d}\n`); process.exit(1); }
        process.stderr.write(`lua2des --check PASS ${outPath}\n`);
        return;
    }
    const base = path.basename(inPath).replace(/\.lua$/, '');
    const src = fs.readFileSync(inPath, 'utf8');
    const text = emitModule(parse(src), base);
    fs.writeFileSync(outPath, text);
    process.stderr.write(`lua2des: ${inPath} -> ${outPath} (${text.length} bytes)\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
