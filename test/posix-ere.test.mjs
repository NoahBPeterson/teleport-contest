/**
 * Differential parity harness for js/boot/posix-ere.mjs.
 *
 * nhregex (nethack-c/recorder/sys/share/posixregex.c) compiles the user
 * patterns behind `msgtype`, `autopickup exceptions` and `menucolors` with
 * regcomp(3) (REG_EXTENDED|REG_NOSUB), and prints regerror()'s wording back
 * to the player when one is bad. js/boot/posix-ere.mjs reimplements that
 * language; this test checks it against the host's own libc:
 *
 *   1. compile a tiny C driver that reads "pattern<TAB>subject" lines and
 *      prints "<regcomp errcode><TAB>yes|no" per line;
 *   2. feed it a hand-written table of edge cases plus a deterministic fuzz
 *      over the ERE metacharacter alphabet;
 *   3. require the same error code from ereCompile(), and — for patterns
 *      that compile — the same match/no-match answer from the translated
 *      JS regexp.
 *
 * Known and accepted: TRE and JS disagree about a repetition applied to a
 * group whose entire body is an anchor ("a($)*"). POSIX leaves anchors
 * inside a subexpression undefined; see the module header.
 *
 * Skipped (not failed) when no C compiler is available.
 *
 * Run from repo root: node test/posix-ere.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { ereCompile } = await import(path.join(HERE, '..', 'js', 'boot', 'posix-ere.mjs'));

const DRIVER = `
#include <stdio.h>
#include <string.h>
#include <regex.h>

int main(void) {
    char line[8192];
    while (fgets(line, sizeof line, stdin)) {
        size_t n = strlen(line);
        while (n && (line[n-1] == '\\n' || line[n-1] == '\\r')) line[--n] = '\\0';
        char *sep = strchr(line, '\\t');
        char *subj = NULL;
        if (sep) { *sep = '\\0'; subj = sep + 1; }
        regex_t re;
        int err = regcomp(&re, line, REG_EXTENDED | REG_NOSUB);
        if (err) { printf("%d\\t-\\n", err); continue; }
        int r = subj ? regexec(&re, subj, 0, NULL, 0) : -1;
        printf("0\\t%s\\n", subj ? (r ? "no" : "yes") : "-");
        regfree(&re);
    }
    return 0;
}
`;

// The one shape whose libc behaviour js/boot/posix-ere.mjs deliberately
// does not reproduce: a repetition applied to a group whose entire body is
// an anchor. See the module header.
const knownDivergent = (src) => /\([$^]+\)[*?{]/.test(src);

const PATTERNS = [
    // the shapes real config files use
    '', 'a', '.*', '^You feel', 'You feel.*', '.*hits.*', 'You hear.*',
    '<.*dagger.*', '>.*rock.*', '.*gold piece.*', '.*cursed.*', '.*blessed.*',
    'a|b|c', '(a|b)c', '[0-9]{1,3}', 'foo$', '^$', '^a$', 'a.c', '[^abc]',
    'a?b+c*', 'a{2,3}', '(ab)+',
    // repetition operators with no operand
    '*bad*', '+x', '?x', 'a**', 'a++', 'a*+', 'a**b', '{2}', '*', '**', '+',
    '?', '^*', '$*', '^+', '^?', '^{2}', 'a|^*', '(*a)', 'x{2}{3}',
    // parentheses
    '(', ')', 'a)', '(a', '((a)', '()', '()*', 'a()', '((((a))))', '(a)(b',
    '(a)*', '(a)+*', '^(a)$', '(a){2}', '\\(a\\)', 'a\\)b',
    // empty (sub)expressions
    '|a', 'a|', '(|a)', '(a|)', '(a|b)|c', '((a|b))', '(|)', '(()|a)',
    // bounds
    'a{', 'a{2', 'a{3,2}', 'a{,}', 'a{}', 'a{2,1}', 'a{255}', 'a{256}',
    'a{0,255}', 'a{0,256}', 'a{1000000}', 'a{1,}', 'a{,3}', 'a{01}', 'a{0}',
    '{', '}', 'a{1,', '{9*', '{1\\', '{1^', '.{3}', '\\{2\\}',
    // brackets
    '[abc', '[]', '[z-a]', 'x[', '[^', '[a-]', '[-a]', '[a-b-c]', '[[.x.]]',
    '[[=a=]]', '[a[:alpha:]b]', '[\\]', '[\\]]', '[]a]', '[^]a]', '[]]',
    '[a-b-]', '[-]', '[--]', '[]-a]', '[^-a]', '[a-c-e]', '[[:alpha:]-z]',
    '[z-[:alpha:]]', '[\\-a]', '[a\\-z]', '[.-/]', '[!-/]', '[^]', '[^]]',
    '[[:alpha:][:digit:]]', '[^[:digit:]]', 'a[a-[', '[*[:1{)',
    // character classes
    '[[:alpha:]]+', '[[:digit:]]', '[[:space:]]', '[[:punct:]]', '[[:upper:]]',
    '[[:alnum:]]', '[[:lower:]]', '[[:blank:]]', '[[:print:]]', '[[:graph:]]',
    '[[:cntrl:]]', '[[:xdigit:]]', '[[:foo:]]', '[[:alpha:]',
    // backslash: POSIX ERE has no \\d / \\w / \\b, they are literal letters
    '\\', 'a\\', '\\d', '\\w', '\\s', '\\b', '\\n', 'a\\.b', 'x\\|y', '\\[a',
];
const SUBJECTS = [
    '5', 'd', 'a', 'w', ' ', 's', 'n', 'b', 'a.b', 'axb', 'abc', '7', '!',
    'A', 'z', ']', 'You feel hot', 'It hits!', 'x|y', 'xy', 'a{2}',
    'a cursed dagger', 'a blessed rock', '12 gold pieces', 'aaa', 'abab', '',
];

const cases = [];
for (const p of PATTERNS) for (const s of SUBJECTS) cases.push([p, s]);

// Deterministic fuzz over the metacharacter alphabet.
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const ALPHA = 'ab19.*+?()[]{}|^$\\-:,';
for (let k = 0; k < 20000; k++) {
    const len = 1 + Math.floor(rnd() * 8);
    let p = '';
    for (let q = 0; q < len; q++) p += ALPHA[Math.floor(rnd() * ALPHA.length)];
    cases.push([p, 'ab19 xyz']);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ere-test-'));
const csrc = path.join(tmp, 'driver.c');
const cbin = path.join(tmp, 'driver');
fs.writeFileSync(csrc, DRIVER);
try {
    execFileSync('cc', ['-O0', '-o', cbin, csrc], { stdio: 'pipe' });
} catch (e) {
    console.log('SKIP posix-ere.test.mjs: no working C compiler');
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
}

const input = cases.map(([p, s]) => `${p}\t${s}`).join('\n') + '\n';
const out = execFileSync(cbin, { input, maxBuffer: 64 << 20 })
    .toString().trimEnd().split('\n');
fs.rmSync(tmp, { recursive: true, force: true });

if (out.length !== cases.length) {
    console.log(`FAIL: driver produced ${out.length} lines for ${cases.length} cases`);
    process.exit(1);
}

let bad = 0, known = 0;
for (let i = 0; i < cases.length; i++) {
    const [pat, subj] = cases[i];
    const [cErrStr, cMatch] = out[i].split('\t');
    const cErr = Number(cErrStr);
    const r = ereCompile(pat);
    const jsErr = r.err || 0;
    if (jsErr !== cErr) {
        if (bad < 20) console.log(`  code  ${JSON.stringify(pat)}: libc=${cErr} js=${jsErr}`);
        bad++;
        continue;
    }
    if (cErr) continue;
    let jsMatch;
    try { jsMatch = new RegExp(r.src, 's').test(subj) ? 'yes' : 'no'; }
    catch (e) { jsMatch = 'threw ' + e.message; }
    if (jsMatch !== cMatch) {
        if (knownDivergent(r.src)) { known++; continue; }
        if (bad < 20) {
            console.log(`  match ${JSON.stringify(pat)} vs ${JSON.stringify(subj)}: `
                + `libc=${cMatch} js=${jsMatch} (src=${JSON.stringify(r.src)})`);
        }
        bad++;
    }
}

console.log(bad === 0
    ? `posix-ere: OK — ${cases.length} differential cases match libc`
      + (known ? ` (${known} known-divergent skipped)` : '')
    : `posix-ere: FAIL — ${bad}/${cases.length} disagree with libc`);
process.exit(bad ? 1 : 0);
