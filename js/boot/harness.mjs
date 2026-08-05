// harness.mjs — reusable boot harness for the transpiled NetHack (js/generated/*).
//
// Runs the generated sys/unix/unixmain.c main() under a libc/tty shim layer,
// driven by a replay descriptor ({seed, datetime, nethackrc, moves, storage}):
//   - FS overlay: reads fall through to the real install dir, writes land in
//     an in-memory overlay; the overlay persists across segments via
//     input.storage (Web-Storage-shaped handle from the judge).
//   - env table: getenv → TERM, NETHACK_FIXED_DATETIME, NETHACK_SEED, ...
//   - unix/libc syscalls not in the corpus: users, signals, tty ioctls.
//   - keyboard input queue: generated tty_nhgetch reads from here.
//   - screen capture: nomux markers (\x1b]7777;...) parsed from stdout.
//
// Each segment boots a FRESH module graph (query-string cache busting), so
// per-segment C state never leaks across segments of a session.
//
// Used by js/jsmain.js (contest runSegment) and js/boot/boot.mjs (CLI).

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

let __segCounter = 0;

/**
 * Boot one segment of the transpiled game. NOTE: generated modules are plain
 * imports — C module state persists across calls within one process. For
 * per-segment isolation use js/boot/worker.mjs (one child process per
 * segment), which is what js/jsmain.js's runSegment does.
 * @param {{seed: number|string, datetime: string, nethackrc: string,
 *          moves: string, storage?: object, trace?: boolean,
 *          stdoutSink?: (s: string) => void}} opts
 * @returns {Promise<{screens: string[], cursors: Array, animFramesByStep: Array,
 *          rngLog: string[], stdout: string, exitCode: number|null, error: Error|null}>}
 */
export async function runBootGame(opts) {
  const seed = String(opts.seed ?? '8000');
  const datetime = String(opts.datetime || '20260401090000');
  const moves = opts.moves || '';
  const storage = opts.storage || null;
  const trace = !!opts.trace;
  const stdoutSink = opts.stdoutSink || null;
  const segId = ++__segCounter;

  const tmpHome = fs.mkdtempSync('/tmp/c2js-boot-');
  if (opts.nethackrc) fs.writeFileSync(path.join(tmpHome, '.nethackrc'), opts.nethackrc);
  const ENV = {
    TERM: 'ansi',
    HOME: tmpHome,
    NETHACKDIR: HACKDIR,
    NETHACK_FIXED_DATETIME: datetime,
    NETHACK_RNGLOG: 'memory',
    NETHACK_SEED: seed,
    NOMUX_MARKERS: process.env.C2JS_NOMUX || '1',
  };

  // ---------------- FS overlay (persisted across segments via storage) ------

  let currentDir = '/';
  const resolveP = (p) => (p.startsWith('/') ? p : (currentDir === '/' ? '/' + p : currentDir + '/' + p));
  const overlay = new Map();
  if (storage) {
    try {
      const raw = storage.getItem('c2js-overlay');
      if (raw) for (const [k, b64] of Object.entries(JSON.parse(raw))) overlay.set(k, new Uint8Array(Buffer.from(b64, 'base64')));
    } catch {}
  }
  const persistOverlay = () => {
    if (!storage) return;
    try {
      const o = {};
      for (const [k, v] of overlay) o[k] = Buffer.from(v).toString('base64');
      storage.setItem('c2js-overlay', JSON.stringify(o));
    } catch {}
  };
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

  let nextFd = 100;
  const fds = new Map();
  // errno: C code branches on it after failed syscalls (getlock's open()
  // takes goto gotlock only when errno == ENOENT). Darwin ENOENT = 2.
  const setErrno = (n) => {
    g.__errnoBuf[0] = n & 255; g.__errnoBuf[1] = (n >> 8) & 255;
    g.__errnoBuf[2] = (n >> 16) & 255; g.__errnoBuf[3] = (n >> 24) & 255;
  };
  function openFd(p, mode) {
    const fd = nextFd++;
    if (mode === 'w' || mode === 'w+') {
      fds.set(fd, { path: p, pos: 0, written: [], write: true });
      realWrite(p, new Uint8Array(0));
    } else {
      const data = realRead(p);
      if (!data) { setErrno(2); return -1; }
      fds.set(fd, { path: p, pos: 0, data, written: [], write: mode !== 'r' });
    }
    return fd;
  }
  function fdFlush(fd) {
    const f = fds.get(fd);
    if (f && f.write) realWrite(f.path, new Uint8Array(f.written));
  }

  // ---------------- output collection + shims ----------------

  const stdoutChunks = [];
  const out = (s) => { stdoutChunks.push(s); if (stdoutSink) stdoutSink(s); };
  const err = (s) => { if (trace) process.stderr.write(s); };

  const inputQueue = [];
  for (const ch of moves) inputQueue.push(ch.charCodeAt(0));

  const g = globalThis;
  const cptr = await import('../cptr.js');
  let __traceN = 0;
  function __trace(...a) { if (trace && ++__traceN <= 400) process.stderr.write('[trace] ' + a.map(String).join(' ') + '\n'); }

  g.getenv = (name) => { __trace('getenv', name && name.buf ? cptr.cstr(name) : name);
    name = typeof name === 'string' ? name : cptr.cstr(name);
    if (name in ENV) return cptr.lit(ENV[name]);
    if (name === 'NETHACK_RNGLOG') return cptr.lit('memory');
    return null;
  };
  g.setenv = (name, val, overwrite) => { ENV[cptr.cstr(name)] = cptr.cstr(val); return 0; };
  g.unsetenv = (name) => { delete ENV[cptr.cstr(name)]; return 0; };

  g.exit = (code) => { __trace('exit', code); throw { __bootExit: code }; };
  g.__builtin_expect = (v, e) => v;
  g.__builtin_object_size = (p, t) => -1n;
  g.__builtin_huge_val = () => Infinity;
  function memsetAny(dst, val, n) {
    if (dst && dst.isBox) { dst.v = 0; return dst; }
    if (dst && Array.isArray(dst.buf)) {
      const B = dst.buf;
      const nested = B.length === 0 || Array.isArray(B[0]) || B[0] instanceof Uint8Array;
      if (!nested) { for (let i = 0; i < n; i++) B[dst.off + i] = val & 0xFF; return dst; }
      let off = dst.off, remaining = n, idx = 0;
      while (remaining > 0 && idx < B.length) {
        const row = B[idx++];
        const rowLen = Array.isArray(row) ? row.reduce((s, r) => s + r.length, 0) : row.length;
        if (off >= rowLen) { off -= rowLen; continue; }
        const k = Math.min(remaining, rowLen - off);
        memsetAny({ buf: row, off }, val, k);
        remaining -= k; off = 0;
      }
      return dst;
    }
    for (let i = 0; i < n; i++) cptr.st1(cptr.add(dst, i), val);
    return dst;
  }
  g.__builtin___memset_chk = (dst, val, len, max) => memsetAny(dst, val, Number(len));
  g.__builtin___strncpy_chk = (dst, src, n, max) => {
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
  g.backtrace = (buf, size) => 0;
  g.backtrace_symbols = (buf, size) => null;
  g.backtrace_symbols_fd = (buf, size, fd) => {};
  g.getpid = () => 4242;
  g.__errnoBuf = new Uint8Array(4);
  g.__error = () => cptr.decay(g.__errnoBuf);
  g.strerror = (e) => cptr.lit(`error ${Number(e)}`);
  g.perror = (s) => {
    const e = g.__errnoBuf[0] | (g.__errnoBuf[1] << 8) | (g.__errnoBuf[2] << 16) | (g.__errnoBuf[3] << 24);
    err(`${s ? cptr.cstr(s) : ''}: error ${e}\n`);
  };
  g.atoi = (p) => { const v = parseInt(cptr.cstr(p), 10); return Number.isNaN(v) ? 0 : v | 0; };
  g.realloc = (p, n) => {
    n = Number(n);
    if (p === null) return cptr.malloc(n);
    const nb = cptr.malloc(n);
    nb.buf.set(p.buf.slice(p.off, p.off + Math.min(n, p.buf.length - p.off)), 0);
    return nb;
  };
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
  g.memchr = (p, c, n) => { c = Number(c) & 0xFF; for (let i = 0; i < Number(n); i++) { if (p.buf[p.off + i] === c) return cptr.add(p, i); } return null; };
  g.memcmp = (a, b, n) => { n = Number(n); for (let i = 0; i < n; i++) { const d = (a.buf[a.off + i] ?? 0) - (b.buf[b.off + i] ?? 0); if (d) return d; } return 0; };
  g.memmove = (dst, src, n) => cptr.memcpy(dst, src, n);
  g.memset = (dst, val, n) => memsetAny(dst, val, Number(n));
  g.atol = (p) => BigInt(g.atoi(p));
  g.strtoul = (p, endptr, base) => {
    base = Number(base) || 10;
    const s = cptr.cstr(p).replace(/^\s+/, '');
    const m = s.match(base === 16 ? /^[+-]?(0x)?[0-9a-fA-F]+/ : /^[+-]?\d+/);
    if (!m) { if (endptr && endptr.buf !== undefined) cptr.stPtr(endptr, p); return 0n; }
    const v = BigInt(base === 16 && !m[0].toLowerCase().startsWith('0x') && !/^[+-]?0x/i.test(m[0]) ? '0x' + m[0] : m[0]);
    if (endptr && endptr.buf !== undefined) cptr.stPtr(endptr, cptr.add(p, cptr.cstr(p).indexOf(m[0]) + m[0].length));
    return BigInt.asUintN(64, v);
  };
  g.strtol = (p, endptr, base) => BigInt.asIntN(64, g.strtoul(p, endptr, base));
  g.sscanf = (str, fmt, ...args) => {
    const s = cptr.cstr(str), f = cptr.cstr(fmt);
    let si = 0, fi = 0, assigned = 0;
    const skipWs = () => { while (si < s.length && /\s/.test(s[si])) si++; };
    while (fi < f.length) {
      const c = f[fi];
      if (/\s/.test(c)) { skipWs(); fi++; continue; }
      if (c !== '%') { if (s[si] !== c) return assigned; si++; fi++; continue; }
      fi++;
      if (f[fi] === '%') { if (s[si] !== '%') return assigned; si++; fi++; continue; }
      let width = 0;
      while (fi < f.length && f[fi] >= '0' && f[fi] <= '9') width = width * 10 + (f[fi++] | 0);
      let lng = 0;
      while (f[fi] === 'l') { lng++; fi++; }
      const spec = f[fi++];
      const arg = args[assigned];
      if (spec === 'c') {
        const n = width || 1;
        for (let i = 0; i < n; i++) { if (si >= s.length) return assigned; cptr.st1(cptr.add(arg, i), s.charCodeAt(si++)); }
        assigned++; continue;
      }
      if (spec === 's') {
        skipWs();
        let out = '';
        while (si < s.length && !/\s/.test(s[si]) && (!width || out.length < width)) out += s[si++];
        if (!out) return assigned;
        cptr.writeStr(arg, out); assigned++; continue;
      }
      if (spec === '[') {
        let negate = false;
        if (f[fi] === '^') { negate = true; fi++; }
        let set = '';
        if (f[fi] === ']') { set += ']'; fi++; }
        while (fi < f.length && f[fi] !== ']') set += f[fi++];
        fi++;
        let out = '';
        while (si < s.length && (set.includes(s[si]) !== negate) && (!width || out.length < width)) out += s[si++];
        if (!out) return assigned;
        cptr.writeStr(arg, out); assigned++; continue;
      }
      if (!'diux'.includes(spec)) return assigned;
      skipWs();
      const m = s.slice(si).match(spec === 'x' ? /^[+-]?(?:0[xX])?[0-9a-fA-F]+/ : /^[+-]?\d+/);
      if (!m) return assigned;
      si += m[0].length;
      let t = m[0], neg = false;
      if (t.startsWith('-')) { neg = true; t = t.slice(1); } else if (t.startsWith('+')) t = t.slice(1);
      let v;
      try { v = spec === 'x' ? BigInt('0x' + t.replace(/^0[xX]/, '')) : BigInt(t); } catch { return assigned; }
      if (neg) v = -v;
      if (lng >= 1) cptr.stU64(arg, BigInt.asUintN(64, v));
      else cptr.stI32(arg, Number(BigInt.asIntN(32, v)));
      assigned++;
    }
    return assigned;
  };
  g.atof = (p) => { const v = parseFloat(cptr.cstr(p)); return Number.isNaN(v) ? 0 : v; };
  g.abs = (x) => Math.abs(Number(x)) | 0;
  g.labs = (x) => BigInt(Math.abs(Number(x)));
  g.getuid = () => 501;
  g.geteuid = () => 501;
  g.getgid = () => 20;
  g.umask = (m) => 0o22;

  function makePasswd(p) {
    const b = cptr.alloc(72);
    cptr.stPtr(b, cptr.lit(p.pw_name));
    cptr.stPtr(cptr.add(b, 8), cptr.lit(p.pw_passwd));
    cptr.stI32(cptr.add(b, 16), p.pw_uid);
    cptr.stI32(cptr.add(b, 20), p.pw_gid);
    cptr.stPtr(cptr.add(b, 32), cptr.lit(''));
    cptr.stPtr(cptr.add(b, 40), cptr.lit(p.pw_gecos));
    cptr.stPtr(cptr.add(b, 48), cptr.lit(p.pw_dir));
    cptr.stPtr(cptr.add(b, 56), cptr.lit(p.pw_shell));
    return b;
  }
  g.getpwuid = (uid) => makePasswd({ pw_name: '', pw_passwd: 'x', pw_uid: 501, pw_gid: 20, pw_gecos: '', pw_dir: tmpHome, pw_shell: '/bin/sh' });
  g.getpwnam = (name) => null;
  // NULL like the recorder's environment: the official sessions were recorded
  // under a GENERICUSERS account, so plname is cleared and askname() reads the
  // player name from the session's own keystrokes. With USER/LOGNAME unset and
  // getlogin() NULL, whoami() leaves plname empty and the same path runs.
  g.getlogin = () => null;

  g.signal = (sig, handler) => { __trace('signal', sig); return null; };
  g.sigaction = (sig, act, oact) => 0;
  g.sigemptyset = (set) => 0;
  g.sigfillset = (set) => 0;
  g.sigaddset = (set, sig) => 0;
  g.sigdelset = (set, sig) => 0;
  g.sigprocmask = (how, set, oset) => 0;
  g.sigsuspend = (set) => 0;
  g.CC_MD4_Init = (ctx) => 1;
  g.CC_MD4_Update = (ctx, data, len) => 1;
  g.CC_MD4_Final = (digest, ctx) => { for (let i = 0; i < 16; i++) cptr.st1(cptr.add(digest, i), 0); return 1; };
  g.setsignal = () => {};
  g.error = (fmt, ...args) => {
    const s = cptr.sprintfCore(fmt, args);
    err(s + '\n');
    throw { __bootExit: 1 };
  };
  g.sethanguphandler = (fn) => {};
  g.chdir = (p) => { currentDir = resolveP(cptr.cstr(p)); __trace('chdir', currentDir); return 0; };
  g.open = (p, flags, mode) => { __trace('open', cptr.cstr(p), flags);
    const acc = Number(flags) & 3;
    const creat = (Number(flags) & 0x200) !== 0;
    if (creat && !realRead(cptr.cstr(p))) realWrite(cptr.cstr(p), new Uint8Array(0));
    const m = acc === 0 ? 'r' : acc === 2 ? 'r+' : 'w';
    return openFd(cptr.cstr(p), m);
  };
  g.creat = (p, mode) => { const fd = openFd(cptr.cstr(p), 'w'); return fd; };
  g.read = (fd, buf, n) => {
    if (buf && buf.isBox) {
      const tmp = cptr.alloc(Number(n));
      const r = g.read(fd, tmp, n);
      if (r > 0) {
        if (Number(n) <= 4) { let v = 0; for (let i = Number(n) - 1; i >= 0; i--) v = (v << 8) | cptr.ld1u(cptr.add(tmp, i)); buf.v = v; }
        else { let v = 0n; for (let i = Math.min(Number(n), 8) - 1; i >= 0; i--) v = (v << 8n) | BigInt(cptr.ld1u(cptr.add(tmp, i))); buf.v = v; }
      }
      return r;
    }
    const f = fds.get(fd);
    if (!f || !f.data) return -1;
    const avail = Math.min(Number(n), f.data.length - f.pos);
    if (avail <= 0) return 0;
    for (let i = 0; i < avail; i++) cptr.st1(cptr.add(buf, i), f.data[f.pos + i]);
    f.pos += avail;
    return avail;
  };
  g.write = (fd, buf, n) => {
    if (buf && buf.isBox) {
      const tmp = cptr.alloc(Number(n));
      if (typeof buf.v === 'bigint') { let x = buf.v; for (let i = 0; i < Number(n); i++) { cptr.st1(cptr.add(tmp, i), Number(x & 0xFFn)); x >>= 8n; } }
      else { let x = Number(buf.v); for (let i = 0; i < Number(n); i++) { cptr.st1(cptr.add(tmp, i), x & 0xFF); x >>>= 8; } }
      return g.write(fd, tmp, n);
    }
    n = Number(n);
    if (fd === 1 || fd === 2) {
      let s = '';
      for (let i = 0; i < n; i++) s += String.fromCharCode(cptr.ld1u(cptr.add(buf, i)));
      if (fd === 1) out(s); else err(s);
      return n;
    }
    const f = fds.get(fd);
    if (!f) return -1;
    if (!f.write) f.write = true;
    for (let i = 0; i < n; i++) f.written.push(cptr.ld1u(cptr.add(buf, i)));
    return n;
  };
  g.close = (fd) => { fdFlush(fd); fds.delete(fd); return 0; };
  g.lseek = (fd, off, whence) => {
    const f = fds.get(fd);
    if (!f) return -1;
    const len = (f.data || f.written || []).length;
    f.pos = whence === 0 ? Number(off) : whence === 1 ? f.pos + Number(off) : len + Number(off);
    return BigInt(f.pos);
  };
  g.getcwd = (buf, size) => { if (buf && buf.buf !== undefined) { cptr.writeStr(buf, HACKDIR); return buf; } return cptr.lit(HACKDIR); };
  g.access = (p, mode) => realStat(cptr.cstr(p)).exists ? 0 : -1;
  g.stat = (p, sb) => {
    const st = realStat(cptr.cstr(p));
    if (!st.exists) return -1;
    if (sb && sb.buf !== undefined) {
      cptr.stU64(cptr.add(sb, 96), BigInt(st.mtime));
      cptr.stU64(cptr.add(sb, 40), BigInt(st.size));
      cptr.stI32(cptr.add(sb, 4), 0o100644);
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
    if (argp && argp.buf !== undefined) {
      cptr.stI16(cptr.add(argp, 0), 24);
      cptr.stI16(cptr.add(argp, 2), 80);
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
    if (tloc && tloc.isBox) tloc.v = t;
    else if (tloc && tloc.buf !== undefined) cptr.stU64(tloc, t);
    return t;
  };
  g.localtime = (tp) => {
    const t = Number(cptr.ldU64(tp));
    const d = new Date(t * 1000);
    const tm = { sec: d.getSeconds(), min: d.getMinutes(), hour: d.getHours(), mday: d.getDate(), mon: d.getMonth(), year: d.getFullYear() - 1900, wday: d.getDay(), yday: 0, isdst: 0 };
    return makeTm(tm);
  };
  function makeTm(t) {
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
  g.difftime = (a, b) => Number(a) - Number(b);
  g.strftime = (buf, max, fmt, tm) => { cptr.writeStr(buf, cptr.cstr(fmt)); return 0; };
  g.clock = () => 0;
  g.sleep = (s) => 0;
  g.usleep = (us) => 0;

  g.fopen = (p, mode) => {
    p = cptr.cstr(p); mode = cptr.cstr(mode); __trace('fopen', p, mode);
    if (mode.startsWith('w')) { const fd = openFd(p, 'w'); return fd < 0 ? null : { __fd: fd }; }
    const data = realRead(p);
    if (!data) return null;
    const fd = openFd(p, 'r');
    return { __fd: fd };
  };
  g.freopen = (p, mode, f) => g.fopen(p, mode);
  g.fdopen = (fd, mode) => fds.has(fd) ? { __fd: fd } : null;
  g.fclose = (f) => { if (f && f.__fd !== undefined) { fdFlush(f.__fd); fds.delete(f.__fd); } return 0; };
  g.fread = (ptr, size, nmemb, f) => {
    const fd = fds.get(f.__fd);
    if (!fd || !fd.data) return 0n;
    const want = Number(size) * Number(nmemb);
    const avail = Math.min(want, fd.data.length - fd.pos);
    if (avail <= 0) return 0n;
    if (ptr.isBox) {
      const tmp = cptr.alloc(avail);
      tmp.buf.set(fd.data.slice(fd.pos, fd.pos + avail), 0);
      fd.pos += avail;
      if (avail <= 4) { let v = 0; for (let i = avail - 1; i >= 0; i--) v = (v << 8) | tmp.buf[i]; ptr.v = v; }
      else { let v = 0n; for (let i = Math.min(avail, 8) - 1; i >= 0; i--) v = (v << 8n) | BigInt(tmp.buf[i]); ptr.v = v; }
      return BigInt(Math.floor(avail / Number(size)));
    }
    ptr.buf.set(fd.data.slice(fd.pos, fd.pos + avail), ptr.off);
    fd.pos += avail;
    return BigInt(Math.floor(avail / Number(size)));
  };
  g.fwrite = (ptr, size, nmemb, f) => {
    const n = Number(size) * Number(nmemb);
    if (f === g.stdout || f === g.__stdout || f === g.__stdoutp) {
      let s = '';
      for (let i = 0; i < n; i++) s += String.fromCharCode(ptr.buf[ptr.off + i]);
      out(s);
      return BigInt(nmemb);
    }
    if (f === g.stderr || f === g.__stderrp) {
      let s = '';
      for (let i = 0; i < n; i++) s += String.fromCharCode(ptr.buf[ptr.off + i]);
      err(s);
      return BigInt(nmemb);
    }
    const fd = fds.get(f.__fd);
    if (!fd) return 0n;
    if (!fd.write) fd.write = true;
    if (ptr.isBox) {
      if (typeof ptr.v === 'bigint') { let x = ptr.v; for (let i = 0; i < n; i++) { fd.written.push(Number(x & 0xFFn)); x >>= 8n; } }
      else { let x = Number(ptr.v); for (let i = 0; i < n; i++) { fd.written.push(x & 0xFF); x >>>= 8; } }
      return BigInt(nmemb);
    }
    for (let i = 0; i < n; i++) fd.written.push(ptr.buf[ptr.off + i]);
    return BigInt(nmemb);
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
    if (f === g.stdout || f === g.__stdout) { out(String.fromCharCode(c)); return c; }
    if (f === g.stderr || f === g.__stderrp) { err(String.fromCharCode(c)); return c; }
    const fd = fds.get(f.__fd);
    if (fd) { if (!fd.write) fd.write = true; fd.written.push(c & 0xFF); }
    return c;
  };
  g.putchar = (c) => g.fputc(c, g.__stdout);
  g.puts = (s) => { out(cptr.cstr(s) + '\n'); return 0; };
  g.fflush = (f) => { if (f && f.__fd !== undefined) fdFlush(f.__fd); return 0; };
  g.setbuf = (f, buf) => {};
  g.setvbuf = (f, buf, mode, size) => 0;
  g.gettty = () => {};
  g.settty = (s) => {};
  g.setftty = () => {};
  g.insettty = () => 0;
  g.ttyon = () => 0;
  g.ttyoff = () => 0;
  g.fgetc = (f) => { const fd = fds.get(f.__fd); if (!fd || !fd.data || fd.pos >= fd.data.length) return -1; return fd.data[fd.pos++]; };
  g.getc = g.fgetc;
  g.ungetc = (c, f) => { const fd = fds.get(f.__fd); if (fd && fd.pos > 0) { fd.pos--; fd.data[fd.pos] = c & 0xFF; } return c; };
  Error.stackTraceLimit = 50;
  let __eofReads = 0;
  g.getchar = () => {
    if (!inputQueue.length) {
      if (++__eofReads > 200) throw new Error('input exhausted (EOF spin)');
      return -1;
    }
    return inputQueue.shift();
  };
  g.vfprintf = (f, fmt, ap) => { const s = cptr.sprintfCore(fmt, ap && ap.args ? ap.args.slice(ap.i) : []); g.fputs(cptr.lit(s), f); return s.length; };
  g.vprintf = (fmt, ap) => g.vfprintf(g.__stdout, fmt, ap);
  g.fprintf = (f, fmt, ...args) => { const s = cptr.sprintfCore(fmt, args); g.fputs(cptr.lit(s), f); return s.length; };
  g.__stdout = { __stdout: true };
  g.__stdoutp = g.__stdout;
  g.__stderrp = { __stderr: true };
  g.__stdinp = { __stdin: true };
  g.stdout = g.__stdout;
  g.stderr = g.__stderrp;

  g.setupterm = (term, fd, err2) => 0;
  g.tigetstr = (cap) => null;
  g.tigetnum = (cap) => -2;
  g.tigetflag = (cap) => 0;
  g.tputs = (str, affcnt, putc) => { const s = cptr.cstr(str); for (const ch of s) putc(ch.charCodeAt(0)); return 0; };
  g.tgoto = (cm, col, line) => cptr.lit('');
  const TERMCAP_STR = {
    le: '\x08', ho: '\x1b[H', nd: '\x1b[C', up: '\x1b[A', xd: '\x1b[B', do: '\x1b[B',
    ce: '\x1b[K', cd: '\x1b[J', cl: '\x1b[H\x1b[J', cm: '\x1b[%i%d;%dH',
    so: '\x1b[7m', se: '\x1b[m', us: '\x1b[4m', ue: '\x1b[m', ZH: '\x1b[3m', ZR: '\x1b[23m',
    md: '\x1b[1m', mr: '\x1b[7m', mb: '\x1b[5m', mh: '\x1b[2m', me: '\x1b[m',
    ti: '', te: '', ks: '', ke: '', eA: '', Ic: '', vi: '', ve: '', vs: '',
    as: '\x0e', ae: '\x0f', AF: '\x1b[3%dm', Sf: '\x1b[3%dm', AB: '\x1b[4%dm',
  };
  const TERMCAP_NUM = { co: 80, li: 24, sg: -1, ug: -1, Co: 8, pa: 64, NC: 0 };
  const TERMCAP_FLG = { am: 1, bs: 0, os: 0, ul: 0 };
  g.tgetent = (bp, name) => 1;
  g.tgetstr = (cap, area) => {
    const s = TERMCAP_STR[cptr.cstr(cap)];
    if (s === undefined) return null;
    const p = area && area.isBox ? area.v : area ? cptr.ldPtr(area) : null;
    if (!p) return cptr.lit(s);
    cptr.writeStr(p, s);
    const np = cptr.add(p, s.length + 1);
    if (area.isBox) area.v = np; else cptr.stPtr(area, np);
    return p;
  };
  g.tgetnum = (cap) => TERMCAP_NUM[cptr.cstr(cap)] ?? -1;
  g.tgetflag = (cap) => TERMCAP_FLG[cptr.cstr(cap)] ?? 0;
  g.tparm = (fmt, ...args) => {
    const s = cptr.cstr(fmt);
    const p = args.map((a) => Number(a) | 0);
    const stack = [];
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== '%') { out += s[i]; continue; }
      const c = s[++i];
      if (c === '%') out += '%';
      else if (c === 'p') stack.push(p[Number(s[++i]) - 1] | 0);
      else if (c === 'd') out += String(stack.pop() | 0);
      else if (c === 'i') { p[0] = (p[0] | 0) + 1; p[1] = (p[1] | 0) + 1; }
      else if (c === 'c') out += String.fromCharCode(stack.pop() & 0xFF);
      else if (c === '+') { const b = stack.pop(), a = stack.pop(); stack.push(a + b); }
      else if (c === '-') { const b = stack.pop(), a = stack.pop(); stack.push(a - b); }
      else if (c === "'") { stack.push(s.charCodeAt(i + 1)); i += 2; }
    }
    return cptr.lit(out);
  };

  // ---------------------------------------------------------------------------

  cptr.setFdHooks({ read: (fd, buf, n) => g.read(fd, buf, n), write: (fd, buf, n) => g.write(fd, buf, n) });

  let exitCode = null;
  let error = null;
  let rngLog = [];
  try {
    const um = await import('../generated/unixmain.js');
    __trace('boot: calling main()');
    const argvBuf = new Uint8Array(16);
    const argv = cptr.decay(argvBuf);
    cptr.stPtr(argv, cptr.lit('nethack'));
    um.main(1, argv);
  } catch (e) {
    if (e && e.__bootExit !== undefined) exitCode = e.__bootExit;
    else if (e && /input exhausted/.test(String(e.message || e))) exitCode = null; // moves consumed mid-wait: normal segment end
    else error = e;
  }
  try {
    const rnd = await import('../generated/rnd.js');
    if (rnd.getRngLog) rngLog = rnd.getRngLog();
  } catch {}
  persistOverlay();

  // ---- parse nomux markers from stdout ----
  const stdout = stdoutChunks.join('');
  const frames = [];
  {
    let i = 0;
    while (i < stdout.length) {
      const m = stdout.indexOf('\x1b]7777;', i);
      if (m < 0) break;
      const end = stdout.indexOf('\x07', m);
      if (end < 0) break;
      const kv = Object.fromEntries(stdout.slice(m + 7, end).split(';').map((p) => p.split('=')));
      const len = Number(kv.LEN);
      frames.push({
        kind: kv.KIND, seq: Number(kv.SEQ), anim: Number(kv.ANIM),
        cx: Number(kv.CX), cy: Number(kv.CY),
        screen: stdout.slice(end + 1, end + 1 + len),
      });
      i = end + 1 + len;
    }
  }
  const inputFrames = frames.filter((f) => f.kind === 'input');
  const screens = inputFrames.map((f) => f.screen);
  const cursors = inputFrames.map((f) => [f.cx, f.cy, 1]);
  // animation frames grouped per step (frames between input boundaries)
  const animFramesByStep = [];
  {
    let pending = [];
    for (const f of frames) {
      if (f.kind === 'anim') pending.push({ screen: f.screen, cursor: [f.cx, f.cy, 1] });
      else { animFramesByStep.push(pending); pending = []; }
    }
  }

  return { screens, cursors, animFramesByStep, rngLog, stdout, exitCode, error };
}
