// frames.mjs — the input-boundary frame reader, shared by every resident engine.
//
// js/boot/harness.mjs writes an OSC marker plus payload at every input
// boundary. A resident engine is called synchronously right after that marker
// was flushed — from inside getchar() in the worker engine, at a generator
// park in the main-thread engine — so everything needed is already buffered.
//
// Extracted from js/boot/engine-worker.mjs so the main-thread engine does not
// carry a second copy of a wire-format parser.

// ---------------------------------------------------------------------------
// Frame extraction.
//
// harness.mjs writes an OSC marker + payload at every input boundary; we are
// called synchronously right after the boundary marker was flushed, so
// everything we need is already in the buffer.

const OSC = '\x1b]7777;';

export function makeFrameReader() {
    let buf = '';
    return {
        sink(s) { buf += s; },
        /** Consume every complete marker; return the last input frame + any anim frames. */
        take() {
            let i = 0, last = null;
            const anim = [];
            for (;;) {
                const m = buf.indexOf(OSC, i);
                if (m < 0) break;
                const end = buf.indexOf('\x07', m);
                if (end < 0) break;
                const kv = Object.fromEntries(buf.slice(m + OSC.length, end).split(';').map((p) => p.split('=')));
                const len = Number(kv.LEN);
                if (buf.length < end + 1 + len) break;   // payload still coming
                const frame = {
                    screen: buf.slice(end + 1, end + 1 + len),
                    cx: Number(kv.CX), cy: Number(kv.CY),
                };
                if (kv.KIND === 'anim') anim.push(frame);
                else last = frame;
                i = end + 1 + len;
            }
            buf = buf.slice(i);
            return { last, anim };
        },
    };
}
