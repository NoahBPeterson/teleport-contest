#!/usr/bin/env node
// lua2des.mjs — generator: a pure `des.*` call-stream .lua level script -> a
// readable JS port module.
//
// WHY A SECOND GENERATOR. tools/lua-port-gen/lua2js.mjs handles the two
// *read-back* scripts, whose whole body is one table constructor. The 49 T0
// level scripts are the other pure shape: a flat stream of `des.*` calls with
// literal arguments, no control flow, no closures and no script-level RNG.
// Between them those 49 files hold 917 des.monster() calls, 601 des.object()
// calls and 34 maps; transcribing that by hand is exactly the kind of work
// that produces a one-character error the corpus would never notice. So the
// transcription is mechanical and the *result* is reviewed and re-checked.
//
// WHAT IT PARSES. Not Lua — the call-stream subset those scripts use:
//   * comments (kept, in place, so the JS mirrors the .lua line for line)
//   * `des.NAME(args)` statements
//   * `local NAME = exp`
//   * literals, long strings, table constructors, `a.b`, `a[k]`, `a:m(args)`,
//     nested calls (`selection.area(...)`, `nh.eckey(...)`) and `..` concat
// Anything else — `if`, `for`, `function`, assignment to a global — is a hard
// error, so a 5.1 script that grows control flow fails loudly rather than
// being silently mistranslated. (A T1/T2 script has to be ported by hand.)
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
// recording stub API, and compares the resulting call stream — every call
// name, every argument, every table key in order — against the stream derived
// from the .lua by this file's own parser. That is the transcription proof: an
// emitter bug, a lost trailing space in a map, a reordered field or an editor
// reformatting the file cannot hide. test/lua-port-scripts.test.mjs runs it
// over every generated port on every `node --test`.
//
// Usage:
//   node tools/lua-port-gen/lua2des.mjs <in.lua> <out.mjs>
//   node tools/lua-port-gen/lua2des.mjs --check <in.lua> <out.mjs>

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

const PUNCT3 = [];
const PUNCT2 = ['..'];
const PUNCT1 = ['{', '}', '[', ']', '(', ')', '=', ',', ';', '.', ':'];

const KEYWORDS = new Set(['true', 'false', 'nil', 'local']);
/** Lua keywords this subset refuses outright — they mean real control flow. */
const REJECTED = new Set(['if', 'then', 'else', 'elseif', 'end', 'for', 'while',
    'repeat', 'until', 'function', 'return', 'do', 'and', 'or', 'not', 'break', 'goto']);

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
            if (REJECTED.has(w)) err(`'${w}' is outside the call-stream subset — port this script by hand`);
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
//   {t:'call',  fn, args, line}         f(...)
//   {t:'method',obj, name, args, line}  a:m(...)
//   {t:'table', entries, positional, line}
//   {t:'concat',parts, line}            a .. b .. c
// Statements:
//   {s:'comment', text, long, line}
//   {s:'local',   name, value, line}
//   {s:'call',    call, line}

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

    function primary() {
        const t = peek();
        if (t.k === 'str' || t.k === 'num') { p++; return { t: 'lit', v: t.v, long: !!t.long, line: t.line }; }
        if (t.k === 'kw') {
            if (t.v === 'local') err("'local' is a statement, not a value");
            p++;
            return { t: 'lit', v: t.v === 'true' ? true : t.v === 'false' ? false : null, line: t.line };
        }
        if (at('punct', '{')) return table();
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

    const items = [];
    while (!at('eof')) {
        const t = peek();
        if (t.k === 'comment') { p++; items.push({ s: 'comment', text: t.v, long: !!t.long, line: t.line }); continue; }
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
        const call = primary();
        if (call.t !== 'call' && call.t !== 'method') err('a statement must be a function call');
        if (at('punct', ';')) p++;
        items.push({ s: 'call', call, line: t.line, endLine: toks[p - 1].line });
    }
    return items;
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
        case 'concat': return node.parts.map((x) => expr(x, pad)).join(' + ');
        case 'call': return `${expr(node.fn, pad)}(${argList(node.args, pad)})`;
        // `sel:filter_mapchar('.')` is sugar for the same C function with the
        // selection as argument 1 — nhlsel.c registers one table and points
        // the metatable's __index at it — so the port spells it out.
        case 'method': return `${methodTarget(node)}.${node.name}(${argList([node.obj, ...node.args], pad)})`;
        case 'table': return tableLit(node, pad);
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

/** Whether the file being emitted had one of those. Reset per emitModule(). */
let sawNilPositional = null;

/** Strip positional entries that are a bare reference to a nil global. */
function dropNilPositional(node) {
    const isNil = (e) => e.key === null && e.value.t === 'name' && NIL_GLOBALS.has(e.value.v);
    if (!node.entries.some(isNil)) return node;
    const dropped = node.entries.filter(isNil).map((e) => e.value.v);
    if (sawNilPositional) for (const d of dropped) sawNilPositional.add(d);
    return {
        ...node,
        entries: node.entries.filter((e) => !isNil(e)),
        positional: node.positional - dropped.length,
    };
}

/** The API table a `a:m(...)` call dispatches to. Only selections use this. */
function methodTarget(node) {
    return 'selection';
}

function argList(args, pad) {
    return args.map((a) => expr(a, pad)).join(', ');
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
    const padIn = pad + '    ';
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
 * Everything a ported T0 script can be handed, in the order bridge.mjs's api
 * declares it. `align` and `monkfoodshop` are nhlib.lua's, not the des DSL's:
 * they are the only two pieces of the Lua prelude any T0 script reaches for.
 */
const API_FIELDS = ['des', 'selection', 'nh', 'align', 'monkfoodshop', 'luaList'];

/** nhlib.lua globals a script may call as a bare function. */
const NHLIB_FUNCS = new Set(['monkfoodshop']);

/** The api fields a script actually uses, in the order the api declares them. */
function apiFields(items) {
    const used = new Set();
    const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (n.t === 'name') used.add(n.v);
        if (n.t === 'field') { walk(n.obj); return; }
        if (n.t === 'method') used.add('selection');
        for (const k of ['obj', 'key', 'fn', 'value', 'call']) if (n[k]) walk(n[k]);
        for (const k of ['args', 'parts']) if (n[k]) for (const x of n[k]) walk(x);
        if (n.entries) for (const e of n.entries) walk(e.value);
    };
    for (const it of items) { if (it.s === 'call') walk(it.call); if (it.s === 'local') walk(it.value); }
    const locals = new Set(items.filter((i) => i.s === 'local').map((i) => i.name));
    return API_FIELDS.filter((f) => used.has(f) && !locals.has(f));
}

/** True when a `local` list is indexed with Lua's 1-based indices. */
function needsLuaList(items, name) {
    let indexed = false;
    const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (n.t === 'index' && n.obj.t === 'name' && n.obj.v === name) indexed = true;
        for (const k of ['obj', 'key', 'fn', 'value', 'call']) if (n[k]) walk(n[k]);
        for (const k of ['args', 'parts']) if (n[k]) for (const x of n[k]) walk(x);
        if (n.entries) for (const e of n.entries) walk(e.value);
    };
    for (const it of items) { if (it.s === 'call') walk(it.call); if (it.s === 'local') walk(it.value); }
    return indexed;
}

const PAD = '    ';

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

    const fields = new Set(apiFields(body));
    const listLocals = body.filter((i) => i.s === 'local' && i.value.t === 'table' && needsLuaList(body, i.name));
    if (listLocals.length) fields.add('luaList');
    const params = API_FIELDS.filter((f) => fields.has(f));

    // Body first: rendering it is what discovers the quirks the header reports.
    sawNilPositional = new Set();
    const lines = renderBody(body, listLocals);
    const nils = [...sawNilPositional];
    sawNilPositional = null;

    const out = [];
    out.push(`// ${base}.mjs — port of dat/${base}.lua.`);
    out.push('//');
    out.push('// GENERATED by tools/lua-port-gen/lua2des.mjs from');
    out.push(`// nethack-c/recorder/dat/${base}.lua. Regenerate rather than hand-edit; the`);
    out.push('// call stream is re-checked against the .lua by');
    out.push('// test/lua-port-scripts.test.mjs on every run.');
    out.push('//');
    out.push('// A T0 script: a flat stream of des.* calls, no control flow, no closures');
    out.push('// and no script-level RNG, so equivalence is exactly "the same des.* calls');
    out.push('// in the same order with the same arguments". All randomness is inside the');
    out.push('// C bindings themselves.');
    if (nils.length) {
        out.push('//');
        out.push(`// The .lua has a stray positional \`${nils.join('`, `')}\` inside some of its`);
        out.push('// argument tables — a bare reference to a global NetHack never defines, so');
        out.push('// Lua stores nil at index 1, which stores nothing. Every lspo_* reads its');
        out.push('// fields by name and nothing walks the table, so it is dropped here.');
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

/** The statements of the function body, one .lua line mapped to one JS line. */
function renderBody(body, listLocals) {
    const out = [];
    let prevLine = body.length ? body[0].line : 0;
    for (const it of body) {
        if (it.line - prevLine > 1) out.push('');
        prevLine = it.endLine ?? it.line;
        if (it.s === 'comment') {
            for (const l of String(it.text).split('\n')) out.push(`${PAD}//${l.replace(/\s+$/, '')}`);
            continue;
        }
        if (it.s === 'local') {
            const isList = listLocals.includes(it);
            const v = isList
                ? `luaList(${it.value.entries.map((e) => expr(e.value, PAD)).join(', ')})`
                : expr(it.value, PAD);
            if (isList) {
                out.push(`${PAD}// luaList keeps Lua's 1-based indices, so ${it.name}[n] means the same here.`);
            }
            pushWrapped(out, `${PAD}const ${it.name} = ${v};`);
            continue;
        }
        pushWrapped(out, `${PAD}${expr(it.call, PAD)};`);
    }
    return out;
}

/**
 * Push a statement, breaking a too-long single-line call at its argument
 * commas rather than letting it run off the page.
 */
function pushWrapped(out, text) {
    if (text.length <= MAXCOL || text.includes('\n')) { out.push(text); return; }
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if (open < 0 || close < open) { out.push(text); return; }
    const head = text.slice(0, open + 1), tail = text.slice(close);
    const args = splitTop(text.slice(open + 1, close));
    const padIn = PAD.repeat(2);
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
    out.push(PAD + tail);
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
 * Values a stub API hands back. Anything that could end up inside a `..`
 * concatenation is represented by a *string* placeholder, so JS `+` and Lua
 * `..` produce the same thing on both sides of the comparison; everything else
 * is a tagged object compared structurally.
 */
const placeholder = (s) => `\u0000${s}\u0000`;

/** Evaluate a parsed expression the way the stub API would. */
function evalNode(node, env) {
    switch (node.t) {
        case 'lit': return node.v;
        case 'name':
            if (env.has(node.v)) return env.get(node.v);
            if (node.v === 'align') return [undefined, placeholder('align[1]'), placeholder('align[2]'), placeholder('align[3]')];
            throw new Error(`lua2des --check: unknown name ${node.v}`);
        case 'index': {
            const o = evalNode(node.obj, env);
            return o[evalNode(node.key, env)];
        }
        case 'field': throw new Error(`lua2des --check: unexpected field access .${node.name}`);
        case 'concat': return node.parts.map((x) => evalNode(x, env)).join('');
        case 'table': {
            const t = dropNilPositional(node);
            if (t.positional === t.entries.length) return t.entries.map((e) => evalNode(e.value, env));
            const o = {};
            for (const e of t.entries) o[e.key] = evalNode(e.value, env);
            return o;
        }
        case 'method':
            return { __call: `selection.${node.name}`, args: [evalNode(node.obj, env), ...node.args.map((a) => evalNode(a, env))] };
        case 'call': {
            const fn = node.fn;
            // An nhlib global (`monkfoodshop()`), which returns a plain string.
            if (fn.t === 'name' && NHLIB_FUNCS.has(fn.v)) return placeholder(`${fn.v}()`);
            if (fn.t !== 'field' || fn.obj.t !== 'name') throw new Error('lua2des --check: unsupported call target');
            const name = `${fn.obj.v}.${fn.name}`;
            const args = node.args.map((a) => evalNode(a, env));
            if (name === 'nh.eckey') return placeholder(`nh.eckey(${args[0]})`);
            return { __call: name, args };
        }
        default: throw new Error(`lua2des --check: cannot evaluate ${node.t}`);
    }
}

/** The des.* call stream the .lua produces, as plain comparable values. */
export function luaCallStream(items) {
    const env = new Map();
    const calls = [];
    for (const it of items) {
        if (it.s === 'comment') continue;
        if (it.s === 'local') {
            const v = evalNode(it.value, env);
            // A local list that the script indexes is emitted through luaList(),
            // i.e. with Lua's 1-based indices; match that here so `place[4]`
            // means the same on both sides.
            const oneBased = Array.isArray(v) && it.value.t === 'table' && needsLuaList(items, it.name);
            env.set(it.name, oneBased ? [undefined, ...v] : v);
            continue;
        }
        const fn = it.call.fn;
        if (!fn || fn.t !== 'field' || fn.obj.t !== 'name' || fn.obj.v !== 'des') {
            throw new Error(`lua2des --check: line ${it.line}: statement is not a des.* call`);
        }
        calls.push({ fn: `des.${fn.name}`, args: it.call.args.map((a) => evalNode(a, env)) });
    }
    return calls;
}

/** A stub api whose des.* calls are recorded instead of executed. */
export function recordingApi() {
    const calls = [];
    const des = new Proxy({}, { get: (_, name) => (...args) => { calls.push({ fn: `des.${String(name)}`, args }); } });
    const selection = new Proxy({}, { get: (_, name) => (...args) => ({ __call: `selection.${String(name)}`, args }) });
    const nh = { eckey: (c) => placeholder(`nh.eckey(${c})`), rn2: () => 0, random: () => 0 };
    const align = [undefined, placeholder('align[1]'), placeholder('align[2]'), placeholder('align[3]')];
    const monkfoodshop = () => placeholder('monkfoodshop()');
    const luaList = (...items) => [undefined, ...items];
    return { calls, api: { des, selection, nh, align, monkfoodshop, luaList } };
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
 * Compare a generated port module against its .lua source.
 * @param {string} luaPath @param {string} modPath
 * @returns {Promise<string|null>} the first difference, or null
 */
export async function checkPort(luaPath, modPath) {
    const items = parse(fs.readFileSync(luaPath, 'utf8'));
    const want = luaCallStream(items);
    const mod = await import(`file://${fs.realpathSync(modPath)}`);
    const { calls, api } = recordingApi();
    mod.default(api);
    if (calls.length !== want.length) return `call count: lua=${want.length} js=${calls.length}`;
    for (let i = 0; i < want.length; i++) {
        const d = diff(want[i], calls[i], `call[${i}] ${want[i].fn}`);
        if (d) return d;
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
