#!/usr/bin/env node
// strict-score.mjs — Sandbox parity gate.
//
// The judge runs contestant code in a Node child process with
// --permission (no fs writes, no network, no child processes, no
// native addons, reads confined to the fork tree). Local frozen/score.sh
// does NOT sandbox — a port that accidentally depends on those APIs
// passes locally and scores zero on the judge. This tool proves parity:
// it runs the same session twice, once sandboxed exactly like the judge
// and once unsandboxed, and requires byte-identical outputs.
//
// It also walks the *reachable* module graph from every shipped entry point
// (see ENTRIES below — js/jsmain.js, the only one the judge imports, plus
// js/boot/main-thread-engine.mjs, which is the root of the yieldable build the
// browser rung ships) and rejects forbidden runtime imports in it.
// Reachability matters: js/boot/boot.mjs and js/boot/worker.mjs are developer
// entry points that legitimately use node:fs, and tools/ is not shipped code —
// none of them may be reachable from runSegment.
//
// Technique credit: Alex Serrano's strict-score.mjs / check-submission.mjs
// (serteal's transpiled entry).
//
// Usage:
//   node tools/strict-score.mjs [session.json ...]   (default: a smoke pair)
//   node tools/strict-score.mjs --all                (every sessions/*.json)

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOLS_DIR, '..');

// The roots the walk starts from.
//
// js/jsmain.js is the only entry the judge imports, and for the *scoring* path
// it is still the only root that matters. The second one is there because the
// browser rung grew a module graph of its own: js/boot/interactive.mjs reaches
// js/boot/main-thread-engine.mjs, which reaches js/boot/harness-y.mjs, which
// reaches all 176 modules of js/generated-y/**. Those are 13.6 MB of machine-
// written JS that no human reviewed and that ships to a real browser, so they
// are held to exactly the same rule as js/generated/**: no node builtins, no
// WebAssembly, nothing the judge's sandbox forbids.
//
// It is named explicitly rather than left to the dynamic-import chain from
// js/jsmain.js. The chain does reach it today, and a walk that depends on
// which rung happens to be wired up this week is a walk that stops checking
// 13.6 MB the day somebody moves an import. A root costs one line.
//
// NOT roots, on purpose: js/boot/boot.mjs and js/boot/worker.mjs (developer
// entry points that legitimately use node:fs), js/jsmain-yield.mjs and
// yieldtest/** (the Node-side parity harness for the yieldable build — same
// reason, it is not shipped), and tools/** (not shipped code either). None of
// them may be *reachable* from the roots below, which is the property this
// walk exists to enforce.
const ENTRIES = [
    join(ROOT, 'js/jsmain.js'),
    join(ROOT, 'js/boot/main-thread-engine.mjs'),
];

// Precisely-justified exceptions: file → forbidden pattern that is allowed
// there. js/boot/interactive.mjs's `import('node:worker_threads')` sits on the
// interactive-play path only: runSegment's call graph never executes it (the
// judge's own frozen/playability_runner.mjs drives interactive play in
// unsandboxed Node — see frozen/play.sh — where a worker thread hosting the
// resident engine is the intended mechanism), and it is IS_NODE-guarded and
// dynamic, so the sandboxed scoring child never even parses the module unless
// startEngine is called, which scoring never does. Judge-confirmed: 44/44
// public scored with this structure in place.
const ALLOWED = new Map([
    ['js/boot/interactive.mjs', [/\bimport\s*\(\s*['"]node:worker_threads['"]\s*\)/]],
]);

// What contestant code may never touch under the judge sandbox.
const FORBIDDEN = [
    /\brequire\(['"](?:node:)?(?:fs|net|child_process|worker_threads|dgram|http|https)['"]\)/,
    /\bimport\s[\s\S]{0,80}?\bfrom\s+['"](?:node:)?(?:fs|net|child_process|worker_threads|dgram|http|https)['"]/,
    /\bimport\s*\(\s*['"](?:node:)?(?:fs|net|child_process|worker_threads)['"]\s*\)/,
    /\bprocess\.binding\b/,
    /\bWebAssembly\b/,
];

// Static + literal-dynamic import specifiers.
const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

/** Every file reachable from `entries` by a resolvable relative specifier. */
function reachableFiles(entries) {
    const seen = new Set();
    const queue = [...entries];
    while (queue.length) {
        const file = queue.pop();
        if (seen.has(file) || !existsSync(file) || !statSync(file).isFile()) continue;
        seen.add(file);
        const src = readFileSync(file, 'utf8');
        for (const m of src.matchAll(SPEC_RE)) {
            const spec = m[1];
            if (!spec.startsWith('.') && !spec.startsWith('/')) continue; // bare / node: builtin
            const target = resolve(dirname(file), spec.split('?')[0]);
            queue.push(target);
        }
    }
    return [...seen].sort();
}

function staticCheck() {
    const files = reachableFiles(ENTRIES);
    let bad = 0;
    for (const file of files) {
        const rel = relative(ROOT, file);
        // frozen fixtures are the judge's own code, overlaid at scoring time
        if (['js/isaac64.js', 'js/terminal.js', 'js/storage.js'].includes(rel)) continue;
        const src = readFileSync(file, 'utf8');
        const allowed = ALLOWED.get(rel) || [];
        for (const re of FORBIDDEN) {
            const m = src.match(re);
            if (m) {
                if (allowed.some((a) => a.test(m[0]))) {
                    console.log(`allowed  in ${rel}: ${m[0].slice(0, 70)} (see ALLOWED)`);
                    continue;
                }
                console.error(`FORBIDDEN in ${rel}: ${m[0].slice(0, 70)}`);
                bad++;
            }
        }
    }
    // Reported per root as well as in total: "0 violations" over a walk that
    // silently found no yieldable build is not the same answer as "0
    // violations" over one that walked all 176 of its modules, and only the
    // count can tell them apart. js/generated-y/ is a build artifact
    // (C2JS_YIELD=1 node tools/c2js/build.mjs --all), and a tree that has not
    // built it gets the smaller number and a note rather than a false pass.
    const y = files.filter((f) => relative(ROOT, f).startsWith('js/generated-y/')).length;
    for (const e of ENTRIES) {
        console.log(`  root ${relative(ROOT, e)}: ${existsSync(e) ? 'walked' : 'ABSENT'}`);
    }
    console.log(`static: ${files.length} file(s) reachable from ${ENTRIES.length} root(s)`
        + ` (${y} in js/generated-y/${y ? '' : ' — NOT BUILT, run C2JS_YIELD=1 node tools/c2js/build.mjs --all'}),`
        + ` ${bad} violation(s)`);
    return bad;
}

function listSessions() {
    const dir = join(ROOT, 'sessions');
    return readdirSync(dir)
        .filter((n) => n.endsWith('.session.json'))
        .sort()
        .map((n) => join(dir, n));
}

async function main() {
    let sessions = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    if (process.argv.includes('--all')) sessions = listSessions();
    if (!sessions.length) {
        sessions = [
            join(ROOT, 'sessions', 'seed8000-tourist-starter.session.json'),
            join(ROOT, 'sessions', 'seed0900-tourist-explore-actions.session.json'),
            // multi-segment: exercises in-process segment isolation + the VFS
            // overlay round-trip through storage.
            join(ROOT, 'sessions', 'seed0013-friday13-save-then-fullmoon-restore.session.json'),
        ];
    }

    const badImports = staticCheck();
    if (badImports) {
        console.error(`\n${badImports} forbidden import(s) reachable from a shipped entry — fix before push.`);
        process.exit(1);
    }

    // One child per session per mode. The judge gives runSegment a fresh
    // process per session too, and it matters here: segment isolation forks a
    // copy of the 172-module transpiled graph, so replaying the whole corpus in
    // one process piles up graphs until GC dominates the runtime.
    const runChild = (sessionPath, sandboxed) => spawnSync(process.execPath, [
        ...(sandboxed ? ['--permission', `--allow-fs-read=${ROOT}`] : []),
        join(TOOLS_DIR, 'sandbox-child.mjs'),
        sessionPath,
    ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

    let failed = 0;
    for (const sessionPath of sessions) {
        const name = sessionPath.split('/').pop();
        // Sandboxed run (judge-style): the ONLY allowance is reading the fork.
        const child = runChild(sessionPath, true);
        if (child.status !== 0) {
            console.error(`FAIL ${name}: sandboxed run exited ${child.status}: ${child.stderr.trim().split('\n')[0]}`);
            failed++;
            continue;
        }
        // Unsandboxed reference run.
        const plain = runChild(sessionPath, false);
        if (plain.status !== 0) {
            console.error(`FAIL ${name}: reference run exited ${plain.status}: ${plain.stderr.trim().split('\n')[0]}`);
            failed++;
            continue;
        }
        const ref = JSON.parse(plain.stdout);
        const same = child.stdout === plain.stdout;
        if (!same) {
            console.error(`FAIL ${name}: sandboxed output differs from unsandboxed`);
            failed++;
            continue;
        }
        console.log(`OK   ${name} (screens=${ref.screens.length}, rng=${ref.rng.length}, sandbox-parity)`);
    }
    if (failed) {
        console.error(`\n${failed}/${sessions.length} sessions failed sandbox parity`);
        process.exit(1);
    }
    console.log(`\n=== sandbox parity OK (${sessions.length} sessions) ===`);
}

main().catch((e) => { console.error(e); process.exit(2); });
