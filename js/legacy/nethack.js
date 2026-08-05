// nethack.js — Browser game bootstrap.
// C ref: unixmain.c / nttty.c — platform-specific entry point.
// Connects the game engine (jsmain.js) to the browser terminal and
// keyboard input, then runs the game loop.

import { NethackGame } from './jsmain.js';
import { GameDisplay } from './game_display.js';
import { game } from './gstate.js';
import { moveloop_core } from './allmain.js';

// Start an interactive browser game with the given terminal container.
export async function startBrowser(container, seed = 42) {
    const display = new GameDisplay(container);

    const nhGame = new NethackGame({ seed });
    nhGame._pendingDisplay = display;
    game.nhDisplay = display;

    await nhGame.start();

    // Game loop: each iteration reads one key and processes one turn
    for (;;) {
        await moveloop_core();
        if (game.program_state?.gameover) break;
    }
}
