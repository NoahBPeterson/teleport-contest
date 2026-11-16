# Input generators for C-vs-JS comparison

Each script writes input `.session.json` files (seed, datetime, nethackrc, moves; no steps).
Record them with the C recorder one at a time (never in parallel on one install), then score:

    python3 tools/fuzz/gen-single.py <in-dir> 200 1500      # N sessions, L keys each
    for f in <in-dir>/*.json; do node scripts/record-session.mjs $f <out-dir>/$(basename $f) </dev/null; done
    for f in <out-dir>/*.json; do node frozen/ps_test_runner.mjs $f </dev/null | tail -1; done

Give `node` `</dev/null` inside a `while read` loop, or it eats the list.

- `gen-single.py`: one segment of random play, half in wizard mode
- `gen-saverestore.py`: 2-5 segments, each saved (`Sy`) and restored by the next
- `gen-bones.py`: wizard-mode Valkyrie dies by wand of death, saves bones; a later segment loads them
- `gen-options.py <nethack-c/upstream> <sessions-dir> <out>`: every settable boolean and 71 compound
  option values, on 6 public inputs
- `gen-features.py`, `gen-features2.py`: wizard-mode scenarios for functions no other recording runs

Results as of Nov 15 are in docs/TICKETS-c2js.md, C2JS-065.
