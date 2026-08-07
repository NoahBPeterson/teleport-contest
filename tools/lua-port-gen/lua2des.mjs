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
// Anything else — `for`, `while`, `repeat`, `and`/`or`/`not`, a comparison
// operator, the selection algebra operators `|`/`&`/`~` — is a hard error, so
// a 5.1 script that grows one fails loudly rather than being quietly
// mistranslated. (Those are S4's tier and have to be ported by hand or by a
// further extension of this file.)
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
import { luaLen, luaList, makeNhlib } from '../../js/lua-js/nhlib.mjs';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

const PUNCT3 = [];
const PUNCT2 = ['..'];
const PUNCT1 = ['{', '}', '[', ']', '(', ')', '=', ',', ';', '.', ':', '#'];

const KEYWORDS = new Set(['true', 'false', 'nil', 'local',
    'if', 'then', 'elseif', 'else', 'end', 'function']);
/**
 * Lua keywords this subset still refuses outright. They mean loops, boolean
 * algebra or early exit, none of which any script this generator is aimed at
 * uses; a script that grows one is S4's problem and must fail here first.
 */
const REJECTED = new Set(['for', 'while', 'repeat', 'until', 'return', 'do',
    'and', 'or', 'not', 'break', 'goto']);

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
        // A bare '-' is unary minus here: '--' was handled above.
        if (/[0-9]/.test(c) || ((c === '.' || c === '-') && /[0-9]/.test(src[i + 1] || ''))) {
            const m = /^-?(0[xX][0-9a-fA-F]+|[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?)/.exec(src.slice(i));
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
// Statements:
//   {s:'comment', text, long, line}
//   {s:'local',   name, value, line}    local x = e   (global:true if no `local`)
//   {s:'call',    call, line}
//   {s:'if',      clauses:[{cond, body}], otherwise, line}

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
        if (at('punct', '#')) { p++; return { t: 'len', obj: primary(), line: t.line }; }
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

    function exp() {
        const first = primary();
        if (!at('punct', '..')) return first;
        const parts = [first];
        while (at('punct', '..')) { p++; parts.push(primary()); }
        return { t: 'concat', parts, line: first.line };
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

    /** Statements up to `end` / `else` / `elseif` / eof. */
    function block() {
        const items = [];
        for (;;) {
            const t = peek();
            if (t.k === 'eof') return items;
            if (t.k === 'kw' && (t.v === 'end' || t.v === 'else' || t.v === 'elseif')) return items;
            if (t.k === 'comment') { p++; items.push({ s: 'comment', text: t.v, long: !!t.long, line: t.line }); continue; }
            if (t.k === 'kw' && t.v === 'if') { items.push(ifStat()); continue; }
            if (t.k === 'kw' && t.v === 'local') {
                p++;
                const name = eat('name').v;
                eat('punct', '=');
                const value = exp();
                if (at('punct', ';')) p++;
                items.push({ s: 'local', name, value, line: t.line, endLine: toks[p - 1].line });
                continue;
            }
            if (t.k !== 'name') err(`expected a statement, got ${JSON.stringify(t.v)}`);
            const e = primary();
            // `place = selection.new()` — dat/soko1-1.lua forgets the `local`.
            if (e.t === 'name' && at('punct', '=')) {
                p++;
                const value = exp();
                if (at('punct', ';')) p++;
                items.push({ s: 'local', name: e.v, value, global: true, line: t.line, endLine: toks[p - 1].line });
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
        for (const k of ['obj', 'key', 'fn', 'value', 'cond']) if (n[k]) node(n[k]);
        for (const k of ['args', 'parts']) if (n[k]) for (const x of n[k]) node(x);
        if (n.entries) for (const e of n.entries) node(e.value);
        if (n.body && n.t === 'func') stmts(n.body);
    };
    const stmts = (list) => {
        for (const it of list) {
            if (it.s === 'call') node(it.call);
            else if (it.s === 'local') node(it.value);
            else if (it.s === 'if') {
                for (const c of it.clauses) { node(c.cond); stmts(c.body); }
                if (it.otherwise) stmts(it.otherwise);
            }
        }
    };
    stmts(items);
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

/** A single-quoted JS string, or a template literal when it spans lines. */
function jsString(s, long) {
    if (long || s.includes('\n')) {
        // A Lua long string keeps every byte including trailing spaces, and
        // has no leading newline (Lua ate it), so the first line goes right
        // after the backtick.
        return '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
    }
    const b = s.replace(/\\/g, '\\\\');
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
        case 'name': return node.v;
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
        default: throw new Error(`lua2des: cannot emit ${node.t}`);
    }
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

/** Strip positional entries that are a bare reference to a nil global. */
function dropNilPositional(node) {
    const isNil = (e) => e.key === null && e.value.t === 'name' && NIL_GLOBALS.has(e.value.v);
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
    const lines = renderBlock(node.body, pad + PAD);
    return `(${node.params.join(', ')}) => {\n${lines.join('\n')}\n${pad}}`;
}

/**
 * A table constructor. Entries keep their source line grouping, so a table
 * the .lua wrote across four lines is written across the same four lines here.
 */
function tableLit(node, pad) {
    node = dropNilPositional(node);
    if (node.entries.length === 0) return node.positional ? '[]' : '{}';
    const arrayLike = node.positional === node.entries.length;
    if (node.positional > 0 && !arrayLike) {
        throw new Error(`lua2des: line ${node.line}: mixed array/record table is not supported`);
    }
    const [open, close] = arrayLike ? ['[', ']'] : ['{', '}'];
    const padIn = pad + PAD;
    const parts = node.entries.map((e) => ({
        line: e.line,
        text: arrayLike ? expr(e.value, padIn) : `${jsKey(e.key)}: ${expr(e.value, padIn)}`,
    }));
    const gap = arrayLike ? '' : ' ';
    const oneLine = `${open}${gap}${parts.map((x) => x.text).join(', ')}${gap}${close}`;
    const sameLine = node.entries.every((e) => e.line === node.line) && node.endLine === node.line;
    if (sameLine && !oneLine.includes('\n') && oneLine.length + pad.length <= MAXCOL) return oneLine;
    // Group by source line, exactly as the .lua broke it.
    const rows = [];
    for (const x of parts) {
        if (rows.length && rows[rows.length - 1].line === x.line) rows[rows.length - 1].texts.push(x.text);
        else rows.push({ line: x.line, texts: [x.text] });
    }
    const body = rows.map((r) => padIn + r.texts.join(', ')).join(',\n');
    return `${open}\n${body},\n${pad}${close}`;
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
    'align', 'monkfoodshop', 'luaList', 'luaLen'];

/** nhlib.lua globals a script may call as a bare function. */
const NHLIB_FUNCS = new Set(['monkfoodshop', 'percent', 'shuffle', 'd']);

/** The api fields a script actually uses, in the order the api declares them. */
function apiFields(items) {
    const used = new Set();
    walkExprs(items, (n) => {
        if (n.t === 'name') used.add(n.v);
        if (n.t === 'field' && n.obj.t === 'name') used.add(n.obj.v);
        if (n.t === 'method') used.add('selection');
        if (n.t === 'len') used.add('luaLen');
    });
    const locals = new Set();
    const collect = (list) => {
        for (const it of list) {
            if (it.s === 'local') locals.add(it.name);
            if (it.s === 'if') { for (const c of it.clauses) collect(c.body); if (it.otherwise) collect(it.otherwise); }
        }
    };
    collect(items);
    walkExprs(items, (n) => { if (n.t === 'func') collect(n.body); });
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
    quirks = { nils: new Set(), globals: new Set(), used: new Set() };
    rootItems = body;
    const lines = renderBlock(body, PAD);
    const { nils, globals, used } = quirks;
    quirks = null;
    rootItems = null;

    const fields = new Set([...apiFields(body), ...used]);
    const params = API_FIELDS.filter((f) => fields.has(f));

    const hasClosure = params.length && lines.some((l) => l.includes('=> {'));
    const hasRng = params.some((p) => p === 'percent' || p === 'shuffle' || p === 'd' || p === 'math');

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
    if (globals.size) {
        out.push('//');
        out.push(`// The .lua assigns \`${[...globals].join('`, `')}\` without \`local\`, so in the interpreter it`);
        out.push("// lands in the script state's globals. Nothing ever reads it back — the state");
        out.push('// is torn down when the level is finished — so the port makes it an ordinary');
        out.push('// binding.');
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
 * One block of statements, one .lua line mapped to one JS line.
 * @param {object[]} body @param {string} pad
 * @returns {string[]}
 */
function renderBlock(body, pad) {
    const out = [];
    // Lua's `local x` shadows; JS's `const x` is an error. Sam-goal.lua
    // redeclares `place` four times, so a name declared more than once in one
    // block becomes a `let` plus plain assignments.
    const counts = new Map();
    for (const it of body) if (it.s === 'local') counts.set(it.name, (counts.get(it.name) || 0) + 1);
    const seen = new Set();
    const listed = new Set();

    let prevLine = body.length ? body[0].line : 0;
    for (const it of body) {
        if (it.line - prevLine > 1) out.push('');
        prevLine = it.endLine ?? it.line;
        if (it.s === 'comment') {
            for (const l of String(it.text).split('\n')) out.push(`${pad}//${l.replace(/\s+$/, '')}`);
            continue;
        }
        if (it.s === 'if') { renderIf(it, pad, out); continue; }
        if (it.s === 'local') {
            if (it.global && quirks) quirks.globals.add(it.name);
            const isList = it.value.t === 'table' && it.value.positional === it.value.entries.length
                && it.value.entries.length > 0 && needsLuaList(rootItems ?? body, it.name);
            const v = isList
                ? `luaList(${it.value.entries.map((e) => expr(e.value, pad)).join(', ')})`
                : expr(it.value, pad);
            if (isList) {
                if (quirks) quirks.used.add('luaList');
                // Say why once per name; Sam-goal.lua redeclares `place` four times.
                if (!listed.has(it.name)) {
                    listed.add(it.name);
                    out.push(`${pad}// luaList keeps Lua's 1-based indices, so ${it.name}[n] means the same here.`);
                }
            }
            const kw = seen.has(it.name) ? '' : (counts.get(it.name) > 1 ? 'let ' : 'const ');
            seen.add(it.name);
            pushWrapped(out, `${pad}${kw}${it.name} = ${v};`, pad);
            continue;
        }
        pushWrapped(out, `${pad}${expr(it.call, pad)};`, pad);
    }
    return out;
}

/** `if … then … else … end` -> `if (…) { … } else { … }`, same shape. */
function renderIf(node, pad, out) {
    node.clauses.forEach((c, i) => {
        out.push(`${pad}${i === 0 ? 'if' : '} else if'} (${expr(c.cond, pad)}) {`);
        out.push(...renderBlock(c.body, pad + PAD));
    });
    if (node.otherwise) {
        out.push(`${pad}} else {`);
        out.push(...renderBlock(node.otherwise, pad + PAD));
    }
    out.push(`${pad}}`);
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
export function recordingApi(rng = stubRng(1)) {
    const calls = [];
    const record = (fn, args) => {
        const pending = [];
        const clean = args.map((a) => sanitize(a, pending));
        calls.push({ fn, args: clean });
        for (const f of pending) f();
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
    };
    const align = luaList(placeholder('align[1]'), placeholder('align[2]'), placeholder('align[3]'));
    return {
        calls,
        api: {
            des: table('des'), selection: table('selection'), nh,
            percent, shuffle, d, math: { random: mathRandom },
            align, monkfoodshop: () => placeholder('monkfoodshop()'),
            luaList, luaLen,
        },
    };
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
    set(n, v) { this.vars.set(n, v); }
}

/** Evaluate a parsed expression against the stub api. */
function evalNode(node, env) {
    switch (node.t) {
        case 'lit': return node.v;
        case 'name': return env.get(node.v);
        case 'index': return evalNode(node.obj, env)[evalNode(node.key, env)];
        case 'field': return evalNode(node.obj, env)[node.name];
        case 'len': return luaLen(evalNode(node.obj, env));
        case 'concat': return node.parts.map((x) => evalNode(x, env)).join('');
        case 'table': {
            const t = dropNilPositional(node);
            if (t.positional === t.entries.length) return t.entries.map((e) => evalNode(e.value, env));
            const o = {};
            for (const e of t.entries) o[e.key] = evalNode(e.value, env);
            return o;
        }
        case 'func': return (...args) => {
            const inner = new Env(env);
            node.params.forEach((p, i) => inner.set(p, args[i]));
            execBlock(node.body, inner);
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

/** Execute one block of statements against the stub api. */
function execBlock(items, env) {
    for (const it of items) {
        if (it.s === 'comment') continue;
        if (it.s === 'local') {
            const v = evalNode(it.value, env);
            // Mirror the emitter: a positional table the script indexes,
            // measures with `#` or shuffles is emitted through luaList().
            const isList = it.value.t === 'table' && it.value.positional === it.value.entries.length
                && it.value.entries.length > 0 && needsLuaList(rootItems ?? items, it.name);
            env.set(it.name, isList ? luaList(...v) : v);
            continue;
        }
        if (it.s === 'if') {
            let done = false;
            for (const c of it.clauses) {
                if (evalNode(c.cond, env)) { execBlock(c.body, new Env(env)); done = true; break; }
            }
            if (!done && it.otherwise) execBlock(it.otherwise, new Env(env));
            continue;
        }
        evalNode(it.call, env);
    }
}

/**
 * The call stream the .lua produces, as plain comparable values.
 * @param {object[]} items @param {object} rng
 */
export function luaCallStream(items, rng = stubRng(1)) {
    const { calls, api } = recordingApi(rng);
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
export async function checkPort(luaPath, modPath) {
    const items = parse(fs.readFileSync(luaPath, 'utf8'));
    const mod = await import(`file://${fs.realpathSync(modPath)}`);
    for (const mode of CHECK_RNGS) {
        const want = luaCallStream(items, stubRng(mode));
        const { calls, api } = recordingApi(stubRng(mode));
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
