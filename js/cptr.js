// cptr.js — C pointer model + libc string/stdio shims for transpiled code.
//
// Representation (memory model v0.5, per tools/c2js/DESIGN.md):
//   A C pointer value is a CPtr: { buf, off } where buf is a Uint8Array
//   (byte buffer) and off is a byte offset. NULL is null. Pointer values
//   are IMMUTABLE: never mutate .off on a shared pointer; cptr.add()
//   returns a fresh object. (Variables holding pointers are plain JS
//   variables; assigning one copies the reference, which is safe because
//   the object itself never changes.)
//
// Emission idioms (produced by tools/c2js/emit.mjs, documented here):
//   p + n            cptr.add(p, n)              (n may be BigInt; scaled by
//   p - n            cptr.add(p, -(n))            pointee size when > 1)
//   p1 - p2          cptr.diff(p1, p2)            -> BigInt (ptrdiff_t=long)
//   p1 < p2 (rel.)   cptr.cmp(p1, p2) < 0         (same buffer assumed)
//   p1 == p2         cptr.eq(p1, p2)              (null-safe)
//   p == NULL        p === null
//   *p  (char r/w)   cptr.ld1s(p) / cptr.st1(p, v)   (signed char load!)
//   *p  (uchar r/w)  cptr.ld1u(p) / cptr.st1(p, v)
//   u64 field r/w    cptr.ldU64(p) / cptr.stU64(p, v) (little-endian, LP64)
//   arr[i] via ptr   cptr.add(p, i[, elemSize]) then ld/st
//   &x / arr decay   cptr.decay(buffer) == { buf: buffer, off: 0 }
//   p++ (stmt pos)   p = cptr.add(p, 1)
//   *p++ (expr pos)  cptr.ld1s(cptr.postinc(() => p, (v) => { p = v; }))
//   p[i]++ (char)    cptr.postinc1(cptr.sub(p, i))
//
// All libc shims operate on CPtr (not JS strings) — signedness and
// mutation semantics follow C byte buffers, not JS strings.

/** @typedef {{ buf: Uint8Array, off: number }} CPtr */

// ------------------------------------------------------------- boxes ----
// Tier-2 address-of support (DESIGN.md memory model): a scalar whose
// address is taken lives in a one-element box; the box IS its address.
// boxProp wraps an object property (or array element) with the same
// protocol. cptr.ld*/st* are box-aware.

/** one-element cell for an address-taken scalar. @param {*} v @returns {{isBox: true, v: *}} */
export function box(v) { return { isBox: true, v }; }

/** box view of an object property / array element. @returns {{isBox: true, v: *}} */
export function boxProp(obj, key) {
  return { isBox: true, get v() { return obj[key]; }, set v(x) { obj[key] = x; } };
}

// ------------------------------------------------------------------ core ----

/** Encode a JS string as NUL-terminated bytes and return a pointer to them. @param {string} s @returns {CPtr} */
export function lit(s) {
  const b = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xFF;
  b[s.length] = 0;
  return { buf: b, off: 0 };
}

/** Encode a JS string as NUL-terminated bytes (char[] initializer). @param {string} s @returns {Uint8Array} */
export function bytes(s) { return lit(s).buf; }

/** Decode a C string to a JS string. Accepts CPtr | Uint8Array | string | null. @returns {string} */
export function cstr(p) { 
  if (p === null || p === undefined) return '(null)';
  if (typeof p === 'string') return p;
  const buf = p.buf !== undefined ? p.buf : p;
  const off = p.off || 0;
  let s = '';
  for (let i = off; i < buf.length && buf[i] !== 0; i++) s += String.fromCharCode(buf[i]);
  return s;
}

/** Array lvalue -> pointer to its first element. A multi-dim array carries its
 * flat backing in .buf (rows are subarrays of it) — unwrap so pointer-to-array
 * arithmetic (and memset over the whole array) sees contiguous storage.
 * @param {Uint8Array|Array} buf @returns {CPtr} */
export function decay(buf) {
  if (buf && buf.buf !== undefined && typeof buf.off === 'number') return buf; // already a CPtr (byte-packed array storage)
  return { buf: Array.isArray(buf) && buf.buf !== undefined ? buf.buf : buf, off: 0 };
}

/** Pointer arithmetic: p + n elements of size sz (default 1 = byte). @param {CPtr} p @param {number|bigint} n @param {number} [sz] @returns {CPtr} */
export function add(p, n, sz = 1) { const off = p.off + Number(n) * sz; if (Number.isNaN(off)) throw new Error(`cptr.add NaN (n=${String(n)} sz=${sz})`); return { buf: p.buf, off }; } // TEMP NaN tripwire

/** Pointer subtraction: p - n elements of size sz. @param {CPtr} p @param {number|bigint} n @param {number} [sz] @returns {CPtr} */
export function sub(p, n, sz = 1) { return { buf: p.buf, off: p.off - Number(n) * sz }; }

/** p1 - p2 in elements (sz=1: bytes). C ptrdiff_t is long -> BigInt. @returns {bigint} */
export function diff(a, b) { return BigInt(a.off - b.off); }

/** Relational comparison of pointers into the same buffer. @returns {number} negative/zero/positive */
export function cmp(a, b) { return a.off - b.off; }

/** Pointer equality (null-safe): same buffer identity and same offset. @returns {boolean} */
export function eq(a, b) {
  if (a === null || b === null) return a === b;
  return a.buf === b.buf && a.off === b.off;
}

// numeric identity for pointer→integer casts ((size_t)p, point2uint): stable
// within a run, NOT a C address — suitable for hash seeds and integer compares
const __bufIds = new WeakMap();
let __nextBufId = 1;
/** @param {CPtr|null} p @returns {bigint} */
export function addr(p) {
  if (p === null || p === undefined) return 0n;
  if (typeof p !== 'object' && typeof p !== 'function') return BigInt(p) || 0n;
  if (p.isBox) { let id = __bufIds.get(p); if (!id) { id = __nextBufId++ * (1 << 26); __bufIds.set(p, id); } return BigInt(id); }
  const key = p.buf !== undefined ? p.buf : p; // function designators: identity
  let base = __bufIds.get(key);
  if (!base) { base = __nextBufId++ * (1 << 26); __bufIds.set(key, base); }
  return BigInt(base + (p.off || 0));
}

// ------------------------------------------------------- scalar load/store ----

/** *p where p is char* (signed on this target). @param {CPtr} p @returns {number} */
export function ld1s(p) { if (p.isBox) return (p.v << 24) >> 24; return (p.buf[p.off] << 24) >> 24; }

/** *p where p is unsigned char*. @param {CPtr} p @returns {number} */
export function ld1u(p) { if (p.isBox) return p.v & 0xFF; return p.buf[p.off]; }

/** *p = v for 1-byte pointees; store truncates mod 256 like C. @param {CPtr} p @param {number|bigint} v */
export function st1(p, v) { if (p.isBox) { p.v = Number(v) & 0xFF; return v; } p.buf[p.off] = Number(v) & 0xFF; return v; }

/** 32-bit int load, little-endian. @param {CPtr} p @returns {number} */
export function ldI32(p) {
  if (p.isBox) return p.v | 0;
  const b = p.buf, o = p.off;
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24));
}

/** 32-bit int store, little-endian. @param {CPtr} p @param {number} v */
export function stI32(p, v) {
  if (p.isBox) { p.v = v | 0; return v; }
  const b = p.buf, o = p.off, x = v | 0;
  b[o] = x & 0xFF; b[o + 1] = (x >> 8) & 0xFF; b[o + 2] = (x >> 16) & 0xFF; b[o + 3] = (x >> 24) & 0xFF;
  return v;
}

/** 16-bit signed load (C short/int16_t), little-endian. @param {CPtr} p @returns {number} */
export function ldI16(p) {
  if (p.isBox) return (p.v << 16) >> 16;
  const b = p.buf, o = p.off;
  return ((b[o] | (b[o + 1] << 8)) << 16) >> 16;
}

/** 16-bit unsigned load (C unsigned short/uint16_t), little-endian. @param {CPtr} p @returns {number} */
export function ldU16(p) {
  if (p.isBox) return p.v & 0xFFFF;
  const b = p.buf, o = p.off;
  return b[o] | (b[o + 1] << 8);
}

/** 16-bit store, little-endian (truncate mod 2^16 like C). @param {CPtr} p @param {number} v @returns {number} v */
export function stI16(p, v) {
  if (p.isBox) { p.v = (v << 16) >> 16; return v; } // signed canonical, like stI32's v|0 — raw .v reads must see C's int16 value
  const b = p.buf, o = p.off, x = v & 0xFFFF;
  b[o] = x & 0xFF; b[o + 1] = (x >> 8) & 0xFF;
  return v;
}

/** 64-bit load, little-endian, as BigInt (C int64/uint64/size_t). @param {CPtr} p @returns {bigint} */
export function ldU64(p) { 
  if (p.isBox) return BigInt.asUintN(64, BigInt(p.v));
  const b = p.buf, o = p.off;
  if (o + 8 > b.length) throw new Error(`ldU64 OOB: buflen=${b.length} off=${o}`); // TEMP debug aid
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]);
  return v;
}

/** 64-bit store into an unsigned 64-bit location, little-endian. @param {CPtr} p @param {bigint|number} v */
export function stU64(p, v) {
  if (p.isBox) { p.v = BigInt.asUintN(64, BigInt(v)); return v; }
  const b = p.buf, o = p.off;
  let x = BigInt(v);
  for (let i = 0; i < 8; i++) { b[o + i] = Number(x & 0xFFn); x >>= 8n; }
  return v;
}

/**
 * 64-bit store into a *signed* 64-bit location (long/long long/int64_t).
 * Byte-identical to stU64 for buffer locations; boxes keep the signed
 * canonical form so raw `.v` reads see C's value (like stI32's `v|0` and
 * stI16's sign-extension).
 * @param {CPtr} p @param {bigint|number} v
 */
export function stI64(p, v) {
  if (p.isBox) { p.v = BigInt.asIntN(64, BigInt(v)); return v; }
  return stU64(p, v);
}

// -------------------------------------------- inc/dec on pointer variables ----
// Pointer values are immutable, so postfix/prefix ++ and -- on a pointer
// variable go through accessor closures. get: () => CPtr, set: (v) => void.

/** postfix p++ on a pointer variable; returns the OLD pointer. */
export function postinc(get, set, sz = 1) { const old = get(); set(add(old, 1, sz)); return old; }
/** postfix p-- on a pointer variable; returns the OLD pointer. */
export function postdec(get, set, sz = 1) { const old = get(); set(sub(old, 1, sz)); return old; }
/** prefix ++p on a pointer variable; returns the NEW pointer. */
export function preinc(get, set, sz = 1) { const v = add(get(), 1, sz); set(v); return v; }
/** prefix --p on a pointer variable; returns the NEW pointer. */
export function predec(get, set, sz = 1) { const v = sub(get(), 1, sz); set(v); return v; }

/** postfix ++ on a signed-char location (e.g. tstr[i]++); returns old value. @param {CPtr} loc */
export function postinc1(loc) { const old = ld1s(loc); st1(loc, old + 1); return old; }

// ------------------------------------------------------------------ malloc ----

/** @param {number|bigint} n @returns {CPtr} */
export function malloc(n) { return { buf: new Uint8Array(Number(n)), off: 0 }; }
/** no-op (GC). @param {CPtr|null} p */
export function free(p) { /* GC */ }

/** zeroed byte storage for a struct/union value local; returns its location. @param {number|bigint} size @returns {CPtr} */
export function alloc(size) { return { buf: new Uint8Array(Number(size)), off: 0 }; }

/** fresh copy of a struct value (C pass-by-value semantics for record params). @param {CPtr} p @param {number} n @returns {CPtr} */
export function dup(p, n) { const b = alloc(n); memcpy(b, p, n); return b; }

// ------------------------------------------------- f64 / i64 / ptr access ----

/** 64-bit double load, little-endian IEEE-754. @param {CPtr} p @returns {number} */
export function ldF64(p) {
  if (p.isBox) return Number(p.v);
  return new DataView(p.buf.buffer, p.buf.byteOffset + p.off, 8).getFloat64(0, true);
}

/** 64-bit double store, little-endian IEEE-754. @param {CPtr} p @param {number} v @returns {number} v */
export function stF64(p, v) {
  if (p.isBox) { p.v = Number(v); return v; }
  new DataView(p.buf.buffer, p.buf.byteOffset + p.off, 8).setFloat64(0, Number(v), true);
  return v;
}

/** 64-bit signed load (two's complement). @param {CPtr} p @returns {bigint} */
export function ldI64(p) { return BigInt.asIntN(64, ldU64(p)); }

// Pointer values stored in byte buffers: serialized through a registry.
// Round-trips are exact (write ptr, read ptr -> identical). The integer
// bits are registry ids, NOT addresses — do not print them expecting
// C address values (differential tests must not depend on them).
const __ptrRegistry = [];

/** store a CPtr into 8 bytes of a byte buffer. @param {CPtr} p @param {CPtr|null} v @returns {*} v */
export function stPtr(p, v) {
  if (p.isBox) { p.v = v; return v; }
  let id;
  if (v === null || v === undefined) id = 0n;
  else {
    id = BigInt(__ptrRegistry.length + 1);
    __ptrRegistry.push(v);
  }
  stU64(p, id);
  return v;
}

/** load a CPtr previously stored via stPtr. @param {CPtr} p @returns {CPtr|null} */
export function ldPtr(p) { 
  if (p.isBox) return p.v === undefined ? null : p.v;
  const id = ldU64(p);
  if (id === 0n) return null;
  return __ptrRegistry[Number(id) - 1];
}

// ------------------------------------------------------------ libc string ----

/** @param {CPtr} p @returns {bigint} size_t */
export function strlen(p) { 
  let n = 0;
  while (p.buf[p.off + n] !== 0) { if (++n > 1e6) throw new Error(`strlen runaway at off=${p.off} buflen=${p.buf.length}`); }
  return BigInt(n);
}

/** @param {CPtr} dst @param {CPtr} src @returns {CPtr} dst */
export function strcpy(dst, src) { 
  let i = 0, c;
  do { c = src.buf[src.off + i]; dst.buf[dst.off + i] = c; i++; } while (c !== 0);
  return dst;
}

/** @param {CPtr} dst @param {CPtr} src @returns {CPtr} dst */
export function strcat(dst, src) {
  // C strcat returns the ORIGINAL dst, not dst+strlen(dst); returning the
  // advanced pointer silently dropped prefixes at every strcat-as-expression
  // call site (YouMessage: "You cannot eat that!" -> "cannot eat that!")
  strcpy(add(dst, strlen(dst)), src);
  return dst;
}

/** @param {CPtr} a @param {CPtr} b @param {number|bigint} n @returns {number} */
export function strncmp(a, b, n) {
  n = Number(n);
  for (let i = 0; i < n; i++) {
    const ca = a.buf[a.off + i], cb = b.buf[b.off + i];
    if (ca !== cb) return ca - cb; // byte difference, matching libc (not just sign)
    if (ca === 0) return 0;
  }
  return 0;
}

/** @param {CPtr} p @param {number} c @returns {CPtr|null} pointer to first occurrence (NUL if c==0), else null */
export function strchr(p, c) {
  c = Number(c) & 0xFF;
  for (let i = p.off; ; i++) {
    if (p.buf[i] === c) return { buf: p.buf, off: i };
    if (p.buf[i] === 0) return null;
  }
}

/** @param {CPtr} p @param {number} c @returns {CPtr|null} pointer to last occurrence, else null */
export function strrchr(p, c) {
  c = Number(c) & 0xFF;
  let found = null;
  for (let i = p.off; ; i++) {
    if (p.buf[i] === c) found = { buf: p.buf, off: i };
    if (p.buf[i] === 0) return found;
  }
}

/** @param {CPtr} haystack @param {CPtr} needle @returns {CPtr|null} */
export function strstr(haystack, needle) {
  if (needle.buf[needle.off] === 0) return haystack;
  outer: for (let i = haystack.off; haystack.buf[i] !== 0; i++) {
    for (let j = 0; ; j++) {
      const c = needle.buf[needle.off + j];
      if (c === 0) return { buf: haystack.buf, off: i };
      if (haystack.buf[i + j] !== c) continue outer;
    }
  }
  return null;
}

/** @param {CPtr} dst @param {CPtr} src @param {number|bigint} n @returns {CPtr} dst */
/**
 * Widen a CPtr whose buf is a subarray view when [off, off+n) would cross
 * the view's end: rebind to the view's underlying ArrayBuffer (same memory,
 * coherent with every other view over it). C legitimately spans 2D-array row
 * boundaries through a row pointer — vision.c get_unused_cs does
 * memset(**rows, 0, ROWNO*COLNO*...) via the row-0 pointer — and typed-array
 * writes past a view's length are SILENTLY dropped otherwise (this froze
 * viz_array rows 1..20, leaving stale monsters on captured screens).
 * @param {CPtr} p @param {number} n @returns {CPtr}
 */
export function span(p, n) {
  const b = p && p.buf;
  if (b instanceof Uint8Array && p.off + n > b.length
      && b.byteOffset + p.off + n <= b.buffer.byteLength) {
    return { buf: new Uint8Array(b.buffer), off: b.byteOffset + p.off };
  }
  return p;
}

export function memcpy(dst, src, n) {
  n = Number(n);
  // boxed scalars (tier-2 &x): stage through a little-endian byte buffer
  if (src && src.isBox) {
    const tmp = new Uint8Array(n);
    const v = src.v;
    if (v && v.buf !== undefined) { const id = __ptrRegistry.indexOf(v) + 1; let x = BigInt(id); for (let i = 0; i < n; i++) { tmp[i] = Number(x & 0xFFn); x >>= 8n; } }
    else if (typeof v === 'bigint') { let x = v; for (let i = 0; i < n; i++) { tmp[i] = Number(x & 0xFFn); x >>= 8n; } }
    else { let x = Number(v) >>> 0; for (let i = 0; i < n; i++) { tmp[i] = x & 0xFF; x >>>= 8; } }
    src = { buf: tmp, off: 0 };
  }
  if (dst && dst.isBox) {
    const tmp = alloc(n);
    const r = memcpy(tmp, src, n);
    if (n <= 4) { let x = 0; for (let i = n - 1; i >= 0; i--) x = (x << 8) | tmp.buf[i]; dst.v = x; }
    else { let x = 0n; for (let i = Math.min(n, 8) - 1; i >= 0; i--) x = (x << 8n) | BigInt(tmp.buf[i]); dst.v = x; }
    return r;
  }
  src = span(src, n); // subarray views: widen when the span crosses the view end
  dst = span(dst, n);
  const tmp = src.buf.slice(src.off, src.off + n); // slice: safe even if overlapping
  dst.buf.set(tmp, dst.off);
  return dst;
}

// ------------------------------------------------------------------ ctype ----

/** C locale. @param {number} c @returns {number} */
export function isupper(c) { return c >= 65 && c <= 90 ? 1 : 0; }
/** C locale. @param {number} c @returns {number} */
export function tolower(c) { return c >= 65 && c <= 90 ? c + 32 : c; }

// ------------------------------------------------------ printf-family --------

/**
 * Minimal C printf formatter. Supports %d %i %u %x %s %c %f %%, optional
 * +/0 flags and numeric width, and the ll length modifier (for i64/u64
 * BigInts). String args may be CPtr; integers may be BigInt.
 * @param {CPtr|string} fmt
 * @param {Array} args
 * @returns {string}
 */
export function sprintfCore(fmt, args) {
  
  const f = cstr(fmt);
  let ai = 0;
  return f.replace(/%([+0-]*)(\d*)(?:\.(\d*))?(ll|l|z)?([diuxXscf%])/g, (m, flags, width, prec, len, spec) => {
    if (spec === '%') return '%';
    const a = args[ai++];
    const w = Number(width || 0);
    let s;
    if (spec === 's') { s = cstr(a); if (prec !== undefined && prec !== '') s = s.slice(0, Number(prec)); }
    else if (spec === 'c') s = String.fromCharCode(Number(a) & 0xFF);
    else if (spec === 'f') s = prec !== undefined && prec !== '' ? Number(a).toFixed(Number(prec)) : Number(a).toFixed(6);
    else if (spec === 'x' || spec === 'X') { s = (len === 'll' || len === 'l' || len === 'z') ? BigInt.asUintN(64, BigInt(a)).toString(16) : (Number(a) >>> 0).toString(16); if (spec === 'X') s = s.toUpperCase(); }
    else if (spec === 'u') s = (len === 'll' || len === 'l' || len === 'z') ? String(BigInt.asUintN(64, BigInt(a))) : String(Number(a) >>> 0);
    else if (len === 'll' || len === 'l' || len === 'z') s = String(BigInt.asIntN(64, BigInt(a))); // %lld/%ld/%zd
    else s = String(Number(a)); // %d %i
    if (prec !== undefined && prec !== '' && 'diuxX'.includes(spec) && !s.startsWith('-')) s = s.padStart(Number(prec), '0');
    if (flags.includes('+') && !s.startsWith('-') && 'di'.includes(spec)) s = '+' + s;
    if (s.length < w) {
      if (flags.includes('-')) s = s + ' '.repeat(w - s.length); // left-justify
      else s = (flags.includes('0') && !s.startsWith('-') ? '0' : ' ').repeat(w - s.length) + s;
    }
    return s;
  });
}

/** printf to stdout. @param {CPtr|string} fmt @returns {number} */
export function printf(fmt, ...args) {
  const s = sprintfCore(fmt, args);
  process.stdout.write(s);
  return s.length;
}

/** write JS string bytes (with NUL) into a C buffer; returns chars written (excl. NUL). @param {CPtr} p @param {string} s @returns {number} */
export function writeStr(p, s) {
  for (let i = 0; i < s.length; i++) p.buf[p.off + i] = s.charCodeAt(i) & 0xFF;
  p.buf[p.off + s.length] = 0;
  return s.length;
}

/** @param {CPtr} str @param {CPtr|string} fmt @param {...*} args @returns {number} */
export function sprintf(str, fmt, ...args) { return writeStr(str, sprintfCore(fmt, args)); }

/** @param {CPtr} str @param {number|bigint} n @param {CPtr|string} fmt @param {...*} args @returns {number} */
export function snprintf(str, n, fmt, ...args) {
  n = Number(n);
  const s = sprintfCore(fmt, args);
  writeStr(str, s.length >= n ? s.slice(0, n - 1) : s);
  return s.length;
}

/** @param {CPtr} str @param {number|bigint} n @param {CPtr|string} fmt @param {Array} ap @returns {number} */
export function vsnprintf(str, n, fmt, ap) {
  n = Number(n);
  if (ap && Array.isArray(ap.args)) ap = ap.args.slice(ap.i); // va_list cursor
  const s = sprintfCore(fmt, ap);
  writeStr(str, s.length >= n ? s.slice(0, n - 1) : s);
  return s.length;
}

// ------------------------------------------------------------------ qsort ----

/**
 * Byte-generic qsort: elements are `size`-byte runs in base's buffer.
 * compar receives CPtrs to COPY-backed elements (writes through them are
 * not visible; libc qsort comparators must not mutate anyway).
 * @param {CPtr} base @param {number|bigint} nmemb @param {number|bigint} size @param {(a: CPtr, b: CPtr) => number} compar
 */
export function qsort(base, nmemb, size, compar) {
  nmemb = Number(nmemb); size = Number(size);
  const elems = [];
  for (let i = 0; i < nmemb; i++) elems.push(base.buf.slice(base.off + i * size, base.off + (i + 1) * size));
  // stable sort (Array.prototype.sort is stable in modern JS)
  elems.sort((a, b) => Number(compar({ buf: a, off: 0 }, { buf: b, off: 0 })));
  for (let i = 0; i < nmemb; i++) base.buf.set(elems[i], base.off + i * size);
}

// ------------------------------------------------------- varargs ----
// va_list is a cursor object { args, i } over the JS rest-parameter array.
// va_arg(ap, T) honors C default argument promotions (char/short -> int,
// float -> double); va_copy is a shallow clone; va_end is a no-op at the
// emission level (the cursor is simply dropped).

/** build a va_list cursor from the variadic rest array. @param {Array} args @returns {{args: Array, i: number}} */
export function vaList(args) { return { args, i: 0 }; }

/** shallow-clone a va_list cursor (va_copy). @returns {{args: Array, i: number}} */
export function vaCopy(ap) { return { args: ap.args, i: ap.i }; }

/**
 * va_arg with default argument promotions.
 * @param {{args: Array, i: number}} ap
 * @param {'i32'|'u32'|'i64'|'u64'|'f64'|'ptr'} tag
 */
export function vaArg(ap, tag) {
  const v = ap.args[ap.i++];
  switch (tag) {
    case 'i32': return v | 0;
    case 'u32': return v >>> 0;
    case 'i64': return BigInt.asIntN(64, BigInt(v));
    case 'u64': return BigInt.asUintN(64, BigInt(v));
    case 'f64': return Number(v);
    default: return v; // ptr
  }
}

// -------------------------------------------------- fd shims (copy_bytes) ----

const __fds = new Map(); // fd -> { data: number[], pos: number, writeBuf: number[]|null }
let __nextFd = 100;

// boot-harness bridge: when installed, route fd I/O to the harness fd table
// (generated code sometimes resolves read/write to cptr.* while open/creat
// resolve to harness globals — the two tables must be one)
let __fdHooks = null; // { read(fd, buf, n), write(fd, buf, n) }
/** @param {{read: Function, write: Function}|null} h */
export function setFdHooks(h) { __fdHooks = h; }

/** Test helper: register an in-memory fd. mode 'r' reads data; 'w' collects writes. @returns {number} fd */
export function fdNew(data, mode) {
  const fd = __nextFd++;
  __fds.set(fd, { data: [...data], pos: 0, writeBuf: mode === 'w' ? [] : null });
  return fd;
}
/** Test helper: bytes written to a 'w' fd. @returns {Uint8Array} */
export function fdWritten(fd) { return new Uint8Array(__fds.get(fd).writeBuf || []); }

/** @param {number} fd @param {CPtr} buf @param {number|bigint} n @returns {bigint} bytes read (ssize_t) */
export function read(fd, buf, n) {
  if (__fdHooks) return BigInt(__fdHooks.read(fd, buf, n));
  n = Number(n);
  const f = __fds.get(fd);
  if (!f) return -1n;
  let i = 0;
  while (i < n && f.pos < f.data.length) { buf.buf[buf.off + i] = f.data[f.pos]; i++; f.pos++; }
  return BigInt(i);
}

/** @param {number} fd @param {CPtr} buf @param {number|bigint} n @returns {bigint} bytes written (ssize_t) */
export function write(fd, buf, n) {
  if (__fdHooks) return BigInt(__fdHooks.write(fd, buf, n));
  n = Number(n);
  const f = __fds.get(fd);
  if (!f || !f.writeBuf) return -1n;
  for (let i = 0; i < n; i++) f.writeBuf.push(buf.buf[buf.off + i]);
  return BigInt(n);
}
