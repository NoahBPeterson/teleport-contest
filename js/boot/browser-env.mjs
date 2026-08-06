// browser-env.mjs — the three Node globals the transpiled corpus still reaches
// for, provided as no-ops when there is no Node.
//
// js/generated/* is machine-generated from C and must not be hand-edited, so
// the shims come to it rather than the other way round. There are exactly two
// call sites and both are libc surface, not game logic:
//
//   js/generated/rnd.js  getenv()  -> process.env  (NETHACK_RNGLOG et al.)
//   js/cptr.js           printf()  -> process.stdout.write
//
// In a browser both must exist before the first generated module *runs*, or
// the very first RNG call dies with "process is not defined" — which is what a
// browser-side 0/0 looks like from the outside.
//
// The shim deliberately leaves `process.versions.node` unset: that is the flag
// js/boot/isolation.mjs uses to decide whether Node's module.registerHooks
// isolation is available, and a browser must answer "no" there.

const NL = 10;

function lineSink(emit) {
    let buf = '';
    return {
        write(s) {
            buf += s;
            let i;
            while ((i = buf.indexOf(String.fromCharCode(NL))) >= 0) {
                emit(buf.slice(0, i));
                buf = buf.slice(i + 1);
            }
            return true;
        },
    };
}

/**
 * Install `process` if absent. Idempotent; returns true when it installed one.
 * @returns {boolean}
 */
export function installBrowserGlobals() {
    if (typeof globalThis.process !== 'undefined') return false;
    globalThis.process = {
        env: {},              // getenv() returns null for everything → C defaults
        argv: ['nethack'],
        platform: 'browser',
        versions: {},         // no `.node` — see header
        stdout: lineSink((l) => console.log(l)),
        stderr: lineSink((l) => console.warn(l)),
        exit() {},
    };
    return true;
}
