# NetHack 5.0 recorder patches

The patches that turn upstream NetHack 5.0 into a deterministic,
reproducible "recorder" build whose run-to-run behavior is exactly
what the JS port has to match.

| # | Patch | What it does | Why it's needed |
|---|---|---|---|
| 001 | `deterministic-runtime` | Pin date/time and RNG seed via env vars (`NETHACK_FIXED_DATETIME`, `NETHACK_SEED`) | Time-of-day affects moon phase, shopkeeper greetings, hire date — non-determinism unless pinned |
| 002 | `deterministic-qsort` | Replace `qsort` with a stable sort | Tie-breaking order in standard `qsort` varies by libc implementation |
| 003 | `rng-log-core` | Log every `rn2/rnd/rne/rnz/rnl/rn1/d` call to `NETHACK_RNGLOG` | Core PRNG — first of three contexts the port has to reproduce |
| 004 | `rng-log-lua-context` | Tag Lua-side PRNG calls with their `<file>:<line>` source location | Lua scripts (special levels) use the same PRNG; need to know which call is which |
| 005 | `rng-display-logging` | Log the third PRNG context (display/hallucination) to `NETHACK_RNGLOG_DISP` | Hallucination uses a separate stream so it doesn't perturb gameplay RNG |
| 006 | `nomux-capture` | Replace `tty` curses output with a deterministic 24×80 frame capture | Need exact terminal contents at every input boundary |
| 007 | `nomux-raw-print` | Route `raw_print` (early errors, banners) through nomux too | Otherwise startup banners aren't captured |
| 008 | `nomux-deterministic-capture` | Snapshot the screen exactly when C blocks for the next key | Pins frame boundaries to `tty_nhgetch` calls |
| 010 | `mktime-now` | Optional `NETHACK_MKTIME_NOW` (epoch) replaces the real clock that `time_from_yyyymmddhhmmss()` takes `tm_isdst` from; unset = unchanged | The recorder reads the session datetime at the record-time UTC offset, so local recordings made in EST differed from the official (EDT) ones. `scripts/recording-env.mjs` pins it to 2026-08-01 by default; with that, all 44 public sessions re-record identically (`scripts/verify-rerecord.mjs`) |
| 011 | `portal-nowhere-ledger` | One line in `ledger_no()`: when `dnum == -1`, read `svc.context.jingle`'s first 4 bytes as the ledger start, which is what upstream's out-of-bounds `svd.dungeons[-1].ledger_start` reads on the macOS build (`svc` sits right before `svd`; `sizeof (dungeon)` = 92, `ledger_start` at offset 84) | A wished magic portal "to nowhere" has `dst` = {-1,-1}. A monster entering it panics if no tune was ever improvised, and otherwise vanishes to wherever the garbage ledger decodes. The JS port's struct layout differs, so it read different garbage and panicked where C did not. Recorder behavior is unchanged: re-recording both cases reproduces the old sessions byte for byte. Line count unchanged |

## Apply

```bash
bash ../build-recorder.sh    # one-shot: clones submodule, applies patches, builds
```

Or by hand:

```bash
git submodule update --init nethack-c/upstream
cp -r nethack-c/upstream nethack-c/recorder
cd nethack-c/recorder
for p in ../patches/*.patch; do patch -p1 < "$p"; done
# ...build per sys/unix/Makefile.unix
```

## What's NOT in here

These patches are **only what the contest needs**. They produce a
build whose externally-observable PRNG sequence and screen output
are deterministic. They do **not** add internal debugging hooks
(event_log, midlog, mapstate hashing, etc.) — those are
teleport-internal aids that would leak the porting strategy.
