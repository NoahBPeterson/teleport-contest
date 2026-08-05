# Play & record — `tools/play-record.mjs`

Play NetHack yourself against the patched C recorder, get a scoreable
`session.json` back, and watch the transpiled JS engine mirror your game
side-by-side while you play.

## The command

```bash
node tools/play-record.mjs 4321
```

That's it. No build, no npm install, no tmux. `4321` is the PRNG seed —
any integer. Optionally name the session:

```bash
node tools/play-record.mjs 4321 my-first-dive
```

Make the terminal window **at least 162 columns wide** and 27 rows tall to
get the side-by-side mirror (or 80×52 for a stacked one). Anything smaller
falls back to plain single-pane play, which still records perfectly — the
tool prints one line telling you which mode it chose.

## What you see

```
 C RECORDER — ground truth  seed 4321  step 8  keys 7 │ JS MIRROR — MATCH  rng 2926/2926  8 steps
 <the game, 80x24>                                    │ <the same game, as the JS port renders it>
 mirror 7 keys  1510ms   Ctrl-] finish & write JSON   out: my-first-dive.session.json
```

* **Left/top pane — the C recorder.** Ground truth. This is literally the
  frame that goes into the JSON: the tool paints it from the same
  input-boundary capture it records, not from a second rendering path.
* **Right/bottom pane — the JS mirror.** Display only. After every keystroke
  the accumulated key prefix is replayed through `js/jsmain.js runSegment`
  in a throwaway child process, and the result is diffed against what C
  produced for the same steps. The header reads `MATCH` (green) or
  `DIVERGE` (red) with the first bad PRNG index / first bad step, and any
  cells whose glyph, colour or attribute disagree are highlighted in red.
  The mirror always lags a little (`… running`, `N behind`) — that is
  normal, and it can crash or hang without touching the recording.

## Keys

| Key | What happens |
| --- | --- |
| anything | goes straight to the game, one key per input boundary |
| `Ctrl-]` | **finish now** — stop recording and write the JSON |
| `Ctrl-C` | same as `Ctrl-]` (the game never sees it) |

Dying, `#quit` and `#save` end the game normally; the JSON is written when
the recorder process exits, after the death/topten screens are captured.

## Where the JSON lands

`sessions-live/<name>.session.json`, i.e. `sessions-live/play-seed4321.session.json`
by default. Override with `--out path/to/file.session.json`. The file is a
clean **v5** session — same schema as `sessions/*.session.json`:

```json
{ "version": 5,
  "segments": [ { "seed": 4321, "datetime": "20260805143000",
                  "nethackrc": "OPTIONS=symset:DECgraphics\n",
                  "moves": "hjkl…",
                  "steps": [ { "key": null|"h", "rng": [...], "screen": "…",
                               "cursor": [cx, cy, 1],
                               "animation_frames": [ … ] } ] } ],
  "source": "c",
  "recorded_with": { "tool": "tools/play-record.mjs", "mode": "interactive" } }
```

## How to score it

```bash
node frozen/ps_test_runner.mjs sessions-live/play-seed4321.session.json
#   PASS: play-seed4321.session.json (RNG 2926/2926, Screen 24/24)
#   1/1 passing
```

Or the whole directory at once: `node frozen/ps_test_runner.mjs sessions-live`.
The mirror's MATCH/DIVERGE indicator is a live approximation (it compares
decoded cells and PRNG entries directly); `ps_test_runner.mjs` is the
authority.

## Options

| Option | Meaning |
| --- | --- |
| `--out <file>` | session JSON destination |
| `--datetime <YYYYMMDDHHMMSS>` | pin the game clock (default: now). Moon phase, Friday-13th luck, shopkeeper greetings all key off this |
| `--options "name:Noah,role:Valkyrie,race:human,gender:female,align:neutral"` | skip chargen, start as that character |
| `--rc <file>` | use a whole `.nethackrc` instead |
| `--tz <zone>` | timezone for the C process (default `America/New_York`) |
| `--no-mirror` | plain single-pane play, no JS side |
| `--keys <string>` | non-interactive: play a fixed key string (this is the smoke-test path) |
| `--keys-file <file>` | same, from a file |
| `--keep-tmp` | keep the scratch dir (rng log, recorder stderr) for debugging |

With no `--options`/`--rc` you get `OPTIONS=symset:DECgraphics` only, so the
game asks "Who are you?" and runs full interactive character creation —
exactly like the canonical `seed0004` session.

## Why it is trustworthy

The recording core is the same machine as `scripts/record-session.mjs`
(same marker parser, same env pinning, same stale-lock cleanup, same
CR→LF convention, same key-to-step attribution by marker `SEQ`), with the
key string coming from the keyboard instead of a file. Verified:

* a 23-key recipe played through `--keys` produces a `segments` array
  **byte-identical** to `node scripts/record-session.mjs` on the same recipe;
* a live pty session typing the same keys produces a `segments` array
  byte-identical to the `--keys` run;
* both `PASS` under `frozen/ps_test_runner.mjs`.

Nothing under `js/generated/`, `frozen/` or the judge path is touched; all
new code is in `tools/` (`play-record.mjs`, `js-mirror-run.mjs`).

## Limitations

* **One segment per run.** Save/restore sessions (two segments sharing a
  save file) are not produced here; use `scripts/record-session.mjs` for
  those. A `#save` simply ends the recording.
* **7-bit keys only.** Bytes ≥ 0x80 are dropped: `moves` is replayed
  byte-per-char, and a non-ASCII byte would be re-encoded as two UTF-8
  bytes on replay and desync the trace. Arrow keys arrive as three bytes
  (`ESC [ A`) and are recorded as three keys — use `hjkl`.
* **`Ctrl-C` and `Ctrl-]` never reach the game.** Use `#quit` to quit
  in-game.
* **Avoid `O` then `?`** (options help). It prints `$HOME/.nethackrc`, and
  the C recorder's `$HOME` here is a scratch dir while the JS harness pins
  the recorder's original `$HOME` — the two disagree on that one screen by
  construction, so the mirror will show a spurious DIVERGE and the session
  will not be scoreable at that step.
* **The mirror is O(n²)-ish.** Each refresh re-runs the whole key prefix
  (~2–3 ms/move plus ~1 s of Node startup), so at 300+ keys it lags several
  seconds behind. It never blocks play; it just falls further behind.
  `js/boot/harness.mjs` consumes a whole move string per run by design, and
  its semantics were deliberately left alone.
* **The DIVERGE rendering path is exercised by code, not by a test** — the
  fork currently matches C on everything reachable here, so no fixture
  produces a divergence to snapshot.
