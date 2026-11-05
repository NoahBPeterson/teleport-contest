# sessions-extra/

Self-recorded sessions that stand in for the held-out pool. The 44 in
`sessions/` are a biased sample; the real holdout was made by the same
recorder, so recording our own with `tools/generate-sessions.mjs` (which
spawns `scripts/record-session.mjs`) is the closest proxy available. All of
it is real `nethack-c/recorder` output, so unlike `sessions-landmine/` it *is*
portable ground truth and is safe to score. The canonical regression run is

    node frozen/ps_test_runner.mjs sessions/ sessions-extra/

Two families live here. `gen9xxx-*` sweep chargen combinations, adversarial
datetimes, option torture, key omnibuses and a dlvl-10 marathon. `tz-*` pin
**calendar behaviour across the DST boundary**, and are described below.

## The `tz-*` family

These exist because `sessions/` happens to contain no datetime where the
recorder's timezone is observable — and, as it turned out, neither did the
`gen9100-dt*` probes already in this directory. The public corpus' winter datetimes are all
at 09:00–12:00 local, where the one-hour EST correction changes nothing on
screen; every datetime that would have exposed it (midnight, 06:00, 22:00) is
in EDT. So the port carried a fixed −04:00 `localtime()` for months at 44/44.

`gen9100-dt*` is the sharper lesson. Those six are genuine C recordings at
exactly the adversarial datetimes you would pick — `19700101000000`,
`20260213090000` (a Friday the 13th), `20380119031407` — and they scored 25/25
*both before and after* the fix. Their keyplan is 147 movement and search
keys: it never opens `^X`, never dies, never reaches a prompt that prints a
moon phase, a Friday-the-13th warning, a tombstone or a top-ten table. Right
datetimes, wrong keyplan. The `tz-*` sessions reuse seed0016's healer keyplan
(and seed0030's for the tombstones) precisely because those *do* land on
date-sensitive screens.

Upstream `docs/recording-environment.md` states the recorder ran with
`TZ=America/New_York`. `getnow()` returns a wall clock pinned by the session's
`datetime` field, but `getlt()` (`src/calendar.c:47`) hands that `time_t` to
`localtime()`, which applies the zone's real rules: EDT (−04:00) in summer,
EST (−05:00) in winter. `mktime()` is a different story — the recorder patch
seeds `tm_isdst` from the record-time clock (EDT), and tzcode's `time1()`
fallback shifts the wall clock by the offset delta, so the resulting `time_t`
*is* a constant −04:00 interpretation for every date. `js/boot/harness.mjs`
keeps that constant for `time()`/`mktime()` and uses the zone rules only for
`localtime()`.

| file | datetime | what it pins |
|------|----------|--------------|
| `tz-q01-fri13-est-midnight.session.json` | `20260213000000` | EST rolls Fri 13 00:00 back to Thu 12 23:00 — `friday_13th()` flips |
| `tz-q03-dst-fallback-ambig.session.json` | `20261101010000` | the hour that occurs twice on fall-back day (`mktime` disambiguation) |
| `tz-q04-dst-springfwd-gap.session.json` | `20260308023000` | the hour that does not exist on spring-forward day |
| `tz-q05-est-night-lo.session.json` | `20260220060000` | `night()` is `hour < 6`; EST turns 06 into 05 |
| `tz-q06-edt-night-lo.session.json` | `20260620060000` | same hour in EDT — the control that must *not* shift |
| `tz-q07-est-night-hi.session.json` | `20260220220000` | `night()` is `hour > 21`; EST turns 22 into 21 |
| `tz-q10-yearstart-est.session.json` | `20260101000000` | rolls back into the previous year — `tm_yday`, so `phase_of_the_moon()` |
| `tz-q13-epoch.session.json` | `19700101000000` | `time_t` 14400; EST puts it in 1969, `tm_yday` 364 vs 0 |
| `tz-s1-tomb-yearroll.session.json` | `20260101003000` | the RIP tombstone prints `getyear()`; EST rolls it back to **2025** |
| `tz-s2-tomb-fri13.session.json` | `20261113000000` | three deaths, growing top-ten list, and `friday_13th()` luck — pre-fix this lost 21665 of 28161 RNG calls |
| `tz-r4-shop-xmas-0030.session.json` | `20261225003000` | date rollback carried through a shop session |
| `tz-r5-fri13-est.session.json` | `20261113000000` | `friday_13th()` feeds luck, so this one diverges in **RNG**, not just screens |

Against the fixed −04:00 `localtime()` these scored 3/12. With the zone-aware
one they score 12/12. Two of them diverge in **RNG**, not just screens, because
`friday_13th()` feeds luck: `tz-r5` missed 30 calls, `tz-s2` missed 21665.

Note that every death in `sessions/` except `seed0030-ten-diverse-deaths` is in
wizard mode, which skips scoring entirely ("Since you were in wizard mode, the
score list will not be checked"). `tz-s1`/`tz-s2` are cut from `seed0030` for
that reason — they are the only way to reach a tombstone or a top-ten table.

    bash frozen/score.sh sessions-extra

## The `fz*-wizfuzz-*` family

24 monkey-test sessions from `tools/fuzz/gen-fuzz.py` (seeds 7000-7025, two
dropped - see below), recorded 2026-11-02 after the held-out pool grew from 44
to 56. Wizard mode, 400 random actions each: wishes, `^G` monsters,
`#polyself`, traps from wishes, Elbereth, horns, digging, riding, kicking,
looting. Each action ends with space+ESC so no prompt wedges the run.

`fz7000` caught a crash that zeroed whole sessions: dying to a monster while
helpless (`done_in_by()`, `end.c:310`, `sscanf("%u:%c")`) made the harness
`%c` conversion index into a boxed `char` local and throw.

fz7006 and fz7015 were dropped. They were recorded after DST ended, so the
recorder's `mktime()` used -05:00 (see `docs/NOTES-recording-environment.md`),
and their 00:00 datetimes make that visible. Both pass with the port's
offset at -05:00, so they are recording artifacts, not port bugs. The
generator now keeps datetimes at 07:00-20:00 for that reason. Record
serially: debug mode forces the name `wizard`, so parallel recordings collide
on lock files.

### `fz7332-playfuzz-priest` and the 208-session batch

A second batch (`gen-fuzz.py ... 104 7100 500 wiz` and `... 104 7300 500
play`, recorded serially 2026-11-02) went 202/208. `fz7332` (normal play)
generated a melting ice room (themerms.lua "Ice room", 25% branch), and the
port printed "Attempted to start duplicate melt_ice_away timer, aborted." at
level creation: `cptr.eq()` treated any two integer-valued `anything`
pointers (`long_to_any()`) as equal, so start_timer()'s duplicate scan
rejected every ice square after the first. The extra --More-- shifted every
later key (RNG 3511/23473). It is kept here as the regression.

The other five failures (fz7129, fz7175, fz7199, fz7310, fz7323) all pass
with the port's offset at -05:00: daytime datetimes, but recorded in EST, so
the timestamp-derived shopkeeper names differ. Recording artifacts, not kept.
The remaining 197 passed and are not committed (281 MB); regenerate with the
commands above if needed.

### `fz7536-deepfuzz-tourist` — blank end-of-game screens across segments

From a 104-session batch (`gen-fuzz.py ... 52 7500 700 deep` and
`... 52 7600 1500 play`, recorded with the patch-010 clock pin). 39 of the 52
three-segment save/restore sessions failed with RNG 100% but thousands of
screens off. When a game ends (death, then the disclosure prompts) the
terminal clears and the recorder stores that step's screen as "". The scorer
keeps a C screen only `if (step.screen)`, but took every JS screen, and ours
serialized as 23 newlines, so every screen of the following segment was
compared one step late. js/jsmain.js now drops blank screens (and their
cursors) the same way. fz7536 went 463/1772 -> 1772/1772; the batch 65/104 ->
104/104. Use `tools/segdiff.mjs` to see mismatches past segment 0.

## The `sc-*` family — scripted themed sessions

35 hand-scripted sessions, written 2026-11-02 by four agents each driving a
private copy of the recorder install, in the style of the public sessions:

- `sc-shops-*` (9): Tourist surcharge, using/eating/burning unpaid items,
  credit, buy-back, angry shopkeepers and appeasement, door/wall damage and
  repair, robbing by teleport and the Keystone Kops across save/restore,
  murdering the shopkeeper, a normal-mode shop visit.
- `sc-speclev-*` (10): Sokoban (pushes, squeezes, luck penalty, save/restore),
  the Oracle, Minetown temple donations and the watch, the castle drawbridge
  and passtune, the Mines, the Elemental Planes and Astral, Medusa,
  the Rogue level and Big Room.
- `sc-quest-*` (8): prayer timeouts and troubles, sacrifice, altar conversion,
  gifts and crowning, #turn, Knight caitiff, quest leaders and expulsion.
- `sc-deaths-*` (8, normal mode): tombstones, a four-game top-ten, disclosure
  option forms, save/restore with lamps/pits/partly eaten food, bones loaded
  by a later character, punishment, shop debts, self-genocide.

All 35 pass. They were recorded with the patch-010 clock pin
(`mktime_utc_offset_sec: -14400` in `recording_env`).

## `reg-*` — regression sessions for bugs found via richie3366's corpus

Our own recipes (not derived from the third-party recipes, which stay
local), each verified to PASS on the fixed port and FAIL on af73003:

- `reg-panic-portal-to-nowhere`: wish for a magic portal (a portal "to
  nowhere": trap->dst unset), step off it, wait; the pet steps on it and C
  panics ("Oops..."). The port used to throw on abort() and score 0.
- `reg-dense-screen-juiblex`: `^F` over Juiblex's swamp in DECgraphics +
  colour, 14 screens over the old 6144-byte capture buffer. The port used
  to throw "strlen runaway" and score 0. Recorded with the enlarged buffer.

The two transpiler bugs (boolean `return` in int functions; goto-spliced
`break` inside loops) are guarded at the emitter level by
`node tools/c2js/test-control.mjs` (fixture `tools/c2js/fixtures/control_gate.c`),
which fails on the old emitter with exactly the in-game symptoms.

## The `cov-*` family — coverage-targeted sessions

27 sessions written 2026-11-03 to exercise C functions that no recording had
ever executed. Targets came from a coverage-instrumented recorder run over
every corpus we have (public + sessions-extra + fuzz + scripted + richie3366's
recipes), and each session was checked with that recorder to confirm it
reaches its targets. All 27 matched the port on the first try, so this family
found no port bugs; it is here to keep those paths verified.

- `cov-items-*` (11): figurine coming alive, royal jelly on eggs,
  Schroedinger's box, eating rings and amulets as a xorn, `#tip`, gems to
  unicorns, the `A` take-off menu, the Bell of Opening on locked boxes,
  dipping worn items into polymorph, stoning cured by a lizard plus coin
  flipping, and a bag of holding inside a bag of holding.
- `cov-dungeon-*` (9): throne effects, falling onto a sink when levitation
  ends, the vault guard collecting gold, the full invocation ritual, buying
  a container with unpaid contents and the `Ix`/`Iu` bills, a partly eaten
  stack splitting the bill, a monster curing sliming on a fire trap, a
  monster eating a lizard while being stoned, and untrapping a land mine,
  a trapped chest and a pit.
- `cov-ui-*` (7): status highlight and condition menus, a config full of
  `hilite_status`/`cond_`/`BIND`/menu-key options, `#optionsfull` with the
  combination and partial menu styles, traditional menu style with class
  prompts, `#herecmdmenu`, a bag of holding exploding, and wizard commands
  tried in normal mode.

Line coverage of NetHack's `src/` by the committed corpus went from 57.8%
to 60.4% (76.4% counting richie3366's recipes). A 28th session that ran
`#saveoptions` is not included: its prompt shows the recorder's `$HOME`, which
is a random temp directory locally (see issue #16), so it can never match.

## The `cov2-*` family — agent-recorded coverage sessions

226 sessions from two rounds of agents, each given a part of the source with low
coverage and told to reach it by playing: `cov2-g*` and `cov2-h*` are the rounds and
groups, and the rest of the name is the agent's own. They cover shops, vaults, every
trap type, polymorphed combat, artifacts, deaths and the end of the game.

Every one was recorded from the C build, and matches on `tools/segdiff.mjs` and
`frozen/ps_test_runner.mjs`. No port bug turned up from these.
