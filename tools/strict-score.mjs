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
// It also walks the *reachable* module graph from js/jsmain.js (the only
// entry point the judge imports) and rejects forbidden runtime imports in
// it. Reachability matters: js/boot/boot.mjs and js/boot/worker.mjs are
// developer entry points that legitimately use node:fs, and tools/ is not
// shipped code — none of them may be reachable from runSegment.
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
const ENTRY = join(ROOT, 'js/jsmain.js');

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

/** Every file reachable from `entry` by a resolvable relative specifier. */
function reachableFiles(entry) {
    const seen = new Set();
    const queue = [entry];
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
    const files = reachableFiles(ENTRY);
    let bad = 0;
    for (const file of files) {
        const rel = relative(ROOT, file);
        // frozen fixtures are the judge's own code, overlaid at scoring time
        if (['js/isaac64.js', 'js/terminal.js', 'js/storage.js'].includes(rel)) continue;
        const src = readFileSync(file, 'utf8');
        for (const re of FORBIDDEN) {
            const m = src.match(re);
            if (m) {
                console.error(`FORBIDDEN in ${rel}: ${m[0].slice(0, 70)}`);
                bad++;
            }
        }
    }
    console.log(`static: ${files.length} file(s) reachable from js/jsmain.js, ${bad} violation(s)`);
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
        console.error(`\n${badImports} forbidden import(s) reachable from js/jsmain.js — fix before push.`);
        process.exit(1);
    }

    const { runSessionCollect } = await import(join(TOOLS_DIR, 'sandbox-child.mjs'));
    let failed = 0;
    for (const sessionPath of sessions) {
        const name = sessionPath.split('/').pop();
        // Sandboxed run (judge-style): the ONLY allowance is reading the fork.
        const child = spawnSync(process.execPath, [
            '--permission',
            `--allow-fs-read=${ROOT}`,
            join(TOOLS_DIR, 'sandbox-child.mjs'),
            sessionPath,
        ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        if (child.status !== 0) {
            console.error(`FAIL ${name}: sandboxed run exited ${child.status}: ${child.stderr.trim().split('\n')[0]}`);
            failed++;
            continue;
        }
        // Unsandboxed reference run, in-process.
        let ref;
        try {
            ref = await runSessionCollect(sessionPath);
        } catch (e) {
            console.error(`FAIL ${name}: reference run threw: ${e.message}`);
            failed++;
            continue;
        }
        const sandboxed = JSON.parse(child.stdout);
        const same = JSON.stringify(sandboxed) === JSON.stringify(ref);
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
