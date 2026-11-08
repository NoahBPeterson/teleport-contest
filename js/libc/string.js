// string.js — C-faithful string/memory/ctype library on the CPtr model.
//
// Mirrors the libc on the LP64/clang target (Darwin libc, C locale):
//   * operands are CPtr ({ buf: Uint8Array, off }) pointers into byte buffers;
//   * C strings are NUL-terminated runs of bytes; char compares are unsigned;
//   * string compare functions return the UNSIGNED-char difference at the
//     first mismatch (not just a sign), exactly like the C library;
//   * strcasecmp/strncasecmp compare tolower()'d unsigned chars;
//   * size_t returns (strlen/strspn/strcspn) are BigInt per the project ABI;
//   * memory functions never stop at NUL — they honor the byte count;
//   * ctype predicates return 0/1; toupper/tolower leave non-A-Z unchanged
//     and pass EOF (-1) through untouched (C locale, ASCII only).
//
// Plain ES6, no dependencies.

/** @typedef {{ buf: Uint8Array, off: number }} CPtr */

// ------------------------------------------------------------------ strings ----

// C ref: strlen(3) — length of the string s, not counting the NUL.
/** @param {CPtr} s @returns {bigint} size_t */
export function strlen(s) {
  let n = 0;
  while (s.buf[s.off + n] !== 0) n++;
  return BigInt(n);
}

// C ref: strcpy(3) — copy the string src (including NUL) into dst.
/** @param {CPtr} dst @param {CPtr} src @returns {CPtr} dst */
export function strcpy(dst, src) {
  let i = 0, c;
  do {
    c = src.buf[src.off + i];
    dst.buf[dst.off + i] = c;
    i++;
  } while (c !== 0);
  return dst;
}

// C ref: strncpy(3) — copy at most n bytes from src; if src ends before n,
// pad dst with NULs until exactly n bytes are written. Not NUL-terminated
// when strlen(src) >= n.
/** @param {CPtr} dst @param {CPtr} src @param {number|bigint} n @returns {CPtr} dst */
export function strncpy(dst, src, n) {
  n = Number(n);
  let i = 0;
  for (; i < n && src.buf[src.off + i] !== 0; i++) dst.buf[dst.off + i] = src.buf[src.off + i];
  for (; i < n; i++) dst.buf[dst.off + i] = 0;
  return dst;
}

// C ref: strcat(3) — append a copy of src to the end of dst.
/** @param {CPtr} dst @param {CPtr} src @returns {CPtr} dst */
export function strcat(dst, src) {
  strcpy({ buf: dst.buf, off: dst.off + Number(strlen(dst)) }, src);
  return dst;
}

// C ref: strncat(3) — append at most n chars from src, always NUL-terminating.
/** @param {CPtr} dst @param {CPtr} src @param {number|bigint} n @returns {CPtr} dst */
export function strncat(dst, src, n) {
  n = Number(n);
  let d = dst.off + Number(strlen(dst));
  let i = 0;
  while (i < n && src.buf[src.off + i] !== 0) {
    dst.buf[d] = src.buf[src.off + i];
    d++;
    i++;
  }
  dst.buf[d] = 0;
  return dst;
}

// C ref: strcmp(3) — compare as unsigned char; return the difference at the
// first mismatch (0 if the strings are equal).
/** @param {CPtr} a @param {CPtr} b @returns {number} */
export function strcmp(a, b) {
  for (let i = 0; ; i++) {
    const ca = a.buf[a.off + i], cb = b.buf[b.off + i];
    if (ca !== cb) return ca - cb;
    if (ca === 0) return 0;
  }
}

// C ref: strncmp(3) — like strcmp, but at most n bytes.
/** @param {CPtr} a @param {CPtr} b @param {number|bigint} n @returns {number} */
export function strncmp(a, b, n) {
  n = Number(n);
  for (let i = 0; i < n; i++) {
    const ca = a.buf[a.off + i], cb = b.buf[b.off + i];
    if (ca !== cb) return ca - cb;
    if (ca === 0) return 0;
  }
  return 0;
}

// C ref: strcasecmp(3) — case-insensitive strcmp (C locale, ASCII folding).
/** @param {CPtr} a @param {CPtr} b @returns {number} */
export function strcasecmp(a, b) {
  for (let i = 0; ; i++) {
    const ca = a.buf[a.off + i], cb = b.buf[b.off + i];
    const la = tolower(ca), lb = tolower(cb);
    if (la !== lb) return la - lb;
    if (ca === 0) return 0;
  }
}

// C ref: strncasecmp(3) — like strcasecmp, but at most n bytes.
/** @param {CPtr} a @param {CPtr} b @param {number|bigint} n @returns {number} */
export function strncasecmp(a, b, n) {
  n = Number(n);
  for (let i = 0; i < n; i++) {
    const ca = a.buf[a.off + i], cb = b.buf[b.off + i];
    const la = tolower(ca), lb = tolower(cb);
    if (la !== lb) return la - lb;
    if (ca === 0) return 0;
  }
  return 0;
}

// C ref: strchr(3) — pointer to the first occurrence of c (as a char, so
// c == 0 matches the terminating NUL), or null.
/** @param {CPtr} s @param {number} c @returns {CPtr|null} */
export function strchr(s, c) {
  c = Number(c) & 0xFF;
  for (let i = s.off; ; i++) {
    if (s.buf[i] === c) return { buf: s.buf, off: i };
    if (s.buf[i] === 0) return null;
  }
}

// C ref: strrchr(3) — pointer to the LAST occurrence of c (NUL included when
// c == 0), or null.
/** @param {CPtr} s @param {number} c @returns {CPtr|null} */
export function strrchr(s, c) {
  c = Number(c) & 0xFF;
  let found = null;
  for (let i = s.off; ; i++) {
    if (s.buf[i] === c) found = { buf: s.buf, off: i };
    if (s.buf[i] === 0) return found;
  }
}

// C ref: strstr(3) — pointer to the first occurrence of the string needle in
// the string haystack (empty needle -> haystack), or null.
/** @param {CPtr} haystack @param {CPtr} needle @returns {CPtr|null} */
export function strstr(haystack, needle) {
  if (needle.buf[needle.off] === 0) return haystack;
  outer:
  for (let i = haystack.off; haystack.buf[i] !== 0; i++) {
    for (let j = 0; ; j++) {
      const c = needle.buf[needle.off + j];
      if (c === 0) return { buf: haystack.buf, off: i };
      if (haystack.buf[i + j] !== c) continue outer;
    }
  }
  return null;
}

// C ref: strspn(3) — length of the initial segment of s consisting only of
// characters in accept.
/** @param {CPtr} s @param {CPtr} accept @returns {bigint} size_t */
export function strspn(s, accept) {
  const acc = new Set();
  for (let i = accept.off; accept.buf[i] !== 0; i++) acc.add(accept.buf[i]);
  let n = 0;
  for (let i = s.off; s.buf[i] !== 0; i++, n++) if (!acc.has(s.buf[i])) break;
  return BigInt(n);
}

// C ref: strcspn(3) — length of the initial segment of s consisting only of
// characters NOT in reject.
/** @param {CPtr} s @param {CPtr} reject @returns {bigint} size_t */
export function strcspn(s, reject) {
  const rej = new Set();
  for (let i = reject.off; reject.buf[i] !== 0; i++) rej.add(reject.buf[i]);
  let n = 0;
  for (let i = s.off; s.buf[i] !== 0; i++, n++) if (rej.has(s.buf[i])) break;
  return BigInt(n);
}

// C ref: strpbrk(3) — pointer to the first character of s that is in accept,
// or null.
/** @param {CPtr} s @param {CPtr} accept @returns {CPtr|null} */
export function strpbrk(s, accept) {
  const acc = new Set();
  for (let i = accept.off; accept.buf[i] !== 0; i++) acc.add(accept.buf[i]);
  for (let i = s.off; s.buf[i] !== 0; i++) if (acc.has(s.buf[i])) return { buf: s.buf, off: i };
  return null;
}

// ------------------------------------------------------------------ memory ----

// C ref: memcpy(3) — copy n bytes from src to dst (overlap undefined).
/** @param {CPtr} dst @param {CPtr} src @param {number|bigint} n @returns {CPtr} dst */
export function memcpy(dst, src, n) {
  n = Number(n);
  dst.buf.set(src.buf.slice(src.off, src.off + n), dst.off);
  return dst;
}

// C ref: memmove(3) — copy n bytes; correct for overlapping ranges.
/** @param {CPtr} dst @param {CPtr} src @param {number|bigint} n @returns {CPtr} dst */
export function memmove(dst, src, n) {
  n = Number(n);
  dst.buf.set(src.buf.slice(src.off, src.off + n), dst.off);
  return dst;
}

// C ref: memset(3) — fill n bytes of dst with (unsigned char) c.
/** @param {CPtr} dst @param {number} c @param {number|bigint} n @returns {CPtr} dst */
export function memset(dst, c, n) {
  n = Number(n);
  dst.buf.fill(Number(c) & 0xFF, dst.off, dst.off + n);
  return dst;
}

// C ref: memcmp(3) — compare n bytes as unsigned char; return the difference
// at the first mismatch, or 0.
/** @param {CPtr} a @param {CPtr} b @param {number|bigint} n @returns {number} */
export function memcmp(a, b, n) {
  n = Number(n);
  for (let i = 0; i < n; i++) {
    const ca = a.buf[a.off + i], cb = b.buf[b.off + i];
    if (ca !== cb) return ca - cb;
  }
  return 0;
}

// C ref: memchr(3) — pointer to the first occurrence of (unsigned char) c in
// the first n bytes, or null.
/** @param {CPtr} p @param {number} c @param {number|bigint} n @returns {CPtr|null} */
export function memchr(p, c, n) {
  n = Number(n);
  c = Number(c) & 0xFF;
  for (let i = 0; i < n; i++) {
    if (p.buf[p.off + i] === c) return { buf: p.buf, off: p.off + i };
  }
  return null;
}

// ------------------------------------------------------------------ ctype ----
// C locale: ASCII only. Arguments are the int passed by C (byte value 0..255,
// or EOF = -1, which no predicate matches and which toupper/tolower return
// unchanged). Out-of-range values are undefined in C; not relied upon.

// C ref: isalpha(3)
/** @param {number} c @returns {number} */
export function isalpha(c) {
  return (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) ? 1 : 0;
}

// C ref: isdigit(3)
/** @param {number} c @returns {number} */
export function isdigit(c) {
  return c >= 0x30 && c <= 0x39 ? 1 : 0;
}

// C ref: isalnum(3)
/** @param {number} c @returns {number} */
export function isalnum(c) {
  return isalpha(c) || isdigit(c);
}

// C ref: isspace(3)
/** @param {number} c @returns {number} */
export function isspace(c) {
  return c === 0x20 || (c >= 0x09 && c <= 0x0D) ? 1 : 0;
}

// C ref: isupper(3)
/** @param {number} c @returns {number} */
export function isupper(c) {
  return c >= 0x41 && c <= 0x5A ? 1 : 0;
}

// C ref: islower(3)
/** @param {number} c @returns {number} */
export function islower(c) {
  return c >= 0x61 && c <= 0x7A ? 1 : 0;
}

// C ref: isxdigit(3)
/** @param {number} c @returns {number} */
export function isxdigit(c) {
  return isdigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66) ? 1 : 0;
}

// C ref: toupper(3)
/** @param {number} c @returns {number} */
export function toupper(c) {
  return c >= 0x61 && c <= 0x7A ? c - 0x20 : c;
}

// C ref: tolower(3)
/** @param {number} c @returns {number} */
export function tolower(c) {
  return c >= 0x41 && c <= 0x5A ? c + 0x20 : c;
}
