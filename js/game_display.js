// game_display.js — NetHack-specific display wrapper around the frozen Terminal.
//
// Restored from the original skeleton (now js/legacy/game_display.js) and
// adapted to how this port actually draws: the engine is the transpiled C
// corpus running on its own thread, and what comes back from it is not a
// sequence of setCell() calls but the *rendered terminal frame* — the same
// KIND=input marker payload the judge scores (js/boot/harness.mjs). So the one
// thing this class grew is `applyFrame()`: decode that frame with the frozen
// decoder and paint the difference into the Terminal grid.
//
// Everything else is the skeleton's contract, unchanged, because
// frozen/playability_runner.mjs and index.html both drive it:
//   new GameDisplay(containerIdOrTerminalOrNull)
//   display.pushKey(code) / await display.readKey() / display.onEmptyQueue
//   display.putstr(...), display.clearScreen(), display.flags = {...}

import { Terminal, CLR_GRAY } from './terminal.js';
import { decodeScreen, renderCell } from '../frozen/screen-decode.mjs';

const TOPLINE_EMPTY = 0;
const TOPLINE_NEED_MORE = 1;

/** Arrow keys become the vi keys the game binds; Shift/Ctrl+arrow runs. */
const VI_FOR_ARROW = { ArrowUp: 'k', ArrowDown: 'j', ArrowLeft: 'h', ArrowRight: 'l' };

/** See GameDisplay.keyMapper. Every branch here has to answer, or drop, a key. */
function defaultNethackKeyMapper(e) {
    if (!e.altKey && !e.metaKey && VI_FOR_ARROW[e.key]) {
        const c = e.shiftKey || e.ctrlKey ? VI_FOR_ARROW[e.key].toUpperCase() : VI_FOR_ARROW[e.key];
        return c.charCodeAt(0);
    }
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
        const c = e.key.toLowerCase().charCodeAt(0);
        return (c >= 97 && c <= 122) ? c - 96 : null;
    }
    if (e.altKey || e.metaKey) return null;
    switch (e.key) {
    case 'Enter':     return 13;
    case 'Backspace': return 8;
    case 'Delete':    return 127;
    case 'Escape':    return 27;
    case 'Tab':       return 9;
    default:          return e.key.length === 1 ? e.key.charCodeAt(0) : null;
    }
}

export class GameDisplay {
    constructor(terminalOrContainerId) {
        // Accept either a Terminal instance or a container ID (backward compat)
        if (terminalOrContainerId instanceof Terminal) {
            this.terminal = terminalOrContainerId;
        } else {
            this.terminal = new Terminal(
                terminalOrContainerId != null ? terminalOrContainerId : null,
                { rows: 24, cols: 80 }
            );
        }

        // NetHack-specific message state
        this.topMessage = null;
        this.toplines = '';
        this.messages = [];
        this.toplin = TOPLINE_EMPTY;
        this.messageWinFlags = 0;

        this.frames = 0;

        // The screen string of the frame currently on the grid, or null when
        // something has written to the grid outside applyFrame(). See
        // applyFrame() / _dirty().
        this._paintedScreen = null;
    }

    /**
     * Anything that writes cells outside applyFrame() invalidates the
     * "this frame is already on screen" shortcut. Cheap to call, and calling it
     * one time too many only costs a repaint.
     */
    _dirty() { this._paintedScreen = null; }

    // --- Delegate all Terminal properties and methods ---

    get rows() { return this.terminal.rows; }
    get cols() { return this.terminal.cols; }
    get grid() { return this.terminal.grid; }
    get cursorCol() { return this.terminal.cursorCol; }
    set cursorCol(v) { this.terminal.cursorCol = v; }
    get cursorRow() { return this.terminal.cursorRow; }
    set cursorRow(v) { this.terminal.cursorRow = v; }
    get cursorVisible() { return this.terminal.cursorVisible; }
    set cursorVisible(v) { this.terminal.cursorVisible = v; }
    get spans() { return this.terminal.spans; }
    get container() { return this.terminal.container; }
    get flags() { return this.terminal.flags; }
    set flags(v) { this.terminal.flags = v; }

    // Display methods. The grid-mutating ones drop the painted-frame marker.
    setCell(col, row, ch, color, attr) { this._dirty(); return this.terminal.setCell(col, row, ch, color, attr); }
    putstr(col, row, str, color, attr) { this._dirty(); return this.terminal.putstr(col, row, str, color, attr); }
    setCursor(col, row) { return this.terminal.setCursor(col, row); }
    clearScreen() { this._dirty(); return this.terminal.clearScreen(); }
    clearRow(row) { this._dirty(); return this.terminal.clearRow(row); }
    scrollUp() { this._dirty(); return this.terminal.scrollUp(); }
    moveCursor(x, y) { return this.terminal.moveCursor(x, y); }
    putChar(x, y, ch, attr) { this._dirty(); return this.terminal.putChar(x, y, ch, attr); }
    getChar(x, y) { return this.terminal.getChar(x, y); }
    putString(str) { this._dirty(); return this.terminal.putString(str); }
    putCharAtCursor(ch) { this._dirty(); return this.terminal.putCharAtCursor(ch); }
    clearToEol() { this._dirty(); return this.terminal.clearToEol(); }
    cursSet(visibility) { return this.terminal.cursSet(visibility); }
    flush() { return this.terminal.flush?.(); }
    getPreElement() { return this.terminal.getPreElement(); }
    getCanvas() { return this.terminal.getCanvas?.(); }
    colorToCss(color) { return this.terminal.colorToCss(color); }
    captureForShell() { return this.terminal.captureForShell(); }
    serialize() { return this.terminal.serialize(); }

    // Input methods — delegate to terminal with NetHack-specific defaults
    pushKey(code) { return this.terminal.pushKey(code); }
    clearInputQueue() { return this.terminal.clearInputQueue(); }
    get isWaitingForInput() { return this.terminal.isWaitingForInput; }
    get inputQueueLength() { return this.terminal.inputQueueLength; }
    get waitEpoch() { return this.terminal.waitEpoch; }

    /**
     * Read a key with NetHack-specific options bundled.
     * Apps set keyMapper, onInterrupt, onEmptyQueue on GameDisplay;
     * these are passed through to terminal.readKey on every call.
     */
    readKey(extraOptions) {
        return this.terminal.readKey({
            keyMapper: this.keyMapper,
            onInterrupt: this.onInterrupt,
            onEmptyQueue: this.onEmptyQueue,
            ...extraOptions,
        });
    }

    /**
     * NetHack key mapper — converts browser keys to game codes.
     *
     * This is a *default*, not a null, because of who else builds a
     * GameDisplay. The page the mirror serves — fetched from
     * https://mazesofmenace.ai/play/NoahBPeterson/ on 2026-08-09 and vendored
     * at tools/judge-sim/fixtures-judge-play-page.html — does
     * `new GameDisplay('game-container')`, sets `flags`, and never touches
     * `keyMapper`. Its own instructions to the player read "Move with
     * hjklyubn or arrow keys."
     *
     * Terminal's built-in translation answers an arrow key with the raw ANSI
     * sequence ESC [ A, which is right for a terminal emulator and wrong for
     * this game: the engine on the other end is real tty NetHack, where ESC
     * cancels the command in progress and the '[' and 'A' behind it are two
     * more commands ('A' takes off your armour). So an arrow key on their page
     * did three unwanted things instead of one wanted one — and the fix lived
     * only in our index.html, which no player is ever served.
     *
     * A keyMapper *replaces* Terminal's translation outright (Terminal._onKeyDown
     * returns as soon as one is present, whatever it answers), so this has to
     * handle every key, not just the ones it changes. Returning null means
     * "drop this keystroke", which is right for bare modifier presses and wrong
     * for everything else. Assign your own to override; frozen/playability_runner.mjs
     * and the judge's replay path never come through here at all, because they
     * push key codes straight into the queue.
     */
    keyMapper = defaultNethackKeyMapper;
    /** Ctrl-C handler. */
    onInterrupt = null;
    /** Called when input queue is empty (headless replay). */
    onEmptyQueue = null;

    // --- Painting engine frames ---

    /**
     * Paint one engine frame: `{ screen, cx, cy }` as produced by the C
     * shadow-buffer serializer. The decode is the judge's own
     * (frozen/screen-decode.mjs), so a cell that renders here is a cell that
     * scores there.
     *
     * Two levels of "don't do the work":
     *
     *  1. If the frame's screen string is byte-identical to the one already on
     *     the grid, there is nothing to paint at all — skip the decode (1,920
     *     freshly allocated cell objects) and the 1,920 setCell calls outright.
     *     Most keystrokes in real play repaint an identical screen: prompts,
     *     --More--, menu navigation, a walk into a wall.
     *  2. Otherwise decode and compare cell by cell, calling setCell only where
     *     the frame actually differs from what is on the grid. Terminal.setCell
     *     no-ops on an unchanged cell anyway; doing the compare here also skips
     *     the renderCell() lookup and the call itself.
     *
     * The shortcut is only valid while applyFrame is the sole writer, so every
     * grid-mutating method on this class clears the marker (see _dirty()).
     * Display only — none of this is on the scored path.
     */
    applyFrame(frame) {
        if (!frame || typeof frame.screen !== 'string') return;
        const t = this.terminal;
        if (frame.screen !== this._paintedScreen) {
            const grid = decodeScreen(frame.screen);
            const tgrid = t.grid;
            for (let r = 0; r < 24; r++) {
                const row = grid[r];
                const trow = tgrid[r];
                for (let c = 0; c < 80; c++) {
                    const cell = row[c];
                    const ch = cell.decgfx ? renderCell(cell) : cell.ch;
                    const cur = trow[c];
                    if (cur.ch === ch && cur.color === cell.color && cur.attr === cell.attr) continue;
                    t.setCell(c, r, ch, cell.color, cell.attr);
                }
            }
            this._paintedScreen = frame.screen;
        }
        if (typeof frame.cx === 'number') t.setCursor(frame.cx, frame.cy);
        this.frames++;
        if (this.onFrame) this.onFrame(frame);
    }

    /** Set by benchmark/automation drivers; called after every painted frame. */
    onFrame = null;

    // --- NetHack-specific methods ---

    putstr_message(msg) {
        this.clearRow(0);
        this.putstr(0, 0, msg, CLR_GRAY);
        this.topMessage = msg.trimEnd();
        this.toplines = this.topMessage;
        this.toplin = this.topMessage ? TOPLINE_NEED_MORE : TOPLINE_EMPTY;
        this.messages.push(this.topMessage);
        if (this.messages.length > 20) this.messages.shift();
    }

    renderStatus(_player) {
        // The engine paints the status line itself; nothing to do here.
    }

    moveCursorTo(col, row = 0) {
        this.setCursor(col, row);
    }
}
