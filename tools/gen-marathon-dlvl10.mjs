#!/usr/bin/env node
// gen-marathon-dlvl10.mjs — build the "marathon / Dlvl 10" session recipe.
//
// This is a *fork* of one of the interactive live recordings: seed 4312,
// datetime 20260805170810, the Archeologist "Digger" who starts with a
// pick-axe (sessions-live/my-first-dive-2-3-4.session.json, 961 keys).
// The fork keeps that human-played prefix verbatim except for one excision
// (see BASE_MOVES below) and then continues the same character with a
// scripted key stream: wield the pick-axe, drop the 400-weight splint mail,
// heal, then dig straight down to Dlvl 10 and camp there.
//
// Emits a v5 session *recipe* (segment with seed/datetime/nethackrc/moves,
// no steps); scripts/record-session.mjs drives it through the patched C
// recorder to produce the ground-truth recording:
//
//   node tools/gen-marathon-dlvl10.mjs --out /tmp/marathon.recipe.json
//   node scripts/record-session.mjs /tmp/marathon.recipe.json \
//        sessions-extra/gen9996-marathon-dlvl10.session.json
//
// Result: 17,828 keys / 17,829 steps / 54,924 PRNG calls, ending alive at
// Dlvl:10 HP:15(15) T:989.
//
// ---------------------------------------------------------------------------
// The one excision from the human prefix
// ---------------------------------------------------------------------------
// The original live recording is 961 keys, and 13 of them (offsets 254..266,
// "#help\rg\r\r\r\r\r\r") open the ?-help menu and select "List of game
// options".  That screen prints the *absolute path of the runtime .nethackrc*,
// i.e. the recorder process's mkdtemp directory — so the canonical recording
// embeds "/var/folders/.../nh-play-tDizMQ/home/.nethackrc" and is by
// construction unreplayable (the JS port cannot know that string).  Verified:
// the untouched live session scores RNG 7722/7722 but Screen 961/962, the one
// mismatch being exactly that frame.
//
// Those 13 keys consume no game turns and no PRNG, so deleting them leaves the
// game state bit-identical; the trimmed 948-key prefix replays PASS
// (RNG 7722/7722, Screen 949/949).  BASE_MOVES below is that trimmed prefix.
//
// ---------------------------------------------------------------------------
// Notes on the scripted continuation (things that bite you in this build)
// ---------------------------------------------------------------------------
//   * 'altmeta' is on in this game (the human toggled options mid-run), so an
//     ESC at the command prompt is a META PREFIX: ESC+a is M-a = #adjust, not
//     ESC then apply.  Every separator in the scripted part is a SPACE, never
//     an ESC.  Space is the universally safe filler: "Unknown command ' '" at
//     the command prompt (0 turns, 0 RNG), --More-- dismissal, and menu paging.
//   * 's' (search) and '.' (wait) both refuse when a monster is adjacent
//     ("Use 'm' prefix to force..."), so the rest primitive is "m." .
//   * 'F'+direction with a pick-axe wielded DIGS when it points at rock, so a
//     blind 8-direction fight sweep burns ~10 turns hitting walls.  Don't.
//   * Engraving Elbereth: on a clean square the prompt chain is
//     E - <More> text \r ; over an existing engraving it is
//     E - n <More> <More> text \r .  "E-n<SP><SP>Elbereth\r" handles both.
//   * Dust Elbereth degrades within ~15-25 turns while you rest on it
//     ("Elb?reth", "[lbereth"), and a degraded one does not scare anything.
//
// ---------------------------------------------------------------------------
// Key-string mnemonics used in the CHUNKS table
// ---------------------------------------------------------------------------
//   <SP>=space  <CR>=\r  <ESC>=\x1b  <DEL>=\x7f  <GT>=>  <LT>=<  <^X>=ctrl-X
//
// Chunk forms: "keys"  or  [count, "keys"] meaning the keys repeated count
// times.  The whole extension is chunks.map(expand).join('').

import { promises as fs } from 'node:fs';

export function expand(s) {
    return s.replace(/<([^>]*)>/g, (m, tok) => {
        if (tok === 'ESC') return '\x1b';
        if (tok === 'CR') return '\r';
        if (tok === 'DEL') return '\x7f';
        if (tok === 'SP') return ' ';
        if (tok === 'LT') return '<';
        if (tok === 'GT') return '>';
        if (/^\^.$/.test(tok)) return String.fromCharCode(tok.charCodeAt(1) & 0x1f);
        throw new Error('unknown token ' + m);
    });
}

// The human-played prefix from sessions-live/my-first-dive-2-3-4.session.json
// with the 13-key ?-help/"game options" detour at offsets 254..266 removed.
const BASE_MOVES = "sdlgsdkjglskdgjsdgkdsg\ry\r\r\rnlkkkk,\ri\u001bjlkl\rkllkklllllll;;l\r\rkllllllklk\u001bkllllkkkjjll,,\rijwjkjlll\u0004l\u0004lllkkkkklllllllkkkllll:#lolot\r#help\rb\u001b[B\u001b[A\u001b:#help\rb\r\r\r\r\r\r\r\r\r\r:h#help\rd\r\r\r\r\r\r\r\r\r\r\r\r\r\r\r\r\r\r:h#help\reT:help#he\u001b\u001b#help\ro\r#help\rn\r\r\r\r\r#help\rl\r#jhelp\rk\r#help\ri\r\r$#ibmgraphics\r\r#help\r\u001b#optionsfull ibmfgraphics\r#m 0\r#help\ri\r\r#help\ri\r\r#help\rf&\ribmgraphics\r\u001b#help\ri\r\r#help\rj\r\r\r\r\r\r\r\u001bW\u001b\u001bw\u001b\u001bW\u001b\u001b[119;6u\u001b\u001b#help\rk\r#ibmgraphics\r#invoke\r\r#IBMGraphics true\r#IBMGraphics True\r\u001b#help\rkakljkkjjl;;lkjlkjkljlj:ibm\raskl\r#help\rk\r#help\ri\r\r#help\rl<>\u001b#helopp\rk>><<>>\u001boptionsfull\u001b#optionsfull\r\u001b[B\u001b#iooptionsfull\rkljlk;kjlkj;lkjkljl?\r\r\rjkjhl\u001b[B\u001b[A\u001b\u001b#optionsfull\r>>>>.,.ab\r#optionsfull\ra\r#optionsfull\r>>><pig\r\r\r#hoptionsfull\r\u001b[46;5u\u001b#\r#optionsfull\r>swbc>euw>efhmnoprstuvw>h>begwvL>ijldeb\r\r\r\r\r\r\r\r\r\r\riavgco\rbbbbbb~\r3c\rlol\rdasdasdasd\r\rdfaaorange\rieayellow\rkcaporosa\rmcxxo\r\u001b\r\rsjkl;;jh\u001bkllllljjjjllllllkjjjjhhjj\u0004j\u0004jjjjhhhhjjh]\rhjjjhhjjjjjh\u001bjhh\u001bhhhjjjj\u001bjjjjh\u001bhh\u001bhh\u001bjh\u001bh\u0004\u001b\u001b[91;5u";

const SEED = 4312;
const DATETIME = "20260805170810";
const NETHACKRC = "OPTIONS=symset:DECgraphics\n";

// Scripted continuation, in play order.  Landmarks:
//   Dlvl 1  : ESC out of the perm-inventory window, wield pick-axe (e),
//             drop the splint mail (j) to clear Burdened, rest to 15/15.
//   Dlvl 1->2: dig down; land inside Inniscrone's bookstore -> walk OUT the
//             door before digging again (digging a shop floor angers the shk).
//   Dlvl 2->7: dig / rest cycles.  On 7 a gecko has to be killed by hand (Fy).
//   Dlvl 7->8->9: dig; on 9 a bugbear is waiting, so read the (blessed ->
//             controlled) scroll of teleportation and jump across the level,
//             then dig down out of reach.
//   Dlvl 10 : kill the jackal that follows us down, Elbereth + rest to 15/15,
//             then pad the tail with zero-game-time info commands
//             (: ) $ i [ ^X ^O and spaces) which advance the step count
//             without ever giving a monster a turn.
const CHUNKS = [
    "<ESC>",
    "<ESC>",
    "l",
    "l",
    "i",
    "<ESC>",
    "we",
    "<CR>",
    "<CR>",
    "dj",
    "<CR>",
    "dj",
    "<SP>",
    "<SP>",
    "<SP>",
    [
        4,
        "s"
    ],
    "y",
    "<SP>",
    [
        30,
        "."
    ],
    "k",
    [
        6,
        "<ESC>Fl"
    ],
    [
        40,
        "<ESC>m."
    ],
    "<SP>",
    "ae<GT>",
    [
        3,
        "<SP>ae<GT>"
    ],
    [
        6,
        "<SP>"
    ],
    "j",
    [
        3,
        "<SP>"
    ],
    "h",
    [
        3,
        "<SP>"
    ],
    "j",
    [
        3,
        "<SP>"
    ],
    "j",
    [
        3,
        "<SP>"
    ],
    [
        4,
        "<SP><SP><SP>ae<GT>"
    ],
    [
        6,
        "<SP>"
    ],
    [
        60,
        "<SP><SP>m.:)$"
    ],
    [
        2,
        "<SP><SP><SP>ae<GT>"
    ],
    [
        6,
        "<SP>"
    ],
    [
        40,
        "<SP><SP>m.:)$"
    ],
    [
        2,
        "<SP><SP><SP>ae<GT>"
    ],
    [
        6,
        "<SP>"
    ],
    [
        150,
        "<SP><SP>m.:)$"
    ],
    [
        2,
        "<SP><SP><SP>ae<GT>"
    ],
    [
        6,
        "<SP>"
    ],
    [
        150,
        "<SP><SP>m.:)$"
    ],
    [
        1,
        "<SP><SP><SP>ae<GT>"
    ],
    [
        8,
        "<SP>"
    ],
    [
        3,
        "n<SP>"
    ],
    [
        4,
        "l<SP>"
    ],
    [
        4,
        "<SP>"
    ],
    [
        4,
        "Fy<SP>"
    ],
    [
        4,
        "<SP>"
    ],
    [
        8,
        "Fy<SP>"
    ],
    [
        4,
        "<SP>"
    ],
    [
        25,
        "<SP><SP>m.:)$"
    ],
    [
        20,
        "<SP><SP>m.:)$"
    ],
    [
        3,
        "<SP><SP><SP>ae<GT>"
    ],
    [
        8,
        "<SP>"
    ],
    [
        4,
        "j<SP>"
    ],
    ",",
    [
        4,
        "<SP>"
    ],
    [
        3,
        "j<SP>"
    ],
    [
        6,
        "l<SP>"
    ],
    "ed",
    [
        8,
        "<SP>"
    ],
    [
        35,
        "<SP><SP>m.:)$"
    ],
    [
        2,
        "<SP><SP><SP>ae<GT>"
    ],
    [
        8,
        "<SP>"
    ],
    "ri",
    "<SP>",
    "LLLJ.",
    [
        8,
        "<SP>"
    ],
    [
        2,
        "<SP><SP><SP>ae<GT>"
    ],
    [
        8,
        "<SP>"
    ],
    [
        3,
        "<SP><SP>m.i<SP>[<SP>"
    ],
    [
        3,
        "<SP><SP>m.<^X><SP><SP>"
    ],
    [
        3,
        "<SP><SP>m.<^O><SP><SP>"
    ],
    [
        12,
        "<SP><SP>m.:)$"
    ],
    [
        6,
        "Fk<SP>"
    ],
    [
        24,
        "<SP><SP>m.:)$"
    ],
    "E-",
    "<SP>",
    "Elbereth<CR>",
    [
        4,
        "<SP>"
    ],
    [
        50,
        "<SP><SP>m.:)$"
    ],
    "<SP><SP><SP>E-n<SP><SP>Elbereth<CR><SP><SP>",
    [
        25,
        "<SP><SP>m.:)$"
    ],
    [
        20,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    "<SP><SP><SP>E-n<SP><SP>Elbereth<CR><SP><SP>",
    [
        25,
        "<SP><SP>m.:)$"
    ],
    [
        20,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    "<SP><SP><SP>E-n<SP><SP>Elbereth<CR><SP><SP>",
    [
        25,
        "<SP><SP>m.:)$"
    ],
    [
        20,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    [
        8,
        "<SP>:)$i<SP>[<SP><^X><SP><SP><^O><SP><SP>"
    ],
    [
        10,
        "<SP>)$<SP>:i<SP><SP>"
    ],
    [
        10,
        "<SP><^O><SP><SP>[<SP>:)"
    ],
    "<SP><SP>"
];

export function buildMoves() {
    const ext = CHUNKS.map((c) => (Array.isArray(c) ? expand(c[1]).repeat(c[0]) : expand(c))).join('');
    return BASE_MOVES + ext;
}

export function buildRecipe() {
    return {
        version: 5,
        segments: [{
            seed: SEED,
            datetime: DATETIME,
            nethackrc: NETHACKRC,
            moves: buildMoves(),
            steps: [],
        }],
        source: 'c',
        recorded_with: { tool: 'scripts/record-session.mjs', mode: 'scripted' },
    };
}

async function main() {
    const argv = process.argv.slice(2);
    let out = null;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--out') out = argv[++i];
    }
    const recipe = buildRecipe();
    const json = JSON.stringify(recipe);
    if (out) {
        await fs.writeFile(out, json);
        console.error(`[ok] wrote ${out} (${recipe.segments[0].moves.length} keys)`);
    } else {
        process.stdout.write(json);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((e) => { console.error('[fail]', e); process.exit(1); });
}
