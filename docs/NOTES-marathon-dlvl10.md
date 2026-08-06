# Marathon fork — extending a live human session to Dlvl 10 (gen9996)

`sessions-extra/gen9996-marathon-dlvl10.session.json` is a **fork of an
interactive human recording**, not a synthetic key-fuzz session. It takes the
961-key live run `sessions-live/my-first-dive-2-3-4.session.json` (seed 4312,
datetime `20260805170810` — a dwarven Archeologist, rank "Digger", who starts
with a pick-axe), keeps that human prefix, and continues the *same character*
with a scripted key stream that digs to **Dlvl 10** and camps there.

| | value |
|---|---|
| seed / datetime | 4312 / 20260805170810 |
| keys (moves) | 17,828 |
| steps (screens) | 17,829 |
| PRNG calls | 54,924 |
| final state | `Dlvl:10 $:0 HP:15(15) Pw:1(1) AC:9 Xp:1/4 T:989` — alive |
| verdict | `PASS` (RNG 54924/54924, Screen 17829/17829, cursors 17829/17829) |

Regenerate with:

```sh
node tools/gen-marathon-dlvl10.mjs --out /tmp/marathon.recipe.json
node scripts/record-session.mjs /tmp/marathon.recipe.json \
     sessions-extra/gen9996-marathon-dlvl10.session.json
SESSION_REPLAY_TIMEOUT_MS=600000 node --max-old-space-size=8192 \
     frozen/ps_test_runner.mjs sessions-extra/gen9996-marathon-dlvl10.session.json
```

## The one change to the human prefix: an unreplayable frame

The untouched 961-key live session is *almost* replayable — it scores
`RNG 7722/7722` but `Screen 961/962`. The single bad frame is step 261: keys
`#help\rg` open the `?` help menu and pick **"List of game options"**, and that
screen prints the absolute path of the runtime rc file, which is the recorder
process's `mkdtemp` directory:

```
Set options as OPTIONS=<options> in
/var/folders/wr/.../T/nh-play-tDizMQ/home/.nethackrc
```

No JS port can reproduce that string; the recording embeds the *recording
machine's* temp dir. The 13 keys at offsets 254..266 (`#help\rg\r\r\r\r\r\r`)
consume **zero game turns and zero PRNG calls**, so excising them leaves the
game state bit-identical and every later key behaves the same. The trimmed
948-key prefix replays clean (`RNG 7722/7722, Screen 949/949`), and that is
`BASE_MOVES` in the generator.

**Takeaway for session authoring: never let a session touch `?` → "List of
game options".** It is the one help topic that leaks the environment.

## Gotchas discovered while scripting the continuation

These all come from this particular game's state (the human had toggled
options with `#optionsfull` mid-run) and cost several in-development deaths:

* **`altmeta` is on**, so ESC at the command prompt is a *meta prefix*:
  `ESC` `a` is `M-a` = `#adjust`, not "ESC then apply". Sending `ESC` before a
  letter silently invokes a different command. The scripted part therefore uses
  **space** as its universal separator — at the command prompt it is a harmless
  `Unknown command ' '.` (0 turns, 0 PRNG), at a `--More--` it advances, and in
  a menu it pages/dismisses.
* **`--More--` only accepts space / Enter / ESC.** Any other key is swallowed,
  which silently eats the next N keys of a macro. Every scripted primitive
  starts with 2–3 spaces for that reason.
* **`s` and `.` refuse to run when a monster is adjacent** in this build
  ("You already found a monster / Are you waiting to get hit? Use 'm' prefix").
  The rest primitive is `m.`.
* **`F`+direction digs when you wield a pick-axe and point it at rock.** An
  8-direction "fight sweep" as a self-defence macro spends ~10 turns hammering
  walls while something eats you.
* **Elbereth prompt chains differ**: on a clean square `E` `-` `<More>` text
  `\r`; over an existing engraving `E` `-` `n` `<More>` `<More>` text `\r`.
  `E-n<SP><SP>Elbereth\r` drives both.
* **Dust Elbereth rots fast** — within ~15–25 turns of resting on it, it reads
  `Elb?reth` / `[lbereth`, and a degraded engraving scares nothing.
* Digging down takes 1–3 `a` `e` `>` applications per level; an extra one leaves
  you sitting in a fresh pit on the new level (bad place to fight from).

## Route

1. **Dlvl 1** — ESC out of the perm-inventory window, wield the pick-axe,
   drop the 400-weight splint mail the human was *wielding* (clears Burdened),
   rest to 15/15.
2. **Dlvl 1 → 2** — dig down; land inside *Inniscrone's second-hand bookstore*.
   Digging a shop floor angers the shopkeeper, so walk out through the door
   (no diagonal moves through a doorway) and dig from the corridor.
3. **Dlvl 2 → 7** — alternating dig / rest. On 7 a gecko has to be killed by
   hand (`Fy`), and the hobbit + giant ant that show up later are outrun by
   digging out early.
4. **Dlvl 7 → 9** — dig; eat a food ration when Hungry.
5. **Dlvl 9** — a bugbear is waiting at the landing spot and out-damages our
   15 max HP. The starting scroll of teleportation turns out to be **blessed**
   → *controlled* teleport; jump across the level and dig down out of reach.
6. **Dlvl 10** — kill the jackal that follows down the hole, Elbereth, rest to
   15/15.
7. **Tail** — the character is an XL1 Archeologist with 15 max HP; at Dlvl 10
   essentially any wandering monster (imp, giant ant, bugbear) out-damages its
   regeneration, so the remaining ~10.9k keys are **zero-game-time** info
   commands — `:` `)` `$` `i` `[` `^X` `^O` and spaces, cycled in three
   different patterns. They advance the step/screen count and exercise the
   menu, overview, attribute and inventory rendering paths without ever giving
   a monster a turn, which makes the tail deterministic *and* survivable.
