// emit.mjs — clang-AST→JS emitter, v0 (rnd.c scope).
//
// Type-directed emission per tools/c2js/DESIGN.md and js/cmachine.js:
//   int/char/short (signed)  -> number, | 0 / Math.imul / (a / b) | 0
//   unsigned 32-bit          -> number, >>> 0 / u32div / u32mod
//   long / long long (LP64)  -> BigInt, native BigInt ops
//   pointers                 -> JS references (memory model v0)
//   structs                  -> JS objects; arrays -> JS arrays / Uint8Array
//
// Only the node kinds rnd.c needs are implemented (see census). Anything
// else throws so the gap is loud, never silent.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- types ----

const INT_RE = /^(signed |unsigned )?(char|short|int|long|long long)$/;

function desugar(t) {
  return (t?.desugaredQualType || t?.qualType || '')
    .replace(/\bconst\b|\brestrict\b|\bvolatile\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse a qualType into {cls:'int',bits,signed}|{cls:'f64'}|{cls:'ptr'}|{cls:'record'}|{cls:'void'} */
export function parseType(qualType, desugared) {
  let q = (desugared || qualType || '').replace(/\bconst\b|\brestrict\b|\bvolatile\b/g, '').replace(/\s+/g, ' ').trim();
  if (q.includes('*')) return { cls: 'ptr' };
  if (/\[/.test(q)) return { cls: 'ptr' }; // array value context: decays
  if (q === 'void') return { cls: 'void' };
  if (/^(struct|union|enum)\b/.test(q)) return { cls: 'record' };
  if (/\b(double|float)\b/.test(q)) return { cls: 'f64' };
  if (/\blong\b/.test(q)) { // LP64: long and long long are both 64-bit
    return { cls: 'int', bits: 64, signed: !/\bunsigned\b/.test(q) };
  }
  if (INT_RE.test(q) || q === 'schar' || q === '_Bool' || q === 'boolean') {
    const signed = !/\bunsigned\b/.test(q);
    const bits = /\bchar\b/.test(q) || q === 'schar' || q === '_Bool' || q === 'boolean' ? 8 : /\bshort\b/.test(q) ? 16 : 32;
    return { cls: 'int', bits, signed };
  }
  // typedef'd function types like "int (int)" reach here; treat as fn value
  if (/\(/.test(q)) return { cls: 'ptr' };
  return { cls: 'record' }; // FILE and friends
}

function nodeType(n) {
  return parseType(n.type?.qualType, n.type?.desugaredQualType);
}

function sameClass(a, b) {
  return a.cls === b.cls && a.bits === b.bits && a.signed === b.signed;
}

// JS operator precedence (for minimal parenthesization)
const PREC = { comma: 1, assign: 2, cond: 3, '||': 4, '&&': 5, '|': 6, '^': 7, '&': 8, eq: 9, rel: 10, shift: 11, add: 12, mul: 13, unary: 15, postfix: 16, atom: 18 };
const BIN_PREC = { '||': 4, '&&': 5, '|': 6, '^': 7, '&': 8, '==': 9, '!=': 9, '<': 10, '>': 10, '<=': 10, '>=': 10, '<<': 11, '>>': 11, '>>>': 11, '+': 12, '-': 12, '*': 13, '/': 13, '%': 13 };

function atom(code) { return { code, prec: PREC.atom, const: undefined }; }

/** parenthesize child for use as left/right operand of an infix op */
function operand(e, parentPrec, side) {
  if (e.prec < parentPrec || (side === 'right' && e.prec === parentPrec)) return { ...e, code: `(${e.code})`, prec: PREC.atom };
  return e;
}

// ------------------------------------------------------------- emitter ----

export class Emitter {
  constructor({ decls, lineOf, source, fileName }) {
    this.decls = decls;
    this.lineOf = lineOf;
    this.fileName = fileName; // "rnd.c"
    this.records = new Map(); // struct name -> [field names]
    this.cmachine = new Set(); // cmachine.js helpers used
    this.out = [];
    this.collectRecords();
  }

  collectRecords() {
    for (const d of this.decls) {
      if (d.kind !== 'RecordDecl' || !d.name) continue;
      const fields = (d.inner || []).filter((c) => c.kind === 'FieldDecl').map((c) => c.name);
      if (fields.length) this.records.set(d.name, fields);
    }
  }

  cref(n) {
    const off = n.loc?.offset ?? n.range?.begin?.offset;
    return off !== undefined ? `${this.fileName}:${this.lineOf(off)}` : this.fileName;
  }

  // ----- type conversions -----

  /** Emit conversion of e ({code,prec,const?}) from type `from` to type `to`. */
  convert(e, from, to) {
    if (to.cls === 'void') return e;
    if (from.cls === 'ptr' || to.cls === 'ptr' || from.cls === 'record' || to.cls === 'record') return e; // v0: references pass through
    if (from.cls === 'f64' || to.cls === 'f64') throw new Error(`float conversion unsupported (v0): ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
    // both integer classes now
    if (sameClass(from, to)) return e;
    // constant folding for literal conversions
    if (e.const !== undefined && /^-?\d+$/.test(e.const)) {
      let v = BigInt(e.const);
      v = to.signed ? BigInt.asIntN(to.bits, v) : BigInt.asUintN(to.bits, v);
      if (to.bits === 64) return { code: `${v}n`, prec: PREC.atom, const: String(v) };
      return { code: String(Number(v)), prec: Number(v) < 0 ? PREC.unary : PREC.atom, const: String(Number(v)) };
    }
    if (to.bits === 64) {
      if (from.bits === 64) return { code: `BigInt.as${to.signed ? 'Int' : 'Uint'}N(64, ${this.group(e, PREC.atom)})`, prec: PREC.atom };
      return { code: from.signed ? `BigInt(${this.group(e, PREC.atom)})` : `BigInt(${this.group(e, PREC.atom)} >>> 0)`, prec: PREC.atom };
    }
    if (from.bits === 64) {
      return { code: `Number(BigInt.as${to.signed ? 'Int' : 'Uint'}N(${to.bits}, ${this.group(e, PREC.atom)}))`, prec: PREC.atom };
    }
    // 8..32 -> 8..32
    if (to.bits === 32 && from.bits === 32) {
      return { code: `${this.group(e, PREC.postfix)} ${to.signed ? '| 0' : '>>> 0'}`, prec: to.signed ? PREC['|'] : PREC.shift };
    }
    if (to.bits < from.bits || (to.bits === from.bits && !to.signed) || to.bits < 32) {
      const helper = to.signed ? { 8: 'schar', 16: 'i16', 32: null }[to.bits] : { 8: 'uchar', 16: 'u16', 32: 'u32' }[to.bits];
      if (helper) {
        this.cmachine.add(helper);
        return { code: `${helper}(${this.group(e, PREC.atom)})`, prec: PREC.atom };
      }
    }
    return e; // widening: value-preserving, no coercion needed
  }

  /** wrap code so it binds as an operand of the given precedence context */
  group(e, ctxPrec) {
    return e.prec < ctxPrec ? `(${e.code})` : e.code;
  }

  to64(e) {
    const t = e._type || { cls: 'int', bits: 32, signed: true };
    return this.convert(e, t, { cls: 'int', bits: 64, signed: t.signed });
  }

  // ----- expressions -----

  emitExpr(n) {
    if (!n || !n.kind) throw new Error('emitExpr: empty node');
    const fn = this['expr_' + n.kind];
    if (!fn) throw new Error(`emitExpr: unsupported node kind ${n.kind} (${this.cref(n)})`);
    return fn.call(this, n);
  }

  expr_IntegerLiteral(n) {
    const t = nodeType(n);
    if (t.cls === 'int' && t.bits === 64) return { code: `${n.value}n`, prec: PREC.atom, const: n.value, _type: t };
    return { code: n.value, prec: n.value.startsWith('-') ? PREC.unary : PREC.atom, const: n.value, _type: t };
  }

  expr_CharacterLiteral(n) {
    return { code: String(n.value), prec: PREC.atom, const: String(n.value), _type: nodeType(n) };
  }

  expr_StringLiteral(n) {
    return { code: n.value, prec: PREC.atom, _type: { cls: 'ptr' } }; // value includes C quotes; valid JS for these literals
  }

  expr_ParenExpr(n) {
    const inner = this.emitExpr(n.inner[0]);
    return { ...inner, code: `(${inner.code})`, prec: PREC.atom };
  }

  expr_ConstantExpr(n) {
    const inner = this.emitExpr(n.inner[0]);
    return { ...inner, const: n.value ?? inner.const };
  }

  expr_DeclRefExpr(n) {
    return { code: n.name || n.referencedDecl?.name, prec: PREC.atom, _type: nodeType(n) };
  }

  expr_MemberExpr(n) {
    const base = this.emitExpr(n.inner[0]);
    return { code: `${this.group(base, PREC.atom)}.${n.name}`, prec: PREC.atom, _type: nodeType(n) };
  }

  expr_ArraySubscriptExpr(n) {
    const base = this.emitExpr(n.inner[0]);
    const idx = this.emitExpr(n.inner[1]);
    return { code: `${this.group(base, PREC.atom)}[${idx.code}]`, prec: PREC.atom, _type: nodeType(n) };
  }

  expr_ImplicitCastExpr(n) {
    const inner = this.emitExpr(n.inner[0]);
    switch (n.castKind) {
      case 'LValueToRValue':
      case 'NoOp':
      case 'FunctionToPointerDecay':
      case 'BuiltinFnToFnPtr':
      case 'ArrayToPointerDecay':
      case 'IntegralToBoolean':
      case 'BitCast': // pointer<->pointer in rnd.c
        return { ...inner, _type: nodeType(n) };
      case 'IntegralCast':
      case 'IntegralConversion':
        return { ...this.convert(inner, nodeType(n.inner[0]), nodeType(n)), _type: nodeType(n) };
      case 'NullToPointer':
        return { code: 'null', prec: PREC.atom, const: '0', _type: { cls: 'ptr' } };
      default:
        throw new Error(`unsupported implicit cast ${n.castKind} (${this.cref(n)})`);
    }
  }

  expr_CStyleCastExpr(n) {
    // NetHack SIZE(x) idiom: (int)(sizeof(arr) / sizeof(arr[0])) -> arr.length
    const sizeIdiom = this.matchSizeIdiom(n);
    if (sizeIdiom) return { code: sizeIdiom, prec: PREC.atom, _type: nodeType(n) };
    const inner = this.emitExpr(n.inner[0]);
    if (n.castKind === 'NullToPointer') return { code: 'null', prec: PREC.atom, const: '0', _type: { cls: 'ptr' } };
    if (n.castKind === 'ToVoid') return { code: `void ${this.group(inner, PREC.unary)}`, prec: PREC.unary };
    return { ...this.convert(inner, nodeType(n.inner[0]), nodeType(n)), _type: nodeType(n) };
  }

  matchSizeIdiom(n) {
    // unwrap this cast down to a BinaryOperator '/' of two sizeofs
    let cur = n;
    while (cur.kind === 'CStyleCastExpr' || cur.kind === 'ImplicitCastExpr' || cur.kind === 'ParenExpr') {
      if (cur.kind === 'ParenExpr') { cur = cur.inner[0]; continue; }
      if (cur.castKind === 'IntegralCast' || cur.castKind === 'NoOp') { cur = cur.inner[0]; continue; }
      return null;
    }
    if (cur.kind !== 'BinaryOperator' || cur.opcode !== '/') return null;
    const [l, r] = cur.inner;
    if (l.kind !== 'UnaryExprOrTypeTraitExpr' || r.kind !== 'UnaryExprOrTypeTraitExpr') return null;
    const arrRef = this.sizeofArrayRef(l); // T[N]
    const eltRef = this.sizeofArrayRef(r, true); // T via arr[0]
    if (arrRef && eltRef && arrRef === eltRef) return `${arrRef}.length`;
    return null;
  }

  sizeofArrayRef(uett, viaSubscript = false) {
    let arg = uett.inner?.[0];
    while (arg && arg.kind === 'ParenExpr') arg = arg.inner[0];
    if (!arg) return null;
    if (viaSubscript) {
      if (arg.kind !== 'ArraySubscriptExpr') return null;
      let base = arg.inner[0];
      while (base.kind === 'ImplicitCastExpr') base = base.inner[0];
      if (base.kind !== 'DeclRefExpr') return null;
      return base.name || base.referencedDecl?.name;
    }
    if (arg.kind !== 'DeclRefExpr' || !/\[\d+\]/.test(arg.type?.qualType || '')) return null;
    return arg.name || arg.referencedDecl?.name;
  }

  expr_UnaryExprOrTypeTraitExpr(n) {
    // sizeof (expr form; rnd.c has no type-form sizeof outside the SIZE idiom)
    let arg = n.inner?.[0];
    while (arg && arg.kind === 'ParenExpr') arg = arg.inner[0];
    const q = desugar(arg?.type);
    const size = this.sizeofType(q);
    const t = nodeType(n); // size_t == unsigned long -> 64-bit class
    const code = t.bits === 64 ? `${size}n` : String(size);
    return { code, prec: PREC.atom, const: String(size), _type: t };
  }

  sizeofType(q) {
    const m = q.match(/^(.*)\[(\d+)\]$/);
    if (m) return Number(m[2]) * this.sizeofType(m[1]);
    if (q.includes('*')) return 8;
    if (/\blong\b/.test(q) || q === 'size_t') return 8;
    if (/\bint\b/.test(q)) return 4;
    if (/\bshort\b/.test(q)) return 2;
    if (/\bchar\b/.test(q) || q === 'boolean' || q === 'schar') return 1;
    throw new Error(`sizeof: unsupported type "${q}" (v0 — record layout not implemented)`);
  }

  expr_UnaryOperator(n) {
    const [sub] = n.inner;
    const e = this.emitExpr(sub);
    const t = nodeType(n);
    switch (n.opcode) {
      case '++': case '--':
        return { code: n.isPostfix ? `${this.group(e, PREC.postfix)}${n.opcode}` : `${n.opcode}${this.group(e, PREC.unary)}`, prec: n.isPostfix ? PREC.postfix : PREC.unary, _type: t };
      case '-': case '!': case '~':
        return { code: `${n.opcode}${this.group(e, PREC.unary)}`, prec: PREC.unary, _type: t };
      case '&': // memory model v0: objects are references; &field == the object
        return { ...e, _type: { cls: 'ptr' } };
      case '*': { // rnd.c only dereferences char* (first byte of a string)
        const pointee = desugar(sub.type).replace(/\s*\*$/, '').trim();
        if (/\bchar\b/.test(pointee)) return { code: `(${this.group(e, PREC.atom)}.charCodeAt(0) || 0)`, prec: PREC.atom, _type: t };
        throw new Error(`deref of ${pointee}* unsupported (v0) (${this.cref(n)})`);
      }
      default:
        throw new Error(`unsupported unary op ${n.opcode} (${this.cref(n)})`);
    }
  }

  expr_BinaryOperator(n) {
    const op = n.opcode;
    const t = nodeType(n);
    const l0 = this.emitExpr(n.inner[0]);
    const r0 = this.emitExpr(n.inner[1]);

    if (op === '=') {
      return { code: `${this.group(l0, PREC.unary)} = ${operand(r0, PREC.assign, 'right').code}`, prec: PREC.assign, _type: t };
    }
    if (op === '&&' || op === '||') {
      const p = BIN_PREC[op];
      return { code: `${operand(l0, p, 'left').code} ${op} ${operand(r0, p, 'right').code}`, prec: p, _type: t };
    }
    // comparisons: pointer operands get strict equality
    if (['==', '!=', '<', '>', '<=', '>='].includes(op)) {
      const p = op === '==' || op === '!=' ? PREC.eq : PREC.rel;
      let jsop = op;
      if ((op === '==' || op === '!=') && (nodeType(n.inner[0]).cls === 'ptr' || nodeType(n.inner[1]).cls === 'ptr')) {
        jsop = op === '==' ? '===' : '!==';
      }
      return { code: `${operand(l0, p, 'left').code} ${jsop} ${operand(r0, p, 'right').code}`, prec: p, _type: t };
    }
    const p = BIN_PREC[op];
    if (!p) throw new Error(`unsupported binary op ${op} (${this.cref(n)})`);
    // shifts with a 64-bit left side need a BigInt shift count
    let r = r0;
    if ((op === '<<' || op === '>>') && t.cls === 'int' && t.bits === 64) r = this.to64(r0);
    const raw = `${operand(l0, p, 'left').code} ${op} ${operand(r, p, 'right').code}`;
    return this.coerceArith(raw, p, op, t, l0, r0);
  }

  /** apply the DESIGN.md arithmetic coercions for a binary op with C type t */
  coerceArith(raw, p, op, t, l, r) {
    if (t.cls !== 'int') return { code: raw, prec: p, _type: t };
    if (t.bits === 64) return { code: raw, prec: p, _type: t }; // BigInt ops are exact (C div/mod truncate like BigInt)
    if (['<<', '>>', '&', '|', '^', '%'].includes(op)) {
      if (t.signed) return { code: raw, prec: p, _type: t };
      // unsigned 32-bit: logical shift right / keep in u32 range
      if (op === '>>') return { code: `${operand(l, PREC.shift, 'left').code} >>> ${operand(r, PREC.shift, 'right').code}`, prec: PREC.shift, _type: t };
      if (op === '%') { this.cmachine.add('u32mod'); return { code: `u32mod(${l.code}, ${r.code})`, prec: PREC.atom, _type: t }; }
      return { code: `(${raw}) >>> 0`, prec: PREC.shift, _type: t };
    }
    if (op === '+') return t.signed ? this.wrapI32(raw) : { code: `(${raw}) >>> 0`, prec: PREC.shift, _type: t };
    if (op === '-') return t.signed ? this.wrapI32(raw) : { code: `(${raw}) >>> 0`, prec: PREC.shift, _type: t };
    if (op === '*') return t.signed ? { code: `Math.imul(${l.code}, ${r.code})`, prec: PREC.atom, _type: t } : { code: `Math.imul(${l.code}, ${r.code}) >>> 0`, prec: PREC.shift, _type: t };
    if (op === '/') {
      if (t.signed) return { code: `${p >= PREC['|'] ? `(${raw})` : raw} | 0`, prec: PREC['|'], _type: t };
      this.cmachine.add('u32div');
      return { code: `u32div(${l.code}, ${r.code})`, prec: PREC.atom, _type: t };
    }
    return { code: raw, prec: p, _type: t };
  }

  wrapI32(raw) {
    return { code: `(${raw}) | 0`, prec: PREC['|'], _type: { cls: 'int', bits: 32, signed: true } };
  }

  expr_CompoundAssignOperator(n) {
    const t = nodeType(n); // computation type
    const l = this.emitExpr(n.inner[0]);
    const r0 = this.emitExpr(n.inner[1]);
    const op = n.opcode; // += -= *= /= %= >>= <<= &= |= ^=
    const base = op.slice(0, -1);
    if (t.cls === 'int' && t.bits === 64) {
      const r = this.convert(r0, nodeType(n.inner[1]), t); // e.g. BigInt(rn2(1000)), literal -> 8n
      return { code: `${l.code} ${op} ${operand(r, PREC.assign, 'right').code}`, prec: PREC.assign, _type: t };
    }
    if (t.cls === 'int' && t.bits === 32) {
      const r = operand(r0, PREC.add, 'right');
      if (base === '+') return { code: `${l.code} = (${l.code} + ${r.code}) | 0`, prec: PREC.assign, _type: t };
      if (base === '-') return { code: `${l.code} = (${l.code} - ${r.code}) | 0`, prec: PREC.assign, _type: t };
      if (base === '*') return { code: `${l.code} = Math.imul(${l.code}, ${r0.code})`, prec: PREC.assign, _type: t };
      if (base === '/') return { code: `${l.code} = (${l.code} / ${r.code}) | 0`, prec: PREC.assign, _type: t };
      // %= &= |= ^= <<= >>= : native compound assignment is exact for i32
      return { code: `${l.code} ${op} ${operand(r0, PREC.assign, 'right').code}`, prec: PREC.assign, _type: t };
    }
    throw new Error(`compound assign ${op} on ${JSON.stringify(t)} unsupported (${this.cref(n)})`);
  }

  expr_ConditionalOperator(n) {
    const c = this.emitExpr(n.inner[0]);
    const a = this.emitExpr(n.inner[1]);
    const b = this.emitExpr(n.inner[2]);
    return { code: `${operand(c, PREC.cond, 'left').code} ? ${a.code} : ${operand(b, PREC.cond, 'right').code}`, prec: PREC.cond, _type: nodeType(n) };
  }

  expr_InitListExpr(n) {
    const q = desugar(n.type);
    const inits = (n.inner || []).filter((c) => c.kind);
    // array of records (e.g. struct rnglist_t[2])
    const arrM = q.match(/^(?:struct|union) (\w+)\[(\d*)\]$/);
    if (arrM) {
      const items = inits.map((c) => this.emitExpr(c).code);
      return { code: `[\n${items.map((s) => '    ' + s).join(',\n')}\n]`, prec: PREC.atom, _type: { cls: 'ptr' } };
    }
    // record literal: zip with field names when the record is known
    const recM = q.match(/^(?:struct|union) (\w+)$/);
    if (recM && this.records.has(recM[1])) {
      const fields = this.records.get(recM[1]);
      const parts = [];
      for (let i = 0; i < fields.length; i++) {
        const init = inits[i];
        if (!init || init.kind === 'ImplicitValueInitExpr') continue; // zero-init: JS undefined == 0/falsy for our uses
        parts.push(`${fields[i]}: ${this.emitExpr(init).code}`);
      }
      return { code: `{ ${parts.join(', ')} }`, prec: PREC.atom, _type: { cls: 'record' } };
    }
    // record outside the main file (isaac64_ctx): zero-initialized in C;
    // overwritten by isaac64_init before any read, so null is exact here.
    if (recM) return { code: 'null', prec: PREC.atom, _type: { cls: 'record' } };
    // scalar array with explicit inits
    if (/\[/.test(q)) {
      const items = inits.filter((c) => c.kind !== 'ImplicitValueInitExpr').map((c) => this.emitExpr(c).code);
      return { code: `[${items.join(', ')}]`, prec: PREC.atom, _type: { cls: 'ptr' } };
    }
    throw new Error(`InitListExpr on "${q}" unsupported (${this.cref(n)})`);
  }

  expr_ImplicitValueInitExpr(n) {
    return { code: '0', prec: PREC.atom, const: '0', _type: nodeType(n) };
  }

  // ----- calls -----

  calleeName(call) {
    let c = call.inner[0];
    while (c && c.kind === 'ImplicitCastExpr' && (c.castKind === 'FunctionToPointerDecay' || c.castKind === 'BuiltinFnToFnPtr' || c.castKind === 'NoOp' || c.castKind === 'LValueToRValue')) c = c.inner[0];
    return c?.kind === 'DeclRefExpr' ? (c.name || c.referencedDecl?.name) : null;
  }

  expr_CallExpr(n) {
    const name = this.calleeName(n);
    const args = n.inner.slice(1);
    // frozen binding: isaac64_init(&ctx, bytes, n) -> ctx = isaac64_init(bytes)
    if (name === 'isaac64_init') {
      let target = args[0];
      if (target.kind === 'UnaryOperator' && target.opcode === '&') target = target.inner[0];
      const bytes = this.emitExpr(args[1]);
      return { code: `${this.emitExpr(target).code} = isaac64_init(${bytes.code})`, prec: PREC.assign, _type: { cls: 'void' } };
    }
    // frozen binding: isaac64_next_uint64(&ctx) -> isaac64_next_uint64(ctx)
    if (name === 'isaac64_next_uint64') {
      let target = args[0];
      if (target.kind === 'UnaryOperator' && target.opcode === '&') target = target.inner[0];
      return { code: `isaac64_next_uint64(${this.emitExpr(target).code})`, prec: PREC.atom, _type: nodeType(n) };
    }
    // fortified snprintf: __builtin___snprintf_chk(buf, n, flag, objsize, fmt, ...) -> snprintf(buf, n, fmt, ...)
    if (name === '__builtin___snprintf_chk') {
      const kept = [args[0], args[1], ...args.slice(4)].map((a) => this.emitExpr(a).code);
      return { code: `snprintf(${kept.join(', ')})`, prec: PREC.atom, _type: nodeType(n) };
    }
    if (name === 'abs') {
      return { code: `Math.abs(${this.emitExpr(args[0]).code})`, prec: PREC.atom, _type: nodeType(n) };
    }
    const callee = this.emitExpr(n.inner[0]);
    const argCodes = args.map((a) => this.emitExpr(a).code);
    return { code: `${this.group(callee, PREC.atom)}(${argCodes.join(', ')})`, prec: PREC.atom, _type: nodeType(n) };
  }

  // ----- statements -----

  emitStmt(n, indent) {
    if (!n || !n.kind) return [];
    const fn = this['stmt_' + n.kind];
    if (!fn) {
      if (n.kind.endsWith('Expr') || n.kind.endsWith('Literal') || n.kind.endsWith('Operator')) {
        return [`${indent}${this.emitExpr(n).code};`];
      }
      throw new Error(`emitStmt: unsupported node kind ${n.kind} (${this.cref(n)})`);
    }
    return fn.call(this, n, indent);
  }

  stmt_CompoundStmt(n, indent) {
    const lines = [`${indent}{`];
    for (const c of (n.inner || []).filter((x) => x && x.kind)) {
      lines.push(...this.emitStmt(c, indent + '    '));
    }
    lines.push(`${indent}}`);
    return lines;
  }

  /** statement position: braces for compounds, indented line otherwise */
  stmt_DeclStmt(n, indent) {
    const decls = (n.inner || []).filter((c) => c && c.kind === 'VarDecl');
    const parts = decls.map((d) => this.localVarDecl(d));
    return [`${indent}${parts.join(' ')}`];
  }

  localVarDecl(d) {
    const q = desugar(d.type);
    const arrM = q.match(/^(.*)\[(\d+)\]$/);
    if (arrM) {
      const elem = arrM[1].trim();
      if (/\bchar\b/.test(elem)) return `let ${d.name} = new Uint8Array(${arrM[2]});`;
      if (/\bint\b/.test(elem) && !/\blong\b/.test(elem)) return `let ${d.name} = new Array(${arrM[2]}).fill(0);`;
      throw new Error(`local array of "${elem}" unsupported (v0)`);
    }
    const init = (d.inner || []).find((c) => c && c.kind);
    if (init) return `let ${d.name} = ${this.emitExpr(init).code};`;
    return `let ${d.name};`;
  }

  stmt_IfStmt(n, indent) {
    const kids = (n.inner || []).filter((c) => c && c.kind);
    const [cond, thenS, elseS] = kids;
    const lines = [];
    const condCode = this.emitExpr(cond).code;
    if (thenS.kind === 'CompoundStmt') {
      const block = this.stmt_CompoundStmt(thenS, indent);
      lines.push(`${indent}if (${condCode}) ${block[0].trimStart()}`);
      lines.push(...block.slice(1));
    } else {
      lines.push(`${indent}if (${condCode})`);
      lines.push(...this.emitStmt(thenS, indent + '    '));
    }
    if (elseS) {
      const thenWasBlock = thenS.kind === 'CompoundStmt';
      const last = lines.length - 1;
      const elseHead = thenWasBlock ? lines[last] + ' else' : `${indent}else`;
      if (!thenWasBlock) lines.push(elseHead);
      if (elseS.kind === 'IfStmt') { // else-if chain
        const elif = this.stmt_IfStmt(elseS, indent);
        if (thenWasBlock) lines[last] = elseHead + ' ' + elif[0].trimStart();
        else lines[lines.length - 1] = elseHead + ' ' + elif[0].trimStart();
        lines.push(...elif.slice(1));
      } else if (elseS.kind === 'CompoundStmt') {
        const block = this.stmt_CompoundStmt(elseS, indent);
        if (thenWasBlock) lines[last] = elseHead + ` ${block[0].trimStart()}`;
        else lines[lines.length - 1] = elseHead + ` ${block[0].trimStart()}`;
        lines.push(...block.slice(1));
      } else {
        lines.push(...this.emitStmt(elseS, indent + '    '));
      }
    }
    return lines;
  }

  stmt_ForStmt(n, indent) {
    const kids = (n.inner || []).filter((c) => c && c.kind);
    if (kids.length !== 4) throw new Error(`ForStmt with ${kids.length} parts unsupported (v0) (${this.cref(n)})`);
    const [init, cond, inc, body] = kids;
    const initCode = init.kind === 'DeclStmt' ? this.stmt_DeclStmt(init, '').join(' ').trim().replace(/;$/, '')
      : this.emitExpr(init).code;
    const condCode = this.emitExpr(cond).code;
    const incCode = this.emitExpr(inc).code;
    const head = `${indent}for (${initCode}; ${condCode}; ${incCode})`;
    return this.loopBody(head, body, indent);
  }

  loopBody(head, body, indent) {
    if (body.kind === 'CompoundStmt') {
      const block = this.stmt_CompoundStmt(body, indent);
      return [`${head} ${block[0].trimStart()}`, ...block.slice(1)];
    }
    return [head, ...this.emitStmt(body, indent + '    ')];
  }

  stmt_WhileStmt(n, indent) {
    const kids = (n.inner || []).filter((c) => c && c.kind);
    const [cond, body] = kids;
    return this.loopBody(`${indent}while (${this.emitExpr(cond).code})`, body, indent);
  }

  stmt_DoStmt(n, indent) {
    const kids = (n.inner || []).filter((c) => c && c.kind);
    const [body, cond] = kids;
    if (body.kind === 'CompoundStmt') {
      const block = this.stmt_CompoundStmt(body, indent);
      return [`${indent}do ${block[0].trimStart()}`, ...block.slice(1, -1), `${indent}}} while (${this.emitExpr(cond).code});`];
    }
    return [`${indent}do`, ...this.emitStmt(body, indent + '    '), `${indent}while (${this.emitExpr(cond).code});`];
  }

  stmt_ReturnStmt(n, indent) {
    const e = (n.inner || []).find((c) => c && c.kind);
    return [`${indent}return${e ? ' ' + this.emitExpr(e).code : ''};`];
  }

  stmt_BreakStmt(n, indent) { return [`${indent}break;`]; }
  stmt_ContinueStmt(n, indent) { return [`${indent}continue;`]; }
  stmt_NullStmt(n, indent) { return [`${indent};`]; }

  // ----- top-level decls -----

  jsdocType(qualType, desugared) {
    const t = parseType(qualType, desugared);
    if (t.cls === 'int') return t.bits === 64 ? 'CLongLong' : t.signed ? 'CInt' : 'CUInt';
    if (t.cls === 'f64') return 'CDouble';
    if (t.cls === 'void') return 'void';
    return '*';
  }

  emitFunction(d) {
    const body = (d.inner || []).find((c) => c && c.kind === 'CompoundStmt');
    const params = (d.inner || []).filter((c) => c && c.kind === 'ParmVarDecl');
    const retQ = d.type.qualType.replace(/\s*\(.*$/, ''); // "int (int)" -> "int"
    const lines = [];
    const paramDoc = params.map((p) => `@param {${this.jsdocType(p.type?.qualType, p.type?.desugaredQualType)}} ${p.name}`).join(' ');
    const retDoc = this.jsdocType(retQ) === 'void' ? '' : ` @returns {${this.jsdocType(retQ)}}`;
    lines.push(`/** C ref: ${this.cref(d)}${paramDoc ? ' — ' + paramDoc : ''}${retDoc} */`);
    const isStatic = d.storageClass === 'static';
    lines.push(`${isStatic ? '' : 'export '}function ${d.name}(${params.map((p) => p.name).join(', ')}) {`);
    for (const c of (body.inner || []).filter((x) => x && x.kind)) {
      lines.push(...this.emitStmt(c, '    '));
    }
    lines.push('}');
    return lines;
  }

  emitTopVar(d) {
    const q = desugar(d.type);
    const init = (d.inner || []).find((c) => c && c.kind);
    const kw = /\[/.test(q) ? 'const' : 'let';
    const lines = [`/** C ref: ${this.cref(d)} — ${q} */`];
    lines.push(`${kw} ${d.name}${init ? ' = ' + this.emitExpr(init).code : q.includes('*') ? ' = null' : ' = 0'};`);
    return lines;
  }

  emitEnum(d) {
    const lines = [`/** C ref: ${this.cref(d)} — enum */`];
    let next = 0;
    for (const c of (d.inner || []).filter((x) => x && x.kind === 'EnumConstantDecl')) {
      const init = (c.inner || []).find((x) => x && x.kind);
      const v = init ? Number(this.emitExpr(init).const ?? this.emitExpr(init).code) : next;
      lines.push(`const ${c.name} = ${v};`);
      next = v + 1;
    }
    return lines;
  }

  emitRecord(d) {
    const fields = this.records.get(d.name) || [];
    return [`/** C ref: ${this.cref(d)} — struct ${d.name} { ${fields.join(', ')} } (memory model v0: plain JS object) */`];
  }

  emitModule() {
    const chunks = [];
    for (const d of this.decls) {
      switch (d.kind) {
        case 'FunctionDecl': {
          const hasBody = (d.inner || []).some((c) => c && c.kind === 'CompoundStmt');
          if (!hasBody) break; // prototype / extern — no emission
          chunks.push(this.emitFunction(d));
          break;
        }
        case 'VarDecl':
          chunks.push(this.emitTopVar(d));
          break;
        case 'EnumDecl':
          chunks.push(this.emitEnum(d));
          break;
        case 'RecordDecl':
          if (d.completeDefinition) chunks.push(this.emitRecord(d));
          break;
        case 'TypedefDecl':
          chunks.push([`/** C ref: ${this.cref(d)} — typedef ${d.name} (type alias only, no runtime output) */`]);
          break;
        default:
          throw new Error(`unsupported top-level decl ${d.kind} ${d.name || ''} (${this.cref(d)})`);
      }
    }
    return chunks;
  }
}

/** load the hand-written runtime prelude inlined into generated files */
export function loadPrelude() {
  return fs.readFileSync(path.join(TOOLS_DIR, 'runtime', 'rnd-prelude.js'), 'utf8').trimEnd();
}
