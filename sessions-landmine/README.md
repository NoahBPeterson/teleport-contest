# sessions-landmine/

Recordings that capture **undefined C behavior**. They are deliberately kept
out of `sessions/` and `sessions-extra/` — they are not portable ground truth
and must never be added to a scored corpus. Their expected screens encode
whatever the recording host's stack happened to contain.

See `docs/LANDMINE-uninit-cmdstr.md`.

| file | landmine |
|------|----------|
| `seed4242-landmine-uninit-cmdstr.session.json` | `src/cmd.c:2356` uninitialized `char cmdstr[BUFSZ]`, `Strcat`ed at 2363 |
| `seed4242-landmine-route-bar.session.json` | same, shortest route (9 keystrokes) |
| `seed4242-landmine-route-keyfirst.session.json` | same, via `keyfirst=TRUE` branch |
| `seed4242-landmine-route-drop.session.json` | same, via `Strcat(cmdstr, ec->ef_txt)` at 2379 |

All four currently fail the port at 20/22 screens with RNG 2469/2469.
- seed4242-landmine-human-live.session.json — Noah's live interactive repro (89 steps, Ctrl-] at the divergence frame): FAIL 88/89, the one miss being the uninit-cmdstr frame.
