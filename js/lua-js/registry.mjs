// registry.mjs — which .lua scripts have a JS port, and how one takes over.
//
// INTERCEPTION POINT. Every .lua script the game runs enters the VM through
// exactly one function, nhl_loadlua() (nhlua.c:2338 / js/generated/nhlua.js:2178):
//
//     fopen(fname,"r") -> fseek/ftell/fread/fclose -> luaL_loadbufferx -> pcall
//
// That function is transpiled C. ES module bindings are immutable, and two of
// its three callers are intra-module (nhlua.js:2281, :2318), so it cannot be
// wrapped from outside without hand-editing js/generated. What *is* reachable
// is the file read itself: the harness owns fopen/fread/fclose (js/boot/
// harness.mjs) and the vendored playground behind them. So the port hooks the
// VFS:
//
//   onOpen  — if the script is ported, the bytes handed to the interpreter are
//             swapped for stubFor(): the same file, same length, same line
//             breaks, wrapped in a --[[ ]] long comment. It compiles to an
//             empty chunk. Equal length matters because nhl_loadlua does
//             alloc(buflen + 2) against NetHack's heap.
//   onClose — the port runs. That is the tightest available seam: the file has
//             been fully read, nhl_init() has already built the interpreter
//             state (and spent nhlib.lua's two align-shuffle draws), and
//             nothing has happened yet except the read. Only the Lua parse of
//             an empty chunk is reordered past the des.* calls, and parsing
//             touches neither NetHack's globals nor its RNG.
//
// OFF-BY-DEFAULT SAFETY. With PORTS empty, or with C2JS_LUA_PORT=0, active()
// is false, the harness leaves luaPort null and not one byte of behaviour
// changes. The corpus is run both ways.
//
// TRACING. C2JS_LUA_TRACE=1 makes the registry active without swapping any
// bytes: it only records, per load of a ported script, the slice of the RNG log
// that script consumed. Running the same session with trace-only and with the
// port live gives a per-script RNG-consumption diff — see tools/lua-oracle.mjs.

import * as cptr from '../cptr.js';
import { svl } from '../generated/decl.js';
import { getRngLog } from '../generated/rnd.js';
import { runPortedScript } from './bridge.mjs';
import oracle from './scripts/oracle.mjs';

/**
 * Ported scripts, keyed by the filename nhl_loadlua() is given.
 * Add an entry here and the JS port replaces the .lua at runtime.
 */
const PORTS = new Map([
    ['oracle.lua', oracle],
]);

function env(name) { return globalThis.process?.env?.[name]; }

/** Env kill-switch: C2JS_LUA_PORT=0 restores the pure-interpreter path. */
function portsEnabled() {
    const v = env('C2JS_LUA_PORT');
    return !(v === '0' || v === 'off' || v === 'false');
}

/** C2JS_LUA_TRACE=1: observe ported scripts without replacing them. */
function traceEnabled() {
    const v = env('C2JS_LUA_TRACE');
    return v === '1' || v === 'on' || v === 'true';
}

/** C2JS_LUA_FP=1: fingerprint the generated level map after each ported load. */
function fpEnabled() {
    const v = env('C2JS_LUA_FP');
    return v === '1' || v === 'on' || v === 'true';
}

// levl[x][y] layout, read straight out of the transpiled accessor the des
// bindings use (js/generated/sp_lev.js:613):
//     levl[x][y].typ  ==  cptr.ld1so3(svl, x, 756, y, 36, 1684)
// i.e. svl + 1684 + x*756 + y*36, struct rm = 36 bytes, ROWNO rows per column.
// Object/monster chains hang off the same struct level, at offsets taken the
// same way (js/generated/mkobj.js:1952, js/generated/apply.js:900):
//     level.objects[x][y]  ==  cptr.ldPtro3(svl, x, 168, y, 8, 62160)
//     level.monsters[x][y] ==  cptr.ldPtro3(svl, x, 168, y, 8, 75600)
// struct obj:   nexthere @8, ox @28 (i16), oy @30, otyp @32
// struct monst: mnum @20 (i16), mx @28, my @30
const RM_BASE = 1684, RM_XSTRIDE = 756, RM_SIZE = 36, COLNO = 80, ROWNO = 21;
const OBJ_BASE = 62160, MON_BASE = 75600, GRID_XSTRIDE = 168, GRID_YSTRIDE = 8;

function fnv(h, v) { return Math.imul(h ^ (v & 0xFF), 0x01000193) >>> 0; }
function fnv16(h, v) { return fnv(fnv(h, v & 0xFF), (v >> 8) & 0xFF); }

/**
 * FNV-1a over what a level script actually built: the terrain type of every
 * square, then every object (position + otyp) and every monster (position +
 * species) on the level, in map order.
 *
 * This is the *result* of the script, and it catches things the RNG log and
 * the visible screens do not — a statue placed one square over consumes
 * identical randomness and may never be looked at, but it moves this hash.
 * Deliberately excludes heap pointers and the rest of struct rm/obj/monst:
 * the port and the interpreter allocate different amounts of memory by
 * construction, so raw addresses are not a fair comparison.
 */
function levelFingerprint() {
    let h = 0x811c9dc5;
    for (let x = 0; x < COLNO; x++) {
        for (let y = 0; y < ROWNO; y++) {
            h = fnv(h, cptr.ld1uo(svl, RM_BASE + x * RM_XSTRIDE + y * RM_SIZE));
        }
    }
    for (let x = 0; x < COLNO; x++) {
        for (let y = 0; y < ROWNO; y++) {
            for (let o = cptr.ldPtro3(svl, x, GRID_XSTRIDE, y, GRID_YSTRIDE, OBJ_BASE);
                o; o = cptr.ldPtro(o, 8)) {
                h = fnv16(fnv(fnv(h, x), y), cptr.ldI16o(o, 32));
            }
            const m = cptr.ldPtro3(svl, x, GRID_XSTRIDE, y, GRID_YSTRIDE, MON_BASE);
            if (m) h = fnv16(fnv(fnv(h, x), y), cptr.ldI16o(m, 20));
        }
    }
    return h >>> 0;
}

/** @returns {string[]} the ported script names */
export function portedScripts() { return [...PORTS.keys()]; }

/** True when the harness should consult this registry at all. */
export function active() {
    return PORTS.size > 0 && (portsEnabled() || traceEnabled() || fpEnabled());
}

/** 'run' = the port replaces the script; 'trace' = observe only. */
export function mode() { return portsEnabled() ? 'run' : 'trace'; }

/** Per-load records: {script, mode, rngFrom, rngTo}. */
export const loads = [];

/**
 * @param {string|null} vendoredName  playground-relative name, or null
 * @returns {string|null} the same name if this registry handles it
 */
export function scriptFor(vendoredName) {
    if (vendoredName === null || !PORTS.has(vendoredName)) return null;
    return active() ? vendoredName : null;
}

/**
 * The bytes the interpreter sees instead of the real script: byte-for-byte the
 * same length, newlines preserved, everything else inside a Lua long comment.
 *
 * `--[[` goes at offset 0 and `]]` at the end; the body is '.' except where the
 * original had '\n', so no `]]` can appear inside and no line grows past
 * nhl_loadlua's 8 KB LOADCHUNKSIZE line limit.
 *
 * @param {Uint8Array} orig
 * @returns {Uint8Array}
 */
export function stubFor(orig) {
    const n = orig.length;
    if (n < 8) return new Uint8Array(0);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = orig[i] === 10 ? 10 : 46; // '\n' or '.'
    out[0] = 45; out[1] = 45; out[2] = 91; out[3] = 91;            // "--[["
    let e = n - 1;
    while (e > 4 && out[e] === 10) e--;                            // before trailing NLs
    out[e - 1] = 93; out[e] = 93;                                  // "]]"
    return out;
}

/**
 * fopen() of a handled script.
 * @param {string} name
 * @param {Uint8Array} orig
 * @returns {Uint8Array|null} replacement bytes, or null to leave them alone
 */
export function onOpen(name, orig) {
    loads.push({ script: name, mode: mode(), rngFrom: getRngLog().length, rngTo: -1 });
    return mode() === 'run' ? stubFor(orig) : null;
}

/**
 * fclose() of a handled script: in 'run' mode this is where the port executes.
 * In 'trace' mode the interpreter has the real bytes and runs them itself, so
 * the RNG slice is closed on the *next* observation instead — see closeTrace().
 * @param {string} name
 */
export function onClose(name) {
    const rec = loads[loads.length - 1];
    if (mode() === 'run') {
        const body = PORTS.get(name);
        if (!body) throw new Error(`lua-port: no port registered for ${name}`);
        runPortedScript(name, body);
        rec.rngTo = getRngLog().length;
    }
    // trace mode: the chunk has not run yet; the slice is closed lazily.
    if (fpEnabled()) armed = rec;
}

/** Load record awaiting a level fingerprint, or null. */
let armed = null;

/**
 * Called by the harness on every key read. The first read after a ported
 * script loaded is the first quiescent moment of the freshly built level, and
 * it is the same moment on both sides of the oracle, so it is where the
 * fingerprint is taken.
 */
export function tick() {
    if (armed === null) return;
    armed.typFingerprint = levelFingerprint();
    armed = null;
}

/**
 * Close any still-open trace slice. Called by the harness once the game is
 * over; in trace mode the script's own execution happens after fclose, so the
 * end index is only known once nothing else can be attributed to it. Callers
 * that need per-load precision use the *next* load's rngFrom as the bound.
 */
export function closeTrace() {
    for (const r of loads) if (r.rngTo < 0) r.rngTo = getRngLog().length;
    return loads;
}
