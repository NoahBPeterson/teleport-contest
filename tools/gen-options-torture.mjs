#!/usr/bin/env node
// gen-options-torture.mjs — build the "options torture" session recipe.
//
// One game, one segment, fresh seed 6666.  Everything the options system
// can be driven to do from inside a running game is driven here:
//
//   1. the 'O' (#options / doset_simple) menu — its '?' show/hide-help
//      toggle, every paging key, and MENU_SEARCH;
//   2. the 'mO' (#optionsfull / doset) menu — EVERY modifiable boolean
//      toggled in one PICK_ANY pass (82 of them), then a subset toggled
//      back;
//   3. every settable compound option — the getlin ones (boulder, fruit,
//      glyph, packorder, scores, ...) and the handler ones (autounlock,
//      disclose, menustyle, number_pad, pickup_types, runmode, symset,
//      whatis_coord, ...);
//   4. the list-valued "Other settings" handlers, add *and* remove:
//      message types (incl. a deliberately invalid POSIX regex, which
//      lands in the regcomp/regerror error path), autopickup exceptions
//      and menu colors, plus autocompletions, status condition fields,
//      status highlight rules and key bindings;
//   5. the menu-wide selection keys inside 'mO' — select/unselect/invert
//      page and all, shift left/right — each cancelled with ESC so the
//      menu machinery is exercised without applying anything;
//   6. ~110 keys of ordinary play afterwards, so the changed options are
//      visible on real gameplay screens (default symset instead of
//      DECgraphics, 3-line status with time/exp/hitpointbar, autopickup
//      with exceptions, partial menustyle, msgtype-suppressed messages,
//      walk runmode), then #quit with full disclosure.
//
// Deliberately NOT exercised (both print the running process's real
// $HOME, which a re-recording can never match — see js/boot/harness.mjs
// VHOME and the same note in tools/gen-omnibus.mjs):
//   * '?' inside the 'mO' menu (view help for options menu → OPTMENUHELP)
//   * #saveoptions
//
// Usage:
//   node tools/gen-options-torture.mjs [--out recipe.json]
//
// The emitted file is a v5 recipe (segments with seed/datetime/
// nethackrc/moves, no steps); scripts/record-session.mjs turns it into
// the ground-truth recording.  A sibling <out>.expect.json carries
// "at step N the screen must contain T" checkpoints used by
// tools/check-options-torture.mjs while iterating on the recipe — every
// menu page, letter and prompt below was read off a recording, and the
// checkpoints are what keeps the key stream in step with the menus.
//
// COVERAGE of sessions-extra/gen9998-options-torture:
//   selectable entries in the 'mO' menu   123 / 123
//     booleans toggled                     82  (every modifiable one; 13
//                                               of them toggled back after)
//     compound options set                 34
//     "Other settings" handlers driven      7
//   Session shape: 1 segment, seed 6666, 1107 keys / 1108 steps,
//   3348 PRNG calls.  Keys 1..981 are the options work, 982..1091 are
//   ordinary play under the changed options, 1092..1107 are #quit and the
//   end-of-game disclosure.
//
// One entry is opened but deliberately not completed: "bind keys".
// handler_change_bind() (nethack-c/recorder/src/cmd.c, near the
// "Key binding failed?!" pline) builds its command string in an
// *uninitialised* `char cmdstr[BUFSZ]` and only Strcat()s onto it, so
// whether the bind succeeds depends on leftover C stack bytes.  No port
// can reproduce that, so the recipe walks both of its sub-menus and backs
// out without picking a command.

import { promises as fs } from 'node:fs';

const ESC = '\x1b';
const NL = '\n';
const C = (ch) => String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f);

// ---------------------------------------------------------------------------
// move-string builder with step checkpoints
// ---------------------------------------------------------------------------

let m = '';
const checks = [];

/** append keys */
const K = (s) => { m += s; };
/** assert: after all keys so far, the rendered screen contains `text` */
const EXPECT = (text) => { if (text) checks.push({ step: m.length, text }); };
/** append keys, then assert on the resulting screen */
const KE = (s, text) => { K(s); EXPECT(text); };

// Open the full options menu (doset) at page 1.  'm' is CMD_M_PREFIX.
const OPEN = 'mO';
/** open doset and page to 1-based page `p` */
const page = (p) => OPEN + '>'.repeat(p - 1);

// ---------------------------------------------------------------------------
// 0. prologue — dismiss the intro --More-- screens
// ---------------------------------------------------------------------------
KE('   n', 'Dlvl:1');

// ---------------------------------------------------------------------------
// 1. the simple 'O' menu: help toggle, every paging key, search
// ---------------------------------------------------------------------------
KE('O', '(1 of 2)');
KE('?', 'hide help');            // descriptions on -> 5 pages
EXPECT('(1 of 5)');
KE('>', '(2 of 5)');
KE('>', '(3 of 5)');
KE('>', '(4 of 5)');
KE('>', '(5 of 5)');
KE('>', '(5 of 5)');             // clamp at last page
KE('<', '(4 of 5)');
KE('<', '(3 of 5)');
KE('^', '(1 of 5)');             // MENU_FIRST_PAGE
KE('|', '(5 of 5)');             // MENU_LAST_PAGE
KE(':', 'Search for:');          // MENU_SEARCH
// NB: in a PICK_ONE menu a search that matches exactly one entry selects
// it and returns, so search for something that matches several.
KE('pickup' + NL, '(1 of 5)');
KE('>', '(2 of 5)');
KE('<', '(1 of 5)');
KE('?', '(1 of 2)');             // descriptions off again
KE('>', '(2 of 2)');
KE('<', '(1 of 2)');
KE(ESC, 'Dlvl:1');

// ---------------------------------------------------------------------------
// 2. compound options, doset page 6 (getlin ones and handler ones)
// ---------------------------------------------------------------------------
const P6 = page(6);
const P7 = page(7);
const P8 = page(8);

// a - autounlock (PICK_ANY)
KE(P6, '(6 of 8)');
KE('a' + NL, "Select 'autounlock' actions");
KE('ukf' + NL, 'Dlvl:1');

// b - boulder (getlin)
KE(P6 + 'b' + NL, 'Set boulder to what?');
KE('0' + NL, 'Dlvl:1');

// c/d/e - crash_email / crash_name / crash_urlmax (getlin)
KE(P6 + 'c' + NL, 'Set crash_email to what?');
K('optto@example.invalid' + NL);
KE(P6 + 'd' + NL, 'Set crash_name to what?');
K('Optto Torture' + NL);
KE(P6 + 'e' + NL, 'Set crash_urlmax to what?');
K('80' + NL);

// f - disclose (PICK_ANY over 6 categories, then one PICK_ONE each)
KE(P6 + 'f' + NL, 'Change which disclosure options categories');
KE('iavgco' + NL, 'Disclosure options for');
K('b');   // inventory : always disclose
K('b');   // attributes
K('b');   // vanquished
K('b');   // genocides
K('b');   // conduct
K('b');   // overview
EXPECT('Dlvl:1');

// g - fruit (getlin)
KE(P6 + 'g' + NL, 'Set fruit to what?');
K('zucchini' + NL);

// h - glyph (getlin)
KE(P6 + 'h' + NL, 'Set glyph to what?');
K('S_stone:.' + NL);

// i - hilite_status (getlin)
KE(P6 + 'i' + NL, 'Set hilite_status to what?');
K('hitpoints/30%/yellow' + NL);

// j - menu_headings (PICK_ONE colour, then PICK_ONE attribute)
KE(P6 + 'j' + NL, 'How to highlight menu headings');
KE('b', 'a - none');
KE('b', 'Dlvl:1');

// k - menu_objsyms (PICK_ONE)
KE(P6 + 'k' + NL, 'Set object symbols in menus to what?');
KE('3', 'Dlvl:1');

// l - menuinvertmode (getlin)
KE(P6 + 'l' + NL, 'Set menuinvertmode to what?');
K('2' + NL);

// m - menustyle (PICK_ONE)
KE(P6 + 'm' + NL, 'Select menustyle');
KE('p', 'Dlvl:1');

// n - msg_window (PICK_ONE)
KE(P6 + 'n' + NL, 'Select message history display type');
KE('f', 'Dlvl:1');

// o - number_pad (PICK_ONE) — set, then put straight back to 0=off so the
//     rest of the recipe keeps vi-key semantics.
KE(P6 + 'o' + NL, 'Select number_pad mode');
KE('b', 'Dlvl:1');
KE('#optionsfull' + NL, '(1 of 8)');
KE('>'.repeat(5) + 'o' + NL, 'Select number_pad mode');
KE('a', 'Dlvl:1');

// p - packorder (getlin)
KE(P6 + 'p' + NL, 'Set packorder to what?');
K('")[%?+!=/(*`0_$' + NL);

// q - paranoid_confirmation (PICK_ANY)
KE(P6 + 'q' + NL, 'Actions requiring extra confirmation');
KE('awe' + NL, 'Dlvl:1');

// r - petattr (PICK_ONE)
KE(P6 + 'r' + NL, 'Select pet highlight attribute');
KE('b', 'Dlvl:1');

// s - pickup_burden (PICK_ONE)
KE(P6 + 's' + NL, 'Select encumbrance level');
KE('b', 'Dlvl:1');

// ---------------------------------------------------------------------------
// 3. compound options, doset page 7
// ---------------------------------------------------------------------------

// a - pickup_types (PICK_ANY over object classes)
KE(P7, '(7 of 8)');
KE('a' + NL, 'Autopickup what?');
KE('ahfji' + NL, 'Dlvl:1');

// b - pile_limit (getlin)
KE(P7 + 'b' + NL, 'Set pile_limit to what?');
K('3' + NL);

// c - roguesymset (PICK_ONE)
KE(P7 + 'c' + NL, 'Select rogue level symbol set');
KE('b', 'Dlvl:1');

// d - runmode (PICK_ONE)
KE(P7 + 'd' + NL, 'Select run/travel display mode');
KE('w', 'Dlvl:1');

// e - scores (getlin)
KE(P7 + 'e' + NL, 'Set scores to what?');
K('5 top/3 around/own' + NL);

// f - sortdiscoveries (PICK_ONE)
KE(P7 + 'f' + NL, 'Ordering of discoveries');
KE('a', 'Dlvl:1');

// g - sortloot (PICK_ONE)
KE(P7 + 'g' + NL, 'Select loot sorting type');
KE('f', 'Dlvl:1');

// h - sortvanquished (PICK_ONE)
KE(P7 + 'h' + NL, 'Sort order for vanquished');
KE('a', 'Dlvl:1');

// i - statushilites (getlin)
KE(P7 + 'i' + NL, 'Set statushilites to what?');
K('5' + NL);

// j - statuslines: deliberately deferred to the very end of the options
//     work.  A 3-line status shrinks the rows the tty menu code has to
//     work with, which re-paginates every doset() menu; doing it here
//     would invalidate every page/letter coordinate that follows.

// k - suppress_alert (getlin)
KE(P7 + 'k' + NL, 'Set suppress_alert to what?');
K('3.6.0' + NL);

// l - symset (PICK_ONE) — DECgraphics -> Default Symbols, whole map changes
KE(P7 + 'l' + NL, 'Select symbol set');
KE('a', 'Dlvl:1');

// m - versinfo (PICK_ANY; reports the new value on a --More-- line)
KE(P7 + 'm' + NL, 'Select version information flags');
KE('g' + NL, "'versinfo' changed to 3.");
KE(' ', 'Dlvl:1');

// n - whatis_coord (PICK_ONE)
KE(P7 + 'n' + NL, 'Select coordinate display');
KE('m', 'Dlvl:1');

// o - whatis_filter (PICK_ONE)
KE(P7 + 'o' + NL, 'Select location filtering');
KE('v', 'Dlvl:1');

// p - autocompletions (PICK_ANY, 8 pages)
KE(P7 + 'p' + NL, 'Which commands autocomplete?');
KE('cde', '');
KE('>', '(2 of 8)');
KE('abc', '');
KE('|', '(8 of 8)');
KE('^', '(1 of 8)');
KE(NL, 'Dlvl:1');

// ---------------------------------------------------------------------------
// 4. the list-valued "Other settings" handlers — add AND remove
// ---------------------------------------------------------------------------

// t - message types
KE(P7 + 't' + NL, 'add new message type');
KE('a', 'What new message pattern?');
KE('You feel.*' + NL, 'How to show the message');
KE('d', 'add new message type');                 // norep
KE('a' + '.*hits.*' + NL, 'How to show the message');
KE('c', 'add new message type');                 // more
KE('a' + 'You hear.*' + NL, 'How to show the message');
KE('b', 'add new message type');                 // hide
// a deliberately invalid POSIX regex — regcomp error path
KE('a' + '*bad*' + NL, 'MSGTYPE regex');
KE(' ', 'add new message type');
KE('l', 'List of message types');
KE(' ', 'add new message type');
KE('r', 'Remove which message types');
KE('a' + NL, 'add new message type');
KE('l', 'List of message types');
KE(' ', 'add new message type');
KE(ESC, 'Dlvl:1');

// q - autopickup exceptions
KE(P7 + 'q' + NL, 'add new autopickup exception');
KE('a', 'What new autopickup exception pattern?');
KE('<.*dagger.*' + NL, 'add new autopickup exception');
KE('a' + '>.*rock.*' + NL, 'add new autopickup exception');
KE('a' + '.*gold piece.*' + NL, 'add new autopickup exception');
KE('l', 'List of autopickup exceptions');
KE(' ', 'add new autopickup exception');
KE('r', 'Remove which autopickup exceptions');
KE('b' + NL, 'add new autopickup exception');
KE('l', 'List of autopickup exceptions');
KE(' ', 'add new autopickup exception');
KE(ESC, 'Dlvl:1');

// s - menu colors
KE(P7 + 's' + NL, 'add new menucolor');
KE('a', 'What new menucolor pattern?');
KE('.*cursed.*' + NL, 'Pick a color');
KE('b', 'Pick an attribute');
KE('b', 'add new menucolor');
KE('a' + '.*blessed.*' + NL, 'Pick a color');
KE('c', 'Pick an attribute');
KE('a', 'add new menucolor');
KE('l', 'List of menu colors');
KE(' ', 'add new menucolor');
KE('r', 'Remove which menu colors');
KE('a' + NL, 'add new menucolor');
KE(ESC, 'Dlvl:1');

// r - bind keys.  Both sub-menus are walked, but no command is ever
// picked: handler_change_bind() (src/cmd.c) builds its command string in
// an *uninitialised* `char cmdstr[BUFSZ]` and only Strcat()s onto it, so
// whether bind_key() succeeds or prints "Key binding failed?!" depends on
// leftover C stack bytes.  That is not reproducible by a port, so the
// recipe stops at the menus, which are.
KE(P7 + 'r' + NL, 'bind key to a command');
KE('b', 'Bind what command?');
KE('>', '(2 of 7)');
KE('|', '(7 of 7)');
KE('^', '(1 of 7)');
KE(ESC, 'bind key to a command');
KE('a', 'Bind which key?');
KE('~', "Bind '~' to what command?");
KE('>', '(2 of 7)');
KE(ESC, 'bind key to a command');
KE(ESC, 'Dlvl:1');

// u - status condition fields
KE(P7 + 'u' + NL, 'Choose status conditions to toggle');
KE('ach', '');
KE('>', '(2 of 2)');
KE('ab', '');
KE('<', '(1 of 2)');
KE(NL, 'Dlvl:1');

// page 8: a - status highlight rules
KE(P8, '(8 of 8)');
KE('a' + NL, 'Status hilites:');
KE('a', 'hitpoints');                 // "View all hilites in config format"
KE(' ', '');
KE(ESC, '');
KE(ESC, 'Dlvl:1');

// ---------------------------------------------------------------------------
// 5. menu machinery: paging + the bulk selection keys, all cancelled
// ---------------------------------------------------------------------------
KE(OPEN, '(1 of 8)');
K('>'.repeat(10));
EXPECT('(8 of 8)');
K('<'.repeat(10));
EXPECT('(1 of 8)');
KE('|', '(8 of 8)');
KE('^', '(1 of 8)');
KE(':' + 'symset' + NL, '(1 of 8)');   // PICK_ANY: search selects, no jump
KE('-', '(1 of 8)');
KE(ESC, 'Dlvl:1');

KE(OPEN + '.', '');                    // MENU_SELECT_ALL
KE('-', '');                           // MENU_UNSELECT_ALL
KE(ESC, 'Dlvl:1');
KE(OPEN + '@', '');                    // MENU_INVERT_ALL
KE('@', '');
KE(ESC, 'Dlvl:1');
KE(OPEN + ',', '');                    // MENU_SELECT_PAGE
KE('\\', '');                          // MENU_UNSELECT_PAGE
KE(ESC, 'Dlvl:1');
KE(OPEN + '~', '');                    // MENU_INVERT_PAGE
KE('~', '');
KE(ESC, 'Dlvl:1');
KE(OPEN + '{', '');                    // MENU_SHIFT_LEFT
KE('}', '');                           // MENU_SHIFT_RIGHT
KE(ESC, 'Dlvl:1');
KE(OPEN + ':' + 'wiz' + NL, '');
KE('-', '');
KE(ESC, 'Dlvl:1');

// ---------------------------------------------------------------------------
// 6. toggle EVERY modifiable boolean, in one PICK_ANY pass
// ---------------------------------------------------------------------------
const A_W = 'abcdefghijklmnopqrstuvw';
KE(OPEN, '(1 of 8)');
KE('a', '');                           // accessiblemsg (only selectable one)
KE('>', '(2 of 8)');
K(A_W);
KE('>', '(3 of 8)');
K(A_W);
KE('>', '(4 of 8)');
K(A_W);
KE('>', '(5 of 8)');
K('abcdefghijkl');
KE(NL, "'accessiblemsg' option toggled on.");
// The toggles are reported two per line behind --More-- until 'verbose'
// itself gets toggled off part way through; 19 spaces clears exactly that
// run.  Sending more would be harmless-looking but is not: 'rest_on_space'
// is on at this point, so every extra space would burn a game turn.
K(' '.repeat(19));
EXPECT('Dlvl:1');

// ---------------------------------------------------------------------------
// 7. the menu after the mass toggle looks different — 'cmdassist' is off
//    so the help block at the top of page 1 is gone, and 'menu_tab_sep'
//    is on so entries are "name<TAB>[value]".  Re-toggle the handful of
//    booleans whose new state would make the rest of the recipe (and
//    ordinary play) unrecordable, plus a few for the sake of toggling
//    them twice.  No ESC may be used until 'altmeta' is back off.
// ---------------------------------------------------------------------------
KE(OPEN, '(1 of 7)');
KE('c', 'altmeta');                    // altmeta -> off (ESC works again)
KE('>', '(2 of 7)');
K('b');                                // autopickup -> on
K('f');                                // cmdassist -> on
K('q');                                // extmenu -> off ('#quit' stays typed)
KE('>', '(3 of 7)');
K('n');                                // menu_tab_sep -> off
K('q');                                // monpolycontrol -> off
K('r');                                // montelecontrol -> off
KE('>', '(4 of 7)');
K('a');                                // query_menu -> off
K('c');                                // rest_on_space -> off
K('f');                                // sanity_check -> off
K('v');                                // travel -> on
K('w');                                // travel_debug -> off
// 'verbose' is off now, so this batch reports nothing at all.
KE(NL, 'Dlvl:1');

// finally: 3-line status.  This re-paginates every doset() menu, so it is
// the last thing the options phase does.
// The 'spot_monsters' + 'whatis_coord:map' pair queued a message when the
// previous menu closed; it comes back behind a --More-- when this one does.
KE(page(7) + 'j' + NL, '--More--');
KE(' ', 'Set statuslines to what?');
KE('3' + NL, 'Dlvl:1');

// ---------------------------------------------------------------------------
// 8. ordinary play, with every one of those changes on screen: the map is
//    drawn from the default symset instead of DECgraphics, the status is
//    3 lines with a hitpointbar / Xp:1/0 / T: / weapon / armor / terrain /
//    version, autopickup is on with pickup_types + exceptions, menus use
//    menustyle:partial with red&bold headings and the two menu colors,
//    runmode:walk draws every step of a run, and the msgtypes suppress or
//    hold back the messages they match.
// ---------------------------------------------------------------------------
KE('k', 'Dlvl:1');                     // north, onto the gold
KE('k', 'Dlvl:1');
KE(',', '');                           // pick up here
KE(' ', '');
KE(ESC, 'Dlvl:1');
KE('i', '');                           // inventory (partial menustyle)
KE(ESC, 'Dlvl:1');
KE(':', '');                           // look here
K('hhhh');                             // west into the wall -> mention_walls
K('jjjj');
K('llll');
K('yubn');
KE('s'.repeat(5), 'Dlvl:1');           // search
KE('G' + 'l', '');                     // run east, runmode:walk
KE('G' + 'h', 'Dlvl:1');
KE(';' + '.', '');                     // farlook, whatis_coord:map
KE(' ', '');
KE(ESC, 'Dlvl:1');
KE('_' + '.', '');                     // travel (travel toggled back on)
K('   ');
KE(ESC, 'Dlvl:1');
KE(C('p'), '');                        // prevmsg, msg_window:full
K('  ');
KE(ESC, 'Dlvl:1');
KE('\\', '');                          // discoveries
KE(ESC, 'Dlvl:1');
KE(C('x'), '');                        // attributes
K('  ');
KE(ESC, 'Dlvl:1');
KE('#terrain' + NL, '');               // extmenu is off again, so '#' types
K('  ');
KE(ESC, '');
KE(ESC, 'Dlvl:1');
KE(C('o'), '');                        // dungeon overview
K('  ');
KE(ESC, 'Dlvl:1');
K('jjkk');
KE('s'.repeat(4), 'Dlvl:1');
K('lll');
K('hhh');
KE(':', '');                           // look here again, 3-line status
KE(',', '');                           // pick up (autopickup rules apply)
KE(ESC, 'Dlvl:1');
KE('i', '');
KE(ESC, 'Dlvl:1');
KE(';' + 'l' + '.', '');               // farlook east
KE(' ', '');
KE(ESC, 'Dlvl:1');
KE('G' + 'j', '');
KE('G' + 'k', 'Dlvl:1');
KE(C('p'), '');
K(' ');
KE(ESC, 'Dlvl:1');
KE('\\', '');
KE(ESC, 'Dlvl:1');
K('kkjj');
KE('s'.repeat(3), 'Dlvl:1');

// ---------------------------------------------------------------------------
// 9. #quit.  disclose is "+X" for every category, i.e. always disclose
//    without prompting, so the end-of-game screens all come out; tombstone
//    is off and toptenwin is on, both courtesy of the mass toggle.
// ---------------------------------------------------------------------------
KE('#quit' + NL, 'Really quit');
KE('y', 'Dump core?');
K('n');
// Exactly enough to walk the disclosure / overview / farewell screens;
// the process exits on the last one, so any extra key would be recorded
// as a step the game never answered.
K(' '.repeat(8));

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

const RC =
    'OPTIONS=name:Optto,role:Valkyrie,race:human,gender:female,align:neutral\n'
  + 'OPTIONS=!autopickup,!legacy,!tutorial,suppress_alert:3.4.3,symset:DECgraphics\n'
  + 'OPTIONS=disclose:-i -a -v -g -c -o\n'
  + 'OPTIONS=playmode:debug\n';

async function main() {
    const argv = process.argv.slice(2);
    const out = argv.includes('--out')
        ? argv[argv.indexOf('--out') + 1]
        : 'options-torture-recipe.json';
    const doc = {
        version: 5,
        segments: [{
            seed: 6666,
            datetime: '20260502143000',
            nethackrc: RC,
            moves: m,
        }],
    };
    await fs.writeFile(out, JSON.stringify(doc));
    await fs.writeFile(out.replace(/\.json$/, '') + '.expect.json',
                       JSON.stringify(checks, null, 1));
    console.log(`keys=${m.length} steps=${m.length + 1} checks=${checks.length}`);
}

await main();
