// symbols.mjs — cross-file symbol table for the c2js batch build.
//
// From the cached ASTs (.cache/c2js/ast/*.ast.json), collect every main-file
// definition of functions and file-scope variables, so generated modules can
// import from each other: foo.c calling bar() defined in baz.c produces
// `import { bar } from './baz.js'` in foo.js.
//
// Only non-static definitions are importable. Names defined in more than one
// file (or shadowed locally) are recorded as conflicts and never imported.

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
  const anonById = new Map(); // anonymous RecordDecl id -> { tag, fields }
  const typedefOwned = new Map(); // typedef name -> anonymous RecordDecl id
  const typedefAlias = new Map(); // typedef name -> named record name
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.kind === 'EnumDecl' && n.completeDefinition) {
      const rec = { tag: 'enum', fields: [] };
      if (n.name) { if (!recordDefs.has(n.name)) recordDefs.set(n.name, rec); }
      else anonById.set(n.id, rec);
    }
    if (n.kind === 'RecordDecl' && n.completeDefinition) {
      const fields = (n.inner || []).filter((c) => c.kind === 'FieldDecl')
        .map((c) => ({ name: c.name, q: (c.type?.desugaredQualType || c.type?.qualType || '') }));
      if (fields.length) {
        if (n.name) { if (!recordDefs.has(n.name)) recordDefs.set(n.name, { tag: n.tagUsed || 'struct', fields }); }
        else anonById.set(n.id, { tag: n.tagUsed || 'struct', fields });
      }
    }
    if (n.kind === 'TypedefDecl' && n.name) {
      const owned = n.inner?.[0]?.ownedTagDecl?.id; // typedef union {...} Name;
      if (owned) typedefOwned.set(n.name, owned);
      // also plain aliases (typedef struct x Name;) — present even when ownedTagDecl exists
      const m = (n.type?.qualType || '').match(/^(?:struct|union) (\w+)$/);
      if (m) typedefAlias.set(n.name, m[1]);
      // enum typedefs (typedef enum {...} Name;) — enums are int-sized for layout
      if (/^enum \w+$/.test(n.type?.qualType || '') || n.inner?.[0]?.ownedTagDecl?.kind === 'EnumDecl') {
        recordDefs.set(n.name, { tag: 'enum', fields: [] });
      }
    }
    for (const c of n.inner || []) walk(c);
  })(root);
  for (const [name, id] of typedefOwned) if (anonById.has(id)) recordDefs.set(name, anonById.get(id));
  for (const [name, recName] of typedefAlias) if (recordDefs.has(recName)) recordDefs.set(name, recordDefs.get(recName));
  return { ...target, decls, lineOf, defs, recordDefs };
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
