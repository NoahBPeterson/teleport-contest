// symbols.mjs — cross-file symbol table for the c2js batch build.
//
// From the cached ASTs (.cache/c2js/ast/*.ast.json), collect every main-file
// definition of functions and file-scope variables, so generated modules can
// import from each other: foo.c calling bar() defined in baz.c produces
// `import { bar } from './baz.js'` in foo.js.
//
// Only non-static definitions are importable. Names defined in more than one
// file (or shadowed locally) are recorded as conflicts and never imported.
//
// Slim IR cache: collectFile's output is large-AST-derived but small; it is
// cached per source file in .cache/c2js/ir/<name>.ir.json, keyed by the mtime
// of the full AST dump. Batch runs load slim IRs and rebuild only stale ones.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAst, mainFileDecls } from './ir.mjs';
import { astPathFor, compileCwdFor, NETHACK_SRC, LUA_SRC } from './ast-dump.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP_LUA = new Set(['lua.c', 'luac.c', 'onelua.c']);

export function listTargets() {
  const files = [];
  for (const f of fs.readdirSync(NETHACK_SRC).filter((f) => f.endsWith('.c')).sort()) {
    files.push({ name: f.replace(/\.c$/, ''), file: path.join(NETHACK_SRC, f), group: 'nethack' });
  }
  for (const f of fs.readdirSync(LUA_SRC).filter((f) => f.endsWith('.c') && !SKIP_LUA.has(f)).sort()) {
    files.push({ name: f.replace(/\.c$/, ''), file: path.join(LUA_SRC, f), group: 'lua' });
  }
  return files;
}

/**
 * Parse one cached AST and return its main-file decls plus its global
 * definitions. The parsed JSON is dropped (memory: these are 30MB+ each).
 * Also collects EVERY complete RecordDecl in the translation unit (headers
 * included): struct layout needs header-defined types like struct obj.
 */
export function collectFile(target) {
  const root = loadAst(astPathFor(target.file));
  const { decls, lineOf } = mainFileDecls(root, target.file, compileCwdFor(target.file));
  const defs = [];
  for (const d of decls) {
    if (d.kind === 'FunctionDecl') {
      const hasBody = (d.inner || []).some((c) => c && c.kind === 'CompoundStmt');
      if (hasBody && d.name) defs.push({ name: d.name, kind: 'function', isStatic: d.storageClass === 'static' });
    } else if (d.kind === 'VarDecl') {
      if (d.storageClass !== 'extern' && d.name) defs.push({ name: d.name, kind: 'variable', isStatic: d.storageClass === 'static' });
    } else if (d.kind === 'EnumDecl') {
      for (const c of (d.inner || []).filter((x) => x && x.kind === 'EnumConstantDecl')) {
        if (c.name) defs.push({ name: c.name, kind: 'enumconst', isStatic: true }); // enum consts are file-local in our emission
      }
    }
  }
  const recordDefs = new Map(); // name -> { tag, fields } (first complete definition wins)
  const addressTaken = new Set(); // globals whose address is taken somewhere in the program
  (function wAddrs(n) {
    if (!n || typeof n !== 'object') return;
    if (n.kind === 'UnaryOperator' && n.opcode === '&' && n.inner?.[0]?.kind === 'DeclRefExpr') {
      const q = (n.inner[0].type?.desugaredQualType || n.inner[0].type?.qualType || '');
      const nm = n.inner[0].name || n.inner[0].referencedDecl?.name;
      if (nm && !/\[/.test(q) && !/\(/.test(q) && !/^(struct|union)\b[^*]*$/.test(q.trim())) addressTaken.add(nm);
    }
    for (const c of n.inner || []) wAddrs(c);
  })(root);
  const anonById = new Map(); // anonymous RecordDecl id -> { tag, fields }
  const anonByLoc = new Map(); // "line:col" -> anon record (unnamed-at recovery)
  const typedefOwned = new Map(); // typedef name -> anonymous RecordDecl id
  const typedefAlias = new Map(); // typedef name -> named record name
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.kind === 'EnumDecl') {
      const rec = { tag: 'enum', fields: [] };
      if (n.name) { if (!recordDefs.has(n.name)) recordDefs.set(n.name, rec); }
      else if (n.completeDefinition) anonById.set(n.id, rec);
    }
    if (n.kind === 'RecordDecl' && n.completeDefinition) {
      // fields of anonymous record type link to the anonymous RecordDecl
      // that directly precedes them among this record's children
      const fields = [];
      let lastAnon = null;
      for (const c of n.inner || []) {
        if (c.kind === 'RecordDecl' && !c.name) { lastAnon = c; continue; }
        if (c.kind !== 'FieldDecl') continue;
        let recId;
        (function deep(x) {
          if (!x || typeof x !== 'object' || recId) return;
          if ((x.kind === 'RecordType' || x.kind === 'ElaboratedType') && x.decl?.kind === 'RecordDecl') { recId = x.decl.id; return; }
          for (const cc of x.inner || []) deep(cc);
        })(c);
        if (!recId && lastAnon && /unnamed|anonymous/.test(c.type?.qualType || '')) recId = lastAnon.id;
        fields.push({ name: c.name, q: (c.type?.desugaredQualType || c.type?.qualType || ''), recId });
      }
      if (fields.length) {
        if (n.name) { if (!recordDefs.has(n.name)) recordDefs.set(n.name, { tag: n.tagUsed || 'struct', fields }); }
        else {
          anonById.set(n.id, { tag: n.tagUsed || 'struct', fields });
          const l = n.loc?.line !== undefined ? `${n.loc.line}:${n.loc.col}` : n.range?.begin?.line !== undefined ? `${n.range.begin.line}:${n.range.begin.col}` : null;
          if (l) { if (anonByLoc.has(l)) anonByLoc.delete(l); else anonByLoc.set(l, anonById.get(n.id)); }
        }
      }
    }
    if (n.kind === 'TypedefDecl' && n.name) {
      const owned = n.inner?.[0]?.ownedTagDecl?.id; // typedef union {...} Name;
      if (owned) typedefOwned.set(n.name, owned);
      // also plain aliases (typedef struct x Name; / typedef x Name;)
      const m = (n.type?.qualType || '').match(/^(?:struct|union) (\w+)$/);
      if (m) typedefAlias.set(n.name, m[1]);
      else if (/^\w+$/.test(n.type?.qualType || '')) typedefAlias.set(n.name, n.type.qualType);
      // enum typedefs (typedef enum {...} Name;) — enums are int-sized for layout
      if (/^enum \w+$/.test(n.type?.qualType || '') || n.inner?.[0]?.ownedTagDecl?.kind === 'EnumDecl') {
        recordDefs.set(n.name, { tag: 'enum', fields: [] });
      }
    }
    for (const c of n.inner || []) walk(c);
  })(root);
  for (const [name, id] of typedefOwned) if (anonById.has(id)) recordDefs.set(name, anonById.get(id));
  for (const [name, recName] of typedefAlias) {
    // chase alias chains (typedef x A; typedef A B;)
    let target = recName, depth = 0;
    while (!recordDefs.has(target) && typedefAlias.has(target) && depth++ < 8) target = typedefAlias.get(target);
    if (recordDefs.has(target)) recordDefs.set(name, recordDefs.get(target));
  }
  // anonymous nested records are addressable by id (field recId linkage)
  for (const [id, rec] of anonById) recordDefs.set(`anon#${id}`, rec);
  return { ...target, decls, lineOf, defs, recordDefs, anonByLoc, addressTaken };
}

/**
 * Map name -> { file } for names defined (non-static) in exactly one file.
 * Conflicts land in `conflicts` (name -> [files]).
 */
export function buildSymbolMap(perFile) {
  const sites = new Map(); // name -> [{file}]
  for (const pf of perFile) {
    for (const def of pf.defs) {
      if (def.isStatic) continue;
      if (!sites.has(def.name)) sites.set(def.name, []);
      sites.get(def.name).push({ file: pf.name, kind: def.kind });
    }
  }
  const symbols = new Map();
  const conflicts = new Map();
  for (const [name, files] of sites) {
    if (files.length === 1) symbols.set(name, { file: files[0].file, kind: files[0].kind });
    else conflicts.set(name, files.map((f) => f.file));
  }
  return { symbols, conflicts };
}

// ---- slim IR cache ----

const IR_DIR = path.join(repoRoot, '.cache/c2js/ir');

export function slimIrPath(target) {
  return path.join(IR_DIR, `${target.name}.ir.json`);
}

/**
 * Load a target's slim IR, (re)building it from the full AST when missing or
 * stale (AST dump newer than the IR). Returns the collectFile() shape:
 * { name, file, group, decls, defs, recordDefs, anonByLoc, lineStarts } —
 * with lineOf(offset) reconstructed from lineStarts.
 */
const SYMBOLS_MTIME = fs.statSync(fileURLToPath(import.meta.url)).mtimeMs;

export function loadSlimIr(target) {
  const irPath = slimIrPath(target);
  const astPath = astPathFor(target.file);
  if (!fs.existsSync(astPath)) throw new Error(`no cached AST: ${astPath}`);
  const astMtime = Math.max(fs.statSync(astPath).mtimeMs, SYMBOLS_MTIME);
  if (fs.existsSync(irPath) && fs.statSync(irPath).mtimeMs >= astMtime) {
    const ir = JSON.parse(fs.readFileSync(irPath, 'utf8'));
    return { ...target, ...ir, lineOf: (o) => lineOfStarts(ir.lineStarts, o) };
  }
  const pf = collectFile(target);
  fs.mkdirSync(IR_DIR, { recursive: true });
  const src = fs.readFileSync(target.file, 'utf8');
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const ir = { decls: pf.decls, defs: pf.defs, recordDefs: [...pf.recordDefs], anonByLoc: [...pf.anonByLoc], addressTaken: [...pf.addressTaken], lineStarts };
  const tmp = irPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ir));
  fs.renameSync(tmp, irPath);
  return { ...target, ...pf, lineStarts, lineOf: (o) => lineOfStarts(lineStarts, o) };
}

function lineOfStarts(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/** recordDefs/anonByLoc round-trip as [key, value] pairs; rebuild Maps */
export function irMaps(pf) {
  return {
    recordDefs: pf.recordDefs instanceof Map ? pf.recordDefs : new Map(pf.recordDefs),
    anonByLoc: pf.anonByLoc instanceof Map ? pf.anonByLoc : new Map(pf.anonByLoc),
  };
}
