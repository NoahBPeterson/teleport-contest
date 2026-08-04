// ---- hand-written runtime prelude (tools/c2js/runtime/rnd-prelude.js) ----
// rng-log runtime + minimal libc shims + extern stubs for the parity harness.
// This section is NOT transpiled; it is inlined verbatim by emit.mjs.

// -- rng log ---------------------------------------------------------------
// The C recorder logs to the file named by $NETHACK_RNGLOG; here the log is
// an in-memory array. Lines are normalized from the C fprintf format
// ("%d %s(%s) = %d @ ...") to the contest entry format ("rn2(12)=1 @ ...").
const __rngLog = [];

function __cstr(arg) {
  if (arg instanceof Uint8Array) {
    let s = '';
    for (let i = 0; i < arg.length && arg[i] !== 0; i++) s += String.fromCharCode(arg[i]);
    return s;
  }
  return String(arg);
}

// minimal printf: %d %s %% only (all rnd.c needs)
function __sprintf(fmt, ...args) {
  let ai = 0;
  return __cstr(fmt).replace(/%(%|d|s)/g, (m, spec) => {
    if (spec === '%') return '%';
    const a = args[ai++];
    return spec === 'd' ? String(Number(a)) : __cstr(a);
  });
}

function __flushLines(f) {
  let i;
  while ((i = f.buf.indexOf('\n')) >= 0) {
    let line = f.buf.slice(0, i);
    f.buf = f.buf.slice(i + 1);
    // "123 rn2(12) = 1 @ f(file:line)" -> "rn2(12)=1 @ f(file:line)"
    line = line.replace(/^\d+\s+/, '').replace(/\) = /, ')=');
    __rngLog.push(line);
  }
}

/** Contest API: the recorded PRNG call log, in contest entry format. */
export function getRngLog() { return __rngLog; }

// -- libc shims --------------------------------------------------------------
function getenv(name) {
  // Logging is always on in the parity runtime (the scorer reads getRngLog()
  // unconditionally); display-rng logging stays opt-in via the environment.
  name = __cstr(name);
  if (name === 'NETHACK_RNGLOG') return process.env.NETHACK_RNGLOG ?? 'memory';
  if (name === 'NETHACK_RNGLOG_DISP') return process.env.NETHACK_RNGLOG_DISP ?? null;
  return process.env[name] ?? null;
}

function fopen(path, mode) { return { buf: '' }; } // in-memory FILE
function setvbuf(f, buf, mode, size) { return 0; }
function fprintf(f, fmt, ...args) {
  f.buf += __sprintf(fmt, ...args);
  __flushLines(f);
  return 0;
}
function fputc(c, f) {
  f.buf += String.fromCharCode(c);
  __flushLines(f);
  return c;
}

// snprintf bound to the fortified __builtin___snprintf_chk call shape after
// the emitter drops the two chk-only args: snprintf(buf, n, fmt, ...args).
function snprintf(buf, n, fmt, ...args) {
  n = Number(n);
  const s = __sprintf(fmt, ...args);
  const len = Math.min(s.length, n - 1);
  for (let i = 0; i < len; i++) buf[i] = s.charCodeAt(i);
  if (n > 0) buf[len] = 0;
  return s.length;
}

function panic(msg) { throw new Error(`panic: ${__cstr(msg)}`); }

// impossible() in C logs a warning and play continues; the parity sessions
// never hit it (rn2(x<=0) etc. are guarded by callers). Kept as a no-op so
// emitted code stays statement-faithful.
function impossible(...args) { return 0; }

// hacklib.c sgn — not transpiled yet; shimmed here.
function sgn(n) { return n < 0 ? -1 : (n !== 0 ? 1 : 0); }

// sys_random_seed is port-specific (provided by the recorder build's unix
// glue); init_random is not exercised by the parity driver, which seeds via
// init_isaac64 directly. Throw if ever reached rather than silently using a
// made-up seed.
function sys_random_seed() {
  throw new Error('sys_random_seed: not available in the parity runtime');
}

// -- extern state stubs (decl.c / struct you) --------------------------------
// struct you u — only the fields rnd.c reads (u.ulevel in rne, Luck ==
// u.uluck + u.moreluck in rnl). ulevel defaults to 1 (game start); the
// driver can override via __setU.
const u = { ulevel: 1, uluck: 0, moreluck: 0 };
export function __setU(props) { Object.assign(u, props); }

let has_strong_rngseed = 1; /* TRUE in the recorder build */
// ---- end runtime prelude ----
