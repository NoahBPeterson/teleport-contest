// spacescan.mjs — scan recorded session screens for literal runs of >=N spaces.
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const N = Number(process.argv[3] || 5);
let files = fs.readdirSync(dir).filter((f) => f.endsWith('.session.json'));
let hits = 0, tot = 0;
const re = new RegExp(` {${N},}`);
for (const f of files) {
  const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const seg of s.segments || []) for (const st of seg.steps || []) {
    if (!st.screen) continue;
    for (const line of st.screen.split('\n')) {
      tot++;
      if (re.test(line)) { hits++; if (hits < 6) console.log(f, JSON.stringify(line).slice(0, 160)); }
    }
  }
}
console.log(`lines=${tot} withRunOf${N}Spaces=${hits}`);
