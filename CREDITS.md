# Credits

This entry stands on published work by other contestants and the
contest organizer. Ideas we adopted, and who they came from:

- **Hidden-state oracle** — *Owen Lockwood* (lockwo). Instrument the C
  recorder and the JS port to emit the same hidden state (monster HP,
  positions, tameness, chain order) at every input boundary; compare
  field-by-field and stop at the first disagreement. Described in David
  Bau's "Hunting Zombies" (2026-07-16). Our implementation:
  `nethack-c/patches/009-state-dump.patch`, `js/statedump.js`,
  `tools/oracle-diff.mjs`.

- **Adversarial self-recorded sessions** — *Alex Serrano* (serteal).
  Record your own sessions with the patched C recorder across
  combinatorial roles/races/genders/alignments and hostile datetimes
  (epoch edges, Friday the 13th, int32 overflow) as a held-out proxy.
  His `tools/generate-local-traces.mjs` is the model for our
  `tools/generate-sessions.mjs`.

- **Sandbox-exact local scoring** — *Alex Serrano* (serteal). Re-run
  scoring under `node --permission` with the judge's isolation and
  statically reject forbidden imports before pushing.
  Our `tools/strict-score.mjs`.

- **Screen-serializer fidelity lessons** — *Raphaël Hervier*
  (richie3366). The scored artifact is C's tty escape-stream behavior
  (SGR placement, CUF space runs, default-color elision on blanks),
  not the abstract screen grid; from his public divergence log
  (D-0930–D-0934).

- **Agent-religion countermeasures** — *David Bau* (contest organizer,
  field report) and *Raphaël Hervier* (constitution pattern). Falsifier
  discipline: every fix names the C locus it ports; trace-index
  branches (`if (getRngLog().length === N)`) and coordinate-conditioned
  behavior are deleted on sight.

- **Cautionary tales** (what not to do): *Florian Brand* (xeophon) —
  session-keyed special-casing collapses on held-out sessions;
  *Anh Dao* (daoa0601) — replay fixtures pass public sessions while the
  honest engine stays at 25/44. Documented in their own repos and in
  Bau's posts.

The contest skeleton, recorder patches 001–006, and scoring harness are
David Bau's (davidbau/teleport-contest). NetHack itself is © the
NetHack DevTeam (NetHack General Public License); the bundled Lua 5.4.8
interpreter is © Lua.org, PUC-Rio (MIT).
