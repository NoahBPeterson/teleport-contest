// Does forking the module graph per segment RE-PARSE the 13.2 MB, or does
// V8's compilation cache make graphs 2..N cheap?
const REPO='/Users/noahpeterson/Documents/Projects/teleport-contest-research/hotfix-realm/';
const { enableSegmentIsolation, segmentSpecifier } = await import(REPO+'js/boot/isolation.mjs');
const isolated = await enableSegmentIsolation();
console.log('isolated =', isolated);
for (let n = 1; n <= 4; n++) {
  const t0 = performance.now();
  await import(segmentSpecifier(REPO+'js/boot/harness.mjs', n, isolated));
  const t1 = performance.now();
  await import(REPO + 'js/generated/unixmain.js' + (isolated ? `?c2jsseg=${n}` : ''));
  const t2 = performance.now();
  console.log(`graph ${n}: harness ${(t1-t0).toFixed(1)} ms   generated(176 modules) ${(t2-t1).toFixed(1)} ms   heapUsed ${(process.memoryUsage().heapUsed/1048576).toFixed(0)} MB`);
}
