// gstate.js — the handle the browser entry point and the playability runner
// share with the running game.
//
// In the original skeleton this held the whole hand-written game state. Here
// the game state lives where the C says it lives — inside the transpiled
// corpus, on the engine thread — so what is left is the small amount of
// *session* state the page needs: which display we are drawing into, which
// engine is resident, and whether the game has ended.
//
// index.html and frozen/playability_runner.mjs both do `game.nhDisplay =
// display` before start(), and both read `game.program_state?.gameover`, so
// those two fields are load-bearing API.

export let game = {
    /** GameDisplay the running game paints into. */
    nhDisplay: null,
    /** InteractiveEngine (or ReplayEngine) currently resident. */
    nhEngine: null,
    /** Mirrors C's program_state for the bits a UI cares about. */
    program_state: { gameover: false },
};

/**
 * Read one file out of the game's VFS as text.
 *
 * The transpiled game's whole filesystem (save files, bones, /record, the
 * logfile) is persisted by js/boot/harness.mjs as a single base64 blob under
 * the storage key `c2js-overlay` — one key, so a save survives a page reload
 * and a multi-segment scoring session with no per-file key juggling. The
 * frozen storage.js's vfsReadFile() looks for a different layout
 * (`vfs:<path>`), so the page needs this to show the topten after a death.
 *
 * @param {{getItem(k: string): string|null}} storage
 * @param {string} path  e.g. '/record' — matched against the tail of the
 *                       VFS path, since the game writes it inside HACKDIR.
 * @returns {string|null}
 */
export function readVfsFile(storage, path) {
    if (!storage) return null;
    try {
        const raw = storage.getItem('c2js-overlay');
        if (!raw) return null;
        const files = JSON.parse(raw);
        for (const k of Object.keys(files)) {
            if (k === path || k.endsWith(path)) return atob(files[k]);
        }
        return null;
    } catch (e) {
        return null;
    }
}

export function resetGame() {
    game.nhDisplay = null;
    game.nhEngine = null;
    game.program_state = { gameover: false };
    return game;
}
