#!/usr/bin/env node
// strict-score.mjs — Sandbox parity gate.
//
// The judge runs contestant code in a Node child process with
// --permission (no fs writes, no network, no child processes, no
// native addons). Local frozen/score.sh does NOT sandbox — a port
// that accidentally depends on those APIs passes locally and scores
// zero on the judge. This tool proves parity: it runs the same
// session twice, once sandboxed exactly like the judge and once
// unsandboxed, and requires byte-identical outputs.
//
// Also greps js/ for forbidden runtime imports as a fast static check.
//
// Technique credit: Alex Serrano's strict-score.mjs / check-submission.mjs
// (serteal's transpiled entry).
//
// Usage:
//   node tools/strict-score.mjs [session.json ...]   (default: a smoke pair)

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOLS_DIR, '..');

// What contestant code may never touch under the judge sandbox.
const FORBIDDEN = [
    /\brequire\(['"](?:node:)?(?:fs|net|child_process|worker_threads|dgram|http|https)['"]\)/,
    /\bimport\s[\s\S]{0,80}?\bfrom\s+['"](?:node:)?(?:fs|net|child_process|worker_threads|dgram|http|https)['"]/,
    /\bimport\s*\(\s*['"](?:node:)?(?:fs|net|child_process|worker_threads)['"]\s*\)/,
    /\bprocess\.binding\b/,
    /\bWebAssembly\b/,
];

function staticCheck() {
    let bad = 0;
    for (const name of readdirSync(join(ROOT, 'js'))) {
        if (!name.endsWith('.js')) continue;
        if (['isaac64.js', 'terminal.js', 'storage.js'].includes(name)) continue; // frozen
        const src = readFileSync(join(ROOT, 'js', name), 'utf8');
        for (const re of FORBIDDEN) {
            const m = src.match(re);
            if (m) {
                console.error(`FORBIDDEN in js/${name}: ${m[0].slice(0, 70)}`);
                bad++;
            }
        }
    }
    return bad;
}

async function main() {
    let sessions = process.argv.slice(2);
    if (!sessions.length) {
        sessions = [
            join(ROOT, 'sessions', 'seed8000-tourist-starter.session.json'),
            join(ROOT, 'sessions', 'seed0900-tourist-explore-actions.session.json'),
        ];
    }

    const badImports = staticCheck();
    if (badImports) {
        console.error(`\n${badImports} forbidden import(s) in js/ — fix before push.`);
        process.exit(1);
    }

    const { runSessionCollect } = await import(join(TOOLS_DIR, 'sandbox-child.mjs'));
    let failed = 0;
    for (const sessionPath of sessions) {
        const name = sessionPath.split('/').pop();
        // Sandboxed run (judge-style).
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
