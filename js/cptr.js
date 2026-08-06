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

// Chunk size for the bulk decode below. String.fromCharCode.apply spreads the
// chunk onto the JS stack, so it has to stay well under the argument limit.
const __CSTR_CHUNK = 2048;

/** Decode a C string to a JS string. Accepts CPtr | Uint8Array | string | null. @returns {string} */
export function cstr(p) {
  if (p === null || p === undefined) return '(null)';
  if (typeof p === 'string') return p;
  const buf = p.buf !== undefined ? p.buf : p;
  const off = p.off || 0;
  // Two passes: find the NUL with a tight integer loop, then decode the run in
  // one go. The single-pass `s += ...` loop re-checked buf.length and built a
  // cons string per byte. Byte -> code unit is latin-1 by construction here
  // (String.fromCharCode of a 0..255 byte); TextDecoder('latin1') is NOT usable
  // as a shortcut — the WHATWG label maps to windows-1252, which rewrites
  // 0x80..0x9F.
  const n = buf.length;
  let end = off;
  while (end < n && buf[end] !== 0) end++;
  const len = end - off;
  if (len === 0) return '';
  if (len <= 16 || off < 0 || buf.subarray === undefined) {   // off<0: subarray would wrap
    let s = '';
    for (let i = off; i < end; i++) s += String.fromCharCode(buf[i]);
    return s;
  }
  if (len <= __CSTR_CHUNK) return String.fromCharCode.apply(null, buf.subarray(off, end));
  let s = '';
  for (let i = off; i < end; i += __CSTR_CHUNK) {
    s += String.fromCharCode.apply(null, buf.subarray(i, Math.min(i + __CSTR_CHUNK, end)));
  }
  return s;
}

/** Array lvalue -> pointer to its first element. A multi-dim array carries its
 * flat backing in .buf (rows are subarrays of it) — unwrap so pointer-to-array
 * arithmetic (and memset over the whole array) sees contiguous storage.
 * @param {Uint8Array|Array} buf @returns {CPtr} */
export function decay(buf) {
  // Ordered so the two common shapes — a Uint8Array (no .buf) and an existing
  // CPtr — each settle in one property load.
  if (buf === null || buf === undefined) return { buf, off: 0 };
  const inner = buf.buf;
  if (inner === undefined) return { buf, off: 0 };
  if (typeof buf.off === 'number') return buf;                 // already a CPtr
  return { buf: Array.isArray(buf) ? inner : buf, off: 0 };    // multi-dim: flat backing
}

/** Pointer arithmetic: p + n elements of size sz (default 1 = byte). @param {CPtr} p @param {number|bigint} n @param {number} [sz] @returns {CPtr} */
export function add(p, n, sz) {
  // Hottest function in the port (~13% of a session's CPU, and a matching share
  // of its GC). Two things and only two things drive the shape of this body:
  //   - the overwhelmingly common call is add(p, <int literal>) with no size
  //     argument, so that path must not multiply or hit a defaulted parameter;
  //   - the body must stay small and throw-free so TurboFan inlines it, which
  //     is what lets escape analysis delete the {buf,off} allocation outright
  //     at fused sites like ldI16(add(u, 26)).
  // `typeof n === 'number'` keeps the common case off the generic ToNumber
  // path. Semantics are unchanged; the NaN tripwire that used to live here was
  // a temporary debugging aid (roadmap 1.12) and is gone.
  if (typeof n === 'number') return { buf: p.buf, off: sz === undefined ? p.off + n : p.off + n * sz };
  return { buf: p.buf, off: p.off + Number(n) * (sz === undefined ? 1 : sz) };
}

/** Pointer subtraction: p - n elements of size sz. @param {CPtr} p @param {number|bigint} n @param {number} [sz] @returns {CPtr} */
export function sub(p, n, sz) {
  if (typeof n === 'number') return { buf: p.buf, off: sz === undefined ? p.off - n : p.off - n * sz };
  return { buf: p.buf, off: p.off - Number(n) * (sz === undefined ? 1 : sz) };
}

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
export function st1(p, v) {
  const x = (typeof v === 'number' ? v : Number(v)) & 0xFF;
  if (p.isBox) { p.v = x; return v; }
  p.buf[p.off] = x;
  return v;
}

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

// 64-bit access is the single hottest thing in the port: every struct field
// that is a pointer, a size_t or a long goes through here, and the obvious
// byte-at-a-time BigInt loop cost 24% of a session's CPU (1.3 s of 7.2 s on
// seed0360, plus most of the GC time — 16 intermediate BigInts per load).
// Splitting into two 32-bit halves with plain integer arithmetic and only
// building BigInts at the boundary keeps the identical value semantics
// (little-endian, mod 2^64) with 1-3 BigInt ops instead of 16.

// Out-of-line so the hot 64-bit readers stay small enough to inline: building
// the message inside ldU64/ldPtr put a string concat and a call on their
// (never-taken) slow path and cost them the inline. Message text unchanged.
function __oob64(b, o) { throw new Error(`ldU64 OOB: buflen=${b.length} off=${o}`); } // TEMP debug aid

/** 64-bit load, little-endian, as BigInt (C int64/uint64/size_t). @param {CPtr} p @returns {bigint} */
export function ldU64(p) {
  if (p.isBox) return BigInt.asUintN(64, BigInt(p.v));
  const b = p.buf, o = p.off;
  if (o + 8 > b.length) __oob64(b, o);
  const lo = (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const hi = (b[o + 4] | (b[o + 5] << 8) | (b[o + 6] << 16) | (b[o + 7] << 24)) >>> 0;
  return hi === 0 ? BigInt(lo) : (BigInt(hi) << 32n) | BigInt(lo);
}

/** 64-bit store into an unsigned 64-bit location, little-endian. @param {CPtr} p @param {bigint|number} v */
export function stU64(p, v) {
  if (p.isBox) { p.v = BigInt.asUintN(64, BigInt(v)); return v; }
  const b = p.buf, o = p.off;
  let lo, hi;
  // Fast path: a non-negative JS integer. (A non-integer number reaches
  // BigInt(v) below and throws, exactly as it did before.)
  if (typeof v === 'number' && v >= 0 && Number.isInteger(v)) {
    lo = v >>> 0;
    hi = Math.floor(v / 4294967296) >>> 0;
  } else {
    const x = BigInt.asUintN(64, BigInt(v));
    lo = Number(x & 0xFFFFFFFFn);
    hi = Number(x >> 32n);
  }
  b[o] = lo & 0xFF; b[o + 1] = (lo >>> 8) & 0xFF; b[o + 2] = (lo >>> 16) & 0xFF; b[o + 3] = (lo >>> 24) & 0xFF;
  b[o + 4] = hi & 0xFF; b[o + 5] = (hi >>> 8) & 0xFF; b[o + 6] = (hi >>> 16) & 0xFF; b[o + 7] = (hi >>> 24) & 0xFF;
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
// Registry ids live above every bit pattern an *integer* union member can
// produce (any int32/uint32, and negative int32 sign-extended to 64 bits ->
// 0x00000000_FFFFFFFF at most). Starting ids at 2^40 keeps the two disjoint:
// a slot holding an integer can never be mistaken for a stored pointer.
const __PTR_ID_BASE = 1n << 40n;
// Non-null bit patterns that aren't registry ids (a union's integer member
// read back through its pointer member -- NetHack's `anything`: a_int is
// written, a_void is tested). C sees a non-null pointer there, so hand back
// a stable opaque non-dereferenceable pointer rather than `undefined`, which
// was falsy and silently flipped control flow (unselectable menu entries).
const __intPtrs = new Map();

/** store a CPtr into 8 bytes of a byte buffer. @param {CPtr} p @param {CPtr|null} v @returns {*} v */
export function stPtr(p, v) {
  if (p.isBox) { p.v = v; return v; }
  let id;
  if (v === null || v === undefined) id = 0n;
  else {
    id = __PTR_ID_BASE + BigInt(__ptrRegistry.length);
    __ptrRegistry.push(v);
  }
  stU64(p, id);
  return v;
}

/** load a CPtr previously stored via stPtr. @param {CPtr} p @returns {CPtr|null} */
export function ldPtr(p) {
  if (p.isBox) return p.v === undefined ? null : p.v;
  const b = p.buf, o = p.off;
  if (o + 8 > b.length) __oob64(b, o);
  // Same two-halves trick as ldU64, but a stored pointer never needs a BigInt
  // at all: __PTR_ID_BASE is 2^40, so a registry id is exactly "hi >= 0x100"
  // and its index is recoverable in double arithmetic (the registry is nowhere
  // near 2^53 entries). Only the rare integer-bit-pattern-as-pointer case
  // (NetHack's `anything` union) falls back to building the BigInt key.
  const lo = (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const hi = (b[o + 4] | (b[o + 5] << 8) | (b[o + 6] << 16) | (b[o + 7] << 24)) >>> 0;
  if (lo === 0 && hi === 0) return null;
  if (hi >= 0x100) {
    const v = __ptrRegistry[(hi - 0x100) * 4294967296 + lo];
    if (v !== undefined) return v;
  }
  return __intPtr(lo, hi);
}

/** Rare tail of ldPtr: a bit pattern that is not a registry id. Out of line so
 * the BigInt construction and the Map lookup stay off ldPtr's hot body. */
function __intPtr(lo, hi) {
  const id = hi === 0 ? BigInt(lo) : (BigInt(hi) << 32n) | BigInt(lo);
  let ip = __intPtrs.get(id);
  if (ip === undefined) { ip = { intBits: id, buf: undefined, off: 0 }; __intPtrs.set(id, ip); }
  return ip;
}

// ------------------------------------------------------------ libc string ----

/** @param {CPtr} p @returns {bigint} size_t */
export function strlen(p) {
  // Bounding the scan by the buffer length instead of counting to 1e6 keeps the
  // per-byte work to one compare and hoists the loads out of the CPtr. A buffer
  // with no NUL in it at all still throws (same message) — that was the only
  // way the counter could ever fire, since reads past the end yield undefined.
  const b = p.buf, o = p.off, lim = b.length;
  let i = o;
  while (i < lim && b[i] !== 0) i++;
  if (i >= lim) __strlenRunaway(o, lim);
  return BigInt(i - o);
}
function __strlenRunaway(off, len) { throw new Error(`strlen runaway at off=${off} buflen=${len}`); }

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
  const sb = src.buf;
  // subarray, not slice: %TypedArray%.set already copies with memmove semantics
  // when source and target share a buffer (ES2023 23.2.3.26.1), so the staging
  // copy the old slice() made was pure allocation. Plain-Array storage has no
  // subarray, so it keeps the slice.
  const tmp = sb.subarray !== undefined ? sb.subarray(src.off, src.off + n)
                                        : sb.slice(src.off, src.off + n);
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
 * Minimal C printf formatter. Supports %d %i %u %o %x %s %c %f %%, optional
 * +/0 flags and numeric width, and the ll length modifier (for i64/u64
 * BigInts). String args may be CPtr; integers may be BigInt.
 *
 * %o is unsigned octal (C11 7.21.6.1p8). NetHack reaches it from
 * dowhatdoes() — "No such command '%s', char code %d (0%03o or 0x%02x)" —
 * and from the invalid-artifact-origin impossible(). Without it the
 * conversion fell through the regex and the literal "%03o" was printed.
 *
 * Formats are *compiled once and cached* (5.5% of a session's CPU went into
 * re-running the regex and re-parsing the same few hundred literals). The
 * compiled form is a flat list of literal chunks and conversion descriptors;
 * the descriptor holds everything the old callback recomputed per call
 * (parsed width, precision kind, long-ness, flag booleans). The conversion
 * arms below are byte-for-byte the old callback's — printf output is
 * parity-scored, so nothing here may "tidy up" an edge case.
 * @param {CPtr|string} fmt
 * @param {Array} args
 * @returns {string}
 */
// Same pattern the old f.replace() used; compileFormat drives it with exec so
// the match set is identical (a '%' that starts no valid conversion is left in
// the literal text, exactly as replace() left it).
const __FMT_RE = /%([+0-]*)(\*|\d*)(?:\.(\*|\d*))?(ll|l|z)?([diouxXscf%])/g;
const __PREC_NONE = -1;   // no '.' at all, or a bare '.' ("%.d")
const __PREC_STAR = -2;   // '.*' — read from an int argument at call time
const __fmtCache = new Map();
const __FMT_CACHE_MAX = 4096;   // formats built at runtime must not grow this forever

function compileFormat(f) {
  const parts = [];
  let last = 0, m;
  __FMT_RE.lastIndex = 0;
  while ((m = __FMT_RE.exec(f)) !== null) {
    if (m.index > last) parts.push(f.slice(last, m.index));
    last = m.index + m[0].length;
    const spec = m[5];
    if (spec === '%') { parts.push('%'); continue; }
    const flags = m[1], width = m[2], prec = m[3];
    parts.push({
      spec,
      isLong: m[4] === 'll' || m[4] === 'l' || m[4] === 'z',
      widthStar: width === '*',
      width: width === '*' ? 0 : Number(width || 0),
      prec: prec === undefined || prec === '' ? __PREC_NONE
          : prec === '*' ? __PREC_STAR : Number(prec),
      plus: flags.indexOf('+') >= 0,
      minus: flags.indexOf('-') >= 0,
      zero: flags.indexOf('0') >= 0,
      intSpec: 'diouxX'.indexOf(spec) >= 0,
      diSpec: spec === 'd' || spec === 'i',
    });
  }
  if (last < f.length) parts.push(f.slice(last));
  return parts;
}

export function sprintfCore(fmt, args) {
  const f = cstr(fmt);
  if (f.indexOf('%') < 0) return f;   // most format strings carry no conversion
  let parts = __fmtCache.get(f);
  if (parts === undefined) {
    parts = compileFormat(f);
    if (__fmtCache.size >= __FMT_CACHE_MAX) __fmtCache.clear();
    __fmtCache.set(f, parts);
  }
  let ai = 0, out = '';
  for (let k = 0; k < parts.length; k++) {
    const it = parts[k];
    if (typeof it === 'string') { out += it; continue; }
    const spec = it.spec, isLong = it.isLong;
    // '*' width/precision take their value from an int argument, consumed
    // ahead of the value argument (C99 7.19.6.1).
    let w = it.width, minus = it.minus;
    if (it.widthStar) {
      w = Number(args[ai++]) | 0;
      if (w < 0) { minus = true; w = -w; } // negative width == '-' flag, positive width
    }
    let prec = it.prec;
    if (prec === __PREC_STAR) {
      const p = Number(args[ai++]) | 0;
      prec = p < 0 ? __PREC_NONE : p;      // negative precision == omitted
    }
    const a = args[ai++];
    let s;
    if (spec === 's') { s = cstr(a); if (prec !== __PREC_NONE) s = s.slice(0, prec); }
    else if (spec === 'c') s = String.fromCharCode(Number(a) & 0xFF);
    else if (spec === 'f') s = prec !== __PREC_NONE ? Number(a).toFixed(prec) : Number(a).toFixed(6);
    else if (spec === 'x' || spec === 'X') { s = isLong ? BigInt.asUintN(64, BigInt(a)).toString(16) : (Number(a) >>> 0).toString(16); if (spec === 'X') s = s.toUpperCase(); }
    else if (spec === 'o') s = isLong ? BigInt.asUintN(64, BigInt(a)).toString(8) : (Number(a) >>> 0).toString(8);
    else if (spec === 'u') s = isLong ? String(BigInt.asUintN(64, BigInt(a))) : String(Number(a) >>> 0);
    else if (isLong) s = String(BigInt.asIntN(64, BigInt(a))); // %lld/%ld/%zd
    else s = String(Number(a)); // %d %i
    if (prec !== __PREC_NONE && it.intSpec && s.charCodeAt(0) !== 45) s = s.padStart(prec, '0');
    if (it.plus && s.charCodeAt(0) !== 45 && it.diSpec) s = '+' + s;
    if (s.length < w) {
      if (minus) s = s + ' '.repeat(w - s.length); // left-justify
      else s = (it.zero && s.charCodeAt(0) !== 45 ? '0' : ' ').repeat(w - s.length) + s;
    }
    out += s;
  }
  return out;
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
