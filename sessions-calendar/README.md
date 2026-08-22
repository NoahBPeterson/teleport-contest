# sessions-calendar/

C recordings that pin **calendar behaviour across the DST boundary**. All of
them are real `nethack-c/recorder` output (`scripts/record-session.mjs`,
`RERECORD_TZ=America/New_York`, the recorder's default), so unlike
`sessions-landmine/` they *are* portable ground truth and are safe to score.

They exist because `sessions/` happens to contain no datetime where the
recorder's timezone is observable. The public corpus' winter datetimes are all
at 09:00–12:00 local, where the one-hour EST correction changes nothing on
screen; every datetime that would have exposed it (midnight, 06:00, 22:00) is
in EDT. So the port carried a fixed −04:00 `localtime()` for months at 44/44.

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

    bash frozen/score.sh sessions-calendar
