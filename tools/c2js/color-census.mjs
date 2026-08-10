#!/usr/bin/env node
// color-census.mjs — Phase 0 of the yieldable-engine study.
//
// Reports the COLOURED set: every function in the transpiled engine that can
// transitively reach a point where the engine blocks waiting for a keystroke.
// A coloured function must become a generator (`function*`) in a yieldable
// build, and every call to it must become `yield*`.
//
// Two numbers matter and they are very different:
//   - coloured FUNCTION count   how much of the engine changes shape
//   - coloured CALL SITE count  the per-move overhead multiplier — each one is
//                               a generator allocation plus a delegation step
//
// Usage:
//   node tools/c2js/color-census.mjs
//   node tools/c2js/color-census.mjs --fptr=any|uniform
//   node tools/c2js/color-census.mjs --json .cache/c2js/color-census.json
//   node tools/c2js/color-census.mjs --why FUNC   # shortest path to a seed

import fs from 'node:fs';
import path from 'node:path';
import { buildGraph, BLOCKING_SEEDS, repoRoot, RUNTIME_MODULES } from './callgraph.mjs';

const args = process.argv.slice(2);
const argVal = (flag) => {
  const i = args.findIndex((a) => a === flag || a.startsWith(flag + '='));
  if (i < 0) return null;
  return args[i].includes('=') ? args[i].split('=').slice(1).join('=') : (args[i + 1] ?? null);
};

const jsonOut = argVal('--json');
const whyFunc = argVal('--why');
const fptrMode = argVal('--fptr') || 'any';

const G = buildGraph({ fptrMode });
const { mods, nodes, colored, colorFrom, addressTaken, forced, runtimeCallbackTargets,
  siteSeedHits, totalSites, indirectSiteCount, unresolvedGlobals, coloredFuncs } = G;

const coloredSet = new Set(coloredFuncs);

// ---- coloured call sites, per module ----
let coloredSiteTotal = 0;
let coloredDirect = 0;
let coloredIndirect = 0;
const coloredSitesByMod = new Map();
const arrowHazards = [];

for (const [key, scan] of mods) {
  // Only js/generated/ is rewritten. The hand-written runtime is shared
  // between the two builds unchanged, so its sites are not "coloured" in any
  // sense that costs anything — they are reported separately below.
  if (!key.startsWith('js/generated')) continue;
  for (const c of scan.calls) {
    if (c.kind === 'member') continue;
    if (!G.siteIsColored(key, c, scan.src)) continue;
    coloredSiteTotal++;
    if (c.kind === 'indirect') coloredIndirect++; else coloredDirect++;
    coloredSitesByMod.set(key, (coloredSitesByMod.get(key) || 0) + 1);
    if (c.inArrow) arrowHazards.push({ mod: key, at: c.i, name: c.name, kind: c.kind });
  }
}

const allFuncs = [...nodes.keys()];
const genFuncs = allFuncs.filter((n) => nodes.get(n).mod.startsWith('js/generated'));
const genColored = coloredFuncs.filter((n) => nodes.get(n).mod.startsWith('js/generated'));
const runtimeColored = coloredFuncs.filter((n) => !nodes.get(n).mod.startsWith('js/generated'));

const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : 'n/a');

const perMod = [];
for (const [key, scan] of mods) {
  perMod.push({
    mod: key,
    total: scan.funcs.length,
    colored: scan.funcs.filter((f) => coloredSet.has(`${key}#${f.name}`)).length,
    sites: scan.calls.filter((c) => c.kind !== 'member').length,
    coloredSites: coloredSitesByMod.get(key) || 0,
  });
}
perMod.sort((a, b) => b.coloredSites - a.coloredSites || b.colored - a.colored);

const lines = [];
const out = (s = '') => { lines.push(s); console.log(s); };

out('=== c2js colouring census — which functions must become generators ===');
out('');
out(`fn-pointer mode            : ${fptrMode}`);
out(`modules scanned            : ${mods.size} (${mods.size - RUNTIME_MODULES.filter((r) => mods.has(r)).length} generated + ${RUNTIME_MODULES.filter((r) => mods.has(r)).length} hand-written runtime)`);
out(`function definitions       : ${allFuncs.length}  (${genFuncs.length} in js/generated)`);
out(`call sites (engine-visible): ${totalSites}`);
out(`  direct                   : ${totalSites - indirectSiteCount}`);
out(`  through function pointers: ${indirectSiteCount}`);
out(`address-taken functions    : ${addressTaken.size}   (forced to generators: ${forced.size}; excluded as hand-written-runtime callbacks: ${runtimeCallbackTargets.size})`);
out('');
out('--- seeds (the only places the engine blocks) ---');
for (const s of BLOCKING_SEEDS) out(`  ${s.id.padEnd(22)} direct callers=${(G.colorFrom, [...mods].reduce((n, [k, sc]) => n + sc.calls.filter((c) => c.kind === 'direct' && G.resolveDirect(k, c.name) === s.id).length, 0))}  ${s.why}`);
for (const h of siteSeedHits) out(`  site ${h.from} @${h.at}\n       ${h.why}`);
out('');
out('--- RESULT ---');
out(`COLOURED functions   : ${coloredFuncs.length} / ${allFuncs.length}   (${pct(coloredFuncs.length, allFuncs.length)})`);
out(`  in js/generated    : ${genColored.length} / ${genFuncs.length}   (${pct(genColored.length, genFuncs.length)})`);
out(`  hand-written rt    : ${runtimeColored.length}   ${runtimeColored.length ? '(!! the runtime would need a generator variant)' : '(none — js/cptr.js, js/cmachine.js, js/cjmp.js etc. stay untouched)'}`);
out(`COLOURED call sites  : ${coloredSiteTotal} / ${totalSites}   (${pct(coloredSiteTotal, totalSites)})`);
out(`  direct             : ${coloredDirect}`);
out(`  via function ptr   : ${coloredIndirect}`);
out(`coloured sites inside arrow closures (would make the transform invalid): ${arrowHazards.length}`);
out(`hand-written runtime call-backs into transpiled code (answered by Y.drive): ${G.runtimeCallbackSites.length}`);
out('');

out('--- per-module (top 40 by coloured call sites) ---');
out('module'.padEnd(30) + 'funcs'.padStart(7) + 'col'.padStart(7) + 'col%'.padStart(8) + 'sites'.padStart(9) + 'colSites'.padStart(10) + 'colSite%'.padStart(10));
for (const m of perMod.slice(0, 40)) {
  out(m.mod.replace(/^js\/generated\//, '').padEnd(30)
    + String(m.total).padStart(7) + String(m.colored).padStart(7)
    + pct(m.colored, m.total).padStart(8)
    + String(m.sites).padStart(9) + String(m.coloredSites).padStart(10)
    + pct(m.coloredSites, m.sites).padStart(10));
}
out('');

// hot-path verdict — is the per-move inner loop coloured?
const HOT = [
  ['rng', ['rn2', 'rnd', 'rn1', 'rnl', 'rne', 'rnz', 'rn2_on_display_rng']],
  ['display', ['newsym', 'show_glyph', 'docrt', 'flush_screen', 'map_location', 'back_to_glyph']],
  ['vision', ['vision_recalc', 'view_from', 'clear_path', 'do_clear_area']],
  ['monmove', ['movemon', 'dochug', 'm_move', 'dochugw', 'mon_regen']],
  ['mainloop', ['moveloop', 'moveloop_core', 'domove', 'domove_core', 'test_move', 'rhack', 'parse']],
  ['output', ['pline', 'vpline', 'putmesg', 'tty_putstr', 'update_topl', 'more', 'tty_nhgetch']],
  ['util', ['dist2', 'sgn', 'mungspaces', 'eos', 'strstri', 'index']],
];
out('--- hot-path verdict (is the per-move inner loop coloured?) ---');
for (const [label, names] of HOT) {
  const v = names.map((nm) => {
    const hits = allFuncs.filter((n) => nodes.get(n).name === nm);
    if (!hits.length) return `${nm}=n/a`;
    return `${nm}=${hits.some((h) => coloredSet.has(h)) ? 'COLOURED' : 'clean'}`;
  });
  out(`  ${label.padEnd(9)} ${v.join('  ')}`);
}
out('');

if (arrowHazards.length) {
  out('--- ARROW HAZARDS (must be resolved before the transform is sound) ---');
  for (const h of arrowHazards.slice(0, 20)) out(`  ${h.mod} @${h.at} ${h.kind} ${h.name || ''}`);
  out('');
}

const topUnresolved = [...unresolvedGlobals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
out('--- top unresolved globals (harness/libc shims; only `getchar` is a seed) ---');
out('  ' + topUnresolved.map(([k, v]) => `${k}(${v})`).join(' '));
out('');

if (whyFunc) {
  for (const h of allFuncs.filter((n) => nodes.get(n).name === whyFunc)) {
    if (!coloredSet.has(h)) { out(`why ${h}: NOT coloured`); continue; }
    const chain = [];
    let cur = h;
    while (cur) { chain.push(cur); cur = colorFrom.get(cur); }
    out(`why ${h} is coloured (shortest path found by the fixpoint):`);
    out('    ' + chain.join('\n      -> '));
  }
  out('');
}

if (jsonOut) {
  const payload = {
    generatedAt: new Date().toISOString(),
    fptrMode,
    seeds: BLOCKING_SEEDS.map((s) => ({ id: s.id, why: s.why })),
    siteSeeds: siteSeedHits,
    totals: {
      modules: mods.size,
      functions: allFuncs.length,
      generatedFunctions: genFuncs.length,
      callSites: totalSites,
      indirectSites: indirectSiteCount,
      addressTaken: addressTaken.size,
      forcedGenerators: forced.size,
      runtimeCallbackTargets: runtimeCallbackTargets.size,
      coloredFunctions: coloredFuncs.length,
      coloredGeneratedFunctions: genColored.length,
      coloredRuntimeFunctions: runtimeColored.length,
      coloredSites: coloredSiteTotal,
      coloredDirectSites: coloredDirect,
      coloredIndirectSites: coloredIndirect,
      arrowHazards: arrowHazards.length,
    },
    colored: Object.fromEntries(
      [...mods.keys()]
        .map((k) => [k, mods.get(k).funcs.filter((f) => coloredSet.has(`${k}#${f.name}`)).map((f) => f.name).sort()])
        .filter(([, v]) => v.length),
    ),
    perModule: perMod,
  };
  fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
  fs.writeFileSync(path.resolve(jsonOut), JSON.stringify(payload, null, 1));
  console.log(`wrote ${jsonOut}`);
}
