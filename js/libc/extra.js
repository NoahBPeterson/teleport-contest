// extra.js — standard functions NetHack itself doesn't call, so that any C the
// transpiler accepts can run. Checked against native C by the gates.
import * as cptr from '../cptr.js';
import { strtoCore } from './scanf.js';

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
      case 'Y': return String(t.year + 1900);
      case 'z': return '+0000';
      case 'Z': return 'UTC';
      case '%': return '%';
      default: return `%${c}`;
    }
  };
  return fmt.replace(/%[EO]?(.)/g, (_, c) => one(c));
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
  g.system = () => -1;
  const onExit = [];
  g.atexit = (f) => { onExit.push(f); return 0; };
  g.__runAtexit = () => { while (onExit.length) onExit.pop()(); };
  // time. No zone in these programs' world, so gmtime is the plain calendar.
  const tmFields = (t) => ({ sec: cptr.ldI32(cptr.add(t, 0)), min: cptr.ldI32(cptr.add(t, 4)), hour: cptr.ldI32(cptr.add(t, 8)), mday: cptr.ldI32(cptr.add(t, 12)), mon: cptr.ldI32(cptr.add(t, 16)), year: cptr.ldI32(cptr.add(t, 20)), wday: cptr.ldI32(cptr.add(t, 24)), yday: cptr.ldI32(cptr.add(t, 28)) });
  g.gmtime = (tp) => {
    const d = new Date(Number(cptr.ldI64(tp)) * 1000);
    const p = cptr.malloc(56);
    const year = d.getUTCFullYear();
    [d.getUTCSeconds(), d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth(), year - 1900, d.getUTCDay(), Math.floor((d - Date.UTC(year, 0, 1)) / 86400000), 0].forEach((v, i) => cptr.stI32(cptr.add(p, i * 4), v));
    return p;
  };
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
  g.__standaloneMain = (main, ...args) => {
    let rc = 0;
    try { rc = main(...args); } catch (e) { if (e && e.__bootExit !== undefined) rc = e.__bootExit; else throw e; }
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
  g.strtoll = (p, e, base) => { const r = strtoCore(cptr.cstr(p), Number(base), true); if (e) cptr.stPtr(e, cptr.add(p, r.end)); return r.value; };
  g.strtoull = (p, e, base) => { const r = strtoCore(cptr.cstr(p), Number(base), false); if (e) cptr.stPtr(e, cptr.add(p, r.end)); return r.value; };
  g.strtod = (p, e) => {
    const s = cptr.cstr(p);
    const m = s.match(/^\s*[-+]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|inf(?:inity)?|nan)/i);
    if (!m) { if (e) cptr.stPtr(e, p); return 0; }
    if (e) cptr.stPtr(e, cptr.add(p, m[0].length));
    const t = m[0].trim().toLowerCase().replace(/^\+/, '');
    if (/nan/.test(t)) return NaN;
    if (/inf/.test(t)) return t[0] === '-' ? -Infinity : Infinity;
    return Number(t);
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
