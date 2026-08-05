// boot.mjs — boot harness for the transpiled NetHack (js/generated/*).
//
// Drives the generated sys/unix/unixmain.c main() with a shim layer:
//   - FS overlay: reads fall through to the real install dir, writes land in
//     an in-memory overlay (no writes into the install tree).
//   - env table: getenv → this table (TERM, NETHACK_FIXED_DATETIME, HOME…).
//   - unix/libc syscalls that are not in the corpus: users, signals, tty ioctls.
//   - keyboard input queue: generated tty_nhgetch reads from here.
//
// Usage: node js/boot/boot.mjs [seed] [datetime] [moves]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// nh_getenv() rejects values longer than 128 chars — the real install path is
// longer than that, so present a short symlink as NETHACKDIR.
const HACKDIR_REAL = path.join(repoRoot, 'nethack-c/recorder/install/games/lib/nethackdir');
const HACKDIR = '/tmp/c2js-nethackdir';
try { if (fs.readlinkSync(HACKDIR) !== HACKDIR_REAL) { fs.unlinkSync(HACKDIR); fs.symlinkSync(HACKDIR_REAL, HACKDIR); } }
catch { fs.symlinkSync(HACKDIR_REAL, HACKDIR); }

// ---------------- env table ----------------

const seed = process.argv[2] || '8000';
const datetime = process.argv[3] || '20260401090000';
const moves = process.argv[4] || '  ';

const tmpHome = fs.mkdtempSync('/tmp/c2js-boot-');
// feed the session's nethackrc as ~/.nethackrc (runner contract passes it too)
try {
  const sess = JSON.parse(fs.readFileSync(process.argv[5] || path.join(repoRoot, 'sessions/seed8000-tourist-starter.session.json'), 'utf8'));
  const seg = (sess.segments || [])[0] || {};
  if (seg.nethackrc) fs.writeFileSync(path.join(tmpHome, '.nethackrc'), seg.nethackrc);
} catch {}
const ENV = {
  TERM: 'ansi',
  HOME: tmpHome,
  NETHACKDIR: HACKDIR,
  NETHACK_FIXED_DATETIME: datetime,
  NETHACK_RNGLOG: 'memory',
  NETHACK_SEED: seed,
};

// ---------------- FS overlay ----------------

let currentDir = '/'; // chdirx chdirs to HACKDIR; resolve relative paths against this
const resolveP = (p) => (p.startsWith('/') ? p : (currentDir === '/' ? '/' + p : currentDir + '/' + p));
const overlay = new Map(); // path -> Uint8Array (written files)
const realRead = (p) => {
  p = resolveP(p);
  if (overlay.has(p)) return overlay.get(p);
  try { return new Uint8Array(fs.readFileSync(p)); } catch { return null; }
};
const realStat = (p) => {
  p = resolveP(p);
  if (overlay.has(p)) return { exists: true, size: overlay.get(p).length, isDir: false, isFile: true, mtime: 0 };
  try {
    const st = fs.statSync(p);
    return { exists: true, size: st.size, isDir: st.isDirectory(), isFile: st.isFile(), mtime: Math.floor(st.mtimeMs / 1000) };
  } catch { return { exists: false, size: 0, isDir: false, isFile: false, mtime: 0 }; }
};
const realWrite = (p, bytes) => { overlay.set(resolveP(p), bytes); };

// FILE* emulation: { buf, off } over overlay/real bytes; line-buffered writes
let nextFd = 100;
const fds = new Map(); // fd -> {path, pos, written:[]}
function openFd(p, mode) {
  const fd = nextFd++;
  if (mode === 'w' || mode === 'w+') {
    fds.set(fd, { path: p, pos: 0, written: [], write: true });
    realWrite(p, new Uint8Array(0));
  } else {
    const data = realRead(p);
    if (!data) return -1;
    fds.set(fd, { path: p, pos: 0, data, write: mode !== 'r' });
  }
  return fd;
}
function fdFlush(fd) {
  const f = fds.get(fd);
  if (f && f.write) realWrite(f.path, new Uint8Array(f.written));
}

// ---------------- shims ----------------

const inputQueue = [];
for (const ch of moves) inputQueue.push(ch.charCodeAt(0));

const g = globalThis;
// --- temporary stage tracing (throttled): last shim calls before a hang ---
let __traceN = 0;
function __trace(...a) { if (++__traceN <= 400) fs.writeSync(2, '[trace] ' + a.map(String).join(' ') + '\n'); }

g.getenv = (name) => { __trace('getenv', name && name.buf ? cptr.cstr(name) : name);
  name = typeof name === 'string' ? name : cptr.cstr(name);
  if (name in ENV) return cptr.lit(ENV[name]);
  if (name === 'NETHACK_RNGLOG') return cptr.lit('memory');
  return null;
};
g.setenv = (name, val, overwrite) => { ENV[cptr.cstr(name)] = cptr.cstr(val); return 0; };
g.unsetenv = (name) => { delete ENV[cptr.cstr(name)]; return 0; };

g.exit = (code) => { __trace('exit', code); throw { __bootExit: code }; };
// clang fortified builtins + assert (bare refs in generated code resolve via globalThis)
g.__builtin_expect = (v, e) => v;
g.__builtin_object_size = (p, t) => -1n;
g.__builtin_huge_val = () => Infinity;
g.__builtin___memset_chk = (dst, val, len, max) => {
  if (dst && dst.isBox) { dst.v = 0; return dst; } // memset(&boxed_scalar, 0, n)
  const n = Number(len);
  for (let i = 0; i < n; i++) cptr.st1(cptr.add(dst, i), val);
  return dst;
};
g.__builtin___strncpy_chk = (dst, src, n, max) => { // C strncpy: NUL-pads to n
  n = Number(n);
  let i = 0;
  for (; i < n; i++) { const c = cptr.ld1u(cptr.add(src, i)); cptr.st1(cptr.add(dst, i), c); if (c === 0) { i++; break; } }
  for (; i < n; i++) cptr.st1(cptr.add(dst, i), 0);
  return dst;
};
g.__builtin___strncat_chk = (dst, src, n, max) => {
  n = Number(n);
  const d = Number(cptr.strlen(dst));
  let i = 0;
  for (; i < n; i++) { const c = cptr.ld1u(cptr.add(src, i)); cptr.st1(cptr.add(dst, d + i), c); if (c === 0) return dst; }
  cptr.st1(cptr.add(dst, d + n), 0);
  return dst;
};
g.__assert_rtn = (fn, file, line, expr) => { throw new Error(`assert failed: ${cptr.cstr(expr)} @ ${cptr.cstr(file)}:${line} (${cptr.cstr(fn)})`); };
g.abort = () => { throw new Error('abort()'); };
g.getpid = () => 4242;
g.__errnoBuf = new Uint8Array(4);
g.__error = () => cptr.decay(g.__errnoBuf); // Darwin errno accessor
g.strerror = (e) => cptr.lit(`error ${Number(e)}`);
g.atoi = (p) => { const v = parseInt(cptr.cstr(p), 10); return Number.isNaN(v) ? 0 : v | 0; };
g.isspace = (c) => (c === 32 || (c >= 9 && c <= 13)) ? 1 : 0;
g.isdigit = (c) => (c >= 48 && c <= 57) ? 1 : 0;
g.isalpha = (c) => ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) ? 1 : 0;
g.isalnum = (c) => (g.isalpha(c) || g.isdigit(c)) ? 1 : 0;
g.islower = (c) => (c >= 97 && c <= 122) ? 1 : 0;
g.isprint = (c) => (c >= 32 && c <= 126) ? 1 : 0;
g.ispunct = (c) => (g.isprint(c) && !g.isalnum(c) && c !== 32) ? 1 : 0;
g.iscntrl = (c) => (c < 32 || c === 127) ? 1 : 0;
g.toupper = (c) => (c >= 97 && c <= 122) ? c - 32 : c;
g.strcmp = (a, b) => { const s = cptr.cstr(a), t = cptr.cstr(b); return s < t ? -1 : s > t ? 1 : 0; };
g.strcasecmp = (a, b) => { const s = cptr.cstr(a).toLowerCase(), t = cptr.cstr(b).toLowerCase(); return s < t ? -1 : s > t ? 1 : 0; };
g.strncasecmp = (a, b, n) => { const s = cptr.cstr(a).toLowerCase().slice(0, Number(n)), t = cptr.cstr(b).toLowerCase().slice(0, Number(n)); return s < t ? -1 : s > t ? 1 : 0; };
g.atol = (p) => BigInt(g.atoi(p));
g.atof = (p) => { const v = parseFloat(cptr.cstr(p)); return Number.isNaN(v) ? 0 : v; };
g.abs = (x) => Math.abs(Number(x)) | 0;
g.labs = (x) => BigInt(Math.abs(Number(x)));
g.getuid = () => 501;
g.geteuid = () => 501;
g.getgid = () => 20;
g.umask = (m) => 0o22;

const pw = { pw_name: 'player', pw_passwd: 'x', pw_uid: 501, pw_gid: 20, pw_gecos: 'Player', pw_dir: tmpHome, pw_shell: '/bin/sh' };
const pwBuf = (() => {
  const b = new Uint8Array(7 * 8);
  g.__pwFields = {};
  for (const [i, k] of ['pw_name', 'pw_passwd', null, null, 'pw_gecos', 'pw_dir', 'pw_shell'].entries()) {}
  return b;
})();
// struct passwd as pointer registry entries: store JS object, return box-like object with fields
function makePasswd(p) {
  return { isBox: true, v: 0, __struct: 'passwd', pw_name: cptr.lit(p.pw_name), pw_passwd: cptr.lit(p.pw_passwd), pw_uid: p.pw_uid, pw_gid: p.pw_gid, pw_gecos: cptr.lit(p.pw_gecos), pw_dir: cptr.lit(p.pw_dir), pw_shell: cptr.lit(p.pw_shell) };
}
g.getpwuid = (uid) => null; // -> whoami falls back to username ""
g.getpwnam = (name) => null;

g.signal = (sig, handler) => { __trace('signal', sig); return null; };
// CommonCrypto MD4 (macOS): only feeds the crash-report build id; stub succeeds
g.CC_MD4_Init = (ctx) => 1;
g.CC_MD4_Update = (ctx, data, len) => 1;
g.CC_MD4_Final = (digest, ctx) => { for (let i = 0; i < 16; i++) cptr.st1(cptr.add(digest, i), 0); return 1; };
g.setsignal = () => {};
g.sethanguphandler = (fn) => {};
g.chdir = (p) => { currentDir = resolveP(cptr.cstr(p)); __trace('chdir', currentDir); return 0; };
g.open = (p, flags, mode) => { __trace('open', cptr.cstr(p), flags); // POSIX
  const acc = Number(flags) & 3;
  const creat = (Number(flags) & 0x200) !== 0; // O_CREAT (darwin)
  if (creat && !realRead(cptr.cstr(p))) realWrite(cptr.cstr(p), new Uint8Array(0));
  const m = acc === 0 ? 'r' : acc === 2 ? 'r+' : 'w';
  return openFd(cptr.cstr(p), m);
};
g.read = (fd, buf, n) => {
  const f = fds.get(fd);
  if (!f || !f.data) return -1;
  const avail = Math.min(Number(n), f.data.length - f.pos);
  if (avail <= 0) return 0;
  for (let i = 0; i < avail; i++) cptr.st1(cptr.add(buf, i), f.data[f.pos + i]);
  f.pos += avail;
  return avail;
};
g.close = (fd) => { fdFlush(fd); fds.delete(fd); return 0; };
g.lseek = (fd, off, whence) => {
  const f = fds.get(fd);
  if (!f) return -1;
  const len = (f.data || f.written || []).length;
  f.pos = whence === 0 ? Number(off) : whence === 1 ? f.pos + Number(off) : len + Number(off);
  return BigInt(f.pos);
};
g.getcwd = (buf, size) => { const s = cptr.cstr ? HACKDIR : HACKDIR; if (buf && buf.buf !== undefined) { cptr.writeStr(buf, HACKDIR); return buf; } return cptr.lit(HACKDIR); };
g.access = (p, mode) => realStat(cptr.cstr(p)).exists ? 0 : -1;
g.stat = (p, sb) => {
  const st = realStat(cptr.cstr(p));
  if (!st.exists) return -1;
  if (sb && sb.buf !== undefined) {
    cptr.stU64(cptr.add(sb, 96), BigInt(st.mtime)); // st_mtime off (darwin arm64)
    cptr.stU64(cptr.add(sb, 40), BigInt(st.size)); // st_size
    cptr.stI32(cptr.add(sb, 4), 0o100644); // st_mode
  }
  return 0;
};
g.lstat = g.stat;
g.fstat = (fd, sb) => { const f = fds.get(fd); if (!f) return -1; cptr.stU64(cptr.add(sb, 40), BigInt((f.data || f.written).length)); cptr.stI32(cptr.add(sb, 4), 0o100644); return 0; };
g.chmod = (p, mode) => 0;
g.unlink = (p) => { overlay.delete(cptr.cstr(p)); return 0; };
g.mkdir = (p, mode) => 0;
g.link = (a, b) => 0;
g.rename = (a, b) => { const d = realRead(cptr.cstr(a)); if (d) { realWrite(cptr.cstr(b), d); overlay.delete(cptr.cstr(a)); } return 0; };
g.rmdir = (p) => 0;
g.opendir = (p) => null;
g.readdir = (d) => null;
g.closedir = (d) => 0;
g.flock = (fd, op) => 0;
g.fcntl = (fd, cmd, arg) => 0;
g.ioctl = (fd, req, argp) => {
  // TIOCGWINSZ = 0x40087468 (darwin)
  if (argp && argp.buf !== undefined) {
    cptr.stI16(cptr.add(argp, 0), 24); // ws_row
    cptr.stI16(cptr.add(argp, 2), 80); // ws_col
  }
  return 0;
};
g.isatty = (fd) => 1;
g.tcdrain = (fd) => 0;
g.tcgetattr = (fd, t) => 0;
g.tcsetattr = (fd, act, t) => 0;
g.cfgetispeed = () => 13;
g.cfgetospeed = () => 13;

g.time = (tloc) => { __trace('time');
  const t = BigInt(Math.floor(new Date(
    Number(datetime.slice(0, 4)), Number(datetime.slice(4, 6)) - 1, Number(datetime.slice(6, 8)),
    Number(datetime.slice(8, 10)), Number(datetime.slice(10, 12)), Number(datetime.slice(12, 14))
  ).getTime() / 1000));
  if (tloc && tloc.buf !== undefined) cptr.stU64(tloc, t);
  return t;
};
g.localtime = (tp) => {
  const t = Number(cptr.ldU64(tp));
  const d = new Date(t * 1000);
  const tm = { sec: d.getSeconds(), min: d.getMinutes(), hour: d.getHours(), mday: d.getDate(), mon: d.getMonth(), year: d.getFullYear() - 1900, wday: d.getDay(), yday: 0, isdst: 0 };
  return makeTm(tm);
};
function makeTm(t) {
  // struct tm: int sec,min,hour,mday,mon,year,wday,yday,isdst; long gmtoff; char *zone
  const b = new Uint8Array(9 * 4 + 8 + 8);
  const p = { buf: b, off: 0 };
  const ints = [t.sec, t.min, t.hour, t.mday, t.mon, t.year, t.wday, t.yday, t.isdst];
  ints.forEach((v, i) => cptr.stI32(cptr.add(p, i * 4), v));
  return p;
}
g.mktime = (tm) => {
  const rd = (o) => cptr.ldI32(cptr.add(tm, o));
  const d = new Date(rd(20) + 1900, rd(16), rd(12), rd(8), rd(4), rd(0));
  return BigInt(Math.floor(d.getTime() / 1000));
};
g.difftime = (a, b) => a - b;
g.strftime = (buf, max, fmt, tm) => { cptr.writeStr(buf, cptr.cstr(fmt)); return 0; };
g.clock = () => 0;
g.sleep = (s) => 0;
g.usleep = (us) => 0;

// stdio over the FS overlay
g.fopen = (p, mode) => {
  p = cptr.cstr(p); mode = cptr.cstr(mode); __trace('fopen', p, mode);
  if (mode.startsWith('w')) { const fd = openFd(p, 'w'); return fd < 0 ? null : { __fd: fd }; }
  const data = realRead(p);
  if (!data) return null;
  const fd = openFd(p, 'r');
  return { __fd: fd };
};
g.freopen = (p, mode, f) => g.fopen(p, mode);
g.fclose = (f) => { if (f && f.__fd !== undefined) { fdFlush(f.__fd); fds.delete(f.__fd); } return 0; };
g.fread = (ptr, size, nmemb, f) => {
  const fd = fds.get(f.__fd);
  if (!fd || !fd.data) return 0;
  const want = Number(size) * Number(nmemb);
  const avail = Math.min(want, fd.data.length - fd.pos);
  if (avail <= 0) return 0;
  ptr.buf.set(fd.data.slice(fd.pos, fd.pos + avail), ptr.off);
  fd.pos += avail;
  return Math.floor(avail / Number(size));
};
g.fwrite = (ptr, size, nmemb, f) => {
  const fd = fds.get(f.__fd);
  const n = Number(size) * Number(nmemb);
  if (!fd) return 0;
  if (!fd.write) fd.write = true;
  for (let i = 0; i < n; i++) fd.written.push(ptr.buf[ptr.off + i]);
  return Number(nmemb);
};
g.fseek = (f, off, whence) => { const fd = fds.get(f.__fd); if (!fd) return -1; off = Number(off); fd.pos = whence === 0 ? off : whence === 1 ? fd.pos + off : (fd.data || fd.written).length + off; return 0; };
g.ftell = (f) => { const fd = fds.get(f.__fd); return fd ? BigInt(fd.pos) : -1n; };
g.rewind = (f) => { const fd = fds.get(f.__fd); if (fd) fd.pos = 0; };
g.fgets = (buf, n, f) => {
  const fd = fds.get(f.__fd);
  if (!fd || !fd.data || fd.pos >= fd.data.length) return null;
  let line = '';
  while (fd.pos < fd.data.length && line.length < Number(n) - 1) {
    const ch = fd.data[fd.pos++];
    line += String.fromCharCode(ch);
    if (ch === 10) break;
  }
  cptr.writeStr(buf, line);
  return buf;
};
g.fputs = (s, f) => { const str = cptr.cstr(s); for (const ch of str) g.fputc(ch.charCodeAt(0), f); return 0; };
g.fputc = (c, f) => {
  if (f === g.stdout || f === g.__stdout) { process.stdout.write(String.fromCharCode(c)); return c; }
  if (f === g.stderr || f === g.__stderrp) { process.stderr.write(String.fromCharCode(c)); return c; }
  const fd = fds.get(f.__fd);
  if (fd) { if (!fd.write) fd.write = true; fd.written.push(c & 0xFF); }
  return c;
};
g.putchar = (c) => g.fputc(c, g.__stdout);
g.puts = (s) => { process.stdout.write(cptr.cstr(s) + '\n'); return 0; };
g.fflush = (f) => { if (f && f.__fd !== undefined) fdFlush(f.__fd); return 0; };
g.fgetc = (f) => { const fd = fds.get(f.__fd); if (!fd || !fd.data || fd.pos >= fd.data.length) return -1; return fd.data[fd.pos++]; };
g.getc = g.fgetc;
g.ungetc = (c, f) => { const fd = fds.get(f.__fd); if (fd && fd.pos > 0) { fd.pos--; fd.data[fd.pos] = c & 0xFF; } return c; };
g.vfprintf = (f, fmt, ap) => { const s = cptr.sprintfCore(fmt, ap && ap.args ? ap.args.slice(ap.i) : []); g.fputs(cptr.lit(s), f); return s.length; };
g.vprintf = (fmt, ap) => g.vfprintf(g.__stdout, fmt, ap);
g.__stdout = { __stdout: true };
g.__stdoutp = g.__stdout; // Darwin stdio: stdout is __stdoutp
g.__stderrp = { __stderr: true };
g.__stdinp = { __stdin: true };
g.stdout = g.__stdout;
g.stderr = g.__stderrp;

// termcap extras
g.setupterm = (term, fd, err) => 0;
g.tigetstr = (cap) => null;
g.tigetnum = (cap) => -2;
g.tigetflag = (cap) => 0;
g.tputs = (str, affcnt, putc) => { const s = cptr.cstr(str); for (const ch of s) putc(ch.charCodeAt(0)); return 0; };
g.tgoto = (cm, col, line) => cptr.lit('');

// ---------------------------------------------------------------------------

import * as cptr from '../cptr.js';

async function main() {
  try {
    const um = await import('../generated/unixmain.js');
    console.error('[boot] calling main()...');
    const argvBuf = new Uint8Array(16); // char *argv[2] = { "nethack", NULL }
    const argv = cptr.decay(argvBuf);
    cptr.stPtr(argv, cptr.lit('nethack'));
    um.main(1, argv);
    console.error('[boot] main() returned (unexpected)');
  } catch (e) {
    if (e && e.__bootExit !== undefined) {
      console.error(`[boot] exit(${e.__bootExit})`);
    } else {
      console.error('[boot] error:', e.stack || e);
      process.exitCode = 1;
    }
  }
}
main();
