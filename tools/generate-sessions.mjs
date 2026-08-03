#!/usr/bin/env node
// generate-sessions.mjs — Adversarial session generator.
//
// Records NEW sessions with the patched C recorder across combinatorial
// chargen choices and adversarial datetimes, into sessions-extra/.
// The 44 public sessions are a biased sample; the held-out pool was
// recorded by this same recorder, so self-recorded sessions are the
// closest thing we have to a held-out proxy. Never tune to sessions/
// alone.
//
// Technique credit: Alex Serrano's generate-local-traces.mjs (serteal's
// transpiled entry) — tiered combinatorial recording with adversarial
// datetimes.
//
// Usage:
//   node tools/generate-sessions.mjs [--out sessions-extra] [--only N]
//
// Each recipe is deterministic: same inputs → same recording (the
// recorder is pinned by NETHACK_SEED + NETHACK_FIXED_DATETIME).

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS_DIR, '..');
const RECORD = path.join(TOOLS_DIR, '..', 'scripts', 'record-session.mjs');

// role: [valid aligns] (subset used), [extra races beyond human]
const ROLES = [
    ['Archeologist', ['lawful', 'neutral'], ['gnome', 'dwarf']],
    ['Barbarian', ['neutral', 'chaotic'], ['orc']],
    ['Caveman', ['lawful', 'neutral'], ['gnome', 'dwarf']],
    ['Healer', ['neutral'], ['gnome']],
    ['Knight', ['lawful'], ['dwarf']],
    ['Monk', ['lawful', 'neutral', 'chaotic'], []],
    ['Priest', ['lawful', 'neutral', 'chaotic'], ['elf']],
    ['Ranger', ['neutral', 'chaotic'], ['elf', 'gnome', 'orc']],
    ['Rogue', ['chaotic'], ['orc']],
    ['Samurai', ['lawful'], []],
    ['Tourist', ['neutral'], []],
    ['Valkyrie', ['lawful', 'neutral'], ['dwarf']],
    ['Wizard', ['neutral', 'chaotic'], ['elf', 'gnome', 'orc']],
];

const NAMES = ['Ada', 'Boris', 'Cora', 'Dag', 'Elsa', 'Finn', 'Greta', 'Hugo',
    'Ines', 'Jonas', 'Kira2', 'Lena', 'Milo', 'Nora', 'Otto', 'Pia', 'Quinn',
    'Rosa', 'Sven', 'Tara', 'Ulf', 'Vera', 'Walt', 'Xena', 'Yara', 'Zane'];

// Adversarial datetimes: epoch edges, Friday the 13th, leap day,
// int32-overflow eve, ordinary days. Moon phase / luck / shopkeeper
// greetings all flow from these.
const DATETIMES = [
    '20260502143000', // release day (canonical corpus default)
    '19691231235959', // one second before epoch
    '19700101000000', // epoch
    '20260213090000', // Friday 13th (luck penalty)
    '20240229234321', // leap day
    '20380119031407', // int32 time_t max
    '20260814235959', // Friday? no — ordinary night edge
];

// Deterministic move patterns. Safe keys only: no quit/save/wizard.
function walkabout(i) {
    const dirs = 'hjklyubn';
    const out = [];
    for (let k = 0; k < 120; k++) {
        out.push(dirs[(i * 3 + k * 5) % 8]);
        if (k % 7 === 6) out.push('s');
        if (k % 11 === 10) out.push('.');
    }
    return out.join('');
}
function descent(i) {
    const dirs = 'jklhyubn';
    const out = [];
    for (let k = 0; k < 140; k++) {
        out.push(dirs[(i + k * 3) % 8]);
        if (k % 9 === 8) out.push('>');
        if (k % 13 === 12) out.push('s');
    }
    return out.join('');
}
function itemuser(i) {
    const dirs = 'hlkjybn u';
    const out = [];
    for (let k = 0; k < 110; k++) {
        out.push(dirs[(i * 7 + k) % 9]);
        if (k % 10 === 5) out.push('i');
        if (k % 14 === 9) out.push(',');
        if (k % 17 === 16) out.push(':');
    }
    return out.join('');
}
const PATTERNS = [walkabout, descent, itemuser];
const PATTERN_NAMES = ['walk', 'descend', 'items'];

function recipes() {
    const out = [];
    let i = 0;
    for (const [role, aligns, extraRaces] of ROLES) {
        const align = aligns[i % aligns.length];
        const race = i % 2 === 0 || !extraRaces.length
            ? 'human'
            : extraRaces[(i >> 1) % extraRaces.length];
        const gender = i % 2 ? 'female' : 'male';
        const pat = i % PATTERNS.length;
        out.push({
            slug: `gen${9000 + i}-${role.toLowerCase()}-${race}-${PATTERN_NAMES[pat]}`,
            seed: 9000 + i * 37,
            datetime: DATETIMES[0],
            nethackrc: `OPTIONS=name:${NAMES[i % NAMES.length]},role:${role},race:${race},gender:${gender},align:${align}\nOPTIONS=!autopickup,suppress_alert:3.4.3,symset:DECgraphics\n`,
            moves: PATTERNS[pat](i),
        });
        i++;
    }
    // Datetime sweep: same character, hostile clocks.
    for (let d = 1; d < DATETIMES.length; d++) {
        out.push({
            slug: `gen9100-dt${DATETIMES[d]}`,
            seed: 9100,
            datetime: DATETIMES[d],
            nethackrc: `OPTIONS=name:Chronos,role:Priest,race:human,gender:female,align:lawful\nOPTIONS=!autopickup,suppress_alert:3.4.3,symset:DECgraphics\n`,
            moves: walkabout(3),
        });
    }
    return out;
}

function recordOne(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const c = spawn(process.execPath, [RECORD, inputPath, outputPath],
            { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        c.stderr.on('data', (b) => { err += b; });
        c.on('close', (code) => code === 0 ? resolve() : reject(new Error(err.trim())));
    });
}

async function main() {
    const argv = process.argv.slice(2);
    const outDir = argv.includes('--out')
        ? argv[argv.indexOf('--out') + 1]
        : path.join(ROOT, 'sessions-extra');
    const only = argv.includes('--only') ? Number(argv[argv.indexOf('--only') + 1]) : Infinity;
    await fs.mkdir(outDir, { recursive: true });

    const tmpDir = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'nh-gen-'));
    let done = 0;
    try {
        for (const r of recipes().slice(0, only)) {
            const inputPath = path.join(tmpDir, 'in.json');
            const outputPath = path.join(outDir, `${r.slug}.session.json`);
            await fs.writeFile(inputPath, JSON.stringify({
                version: 5,
                segments: [{
                    seed: r.seed, datetime: r.datetime,
                    nethackrc: r.nethackrc, moves: r.moves,
                }],
            }));
            process.stdout.write(`[..] ${r.slug} `);
            try {
                await recordOne(inputPath, outputPath);
                const rec = JSON.parse(await fs.readFile(outputPath, 'utf8'));
                const steps = rec.segments.reduce((n, s) => n + (s.steps || []).length, 0);
                const rng = rec.segments.reduce((n, s) =>
                    n + (s.steps || []).reduce((m, st) => m + (st.rng || []).length, 0), 0);
                console.log(`OK steps=${steps} rng=${rng}`);
                done++;
            } catch (e) {
                console.log(`FAIL: ${String(e.message).split('\n')[0]}`);
            }
        }
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    console.log(`\n=== ${done} sessions recorded to ${path.relative(ROOT, outDir)}/ ===`);
}

main().catch((e) => { console.error(e); process.exit(1); });
