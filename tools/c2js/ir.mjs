// ir.mjs — shared IR for the c2js transpiler: load cached clang JSON ASTs,
// filter to main-file declarations, expose a small cursor API.
//
// Main-file filtering rule (mirrors clang's JSONNodeDumper state machine,
// clang/lib/AST/JSONNodeDumper.cpp writeBareSourceLocation):
//   - clang tracks LastLocFilename across every location it prints, in dump
//     order (node.loc, then range.begin, then range.end, then inner children;
//     macro locations print spellingLoc then expansionLoc).
//   - A location object only carries "file" when the buffer name changed vs.
//     the previously printed location; otherwise it inherits that state.
//   - "includedFrom" marks locations inside #included files and never appears
//     for the main file. Macro locations are split into spellingLoc /
//     expansionLoc; we resolve a node's file through the expansionLoc side
//     (where the code lands in the translation unit), falling back to the
//     bare location.
//   - A node is a main-file node iff its effective location (node.loc, else
//     range.begin) resolves to the main file path AND has no includedFrom.

import fs from 'node:fs';
import path from 'node:path';

// ---------- clang location state machine ----------

export function makeLocationTracker(compileCwd, mainFileAbs) {
  let lastFile; // mirrors LastLocFilename (initially empty string in clang)
  function trackBare(l) {
    if (!l || l.offset === undefined) return null;
    if (l.file) lastFile = path.isAbsolute(l.file) ? l.file : path.resolve(compileCwd, l.file);
    return { file: lastFile, offset: l.offset, included: !!l.includedFrom };
  }
  function track(l) {
    if (!l) return null;
    if (l.spellingLoc || l.expansionLoc) {
      trackBare(l.spellingLoc);
      const e = trackBare(l.expansionLoc);
      return e || trackBare(l.spellingLoc);
    }
    return trackBare(l);
  }
  return {
    // process all locations of a node in clang's print order; returns the
    // node's effective location (loc preferred, else range.begin)
    processNode(n) {
      const locEff = track(n.loc);
      const beginEff = n.range ? track(n.range.begin) : null;
      if (n.range) track(n.range.end);
      return locEff || beginEff;
    },
    isMain(eff) {
      return !!eff && eff.file === mainFileAbs && !eff.included;
    },
  };
}

// ---------- source line mapping ----------

export function lineIndexFor(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function lineOf(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// ---------- AST loading + main-file decl extraction ----------

export function loadAst(astPath) {
  return JSON.parse(fs.readFileSync(astPath, 'utf8'));
}

/**
 * Walk the whole AST (driving clang's location state machine so inherited
 * files resolve correctly) and collect the TranslationUnitDecl's direct
 * children whose effective location is in the main file.
 *
 * Returns {
 *   decls,        // main-file top-level decls, in source order
 *   lineOf,       // byte offset -> 1-based line in the main file
 *   source,       // main file text
 *   mainFileAbs,
 * }.
 */
export function mainFileDecls(root, mainFileAbs, compileCwd) {
  mainFileAbs = path.resolve(mainFileAbs);
  const tracker = makeLocationTracker(compileCwd, mainFileAbs);
  const source = fs.readFileSync(mainFileAbs, 'utf8');
  const starts = lineIndexFor(source);
  const decls = [];

  (function walk(n, parent) {
    if (!n || typeof n !== 'object') return;
    const eff = tracker.processNode(n);
    if (parent && parent.kind === 'TranslationUnitDecl' && n.kind && tracker.isMain(eff)) {
      decls.push(n);
    }
    for (const c of n.inner || []) walk(c, n);
  })(root, null);

  return { decls, lineOf: (o) => lineOf(starts, o), source, mainFileAbs };
}
