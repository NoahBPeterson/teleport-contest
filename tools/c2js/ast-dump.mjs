#!/usr/bin/env node
// ast-dump.mjs — dump clang JSON AST for a single C file into .cache/c2js/ast/
//
// Usage: node tools/c2js/ast-dump.mjs <path-to-c-file>
//
// Writes .cache/c2js/ast/<name>.ast.json (streamed, not buffered in memory).
// Skips the dump if the cache file is newer than the source file.
// On failure writes .cache/c2js/ast/<name>.err.log and exits non-zero.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const NETHACK_SRC = path.join(repoRoot, 'nethack-c/recorder/src');
export const LUA_SRC = path.join(repoRoot, 'nethack-c/recorder/lib/lua-5.4.8/src');
export const FIXTURE_SRC = path.join(repoRoot, 'tools/c2js/fixtures');
export const AST_DIR = path.join(repoRoot, '.cache/c2js/ast');

// Flags taken from sys/unix/hints/macosx-minimal and the Lua build (SYSCFLAGS).
const NETHACK_FLAGS = ['-I../include', '-DNOTPARMDECL', '-DNO_TIMED_DELAY'];
const LUA_FLAGS = ['-DLUA_USE_MACOSX', '-I.'];
const FIXTURE_FLAGS = []; // standalone fixtures: system headers only

export function isLuaFile(absFile) {
  return path.resolve(absFile).startsWith(LUA_SRC + path.sep);
}

export function isFixtureFile(absFile) {
  return path.resolve(absFile).startsWith(FIXTURE_SRC + path.sep);
}

export function astPathFor(absFile) {
  const name = path.basename(absFile).replace(/\.c$/, '');
  return path.join(AST_DIR, `${name}.ast.json`);
}

export function compileCwdFor(absFile) {
  if (isLuaFile(absFile)) return LUA_SRC;
  if (isFixtureFile(absFile)) return FIXTURE_SRC;
  return NETHACK_SRC;
}

function flagsFor(absFile) {
  if (isLuaFile(absFile)) return LUA_FLAGS;
  if (isFixtureFile(absFile)) return FIXTURE_FLAGS;
  return NETHACK_FLAGS;
}

/**
 * Dump the AST for `file` (any path; resolved to absolute).
 * Returns { astPath, skipped, stderr } on success; throws on clang failure.
 */
export function dumpAst(file, { force = false } = {}) {
  const abs = path.resolve(file);
  const name = path.basename(abs).replace(/\.c$/, '');
  const outPath = astPathFor(abs);
  const errPath = path.join(AST_DIR, `${name}.err.log`);
  fs.mkdirSync(AST_DIR, { recursive: true });

  // Sidecar records the absolute source path this AST was dumped from. A
  // worktree checkout running a gate suite dumps its OWN path into the shared
  // cache; when that worktree is later deleted, ir.mjs's realpath
  // canonicalization can no longer map the dead path back and build.mjs
  // silently emits empty modules (this has bitten three times). A path
  // mismatch therefore forces a re-dump from the current checkout. ASTs
  // predating the sidecar are accepted as-is (grandfathered) to avoid a
  // full 7 GB re-dump of the healthy TU cache.
  const srcPath = outPath + '.src';
  const sidecarOk = !fs.existsSync(srcPath) || fs.readFileSync(srcPath, 'utf8').trim() === abs;
  if (!force && sidecarOk && fs.existsSync(outPath) && fs.statSync(outPath).mtimeMs >= fs.statSync(abs).mtimeMs) {
    return Promise.resolve({ astPath: outPath, skipped: true, stderr: '' });
  }

  const cwd = compileCwdFor(abs);
  const flags = flagsFor(abs);
  const args = ['-Xclang', '-ast-dump=json', '-fsyntax-only', ...flags, abs];

  return new Promise((resolve, reject) => {
    const tmpPath = outPath + '.tmp';
    const out = fs.createWriteStream(tmpPath);
    const child = spawn('clang', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.pipe(out);
    child.on('error', (err) => { out.destroy(); fs.rmSync(tmpPath, { force: true }); reject(err); });
    child.on('close', (code) => {
      out.close(() => {
        if (code === 0) {
          fs.renameSync(tmpPath, outPath);
          fs.writeFileSync(srcPath, abs + '\n');
          fs.rmSync(errPath, { force: true });
          resolve({ astPath: outPath, skipped: false, stderr });
        } else {
          fs.rmSync(tmpPath, { force: true });
          fs.writeFileSync(errPath, stderr || `clang exited with code ${code}\n`);
          reject(new Error(`clang failed for ${abs} (code ${code}); see ${errPath}`));
        }
      });
    });
  });
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node tools/c2js/ast-dump.mjs <path-to-c-file>');
    process.exit(2);
  }
  dumpAst(file, { force: process.argv.includes('--force') })
    .then(({ astPath, skipped }) => {
      console.log(`${skipped ? 'cached ' : 'dumped '} ${astPath}`);
    })
    .catch((err) => {
      console.error(String(err.message || err));
      process.exit(1);
    });
}
