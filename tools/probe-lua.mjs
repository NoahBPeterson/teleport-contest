// probe-lua.mjs — isolated Lua interpreter boot probe
import * as cptr from '../js/cptr.js';

const g = globalThis;
g.getenv = () => null;
g.time = () => 1700000000n;
g.realloc = (p, n) => {
  n = Number(n);
  if (p === null) return cptr.malloc(n);
  const nb = cptr.malloc(n);
  nb.buf.set(p.buf.slice(p.off, p.off + Math.min(n, p.buf.length - p.off)), 0);
  return nb;
};
g.memcmp = (a, b, n) => { n = Number(n); for (let i = 0; i < n; i++) { const d = (a.buf[a.off + i] ?? 0) - (b.buf[b.off + i] ?? 0); if (d) return d; } return 0; };
g.memchr = (p, c, n) => { c = Number(c) & 0xFF; for (let i = 0; i < Number(n); i++) { if (p.buf[p.off + i] === c) return cptr.add(p, i); } return null; };
g.strcmp = (a, b) => { const s = cptr.cstr(a), t = cptr.cstr(b); return s < t ? -1 : s > t ? 1 : 0; };
g.strcoll = g.strcmp;
g.isspace = (c) => (c === 32 || (c >= 9 && c <= 13)) ? 1 : 0;
g.isdigit = (c) => (c >= 48 && c <= 57) ? 1 : 0;
g.isalpha = (c) => ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) ? 1 : 0;
g.isalnum = (c) => (g.isalpha(c) || g.isdigit(c)) ? 1 : 0;
g.islower = (c) => (c >= 97 && c <= 122) ? 1 : 0;
g.isupper = (c) => (c >= 65 && c <= 90) ? 1 : 0;
g.isprint = (c) => (c >= 32 && c <= 126) ? 1 : 0;
g.iscntrl = (c) => (c < 32 || c === 127) ? 1 : 0;
g.ispunct = (c) => (g.isprint(c) && !g.isalnum(c) && c !== 32) ? 1 : 0;
g.isxdigit = (c) => (g.isdigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) ? 1 : 0;
g.toupper = (c) => (c >= 97 && c <= 122) ? c - 32 : c;
g.tolower = (c) => (c >= 65 && c <= 90) ? c + 32 : c;
g.abort = () => { throw new Error('abort()'); };
g.exit = (c) => { throw { __exit: c }; };
g.__builtin_expect = (v, e) => v;
g.__builtin_huge_val = () => Infinity;
g.__builtin_object_size = (p, t) => -1n;
g.__assert_rtn = (fn, file, line, expr) => { throw new Error(`assert: ${cptr.cstr(expr)} @ ${cptr.cstr(file)}:${line}`); };
g.localeconv = () => cptr.alloc(64); // all null/zero fields
g.fwrite = () => 0;
g.fprintf = () => 0;
g.fflush = () => 0;
g.__stderrp = { __stderr: true };
g.__stdinp = { __stdin: true };
g.__stdoutp = { __stdout: true };
g.strerror = (e) => cptr.lit(`error ${Number(e)}`);
g.fopen = () => null;
g.fclose = () => 0;
g.fread = () => 0;
g.getc = () => -1;
g.ungetc = () => 0;
g.fseek = () => 0;
g.ftell = () => 0n;
g.clearerr = () => {};
g.feof = () => 0;
g.setvbuf = () => 0;

Error.stackTraceLimit = 50;

await import('../js/generated/unixmain.js'); // boot import order (import-cycle init)
const aux = await import('../js/generated/lauxlib.js');
const init = await import('../js/generated/linit.js');
const lapi = await import('../js/generated/lapi.js');
const ltable = await import('../js/generated/ltable.js');
try {
  const L = aux.luaL_newstate();
  console.log('newstate ok:', L !== null);
  init.luaL_openlibs(L);
  console.log('openlibs ok');
  const trySrc = (s, label) => {
    const L2 = aux.luaL_newstate();
    const b = Buffer.from(s, 'utf8');
    const buf = cptr.malloc(b.length + 1);
    buf.buf.set(b, 0);
    buf.buf[b.length] = 0;
    const rc = aux.luaL_loadbufferx(L2, buf, BigInt(b.length), cptr.lit('(chunk)'), cptr.lit('t'));
    let msg = '';
    if (rc !== 0) { try { msg = cptr.cstr(cptr.add(cptr.ldPtr(cptr.add(cptr.ldPtr(cptr.add(L2, 16)), -1, 16)), 24)); } catch {} }
    console.log(rc === 0 ? 'OK  ' : 'FAIL', label, msg);
    return rc === 0;
  };
  trySrc('x = 1', 'assign number');
  trySrc('return 1', 'return');
  trySrc('print(1)', 'call name');
  trySrc('x', 'bare name');
  trySrc('x=1', 'assign nospace');
} catch (e) {
  console.error('probe error:', e.stack || e);
}
