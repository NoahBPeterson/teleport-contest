# Roadmap — teleport-contest fork (compacted 2026-08-06)

Status legend: ✅ done · 🔄 in progress · 📋 planned · ⚠️ blocked/external · 🧊 icebox

## Phase 1 — byte-exact NetHack 5.0 port (freeze: Nov 29, 2026)

### Scoring-critical
| # | Task | Status | Notes |
|---|------|--------|-------|
| 1.1 | Public corpus parity (44/44) | ✅ | Judge-confirmed 11,405/11,405; PRNG+screens 100% |
| 1.2 | Held-out parity (43/44) | ⚠️ | 1 screen short of 11,265. Suspected $HOME-path class (issue #16); unfixable locally unless upstream re-records or documents env. Nudge #16 with held-out data. |
| 1.3 | Sandbox-legal architecture | ✅ | In-memory VFS, vendored data (js/data-nethackdir), Worker-realm segment isolation, strict-score gate |
| 1.4 | Browser playability | 🔄 | Shipped: resident engine, SAB + SW-XHR transports, 1.7–5.1 ms/move. Await crawl verdict; XHR sits on 5 ms threshold; if judged on aggregate runner, boot time (1.26 s) is the lever. |
| 1.5 | Animation frames (supplemental) | ✅ | 1,483/1,483 public locally; await crawl for held-out 2,959 |
| 1.6 | Speed (category-best target) | 🔄 | 3027+8.7 → ~835+3.5 locally (BigInt rewrite −43%, folding −8% bytes). Next: boot time (module instantiation ~400 ms), per-move toward 2.0 class. |

### Quality / Phase-2 hedges (land BEFORE the freeze — free in baseline)
| # | Task | Status | Notes |
|---|------|--------|-------|
| 1.7 | Constant folding (emit-time) | ✅ | 301,692 folds, 0 mismatch, self-auditing |
| 1.8 | Named constants — enum tier | 📋 | AST has names; emit generated const modules + named refs. Next agent. |
| 1.9 | Named constants — macro provenance tier | 📋 | cmap_to_glyph family first; fold to named form, audit like 1.7. Biggest Phase-2 diff hedge. |
| 1.10 | Lua→JS script port | 📋 | User-mandated post-parity/pre-freeze. Transpiled Lua 5.4.8 interpreter stays as differential oracle per script. Large. |
| 1.11 | Readability: de-box mega-globals, layout accessors | 📋 | After 1.8/1.9; corpus is the referee |
| 1.12 | Delete js/legacy/, strip debug tripwires (cptr NaN guard etc.) | 📋 | Before tag; dead weight in baseline is fine, in diff is not |
| 1.13 | Method writeup (Best Method award) | 📋 | Raw material excellent: docs/, LANDMINE, NOTES-*, session logs. Formalize. |

### Infrastructure / corpus
| # | Task | Status | Notes |
|---|------|--------|-------|
| 1.14 | Test corpus (69 sessions, all byte-exact) | ✅ | public 44 + extra 25 (omnibus 20k-step, options-torture, adversarial multi-segment, marathon Dlvl10) |
| 1.15 | Human session promotion decision | 📋 | my-first-dive, -2-3 (64k RNG, ^Z) in sessions-live/ — promote to sessions-extra? (Noah to confirm) |
| 1.16 | Play-record rig + JS mirror | ✅ | tools/play-record.mjs; auto-suffix filenames still open (minor) |
| 1.17 | Judge simulator (headless Chrome, mirror-shaped serving) | ✅ | tools/judge-sim/; playability harness included |
| 1.18 | Anim-frame diff support in screendiff | 📋 | Frozen runner scores anim; aux tools blind to it. Small. |
| 1.19 | CI: score.yml + strict-score green from bare clone | ✅ | Keep green |
| 1.20 | Session-log export (main + all agents) | ✅ | export-claude-logs.sh; run at every chunk (standing rule) |

### Upstream / external
| # | Task | Status | Notes |
|---|------|--------|-------|
| 1.21 | Contest issue: $HOME leak in seed2200 | ✅ | Noah's #16 (dup #17 closed). Follow up with held-out evidence per 1.2. |
| 1.22 | NetHack upstream: uninit cmdstr UB (5.0 release + 3.7 branch) | 📋 | Full forensics in docs/LANDMINE-uninit-cmdstr.md; draft ready; Noah decides who files |
| 1.23 | Reproducibility-limits docs ($HOME, uninit buffer, signals) | ✅ | LANDMINE + NOTES-signal-laced + NOTES-marathon |

## Phase 2 — NetHack 5.1 adaptation (post-freeze; score = parity ÷ js/ diff size)
| # | Task | Status | Notes |
|---|------|--------|-------|
| 2.1 | Re-transpile 5.1 C sources | 📋 | Emitter output stability = small diffs; named constants (1.8/1.9) concentrate churn in const modules |
| 2.2 | Re-vendor 5.1 data files | 📋 | Now inside js/ (judge mirror constraint) → counts in diff; regeneration is one module set |
| 2.3 | Re-record corpus vs 5.1 recorder; re-run parity grind | 📋 | Harness + diff tooling all reusable |
| 2.4 | Lua script diffs (if 5.1 changes .lua) | 📋 | If 1.10 done: ported scripts diff in js/; interpreter-as-oracle re-validates |

## Standing constraints (never violate)
- Never hand-edit js/generated (central fixes only); frozen/ + isaac64/terminal/storage untouchable
- Parity > speed > readability, in that order, always verified by full corpus
- Worktree agents: symlink .cache/recorder per current protocol; never re-dump ASTs
- Cite other contestants' work in commit + comment when consulted
- Export session logs after every work chunk
