# Landmine: uninitialized `cmdstr[BUFSZ]` in the interactive key-rebind menu

**Status:** reproduced against the C recorder, minimal session recorded, JS port
diverges. Not added to any passing corpus — the recordings live in
`sessions-landmine/` precisely because they encode platform-specific stack
garbage and must not be treated as a portable ground truth.

---

## 1. The C

Upstream NetHack 5.0, `src/cmd.c`, function `handler_rebind_keys_add()`
(declared `staticfn void handler_rebind_keys_add(boolean)` at cmd.c:142,
defined at **cmd.c:2290-2405**). None of the recorder patches in
`nethack-c/patches/` touch `cmd.c` at all (`grep -c cmd.c patches/*.patch` →
0 for every patch), so this is pristine upstream code, not a harness artifact.

The buffer is declared at **cmd.c:2356** and is never initialized:

```c
/* src/cmd.c:2352-2381 */
    npick = select_menu(win, PICK_ONE, &picks);
    destroy_nhwindow(win);
    if (npick > 0) {
        struct Cmd_bind *prevcmd;
        char cmdstr[BUFSZ];          /* <-- 2356: no `= ""`, no cmdstr[0]='\0' */

        i = picks->item.a_int;
        free((genericptr_t) picks);

        if (i == -1) {
            ec = NULL;
            Strcat(cmdstr, "nothing");        /* <-- 2363: Strcat onto garbage */
            goto bindit;
        } else {
            ec = &extcmdlist[i-1];

            if ((ec->flags & CMD_PARAM) != 0) {
                char parambuf[BUFSZ];
                char querybuf[BUFSZ];

                parambuf[0] = '\0';
                Sprintf(querybuf, "Command %s requires a parameter:", ec->ef_txt);
                getlin(querybuf, parambuf);
                (void) mungspaces(parambuf);
                Snprintf(cmdstr, BUFSZ-1, "%s(%s)", ec->ef_txt, parambuf);
                cmdstr[BUFSZ-1] = '\0';       /* this branch is fine: Snprintf */
            } else {
                Strcat(cmdstr, ec->ef_txt);   /* <-- 2379: Strcat onto garbage */
            }
        }
 bindit:
        ...
        prevcmd = cmdbind_get(key);

        if (bind_key(key, cmdstr, TRUE)) {                     /* 2393 */
            if (prevcmd && prevcmd->cmd != ec) {
                pline("Changed key '%s' from \"%s\" to \"%s\".",
                      key2txt(key, buf2), prevcmd->cmd->ef_txt, cmdstr);
            } else if (!prevcmd) {
                pline("Bound key '%s' to \"%s\".",
                      key2txt(key, buf2), cmdstr);
            }
        } else {
            pline("Key binding failed?!");                     /* 2402 */
        }
    }
```

Two of the three assignment paths use `Strcat` (`strcat`), which appends at the
*first NUL byte already in the buffer*. Only the `CMD_PARAM` branch (2376) uses
`Snprintf` and is therefore safe.

`bind_key()` (cmd.c:2661-2728) then does an exact-string lookup on that value:

```c
    /* special case: "nothing" is reserved for unbinding */
    if (!strcmpi(command, "nothing")) {
        cmdbind_remove(key);
        return TRUE;
    }
    ...
    for (extcmd = extcmdlist; extcmd->ef_txt; extcmd++) {
        if (strcmpi(buf, extcmd->ef_txt))
            continue;
        ...
        return TRUE;
    }
    free(buf);
    return FALSE;
```

So whether the user's key binding *works at all* is decided by whether
`cmdstr[0]` happens to be `'\0'` on entry.

### Trigger conditions

Reached only through the interactive rebind UI:

`doset()` (`#optionsfull`, i.e. the `m` prefix + `O`)
→ Advanced/"Other settings" → **`bind keys`** (options.c:8340,
`optfn_o_bind_keys` → `handler_rebind_keys`, cmd.c:2408)
→ "Do what?" menu (`a` = bind key to a command, `b` = bind command to a key)
→ `handler_rebind_keys_add()`
→ pick **any** item from the "Bind what command?" menu **except** a
`CMD_PARAM` command
→ supply a key.

The plain `O` (simple) options menu cannot reach it: `doset_simple()` iterates
`for (section = OptS_General; section < OptS_Advanced; section++)`
(options.c:8581), so the whole Advanced section — including `bind keys` — is
excluded. You need `#optionsfull`, which is bound to the `m` prefix on `O`
(cmd.c:1779-1784).

Both `keyfirst` values (menu items `a` and `b`) hit it; the only escape is a
`CMD_PARAM` command, which goes through `Snprintf`.

---

## 2. Minimal recipe

Config (`nethackrc`), seed 4242, datetime `20000110090000`:

```
OPTIONS=name:Landmine,role:Valkyrie,race:human,gender:female,align:neutral
OPTIONS=playmode:debug,!legacy,!tutorial,suppress_alert:3.4.3
```

Fully-specified role/race/gender/align skips chargen, so step 0 is already the
dungeon — no intro keys are needed.

**Shortest route to the failure screen: 9 keystrokes.**

| # | key | effect |
|---|-----|--------|
| 1 | `m` | command prefix |
| 2 | `O` | `m`+`O` runs `#optionsfull` → `doset()` (full options menu) |
| 3 | `\|` | jump to last page (8 of 8) |
| 4 | `<` | back one page → page 7, which holds `r - bind keys` |
| 5 | `r` | toggle-select `bind keys` |
| 6 | `\n` | confirm the PICK_ANY selection → `handler_rebind_keys()` |
| 7 | `b` | "bind command to a key" (PICK_ONE, closes immediately) |
| 8 | `a` | "nothing: unbind the key" → **`Strcat(cmdstr, "nothing")` on garbage** |
| 9 | `z` | "Bind which key?" → answer → `bind_key()` → `pline()` |

Full move string including exit (17 keys total):

```
mO|<r\nbaz \x1b\x1b#q\nyq
```

(` ` dismisses the `--More--`, `ESC` `ESC` leaves the rebind and options menus,
`#q`+Enter+`y`+`q` is `#quit` / "Really quit" / "Dump core? → q".)

The more obvious page-by-page route `mO>>>>>>r\nbaz…` (13 keystrokes to the
failure) is recorded as the "base" variant because it is the route a human
would take.

### Recorded artifacts (`sessions-landmine/`)

| file | moves | landmine step |
|------|-------|---------------|
| `seed4242-landmine-uninit-cmdstr.session.json` | `mO>>>>>>r\nbaz \x1b\x1b#q\nyq` | 13 |
| `seed4242-landmine-route-bar.session.json` | `mO\|<r\nbaz \x1b\x1b#q\nyq` | 9 |
| `seed4242-landmine-route-keyfirst.session.json` | `mO>>>>>>r\naza \x1b\x1b#q\nyq` | 13 |
| `seed4242-landmine-route-drop.session.json` | `mO>>>>>>r\nbsz \x1b\x1b#q\nyq` (picks `drop`, i.e. the `ec->ef_txt` branch at 2379) | 13 |

Every one of them prints, on the landmine step:

```
Key binding failed?!--More--
```

---

## 3. Does the garbage vary?

### 3a. Observable output: no. Byte-identical everywhere.

5 fresh recorder processes per recipe (30 recordings total, 6 route variants),
plus 6 more runs of the base recipe with `LANDMINE_PAD` env padding of
0/1/7/64/517/4096 bytes to move the stack base.

```
sha256 of the whole recorded session.json, base recipe:
  run1..run5      e58edb607246c4ba2dc371f7edbeedc82ce05fc846e4e36d31f6ae942fe680d5
  env pad 0       e58edb60...80d5
  env pad 1       e58edb60...80d5
  env pad 7       e58edb60...80d5
  env pad 64      e58edb60...80d5
  env pad 517     e58edb60...80d5
  env pad 4096    e58edb60...80d5
```

All 11 files are byte-for-byte identical — zero diff on the affected frames.
Per-route step hashes (sha256 of `segments[0].steps`, 5 runs each, all stable):

```
base            f04e4697206ea75e   step 13 -> "Key binding failed?!--More--"
route-bar       436c493ad0fdf667   step  9 -> "Key binding failed?!--More--"
route-keyfirst  243c72a9cca4539d   step 13 -> "Key binding failed?!--More--"
route-drop      c758b7319186721d   step 13 -> "Key binding failed?!--More--"
route-detour    3d59f75c2476bb92   step 16 -> "Key binding failed?!--More--"
route-deeppage  a6093c00c3ae59c3   step 20 -> "Key binding failed?!--More--"
```

### 3b. Underlying buffer: yes, it varies every run.

Confirmed with lldb (`breakpoint set --file cmd.c --line 2393`, then dump
`cmdstr`). Backtrace at the breakpoint:

```
frame #0: nethack`handler_rebind_keys_add(keyfirst='\0') at cmd.c:2393:22
frame #1: nethack`handler_rebind_keys                    at cmd.c:2440:13
frame #2: nethack`optfn_o_bind_keys(optidx=24, req=3, …) at options.c:8340:9
frame #3: nethack`doset                                  at options.c:8935:29
```

`cmdstr` is at `0x16fdfd4c8`. Its first bytes at 2393, for `"nothing"`:

```
CMDSTR_REPR = b"\x06\xf8\xc2nothing\x00\x00…"
strlen(cmdstr) == 10        (not 7)
cmdstr[0]      == 0x06      (not 0)
```

There is a **3-byte garbage prefix**, then the `Strcat`ed payload. Byte 3 was
the NUL that `strcat` found. Raw hex of the first 16 bytes, 3 runs per route:

```
route            run  cmdstr[0..15]                      strlen
base              1   0638c3 6e6f7468696e67 00 00 00 00   10   "\x06\x38\xc3nothing"
base              2   06b8bb 6e6f7468696e67 00 00 00 00   10
base              3   0678b8 6e6f7468696e67 00 00 00 00   10
route-bar         1   0638bf 6e6f7468696e67 00 00 00 00   10
route-bar         2   06f8b9 6e6f7468696e67 00 00 00 00   10
route-bar         3   0678c4 6e6f7468696e67 00 00 00 00   10
route-keyfirst    1   0678c0 6e6f7468696e67 00 00 00 00   10
route-keyfirst    2   06f8c2 6e6f7468696e67 00 00 00 00   10
route-keyfirst    3   0638c2 6e6f7468696e67 00 00 00 00   10
route-drop        1   0678c1 64726f70 00 01000000000000    7   "\x06\x78\xc1drop"
route-drop        2   06f8bd 64726f70 00 01000000000000    7
route-drop        3   0638b5 64726f70 00 01000000000000    7
route-detour      1   0638b8 6e6f7468696e67 00 00 00 00   10
route-detour      2   06b8ba 6e6f7468696e67 00 00 00 00   10
route-detour      3   06f8b6 6e6f7468696e67 00 00 00 00   10
route-deeppage    1   06f8c2 6e6f7468696e67 00 00 00 00   10
route-deeppage    2   0638b8 6e6f7468696e67 00 00 00 00   10
route-deeppage    3   06b8b6 6e6f7468696e67 00 00 00 00   10
```

Bytes 1 and 2 change on **every single run** (`38 c3`, `b8 bb`, `78 b8`,
`38 bf`, `f8 b9`, …) — they are the middle bytes of an ASLR-randomised
address left behind by the `select_menu()` call tree that previously occupied
this frame. Byte 0 is `0x06` and byte 3 is `0x00` in all 18 samples on this
build (arm64 macOS, NetHack 5.0.0 recorder build of 2026-05-02).

**Conclusion: stable-but-arbitrary.** The buffer really does contain live,
run-varying stack garbage; the *screen output* is nevertheless deterministic on
this platform because `cmdstr[0]` is reliably non-zero, so `bind_key()` always
misses and always prints the constant string `"Key binding failed?!"`. Nothing
in the C guarantees that: a different compiler, optimisation level, stack
layout, ABI, or terminal library would flip `cmdstr[0]` to `0` and turn the
same keystrokes into a *successful* rebind with a completely different message
— and a different persistent game state. This is a genuine landmine for anyone
who re-records the corpus on another machine.

---

## 4. JS port divergence

`node frozen/ps_test_runner.mjs sessions-landmine/seed4242-landmine-uninit-cmdstr.session.json`

```
FAIL: seed4242-landmine-uninit-cmdstr.session.json (RNG 2469/2469, Screen 20/22)
```

RNG is perfect; two screens differ. Screendiff:

```
--- step 13 key="z" cells=46 cursor want=[28,0,1] got=[48,0] ---
 row 0 (46 cells)
   want: "Key binding failed?!--More--"
   got:  "Changed key 'z' from \"zap\" to \"nothing\".--More--"
--- step 14 key=" " cells=28 cursor want=[47,4,1] got=[47,5] ---
 row 4
   want: "                                         (end)"
   got:  "                                         c - view changed key binds"
 row 5
   want: ""
   got:  "                                         (end)"
[diff] pass=20/22 mismatched steps: 13,14
```

`route-keyfirst` diverges identically; `route-drop` diverges at the same two
steps with the port printing a successful `drop` rebind instead of the failure.

**Why.** The port declares the buffer as

```js
// js/generated/cmd.js:3188
let cmdstr = new Uint8Array(256);
...
void cptr.strcat(cptr.decay(cmdstr), __sl459);   // 3194, "nothing"
...
void cptr.strcat(cptr.decay(cmdstr), cptr.ldPtr(cptr.add(ec, 8)));  // 3208
```

`new Uint8Array(256)` is **zero-filled by specification**. So the JS `strcat`
appends at index 0, `cmdstr` is exactly `"nothing"`, `bind_key()` matches the
reserved unbind name, returns `TRUE`, and the port prints what the C source
*says* should happen. The C prints what the C *does*.

The knock-on effect at step 14 is the more damaging half: because the JS port
actually performed the unbind, `count_bind_keys()` is now 1, so
`handler_rebind_keys()` (cmd.c:2427-2431) adds a third menu entry
`c - view changed key binds` that does not exist in the C recording. One
uninitialized byte changes both the message *and* the persistent option state
*and* the shape of every subsequent menu.

No session in `sessions/` or `sessions-extra/` currently reaches the
`Strcat` — `gen9998-options-torture.session.json` opens the same menus
(steps 732-740) but ESCs out before selecting a command, so the corpus does not
yet punish this. It will the moment anyone records a session that finishes the
rebind.

---

## 5. Draft issue text for davidbau/teleport-contest

> **`handler_rebind_keys_add()` builds its command string in an uninitialized
> stack buffer — recorded sessions encode host stack garbage**
>
> `src/cmd.c:2356` declares `char cmdstr[BUFSZ];` inside
> `handler_rebind_keys_add()` and never initializes it; two of the three paths
> that fill it use `Strcat` (cmd.c:2363 `Strcat(cmdstr, "nothing")` and
> cmd.c:2379 `Strcat(cmdstr, ec->ef_txt)`), which append at whatever NUL
> already happens to be in the frame. Only the `CMD_PARAM` branch (cmd.c:2376)
> uses `Snprintf` and is safe. `bind_key()` (cmd.c:2669, 2690) then does an
> exact `strcmpi` against the extended-command table, so whether an interactive
> key rebind succeeds is decided by whichever bytes the previous
> `select_menu()` call tree left on the stack. On the arm64 macOS recorder
> build the buffer reliably holds a 3-byte prefix — lldb at cmd.c:2393 shows
> `cmdstr == b"\x06\xf8\xc2nothing"`, `strlen == 10` — whose middle two bytes
> change on every run with ASLR, so `bind_key()` always fails and the game
> always prints `Key binding failed?!` instead of
> `Changed key 'z' from "zap" to "nothing".`. That makes the observable output
> *stable but arbitrary*: identical for 11 fresh recorder processes (including
> ones launched with 0/1/7/64/517/4096 bytes of extra environment) and across
> six different menu routes, yet with nothing in the C standard or the source
> guaranteeing it. A 9-keystroke session from game start reproduces it —
> `m O | < r ⏎ b a z` — and a straightforward JS port diverges on it
> immediately, because `new Uint8Array(BUFSZ)` is zero-filled and therefore
> performs the rebind the source *says* it should, which additionally makes
> `count_bind_keys()` return 1 and adds a `view changed key binds` entry to the
> very next menu. Ports that want the recorded corpus to pass have to emulate
> the garbage, and re-recording the corpus on a different compiler/ABI could
> silently flip these frames. Suggested upstream fix: `cmdstr[0] = '\0';`
> immediately after the declaration (or `char cmdstr[BUFSZ] = "";`).

---

## 6. Reproduction commands

```bash
# record (recorder must be present at nethack-c/recorder/install/...)
node scripts/record-session.mjs <in.session.json> <out.session.json>

# replay through the port
node frozen/ps_test_runner.mjs sessions-landmine/seed4242-landmine-uninit-cmdstr.session.json

# inspect the raw buffer (short paths matter: nh_getenv() rejects env values
# longer than BUFSZ/2 == 128 bytes, see src/options.c:6848)
lldb -b \
  -o "settings set target.input-path keys.bin" \
  -o "settings set target.env-vars HOME=… HACKDIR=… NETHACK_SEED=4242 \
      NETHACK_FIXED_DATETIME=20000110090000 NETHACK_RAW_KEYS=1 NOMUX_MARKERS=1" \
  -o "breakpoint set --file cmd.c --line 2393" \
  -o "run -u Landmine" \
  -o "memory read --size 1 --format x --count 96 &cmdstr[0]" \
  -o "expr -- (int)strlen(cmdstr)" \
  nethack-c/recorder/install/games/lib/nethackdir/nethack
# keys.bin contains: mO|<r\nbaz
```
