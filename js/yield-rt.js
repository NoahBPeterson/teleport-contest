// yield-rt.js — the four-function runtime of the yieldable engine build.
//
// Hand-written, tiny, and deliberately outside js/generated*: the yieldable
// build (js/generated-y/, produced by tools/c2js/yieldify.mjs) is a mechanical
// rewrite of the synchronous build in which every function that can reach a
// blocking keystroke read becomes a generator and every call to one becomes
// `yield*`. Three situations that rewrite cannot express inline live here.
//
// Nothing in this file is imported by the synchronous scoring build.

/** The value a parked engine yields. Identity is the protocol: a trampoline
 *  that sees this object knows the engine wants a key code back from .next(). */
export const KEY_REQUEST = { nhYield: 'key' };

/**
 * Delegate to a call whose callee is a C function pointer.
 *
 * At an indirect site the transform cannot know statically whether the target
 * is one of the coloured functions (now a generator) or one that stayed a
 * plain function — `windowprocs` alone holds both. Calling it and inspecting
 * the result is exact: transpiled C functions return numbers, BigInts, CPtr
 * records `{buf, off}` or null, never a generator object.
 *
 * Emitted as `(yield* icall(EXPR(args)))`, so the callee is evaluated exactly
 * once, in argument order, before this generator is entered.
 */
export function* icall(r) {
  if (r !== null && typeof r === 'object'
      && typeof r.next === 'function' && typeof r.throw === 'function') {
    return yield* r;
  }
  return r;
}

/**
 * Adapt a coloured function back down to a plain synchronous one.
 *
 * Used where a generator would be handed to hand-written runtime code that
 * calls it directly — js/cptr.js's qsort calling its comparator. Such a callee
 * is coloured only by the conservative function-pointer approximation; it
 * cannot actually block, and the throw here is the assertion of that.
 */
export function drive(fn) {
  return function (...args) {
    const it = fn(...args);
    const r = it.next();
    if (!r.done) throw new Error('yield-rt: a synchronous callback tried to block');
    return r.value;
  };
}

/**
 * The nested-input read inside tty_nhgetch.
 *
 * The C reads one byte from stdin when `program_state.in_getchar > 1`; the
 * harness routes fd 0 to the same queue g.getchar drains. In the yieldable
 * build that read has to be able to park too, so the transform rewrites the
 * one site that passes stdin into a call to this generator. `buf` is the
 * emitter's one-element box, read back as `buf.v`.
 */
export function* stdinRead(buf) {
  const c = yield* globalThis.getchar();
  buf.v = c;
  return 1n;
}

/**
 * Run a yieldable engine to completion, answering every park from `nextKey`.
 *
 * The synchronous driver: used by the Node parity harness, where the whole
 * move string is known up front and `nextKey` never actually has to wait.
 * The browser rung uses the generator directly instead, parking between
 * keystrokes rather than looping here.
 *
 * @param {Generator} it   the generator returned by the engine's main()
 * @param {() => number} nextKey  supplies a key code, or a negative for EOF
 */
export function trampoline(it, nextKey) {
  let send;
  for (;;) {
    const r = it.next(send);
    if (r.done) return r.value;
    if (r.value !== KEY_REQUEST) throw new Error('yield-rt: unexpected yield from the engine');
    send = nextKey();
  }
}
