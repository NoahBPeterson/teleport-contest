#!/usr/bin/env node
// swarm/run.mjs — DeepSeek swarm task driver.
//
// Runs one work packet through deepseek-v4-flash, writes the returned
// files into a staging area for review, and tracks cumulative token
// usage per task. Circuit breaker (see tools/c2js/DESIGN.md "Swarm
// policy"): any task that exceeds 5,000,000 cumulative tokens is
// stopped and Noah is notified WITH SOUND for escalation.
//
// Usage:
//   node tools/swarm/run.mjs <packet.md> [--effort low|high|max]
//                          [--apply] [--out .cache/swarm]
//
// Packet format (markdown):
//   ---
//   task: libc-strlen-family
//   effort: low                # optional; CLI --effort overrides
//   ---
//   <prompt body — what to build, conventions, acceptance>
// The model is instructed to return files as fenced code blocks whose
// info string is the target path, e.g. ```js/libc/string.js
//
// Without --apply, files go to <out>/<task>/staging/ for review.
// With --apply they land in the repo (review first!).

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TOKEN_LIMIT = 5_000_000;

const SYSTEM = `You are a code generator for a NetHack C-to-JavaScript transpilation project.
Rules:
- Output files as fenced code blocks. The info string is the language (e.g. \`\`\`javascript) and the FIRST LINE inside each block MUST be a path comment: // file: js/libc/string.js
- One file per block; no prose between blocks.
- Plain ES6 JavaScript, no dependencies, no TypeScript syntax, no build step.
- Heavy JSDoc types on every function (@param/@returns with project typedefs CInt/CUInt/CDouble where applicable).
- Match C semantics exactly (32-bit wraparound, truncation-toward-zero division, byte-oriented strings).
- Every function carries a "// C ref:" comment naming the source function.
- No commentary outside code blocks except a short summary list of files at the end.`;

function getApiKey() {
    if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
    // The key lives in ~/.zshenv; our bash sessions don't source it.
    const r = spawnSync('zsh', ['-c', 'printf %s "$DEEPSEEK_API_KEY"'], { encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout) throw new Error('DEEPSEEK_API_KEY not found in env or ~/.zshenv');
    return r.stdout;
}

async function callDeepSeek(apiKey, { model, effort, system, user }) {
    const body = {
        model,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        thinking: { type: 'enabled' },
        // max_tokens deliberately unset (provider default) — see DESIGN.md
    };
    if (effort) body.reasoning_effort = effort;
    const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`deepseek API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
}

function parseFiles(text) {
    // ```javascript\n// file: path/to/file\n<contents>```
    // Also tolerate the info string being the path itself (```js/libc/x.js).
    const files = [];
    const re = /```([^\n`]*)\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text))) {
        const info = m[1].trim();
        let body = m[2];
        let target = null;
        const fileLine = body.match(/^\s*\/\/\s*file:\s*(\S+)\s*\n/);
        if (fileLine) {
            target = fileLine[1];
            body = body.slice(fileLine[0].length);
        } else if (info.includes('/')) {
            target = info;
        }
        if (!target || target.includes('..') || target.startsWith('/')) continue;
        files.push({ target, content: body });
    }
    return files;
}

function soundAlert() {
    try { spawnSync('afplay', ['/System/Library/Sounds/Glass.aiff']); } catch {}
}

async function main() {
    const argv = process.argv.slice(2);
    const packetPath = argv[0];
    if (!packetPath) {
        console.error('Usage: node tools/swarm/run.mjs <packet.md> [--effort E] [--apply] [--out DIR]');
        process.exit(2);
    }
    const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
    const apply = argv.includes('--apply');
    const outBase = opt('--out') || path.join(ROOT, '.cache', 'swarm');

    const raw = await fs.readFile(packetPath, 'utf8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const meta = {};
    if (fm) {
        for (const line of fm[1].split('\n')) {
            const kv = line.match(/^(\w+):\s*(.+)$/);
            if (kv) meta[kv[1]] = kv[2].trim();
        }
    }
    const task = meta.task || path.basename(packetPath, '.md');
    const effort = opt('--effort') || meta.effort || null; // null = provider default (high)
    const prompt = fm ? fm[2] : raw;

    const usagePath = path.join(outBase, 'usage.json');
    let usage = {};
    try { usage = JSON.parse(await fs.readFile(usagePath, 'utf8')); } catch {}
    const prior = usage[task]?.total || 0;
    if (prior > TOKEN_LIMIT) {
        console.error(`CIRCUIT BREAKER: task "${task}" already at ${prior} tokens (> ${TOKEN_LIMIT}). Escalate to a smarter model.`);
        soundAlert();
        process.exit(3);
    }

    console.log(`[swarm] task=${task} effort=${effort ?? 'default(high)'} apply=${apply} priorTokens=${prior}`);
    const apiKey = getApiKey();
    const res = await callDeepSeek(apiKey, {
        model: 'deepseek-v4-flash', effort, system: SYSTEM, user: prompt,
    });

    const u = res.usage || {};
    const total = prior + (u.total_tokens || 0);
    usage[task] = { total, last: u, updated: new Date().toISOString() };
    await fs.mkdir(outBase, { recursive: true });
    await fs.writeFile(usagePath, JSON.stringify(usage, null, 2));
    console.log(`[swarm] usage this call: prompt=${u.prompt_tokens} completion=${u.completion_tokens} (reasoning=${u.completion_tokens_details?.reasoning_tokens ?? '?'}) cumulative=${total}`);

    if (total > TOKEN_LIMIT) {
        console.error(`CIRCUIT BREAKER: task "${task}" exceeded ${TOKEN_LIMIT} cumulative tokens. Escalate.`);
        soundAlert();
    }

    const content = res.choices?.[0]?.message?.content || '';
    if (!content) {
        console.error('[swarm] EMPTY response (finish_reason:', res.choices?.[0]?.finish_reason, ')');
        process.exit(1);
    }
    const files = parseFiles(content);
    if (!files.length) {
        console.error('[swarm] no file blocks found in response; dumping raw to staging');
    }
    const staging = path.join(outBase, task, 'staging');
    for (const f of files) {
        const dest = apply ? path.join(ROOT, f.target) : path.join(staging, f.target);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, f.content);
        console.log(`[swarm] wrote ${apply ? '' : 'staging/'}${f.target} (${f.content.length} chars)`);
    }
    const rawPath = path.join(outBase, task, 'last-response.md');
    await fs.mkdir(path.dirname(rawPath), { recursive: true });
    await fs.writeFile(rawPath, content);
    console.log(`[swarm] raw response: ${path.relative(ROOT, rawPath)}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
