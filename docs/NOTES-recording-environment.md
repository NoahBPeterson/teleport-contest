# NOTES: the recording environment

Upstream published `docs/recording-environment.md`
(davidbau/teleport-contest@2a7b4f2) listing the environment the sessions were
recorded in, with the ruling that matching it verbatim is fine. This is what
each item cost us to check, and what changed.

## `HOME` — already exact

    /Users/davidbau/git/mazesofmenace/teleport/maud/test/comparison/c-harness/results

`js/boot/harness.mjs` `VHOME` is byte-identical to the published string, and
`$HOME/.nethackrc` is injected per boot the same way the harness wrote it.
That is the path the options help pager prints via `get_configfile()`
(upstream issue #16); seed2200 has covered it since the VFS rework. No change.

## `TERM` — pinned, but inert

Was `ansi`, now `xterm-256color`. Nothing downstream reads the string: the
only consumers in the recorder are `win/tty/termcap.c:94` (which feeds
`tgetent()`, a stub here answering from a fixed capability table) and
`src/options.c:7223/7235`, whose `"AT"` and `"vt"` prefix probes miss for both
values. The one capability that *is* observable — `Co=256`, which gates
`WC2_EXTRACOLORS` and therefore the symset wall colors — was already set in
`TERMCAP_NUM`. Pinned so the environment matches on paper as well as in effect.

The rest of `TERMCAP_STR` is deliberately *not* being aligned to
`infocmp -C xterm-256color`. Screens are captured from the NOMUX shadow cell
buffer, not by re-parsing the escape stream: `graph_on()` sets
`nomux_decgfx_cur` directly and `term_start_attr()` calls `nomux_set_attr()`
before it looks at the capability string. So `se`/`ue`/`as`/`ae`/`ti`/`te`
content is unobservable, and only the *nullness* of a capability can change
control flow — which is identical between the two tables.

## `TZ` — the one real bug

`TZ` was `America/New_York`, and that is **not** a constant offset.

`getnow()` returns a wall clock pinned by the session's `datetime`, but
`getlt()` (`src/calendar.c:47`) hands the resulting `time_t` to `localtime()`.
For a summer datetime that is EDT (−04:00); for a winter one it is EST
(−05:00). The port applied a flat −04:00 in both directions, so every session
whose *simulated* date falls outside DST got a wall clock one hour late.

`mktime()` is the opposite case and was already right. The recorder patch
seeds `tm` from `localtime(real now)` — August 2026, so `tm_isdst == 1` — then
overwrites Y/M/D h:m:s and calls `mktime()`. tzcode's `time1()` fails its
first attempt for a winter date, then its "divine the type they started from"
fallback shifts `tm_sec` by the offset delta and retries, and the two
corrections cancel exactly. Confirmed against Darwin libc over 15 datetimes:
the `time_t` is a constant −04:00 interpretation of the wall clock for every
date, DST or not. `ubirthday` — and so `shknam.c`'s shopkeeper-name pick — was
never affected, which is why this hid behind a green board.

Three separate consumers see the hour:

| consumer | code | failure |
|---|---|---|
| `night()` | `hour < 6 \|\| hour > 21` | "It is nighttime." appears/disappears on the `^X` attributes screen |
| `midnight()` | `hour == 0` | midnight undead bonus |
| `phase_of_the_moon()` | `((((tm_yday + epact) * 6) + 11) % 177) / 22) & 7` | a datetime in the 00:00–00:59 hour rolls the date back a day, so the game opens with a different moon pline — a `--More--` that shifts every following keystroke |
| `friday_13th()` | `tm_wday == 5 && tm_mday == 13` | same rollback; and this one feeds luck, so it diverges in **RNG**, not just screens |
| `getyear()` | RIP tombstone | wrong year carved on the stone |

`g.localtime` now derives the fields from `Intl.DateTimeFormat` with
`timeZone: 'America/New_York'`. `g.time` and `g.mktime` keep
`REC_UTC_OFFSET_SEC`.

Both the formatter and the decoded fields live on `globalThis`, not in the
`runBootGame` closure. Constructing an `Intl.DateTimeFormat` costs ~18 ms (it
faults in ICU's zone tables) and `js/boot/isolation.mjs` re-instantiates the
module graph per segment, so a closure-local one cost ~80 ms of scored startup
across the corpus — 825 → 912 ms. Hoisted, it is back in the noise (847–875 vs
a 823–851 baseline). The zone is a fixed constant, so the process-wide cache is
sound.

Why this survived 44/44: `sessions/` contains winter datetimes (31 of them use
`20000110090000`), but all at 09:00–12:00 local, where the correction moves
the hour from 9 to 8 and nothing on screen notices. Every datetime that would
have exposed it is in EDT. `sessions-calendar/` closes that hole — 12 fresh C
recordings that went 3/12 before the fix and 12/12 after.

`g.localtime` was also cross-checked directly against Darwin `localtime()`
over 2 220 032 `time_t` values — a coarse sweep of 1968–2040 that drifts
through every hour, every second within ±2h of every real UTC-offset change in
that span, and every local midnight of every month — comparing all nine `tm`
fields. Zero mismatches.

## Aside: the score file is not a leak

Worth stating because it looks like it should be one. The RIP tombstone and
the top-ten table are the only screens that render persistent host state, and
if the recorder's `record` file had carried deaths from games outside the
corpus, no port could ever match them. It didn't: `seed0030-ten-diverse-deaths`
shows a top-ten list with exactly **one** entry after its first death, then
2, 3, 4, 5 as its own ten segments die in turn, every name from the session
itself. The score file starts empty per session and only accumulates within it.
`scripts/record-session.mjs` `clearStaleState()` reproduces that — it unlinks
`record`, `xlogfile`, `logfile`, `paniclog`, plus bones and lock files, on the
first segment and recreates them empty — and the vendored `nethackdir` ships a
zero-byte `record`, so the port's VFS starts from the same place and carries it
across segments in the storage overlay.

One caveat on the death probes: every death in `sessions/` *except* seed0030 is
in wizard mode, which prints "Since you were in wizard mode, the score list
will not be checked" and skips scoring entirely. So a death session is not
automatically coverage of the date-rendering path; `tz-s1`/`tz-s2` are cut from
seed0030 specifically because it is the only non-wizard death in the corpus.

## Everything else

`TERM`-driven 80×24 is already what `ioctl()` and `co`/`li` report. The Darwin
libc surface the page calls out is covered by `test/posix-ere.test.mjs` and
`test/printf.test.mjs`; the tty input modes are the zeroed no-tty termios
`js/boot/harness.mjs` already emulates.
