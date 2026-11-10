// cjmp.js — setjmp/longjmp runtime for transpiled code.
//
// Mapping (hard-construct gate A): setjmp returns twice, JS can't, so
// longjmp becomes a tagged exception and the setjmp site becomes try/catch.
//
//   longjmp(jb, v)      ->  throw new Longjmp(idOf(jb), v)   [via cjmp.longjmp]
//   if (setjmp(jb))     ->  try { if (0) {...} }             [emitter pattern]
//                           catch (e) { if (!cjmp.matches(e, id)) throw e;
//                                       val = cjmp.jbval(e); if (val) {...} }
//
// The emitter re-emits the `if` with the setjmp call substituted by 0 (try
// arm, direct path) or by the caught value (catch arm, longjmp path) — C
// evaluates the condition once per setjmp return, and so do we.
//
// Buffer identity: a jmp_buf is identified by its {buf, off} (CPtr-style);
// that distinguishes nested buffers and struct members holding buffers.
// cjmp.jbval implements the C rule that longjmp(jb, 0) yields 1.

/** Tagged nonlocal exit. Thrown by longjmp, matched by identity at setjmp sites. */
export class Longjmp {
  /** @param {{buf: *, off: number}} id @param {number|bigint} val */
  constructor(id, val) {
    this.id = id;
    this.val = val;
  }
}

/** normalize a jmp_buf reference (CPtr {buf,off}) to a comparable identity */
export function idOf(p) {
  if (p && typeof p === 'object' && 'buf' in p) return { buf: p.buf, off: p.off };
  return { buf: p, off: 0 };
}

/** is `e` a Longjmp targeted at buffer identity `id`? */
export function matches(e, id) {
  return e instanceof Longjmp && e.id.buf === id.buf && e.id.off === id.off;
}

/** C rule: setjmp returns the longjmp value, except 0 becomes 1. */
export function jbval(e) {
  return e.val === 0 ? 1 : e.val;
}

/** longjmp(jb, v) — never returns. @param {*} jb @param {number|bigint} v */
export function longjmp(jb, v) {
  throw new Longjmp(idOf(jb), Number(v));
}
