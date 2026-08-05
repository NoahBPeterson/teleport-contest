#!/usr/bin/env node
// play-record.mjs — play NetHack interactively against the patched C
// recorder and get a scoreable session.json back, with a live side-by-side
// JS mirror.
//
//   node tools/play-record.mjs <seed> [name]
//
// WHAT IT IS. scripts/record-session.mjs replays a *fixed* key string into
// the recorder and writes a session.json. This is the same machine with the
// key string coming from your keyboard instead of a file: your keystrokes go
// to the real C game and every input-boundary marker (screen + cursor + PRNG
// delta) is captured exactly as the canonical corpus captured it. On
// quit/death/save (or Ctrl-]) it writes a v5 session.json that
// frozen/ps_test_runner.mjs scores. Verified: a session played here is
// byte-identical to the same keys re-recorded by scripts/record-session.mjs.
//
// HOW THE SCREEN GETS TO YOU. Under NOMUX_MARKERS=1 the recorder writes two
// things to stdout, interleaved: the ordinary termcap rendering (which is
// what a terminal wants) and OSC 7777 marker blocks (which a terminal must
// never see — the payload after the BEL is raw screen text). So this tool
// sits in the middle and splits the stream. In plain mode it forwards the
// real rendering to your tty verbatim and eats the markers. In split mode it
// eats both and paints the panes itself from the captured frames — so the
// left pane is literally the frame that goes into the JSON.
//
// THE MIRROR. With a wide (>=162 col) or tall (>=52 row) terminal the tool
// splits itself in two: left/top = C recorder (ground truth), right/bottom =
// the same game replayed through the transpiled JS engine (js/jsmain.js
// runSegment), with a MATCH/DIVERGE readout on PRNG count and screen cells
// and the diverging cells highlighted. No tmux, no npm, no build: the split
// is drawn in-process (one process = one place for a bug to hide, and it is
// testable under a pty in CI), and the mirror runs as a short-lived child
// per refresh (tools/js-mirror-run.mjs) that is coalesced, always allowed to
// lag, and completely unable to affect the recording. The C side is the only
// thing recorded; the mirror is display-only.
//
// The marker parser, the env pinning, the stale-lock cleanup and the CR→LF
// convention are lifted from scripts/record-session.mjs (this repo) so the
// two tools stay wire-compatible. No third-party code is used: Alex Serrano
// (serteal)'s fork, checked for prior art, has no interactive-play harness
// (nothing in that tree drives the recorder from a live terminal).
//
// Options:
//   --out <file>        where to write the session JSON
//                       (default sessions-live/<name>.session.json)
//   --datetime <ts>     pinned YYYYMMDDHHMMSS (default: now, in --tz)
//   --rc <file>         .nethackrc contents to use
//   --options <str>     one-line OPTIONS= body, e.g. "name:Noah,role:Valkyrie"
//   --tz <zone>         TZ for the C process (default America/New_York)
//   --no-mirror         no split, no JS mirror — plain full-screen play
//   --keys <string>     NON-INTERACTIVE: feed these keys (smoke-test path)
//   --keys-file <file>  NON-INTERACTIVE: feed the file's bytes as keys
//   --keep-tmp          keep the scratch dir (rng log, recorder stderr)
//
// While playing:
//   Ctrl-]  finish now — stop recording, write the JSON  (Ctrl-C does too)
//   Everything else goes to the game. #quit, #save and dying end the game
//   normally and the JSON is written when the process exits.

import { spawn } from 'node:child_process';
import { promises as fs, constants as fsConstants } from 'node:fs';
import fsSync from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS_DIR, '..');
const DEFAULT_BINARY = path.join(
    ROOT, 'nethack-c', 'recorder', 'install',
    'games', 'lib', 'nethackdir', 'nethack');
const DEFAULT_INSTALL = path.join(
    ROOT, 'nethack-c', 'recorder', 'install',
    'games', 'lib', 'nethackdir');

// Keys we steal from the game to mean "stop recording and write the file".
const KEY_FINISH = 0x1d;   // Ctrl-]
const KEY_INTR = 0x03;     // Ctrl-C (raw mode delivers it as data, not SIGINT)

// ---------------------------------------------------------------------------
// Screen encoding — byte-for-byte the canonical wire form the corpus uses
// (ported from scripts/record-session.mjs, which ports run_session.py).
// ---------------------------------------------------------------------------

function compressAnsiLine(line) {
    if (!line) return '';
    let out = '';
    let i = 0;
    while (i < line.length) {
        if (line[i] === ' ') {
            const start = i;
            while (i < line.length && line[i] === ' ') i++;
            const run = i - start;
            if (run >= 5) out += `\x1b[${run}C`;
            else out += ' '.repeat(run);
        } else {
            out += line[i];
            i += 1;
        }
    }
    return out;
}

function encodeScreenAnsiRle(lines) {
    if (!lines || lines.length === 0) return '';
    const compressed = lines.map((line) => compressAnsiLine(line.replace(/ +$/u, '')));
    while (compressed.length > 0 && compressed[compressed.length - 1] === '') compressed.pop();
    return compressed.join('\n');
}

function payloadToLines(payload) {
    const lines = payload.split('\n');
    while (lines.length < 24) lines.push('');
    return lines.slice(0, 24);
}

// ---------------------------------------------------------------------------
// OSC 7777 marker stream, with passthrough
// ---------------------------------------------------------------------------
//
// Wire format (win/tty/termcap.c, patch 006):
//   ESC ] 7777 ; KIND=k ; SEQ=n ; ANIM=a ; CX=x ; CY=y ; LEN=l BEL <l bytes>
//
// Everything that is not part of a marker block is real terminal output and
// is handed to onPassthrough in order. The payload is length-delimited, so a
// BEL or ESC inside it can never be mistaken for the next header.

const INTRODUCER = Buffer.from('\x1b]7777;');

class MarkerStream {
    constructor({ onMarker, onPassthrough }) {
        this.onMarker = onMarker;
        this.onPassthrough = onPassthrough;
        this.buf = Buffer.alloc(0);
        this.stopped = false;
    }

    stop() { this.stopped = true; this.buf = Buffer.alloc(0); }

    push(chunk) {
        if (this.stopped) return;
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        this._drain();
    }

    _drain() {
        for (;;) {
            if (this.stopped) return;
            const idx = this.buf.indexOf(INTRODUCER);
            if (idx < 0) {
                // No marker in flight. Forward everything except a tail that
                // could still turn into an introducer once more bytes land.
                const keep = Math.min(INTRODUCER.length - 1, this.buf.length);
                const cut = this.buf.length - keep;
                if (cut > 0) {
                    this.onPassthrough(this.buf.subarray(0, cut));
                    this.buf = Buffer.from(this.buf.subarray(cut));
                }
                return;
            }
            if (idx > 0) {
                this.onPassthrough(this.buf.subarray(0, idx));
                this.buf = Buffer.from(this.buf.subarray(idx));
                continue;
            }
            const bel = this.buf.indexOf(0x07, INTRODUCER.length);
            if (bel < 0) return;                       // header still arriving
            const meta = parseMarkerHeader(
                this.buf.subarray(INTRODUCER.length, bel).toString('ascii'));
            const total = bel + 1 + meta.len;
            if (this.buf.length < total) return;       // payload still arriving
            const payload = this.buf.subarray(bel + 1, total).toString('utf8');
            this.buf = Buffer.from(this.buf.subarray(total));
            this.onMarker({ ...meta, payload });
        }
    }
}

function parseMarkerHeader(header) {
    const out = { kind: '', seq: 0, anim: 0, cx: 0, cy: 0, len: 0 };
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const k = part.slice(0, eq);
        const v = part.slice(eq + 1);
        if (k === 'KIND') out.kind = v;
        else if (k === 'SEQ') out.seq = parseInt(v, 10) || 0;
        else if (k === 'ANIM') out.anim = parseInt(v, 10) || 0;
        else if (k === 'CX') out.cx = parseInt(v, 10) || 0;
        else if (k === 'CY') out.cy = parseInt(v, 10) || 0;
        else if (k === 'LEN') out.len = parseInt(v, 10) || 0;
    }
    return out;
}

// ---------------------------------------------------------------------------
// PRNG log (mirrors scripts/record-session.mjs parseRngLines)
// ---------------------------------------------------------------------------

function parseRngLines(text) {
    const out = [];
    for (const raw of text.split('\n')) {
        const line = raw.trimEnd();
        if (!line) continue;
        const c0 = line[0];
        if (c0 === '>' || c0 === '<' || c0 === '^') { out.push(line); continue; }
        const sp = line.indexOf(' ');
        if (sp < 0) continue;
        out.push(line.slice(sp + 1).replace(' = ', '='));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Playground hygiene (from scripts/record-session.mjs; first-segment variant)
// ---------------------------------------------------------------------------

async function ensureScorefiles(installDir) {
    for (const name of ['record', 'xlogfile', 'logfile']) {
        try { const fh = await fs.open(path.join(installDir, name), 'a'); await fh.close(); } catch {}
    }
}

async function clearStaleState(installDir) {
    const saveDir = path.join(installDir, 'save');
    try {
        const entries = await fs.readdir(saveDir);
        await Promise.all(entries.map((e) => fs.unlink(path.join(saveDir, e)).catch(() => {})));
    } catch {}
    let entries = [];
    try { entries = await fs.readdir(installDir); } catch {}
    const killNames = new Set(['record', 'xlogfile', 'logfile', 'paniclog']);
    for (const name of entries) {
        const lower = name.toLowerCase();
        const full = path.join(installDir, name);
        let st;
        try { st = await fs.stat(full); } catch { continue; }
        if (!st.isFile()) continue;
        if (name.endsWith('.lua')) continue;
        if (/^\d+\S*\.\d+$/.test(name)) { await fs.unlink(full).catch(() => {}); continue; }
        if (killNames.has(lower) || lower.startsWith('bon') || lower.endsWith('.0')
            || lower.includes('wizard') || lower.includes('recorder') || lower.includes('agent')) {
            await fs.unlink(full).catch(() => {});
        }
    }
    await ensureScorefiles(installDir);
}

function parseNethackrcName(rc) {
    if (!rc) return null;
    for (const rawLine of rc.split('\n')) {
        const line = rawLine.trim();
        const upper = line.toUpperCase();
        if (!(upper.startsWith('OPTIONS=') || upper.startsWith('OPTIONS ='))) continue;
        for (const opt of line.slice(line.indexOf('=') + 1).split(',')) {
            const t = opt.trim();
            if (t.toLowerCase().startsWith('name:')) return t.slice('name:'.length).trim();
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// The recording session
// ---------------------------------------------------------------------------

async function playAndRecord(cfg, ui) {
    const scratch = cfg.scratch;
    const rngLogPath = path.join(scratch, 'rng.log');
    const homeDir = path.join(scratch, 'home');
    const cStepsPath = path.join(scratch, 'c-steps.ndjson');
    const errPath = path.join(scratch, 'game.err');

    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, '.nethackrc'), cfg.nethackrc || '');
    await fs.writeFile(rngLogPath, '');
    await fs.writeFile(cStepsPath, '');
    await clearStaleState(cfg.installDir);

    // nh_getenv() drops env values longer than BUFSZ/2 (128); a deep checkout
    // path silently falls back to the compiled-in playground. Short symlink.
    let envInstallDir = cfg.installDir;
    if (cfg.installDir.length > 120) {
        envInstallDir = path.join(scratch, 'nhdir');
        await fs.symlink(cfg.installDir, envInstallDir).catch(() => {});
    }

    const env = {
        ...process.env,
        NETHACKDIR: envInstallDir,
        HACKDIR: envInstallDir,
        HOME: homeDir,
        TERM: 'xterm-256color',
        TZ: cfg.tz,
        NETHACK_NO_DELAY: '1',
        NETHACK_SEED: String(cfg.seed),
        NETHACK_FIXED_DATETIME: cfg.datetime,
        NETHACK_RNGLOG: rngLogPath,
        NOMUX_MARKERS: '1',
        NETHACK_RAW_KEYS: '1',
    };

    const scripted = cfg.scriptedKeys != null;
    const interactive = !scripted && process.stdin.isTTY;

    // Raw mode first, so keys typed during startup are captured rather than
    // echoed by the line discipline. stdin stays paused until the handler is
    // attached below; the kernel buffers whatever is typed meanwhile.
    let restoreTty = () => {};
    if (interactive) {
        process.stdin.setRawMode(true);
        restoreTty = () => {
            try { process.stdin.setRawMode(false); } catch {}
            try { process.stdin.pause(); } catch {}
        };
    }

    const playerName = parseNethackrcName(cfg.nethackrc) ?? '';
    const errFd = fsSync.openSync(errPath, 'a');
    const child = spawn(cfg.binary, ['-u', playerName], {
        env, stdio: ['pipe', 'pipe', errFd],
    });
    child.stdin.on('error', () => {});

    const expectedSteps = scripted ? cfg.scriptedKeys.length + 1 : Infinity;

    const steps = [];
    let moves = '';
    let pendingAnimFrames = [];
    let lastRngBytes = 0;
    let awaitingBoundary = true;     // a key (or startup) is in flight
    const queue = [];                // key bytes waiting for a boundary
    let finished = false;
    let finishReason = '';
    let timeoutHandle = null;
    let resolveDone;
    const done = new Promise((res) => { resolveDone = res; });

    if (scripted) for (const ch of cfg.scriptedKeys) queue.push(ch.charCodeAt(0) & 0xff);

    const armTimeout = (ms, why) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (!Number.isFinite(ms)) { timeoutHandle = null; return; }
        timeoutHandle = setTimeout(() => finish(`timeout: ${why} (${ms}ms)`), ms);
    };
    const disarmTimeout = () => { if (timeoutHandle) clearTimeout(timeoutHandle); timeoutHandle = null; };

    const readRngDelta = async () => {
        let rngText = '';
        try {
            const fh = await fs.open(rngLogPath, 'r');
            try {
                const st = await fh.stat();
                if (st.size > lastRngBytes) {
                    const buf = Buffer.alloc(st.size - lastRngBytes);
                    await fh.read(buf, 0, buf.length, lastRngBytes);
                    rngText = buf.toString('utf8');
                    lastRngBytes = st.size;
                }
            } finally { await fh.close(); }
        } catch {}
        return parseRngLines(rngText);
    };

    // JS mirror: display only. Never awaited, never blocks the C side.
    const mirror = cfg.mirror
        ? makeMirror({ cfg, cStepsPath, onResult: (r) => ui.setJs(r), onBusy: (b) => ui.setBusy(b) })
        : null;

    const sendNextKey = () => {
        if (finished || queue.length === 0) return;
        const byte = queue.shift();
        // Canonical convention (scripts/record-session.mjs): the corpus was
        // captured under a tmux pty whose line discipline maps CR→LF (ICRNL).
        // Our stdin is a plain pipe, so we do the translation ourselves and
        // record the key as the CR the player actually pressed.
        moves += String.fromCharCode(byte);
        awaitingBoundary = true;
        child.stdin.write(Buffer.from([byte === 0x0d ? 0x0a : byte]));
        armTimeout(scripted ? 20000 : 60000, `after key ${moves.length}`);
    };

    const finish = (reason) => {
        if (finished) return;
        finished = true;
        finishReason = reason;
        disarmTimeout();
        stream.stop();
        if (mirror) mirror.stop();
        try { child.stdin.end(); } catch {}
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 800).unref();
        chain.then(() => resolveDone(), () => resolveDone());
    };

    const onInputMarker = async (m) => {
        const screen = encodeScreenAnsiRle(payloadToLines(m.payload));
        const rng = await readRngDelta();
        // Key attribution by marker SEQ, exactly as scripts/record-session.mjs
        // does it, so a recipe played here and replayed there produce
        // byte-identical segments.
        const stepIdx = m.seq - 1;
        const step = {
            key: stepIdx === 0 ? null : (moves[stepIdx - 1] ?? null),
            rng, screen, cursor: [m.cx, m.cy, 1],
        };
        if (pendingAnimFrames.length) { step.animation_frames = pendingAnimFrames; pendingAnimFrames = []; }
        steps.push(step);
        try { fsSync.appendFileSync(cStepsPath, JSON.stringify(step) + '\n'); } catch {}
        awaitingBoundary = false;

        ui.setC(screen, [m.cx, m.cy], { step: steps.length, keys: moves.length });

        if (steps.length >= expectedSteps) { finish('all scripted keys consumed'); return; }
        if (queue.length > 0) sendNextKey();
        else if (scripted) { try { child.stdin.end(); } catch {} armTimeout(10000, 'awaiting exit'); }
        else disarmTimeout();     // the human's turn: wait as long as it takes
        if (mirror) mirror.request(moves);
    };

    let chain = Promise.resolve();
    const stream = new MarkerStream({
        onPassthrough: (bytes) => ui.passthrough(bytes),
        onMarker: (m) => {
            if (m.kind === 'anim') {
                const screen = encodeScreenAnsiRle(payloadToLines(m.payload));
                pendingAnimFrames.push({ screen, cursor: [m.cx, m.cy, 1] });
                ui.setAnim(screen, [m.cx, m.cy]);
                return;
            }
            if (m.kind !== 'input') return;
            chain = chain.then(() => onInputMarker(m)).catch((e) => finish(`marker error: ${e.message}`));
        },
    });

    child.stdout.on('data', (chunk) => stream.push(chunk));
    child.stdout.on('error', () => {});
    child.on('error', (e) => finish(`spawn error: ${e.message}`));
    child.on('close', (code, signal) => {
        if (finished) return;
        // Let queued markers (death screen, topten) settle before stopping.
        chain.then(() => setTimeout(() => finish(
            signal ? `game exited on ${signal}` : `game exited (code ${code})`), 60));
    });

    if (interactive) {
        process.stdin.resume();
        process.stdin.on('data', (buf) => {
            for (const byte of buf) {
                if (byte === KEY_FINISH) { finish('Ctrl-] pressed'); return; }
                if (byte === KEY_INTR) { finish('Ctrl-C pressed'); return; }
                // Only 7-bit keys are recordable: the session `moves` string is
                // replayed byte-per-char, and a >0x7f byte would be re-encoded
                // as two UTF-8 bytes on replay and desync the trace.
                if (byte >= 0x80) continue;
                queue.push(byte);
            }
            if (!awaitingBoundary) sendNextKey();
        });
    }

    armTimeout(20000, 'first marker from recorder');
    await done;
    restoreTty();
    try { fsSync.closeSync(errFd); } catch {}

    return { steps, moves, finishReason, errPath };
}

// ---------------------------------------------------------------------------
// JS mirror driver — one short-lived child per refresh, coalesced.
// ---------------------------------------------------------------------------

function makeMirror({ cfg, cStepsPath, onResult, onBusy }) {
    const runner = path.join(TOOLS_DIR, 'js-mirror-run.mjs');
    const jobPath = path.join(cfg.scratch, 'mirror-job.json');
    let busy = false;
    let pending = null;
    let stopped = false;
    let active = null;

    const launch = (moves) => {
        if (stopped) return;
        busy = true;
        onBusy(true);
        try {
            fsSync.writeFileSync(jobPath, JSON.stringify({
                root: ROOT,
                seed: cfg.seed,
                datetime: cfg.datetime,
                nethackrc: cfg.nethackrc,
                moves,
                cStepsPath,
            }));
        } catch {}
        const child = spawn(process.execPath, [runner, jobPath], {
            cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        });
        active = child;
        let out = '';
        let err = '';
        child.stdout.on('data', (b) => { out += b; });
        child.stderr.on('data', (b) => { err += b; });
        child.on('error', (e) => { err += String(e.message); });
        child.on('close', () => {
            active = null;
            busy = false;
            onBusy(false);
            if (stopped) return;
            let res;
            try { res = JSON.parse(out.trim().split('\n').pop() || '{}'); }
            catch { res = { ok: false, error: (err.trim().split('\n').pop() || 'mirror produced no output').slice(0, 300) }; }
            if (res && res.ok === false && !res.error && err) res.error = err.trim().slice(-300);
            onResult(res);
            if (pending !== null) { const nx = pending; pending = null; launch(nx); }
        });
    };

    return {
        request(moves) { if (busy) pending = moves; else launch(moves); },
        stop() { stopped = true; pending = null; if (active) { try { active.kill('SIGKILL'); } catch {} } },
    };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

// DEC special-graphics → box drawing, so the panes look like a real terminal
// running with symset:DECgraphics.
const DECGFX = {
    j: '┘', k: '┐', l: '┌', m: '└', n: '┼', q: '─', t: '├',
    u: '┤', v: '┴', w: '┬', x: '│', a: '▒', '`': '◆', f: '°',
    g: '±', o: '⎺', p: '⎻', r: '⎼', s: '⎽', '~': '·', y: '≤', z: '≥',
};

function sgrFor(cell) {
    const parts = [];
    if (cell.attr & 2) parts.push('1');
    if (cell.attr & 4) parts.push('4');
    if (cell.attr & 1) parts.push('7');
    const c = cell.color;
    if (c === 8 || c == null) parts.push('39');
    else if (c < 8) parts.push(String(30 + c));
    else parts.push(String(90 + (c - 8)));
    return `\x1b[0;${parts.join(';')}m`;
}

// Plain mode: hand the recorder's own terminal output straight to the tty.
function makePlainUI() {
    return {
        passthrough: (bytes) => process.stdout.write(bytes),
        setC() {}, setAnim() {}, setJs() {}, setBusy() {},
        stop() { process.stdout.write('\x1b[?1049l\x1b[0m\x1b[?25h'); },
    };
}

// Silent mode: scripted runs have no terminal at all.
function makeNullUI() {
    return { passthrough() {}, setC() {}, setAnim() {}, setJs() {}, setBusy() {}, stop() {} };
}

// Split mode: we draw both panes ourselves from the captured frames. The
// C pane is exactly the frame that goes into the JSON.
async function makeSplitUI(layout, cfg) {
    const { decodeScreen, ROWS_24, COLS_80 } =
        await import(pathToFileURL(path.join(ROOT, 'frozen', 'screen-decode.mjs')).href);

    const W = COLS_80;
    const state = {
        cScreen: '', cCursor: [0, 0], meta: { step: 0, keys: 0 },
        js: null, busy: false,
    };
    let pendingDraw = null;

    const paneOrigin = (which) => (layout === 'h'
        ? { row: 2, col: which === 'c' ? 1 : W + 3 }
        : { row: which === 'c' ? 2 : ROWS_24 + 4, col: 1 });

    const gridLines = (screen, diffSet) => {
        const grid = decodeScreen(screen || '');
        const lines = [];
        for (let r = 0; r < ROWS_24; r++) {
            let line = '';
            let last = '';
            for (let c = 0; c < W; c++) {
                const cell = grid[r][c];
                const ch = cell.decgfx ? (DECGFX[cell.ch] || cell.ch) : cell.ch;
                const sgr = (diffSet && diffSet.has(r * 100 + c)) ? '\x1b[0;1;41;97m' : sgrFor(cell);
                if (sgr !== last) { line += sgr; last = sgr; }
                line += ch;
            }
            lines.push(line + '\x1b[0m');
        }
        return lines;
    };

    const draw = () => {
        if (pendingDraw) { clearTimeout(pendingDraw); pendingDraw = null; }
        const cols = process.stdout.columns || 80;
        const rows = process.stdout.rows || 24;
        const m = state.js;
        const at = (r, c) => `\x1b[${r};${c}H`;
        const out = ['\x1b[?25l\x1b[H\x1b[2J'];

        const cO = paneOrigin('c');
        const jO = paneOrigin('js');
        out.push(at(cO.row - 1, cO.col)
            + `\x1b[1;97;44m C RECORDER — ground truth   seed ${cfg.seed}   `
            + `step ${state.meta.step}   keys ${state.meta.keys} \x1b[0m`);

        let jsHead;
        if (!m) jsHead = '\x1b[1;97;100m JS MIRROR — waiting for the first run… \x1b[0m';
        else if (m.ok === false) jsHead = '\x1b[1;97;41m JS MIRROR — ERROR \x1b[0m';
        else if (m.match) jsHead = `\x1b[1;30;42m JS MIRROR — MATCH   rng ${m.rngJs}/${m.rngC}   ${m.comparedSteps} steps \x1b[0m`;
        else {
            const bits = [];
            if (m.rngFirstDiff !== null) bits.push(`rng @#${m.rngFirstDiff} (C ${m.rngC} / JS ${m.rngJs})`);
            if (m.screenFirstDiff !== null) bits.push(`screen @step ${m.screenFirstDiff}`);
            jsHead = `\x1b[1;97;41m JS MIRROR — DIVERGE   ${bits.join('   ')} \x1b[0m`;
        }
        out.push(at(jO.row - 1, jO.col) + jsHead);

        const cLines = gridLines(state.cScreen, null);
        for (let r = 0; r < ROWS_24; r++) out.push(at(cO.row + r, cO.col) + cLines[r]);

        const diff = new Set((m && m.diffCells ? m.diffCells : []).map(([r, c]) => r * 100 + c));
        const jsLines = gridLines(m && m.ok !== false ? (m.screen || '') : '', diff);
        for (let r = 0; r < ROWS_24; r++) out.push(at(jO.row + r, jO.col) + jsLines[r]);

        if (m && m.ok === false) {
            out.push(at(jO.row + 1, jO.col + 2)
                + `\x1b[31m${String(m.error || '').replace(/\s+/g, ' ').slice(0, W - 4)}\x1b[0m`);
        }

        if (layout === 'h' && cols >= W * 2 + 2) {
            for (let r = 0; r < ROWS_24 + 1; r++) out.push(at(cO.row - 1 + r, W + 2) + '\x1b[2m│\x1b[0m');
        }

        const footRow = layout === 'h' ? ROWS_24 + 2 : ROWS_24 * 2 + 4;
        const lag = m ? Math.max(0, state.meta.keys - m.moves) : state.meta.keys;
        const foot = `\x1b[2mmirror ${m ? m.moves : 0} keys`
            + `${lag ? ` (${lag} behind)` : ''}${state.busy ? ' …running' : ''}`
            + `${m ? `  ${m.ms}ms` : ''}   Ctrl-] finish & write JSON   `
            + `out: ${path.basename(cfg.outPath)}\x1b[0m`;
        if (footRow <= rows) out.push(at(footRow, 1) + foot);

        // Put the real cursor where the game left it, in the C pane.
        out.push(at(cO.row + (state.cCursor[1] | 0), cO.col + (state.cCursor[0] | 0)) + '\x1b[?25h');
        process.stdout.write(out.join(''));
    };

    const schedule = (immediate) => {
        if (immediate) { draw(); return; }
        if (pendingDraw) return;
        pendingDraw = setTimeout(draw, 16);
    };

    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
    const onResize = () => schedule(true);
    process.stdout.on('resize', onResize);
    schedule(true);

    return {
        passthrough() { /* the recorder's own rendering is not used in this mode */ },
        setC(screen, cursor, meta) { state.cScreen = screen; state.cCursor = cursor; state.meta = meta; schedule(true); },
        setAnim(screen, cursor) { state.cScreen = screen; state.cCursor = cursor; schedule(false); },
        setJs(r) { state.js = r; schedule(true); },
        setBusy(b) { state.busy = b; schedule(false); },
        stop() {
            if (pendingDraw) clearTimeout(pendingDraw);
            process.stdout.off('resize', onResize);
            process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
        },
    };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(code = 2) {
    process.stderr.write(`Usage: node tools/play-record.mjs <seed> [name] [options]

  --out <file>        session JSON destination
  --datetime <ts>     pinned YYYYMMDDHHMMSS (default: now)
  --rc <file>         .nethackrc contents
  --options <str>     OPTIONS= body, e.g. "name:Noah,role:Valkyrie,race:human"
  --tz <zone>         default America/New_York
  --no-mirror         no split pane, no JS mirror
  --keys <string>     non-interactive: play these keys and exit
  --keys-file <file>  non-interactive: play this file's bytes as keys
  --keep-tmp          keep the scratch dir

  In game: Ctrl-] (or Ctrl-C) finishes the recording and writes the JSON.
`);
    process.exit(code);
}

function nowStamp(tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
    const hh = parts.hour === '24' ? '00' : parts.hour;
    return `${parts.year}${parts.month}${parts.day}${hh}${parts.minute}${parts.second}`;
}

async function exists(p) {
    try { await fs.access(p, fsConstants.F_OK); return true; } catch { return false; }
}

const VALUE_FLAGS = new Set(['--out', '--datetime', '--rc', '--options', '--tz', '--keys', '--keys-file']);

async function main() {
    const argv = process.argv.slice(2);
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') usage(argv.length ? 0 : 2);

    const opt = (name, dflt = null) => {
        const i = argv.indexOf(name);
        return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
    };
    const flag = (name) => argv.includes(name);

    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) { if (VALUE_FLAGS.has(argv[i])) i++; continue; }
        positional.push(argv[i]);
    }
    const seed = Number(positional[0]);
    if (!Number.isFinite(seed)) usage();
    const name = positional[1] || `play-seed${String(seed).padStart(4, '0')}`;

    const tz = opt('--tz', 'America/New_York');
    const datetime = opt('--datetime', nowStamp(tz));
    let nethackrc;
    if (opt('--rc')) nethackrc = await fs.readFile(path.resolve(opt('--rc')), 'utf8');
    else if (opt('--options')) nethackrc = `OPTIONS=${opt('--options')}\nOPTIONS=!autopickup,suppress_alert:3.4.3,symset:DECgraphics\n`;
    else nethackrc = 'OPTIONS=symset:DECgraphics\n';   // full interactive chargen, like seed0004

    let scriptedKeys = null;
    if (opt('--keys') !== null) scriptedKeys = opt('--keys');
    else if (opt('--keys-file')) scriptedKeys = await fs.readFile(path.resolve(opt('--keys-file')), 'utf8');

    const outPath = path.resolve(opt('--out') || path.join(ROOT, 'sessions-live', `${name}.session.json`));
    const binary = process.env.NETHACK_BINARY || DEFAULT_BINARY;
    const installDir = process.env.NETHACK_INSTALL || DEFAULT_INSTALL;
    if (!await exists(binary)) {
        throw new Error(`recorder binary not found: ${binary}\n  build it: bash nethack-c/build-recorder.sh`);
    }

    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nh-play-'));
    const cfg = {
        seed, name, datetime, tz, nethackrc, outPath, binary, installDir,
        scratch, scriptedKeys, keepTmp: flag('--keep-tmp'), mirror: false,
    };

    let ui;
    let modeNote;
    if (scriptedKeys !== null) {
        ui = makeNullUI();
        modeNote = 'scripted (non-interactive)';
    } else if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('interactive play needs a terminal (or pass --keys/--keys-file)');
    } else {
        const cols = process.stdout.columns || 80;
        const rows = process.stdout.rows || 24;
        let layout = null;
        if (!flag('--no-mirror')) {
            if (cols >= 2 * 80 + 2 && rows >= 27) layout = 'h';
            else if (rows >= 52 && cols >= 80) layout = 'v';
        }
        if (layout) {
            cfg.mirror = true;
            ui = await makeSplitUI(layout, cfg);
            modeNote = `split ${layout === 'h' ? 'side-by-side' : 'stacked'} + JS mirror`;
        } else {
            const why = flag('--no-mirror') ? '--no-mirror'
                : `terminal is ${cols}x${rows}; the split needs 162x27 (side by side) or 80x52 (stacked)`;
            process.stderr.write(`[play-record] JS mirror off: ${why}\n`);
            ui = makePlainUI();
            modeNote = 'plain single pane';
        }
    }

    let result;
    try {
        result = await playAndRecord(cfg, ui);
    } finally {
        ui.stop();
    }

    const doc = {
        version: 5,
        segments: [{
            seed: cfg.seed,
            datetime: cfg.datetime,
            nethackrc: cfg.nethackrc,
            moves: result.moves,
            steps: result.steps,
        }],
        source: 'c',
        recorded_with: {
            tool: 'tools/play-record.mjs',
            mode: scriptedKeys != null ? 'scripted' : 'interactive',
        },
    };
    await fs.mkdir(path.dirname(cfg.outPath), { recursive: true });
    await fs.writeFile(cfg.outPath, JSON.stringify(doc));

    const rng = result.steps.reduce((n, s) => n + (s.rng || []).length, 0);
    const rel = path.relative(process.cwd(), cfg.outPath);
    process.stderr.write(
        `\n[play-record] finished: ${result.finishReason}  (${modeNote})\n`
        + `[play-record] ${result.steps.length} steps / ${result.moves.length} keys / ${rng} PRNG calls\n`
        + `[play-record] wrote ${cfg.outPath}\n`
        + `[play-record] score it:  node frozen/ps_test_runner.mjs ${rel}\n`);

    if (cfg.keepTmp) process.stderr.write(`[play-record] scratch kept at ${scratch}\n`);
    else await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
    process.exit(0);
}

main().catch((e) => {
    process.stderr.write(`[play-record] ${e.stack || e.message || e}\n`);
    process.exit(1);
});
