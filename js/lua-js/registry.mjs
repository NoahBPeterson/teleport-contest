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
// OFF-BY-DEFAULT SAFETY. With both maps empty, or with C2JS_LUA_PORT=0,
// active() is false, the harness leaves luaPort null, the allocator is not
// wrapped, and not one byte of behaviour changes. The corpus is run both ways.
//
// TRACING. C2JS_LUA_TRACE=1 makes the registry active without swapping any
// bytes: it only records, per load of a ported script, the slice of the RNG log
// that script consumed. Running the same session with trace-only and with the
// port live gives a per-script RNG-consumption diff — see tools/lua-oracle.mjs.

// TWO KINDS OF PORT. A level script's whole effect is the C bindings it calls,
// so its port runs against a port-owned lua_State (bridge.mjs) and the
// interpreter's state is irrelevant. A *read-back* script — dungeon.lua,
// quest.lua — has no effect at all except the global table it leaves behind
// for C to read afterwards, so its port must build that table in the state
// nhl_loadlua() was handed. interp-state.mjs finds that state; READBACK below
// lists the scripts that need it. Everything else about the seam is the same.

import * as cptr from '../cptr.js';
import { gu, svl } from '../generated/decl.js';
import { getRngLog } from '../generated/rnd.js';
import { com_pager, qt_pager } from '../generated/questpgr.js';
import { runPortedScript, runProtected, setGlobal } from './bridge.mjs';
import { installStateProbe, interpState, stateIsFresh, stateSeed } from './interp-state.mjs';
import { dumpGlobal, runRealChunk } from './readback.mjs';
import oracle from './scripts/oracle.mjs';
import dungeonPort, { globalName as dungeonGlobal } from './scripts/dungeon.mjs';
import questPort, { globalName as questGlobal } from './scripts/quest.mjs';

/**
 * Ported scripts, keyed by the filename nhl_loadlua() is given.
 * Add an entry here and the JS port replaces the .lua at runtime.
 */
const PORTS = new Map([
    ['oracle.lua', oracle],
]);

/**
 * Ported scripts that define a global for C to read back, keyed the same way.
 * `global` is the name the script assigns; the port is handed a `setGlobal`
 * bound to the interpreter's state.
 */
const READBACK = new Map([
    ['dungeon.lua', { body: dungeonPort, global: dungeonGlobal }],
    ['quest.lua', { body: questPort, global: questGlobal }],
]);

/** Every script this registry handles, ported or read-back. */
function handles(name) { return PORTS.has(name) || READBACK.has(name); }

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

/**
 * C2JS_LUA_READBACK=dump: fingerprint the global table a read-back script
 * leaves behind, on whichever side is running.
 *
 * On the interpreter side this also moves the chunk's execution into this
 * module (see onClose): the interpreter's own compile is given the stub, and
 * runRealChunk() executes the real bytes at the same seam. That is what makes
 * the two dumps comparable — same point in the run, same state, one execution
 * of the script either way.
 */
function readbackDump() { return env('C2JS_LUA_READBACK') === 'dump'; }

/**
 * C2JS_LUA_QUESTPROBE=1: once the game is up, deliver a fixed list of quest
 * messages for the hero's own role. Nothing in a normal recorded session
 * reaches quest.lua's role sections — only `common.legacy` — so this drives
 * the qt_pager() path that the corpus cannot, and the delivered text lands in
 * the screen sequence the oracle already compares byte for byte.
 */
function questProbeEnabled() {
    const v = env('C2JS_LUA_QUESTPROBE');
    return v === '1' || v === 'on' || v === 'true';
}

/** Read once: tick() is on the key-read path and must stay a null check. */
const QUEST_PROBE = questProbeEnabled();

/** Message ids present in every one of quest.lua's 13 role sections. */
const QUEST_PROBE_MSGIDS = ['firsttime', 'goal_first', 'encourage', 'discourage', 'gotit'];

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
export function portedScripts() { return [...PORTS.keys(), ...READBACK.keys()]; }

/** True when the harness should consult this registry at all. */
export function active() {
    const on = (PORTS.size + READBACK.size) > 0
        && (portsEnabled() || traceEnabled() || fpEnabled() || readbackDump() || questProbeEnabled());
    // The read-back ports need the interpreter's lua_State, and the only place
    // it can be caught is at creation — before main() runs, which is where the
    // harness imports this module. Installing it here rather than at module
    // scope keeps `realloc` untouched whenever the registry is inert.
    if (on && READBACK.size > 0) installStateProbe();
    return on;
}

/** 'run' = the port replaces the script; 'trace' = observe only. */
export function mode() { return portsEnabled() ? 'run' : 'trace'; }

/**
 * The lua_State a read-back script must define its global in, verified.
 *
 * A read-back port that cannot find its state is a hard error, not a silent
 * fallback: falling back would leave the global undefined and panic C
 * ("dungeon is not a lua table") somewhere far away, and a fallback that
 * quietly restored the interpreter would let a broken port pass the corpus.
 *
 * @param {string} name
 * @param {string} globalName
 */
function readbackState(name, globalName) {
    const L = interpState();
    if (!L) throw new Error(`lua-port ${name}: interpreter lua_State not found`);
    if (!stateIsFresh(L, globalName)) {
        throw new Error(`lua-port ${name}: state already defines '${globalName}'`);
    }
    return L;
}

/** Per-load records: {script, mode, rngFrom, rngTo}. */
export const loads = [];

/**
 * @param {string|null} vendoredName  playground-relative name, or null
 * @returns {string|null} the same name if this registry handles it
 */
export function scriptFor(vendoredName) {
    if (vendoredName === null || !handles(vendoredName)) return null;
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
    const rec = { script: name, mode: mode(), rngFrom: getRngLog().length, rngTo: -1 };
    loads.push(rec);
    if (mode() === 'run') return stubFor(orig);
    // Interpreter side. A read-back script under C2JS_LUA_READBACK=dump is the
    // one case where 'trace' still swaps the bytes: this module runs the real
    // chunk itself at fclose so the dump can be taken at the same seam as the
    // port's, and the interpreter must then not run it a second time.
    if (readbackDump() && READBACK.has(name)) { rec.realBytes = orig.slice(); return stubFor(orig); }
    return null;
}

/**
 * fclose() of a handled script: in 'run' mode this is where the port executes.
 * In 'trace' mode the interpreter has the real bytes and runs them itself, so
 * the RNG slice is closed on the *next* observation instead — see closeTrace().
 * @param {string} name
 */
export function onClose(name) {
    const rec = loads[loads.length - 1];
    const rb = READBACK.get(name);
    if (mode() === 'run') {
        if (rb) {
            const L = readbackState(name, rb.global);
            runProtected(L, name, () => rb.body({ setGlobal: (k, v) => setGlobal(L, k, v) }));
            if (readbackDump()) recordDump(rec, L, rb.global);
        } else {
            const body = PORTS.get(name);
            if (!body) throw new Error(`lua-port: no port registered for ${name}`);
            runPortedScript(name, body);
        }
        rec.rngTo = getRngLog().length;
    } else if (rec.realBytes) {
        // Interpreter side of the read-back oracle: same seam, same state, the
        // real chunk.
        const L = readbackState(name, rb.global);
        runRealChunk(L, rec.realBytes, name);
        recordDump(rec, L, rb.global);
        rec.realBytes = null;
        rec.rngTo = getRngLog().length;
    }
    // trace mode: the chunk has not run yet; the slice is closed lazily.
    if (fpEnabled()) armed = rec;
}

/** Attach the read-back fingerprint of `globalName` to a load record. */
function recordDump(rec, L, globalName) {
    const d = dumpGlobal(L, globalName);
    rec.readbackGlobal = globalName;
    rec.readbackHash = d.hash;          // canonical: content only
    rec.readbackOrder = d.order;        // raw lua_next order, seed-dependent
    rec.readbackValues = d.values;
    rec.readbackKeys = d.keys;
    rec.readbackSeed = stateSeed(L);
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
    if (QUEST_PROBE && !questProbed) runQuestProbe();
    if (armed === null) return;
    armed.typFingerprint = levelFingerprint();
    armed = null;
}

/** Whether the C2JS_LUA_QUESTPROBE deliveries have already been made. */
let questProbed = false;

/**
 * Deliver quest text for the hero's own role, and the two role-independent
 * `common` messages a normal game never shows.
 *
 * Each call is a full com_pager_core(): nhl_init(), nhl_loadlua("quest.lua")
 * — so the port (or the interpreter) runs again — lua_getglobal("questtext"),
 * lua_getfield(section), lua_getfield(msgid), and delivery through pline or a
 * text window. Whatever comes out is on the screen, which the oracle compares
 * byte for byte, and each load also produces its own read-back dump.
 *
 * gu+192 is u.urole.filecode (js/generated/questpgr.js:611), the role's
 * three-letter section name. It is set by role_init(), which runs during
 * character generation — far too early to deliver anything, since the message
 * window does not exist yet. The gate is instead the game's *own* first quest
 * load: com_pager("legacy") is the last thing newgame() does (allmain.c:832),
 * so once a quest.lua load has been recorded the game is fully up.
 */
function runQuestProbe() {
    if (!loads.some((l) => l.script === 'quest.lua')) return;
    if (!cptr.ldPtro(gu, 192)) return;   // role not set up yet
    questProbed = true;
    for (const id of QUEST_PROBE_MSGIDS) qt_pager(cptr.lit(id));
    for (const id of ['quest_portal', 'banished']) com_pager(cptr.lit(id));
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
