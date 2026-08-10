// callgraph.mjs — the static call graph of the transpiled engine, and the
// "colouring" fixpoint over it.
//
// Shared by tools/c2js/color-census.mjs (the report) and
// tools/c2js/yieldify.mjs (the transform). Both must agree exactly on which
// functions are coloured and which call sites are coloured, or the emitted
// build is broken, so they read it from one place.
//
// Node ids are "<moduleKey>#<funcName>"; C's one-definition rule makes most
// names unique but file-static functions collide, so the module qualifier is
// load-bearing. Non-function targets get pseudo-ids:
//   GLOBAL#name        a harness-provided global (getchar, malloc, strcmp...)
//   NS#ns.name         a namespace member that is not a scanned function
//   EXTERN#name        imported, but not a function definition
//   PSEUDO#fptr        any call through a C function pointer
//   PSEUDO#site-block  a call that blocks only in a specific syntactic context

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanModule } from './jslex.mjs';
import { RESET_BARREL, stripResetBlock } from './reset-census.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ---------------------------------------------------------------------------
// The reset pass is invisible to this one, deliberately.
// ---------------------------------------------------------------------------
//
// tools/c2js/resetify.mjs appends a delimited block to the tail of every
// stateful module in js/generated/ (a C2JS_RESET=1 build) and writes a barrel
// beside them. Neither is transpiled C, and both would be *wrong* to colour:
//
//   - `export function __captureState(S) { __c2js_rs = [S(a), S(b), ...]; }`
//     calls its own parameter, which this analysis classifies as a call through
//     a function pointer, so `fptrMode` colours it and yieldify emits
//     `(yield* Y.icall(S(a)))`. The reset functions become generators — and
//     js/generated-y/__reset.js's barrel calls them directly, so the yieldable
//     build's reset would throw on its first use.
//   - a rewritten barrel would be a second, differently-shaped copy of a file
//     resetify writes for that directory anyway.
//
// So the source this analysis sees is the source *before* the reset pass ran,
// which also means js/generated-y/ is byte-identical whether or not the sync
// build was built with C2JS_RESET=1. The yieldable build gets its own reset
// blocks from `resetify.mjs --dir js/generated-y`, run after yieldify.
//
// The delimiters and the strip itself live in tools/c2js/reset-census.mjs,
// which is where all three passes that need them can agree on one copy.

/** Hand-written runtime modules transpiled code calls into. Scanned so the
 *  analysis can see whether any of them can itself reach a blocking point. */
export const RUNTIME_MODULES = [
  'js/cptr.js', 'js/cmachine.js', 'js/cjmp.js', 'js/isaac64.js',
  'js/libc/printf.js', 'js/libc/string.js',
];

// ---------------------------------------------------------------------------
// Blocking seeds — where the engine actually stops and waits for a keystroke.
// ---------------------------------------------------------------------------
//
// Established empirically (see docs/NOTES-async-engine.md §Phase 0). The
// engine has exactly ONE leaf: the harness-provided global `getchar()`, which
// js/boot/harness.mjs defines as "shift the input queue, else park until a key
// arrives (interactive) / end the run (replay)". Every other thing that looks
// like it waits -- --More--, menus, getlin, yn_function, getpos, wait_synch,
// tty_display_nhwindow -- reaches the keyboard through that call by way of
// tty_nhgetch, and so is found by reverse reachability rather than seeded.
//
// Confirmed non-blocking despite appearances:
//   tty_delay_output  NETHACK_NO_DELAY=1 takes the fflush branch; the ospeed
//                     busy-loop never runs because harness sets ospeed = 0.
//   g.sleep/g.usleep  no-ops in the harness.
//   g.fgets/g.fgetc/g.getc  read the VFS fd table; __stdinp carries no __fd,
//                     so they return EOF rather than parking.
//   tty_mark_synch    fflush only.
export const BLOCKING_SEEDS = [
  {
    id: 'GLOBAL#getchar',
    why: 'harness g.getchar parks (interactive) / ends the run (replay) on an empty input queue — js/boot/harness.mjs:791',
  },
];

/**
 * Site-level seeds: a call that blocks only in one syntactic context.
 *
 * cptr.read is the ordinary file read used by save/restore and hacklib; it
 * blocks only for fd 0, which the harness routes to g.getchar
 * (harness.mjs:538). Seeding the callee would falsely colour the entire
 * save/restore subsystem, so this is matched at the site.
 */
export const BLOCKING_SITES = [
  {
    name: 'stdin-read',
    match: (mod, call, src) => call.kind === 'ns' && call.ns === 'cptr' && call.name === 'read'
      && /__stdinp/.test(src.slice(call.i, call.i + 200)),
    why: 'tty_nhgetch nested-read path, cptr.read(fileno(__stdinp), ...) — harness routes fd 0 to g.getchar (js/boot/harness.mjs:538)',
  },
];

/** Runtime helpers that call a caller-supplied function back. */
export const RUNTIME_CALLBACKS = new Set(['qsort', 'bsearch', 'postinc', 'postdec', 'preinc', 'predec']);

export const FPTR = 'PSEUDO#fptr';
export const SITEBLOCK = 'PSEUDO#site-block';

/**
 * Build the graph and run the colouring fixpoint.
 *
 * @param {{ fptrMode?: 'any'|'uniform', genDir?: string }} opts
 *   fptrMode 'any'     — a pointer call is coloured iff SOME address-taken
 *                        target is coloured. Minimal colouring, but indirect
 *                        sites then need a runtime dual-dispatch shim, because
 *                        `yield* f(...)` throws when f stayed a plain function.
 *   fptrMode 'uniform' — additionally force every address-taken function to be
 *                        coloured, so every indirect site is unconditionally
 *                        `yield*`-safe with no runtime check. (default)
 */
export function buildGraph({ fptrMode = 'any', genDir = 'js/generated' } = {}) {
  const mods = new Map();
  const modKeyOf = (abs) => path.relative(repoRoot, abs).replace(/\\/g, '/');

  const genAbs = path.join(repoRoot, genDir);
  for (const f of fs.readdirSync(genAbs).filter((x) => x.endsWith('.js')).sort()) {
    // __reset.js is not transpiled C — it is tools/c2js/resetify.mjs's barrel
    // over the directory, hand-written by a generator. It is not part of the
    // program's call graph and must not be rewritten into one: see
    // stripResetBlock below for the whole story.
    if (f === RESET_BARREL) continue;
    const abs = path.join(genAbs, f);
    mods.set(modKeyOf(abs), scanModule(stripResetBlock(fs.readFileSync(abs, 'utf8')),
      { file: modKeyOf(abs) }));
  }
  for (const rel of RUNTIME_MODULES) {
    const abs = path.join(repoRoot, rel);
    if (fs.existsSync(abs)) mods.set(rel, scanModule(fs.readFileSync(abs, 'utf8'), { file: rel }));
  }

  // ---- nodes ----
  const defsByMod = new Map();
  const nodes = new Map();
  for (const [key, scan] of mods) {
    const m = new Map();
    scan.funcs.forEach((f, idx) => {
      const id = `${key}#${f.name}`;
      if (!m.has(f.name)) m.set(f.name, id);
      if (!nodes.has(id)) nodes.set(id, { id, mod: key, name: f.name, exported: f.exported, nested: !!f.nested, funcIdx: idx, def: f });
    });
    defsByMod.set(key, m);
  }

  const resolveImport = (fromMod, spec) => {
    if (!spec || !spec.startsWith('.')) return null;
    return modKeyOf(path.resolve(repoRoot, path.dirname(fromMod), spec));
  };

  function resolveDirect(mod, name) {
    const local = defsByMod.get(mod);
    if (local && local.has(name)) return local.get(name);
    const imp = mods.get(mod).imports.get(name);
    if (imp) {
      const target = resolveImport(mod, imp.module);
      if (target && defsByMod.has(target)) {
        const t = defsByMod.get(target).get(imp.imported);
        if (t) return t;
      }
      return `EXTERN#${imp.imported}`;
    }
    return `GLOBAL#${name}`;
  }

  function resolveNs(mod, ns, name) {
    const spec = mods.get(mod).nsImports.get(ns);
    const target = resolveImport(mod, spec);
    if (target && defsByMod.has(target)) {
      const t = defsByMod.get(target).get(name);
      if (t) return t;
    }
    return `NS#${ns}.${name}`;
  }

  /**
   * Where a call site points. Returns null for sites the graph ignores.
   *
   * A `cptr.qsort(..., cmp)` site is NOT treated as an indirect call even
   * though qsort calls `cmp` back: qsort itself is hand-written and stays a
   * plain function, so the site can never be `yield*`ed. The hazard it does
   * create — a coloured comparator handed to a plain-function caller — is
   * caught separately as `runtimeCallbackTargets` and handled by the transform
   * with a drive-to-completion wrapper.
   */
  function targetOf(mod, call) {
    if (call.kind === 'direct') return resolveDirect(mod, call.name);
    if (call.kind === 'ns') return resolveNs(mod, call.ns, call.name);
    if (call.kind === 'indirect') return FPTR;
    return null; // 'member': obj.method() on a JS object, never engine code
  }

  // ---- address-taken functions ----
  const addressTaken = new Set();
  for (const [key, scan] of mods) {
    const toks = scan.tokens;
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t.t !== 'id') continue;
      if (toks[k + 1]?.t === 'punc' && toks[k + 1].v === '(') continue;   // a call
      if (toks[k - 1]?.t === 'punc' && toks[k - 1].v === '.') continue;   // a member name
      if (toks[k - 1]?.t === 'id' && toks[k - 1].v === 'function') continue; // the definition
      if (inImportClause(scan, k)) continue;
      const node = resolveDirect(key, t.v);
      if (nodes.has(node)) addressTaken.add(node);
    }
  }

  // Address-taken functions handed to a HAND-WRITTEN runtime helper that calls
  // them directly (cptr.qsort's comparator). Those must NOT be forced into
  // generators: cptr.js would get a generator object back instead of an int.
  const runtimeCallbackTargets = new Set();
  for (const [key, scan] of mods) {
    for (const c of scan.calls) {
      if (c.kind !== 'ns' || !RUNTIME_CALLBACKS.has(c.name)) continue;
      if (!mods.has(resolveImport(key, scan.nsImports.get(c.ns)) || '')) continue;
      // scan the argument list for bare function references
      const end = matchParen(scan.tokens, c.tokIdx);
      for (let k = c.tokIdx + 1; k < end; k++) {
        const t = scan.tokens[k];
        if (t.t !== 'id') continue;
        if (scan.tokens[k + 1]?.v === '(') continue;
        if (scan.tokens[k - 1]?.v === '.') continue;
        const node = resolveDirect(key, t.v);
        if (nodes.has(node)) runtimeCallbackTargets.add(node);
      }
    }
  }

  // ---- edges ----
  const callers = new Map();
  const addEdge = (from, to) => {
    if (!callers.has(to)) callers.set(to, new Set());
    callers.get(to).add(from);
  };

  const siteSeedHits = [];
  let totalSites = 0;
  let indirectSiteCount = 0;
  const unresolvedGlobals = new Map();

  // Hand-written runtime modules (js/cptr.js et al.) are scanned so that names
  // RESOLVE through them, but they contribute no edges: they are not part of
  // the rewrite, so they stay plain functions no matter what they call. Where
  // one of them calls back into transpiled code — js/cptr.js's qsort invoking
  // its `compar` argument — the transform hands it a Y.drive-wrapped plain
  // function instead, and Y.drive throws if that callee ever tries to park.
  // Those sites are collected here so the report can name them rather than
  // leave the exception to be discovered at runtime.
  const runtimeCallbackSites = [];
  for (const [key, scan] of mods) {
    const isGenerated = key.startsWith('js/generated');
    if (!isGenerated) {
      for (const c of scan.calls) {
        if (c.kind === 'indirect') runtimeCallbackSites.push({ mod: key, at: c.i, via: c.viaVar || '(expr)', inFunc: c.inFunc });
      }
      continue;
    }
    for (const c of scan.calls) {
      const from = c.inFunc ? (defsByMod.get(key).get(c.inFunc) || `${key}#${c.inFunc}`) : `${key}#<toplevel>`;
      for (const s of BLOCKING_SITES) {
        if (s.match(key, c, scan.src)) { addEdge(from, SITEBLOCK); siteSeedHits.push({ mod: key, from, at: c.i, why: s.why, name: s.name }); }
      }
      // qsort/bsearch reach their comparator: model the edge so a blocking
      // comparator would still colour its caller, but do not colour the site.
      if (c.kind === 'ns' && RUNTIME_CALLBACKS.has(c.name)) addEdge(from, FPTR);
      const to = targetOf(key, c);
      if (!to) continue;
      if (to.startsWith('GLOBAL#')) unresolvedGlobals.set(c.name, (unresolvedGlobals.get(c.name) || 0) + 1);
      if (to === FPTR) indirectSiteCount++;
      addEdge(from, to);
      totalSites++;
    }
  }
  for (const t of addressTaken) addEdge(FPTR, t);

  // ---- colour ----
  const seedNodes = BLOCKING_SEEDS.map((s) => s.id);
  if (siteSeedHits.length) seedNodes.push(SITEBLOCK);
  const forced = new Set();
  if (fptrMode === 'uniform') {
    for (const t of addressTaken) {
      if (runtimeCallbackTargets.has(t)) continue; // called by hand-written runtime
      forced.add(t);
      seedNodes.push(t);
    }
  }

  const colored = new Set();
  const colorFrom = new Map();
  {
    const queue = [...seedNodes];
    for (const s of seedNodes) { colored.add(s); colorFrom.set(s, null); }
    while (queue.length) {
      const cur = queue.pop();
      for (const c of callers.get(cur) || []) {
        if (colored.has(c)) continue;
        colored.add(c);
        colorFrom.set(c, cur);
        queue.push(c);
      }
    }
  }

  /** Is this call site coloured — i.e. must it be emitted as `yield*`? */
  function siteIsColored(mod, call, src) {
    for (const s of BLOCKING_SITES) if (s.match(mod, call, src)) return true;
    const to = targetOf(mod, call);
    return to ? colored.has(to) : false;
  }

  return {
    mods, nodes, defsByMod, colored, colorFrom, addressTaken, forced,
    runtimeCallbackTargets, runtimeCallbackSites, siteSeedHits, totalSites, indirectSiteCount,
    unresolvedGlobals, targetOf, siteIsColored, resolveDirect, resolveNs,
    fptrMode,
    /** the set of coloured function definitions (real functions, not pseudo-nodes) */
    coloredFuncs: [...colored].filter((n) => nodes.has(n)),
    isColoredFunc: (mod, name) => colored.has(`${mod}#${name}`),
  };
}

function inImportClause(scan, k) {
  for (let m = k; m >= 0 && m > k - 400; m--) {
    const tk = scan.tokens[m];
    const v = tk.t === 'id' ? tk.v : null;
    if (v === 'from') return false;
    if (v === 'import' || v === 'export') return scan.tokens[m + 1]?.v === '{' || scan.tokens[m + 1]?.v === '*';
    if (tk.t === 'punc' && tk.v === ';') return false;
  }
  return false;
}

/** index of the `)` matching the `(` at tokens[k] */
export function matchParen(tokens, k) {
  let d = 0;
  for (let m = k; m < tokens.length; m++) {
    const v = tokens[m].t === 'punc' ? tokens[m].v : null;
    if (v === '(') d++;
    else if (v === ')') { d--; if (d === 0) return m; }
  }
  return tokens.length - 1;
}
