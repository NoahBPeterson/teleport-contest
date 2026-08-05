// summarize.mjs — parse __RESULTS_JSON__ from a ps_test_runner log.
import fs from 'node:fs';
const txt = fs.readFileSync(process.argv[2], 'utf8');
const idx = txt.indexOf('__RESULTS_JSON__');
const j = JSON.parse(txt.slice(idx + 16).trim());
let pass = 0, sm = 0, st = 0;
for (const r of j.results) {
  const s = r.metrics.screens, rn = r.metrics.rngCalls;
  if (r.passed) pass++;
  sm += s.matched; st += s.total;
  console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.session.replace('.session.json', '').padEnd(52)} screens ${s.matched}/${s.total}  rng ${rn.matched}/${rn.total}`);
}
console.log(`TOTAL passing=${pass}/${j.results.length} screens=${sm}/${st}`);
