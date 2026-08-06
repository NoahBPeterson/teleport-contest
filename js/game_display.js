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
    }

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

    // Display methods
    setCell(col, row, ch, color, attr) { return this.terminal.setCell(col, row, ch, color, attr); }
    putstr(col, row, str, color, attr) { return this.terminal.putstr(col, row, str, color, attr); }
    setCursor(col, row) { return this.terminal.setCursor(col, row); }
    clearScreen() { return this.terminal.clearScreen(); }
    clearRow(row) { return this.terminal.clearRow(row); }
    scrollUp() { return this.terminal.scrollUp(); }
    moveCursor(x, y) { return this.terminal.moveCursor(x, y); }
    putChar(x, y, ch, attr) { return this.terminal.putChar(x, y, ch, attr); }
    getChar(x, y) { return this.terminal.getChar(x, y); }
    putString(str) { return this.terminal.putString(str); }
    putCharAtCursor(ch) { return this.terminal.putCharAtCursor(ch); }
    clearToEol() { return this.terminal.clearToEol(); }
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

    /** NetHack key mapper — converts browser keys to game codes. */
    keyMapper = null;
    /** Ctrl-C handler. */
    onInterrupt = null;
    /** Called when input queue is empty (headless replay). */
    onEmptyQueue = null;

    // --- Painting engine frames ---

    /**
     * Paint one engine frame: `{ screen, cx, cy }` as produced by the C
     * shadow-buffer serializer. The decode is the judge's own
     * (frozen/screen-decode.mjs), so a cell that renders here is a cell that
     * scores there. Terminal.setCell() already no-ops on unchanged cells, so
     * a full 24x80 repaint only touches the DOM where the frame actually moved.
     */
    applyFrame(frame) {
        if (!frame || typeof frame.screen !== 'string') return;
        const grid = decodeScreen(frame.screen);
        const t = this.terminal;
        for (let r = 0; r < 24; r++) {
            const row = grid[r];
            for (let c = 0; c < 80; c++) {
                const cell = row[c];
                t.setCell(c, r, renderCell(cell), cell.color, cell.attr);
            }
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
