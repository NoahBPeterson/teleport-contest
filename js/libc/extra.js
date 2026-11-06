// extra.js — standard functions NetHack itself doesn't call, so that any C the
// transpiler accepts can run. Checked against native C by the gates.
import * as cptr from '../cptr.js';
import { strtoCore, strtodCore } from './scanf.js';

const bytesOf = (s) => { const b = new Uint8Array(s.length + 1); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return { buf: b, off: 0 }; };

const WDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** strftime in the C locale. */
function formatTm(fmt, t) {
  const p2 = (v) => String(v).padStart(2, '0');
  const h12 = t.hour % 12 || 12;
  const week = (first) => Math.floor((t.yday + 7 - ((t.wday - first + 7) % 7)) / 7);
  const one = (c) => {
    switch (c) {
      case 'a': return WDAY[t.wday]?.slice(0, 3) ?? '?';
      case 'A': return WDAY[t.wday] ?? '?';
      case 'b': case 'h': return MON[t.mon]?.slice(0, 3) ?? '?';
      case 'B': return MON[t.mon] ?? '?';
      case 'c': return `${one('a')} ${one('b')} ${String(t.mday).padStart(2)} ${one('T')} ${one('Y')}`;
      case 'C': return p2(Math.floor((t.year + 1900) / 100));
      case 'd': return p2(t.mday);
      case 'D': case 'x': return `${one('m')}/${one('d')}/${one('y')}`;
      case 'e': return String(t.mday).padStart(2);
      case 'F': return `${one('Y')}-${one('m')}-${one('d')}`;
      case 'H': return p2(t.hour);
      case 'I': return p2(h12);
      case 'j': return String(t.yday + 1).padStart(3, '0');
      case 'k': return String(t.hour).padStart(2);
      case 'l': return String(h12).padStart(2);
      case 'm': return p2(t.mon + 1);
      case 'M': return p2(t.min);
      case 'n': return '\n';
      case 'p': return t.hour < 12 ? 'AM' : 'PM';
      case 'r': return `${one('I')}:${one('M')}:${one('S')} ${one('p')}`;
      case 'R': return `${one('H')}:${one('M')}`;
      case 'S': return p2(t.sec);
      case 't': return '\t';
      case 'T': case 'X': return `${one('H')}:${one('M')}:${one('S')}`;
      case 'u': return String(t.wday || 7);
      case 'U': return p2(week(0));
      case 'w': return String(t.wday);
      case 'W': return p2(week(1));
      case 'y': return p2(((t.year % 100) + 100) % 100);
      case 'Y': return String(t.year + 1900).padStart(4, '0');
      case 'z': { const o = t.gmtoff ?? 0, a = Math.abs(o); return `${o < 0 ? '-' : '+'}${p2(Math.floor(a / 3600))}${p2(Math.floor(a / 60) % 60)}`; }
      case 'Z': return t.zone ?? 'UTC';
      case '%': return '%';
      case 'g': return p2(((iso().year % 100) + 100) % 100);
      case 'G': return String(iso().year).padStart(4, '0');
      case 'V': return p2(iso().week);
      case 's': return String(Math.floor(Date.UTC(t.year + 1900, t.mon, t.mday, t.hour, t.min, t.sec) / 1000) - (t.gmtoff ?? 0));
      case 'v': return `${one('e')}-${one('b')}-${one('Y')}`;
      case '+': return `${one('a')} ${one('b')} ${one('e')} ${one('T')} ${one('Z')} ${one('Y')}`;
      default: return c; // Darwin prints an unknown conversion's letter
    }
  };
  // ISO 8601 week: weeks start on Monday, and week 1 holds the year's first Thursday
  const iso = () => {
    const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    let year = t.year + 1900;
    const wd = (t.wday + 6) % 7;
    let week = Math.floor((t.yday - wd + 10) / 7);
    if (week < 1) { year--; const d = 365 + (leap(year) ? 1 : 0); week = Math.floor((t.yday + d - wd + 10) / 7); }
    else if (week === 53 && t.yday - wd + 3 >= 365 + (leap(year) ? 1 : 0)) { year++; week = 1; }
    return { year, week };
  };
  // Apple's flags: %-d drops padding, %_d pads with spaces, %0d with zeros
  const NUM = 'CdeGgHIjklMmSUuVWwYy';
  return fmt.replace(/%(?:[EO])?(?:([-_0])(?=[A-Za-z]))?([\s\S])|%$/g, (all, flag, c) => {
    if (c === undefined) return '%';
    const r = one(c);
    if (!flag || !NUM.includes(c)) return r;
    const body = r.replace(/^[ 0]+(?=.)/, '');
    return flag === '-' ? body : body.padStart(r.length, flag === '_' ? ' ' : '0');
  });
}

/** Lanczos log-gamma, positive x. */
function lgam(x) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgam(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
/** erf by its Taylor series, or the continued fraction of erfc past 2.5. */
function erf(x) {
  if (x === 0 || x !== x) return x;
  const a = Math.abs(x);
  if (a >= 6) return Math.sign(x);
  if (a > 2.5) return Math.sign(x) * (1 - erfcBig(a));
  let sum = a, term = a;
  for (let n = 1; n < 200 && Math.abs(term) > 1e-17 * Math.abs(sum); n++) { term *= -a * a / n; sum += term / (2 * n + 1); }
  return Math.sign(x) * (2 / Math.sqrt(Math.PI)) * sum;
}
function erfcBig(a) {
  let f = 0;
  for (let k = 60; k >= 1; k--) f = (k / 2) / (a + f);
  return Math.exp(-a * a) / Math.sqrt(Math.PI) / (a + f);
}
function rintEven(x) {
  if (!Number.isFinite(x)) return x;
  const r = Math.round(x);
  return Math.abs(x - Math.trunc(x)) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
function roundAway(x) { return x < 0 ? -Math.round(-x) : Math.round(x); }
function nextAfter(x, y) {
  if (x !== x || y !== y) return NaN;
  if (x === y) return y;
  if (x === 0) return y > 0 ? 5e-324 : -5e-324;
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, x);
  const up = (y > x) === (x > 0);
  b.setBigInt64(0, b.getBigInt64(0) + (up ? 1n : -1n));
  return b.getFloat64(0);
}
function frexpParts(x) {
  if (x === 0 || !Number.isFinite(x)) return [x, 0];
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, x);
  let e = (b.getUint16(0) >> 4) & 0x7FF;
  if (e === 0) { b.setFloat64(0, x * 2 ** 54); e = ((b.getUint16(0) >> 4) & 0x7FF) - 54; }
  b.setUint16(0, (b.getUint16(0) & 0x800F) | (1022 << 4));
  return [b.getFloat64(0), e - 1022];
}
const ldexp = (x, e) => {
  e = Number(e);
  // in steps, so an extreme exponent doesn't overflow on its way to a normal result
  while (e > 1000) { x *= 2 ** 1000; e -= 1000; }
  while (e < -1000) { x *= 2 ** -1000; e += 1000; }
  return x * 2 ** e;
};

export function installExtraLibc(g) {
  const m1 = {
    acosh: Math.acosh, asinh: Math.asinh, atanh: Math.atanh, cbrt: Math.cbrt, expm1: Math.expm1, log1p: Math.log1p, log2: Math.log2,
    exp2: (x) => 2 ** x, erf, erfc: (x) => (x > 2.5 ? (x >= 28 ? 0 : erfcBig(x)) : 1 - erf(x)),
    lgamma: (x) => (x === 1 || x === 2 ? 0 : x <= 0 && Number.isInteger(x) ? Infinity : lgam(x)),
    tgamma: (x) => {
      if (Number.isInteger(x) && x > 0 && x < 171) { let r = 1; for (let i = 2; i < x; i++) r *= i; return r; }
      return x < 0.5 ? Math.PI / (Math.sin(Math.PI * x) * Math.exp(lgam(1 - x))) : Math.exp(lgam(x));
    },
    logb: (x) => (x === 0 ? -Infinity : Number.isFinite(x) ? frexpParts(x)[1] - 1 : Math.abs(x)),
    nearbyint: rintEven, rint: rintEven, round: roundAway, trunc: Math.trunc,
    acos: Math.acos, asin: Math.asin, atan: Math.atan, ceil: Math.ceil, cos: Math.cos, cosh: Math.cosh, exp: Math.exp, fabs: Math.abs, floor: Math.floor,
    log: Math.log, log10: Math.log10, sin: Math.sin, sinh: Math.sinh, sqrt: Math.sqrt, tan: Math.tan, tanh: Math.tanh,
  };
  const m2 = {
    copysign: (x, y) => (Object.is(y, -0) || y < 0 ? -Math.abs(x) : Math.abs(x)),
    fdim: (x, y) => (x > y ? x - y : x !== x || y !== y ? NaN : 0),
    fmax: (x, y) => (x !== x ? y : y !== y ? x : Math.max(x, y)), fmin: (x, y) => (x !== x ? y : y !== y ? x : Math.min(x, y)),
    fmod: (x, y) => x % y, hypot: Math.hypot, nextafter: nextAfter, pow: Math.pow, atan2: Math.atan2,
    remainder: (x, y) => x - rintEven(x / y) * y,
  };
  // double versions where the game hasn't its own, then the float family over them
  for (const [n, f] of Object.entries(m1)) { g[n] ||= f; g[`${n}f`] = (x) => Math.fround(f(x)); g[`${n}l`] = f; }
  for (const [n, f] of Object.entries(m2)) { g[n] ||= f; g[`${n}f`] = (x, y) => Math.fround(f(x, y)); g[`${n}l`] = f; }
  g.fma = g.fmal = cptr.fma; g.fmaf = cptr.fmaf;
  g.frexp = g.frexpl = (x, e) => { const [m, v] = frexpParts(x); cptr.stI32(e, v); return m; };
  g.frexpf = (x, e) => { const [m, v] = frexpParts(x); cptr.stI32(e, v); return Math.fround(m); };
  g.ldexp = g.ldexpl = g.scalbn = g.scalbnl = g.scalbln = ldexp; g.ldexpf = g.scalbnf = (x, e) => Math.fround(ldexp(x, e));
  g.modf = g.modfl = (x, p) => { const i = Math.trunc(x); cptr.stF64(p, i); return Number.isFinite(x) ? x - i : 0; };
  g.modff = (x, p) => { const i = Math.trunc(x); cptr.stF32(p, i); return Math.fround(Number.isFinite(x) ? x - i : 0); };
  g.ilogb = (x) => (x === 0 ? -2147483648 : Number.isFinite(x) ? frexpParts(x)[1] - 1 : 2147483647);
  g.remquo = (x, y, q) => { const n = rintEven(x / y); cptr.stI32(q, n | 0); return x - n * y; };
  const whole = (f) => (x) => BigInt(f(x));
  g.lround = g.llround = g.lroundf = g.llroundf = whole(roundAway);
  g.lrint = g.llrint = g.lrintf = g.llrintf = whole(rintEven);
  g.strtof = (p, e) => Math.fround(g.strtod(p, e)); g.strtold = (p, e) => g.strtod(p, e);
  g.atoll = (p) => { const m = /^\s*[-+]?\d+/.exec(cptr.cstr(p)); return m ? BigInt.asIntN(64, BigInt(m[0].trim().replace(/^\+/, ''))) : 0n; };
  // strings
  g.strndup = (p, n) => bytesOf(cptr.cstr(p).slice(0, Number(n)));
  g.stpcpy = (d, s) => { const t = cptr.cstr(s); cptr.writeStr(d, t); return cptr.add(d, t.length); };
  g.stpncpy = (d, s, n) => { const t = cptr.cstr(s).slice(0, Number(n)); g.strncpy(d, s, n); return cptr.add(d, t.length); };
  g.strcoll = (a, b) => g.strcmp(a, b);
  g.strxfrm = (d, s, n) => { const t = cptr.cstr(s); if (Number(n) > 0) cptr.writeStr(d, t.slice(0, Number(n) - 1)); return BigInt(t.length); };
  g.strsep = (sp, delim) => {
    const s = cptr.ldPtr(sp);
    if (!s) return null;
    const t = cptr.cstr(s), d = cptr.cstr(delim);
    let i = 0;
    while (i < t.length && !d.includes(t[i])) i++;
    if (i === t.length) cptr.stPtr(sp, null);
    else { cptr.st1(cptr.add(s, i), 0); cptr.stPtr(sp, cptr.add(s, i + 1)); }
    return s;
  };
  g.strlcpy = (d, s, n) => { const t = cptr.cstr(s); if (Number(n) > 0) cptr.writeStr(d, t.slice(0, Number(n) - 1)); return BigInt(t.length); };
  g.strlcat = (d, s, n) => {
    const a = cptr.cstr(d), t = cptr.cstr(s), room = Number(n) - a.length - 1;
    if (room > 0) cptr.writeStr(cptr.add(d, a.length), t.slice(0, room));
    return BigInt(Math.min(a.length, Number(n)) + t.length);
  };
  g.isblank = (c) => (c === 32 || c === 9 ? 1 : 0);
  g.__builtin___stpncpy_chk = (d, s, n) => g.stpncpy(d, s, n);
  g.__builtin___strlcpy_chk = (d, s, n) => g.strlcpy(d, s, n);
  g.__builtin___strlcat_chk = (d, s, n) => g.strlcat(d, s, n);
  g.setlocale = () => cptr.lit('C');
  // struct lconv in the C locale: ten char* fields of "" (decimal_point "."), then CHAR_MAX bytes
  g.localeconv = () => {
    const p = cptr.malloc(96), empty = cptr.lit('');
    for (let i = 0; i < 10; i++) cptr.stPtr(cptr.add(p, i * 8), i === 0 ? cptr.lit('.') : empty);
    for (let i = 80; i < 96; i++) cptr.st1(cptr.add(p, i), 127);
    return p;
  };
  g.alloca = g.__builtin_alloca = (n) => cptr.malloc(n);
  g.__builtin_alloca_with_align = (n) => cptr.malloc(n);
  // Darwin's messages
  const ERRS = ['Undefined error: 0', 'Operation not permitted', 'No such file or directory', 'No such process', 'Interrupted system call', 'Input/output error', 'Device not configured', 'Argument list too long', 'Exec format error', 'Bad file descriptor', 'No child processes', 'Resource deadlock avoided', 'Cannot allocate memory', 'Permission denied', 'Bad address', 'Block device required', 'Resource busy', 'File exists', 'Cross-device link', 'Operation not supported by device', 'Not a directory', 'Is a directory', 'Invalid argument', 'Too many open files in system', 'Too many open files', 'Inappropriate ioctl for device', 'Text file busy', 'File too large', 'No space left on device', 'Illegal seek', 'Read-only file system', 'Too many links', 'Broken pipe', 'Numerical argument out of domain', 'Result too large', 'Resource temporarily unavailable', 'Operation now in progress', 'Operation already in progress', 'Socket operation on non-socket', 'Destination address required', 'Message too long', 'Protocol wrong type for socket', 'Protocol not available', 'Protocol not supported', 'Socket type not supported', 'Operation not supported', 'Protocol family not supported', 'Address family not supported by protocol family', 'Address already in use', 'Can\'t assign requested address', 'Network is down', 'Network is unreachable', 'Network dropped connection on reset', 'Software caused connection abort', 'Connection reset by peer', 'No buffer space available', 'Socket is already connected', 'Socket is not connected', 'Can\'t send after socket shutdown', 'Too many references: can\'t splice', 'Operation timed out', 'Connection refused', 'Too many levels of symbolic links', 'File name too long', 'Host is down', 'No route to host', 'Directory not empty', 'Too many processes', 'Too many users', 'Disc quota exceeded', 'Stale NFS file handle', 'Too many levels of remote in path', 'RPC struct is bad', 'RPC version wrong', 'RPC prog. not avail', 'Program version wrong', 'Bad procedure for program', 'No locks available', 'Function not implemented', 'Inappropriate file type or format', 'Authentication error', 'Need authenticator', 'Device power is off', 'Device error', 'Value too large to be stored in data type', 'Bad executable (or shared library)', 'Bad CPU type in executable', 'Shared library version mismatch', 'Malformed Mach-o file', 'Operation canceled', 'Identifier removed', 'No message of desired type', 'Illegal byte sequence', 'Attribute not found', 'Bad message', 'EMULTIHOP (Reserved)', 'No message available on STREAM', 'ENOLINK (Reserved)', 'No STREAM resources', 'Not a STREAM', 'Protocol error', 'STREAM ioctl timeout', 'Operation not supported on socket', 'Policy not found', 'State not recoverable', 'Previous owner died', 'Interface output queue is full', 'Capabilities insufficient', 'Unknown error: 108', 'Unknown error: 109'];
  g.strerror = (e) => cptr.lit(ERRS[Number(e)] ?? `Unknown error: ${Number(e)}`);
  g.system = () => -1;
  const onExit = [];
  g.atexit = (f) => { onExit.push(f); return 0; };
  g.__runAtexit = () => { while (onExit.length) onExit.pop()(); };
  // time. No zone in these programs' world, so gmtime is the plain calendar.
  const tmFields = (t) => ({ sec: cptr.ldI32(cptr.add(t, 0)), min: cptr.ldI32(cptr.add(t, 4)), hour: cptr.ldI32(cptr.add(t, 8)), mday: cptr.ldI32(cptr.add(t, 12)), mon: cptr.ldI32(cptr.add(t, 16)), year: cptr.ldI32(cptr.add(t, 20)), wday: cptr.ldI32(cptr.add(t, 24)), yday: cptr.ldI32(cptr.add(t, 28)), gmtoff: Number(cptr.ldI64(cptr.add(t, 40))), zone: (() => { const z = cptr.ldPtr(cptr.add(t, 48)); return z ? cptr.cstr(z) : ''; })() });
  g.strftime = (buf, max, fmt, tm) => {
    const s = formatTm(cptr.cstr(fmt), tmFields(tm));
    if (s.length >= Number(max)) return 0n;
    cptr.writeStr(buf, s);
    return BigInt(s.length);
  };
  g.asctime = (tm) => cptr.lit(`${formatTm('%a %b %e %T %Y', tmFields(tm))}\n`);
  g.ctime = (tp) => g.asctime(g.localtime(tp));
  // A program's whole life, for a standalone C program: exit() and returning from
  // main both end in the atexit handlers, last registered first.
  g.__standaloneMain = (main) => {
    let rc = 0;
    // nothing to read: stdin is at its end
    const isIn = (f) => f && f.__stdin;
    const orig = { fgets: g.fgets, fgetc: g.fgetc, getc: g.getc, feof: g.feof };
    let inEof = false;
    g.getchar = () => { inEof = true; return -1; };
    g.fgets = (b, n, f) => { if (isIn(f)) { inEof = true; return null; } return orig.fgets(b, n, f); };
    g.fgetc = (f) => { if (isIn(f)) { inEof = true; return -1; } return orig.fgetc(f); };
    g.getc = (f) => { if (isIn(f)) { inEof = true; return -1; } return orig.getc(f); };
    g.feof = (f) => (isIn(f) ? (inEof ? 1 : 0) : orig.feof(f));
    g.scanf = () => { inEof = true; return -1; };
    // The game's mktime is pinned to the recorder's offset. A program gets the real
    // thing: tm_isdst read as a hint, fields normalized and written back.
    g.mktime = (tm) => {
      const f = (o) => cptr.ldI32(cptr.add(tm, o));
      const naive = Math.floor(Date.UTC(f(20) + 1900, f(16), f(12), f(8), f(4), f(0)) / 1000), dst = f(32);
      let sec;
      if (dst > 0) sec = naive + 4 * 3600;
      else if (dst === 0) sec = naive + 5 * 3600;
      else {
        const box = cptr.malloc(8), wall = (s) => { cptr.stI64(box, BigInt(s)); const t = g.localtime(box); return Math.floor(Date.UTC(cptr.ldI32(cptr.add(t, 20)) + 1900, cptr.ldI32(cptr.add(t, 16)), cptr.ldI32(cptr.add(t, 12)), cptr.ldI32(cptr.add(t, 8)), cptr.ldI32(cptr.add(t, 4)), cptr.ldI32(t)) / 1000); };
        const est = naive + 5 * 3600, edt = naive + 4 * 3600;
        sec = wall(edt) === naive ? edt : est; // a repeated hour reads as daylight time, its first pass; a skipped one as standard
      }
      const box2 = cptr.malloc(8);
      cptr.stI64(box2, BigInt(sec));
      g.localtime_r(box2, tm);
      return BigInt(sec);
    };
    // argc, argv, envp, as a real process sees them
    const argv = cptr.malloc(16), envp = cptr.malloc(8);
    cptr.stPtr(argv, cptr.lit('program'));
    try { rc = main(1, argv, envp); } catch (e) { if (e && e.__bootExit !== undefined) rc = e.__bootExit; else throw e; }
    try { g.__runAtexit(); } catch (e) { if (!(e && e.__bootExit !== undefined)) throw e; }
    return rc;
  };
  // <complex.h>: a value is {re, im}
  for (const sfx of ['', 'f', 'l']) {
    const r = sfx === 'f' ? Math.fround : (x) => x;
    g[`creal${sfx}`] = (z) => z.re; g[`cimag${sfx}`] = (z) => z.im;
    g[`cabs${sfx}`] = (z) => r(Math.hypot(z.re, z.im)); g[`carg${sfx}`] = (z) => r(Math.atan2(z.im, z.re));
    g[`conj${sfx}`] = (z) => ({ re: z.re, im: -z.im });
    g[`cexp${sfx}`] = (z) => { const e = Math.exp(z.re); return { re: r(e * Math.cos(z.im)), im: r(e * Math.sin(z.im)) }; };
    g[`csqrt${sfx}`] = (z) => { const m = Math.hypot(z.re, z.im); const a = Math.sqrt((m + Math.abs(z.re)) / 2), b = a === 0 ? 0 : Math.abs(z.im) / (2 * a); return z.re >= 0 ? { re: r(a), im: r(Math.sign(z.im || 1) * b) } : { re: r(b), im: r(Math.sign(z.im || 1) * a) }; };
  }
  // <wchar.h>: elements are 4 bytes
  const wlen = (p) => { let n = 0; while (cptr.ldI32(cptr.add(p, n * 4)) !== 0) n++; return n; };
  g.wcslen = (p) => BigInt(wlen(p));
  g.wcscpy = (d, s) => { const n = wlen(s); for (let i = 0; i <= n; i++) cptr.stI32(cptr.add(d, i * 4), cptr.ldI32(cptr.add(s, i * 4))); return d; };
  g.wcscat = (d, s) => { g.wcscpy(cptr.add(d, wlen(d) * 4), s); return d; };
  g.wcscmp = (a, b) => { for (let i = 0; ; i++) { const x = cptr.ldI32(cptr.add(a, i * 4)), y = cptr.ldI32(cptr.add(b, i * 4)); if (x !== y) return x < y ? -1 : 1; if (x === 0) return 0; } };
  g.wcschr = (p, c) => { for (let i = 0; ; i++) { const x = cptr.ldI32(cptr.add(p, i * 4)); if (x === c) return cptr.add(p, i * 4); if (x === 0) return null; } };
  // Darwin's FP_NAN, FP_INFINITE, FP_ZERO, FP_NORMAL, FP_SUBNORMAL
  const fpclass = (x, least) => (x !== x ? 1 : Math.abs(x) === Infinity ? 2 : x === 0 ? 3 : Math.abs(x) < least ? 5 : 4);
  g.__fpclassifyd = g.__fpclassifyl = (x) => fpclass(x, 2.2250738585072014e-308);
  g.__fpclassifyf = (x) => fpclass(x, 1.1754943508222875e-38);
  // clang's builtins, as <math.h> macros and fortified headers expand to them
  g.__builtin_isnan = (x) => (x !== x ? 1 : 0);
  g.__builtin_isinf = (x) => (Math.abs(x) === Infinity ? 1 : 0);
  g.__builtin_isfinite = (x) => (Number.isFinite(x) ? 1 : 0);
  g.__builtin_signbit = (x) => (x < 0 || Object.is(x, -0) ? 1 : 0);
  // clang's builtins, as <math.h> macros and fortified headers expand to them
  for (const n of ['nan', 'nanf', 'nanl']) g[`__builtin_${n}`] = () => NaN;
  for (const n of ['inf', 'inff', 'infl', 'huge_val', 'huge_valf', 'huge_vall']) g[`__builtin_${n}`] = () => Infinity;
  for (const n of ['fabs', 'fabsf', 'fabsl']) g[`__builtin_${n}`] = Math.abs;
  g.__builtin___memmove_chk = (d, s, n) => g.memmove(d, s, n);
  g.__builtin___stpcpy_chk = (d, s) => g.stpcpy(d, s);
  g.__builtin_unreachable = () => { throw new Error('__builtin_unreachable reached'); };
  const u64 = (v) => BigInt.asUintN(64, BigInt(v));
  const pop = (v) => { let c = 0; for (let x = u64(v); x; x &= x - 1n) c++; return c; };
  const clz = (v, w) => { let c = 0; for (let m = 1n << BigInt(w - 1); m && !(u64(v) & m); m >>= 1n) c++; return c; };
  const ctz = (v, w) => { let c = 0; for (let x = u64(v); c < w && !(x & 1n); x >>= 1n) c++; return c; };
  g.__builtin_popcount = (v) => pop(v >>> 0); g.__builtin_popcountl = g.__builtin_popcountll = pop;
  g.__builtin_clz = (v) => clz(v >>> 0, 32); g.__builtin_clzl = g.__builtin_clzll = (v) => clz(v, 64);
  g.__builtin_ctz = (v) => ctz(v >>> 0, 32); g.__builtin_ctzl = g.__builtin_ctzll = (v) => ctz(v, 64);
  g.__builtin_ffs = g.ffs = (v) => ((v | 0) === 0 ? 0 : ctz(v >>> 0, 32) + 1);
  g.__builtin_bswap16 = (v) => ((v & 0xFF) << 8) | ((v >> 8) & 0xFF);
  g.__builtin_bswap32 = (v) => (((v & 0xFF) << 24) | ((v & 0xFF00) << 8) | ((v >> 8) & 0xFF00) | ((v >>> 24) & 0xFF)) >>> 0;
  g.__builtin_bswap64 = (v) => { let r = 0n, x = u64(v); for (let i = 0; i < 8; i++) { r = (r << 8n) | (x & 0xFFn); x >>= 8n; } return r; };
  // div_t/ldiv_t come back by value, which means a location holding quot then rem
  const quotRem = (put, size) => (a, b) => {
    const p = cptr.malloc(2 * size);
    put(p, a / b, cptr.add(p, size), a % b);
    return p;
  };
  g.div = (a, b) => quotRem((p, q, r, m) => { cptr.stI32(p, Math.trunc(q) | 0); cptr.stI32(r, m | 0); }, 4)(Number(a), Number(b));
  g.ldiv = g.lldiv = (a, b) => quotRem((p, q, r, m) => { cptr.stI64(p, q); cptr.stI64(r, m); }, 8)(BigInt(a), BigInt(b));
  g.calloc = (n, sz) => cptr.malloc(Number(n) * Number(sz));
  g.strdup = (p) => bytesOf(cptr.cstr(p));
  g.strnlen = (p, n) => { n = Number(n); let i = 0; while (i < n && p.buf[p.off + i]) i++; return BigInt(i); };
  g.strncat = (d, s, n) => {
    const dl = Number(cptr.strlen(d)), src = cptr.cstr(s).slice(0, Number(n));
    for (let i = 0; i < src.length; i++) d.buf[d.off + dl + i] = src.charCodeAt(i);
    d.buf[d.off + dl + src.length] = 0;
    return d;
  };
  let tokNext = null;
  g.strtok = (s, delim) => {
    let p = s ?? tokNext;
    if (!p) return null;
    const ds = cptr.cstr(delim);
    const has = (o) => ds.includes(String.fromCharCode(p.buf[o]));
    let o = p.off;
    while (p.buf[o] && has(o)) o++;
    if (!p.buf[o]) { tokNext = null; return null; }
    const start = o;
    while (p.buf[o] && !has(o)) o++;
    if (p.buf[o]) { p.buf[o] = 0; tokNext = { buf: p.buf, off: o + 1 }; } else tokNext = null;
    return { buf: p.buf, off: start };
  };
  const seterr = (n) => { if (n && g.__errnoBuf) { g.__errnoBuf[0] = n & 255; g.__errnoBuf[1] = g.__errnoBuf[2] = g.__errnoBuf[3] = 0; } };
  g.strtoll = (p, e, base) => { const r = strtoCore(cptr.cstr(p), Number(base), true); seterr(r.errno); if (e) cptr.stPtr(e, cptr.add(p, r.end)); return r.value; };
  g.strtoull = (p, e, base) => { const r = strtoCore(cptr.cstr(p), Number(base), false); seterr(r.errno); if (e) cptr.stPtr(e, cptr.add(p, r.end)); return r.value; };
  g.strtod = (p, e) => {
    const r = strtodCore(cptr.cstr(p));
    seterr(r.errno);
    if (e) cptr.stPtr(e, r.end ? cptr.add(p, r.end) : p);
    return r.value;
  };
  g.llabs = (x) => { const v = BigInt.asIntN(64, BigInt(x)); return v < 0n ? BigInt.asIntN(64, -v) : v; };
  // Apple's rand(): Park-Miller over a 32-bit state (0 is replaced by 123459876)
  let randState = 1;
  g.srand = (s) => { randState = Number(s) >>> 0; };
  g.rand = () => {
    let x = randState === 0 ? 123459876 : randState % 0x7fffffff;
    const hi = Math.trunc(x / 127773), lo = x % 127773;
    x = 16807 * lo - 2836 * hi;
    if (x < 0) x += 0x7fffffff;
    randState = x >>> 0;
    return x % 0x80000000;
  };
  g.bsearch = (key, base, nmemb, size, compar) => {
    let lo = 0, hi = Number(nmemb), sz = Number(size);
    while (lo < hi) {
      const mid = (lo + hi) >>> 1, el = cptr.add(base, mid * sz);
      const c = Number(compar(key, el));
      if (c === 0) return el;
      if (c < 0) hi = mid; else lo = mid + 1;
    }
    return null;
  };
  g.isgraph = (c) => (c > 32 && c < 127 ? 1 : 0);
  g.isxdigit = (c) => ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102) ? 1 : 0);
  for (const f of ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'exp', 'log', 'log10', 'log2', 'sinh', 'cosh', 'tanh', 'cbrt', 'hypot', 'trunc']) g[f] = Math[f];
  g.round = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));
}
