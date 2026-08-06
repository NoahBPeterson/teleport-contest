// allmain.js — one keystroke of interactive play.
//
// C ref: allmain.c moveloop_core(). In C that is "read a command, run it,
// let the monsters move". Here the whole of allmain.c is already running —
// resident, on the engine thread, parked inside tty_nhgetch() — so the
// equivalent unit of work from the UI's point of view is:
//
//     take the next key the player pressed,
//     hand it to the engine,
//     wait for the frame the engine paints at its next input boundary,
//     draw that frame.
//
// The engine is never restarted and the key prefix is never replayed: a
// keystroke costs one thread wake-up plus whatever that key actually made the
// game do. That is the whole point of js/boot/interactive.mjs.
//
// Driven by index.html (`for(;;) await moveloop_core()`) and by
// frozen/playability_runner.mjs (`display.pushKey(c); await moveloop_core()`).

import { game } from './gstate.js';

/** Advance the game by exactly one player keystroke. */
export async function moveloop_core() {
    const display = game.nhDisplay;
    const engine = game.nhEngine;
    if (!display || !engine) throw new Error('moveloop_core: no game running (call NethackGame.start() first)');

    if (engine.gameover) {
        game.program_state.gameover = true;
        return;
    }

    // readKey() honours display.onEmptyQueue — that is how the playability
    // runner unwinds a multi-key prompt, and how a browser page waits for the
    // next keydown. Race it against the engine ending, so a death that lands
    // between two keystrokes doesn't leave the page waiting for a key the
    // player has no reason to press.
    const pending = display.readKey();
    const code = engine.whenExit
        ? await Promise.race([pending, engine.whenExit.then(() => null)])
        : await pending;
    if (code === null || engine.gameover) {
        game.program_state.gameover = true;
        return;
    }

    const frame = await engine.step(code);
    if (frame) display.applyFrame(frame);

    if (engine.gameover) {
        game.program_state.gameover = true;
        if (engine.exitInfo && engine.exitInfo.error) game.program_state.error = engine.exitInfo.error;
    }
}

/** C ref: allmain.c moveloop() — run until the game ends. */
export async function moveloop() {
    for (;;) {
        await moveloop_core();
        if (game.program_state?.gameover) break;
    }
}
