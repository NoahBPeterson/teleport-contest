// probe-disco.mjs — run boot in-process, then dump discovery state
import { runBootGame } from '../js/boot/harness.mjs';
import * as cptr from '../js/cptr.js';

const r = await runBootGame({
  seed: 8000, datetime: '20260401090000',
  nethackrc: "OPTIONS=name:Contestant,role:Tourist,race:human,gender:female,align:neutral\nOPTIONS=!autopickup,!legacy,!tutorial,!splash_screen,pettype:none\nOPTIONS=pushweapon,showexp,time,color,suppress_alert:3.3.1\nOPTIONS=symset:DECgraphics\n",
  moves: '  ',
});
console.log('exit:', r.exitCode, 'err:', r.error && String(r.error).slice(0, 120));
const { objects, obj_descr } = await import('../js/generated/objects.js');
const descrName = (di) => cptr.cstr(cptr.ldPtr(cptr.add(obj_descr, di, 16)));
// objclass layout: name_idx@0 descr_idx@2 uname@8 name_known@16 merge@20
// uses_known@24 encountered@28 magic@32
for (let otyp = 1; otyp < 400; otyp++) {
  const base = cptr.add(objects, otyp * 120);
  const di = cptr.ldI16(cptr.add(base, 2));
  const nm = di > 0 && di < 482 ? descrName(di) : '';
  if (nm === 'magic mapping' || nm === 'extra healing') {
    console.log('otyp', otyp, nm, '| name_known:', cptr.ldI32(cptr.add(base, 16)), 'uses_known:', cptr.ldI32(cptr.add(base, 24)), 'encountered:', cptr.ldI32(cptr.add(base, 28)));
  }
}
const decl = await import('../js/generated/decl.js');
const disco = [];
for (let i = 0; i < 60; i++) { const v = cptr.ldI16(cptr.add(cptr.add(decl.svd, 1940), i, 2)); if (v) disco.push(v); }
console.log('disco[]:', JSON.stringify(disco));
// walk gi.invent (field at gi+8)
const inv0 = cptr.ldPtr(cptr.add(decl.gi, 8));
console.log('gi.invent head:', inv0 !== null);
for (let o = inv0, n = 0; o && n < 25; o = cptr.ldPtr(o), n++) {
  const otyp = cptr.ldI16(cptr.add(o, 32));
  const base = cptr.add(objects, otyp * 120);
  const di = cptr.ldI16(cptr.add(base, 2));
  console.log('  otyp', otyp, descrName(di), 'known:', cptr.ldI32(cptr.add(o, 80)));
}
