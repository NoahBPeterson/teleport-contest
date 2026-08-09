// /shim/node-builtins.mjs — minimal browser shims for Node built-in
// modules so contestant forks that import 'fs', 'path', 'module', etc.
// don't fail at the module-resolver before any of their browser-safe
// code can run. Contestants who *only import* these names but never
// call them will work; contestants who actually call them will get
// a clearer error at the call site instead of a cryptic
// "Failed to resolve module specifier" from the browser's loader.
//
// Wired up via an <script type="importmap"> in the pages that serve
// contestant code: /sessions-viewer/ and /play/<owner>/.

const fail = (name) => () => {
    throw new Error(
        `${name} was called in the browser. This fork uses Node-only APIs ` +
        `that aren't available here. The judge runs your fork under Node, ` +
        `where these work; the in-browser Play view and Session Viewer ` +
        `cannot. Open this fork on GitHub or test under Node locally.`
    );
};

// from 'module'
export const createRequire = () => fail('require()');
export const Module = function () { throw new Error('Module is not available in the browser'); };

// from 'fs' / 'fs/promises'
export const readFileSync   = fail('fs.readFileSync()');
export const writeFileSync  = fail('fs.writeFileSync()');
export const existsSync     = () => false;
export const readdirSync    = () => [];
export const statSync       = fail('fs.statSync()');
export const mkdirSync      = fail('fs.mkdirSync()');
export const readFile       = fail('fs.readFile()');
export const writeFile      = fail('fs.writeFile()');
export const promises       = {
    readFile,
    writeFile,
    readdir:  async () => [],
    mkdir:    fail('fs.promises.mkdir()'),
    stat:     fail('fs.promises.stat()'),
};

// from 'path'
export const join     = (...p) => p.filter(Boolean).join('/').replace(/\/+/g, '/');
export const resolve  = (...p) => '/' + p.filter(Boolean).join('/').replace(/^\/+/, '').replace(/\/+/g, '/');
export const dirname  = (p) => { const s = String(p); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); };
export const basename = (p, ext) => {
    const b = String(p).split('/').pop() || '';
    return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
};
export const extname  = (p) => { const b = String(p).split('/').pop() || ''; const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); };
export const sep      = '/';
export const delimiter = ':';

// from 'url'
export const fileURLToPath = (u) => String(u).replace(/^file:\/\//, '');
export const pathToFileURL = (p) => new URL('file://' + (String(p).startsWith('/') ? '' : '/') + String(p));
export const URL_      = globalThis.URL;
export { URL_ as URL };

// from 'os'
export const platform = () => 'browser';
export const homedir  = () => '/';
export const tmpdir   = () => '/tmp';

// from 'process' / 'node:process'
export const env       = {};
export const argv      = [];
export const cwd       = () => '/';
export const platform_ = 'browser';

// Default export for namespace imports (`import fs from 'fs'`).
export default {
    readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync,
    readFile, writeFile, promises,
    join, resolve, dirname, basename, extname, sep, delimiter,
    fileURLToPath, pathToFileURL,
    platform, homedir, tmpdir,
    env, argv, cwd,
    createRequire, Module,
};
