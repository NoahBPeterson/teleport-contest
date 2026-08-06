# Notes: recording NetHack while real POSIX signals fly

**Status:** experiment complete. One recorder bug found and fixed
(`scripts/record-session.mjs`, exit-race that silently truncated recordings —
section 4). One corpus session added
(`sessions-extra/gen9997-signal-inert-laced.session.json`). Every other signal
is documented here and deliberately **not** in the corpus, because its effect
cannot be expressed in the judge's replay input.

---

## 1. What was done

`scripts/record-session.mjs` learned an optional per-segment `signals`
schedule (recipe-only; a session without one is completely unaffected):

```json
"signals": [ { "at": 30, "sig": "SIGHUP", "when": "before-key", "pause": 60 } ]
```

* `at` — input-marker sequence number. `at: 30` = "the screen for step 30 has
  been captured".
* `when` — `before-key` (default) delivers the signal while the C process is
  blocked in `read()` waiting for the next key; `after-key` delivers it right
  after the next key is written, i.e. while the process is executing a command.
* `pause` — ms to wait after `kill()` before writing the next key.

`before-key` is the only boundary the harness can attribute: the OSC-7777
marker is written from *inside* the input routine (patched `termcap.c`), so
receiving it proves the process reached the read. Everything else is a race
against the game's own execution.

Probe rig: `sigprobe.mjs` (scratch) builds a 2-segment recipe — segment 1
plays 76 keys with the signal at step 30, segment 2 starts a game under the
same character name so that its first screen says *"welcome back"* iff the
first segment left a save behind. **Every candidate was recorded twice and the
recordings byte-compared**, and against a no-signal baseline of the same
recipe.

## 2. The matrix

Recorder: patched NetHack 5.0, `playmode:debug`, headless (stdin/stdout are
pipes, no tty). Baseline: seg0 = 76 steps / 4055 PRNG calls, seg1 = fresh game
(9 steps / 2433 PRNG calls).

| signal | disposition in this build | observed recorder behaviour | seg0 steps | seg1 | 2 runs identical? | vs no-signal baseline |
|---|---|---|---|---|---|---|
| *(none)* | — | plays to the end of the key stream | 76 | fresh game | yes | *(is the baseline)* |
| `SIGHUP` | `hangup()` (`sys/unix/unixmain.c:608`, `SA_RESTART` off) | **emergency save + exit** at the marker boundary | 31 | **restores the hangup save** ("welcome back", 65 PRNG calls) | yes | differs |
| `SIGXCPU` | same handler as SIGHUP (`unixmain.c:610`) | identical to SIGHUP: emergency save + exit | 31 | restores the hangup save | yes | differs |
| `SIGWINCH` | `winch_handler()` (`win/tty/wintty.c:557`) | handler runs, calls `resize_tty()`; the `ioctl(TIOCGWINSZ)` behind a pipe yields nothing to change, so **no observable effect** | 76 | fresh game | yes | **identical (inert)** |
| `SIGCONT` | default (no handler) | no-op for a process that is already running | 76 | fresh game | yes | **identical (inert)** |
| `SIGUSR1` | default → terminate | process dies instantly, **no save**, recording truncated | 30 | fresh game | yes | differs |
| `SIGUSR2` | default → terminate | dies, no save | 30 | fresh game | yes | differs |
| `SIGALRM` | default → terminate | dies, no save | 30 | fresh game | yes | differs |
| `SIGQUIT` | default → terminate+core (only `SIG_IGN`'d for **non**-wizard games, `unixmain.c:206`) | dies, no save | 30 | fresh game | yes | differs |
| `SIGPIPE` | default → terminate | dies, no save | 30 | fresh game | yes | differs |
| `SIGINT` | `done1` on a restored game (`unixmain.c:249`); otherwise default | game *survives* but diverges: same step count, **100 fewer PRNG calls** — the following keys answer a quit prompt instead of driving commands | 76 | fresh game | yes | differs |
| `SIGWINCH` ×8 (steps 10..45) | — | inert under repetition too | 76 | fresh game | yes | **identical (inert)** |
| `SIGCONT` ×8 (steps 10..45) | — | inert under repetition too | 76 | fresh game | yes | **identical (inert)** |
| `SIGWINCH` `after-key` | — | inert | 76 | fresh game | yes | **identical (inert)** |
| `SIGHUP` `after-key` | — | save + exit; the key was already consumed, so 14 more PRNG calls than the `before-key` case | 31 | restores the hangup save | yes (2 runs) | differs |

(All step counts above are from the **fixed** recorder of section 4. Recorded
before that fix, the SIGHUP/SIGXCPU rows read 30 steps, not 31: the exit race
was eating the very screen the hangup handler painted.)

Never sent: `SIGKILL`/`SIGSTOP` (out of scope by instruction) and `SIGTSTP`
(`#suspend` / `^Z` stops the whole headless process group — the same reason
`^Z` is excluded from `tools/gen-omnibus.mjs`).

**Determinism result:** at a `before-key` boundary every signal in the table
was byte-stable across two independent recordings. That is not luck — the
marker *is* the proof that the process is parked in `read()`, so the handler
has exactly one place to run. The `after-key` variants were also stable in 2
runs, but that is timing luck and should not be relied on: nothing pins where
in the command's execution the handler lands.

## 3. Why only the inert signals are in the corpus

The judge is `frozen/ps_test_runner.mjs`, and its `replayInputFor()` hands the
contestant exactly this:

```js
return { seed: segment.seed, datetime: segment.datetime,
         nethackrc: segment.nethackrc, moves: segment.moves };
```

There is no channel for "and a SIGHUP arrived after step 30". `frozen/` is
immutable, so a recording whose output depends on a signal is **unreplayable by
construction** — not a port bug, a contract fact. Measured, not assumed:

```
node frozen/ps_test_runner.mjs <SIGHUP recording>
  FAIL  RNG 3509/3574, Screen 30/40 (cursors 33/40)
```

The first 30 of segment 1's screens match the JS replay *exactly* — the C
process and the port agree byte-for-byte right up to the boundary the signal
landed on. The 10 failures are the one screen the hangup handler painted
afterwards, plus all 9 of segment 2: C restores the hangup save the signal
wrote, the JS side never wrote one, so it starts a fresh game. The port is
correct; the input contract simply cannot carry the event.

The same argument rules out the tempting alternative route to the hangup path.
`readchar_core()` calls `hangup(0)` on `EOF` (`src/cmd.c:5245`, transpiled at
`js/generated/cmd.js`), so closing stdin would produce the same emergency save
without any signal — but "the key stream ended" is not distinguishable from
"the recorder killed the child after the last marker" from `moves` alone, and
both sides deliberately agree to stop there (`js/boot/harness.mjs`:
`if (!inputQueue.length) throw new Error('input exhausted')`). Post-key-stream
behaviour, however reached, is outside the contract.

What *is* corpus-legal is the inert case, and it is worth having:
`sessions-extra/gen9997-signal-inert-laced.session.json` was recorded with
**59 real signals** (`SIGWINCH`/`SIGCONT`) delivered across 3 segments — inside
menus, getlin prompts, `--More--` screens, direction prompts, the getpos travel
cursor, yn prompts, a half-typed count, a half-typed extended command, through a
save/restore boundary and through the end-of-game disclosure screens. It is
byte-identical to the control recording of the same recipe with no signals at
all, and replays byte-exactly. The `signals` arrays are kept in the committed
session as documentation; the judge ignores unknown segment fields.

## 4. The bug the experiment found (fixed)

While byte-comparing repeat recordings, the *no-signal control* turned out to
be nondeterministic too — so the flakiness was never about signals.

`recordSegment()` handles markers on an async queue (`chain`), because each
marker's handler awaits file IO to read the rng-log delta. The `child.on(
'close')` handler resolved the segment immediately, without waiting for that
queue to drain, so however many trailing steps were still in flight were
dropped. It only bites segments whose process exits **on its own** — a
save-exit (`Sy`), `#quit`, or a death — because segments that merely run out of
keys are torn down from inside the queue by `finish()`.

Measured on the **public** corpus session `seed0030-ten-diverse-deaths`
(10 death segments), re-recorded 6× from its own recipe:

```
pre-fix   3 distinct recordings / 6 runs
          [79,124,93,291,198,236,253,172,39,468]  runs 1,2,4,5   <- correct
          [79,124,93,291,198,236,253,172,38,468]  run 3          <- lost a step
          [79,123,93,291,198,236,253,172,39,468]  run 6          <- lost a step
post-fix  1 distinct recording / 6 runs (== the committed session)
```

Same story on the 3-segment signal recipe (pre-fix: 3 shapes in 5 runs; post-fix
12/12 identical, with and without signals). So a third of re-recordings of a
committed corpus session were silently producing a session with a missing final
screen — a ground truth that would then be *wrong* for anyone replaying it.

Fix: `child.on('close')` now awaits the in-flight marker queue before settling
(`scripts/record-session.mjs`). `node scripts/verify-rerecord.mjs` on
`seed0013-friday13-save-then-fullmoon-restore` and `seed0030-ten-diverse-deaths`
still reproduces the committed sessions byte-for-byte, so nothing in the corpus
changes — the fix only removes the coin flip.

## 5. Reproducing

```bash
node tools/gen-adversarial.mjs signals --out /tmp/sig-recipe.json
node tools/gen-adversarial.mjs signals --control --out /tmp/sig-control.json
node scripts/record-session.mjs /tmp/sig-recipe.json  /tmp/laced.session.json
node scripts/record-session.mjs /tmp/sig-control.json /tmp/control.session.json
# the two recordings' `steps` arrays are identical
node frozen/ps_test_runner.mjs /tmp/laced.session.json
```
