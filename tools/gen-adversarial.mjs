#!/usr/bin/env node
// gen-adversarial.mjs — build adversarial MULTI-SEGMENT session recipes.
//
// Emits v5 session *recipes* (segments with seed/datetime/nethackrc/moves,
// no steps) which scripts/record-session.mjs drives through the patched C
// recorder to produce ground truth.  Sibling of tools/gen-omnibus.mjs; that
// one goes for breadth of *commands*, these go for breadth of *context* —
// the same bytes fed to the game while it is in the middle of a getlin
// prompt, a menu, a direction prompt, a --More--, a getpos cursor pick,
// and across save/restore boundaries.
//
// Usage:
//   node tools/gen-adversarial.mjs <ctrlspam|combos|signals> [--out <recipe.json>]
//                                  [--only seg1,seg2] [--control]
//
// RECORDED SESSIONS (all byte-exact under frozen/ps_test_runner.mjs, and each
// re-records identically — verified by repeat recordings, see section 4 of
// docs/NOTES-signal-laced-recording.md):
//
//   sessions-extra/gen9997-ctrl-spam-segments.session.json
//       6 segments, 5760 keys, 5670 steps, 18431 PRNG calls.
//       save -> restore -> #quit death -> fresh game -> fresh altmeta game ->
//       fresh number_pad game -> hand-walked chargen. All 31 usable control
//       bytes (^Z excluded: SIGTSTP) swept in 10 orders across 10 input
//       contexts: top level, getlin, menu, menu search prompt, direction
//       prompt, getpos travel cursor, --More--/text window, yn prompt, the
//       half-typed count state, the '#' extended-command line, plus the
//       chargen name prompt and role/race/gender/alignment windows.
//
//   sessions-extra/gen9997-combo-sequences.session.json
//       4 segments, 2086 keys, 1997 steps, 24653 PRNG calls.
//       save -> restore (rc gains 'altmeta' across the boundary) -> restore
//       -> #quit death -> fresh number_pad:1 game. 3- and 4-key chains:
//       counts, count+direction, prefix+direction, count+prefix+direction,
//       prefix+prefix, altmeta ESC-x pairs, ESC-prefixed garbage, ^A repeat
//       chains, and menu->count->ESC->prefix->direction mode mixing.
//
//   sessions-extra/gen9997-signal-inert-laced.session.json
//       3 segments, 826 keys, 733 steps, 4880 PRNG calls, recorded while 59
//       real POSIX signals were delivered to the recorder process.
//       See docs/NOTES-signal-laced-recording.md for the full signal matrix
//       and for why only the inert signals can appear in the corpus.
//
// Exclusions (same reasons as gen-omnibus.mjs):
//   ^Z (0x1a)  — SUSPEND raises SIGTSTP, which stops the headless recorder.
//   '!' #shell — forks /bin/sh, which eats the recorder's stdin pipe.
//   #saveoptions and help topic 'g' — print the process's $HOME path, which
//   a re-recording (fresh mkdtemp $HOME) can never reproduce.

import { promises as fs } from 'node:fs';

const ESC = '\x1b';
const NL = '\n';
const C = (ch) => String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f);

const BASE_OPTS = 'OPTIONS=!autopickup,!legacy,!tutorial,suppress_alert:3.4.3,symset:DECgraphics\n'
    + 'OPTIONS=disclose:-i -a -v -g -c -o\n';
const DISCLOSE_YES = 'OPTIONS=disclose:yi ya yv yg yc yo\n';
const DEBUG = 'OPTIONS=playmode:debug\n';

function rc(name, role, race, gender, align, extra = '') {
    return `OPTIONS=name:${name},role:${role},race:${race},gender:${gender},align:${align}\n`
        + BASE_OPTS + extra;
}
// Same as rc() but with the "prompt, default yes" disclosure set, needed by
// the segments that end in #quit so every end-of-game screen is recorded.
function rcDisclose(name, role, race, gender, align, extra = '') {
    return rc(name, role, race, gender, align, extra)
        .replace('OPTIONS=disclose:-i -a -v -g -c -o\n', DISCLOSE_YES);
}

const PROLOGUE = '   n';
const CANCEL = ESC + ESC + ESC;
const PAD = ' '.repeat(48);
// Wizard-mode survival kit (verbatim from gen-omnibus.mjs): the spam sweeps
// take hundreds of turns and an unlucky early death would truncate them.
const KIT = '#levelchange' + NL + '30' + NL + PAD
    + C('w') + 'blessed amulet of life saving' + NL + '    '
    + C('w') + 'blessed +5 gray dragon scale mail' + NL + '    '
    + C('w') + 'blessed +5 speed boots' + NL + '    '
    + C('w') + 'blessed ring of free action' + NL + '    '
    + 'Wb    Wc    Wd    ';

// Control bytes 0x00..0x1f, NUL included, ^Z (0x1a) excluded.
const CTRLS = [];
for (let c = 0x00; c <= 0x1f; c++) {
    if (c === 0x1a) continue;
    CTRLS.push(String.fromCharCode(c));
}

// Deterministic order permutations, so each segment hits the 31 bytes in a
// different sequence (a wedge that only shows up when ^L follows ^V, say).
const ORDERS = {
    forward: (a) => a.slice(),
    reverse: (a) => a.slice().reverse(),
    // even indices then odd indices
    stride: (a) => a.filter((_, i) => i % 2 === 0).concat(a.filter((_, i) => i % 2 === 1)),
    // adjacent pairs swapped
    swapped: (a) => {
        const out = a.slice();
        for (let i = 0; i + 1 < out.length; i += 2) {
            const t = out[i]; out[i] = out[i + 1]; out[i + 1] = t;
        }
        return out;
    },
    // walk with a stride coprime to the length
    rot7: (a) => a.map((_, i) => a[(i * 7) % a.length]),
};

const METAKEYS = ['?', 'a', 'A', 'c', 'C', 'd', 'e', 'f', 'g', 'i', 'j', 'l',
    'm', 'n', 'o', 'p', 'R', 'r', 's', 'T', 't', 'u', 'V', 'v', 'w', 'X'];

const DIRS8 = 'hjklyubn';
const DIRSZ = DIRS8 + '<>';

// ---------------------------------------------------------------------------
// 1. ctrl-spam-across-segments
// ---------------------------------------------------------------------------
// Every control byte, in five different *contexts* and five different
// orders, spread over four segments joined by a save/restore and a death.

const ctxTop = (cs) => cs.map((c) => c + CANCEL).join('');
// getlin: #annotate opens "What do you want to call this dungeon level?"
const ctxGetlin = (cs) => cs.map((c) => '#annotate' + NL + c + 'x' + NL + CANCEL).join('');
// menu: the inventory window (a perm menu with selectable entries)
const ctxMenu = (cs) => cs.map((c) => 'i' + c + ESC + ESC).join('');
// direction prompt: 'F' (fight) always asks "In what direction?"
const ctxDir = (cs) => cs.map((c) => 'F' + c + ESC + ESC).join('');
// getpos cursor picker: '_' (travel) opens "(For instructions type a ?)"
const ctxGetpos = (cs) => cs.map((c) => '_' + c + ESC + ESC).join('');
// text window / --More--: #version paints a paged display
const ctxMore = (cs) => cs.map((c) => '#version' + NL + c + '  ' + ESC + ESC).join('');

function segCtrlSave() {
    let m = PROLOGUE + KIT;
    m += ctxTop(ORDERS.forward(CTRLS));
    m += ctxGetlin(ORDERS.stride(CTRLS));
    m += ctxMenu(ORDERS.reverse(CTRLS));
    m += 'i' + ESC + '\\' + ESC + C('x') + ' ' + ESC;
    m += '#annotate' + NL + 'ctrl spam save point' + NL;
    m += 'Sy';                                   // save & exit
    return m;
}

function segCtrlRestoreDie() {
    let m = '   ';                               // restore banner --More--
    m += 'i' + ESC + C('o') + '   ' + ESC;
    m += ctxTop(ORDERS.reverse(CTRLS));
    m += ctxDir(ORDERS.swapped(CTRLS));
    m += ctxMore(ORDERS.rot7(CTRLS));
    m += 'i' + ESC + C('x') + ' ' + ESC;
    m += '#quit' + NL + 'y';                     // "Really quit...? [yn]"
    m += 'n';                                    // "Dump core? [ynq]" -> no
    for (let i = 0; i < 6; i++) m += 'y' + ' '.repeat(10);
    m += ' '.repeat(40);                         // tombstone + top-ten
    return m;
}

function segCtrlFresh() {
    let m = PROLOGUE + KIT;
    m += ctxTop(ORDERS.stride(CTRLS));
    m += ctxGetpos(ORDERS.forward(CTRLS));
    m += ctxGetlin(ORDERS.reverse(CTRLS));
    // Control bytes back-to-back with no cancel in between — whatever
    // prompt one opens, the next one answers.
    m += ORDERS.rot7(CTRLS).join('') + CANCEL;
    m += ORDERS.swapped(CTRLS).join('') + CANCEL;
    m += 'i' + ESC + '\\' + ESC + C('x') + ' ' + ESC + 'ss:';
    return m;
}

function segCtrlAltmeta() {
    const EE = ESC + ESC;                        // one literal ESC under altmeta
    const CANCEL2 = EE + EE + EE;
    let m = PROLOGUE + KIT.split(ESC).join(EE);
    m += CTRLS.map((c) => c + CANCEL2).join('');
    // ESC-prefixed control bytes: under altmeta the ESC arms a meta key, so
    // ESC+^X asks the parser for M-^X, which is bound to nothing.
    m += ORDERS.reverse(CTRLS).map((c) => ESC + c + CANCEL2).join('');
    m += CTRLS.map((c) => 'i' + c + EE + EE).join('');
    m += 'i' + EE + '\\' + EE + C('x') + ' ' + EE + 'ss:';
    return m;
}

// The nastiest contexts: a yn_function prompt, the '#' extended-command
// line, a menu's ':' search prompt, and the half-typed count state.
function segCtrlPrompts() {
    let m = PROLOGUE + KIT;
    // yn prompt: #pray asks "Are you sure you want to pray? [yn]".
    m += CTRLS.map((c) => '#pray' + NL + c + 'n' + ESC).join('');
    // getlin for the extended command name itself.
    m += CTRLS.map((c) => '#' + c + 'q' + NL + CANCEL).join('');
    // menu search prompt (':' inside a menu opens "Search for:").
    m += CTRLS.map((c) => 'i' + ':' + c + 'a' + NL + ESC + ESC).join('');
    // half-typed count: a digit puts the parser in get_count(), so the
    // control byte lands inside the count reader, not the command reader.
    m += CTRLS.map((c) => '1' + c + ESC + ESC).join('');
    // getlin overflow: NetHack's getlin buffer is BUFSZ (256); type past it,
    // then rub out past the front of the line.
    m += '#annotate' + NL + 'A'.repeat(300) + '\x7f'.repeat(20) + C('u')
        + '\x7f'.repeat(8) + 'tail' + NL + CANCEL;
    m += 'C' + 'a' + 'B'.repeat(280) + NL + CANCEL;
    m += 'i' + ESC + '\\' + ESC + C('x') + ' ' + ESC + 'ss:';
    return m;
}

// Control bytes *before there is a game*: the askname getlin and the
// pick-a-role / race / gender / alignment windows run in player_selection(),
// a code path no other adversarial segment touches.
//
// Two bytes are held out of the chargen sweeps. ESC (0x1b) means "quit" at a
// chargen menu, and so does NUL (0x00): tty_nhgetch() maps it to ESC —
//   win/tty/wintty.c:4164  if (!i) i = '\033';
//                          /* map NUL to ESC since nethack doesn't expect NUL */
// — which the first cut of this segment discovered the hard way, exiting the
// game 40 steps in. Both are swept everywhere else in this session, where
// "cancel" is a survivable answer.
const CTRLS_NOESC = CTRLS.filter((c) => c !== ESC && c !== '\x00');

function segCtrlChargen() {
    let m = '';
    // askname getlin: control bytes inside the player-name prompt.
    m += CTRLS_NOESC.join('') + 'CtrlGen' + NL;
    m += 'n';                                    // decline "shall I pick?"
    // Role window: every control byte, then a real pick.
    m += CTRLS_NOESC.join('');
    m += 'v';                                    // Valkyrie
    m += CTRLS_NOESC.join('') + 'h';             // race: human
    m += CTRLS_NOESC.join('') + 'f';             // gender: female
    m += CTRLS_NOESC.join('') + 'n';             // alignment: neutral
    m += CTRLS_NOESC.join('') + 'y';             // "Is this ok?" -> yes
    m += '   ';                                  // intro --More--
    m += CTRLS_NOESC.map((c) => c + CANCEL).join('');
    m += 'i' + ESC + C('x') + ' ' + ESC + 'ss:';
    return m;
}

const CTRLSPAM = [
    { id: 'save', seed: 97001, dt: '20260615120000',
      rc: rcDisclose('CtrlA', 'Valkyrie', 'human', 'female', 'neutral', DEBUG),
      build: segCtrlSave },
    { id: 'restore-die', seed: 97002, dt: '20260615123000',
      rc: rcDisclose('CtrlA', 'Valkyrie', 'human', 'female', 'neutral', DEBUG),
      build: segCtrlRestoreDie },
    { id: 'fresh', seed: 97003, dt: '20260616010000',
      rc: rc('CtrlB', 'Wizard', 'gnome', 'male', 'neutral', DEBUG),
      build: segCtrlFresh },
    { id: 'altmeta', seed: 97004, dt: '20260616020000',
      rc: rc('CtrlC', 'Priest', 'human', 'female', 'lawful', DEBUG + 'OPTIONS=altmeta\n'),
      build: segCtrlAltmeta },
    { id: 'prompts', seed: 97005, dt: '20260616030000',
      rc: rc('CtrlD', 'Monk', 'human', 'male', 'lawful', DEBUG + 'OPTIONS=number_pad:0\n'),
      build: segCtrlPrompts },
    // No name/role/race in the rc: chargen has to be walked by hand.
    { id: 'chargen', seed: 97006, dt: '20260616040000',
      rc: BASE_OPTS, build: segCtrlChargen },
];

// ---------------------------------------------------------------------------
// 2. combo-sequences
// ---------------------------------------------------------------------------
// 3- and 4-key command chains: counts, prefixes, altmeta pairs, ESC garbage,
// and rapid mode mixing, across three segments joined by TWO save/restores.

const COUNTS = ['0', '1', '2', '3', '7', '12', '25', '40', '99', '100', '250', '999'];

function segComboSave() {
    let m = PROLOGUE + KIT;
    // 2-key: count + repeatable command.
    for (const n of COUNTS) m += n + 's' + ESC;
    // 3-key: count + direction (multi-digit counts are 3-4 keys already).
    for (const n of ['2', '3', '12', '25']) for (const d of 'hjkl') m += n + d + ESC;
    // 3-key: movement prefix + direction + cancel.
    for (const p of 'gGmF') for (const d of DIRSZ) m += p + d + ESC;
    // 4-key: count + prefix + direction.
    for (const n of ['2', '12']) for (const p of 'gGmF') for (const d of 'hjkl') m += n + p + d + ESC;
    // ESC-prefixed garbage: a bare ESC run followed by a real command.
    for (const k of 'gGmFsijZ0129') m += CANCEL + k + CANCEL;
    // Rapid mode mixing: open a menu, type a count into it, bail out, then
    // immediately start a prefix+direction chain.
    for (const open of ['i', 'I', 'O', '\\', '+', C('x')]) {
        m += open + '12' + ESC + ESC + 'g' + 'h' + ESC;
    }
    m += '#annotate' + NL + 'combo save point' + NL;
    m += 'Sy';
    return m;
}

function segComboRestoreAltmeta() {
    const EE = ESC + ESC;
    let m = '   ';                               // restore banner
    m += 'i' + EE + C('o') + '   ' + EE;
    // altmeta ESC-x pairs, each followed by an answer and a triple cancel.
    for (const k of METAKEYS) m += ESC + k + 'n' + EE + EE + EE;
    // 3-key altmeta chains that take an argument.
    m += ESC + 'j' + 'h' + EE + ESC + 'f' + 'h' + EE + ESC + 'c' + 'h' + EE;
    m += ESC + 'u' + 'h' + EE + ESC + 'l' + EE + EE;
    // ESC + digit: Alt+digit inside getpos, and a count under altmeta.
    for (const d of '0123456789') m += '_' + ESC + d + EE + EE;
    for (const d of '0123456789') m += ESC + d + 's' + EE;
    // ESC-prefixed garbage under altmeta: ESC ESC ESC x is "literal ESC, then
    // arm meta, then x" — a different parse from the non-altmeta segment.
    for (const k of 'gGmFsijZ') m += ESC + ESC + ESC + k + EE + EE;
    // 4-key chains that mix a count, a prefix and a meta key.
    for (const n of ['2', '12']) for (const p of 'gGmF') m += n + p + 'h' + EE;
    m += '#annotate' + NL + 'combo altmeta point' + NL;
    m += 'Sy';
    return m;
}

function segComboRestoreDie() {
    let m = '   ';                               // second restore banner
    m += 'i' + ESC + C('x') + '   ' + ESC;
    // Counts in front of commands that do not take one, and counts fed to
    // prompts that do.
    for (const k of 'ijklZOF_;/&`\\') m += '12' + k + CANCEL;
    // ^A repeat after a counted command; ^A after a cancelled command.
    m += '12' + 's' + C('a') + C('a') + ESC;
    m += CANCEL + C('a') + ESC;
    // travel / retravel chains.
    m += '_' + 'hjkl' + '.' + '   ' + ESC;
    m += C('_') + '   ' + ESC;
    m += '12' + C('_') + '   ' + ESC;
    // Prefix + prefix (a prefix key answering another prefix's direction
    // prompt), then prefix + count.
    for (const a of 'gGmF') for (const b of 'gGmF') m += a + b + 'h' + ESC;
    for (const p of 'gGmF') m += p + '12' + 'h' + ESC;
    m += '#quit' + NL + 'y' + 'n';
    for (let i = 0; i < 6; i++) m += 'y' + ' '.repeat(10);
    m += ' '.repeat(40);
    return m;
}

// A fresh game under number_pad:1, where the *same* chains parse completely
// differently: digits are directions, 'n' is the count prefix, and the
// movement prefixes move house.
function segComboNumpad() {
    let m = PROLOGUE + KIT;
    // digits-as-directions, alone and doubled.
    for (const d of '12346789') m += d + d;
    // 'n' count prefix: n<count><cmd>, including a zero count and a big one.
    for (const n of ['0', '1', '5', '12', '99', '250', '9999']) m += 'n' + n + 's' + ESC;
    for (const n of ['2', '12']) for (const d of '2468') m += 'n' + n + d + ESC;
    // 'g'/'G'/'F'/'m' prefixes with numeric directions.
    for (const p of 'gGmF') for (const d of '12346789') m += p + d + ESC;
    // '5' is the run prefix under number_pad, '0' is inventory.
    m += '5' + '4' + ESC + '5' + '6' + ESC + '0' + ESC;
    // Counts typed into a menu select the item quantity.
    for (const n of ['1', '2', '12']) m += 'i' + n + 'a' + ESC + ESC;
    m += 'D' + '2' + 'a' + NL + ESC + CANCEL;
    // ^A repeat with and without a preceding count; do_again after a cancel.
    m += 's' + '5' + C('a') + ESC + C('a') + C('a') + ESC;
    // Oversized and malformed counts, never executed.
    for (const n of ['9999', '12345', '99999', '00', '000012']) m += 'n' + n + ESC + ESC;
    m += 'i' + ESC + '\\' + ESC + C('x') + ' ' + ESC;
    return m;
}

const COMBOS = [
    { id: 'save', seed: 97101, dt: '20260620090000',
      rc: rcDisclose('ComboA', 'Samurai', 'human', 'male', 'lawful', DEBUG),
      build: segComboSave },
    { id: 'restore-altmeta', seed: 97102, dt: '20260620093000',
      // Same character, but the rc gains 'altmeta' across the save/restore
      // boundary: the restored game must pick up the new option.
      rc: rcDisclose('ComboA', 'Samurai', 'human', 'male', 'lawful', DEBUG + 'OPTIONS=altmeta\n'),
      build: segComboRestoreAltmeta },
    { id: 'restore-die', seed: 97103, dt: '20260620100000',
      rc: rcDisclose('ComboA', 'Samurai', 'human', 'male', 'lawful', DEBUG),
      build: segComboRestoreDie },
    { id: 'numpad', seed: 97104, dt: '20260620110000',
      rc: rc('ComboB', 'Barbarian', 'orc', 'female', 'chaotic', DEBUG + 'OPTIONS=number_pad:1\n'),
      build: segComboNumpad },
];

// ---------------------------------------------------------------------------
// 3. signal-laced (inert signals only)
// ---------------------------------------------------------------------------
// Real POSIX signals are delivered to the recorder process while it is
// blocked waiting for a key, in every input context the game has.  Only the
// two signals that the matrix in docs/NOTES-signal-laced-recording.md proved
// *observationally inert* are used here — SIGWINCH (caught by the tty
// windowport's winch_handler, which calls resize_tty(); with no tty behind
// the pipes the size query fails and nothing changes) and SIGCONT (no
// handler, default disposition is a no-op for a process that is running).
//
// The point of the session is the equality: this recording, taken while ~50
// signals were flying, is byte-identical to the control recording of the
// same recipe with no signals at all, and replays byte-exactly in JS — which
// is only possible because the port needs no signal machinery.  Every other
// signal is observable and therefore unreplayable (the judge hands the
// contestant only seed/datetime/nethackrc/moves), so none are in the corpus.
//
// Signal placement: `at` is an input-marker sequence number.  After the j-th
// key (1-based) has been consumed the recorder holds marker seq j+1, so a
// signal scheduled at `keys.length + 1` right after appending key j lands
// while the process sits in the read() that follows that key.

class SigSeg {
    constructor() { this.keys = ''; this.signals = []; }
    k(s) { this.keys += s; return this; }
    // Fire `sig` at the boundary right after the keys appended so far.
    sig(sig) {
        this.signals.push({ at: this.keys.length + 1, sig, pause: 25 });
        return this;
    }
    // Append keys, then fire a signal while the game sits in whatever
    // prompt/menu those keys opened.
    inCtx(open, sig, close) { return this.k(open).sig(sig).k(close); }
}

const WINCH = 'SIGWINCH';
const CONT = 'SIGCONT';

function segSignalPlay() {
    const s = new SigSeg();
    s.k(PROLOGUE).sig(WINCH).k(KIT).sig(CONT);
    // top-level command wait
    s.k('hjkl').sig(WINCH).k('hjkl').sig(CONT);
    // inside a menu
    s.inCtx('i', WINCH, ESC).inCtx('\\', CONT, ESC).inCtx('+', WINCH, ESC);
    // inside a getlin
    s.inCtx('#annotate' + NL, WINCH, 'winch level' + NL);
    s.inCtx('C' + 'a', CONT, 'cont item' + NL + CANCEL);
    // inside a --More-- / text window
    s.inCtx('#version' + NL, WINCH, '  ' + ESC + ESC);
    s.inCtx(C('x'), CONT, '  ' + ESC);
    // inside a direction prompt
    s.inCtx('F', WINCH, 'h').inCtx('#chat' + NL, CONT, 'h');
    // inside the getpos travel cursor
    s.inCtx('_', WINCH, 'hjkl').sig(CONT).k(ESC + ESC);
    // inside a yn prompt
    s.inCtx('#pray' + NL, WINCH, 'n' + ESC);
    // inside a half-typed count and a half-typed extended command
    s.inCtx('12', CONT, 's' + ESC).inCtx('#anno', WINCH, NL + CANCEL);
    // a burst: eight signals at eight consecutive boundaries
    for (let i = 0; i < 8; i++) s.k('hjkl'[i % 4]).sig(i % 2 ? WINCH : CONT);
    s.k('s'.repeat(6) + ':' + C('o') + '   ' + ESC);
    s.sig(WINCH).k('i' + ESC).sig(CONT);
    s.k('#annotate' + NL + 'signal save point' + NL);
    s.k('Sy');                                   // save & exit
    return s;
}

function segSignalRestore() {
    const s = new SigSeg();
    s.k('   ').sig(WINCH);                       // restore banner --More--
    s.k('i' + ESC).sig(CONT).k(C('o') + '   ' + ESC).sig(WINCH);
    s.k('hjkl'.repeat(3)).sig(CONT);
    s.inCtx('I' + '*', WINCH, ESC + ESC);
    s.inCtx('#optionsfull' + NL, CONT, '>><<' + ESC + ESC);
    s.inCtx('?', WINCH, 'a' + '  '.repeat(4) + ESC + ESC);
    s.inCtx('_', CONT, '@' + '.' + '   ');
    for (let i = 0; i < 6; i++) s.k('s').sig(i % 2 ? CONT : WINCH);
    s.k('i' + ESC + '\\' + ESC + C('x') + ' ' + ESC);
    s.k('Sy');
    return s;
}

function segSignalFreshDie() {
    const s = new SigSeg();
    s.k(PROLOGUE).sig(CONT).k(KIT).sig(WINCH);
    s.k('hjkl'.repeat(4)).sig(CONT);
    s.inCtx('i', WINCH, ESC).inCtx('O', CONT, '>' + ESC + ESC);
    for (let i = 0; i < 10; i++) s.k('s').sig(i % 2 ? WINCH : CONT);
    s.k(':' + 'i' + ESC);
    // die with the full disclosure walk, signals flying through the
    // end-of-game screens too.
    s.k('#quit' + NL).sig(WINCH).k('y').sig(CONT).k('n');
    for (let i = 0; i < 6; i++) { s.k('y' + ' '.repeat(10)); if (i % 2) s.sig(WINCH); }
    s.k(' '.repeat(40));
    return s;
}

const SIGNALS = [
    { id: 'play-save', seed: 97301, dt: '20260701090000',
      rc: rcDisclose('SigA', 'Valkyrie', 'human', 'female', 'neutral', DEBUG),
      build: segSignalPlay },
    { id: 'restore', seed: 97302, dt: '20260701093000',
      rc: rcDisclose('SigA', 'Valkyrie', 'human', 'female', 'neutral', DEBUG),
      build: segSignalRestore },
    { id: 'fresh-die', seed: 97303, dt: '20260701100000',
      rc: rcDisclose('SigB', 'Ranger', 'elf', 'female', 'chaotic', DEBUG),
      build: segSignalFreshDie },
];

// ---------------------------------------------------------------------------

const RECIPES = { ctrlspam: CTRLSPAM, combos: COMBOS, signals: SIGNALS };

async function main() {
    const argv = process.argv.slice(2);
    const which = argv[0];
    if (!RECIPES[which]) {
        console.error('Usage: node tools/gen-adversarial.mjs <ctrlspam|combos> [--out file]');
        process.exit(2);
    }
    const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : `${which}-recipe.json`;
    const only = argv.includes('--only')
        ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null;
    // --control drops the signal schedules, producing the otherwise identical
    // recipe used to prove the laced recording is byte-identical.
    const control = argv.includes('--control');
    const defs = RECIPES[which].filter((s) => !only || only.has(s.id));
    const segs = defs.map((s) => {
        const built = s.build();
        const seg = { seed: s.seed, datetime: s.dt, nethackrc: s.rc };
        if (typeof built === 'string') {
            seg.moves = built;
        } else {
            seg.moves = built.keys;
            if (!control && built.signals.length) seg.signals = built.signals;
        }
        return seg;
    });
    await fs.writeFile(out, JSON.stringify({ version: 5, segments: segs }));
    for (const [i, s] of segs.entries()) {
        console.log(`${String(i).padStart(2)} ${defs[i].id.padEnd(16)} keys=${s.moves.length}`
            + (s.signals ? ` signals=${s.signals.length}` : ''));
    }
    console.log(`total keys=${segs.reduce((n, s) => n + s.moves.length, 0)}`
        + ` signals=${segs.reduce((n, s) => n + (s.signals?.length || 0), 0)}`);
}

main();
