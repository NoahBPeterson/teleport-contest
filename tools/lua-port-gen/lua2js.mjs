#!/usr/bin/env node
// lua2js.mjs — one-time generator: a declarative .lua data file -> a readable
// JS module holding the same nested value.
//
// WHY A GENERATOR. Two of NetHack's scripts, quest.lua (132 KB) and
// dungeon.lua (6.7 KB), contain no executable statements at all: each is a
// single assignment of a nested table constructor to a global. Together they
// are 21.7 % of the .lua corpus by bytes. Hand-transcribing 3,000 lines of
// quest prose would introduce exactly the class of error the port exists to
// avoid, so the transcription is mechanical and the *result* is reviewed.
//
// WHAT IT PARSES. Deliberately not Lua — the declarative subset those two
// files use, and nothing more: comments, string/number/boolean/nil literals,
// long strings ([[...]]), and table constructors with record (`k = v`),
// bracketed (`[k] = v`) and positional fields. Anything else is a hard error,
// so a future 5.1 quest.lua that grows a function call fails loudly instead of
// being silently mistranslated.
//
// WHAT IT EMITS. A module exporting one default value that mirrors the Lua
// layout one-for-one:
//   * a table with only positional fields  -> JS array
//   * a table with only keyed fields       -> JS object, keys in source order
//   * a mixed table                        -> rejected (see LuaTable below);
//     none occur, and if one appears the array/hash split it implies for
//     lua_createtable() would need an explicit representation.
// Multi-line strings become template literals so the quest prose stays
// diffable against the .lua it came from.
//
// Usage:
//   node tools/lua-port-gen/lua2js.mjs <in.lua> <global> <out.mjs> [--header=...]

import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

const PUNCT = new Set(['{', '}', '[', ']', '=', ',', ';']);

/**
 * @param {string} src
 * @returns {{k: string, v: any, line: number}[]} tokens; k is one of
 *   'punct' | 'name' | 'str' | 'num' | 'kw' | 'eof'
 */
function lex(src) {
    const toks = [];
    let i = 0, line = 1;
    const err = (m) => { throw new Error(`lua2js: line ${line}: ${m}`); };

    // `[[ ... ]]` / `[==[ ... ]==]`; returns the body or null if not a long
    // bracket at `i`. Lua drops a newline immediately after the opener.
    const longBracket = (open) => {
        let j = i + 1, eq = 0;
        while (src[j] === '=') { eq++; j++; }
        if (src[j] !== '[') return null;
        j++;
        if (src[j] === '\r') j++;
        if (src[j] === '\n') { j++; line++; }
        const close = ']' + '='.repeat(eq) + ']';
        const end = src.indexOf(close, j);
        if (end < 0) err(`unterminated long ${open}`);
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
            i += 2;
            if (src[i] === '[' && longBracket('comment') !== null) continue;
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (c === '[' && (src[i + 1] === '[' || src[i + 1] === '=')) {
            const startLine = line;
            const body = longBracket('string');
            if (body !== null) { toks.push({ k: 'str', v: body, line: startLine, long: true }); continue; }
        }
        if (PUNCT.has(c)) { toks.push({ k: 'punct', v: c, line }); i++; continue; }
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
        // A bare '-' here is unary minus: the '--' comment case is handled above.
        if (/[0-9]/.test(c) || ((c === '.' || c === '-') && /[0-9]/.test(src[i + 1] || ''))) {
            const m = /^-?(0[xX][0-9a-fA-F]+|[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?)/.exec(src.slice(i));
            if (!m) err('bad number');
            toks.push({ k: 'num', v: Number(m[0]), line });
            i += m[0].length;
            continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
            const w = m[0];
            i += w.length;
            toks.push({ k: (w === 'true' || w === 'false' || w === 'nil') ? 'kw' : 'name', v: w, line });
            continue;
        }
        err(`unexpected character ${JSON.stringify(c)}`);
    }
    toks.push({ k: 'eof', v: null, line });
    return toks;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * A Lua table constructor. `entries` keeps source order; `positional` counts
 * the fields that landed in the array part. The bridge needs both numbers to
 * size lua_createtable() the way OP_NEWTABLE does.
 */
class LuaTable {
    constructor() { this.entries = []; this.positional = 0; }
}

export function parse(src) {
    const toks = lex(src);
    let p = 0;
    const peek = () => toks[p];
    const err = (m) => { throw new Error(`lua2js: line ${peek().line}: ${m}`); };
    const eat = (k, v) => {
        const t = toks[p];
        if (t.k !== k || (v !== undefined && t.v !== v)) err(`expected ${v ?? k}, got ${JSON.stringify(t.v)}`);
        p++;
        return t;
    };
    const at = (k, v) => peek().k === k && (v === undefined || peek().v === v);

    function value() {
        const t = peek();
        if (t.k === 'str' || t.k === 'num') { p++; return { lit: t.v, long: !!t.long }; }
        if (t.k === 'kw') { p++; return { lit: t.v === 'true' ? true : t.v === 'false' ? false : null }; }
        if (at('punct', '{')) return table();
        return err(`expected a value, got ${JSON.stringify(t.v)}`);
    }

    function table() {
        eat('punct', '{');
        const tbl = new LuaTable();
        while (!at('punct', '}')) {
            if (at('name') && toks[p + 1].k === 'punct' && toks[p + 1].v === '=') {
                const k = eat('name').v; eat('punct', '=');
                tbl.entries.push({ key: k, value: value() });
            } else if (at('punct', '[')) {
                eat('punct', '[');
                const kt = peek();
                if (kt.k !== 'str' && kt.k !== 'num') err('only string/number keys are supported');
                p++;
                eat('punct', ']'); eat('punct', '=');
                tbl.entries.push({ key: kt.v, value: value(), bracketed: true });
            } else {
                tbl.positional++;
                tbl.entries.push({ key: null, value: value() });
            }
            if (at('punct', ',') || at('punct', ';')) p++;
            else break;
        }
        eat('punct', '}');
        return tbl;
    }

    const globals = [];
    while (!at('eof')) {
        const name = eat('name').v;
        eat('punct', '=');
        globals.push({ name, value: value() });
    }
    return globals;
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(['default', 'class', 'function', 'return', 'new', 'delete', 'in', 'of', 'do', 'if', 'else', 'for', 'while', 'var', 'let', 'const']);

/** A JS string literal: template literal when multi-line, quoted otherwise. */
function jsString(s) {
    if (s.includes('\n')) {
        return '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
    }
    return JSON.stringify(s);
}

function jsKey(k) {
    if (typeof k === 'number') return `[${k}]`;
    return IDENT.test(k) && !RESERVED.has(k) ? k : JSON.stringify(k);
}

/** True when the table renders on one line without hurting readability. */
function isShort(node) {
    if (!(node instanceof LuaTable)) return true;
    if (node.entries.length > 4) return false;
    return node.entries.every((e) => !(e.value instanceof LuaTable)
        && !(typeof e.value.lit === 'string' && (e.value.lit.length > 40 || e.value.lit.includes('\n'))));
}

function emit(node, indent, out) {
    const pad = '    '.repeat(indent);
    const padIn = '    '.repeat(indent + 1);
    if (!(node instanceof LuaTable)) {
        const v = node.lit;
        if (typeof v === 'string') return jsString(v);
        if (v === null) return 'null';
        return String(v);
    }
    if (node.entries.length === 0) return node.positional ? '[]' : '{}';
    const arrayLike = node.positional === node.entries.length;
    const mixed = node.positional > 0 && !arrayLike;
    if (mixed) {
        // Would need an explicit array-part/hash-part representation for
        // lua_createtable()'s size hints. Neither file has one.
        throw new Error(`lua2js: mixed array/record table (${node.positional} positional, `
            + `${node.entries.length - node.positional} keyed) is not supported`);
    }
    const parts = node.entries.map((e) => {
        const v = emit(e.value, indent + 1, out);
        return arrayLike ? v : `${jsKey(e.key)}: ${v}`;
    });
    const [open, close] = arrayLike ? ['[', ']'] : ['{', '}'];
    if (isShort(node)) {
        const one = `${open} ${parts.join(', ')} ${close}`;
        if (one.length + pad.length <= 100) return one;
    }
    return `${open}\n${parts.map((s) => padIn + s).join(',\n')},\n${pad}${close}`;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/** The parsed Lua value as plain JS, for round-tripping against the module. */
export function plain(node) {
    if (!(node instanceof LuaTable)) return node.lit;
    if (node.positional === node.entries.length) return node.entries.map((e) => plain(e.value));
    return Object.fromEntries(node.entries.map((e) => [e.key, plain(e.value)]));
}

/**
 * Deep structural comparison, order-sensitive for object keys — key order is
 * what determines the Lua table's hash layout, so it is part of the contract.
 * @returns {string|null} the path of the first difference, or null
 */
export function diff(a, b, path = '$') {
    if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array/object mismatch`;
    if (a === null || typeof a !== 'object') return Object.is(a, b) ? null : `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return `${path}: ${ka.length} keys != ${kb.length}`;
    for (let i = 0; i < ka.length; i++) {
        if (ka[i] !== kb[i]) return `${path}: key ${i} is ${ka[i]} != ${kb[i]}`;
        const d = diff(a[ka[i]], b[kb[i]], `${path}.${ka[i]}`);
        if (d) return d;
    }
    return null;
}

function main(argv) {
    const check = argv.includes('--check');
    const [inPath, globalName, outPath] = argv.filter((a) => !a.startsWith('--'));
    if (!inPath || !globalName || !outPath) {
        process.stderr.write('usage: lua2js.mjs [--check] <in.lua> <global> <out.mjs>\n');
        process.exit(2);
    }
    const src = fs.readFileSync(inPath, 'utf8');
    const globals = parse(src);
    const g = globals.find((x) => x.name === globalName);
    if (!g) throw new Error(`lua2js: ${inPath} does not assign a global named ${globalName}`);
    if (globals.length !== 1) throw new Error(`lua2js: ${inPath} assigns ${globals.length} globals; expected 1`);

    const rel = inPath.replace(/^.*\/dat\//, 'dat/');
    const body = emit(g.value, 0, null);
    const header = [
        '// GENERATED by tools/lua-port-gen/lua2js.mjs — do not edit by hand.',
        `// Source: nethack-c/recorder/${rel} (the \`${globalName}\` global), NetHack 3.7.`,
        '//',
        '// The .lua file is pure data: one table constructor, no executable',
        '// statements. This module is the same value written as a JS literal, in',
        '// source order, so a 5.1 diff of the .lua maps line-for-line onto a diff',
        `// of this file. js/lua-js/scripts/${globalName === 'dungeon' ? 'dungeon' : 'quest'}.mjs feeds it to the`,
        '// C side through the bridge.',
        '',
        `export default ${body};`,
        '',
    ].join('\n');
    if (check) {
        // Re-derive the value from the .lua and compare it against what the
        // committed module actually exports. This is the transcription proof:
        // it re-runs the parser but reads the *emitted* file back through the
        // JS parser, so an emitter bug (bad escape, lost key, reordered field)
        // cannot hide.
        return import(new URL(`file://${fs.realpathSync(outPath)}`)).then((m) => {
            const d = diff(plain(g.value), m.default);
            if (d) { process.stderr.write(`lua2js --check FAIL ${outPath}: ${d}\n`); process.exit(1); }
            process.stderr.write(`lua2js --check PASS ${outPath}\n`);
        });
    }
    fs.writeFileSync(outPath, header);
    process.stderr.write(`lua2js: ${inPath} -> ${outPath} (${header.length} bytes)\n`);
    return undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
