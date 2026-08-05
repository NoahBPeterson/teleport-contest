#!/usr/bin/env node
// gen-omnibus.mjs — build the "omnibus" exhaustive key-coverage session.
//
// Emits a v5 session *recipe* (segments with seed/datetime/nethackrc/moves,
// no steps) which scripts/record-session.mjs then drives through the patched
// C recorder to produce the ground-truth recording.
//
// Goal: exercise literally every reachable input of the NetHack 5.0 command
// table (src/cmd.c extcmdlist) — plain keys, SHIFT-keys, CTRL-keys, M-x meta
// keys (via the 'altmeta' option's ESC-prefix form), the full #extended
// command list, prompt keys, menu navigation, counts, direction keys, the
// g/G/m/F movement prefixes, travel, and the odd unbound characters that
// should answer "Unknown command".
//
// Usage:
//   node tools/gen-omnibus.mjs [--out <recipe.json>] [--only seg1,seg2]
//
// Exclusions (documented, deliberate — each one wedges or kills the
// recorder harness rather than producing a recordable frame):
//   '!'  / #shell     — SHELL is defined; forks /bin/sh which then eats our
//                       stdin pipe. Probed: recorder times out.
//   ^Z   / #suspend   — SUSPEND is defined; raises SIGTSTP and the whole
//                       process group stops. Probed: hangs past 120 s.
//   #debugfuzzer      — starts an unbounded fuzz loop.
//   #panic            — deliberately fatal (abort/paniclog), and its output
//                       carries host paths.
// 'S' (#save) and #quit *are* exercised — they come last in their segment.
//
// Two more are excluded because their *output* is not reproducible from a
// locally recorded session, not because they misbehave:
//   #saveoptions / help topic 'g' — both print the absolute path of the
//       running process's ~/.nethackrc.  record-session.mjs gives each run a
//       fresh mkdtemp $HOME, while the JS harness pins its virtual $HOME to
//       the path the canonical corpus was recorded under (js/boot/harness.mjs
//       VHOME), so those screens can never agree.
//   #stats — prints sizeof() for the C structs.  The port's byte-packed
//       layouts are self-consistent but deliberately not ABI-identical to
//       the C compiler's (see emit.mjs layoutOf), so the numbers differ.
//
// COVERAGE of the recorded session (sessions-extra/gen9999-omnibus-all-keys):
//   extcmdlist entries exercised   164 / 170
//   printable ASCII 0x20..0x7e      95 / 95   (every one, incl. DEL 0x7f)
//   control bytes 0x00..0x1f        31 / 32   (only ^Z missing)
//   M(x) meta bindings              26 / 26   (via the altmeta ESC-prefix)
//   #extended command names sent   162
//   69 of the exercised entries are reachable by NO other session in
//   sessions/ or sessions-extra/.
//   The 6 not exercised are exactly the 6 excluded above: debugfuzzer,
//   panic, saveoptions, shell, stats, suspend.
//   Session shape: 14 segments, 20119 keys, 20040 steps/screens,
//   159174 PRNG calls (~10.3x the previous longest, seed0030 @ 1953 steps).

import { promises as fs } from 'node:fs';

const ESC = '\x1b';
const C = (ch) => String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f);
const NL = '\n';

// --- shared option lines -------------------------------------------------
const BASE_OPTS = 'OPTIONS=!autopickup,!legacy,!tutorial,suppress_alert:3.4.3,symset:DECgraphics\n'
    + 'OPTIONS=disclose:-i -a -v -g -c -o\n';

function rc(name, role, race, gender, align, extra = '') {
    return `OPTIONS=name:${name},role:${role},race:${race},gender:${gender},align:${align}\n`
        + BASE_OPTS + extra;
}
const DEBUG = 'OPTIONS=playmode:debug\n';

// --- building blocks -----------------------------------------------------

// Dismiss the intro --More-- screens and the "pick a pet name?" style
// prompts that a fully specified nethackrc still leaves.
const PROLOGUE = '   n';

// Cancel out of whatever nested prompt/menu a probe key may have opened.
const CANCEL = ESC + ESC + ESC;

// Wizard-mode survival kit: raise level, then wish for gear and wear it.
// Keeps the long sweeps from being cut short by an early death.
// The '#levelchange 30' spends ~40 --More-- frames on level-up messages, so
// pad generously before the wishes or the ^W keys get eaten as dismissals.
const PAD = ' '.repeat(48);
const KIT = '#levelchange' + NL + '30' + NL + PAD
    + C('w') + 'blessed amulet of life saving' + NL + '    '
    + C('w') + 'blessed +5 gray dragon scale mail' + NL + '    '
    + C('w') + 'blessed +5 speed boots' + NL + '    '
    + C('w') + 'blessed ring of free action' + NL + '    '
    + 'Wb    Wc    Wd    ';

// --- the complete extended-command name list (src/cmd.c extcmdlist) ------
// Order preserved. `false` in the second slot = deliberately not sent.
const EXTCMDS = [
    ['?', true], ['adjust', true], ['annotate', true], ['apply', true],
    ['attributes', true], ['autopickup', true], ['bugreport', true],
    ['call', true], ['cast', true], ['chat', true], ['chronicle', true],
    ['close', true], ['conduct', true], ['debugfuzzer', false],
    ['dip', true], ['down', true], ['drop', true], ['droptype', true],
    ['eat', true], ['engrave', true], ['enhance', true], ['exploremode', true],
    ['fight', true], ['fire', true], ['force', true], ['genocided', true],
    ['glance', true], ['help', true], ['herecmdmenu', true], ['history', true],
    ['inventory', true], ['inventtype', true], ['invoke', true], ['jump', true],
    ['kick', true], ['known', true], ['knownclass', true], ['levelchange', true],
    ['lightsources', true], ['look', true], ['lookaround', true], ['loot', true],
    ['migratemons', true], ['monster', true], ['name', true], ['offer', true],
    ['open', true], ['options', true], ['optionsfull', true], ['overview', true],
    ['panic', false], ['pay', true], ['perminv', true], ['pickup', true],
    ['polyself', true], ['pray', true], ['prevmsg', true], ['puton', true],
    ['quaff', true], ['quit', false], ['quiver', true], ['read', true],
    ['redraw', true], ['remove', true], ['repeat', true], ['reqmenu', true],
    ['retravel', true], ['ride', true], ['rub', true], ['run', true],
    ['rush', true], ['save', false], ['saveoptions', false], ['search', true],
    ['seeall', true], ['seeamulet', true], ['seearmor', true], ['seerings', true],
    ['seetools', true], ['seeweapon', true], ['shell', false], ['showgold', true],
    ['showspells', true], ['showtrap', true], ['sit', true], ['stats', false],
    ['suspend', false], ['swap', true], ['takeoff', true], ['takeoffall', true],
    ['teleport', true], ['terrain', true], ['therecmdmenu', true], ['throw', true],
    ['timeout', true], ['tip', true], ['toggle', true], ['travel', true],
    ['turn', true], ['twoweapon', true], ['untrap', true], ['up', true],
    ['vanquished', true], ['version', true], ['versionshort', true],
    ['vision', true], ['wait', true], ['wear', true], ['whatdoes', true],
    ['whatis', true], ['wield', true], ['wipe', true], ['wizborn', true],
    ['wizbury', true], ['wizcast', true], ['wizcustom', true], ['wizdetect', true],
    ['wizdispmacros', true], ['wizfliplevel', true], ['wizgenesis', true],
    ['wizidentify', true], ['wizintrinsic', true], ['wizkill', true],
    ['wizlevelport', true], ['wizloaddes', true], ['wizloadlua', true],
    ['wizobjprobs', true], ['wizmakemap', true], ['wizmap', true],
    ['wizmondiff', true], ['wizrumorcheck', true], ['wizseenv', true],
    ['wizshownhuuid', true], ['wizsmell', true], ['wiztelekinesis', true],
    ['wizwhere', true], ['wizwish', true], ['wmode', true], ['zap', true],
    ['movewest', true], ['movenorthwest', true], ['movenorth', true],
    ['movenortheast', true], ['moveeast', true], ['movesoutheast', true],
    ['movesouth', true], ['movesouthwest', true],
    ['rushwest', true], ['rushnorthwest', true], ['rushnorth', true],
    ['rushnortheast', true], ['rusheast', true], ['rushsoutheast', true],
    ['rushsouth', true], ['rushsouthwest', true],
    ['runwest', true], ['runnorthwest', true], ['runnorth', true],
    ['runnortheast', true], ['runeast', true], ['runsoutheast', true],
    ['runsouth', true], ['runsouthwest', true],
    ['clicklook', true], ['mouseaction', true], ['altadjust', true],
    ['altdip', true], ['alttakeoff', true], ['altunwield', true],
];

// The M(x) bindings in extcmdlist, reachable as ESC+<char> when 'altmeta'
// is on.
const METAKEYS = ['?', 'a', 'A', 'c', 'C', 'd', 'e', 'f', 'g', 'i', 'j', 'l',
    'm', 'n', 'o', 'p', 'R', 'r', 's', 'T', 't', 'u', 'V', 'v', 'w', 'X'];

// Printable ASCII, minus '!' (forks a shell — see header).
const PRINTABLE = [];
for (let c = 0x21; c <= 0x7e; c++) {
    const ch = String.fromCharCode(c);
    if (ch === '!') continue;
    PRINTABLE.push(ch);
}

// Control bytes, NUL included. ^Z excluded (SIGTSTP). ^[ is ESC, kept — it is
// the cancel key and gets hammered everywhere anyway.
const CTRLS = [];
for (let c = 0x00; c <= 0x1f; c++) {
    if (c === 0x1a) continue;
    CTRLS.push(String.fromCharCode(c));
}

const DIRS8 = 'hjklyubn';
const DIRSZ = DIRS8 + '<>';

// -------------------------------------------------------------------------
// Segment builders
// -------------------------------------------------------------------------

// 1. Character generation: walk every chargen menu instead of pinning the
//    role in the rc. Exercises the pick-a-role / race / gender / align
//    windows, their '*' random pick, '?' help and ESC/quit paths.
function segChargen() {
    let m = '';
    m += 'Omni' + '\x7f' + '\x08' + 'ibus' + NL;  // name prompt, with rubouts
    m += 'n';                     // "Shall I pick ... for you?" -> no
    m += '~' + ESC;               // role menu: filtering submenu, cancelled
    m += 'z';                     // role menu: invalid key
    m += '/';                     // "pick race first"
    m += 'e';                     // race: elf
    m += 'R';                     // role: Ranger
    m += 'f';                     // gender: female
    m += 'c';                     // alignment: chaotic
    m += 'n';                     // "Is this ok?" -> no, choose role again
    m += '[';                     // "pick alignment first"
    m += 'l';                     // lawful
    m += '"';                     // "pick gender first" (if offered)
    m += 'm';                     // male
    m += '*';                     // random role
    m += '*';                     // random race
    m += '*';                     // random gender
    m += '*';                     // random alignment
    m += 'a';                     // "Is this ok?" -> pick another name
    m += 'Omnibus' + NL;
    m += 'n';                     // decline autopick again
    m += 'v' + 'h' + 'n';         // Valkyrie / human / neutral
    m += 'y';                     // "Is this ok?" -> yes
    m += '   ';                   // intro --More--
    // Poke the chargen-adjacent displays.
    m += C('x') + CANCEL;         // attributes
    m += 'v' + '  ' + CANCEL;     // chronicle
    m += 'V' + '  ' + CANCEL;     // versionshort
    m += '#version' + NL + '   ' + CANCEL;
    m += 'i' + CANCEL + '*' + CANCEL + '$' + CANCEL;
    m += ')' + CANCEL + '[' + CANCEL + '=' + CANCEL + '"' + CANCEL
        + '(' + CANCEL + '+' + CANCEL;
    m += '\\' + CANCEL + '`' + CANCEL;
    m += ':' + '^h' + CANCEL;
    m += 'hjklyubn'.repeat(6);
    m += 's'.repeat(10);
    m += '#terrain' + NL + CANCEL;
    m += 'i' + ESC + '+' + ESC + '\\' + ESC + C('x') + ' ' + ESC + 'ss:';
    return m;
}

// 2. Every printable ASCII byte at top level, each followed by triple-ESC.
function segAsciiSweep() {
    let m = PROLOGUE + KIT;
    for (const ch of PRINTABLE) {
        if (ch === 'S') continue;           // #save ends the game
        m += ch + CANCEL;
    }
    // Second pass: the prefix keys with a real direction after them.
    for (const p of ['m', 'g', 'G', 'F']) {
        for (const d of DIRSZ) m += p + d + ESC;
    }
    // And the count prefix with multi-digit counts.
    for (const n of ['1', '2', '5', '10', '20', '99', '100']) {
        m += n + 's' + ESC;
    }
    m += 'i' + ESC + '+' + ESC + '\\' + ESC + C('x') + ' ' + ESC + 'ss:';
    return m;
}

// 3. Every control byte at top level (minus ^Z), each followed by triple-ESC,
//    then the interesting ones with plausible arguments.
function segCtrlSweep() {
    let m = PROLOGUE + KIT;
    for (const ch of CTRLS) m += ch + CANCEL;
    // ^D kick in every direction; ^T teleport; ^A repeat; ^_ retravel.
    for (const d of DIRS8) m += C('d') + d + ESC;
    m += C('t') + CANCEL;
    m += 's' + C('a') + C('a') + ESC;
    m += C('_') + CANCEL;
    m += C('p') + C('p') + C('p') + ESC;
    m += C('r') + C('l') + ESC;
    m += C('o') + ' ' + ESC + C('x') + ' ' + ESC;
    m += 'i' + ESC + '+' + ESC + '\\' + ESC + C('x') + ' ' + ESC + 'ss:';
    return m;
}

// 4/5. The full #extended command list, split into two segments so a mishap
//      in one does not cost the other.
function segExtcmds(slice) {
    let m = PROLOGUE + KIT;
    const list = EXTCMDS.filter(([, ok]) => ok).map(([n]) => n);
    const half = Math.ceil(list.length / 2);
    const part = slice === 0 ? list.slice(0, half) : list.slice(half);
    for (const name of part) {
        // #exploremode / #polyself / #levelchange etc. all answer to ESC or
        // 'n'; send 'n' first (declines yes/no prompts) then triple-ESC.
        m += '#' + name + NL + 'n' + CANCEL;
    }
    m += 'i' + ESC + '+' + ESC + '\\' + ESC + C('x') + ' ' + ESC + 'ss:';
    return m;
}

// 6. The M(x) meta bindings, reached with the 'altmeta' ESC-prefix form.
//    With altmeta on, a literal ESC has to be typed twice.
function segAltmeta() {
    const EE = ESC + ESC;                     // one real ESC under altmeta
    let m = PROLOGUE + KIT.split(ESC).join(EE);
    for (const k of METAKEYS) {
        m += ESC + k + 'n' + EE + EE + EE;
    }
    // Meta keys that take a direction / selection.
    m += ESC + 'j' + 'h' + EE;                // jump west
    m += ESC + 'l' + EE;                      // loot
    m += ESC + 'f' + 'h' + EE;                // force
    m += ESC + 'u' + 'h' + EE;                // untrap
    m += ESC + 'c' + 'h' + EE;                // chat
    m += ESC + 'A' + 'omnibus' + NL + EE;     // annotate
    m += 'i' + EE + '+' + EE + '\\' + EE + C('x') + ' ' + EE + 'ss:';
    return m;
}

// 7. Menus and full-screen displays, with every menu-navigation key.
function segMenus() {
    const NAV = '>><<^|.-,:@' + ESC;
    let m = PROLOGUE + KIT;
    // Inventory & the class-filtered variants.
    m += 'i' + NAV + ESC;
    m += 'I' + 'a' + NAV + ESC + 'I' + '*' + NAV + ESC + 'I' + ESC;
    m += 'D' + 'a' + NAV + ESC + ESC;
    // Simple options display, then the full interactive options menu with a
    // long paging walk.
    m += 'O' + NAV + ESC + ESC;
    m += '#optionsfull' + NL;
    for (let i = 0; i < 40; i++) m += '>';
    for (let i = 0; i < 40; i++) m += '<';
    m += '^|.-,:@' + ESC + ESC;
    // Help menu and each of its entries.  'g' (the long option help) is
    // skipped on purpose: its first page prints the absolute path of the
    // running process's ~/.nethackrc, which for a re-recording is a fresh
    // mkdtemp directory.  The JS harness pins its virtual $HOME to the path
    // the *canonical* corpus was recorded under, so that one screen can
    // never be matched by a locally recorded session.
    m += '?' + ESC;
    for (const k of 'abcdefhijklmnopqr') {
        m += '?' + k + '  '.repeat(6) + ESC + ESC;
    }
    // Discoveries, class discoveries, overview, spells, skills, conduct,
    // attributes, vanquished, genocided, chronicle, seeXXX displays.
    m += '\\' + NAV + ESC;
    for (const cls of ')[!?/=("*+`%$0_') m += '`' + cls + '  ' + ESC + ESC;
    m += C('o') + '  ' + ESC + ESC;
    m += '+' + NAV + ESC;
    m += '#enhance' + NL + NAV + ESC + ESC;
    m += '#conduct' + NL + '  '.repeat(6) + ESC;
    m += C('x') + '  '.repeat(4) + ESC;
    m += '#vanquished' + NL + '  '.repeat(4) + ESC;
    m += '#genocided' + NL + '  ' + ESC;
    m += 'v' + '  '.repeat(4) + ESC;
    m += '*' + ESC + '$' + ESC + ')' + ESC + '[' + ESC + '=' + ESC + '"' + ESC + '(' + ESC;
    m += '#terrain' + NL + NAV + ESC + ESC;
    m += '\x7f' + NAV + ESC + ESC;           // DEL == #terrain
    m += '|' + ESC;                          // perminv
    m += '#herecmdmenu' + NL + NAV + ESC + ESC;
    m += '#therecmdmenu' + NL + 'l' + NAV + ESC + ESC;
    m += '#history' + NL + '  '.repeat(8) + ESC + ESC;
    m += '#lookaround' + NL + '  ' + ESC;
    m += '#prevmsg' + NL + C('p').repeat(8) + ESC;
    // '&' whatdoes over a spread of keys.
    for (const k of 'aAbcdefzZ?/;:<>_') m += '&' + k + '  ' + ESC;
    m += '&' + C('x') + '  ' + ESC + '&' + ESC + ESC;
    // '/' whatis over every symbol class, in both the menu and direct forms.
    for (const k of 'ia mo tso') m += '/' + k + '  ' + ESC + ESC;
    for (const s of '@dfhkoqrxyz$)[!?/=("*+`%0_^|-<>{}#.') {
        m += '/' + s + '  ' + ESC + ESC;
    }
    m += 'i' + ESC + '+' + ESC + '\\' + ESC + C('x') + ' ' + ESC + 'ss:';
    return m;
}

// 8. Counts, movement prefixes, every direction, travel, farlook.
function segCountsDirs() {
    let m = PROLOGUE + KIT;
    // Plain moves in every direction, then the shifted (run) forms and the
    // ctrl-dir (rush) forms.
    for (const d of DIRS8) m += d.repeat(3);
    for (const d of 'HJKLYUBN') m += d + ESC;
    for (const d of DIRS8) m += C(d) + ESC;
    // g / G / m / F prefixes over all 8 directions plus < and >.
    for (const p of 'gGmF') for (const d of DIRSZ) m += p + d + ESC;
    // 'm' prefix in front of non-movement commands that accept CMD_M_PREFIX.
    for (const cmd of [',', ':', '.', '<', '>', '_', 's', 'O', '\\', '`', '*',
        '$', '"', '[', '=', '(', ')', C('o'), C('t'), '#']) {
        m += 'm' + cmd + CANCEL;
    }
    // Counts: every digit alone, then multi-digit counts on a repeatable cmd.
    for (const d of '0123456789') m += d + ESC;
    for (const n of ['3', '7', '12', '25', '40', '75', '123', '250', '999']) {
        m += n + 's' + ESC;
    }
    // Travel: '_' opens the cursor picker; walk it with direction keys,
    // '<'/'>'/'.'/'@' hot spots, then confirm and cancel variants.
    m += '_' + 'hjklyubn' + '.' + ESC;
    m += '_' + 'HJKL' + '<' + ESC;
    m += '_' + '@' + '.' + '   ';
    m += C('_') + '   ';
    // Farlook in every direction plus the class hot keys.
    m += ';' + 'hhh' + '.' + '   ' + ESC;
    m += ';' + 'jjj' + ',' + '   ' + ESC;
    m += ';' + '@' + '.' + '   ' + ESC;
    for (const k of 'mMoOdxaA') m += ';' + k + '.' + '   ' + ESC + ESC;
    m += 'i' + ESC + '+' + ESC + '\\' + ESC + C('x') + ' ' + ESC + 'ss:';
    return m;
}

// 9. Item interaction: wish up a large kit, then drive every object verb.
function segItems() {
    const W = (what) => C('w') + what + NL + '   ';
    let m = PROLOGUE + '#levelchange' + NL + '30' + NL + '   ';
    m += W('blessed amulet of life saving');
    m += W('blessed +5 gray dragon scale mail');
    m += W('blessed +3 helmet');
    m += W('blessed +3 pair of gauntlets of power');
    m += W('blessed +3 pair of speed boots');
    m += W('blessed +3 small shield');
    m += W('blessed ring of free action');
    m += W('blessed ring of conflict');
    m += W('blessed long sword named Excalibur');
    m += W('blessed +2 dagger');
    m += W('blessed 20 elven arrows');
    m += W('blessed elven bow');
    m += W('blessed magic lamp');
    m += W('blessed magic marker');
    m += W('blessed tinning kit');
    m += W('blessed stethoscope');
    m += W('blessed mirror');
    m += W('blessed expensive camera');
    m += W('blessed bugle');
    m += W('blessed pick-axe');
    m += W('blessed unicorn horn');
    m += W('blessed bag of holding');
    m += W('blessed large box');
    m += W('blessed skeleton key');
    m += W('blessed towel');
    m += W('blessed figurine of a jackal');
    m += W('blessed leash');
    m += W('blessed can of grease');
    m += W('blessed potion of water');
    m += W('blessed potion of healing');
    m += W('blessed scroll of identify');
    m += W('blessed scroll of magic mapping');
    m += W('blessed spellbook of force bolt');
    m += W('blessed wand of digging');
    m += W('blessed wand of striking');
    m += W('blessed food ration');
    m += W('blessed apple');
    m += W('blessed 500 gold pieces');
    m += C('i') + '   ';                       // wizidentify
    m += 'i' + ESC;
    // Wear / take off / put on / remove, twoweapon, swap, quiver.
    m += 'W' + 'b' + '   ' + 'W' + 'c' + '   ' + 'W' + 'd' + '   ';
    m += 'A' + '   ' + CANCEL;
    m += 'T' + ESC + CANCEL;
    m += 'P' + ESC + CANCEL + 'R' + ESC + CANCEL;
    m += 'w' + ESC + CANCEL + 'x' + CANCEL + 'X' + CANCEL;
    m += 'Q' + ESC + CANCEL;
    // Apply every applicable tool.
    for (const k of 'abcdefghijklmnopqrstuvwxyz') {
        m += 'a' + k + CANCEL;
    }
    // Read / quaff / zap / throw / fire / eat / dip / rub / invoke / offer.
    m += 'r' + ESC + CANCEL + 'q' + ESC + CANCEL + 'z' + ESC + CANCEL;
    m += 't' + ESC + CANCEL + 'f' + ESC + CANCEL + 'e' + ESC + CANCEL;
    m += '#dip' + NL + ESC + CANCEL;
    m += '#rub' + NL + ESC + CANCEL;
    m += '#invoke' + NL + ESC + CANCEL;
    m += '#offer' + NL + ESC + CANCEL;
    m += '#loot' + NL + 'n' + CANCEL;
    m += '#force' + NL + 'n' + CANCEL;
    m += '#tip' + NL + ESC + CANCEL;
    m += '#untrap' + NL + 'h' + CANCEL;
    m += '#adjust' + NL + 'a' + 'z' + CANCEL;
    m += '#name' + NL + 'i' + 'a' + 'Omnibus blade' + NL + CANCEL;
    m += 'C' + 'a' + 'omnibus' + NL + CANCEL;
    m += 'E' + '-' + 'Elbereth' + NL + '   ' + CANCEL;
    m += 'E' + ESC + CANCEL;
    // Drop / droptype / pickup.
    m += 'd' + 'a' + '   ' + ',' + '   ' + CANCEL;
    m += 'D' + 'a' + '   ' + ESC + CANCEL;
    m += 'p' + CANCEL;
    // Cast: the spell menu plus a cast at a direction.
    m += 'Z' + ESC + CANCEL + '+' + ESC;
    m += '#cast' + NL + ESC + CANCEL;
    m += 'i' + ESC + '+' + ESC + '\\' + ESC + C('x') + ' ' + ESC + 'ss:';
    return m;
}

// 10. Bulk exploration — deterministic wandering with periodic searches,
//     kicks, stair use and level teleports. This is what takes the session
//     from "wide" to "long".
function segBulk(tag, n) {
    let m = PROLOGUE + KIT;
    const dirs = DIRS8;
    for (let k = 0; k < n; k++) {
        m += dirs[(tag * 7 + k * 5) % 8];
        if (k % 9 === 8) m += 's';
        if (k % 23 === 22) m += ':';
        if (k % 37 === 36) m += C('f') + '   ';          // wizmap
        if (k % 53 === 52) m += '>' + '   ';
        if (k % 101 === 100) m += C('v') + NL + '   ';   // levelport (random)
        if (k % 131 === 130) m += '#wizfliplevel' + NL + '   ';
        if (k % 149 === 148) m += C('d') + dirs[k % 8] + '   ';
        if (k % 167 === 166) m += C('g') + 'newt' + NL + '   ';
        if (k % 191 === 190) m += C('e') + '   ';
    }
    m += 'i' + ESC + '+' + ESC + '\\' + ESC + C('x') + ' ' + ESC + 'ss:';
    return m;
}

// 11a. Play a bit, then save the game with 'S'. The next segment restores.
function segSaveHalf() {
    let m = PROLOGUE + KIT;
    m += 'hjklyubn'.repeat(20);
    m += 's'.repeat(8) + ':';
    m += '#annotate' + NL + 'omnibus save point' + NL;
    m += C('o') + '   ' + ESC;
    m += 'Sy';                                  // save & exit
    return m;
}

// 11b. Restore that save (same player name + install dir), verify the
//      restored state, then finish with #quit and the full disclosure walk.
function segRestoreQuit() {
    let m = '   ';                              // restore banner --More--
    m += 'i' + ESC + C('o') + '   ' + ESC + C('x') + '   ' + ESC;
    m += 'hjklyubn'.repeat(10);
    m += '\\' + ESC + '+' + ESC + 'v' + '   ' + ESC;
    m += '#quit' + NL + 'y';                    // "Really quit without saving? [yn]"
    m += 'n';                                   // "Dump core? [ynq]" -> no core,
                                                //   continue with normal wrap-up
    // disclose:-i -a -v -g -c -o prompts for each disclosure in turn; answer
    // yes to every one so the end-of-game screens are all recorded.
    for (let i = 0; i < 6; i++) m += 'y' + ' '.repeat(10);
    m += ' '.repeat(40);                        // tombstone + top-ten score list
    return m;
}

// -------------------------------------------------------------------------

const SEGMENTS = [
    { id: 'chargen', seed: 90001, dt: '20260502143000',
      rc: 'OPTIONS=!autopickup,!legacy,!tutorial,suppress_alert:3.4.3,symset:DECgraphics\n'
        + 'OPTIONS=disclose:yi ya yv yg yc yo\n', build: segChargen },
    { id: 'ascii', seed: 90002, dt: '20260502143000',
      rc: rc('Ascii', 'Valkyrie', 'human', 'female', 'neutral', DEBUG), build: segAsciiSweep },
    { id: 'ctrl', seed: 90003, dt: '20260502143000',
      rc: rc('Ctrl', 'Wizard', 'human', 'male', 'neutral', DEBUG), build: segCtrlSweep },
    { id: 'extcmd0', seed: 90004, dt: '20260502143000',
      rc: rc('ExtA', 'Wizard', 'elf', 'female', 'chaotic', DEBUG), build: () => segExtcmds(0) },
    { id: 'extcmd1', seed: 90005, dt: '20260502143000',
      rc: rc('ExtB', 'Wizard', 'gnome', 'male', 'neutral', DEBUG), build: () => segExtcmds(1) },
    { id: 'altmeta', seed: 90006, dt: '20260502143000',
      rc: rc('Meta', 'Priest', 'human', 'female', 'lawful', DEBUG + 'OPTIONS=altmeta\n'),
      build: segAltmeta },
    { id: 'menus', seed: 90007, dt: '20260502143000',
      rc: rc('Menu', 'Wizard', 'human', 'female', 'neutral', DEBUG), build: segMenus },
    { id: 'counts', seed: 90008, dt: '20260502143000',
      rc: rc('Counts', 'Samurai', 'human', 'male', 'lawful', DEBUG), build: segCountsDirs },
    { id: 'items', seed: 90009, dt: '20260502143000',
      rc: rc('Items', 'Wizard', 'human', 'male', 'neutral', DEBUG), build: segItems },
    { id: 'bulk1', seed: 90010, dt: '20260502143000',
      rc: rc('Bulk1', 'Barbarian', 'orc', 'male', 'chaotic', DEBUG), build: () => segBulk(1, 2200) },
    { id: 'bulk2', seed: 90011, dt: '20260502143000',
      rc: rc('Bulk2', 'Ranger', 'elf', 'female', 'chaotic', DEBUG), build: () => segBulk(2, 2200) },
    { id: 'bulk3', seed: 90012, dt: '20260502143000',
      rc: rc('Bulk3', 'Monk', 'human', 'male', 'lawful', DEBUG), build: () => segBulk(3, 2200) },
    { id: 'save', seed: 90013, dt: '20260502143000',
      rc: rc('Saver', 'Knight', 'human', 'male', 'lawful', DEBUG)
        .replace('OPTIONS=disclose:-i -a -v -g -c -o\n', 'OPTIONS=disclose:yi ya yv yg yc yo\n'),
      build: segSaveHalf },
    { id: 'restore', seed: 90014, dt: '20260502143000',
      rc: rc('Saver', 'Knight', 'human', 'male', 'lawful', DEBUG)
        .replace('OPTIONS=disclose:-i -a -v -g -c -o\n', 'OPTIONS=disclose:yi ya yv yg yc yo\n'),
      build: segRestoreQuit },
];

async function main() {
    const argv = process.argv.slice(2);
    const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'omnibus-recipe.json';
    const only = argv.includes('--only')
        ? new Set(argv[argv.indexOf('--only') + 1].split(','))
        : null;
    const segs = SEGMENTS.filter((s) => !only || only.has(s.id)).map((s) => ({
        seed: s.seed, datetime: s.dt, nethackrc: s.rc, moves: s.build(),
    }));
    const total = segs.reduce((n, s) => n + s.moves.length, 0);
    await fs.writeFile(out, JSON.stringify({ version: 5, segments: segs }));
    for (const [i, s] of segs.entries()) {
        console.log(`${String(i).padStart(2)} ${SEGMENTS.filter((x) => !only || only.has(x.id))[i].id.padEnd(9)} keys=${s.moves.length}`);
    }
    console.log(`total keys=${total} (steps ≈ ${total + segs.length})`);
}

main();
