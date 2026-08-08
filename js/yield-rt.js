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
 * This is the whole trick, and it is worth being precise about why it works.
 * When the engine parks, its entire C call stack — forty-odd frames of
 * transpiled NetHack — is suspended inside generator objects on the heap.
 * There is no live JS stack to hold. So the driver is free to return to the
 * event loop and come back later, which is exactly what a browser main thread
 * requires and exactly what the synchronous engine can never do.
 *
 * `nextKey` may return a key code or a promise of one. During replay it is
 * never called at all: the whole move string is queued up front, getchar
 * drains it without reaching its `yield`, and the loop below runs `it.next()`
 * exactly once. That is deliberate — it makes a corpus run a test of the
 * TRANSFORM, with no trampoline behaviour mixed in.
 *
 * @param {Generator} it   the generator returned by the engine's main()
 * @param {() => number | Promise<number>} [nextKey]
 */
export async function trampoline(it, nextKey) {
  let send;
  for (;;) {
    const r = it.next(send);
    if (r.done) return r.value;
    if (r.value !== KEY_REQUEST) throw new Error('yield-rt: unexpected yield from the engine');
    if (!nextKey) throw new Error('yield-rt: engine parked with no key source');
    const k = nextKey();
    send = (k && typeof k.then === 'function') ? await k : k;
  }
}

/**
 * A resident engine: park-per-keystroke rather than run-to-completion.
 *
 * `start()` runs until the first park (the first painted frame); `step(code)`
 * delivers one key and runs until the next park. Nothing here blocks, so this
 * is usable on a browser main thread — which is the entire point of the
 * yieldable build.
 */
export class ResidentEngine {
  /** @param {Generator} it @param {() => void} [onPark] called at each park */
  constructor(it, onPark) {
    this.it = it;
    this.onPark = onPark;
    this.done = false;
    this.result = undefined;
  }

  /** run to the first park. @returns {boolean} true if parked, false if the game already ended */
  start() { return this._runTo(undefined); }

  /** deliver one key and run to the next park. */
  step(code) { return this._runTo(code); }

  _runTo(send) {
    const r = this.it.next(send);
    if (r.done) { this.done = true; this.result = r.value; return false; }
    if (r.value !== KEY_REQUEST) throw new Error('yield-rt: unexpected yield from the engine');
    if (this.onPark) this.onPark();
    return true;
  }
}
