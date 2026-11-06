// scanf.js — the scanner behind the port's sscanf/fscanf. Follows Apple's
// vfscanf.c (FreeBSD-derived): what counts as a digit at each step, how a width
// limits it, and when the result is EOF rather than a short count. Checked
// against the real thing by test/libc-real.test.mjs.
//
// `s` and `f` are JS strings of bytes. Returns {assigned, consumed}; assigned
// is -1 for EOF before the first conversion.
import * as cptr from '../cptr.js';

const isSpace = (c) => c === ' ' || (c >= '\t' && c <= '\r');
const digitOf = (c) => {
  const k = c.charCodeAt(0);
  if (k >= 48 && k <= 57) return k - 48;
  if (k >= 97 && k <= 122) return k - 87;
  if (k >= 65 && k <= 90) return k - 55;
  return 99;
};
const I64_MAX = (1n << 63n) - 1n, I64_MIN = -(1n << 63n), U64_MAX = (1n << 64n) - 1n;

/** Value of already-validated digits, saturating the way strtoimax/strtoumax do. */
function convert(text, base, signed) {
  let i = 0, neg = false;
  if (text[0] === '-' || text[0] === '+') { neg = text[0] === '-'; i = 1; }
  if ((base === 16 || base === 0) && text[i] === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X')) { i += 2; base = 16; }
  else if (base === 0) base = text[i] === '0' ? 8 : 10;
  let v = 0n;
  const b = BigInt(base);
  for (; i < text.length; i++) v = v * b + BigInt(digitOf(text[i]));
  if (signed) { if (neg) v = -v; return v > I64_MAX ? I64_MAX : v < I64_MIN ? I64_MIN : v; }
  if (v > U64_MAX) return U64_MAX;
  return BigInt.asUintN(64, neg ? -v : v);
}

function parseSet(f, fi) {
  let negate = false;
  if (f[fi] === '^') { negate = true; fi++; }
  const member = new Set();
  if (f[fi] === ']') { member.add(']'); fi++; }
  while (fi < f.length && f[fi] !== ']') {
    // "a-c" is a range unless the '-' is last or the bounds are out of order.
    if (f[fi + 1] === '-' && fi + 2 < f.length && f[fi + 2] !== ']' && f[fi + 2] >= f[fi]) {
      for (let k = f.charCodeAt(fi); k <= f.charCodeAt(fi + 2); k++) member.add(String.fromCharCode(k));
      fi += 3;
    } else member.add(f[fi++]);
  }
  return { negate, member, next: fi + 1 };
}

export function scanfCore(s, f, args) {
  let si = 0, fi = 0, assigned = 0, argi = 0;
  const matchFailure = () => ({ assigned, consumed: si });
  const inputFailure = () => ({ assigned: assigned || -1, consumed: si });
  const skipWs = () => { while (si < s.length && isSpace(s[si])) si++; };

  while (fi < f.length) {
    const c = f[fi++];
    if (isSpace(c)) { skipWs(); continue; }
    if (c !== '%') {
      if (si >= s.length) return inputFailure();
      if (s[si] !== c) return matchFailure();
      si++;
      continue;
    }
    let suppress = false, width = 0, h = 0, l = 0;
    if (f[fi] === '*') { suppress = true; fi++; }
    while (f[fi] >= '0' && f[fi] <= '9') width = width * 10 + (f.charCodeAt(fi++) - 48);
    while (f[fi] === 'h') { h++; fi++; }
    while (f[fi] === 'l') { l++; fi++; }
    if (f[fi] === 'z' || f[fi] === 't' || f[fi] === 'j') { l = 1; fi++; }
    const spec = f[fi++];

    if (spec === '%') {
      skipWs();
      if (si >= s.length) return inputFailure();
      if (s[si] !== '%') return matchFailure();
      si++;
      continue;
    }
    if (spec === 'n') {
      if (!suppress) cptr.stI32(args[argi++], si);
      continue;
    }
    if (spec === 'c') {
      if (si >= s.length) return inputFailure();
      const n = Math.min(width || 1, s.length - si);
      if (!suppress) {
        // A boxed scalar (an address-taken `char` local) has nothing to offset
        // into: element 0 goes in the box itself.
        const arg = args[argi++];
        for (let i = 0; i < n; i++) cptr.st1(i === 0 ? arg : cptr.add(arg, i), s.charCodeAt(si + i));
        assigned++;
      }
      si += n;
      continue;
    }
    if (spec === '[') {
      const set = parseSet(f, fi);
      fi = set.next;
      if (si >= s.length) return inputFailure();
      const start = si;
      while (si < s.length && set.member.has(s[si]) !== set.negate && (!width || si - start < width)) si++;
      if (si === start) return matchFailure();
      if (!suppress) { cptr.writeStr(args[argi++], s.slice(start, si)); assigned++; }
      continue;
    }
    skipWs();
    if (si >= s.length) return inputFailure();
    if (spec === 's') {
      const start = si;
      while (si < s.length && !isSpace(s[si]) && (!width || si - start < width)) si++;
      if (!suppress) { cptr.writeStr(args[argi++], s.slice(start, si)); assigned++; }
      continue;
    }

    if ('feEgGaA'.includes(spec)) {
      while (s[si] === ' ' || s[si] === '\t' || s[si] === '\n' || s[si] === '\r' || s[si] === '\f' || s[si] === '\v') si++;
      if (si >= s.length) return inputFailure();
      const limit = width ? s.slice(si, si + width) : s.slice(si);
      const m = /^[-+]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|inf(?:inity)?|nan)/i.exec(limit);
      if (!m) return matchFailure();
      si += m[0].length;
      if (!suppress) {
        const t = m[0].toLowerCase().replace(/^\+/, '');
        const v = /nan/.test(t) ? NaN : /inf/.test(t) ? (t[0] === '-' ? -Infinity : Infinity) : Number(t);
        const arg = args[argi++];
        if (l) cptr.stF64(arg, v); else cptr.stF32(arg, v);
        assigned++;
      }
      continue;
    }
    const baseOf = { d: 10, u: 10, i: 0, x: 16, X: 16, o: 8 }[spec];
    if (baseOf === undefined) return matchFailure();
    let base = baseOf;
    let signOk = true, noDigits = true, noNonzero = true, prefixOk = base === 16 || base === 0, sign = 0;
    const start = si, limit = width ? Math.min(s.length, si + width) : s.length;
    scan: while (si < limit) {
      const ch = s[si];
      if (ch === '0') {
        if (base === 0) { base = 8; prefixOk = true; }
        if (noNonzero) { signOk = false; noNonzero = false; noDigits = false; }
        else { signOk = false; prefixOk = false; noDigits = false; }
      } else if (ch >= '1' && ch <= '9') {
        if (base === 0) base = 10;
        if (ch >= '8' && base <= 8) break scan;
        signOk = false; prefixOk = false; noDigits = false;
      } else if ((ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')) {
        if (base <= 10) break scan;
        signOk = false; prefixOk = false; noDigits = false;
      } else if (ch === '+' || ch === '-') {
        if (!signOk) break scan;
        signOk = false; sign = 1;
      } else if (ch === 'x' || ch === 'X') {
        if (!prefixOk || si !== start + 1 + sign) break scan;
        base = 16; prefixOk = false;
      } else break scan;
      si++;
    }
    if (noDigits) {
      if (si > start) si--;       // a lone sign goes back
      return matchFailure();
    }
    if (s[si - 1] === 'x' || s[si - 1] === 'X') si--;   // "0x" with no digits is the 0
    if (!suppress) {
      const v = convert(s.slice(start, si), base, spec === 'd' || spec === 'i');
      const arg = args[argi++];
      if (l) cptr.stU64(arg, BigInt.asUintN(64, v));
      else if (h === 1) { cptr.st1(arg, Number(v & 0xFFn)); cptr.st1(cptr.add(arg, 1), Number((v >> 8n) & 0xFFn)); }
      else if (h >= 2) cptr.st1(arg, Number(v & 0xFFn));
      else cptr.stI32(arg, Number(BigInt.asIntN(32, v)));
      assigned++;
    }
  }
  return { assigned, consumed: si };
}

/** strtol/strtoul core: {value (BigInt), end (offset)}. No conversion leaves end at 0. */
export function strtoCore(str, base, signed) {
  let i = 0;
  while (i < str.length && isSpace(str[i])) i++;
  let neg = false;
  if (str[i] === '-' || str[i] === '+') { neg = str[i] === '-'; i++; }
  const hexPrefix = str[i] === '0' && (str[i + 1] === 'x' || str[i + 1] === 'X') && digitOf(str[i + 2] ?? '!') < 16;
  if ((base === 0 || base === 16) && hexPrefix) { i += 2; base = 16; }
  else if (base === 0) base = str[i] === '0' ? 8 : 10;
  const start = i, b = BigInt(base);
  let v = 0n;
  while (i < str.length && digitOf(str[i]) < base) { v = v * b + BigInt(digitOf(str[i])); i++; }
  if (i === start) return { value: 0n, end: 0 };
  if (signed) {
    if (neg) v = -v;
    return { value: v > I64_MAX ? I64_MAX : v < I64_MIN ? I64_MIN : v, end: i };
  }
  if (v > U64_MAX) return { value: U64_MAX, end: i };
  return { value: BigInt.asUintN(64, neg ? -v : v), end: i };
}
