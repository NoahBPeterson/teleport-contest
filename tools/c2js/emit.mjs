// emit.mjs — clang-AST→JS emitter, v1 (rnd.c + hacklib.c scope).
//
// Type-directed emission per tools/c2js/DESIGN.md and js/cmachine.js:
//   int/char/short (signed)  -> number, | 0 / Math.imul / (a / b) | 0
//   unsigned 32-bit          -> number, >>> 0 / u32div / u32mod
//   long / long long (LP64)  -> BigInt, native BigInt ops
//   pointers                 -> CPtr { buf, off } via js/cptr.js (memory
//                               model v0.5; idioms documented in cptr.js)
//   structs                  -> JS objects (static initializers) or
//                               byte-packed CPtr locations (malloc'd/POD)
//   arrays                   -> Uint8Array (char/uchar) / JS array (else)
//
// Emitted value representations (this.rep convention):
//   'val'  plain JS number/bigint/boolean/null/function
//   'cptr' { buf, off } pointer — also the lvalue location form for
//          byte-buffer storage (loads/stores via cptr.ld*/st*)
//   'obj'  plain JS object (record value, e.g. static datamodel table)
//   'buf'  raw Uint8Array / JS array (array-typed storage, pre-decay)
//
// Only the node kinds rnd.c + hacklib.c need are implemented. Anything
// else throws so the gap is loud, never silent.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- types ----

const INT_RE = /^(signed |unsigned )?(char|short|int|long|long long)$/;

// NetHack/stdint typedefs seen without a desugaredQualType — normalized here.
const TYPEDEFS = {
  uint8: 'unsigned char', uint16: 'unsigned short', uint32: 'unsigned int', uint64: 'unsigned long long',
  sint8: 'signed char', sint16: 'short', sint32: 'int', sint64: 'long long',
  int8_t: 'signed char', int16_t: 'short', int32_t: 'int', int64_t: 'long long',
  uint8_t: 'unsigned char', uint16_t: 'unsigned short', uint32_t: 'unsigned int', uint64_t: 'unsigned long long',
  uchar: 'unsigned char', ushort: 'unsigned short', uint: 'unsigned int', ulong: 'unsigned long',
  coordxy: 'short', size_t: 'unsigned long', ptrdiff_t: 'long',
};

function desugar(t) {
  return (t?.desugaredQualType || t?.qualType || '')
    .replace(/\bconst\b|\brestrict\b|\bvolatile\b/g, '')
    .replace(/\b(uint8|uint16|uint32|uint64|sint8|sint16|sint32|sint64|int8_t|int16_t|int32_t|int64_t|uint8_t|uint16_t|uint32_t|uint64_t|uchar|ushort|uint|ulong|coordxy|size_t|ptrdiff_t)\b/g,
      (m) => TYPEDEFS[m])
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
  if (/\(/.test(q)) return { cls: 'ptr' }; // function designator type
  return { cls: 'record' };
}

function nodeType(n) {
  return parseType(n.type?.qualType, n.type?.desugaredQualType);
}

function sameClass(a, b) {
  return a.cls === b.cls && a.bits === b.bits && a.signed === b.signed;
}

/** pointee of a pointer type string ("const char *" -> "char"); null if not a pointer */
function pointeeOf(qualType, desugared) {
  let q = (desugared || qualType || '').replace(/\bconst\b|\brestrict\b|\bvolatile\b/g, '').replace(/\s+/g, ' ').trim();
  if (!q.includes('*')) return null;
  return q.replace(/\s*\*\s*$/, '').trim();
}

/** "char[5][5]" -> { elem: 'char[5]', count: 5 }; "int[5]" -> { elem:'int', count:5 } */
function arrayParts(qualType, desugared) {
  const q = (desugared || qualType || '').trim();
  const m = q.match(/^(.*)\[(\d*)\]$/);
  if (!m) return null;
  return { elem: m[1].trim(), count: m[2] ? Number(m[2]) : null };
}

// JS operator precedence (for minimal parenthesization)
const PREC = { comma: 1, assign: 2, cond: 3, '||': 4, '&&': 5, '|': 6, '^': 7, '&': 8, eq: 9, rel: 10, shift: 11, add: 12, mul: 13, unary: 15, postfix: 16, atom: 18 };
const BIN_PREC = { '||': 4, '&&': 5, '|': 6, '^': 7, '&': 8, '==': 9, '!=': 9, '<': 10, '>': 10, '<=': 10, '>=': 10, '<<': 11, '>>': 11, '>>>': 11, '+': 12, '-': 12, '*': 13, '/': 13, '%': 13 };

/** parenthesize child for use as an operand of an infix op */
function operand(e, parentPrec, side) {
  if (e.prec < parentPrec || (side === 'right' && e.prec === parentPrec)) return { ...e, code: `(${e.code})`, prec: PREC.atom };
  return e;
}

// libc calls routed to cptr.* (same name)
const LIBC = new Set(['strlen', 'strcpy', 'strcat', 'strncmp', 'strchr', 'strrchr', 'strstr', 'memcpy',
  'malloc', 'free', 'qsort', 'read', 'write', 'isupper', 'tolower', 'sprintf', 'snprintf', 'vsnprintf', 'printf']);

// ------------------------------------------------------------- emitter ----

export class Emitter {
  constructor({ decls, lineOf, source, fileName, extraRecords }) {
    this.decls = decls;
    this.lineOf = lineOf;
    this.fileName = fileName; // "rnd.c"
    this.records = new Map(); // struct name -> [{name, q (desugared qualType)}]
    this.layouts = new Map(); // struct name -> { size, align, offsets: {field: off} }
    this.cmachine = new Set(); // cmachine.js helpers used
    this.strings = new Map(); // raw literal -> __slN (dedup)
    this.stringList = [];
    this.staticLocals = new Map(); // VarDecl id -> hoisted name (current function)
    this.recordLocals = new Set(); // names of struct/union value locals (current function)
    this.setjmpVar = null; // substitution variable while emitting a setjmp if
    this.uniq = 0;
    this.refs = new Map(); // name -> 'FunctionDecl'|'VarDecl' (cross-file import wiring)
    this.declared = new Set(); // names defined at this file's top level
    this.usesCptr = false;
    this.usesCjmp = false;
    this.collectRecords();
    // header-defined record layouts (full-TU record table from symbols.mjs);
    // main-file records take precedence
    if (extraRecords) {
      for (const [name, rec] of extraRecords) {
        if (!this.records.has(name)) {
          this.records.set(name, { tag: rec.tag, fields: rec.fields.map((f) => ({ name: f.name, q: desugar({ qualType: f.q }) })) });
        }
      }
    }
  }

  collectRecords() {
    for (const d of this.decls) {
      if (d.kind !== 'RecordDecl' || !d.name) continue;
      const fields = (d.inner || []).filter((c) => c.kind === 'FieldDecl')
        .map((c) => ({ name: c.name, q: desugar(c.type) }));
      if (fields.length) this.records.set(d.name, { tag: d.tagUsed || 'struct', fields });
    }
  }

  /** minimal LP64 layout: scalar fields, fixed arrays, nested records; unions: all offsets 0 */
  layoutOf(name) {
    if (this.layouts.has(name)) return this.layouts.get(name);
    const rec = this.records.get(name);
    if (!rec) throw new Error(`layout: unknown struct ${name}`);
    if (rec.tag === 'enum') return { size: 4, align: 4, offsets: {} };
    if (rec.tag === 'union') {
      let size = 1, maxAlign = 1;
      const offsets = {};
      for (const f of rec.fields) {
        const { size: fs, align } = this.sizeAlign(f.q);
        offsets[f.name] = 0;
        size = Math.max(size, fs);
        maxAlign = Math.max(maxAlign, align);
      }
      const layout = { size: Math.ceil(size / maxAlign) * maxAlign, align: maxAlign, offsets };
      this.layouts.set(name, layout);
      return layout;
    }
    let off = 0, maxAlign = 1;
    const offsets = {};
    for (const f of rec.fields) {
      const { size, align } = this.sizeAlign(f.q);
      off = Math.ceil(off / align) * align;
      offsets[f.name] = off;
      off += size;
      maxAlign = Math.max(maxAlign, align);
    }
    const layout = { size: Math.ceil(off / maxAlign) * maxAlign, align: maxAlign, offsets };
    this.layouts.set(name, layout);
    return layout;
  }

  sizeAlign(q) {
    const arr = arrayParts(q);
    if (arr) {
      const e = this.sizeAlign(arr.elem);
      return { size: e.size * (arr.count ?? 0), align: e.align };
    }
    if (q.includes('*')) return { size: 8, align: 8 };
    if (/^enum \w+$/.test(q)) return { size: 4, align: 4 };
    const recName = this.recordNameOf(q);
    if (recName) { const l = this.layoutOf(recName); return { size: l.size, align: l.align }; }
    if (/\bdouble\b/.test(q)) return { size: 8, align: 8 };
    if (/\bfloat\b/.test(q)) return { size: 4, align: 4 };
    if (/\blong\b/.test(q) || q === 'size_t') return { size: 8, align: 8 };
    if (/\bint\b/.test(q)) return { size: 4, align: 4 };
    if (/\bshort\b/.test(q)) return { size: 2, align: 2 };
    if (/\bchar\b/.test(q) || q === 'boolean' || q === 'schar') return { size: 1, align: 1 };
    throw new Error(`sizeAlign: unsupported field type "${q}"`);
  }

  cptrCall(name, ...args) { this.usesCptr = true; return `cptr.${name}(${args.join(', ')})`; }

  cref(n) {
    const off = n.loc?.offset ?? n.range?.begin?.offset;
    return off !== undefined ? `${this.fileName}:${this.lineOf(off)}` : this.fileName;
  }

  internString(raw) {
    if (!this.strings.has(raw)) {
      const name = `__sl${this.stringList.length}`;
      this.strings.set(raw, name);
      this.stringList.push(raw);
    }
    return this.strings.get(raw);
  }

  // ----- type conversions -----

  convert(e, from, to) {
    if (to.cls === 'void') return e;
    if (from.cls === 'ptr' || to.cls === 'ptr' || from.cls === 'record' || to.cls === 'record') return e;
    if (from.cls === 'f64' || to.cls === 'f64') {
      // int <-> double conversions (C truncates toward zero)
      if (from.cls === 'f64' && to.cls === 'int' && to.bits <= 32) return { code: `${this.group(e, PREC.postfix)} | 0`, prec: PREC['|'], rep: 'val' };
      if (from.cls === 'f64' && to.cls === 'int') return { code: `BigInt.as${to.signed ? 'Int' : 'Uint'}N(64, BigInt(Math.trunc(${this.group(e, PREC.atom)})))`, prec: PREC.atom, rep: 'val' };
      if (to.cls === 'f64' && from.cls === 'int' && from.bits === 64) return { code: `Number(${this.group(e, PREC.atom)})`, prec: PREC.atom, rep: 'val' };
      return e; // int32 -> double: identity (JS number)
    }
    if (sameClass(from, to)) return e;
    // constant folding for literal conversions
    if (e.const !== undefined && /^-?\d+$/.test(e.const)) {
      let v = BigInt(e.const);
      v = to.signed ? BigInt.asIntN(to.bits, v) : BigInt.asUintN(to.bits, v);
      if (to.bits === 64) return { code: `${v}n`, prec: PREC.atom, const: String(v), rep: 'val' };
      return { code: String(Number(v)), prec: Number(v) < 0 ? PREC.unary : PREC.atom, const: String(Number(v)), rep: 'val' };
    }
    if (to.bits === 64) {
      if (from.bits === 64) return { code: `BigInt.as${to.signed ? 'Int' : 'Uint'}N(64, ${this.group(e, PREC.atom)})`, prec: PREC.atom, rep: 'val' };
      if (from.signed && to.signed) return { code: `BigInt(${this.group(e, PREC.atom)})`, prec: PREC.atom, rep: 'val' };
      if (from.signed && !to.signed) return { code: `BigInt.asUintN(64, BigInt(${this.group(e, PREC.atom)}))`, prec: PREC.atom, rep: 'val' };
      return { code: `BigInt(${this.group(e, PREC.atom)} >>> 0)`, prec: PREC.atom, rep: 'val' };
    }
    if (from.bits === 64) {
      return { code: `Number(BigInt.as${to.signed ? 'Int' : 'Uint'}N(${to.bits}, ${this.group(e, PREC.atom)}))`, prec: PREC.atom, rep: 'val' };
    }
    if (to.bits === 32 && from.bits === 32) {
      return { code: `${this.group(e, PREC.postfix)} ${to.signed ? '| 0' : '>>> 0'}`, prec: to.signed ? PREC['|'] : PREC.shift, rep: 'val' };
    }
    if (to.bits < from.bits || (to.bits === from.bits && !to.signed) || to.bits < 32) {
      const helper = to.signed ? { 8: 'schar', 16: 'i16', 32: null }[to.bits] : { 8: 'uchar', 16: 'u16', 32: 'u32' }[to.bits];
      if (helper) {
        this.cmachine.add(helper);
        return { code: `${helper}(${this.group(e, PREC.atom)})`, prec: PREC.atom, rep: 'val' };
      }
    }
    return e; // widening: value-preserving
  }

  group(e, ctxPrec) {
    return e.prec < ctxPrec ? `(${e.code})` : e.code;
  }

  // ----- expressions -----

  emitExpr(n, opts = {}) {
    if (!n || !n.kind) throw new Error('emitExpr: empty node');
    const fn = this['expr_' + n.kind];
    if (!fn) throw new Error(`emitExpr: unsupported node kind ${n.kind} (${this.cref(n)})`);
    return fn.call(this, n, opts);
  }

  expr_IntegerLiteral(n) {
    const t = nodeType(n);
    if (t.cls === 'int' && t.bits === 64) return { code: `${n.value}n`, prec: PREC.atom, const: n.value, rep: 'val' };
    return { code: n.value, prec: n.value.startsWith('-') ? PREC.unary : PREC.atom, const: n.value, rep: 'val' };
  }

  expr_CharacterLiteral(n) {
    return { code: String(n.value), prec: PREC.atom, const: String(n.value), rep: 'val' };
  }

  expr_FloatingLiteral(n) {
    // value may be a JSON number; emit a JS double literal
    return { code: typeof n.value === 'number' ? String(n.value) : String(n.value), prec: PREC.atom, rep: 'val' };
  }

  expr_StringLiteral(n) {
    // value includes the C quotes/escapes; valid JS for these literals
    return { code: this.internString(n.value), prec: PREC.atom, rep: 'cptr' };
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
    let name = n.name || n.referencedDecl?.name;
    const refId = n.referencedDecl?.id;
    const refKind = n.referencedDecl?.kind;
    if (name && (refKind === 'FunctionDecl' || refKind === 'VarDecl') && !(refId && this.staticLocals.has(refId))) {
      this.refs.set(name, refKind);
    }
    if (refId && this.staticLocals.has(refId)) name = this.staticLocals.get(refId);
    const t = nodeType(n);
    const q = desugar(n.type);
    const rep = arrayParts(q) ? 'buf'
      : this.recordLocals.has(name) ? 'cptr'
      : t.cls === 'record' ? 'obj'
      : t.cls === 'ptr' && !/\(/.test(q) ? 'cptr' : 'val';
    return { code: name, prec: PREC.atom, _type: t, rep };
  }

  /** load a scalar rvalue from a cptr location, by access type */
  loadFrom(locCode, typeQ) {
    const t = parseType(typeQ);
    if (t.cls === 'int' && t.bits === 8) return { code: this.cptrCall(t.signed ? 'ld1s' : 'ld1u', locCode), prec: PREC.atom, rep: 'val' };
    if (t.cls === 'int' && t.bits === 64) return { code: this.cptrCall(t.signed ? 'ldI64' : 'ldU64', locCode), prec: PREC.atom, rep: 'val' };
    if (t.cls === 'int' && t.bits === 32) return { code: this.cptrCall('ldI32', locCode), prec: PREC.atom, rep: 'val' };
    if (t.cls === 'f64') return { code: this.cptrCall('ldF64', locCode), prec: PREC.atom, rep: 'val' };
    if (t.cls === 'ptr') return { code: this.cptrCall('ldPtr', locCode), prec: PREC.atom, rep: 'cptr' };
    throw new Error(`loadFrom: unsupported access type "${typeQ}"`);
  }

  storeTo(locCode, typeQ, valueCode) {
    const t = parseType(typeQ);
    if (t.cls === 'int' && t.bits === 8) return this.cptrCall('st1', locCode, valueCode);
    if (t.cls === 'int' && t.bits === 64) return this.cptrCall('stU64', locCode, valueCode);
    if (t.cls === 'int' && t.bits === 32) return this.cptrCall('stI32', locCode, valueCode);
    if (t.cls === 'f64') return this.cptrCall('stF64', locCode, valueCode);
    if (t.cls === 'ptr') return this.cptrCall('stPtr', locCode, valueCode);
    throw new Error(`storeTo: unsupported access type "${typeQ}"`);
  }

  /** element access location for base[{idx}] — returns {code, elemQ, rep} */
  subscriptLoc(base, idx, baseQ) {
    const arr = arrayParts(baseQ);
    if (arr) { // base has array type
      const elemT = parseType(arr.elem);
      if (base.rep === 'cptr') {
        // byte-packed array member of a struct/union: scaled location
        return { code: this.cptrCall('add', base.code, idx.code, String(this.sizeofType(arr.elem))), elemQ: arr.elem, rep: 'cptr' };
      }
      if (arrayParts(arr.elem) || elemT.cls === 'record') {
        return { code: `${this.group(base, PREC.atom)}[${idx.code}]`, elemQ: arr.elem, rep: arrayParts(arr.elem) ? 'buf' : 'obj' };
      }
      if (arr.elem === 'int' || arr.elem === 'unsigned int') {
        return { code: `${this.group(base, PREC.atom)}[${idx.code}]`, elemQ: arr.elem, rep: 'val', plain: true };
      }
      // 1-byte element buffer: location through cptr
      const loc = this.cptrCall('add', this.cptrCall('decay', base.code), idx.code);
      return { code: loc, elemQ: arr.elem, rep: 'cptr' };
    }
    // base is a CPtr
    const pointee = pointeeOf(baseQ);
    if (!pointee) throw new Error('subscript on non-pointer/non-array');
    const elemT = parseType(pointee);
    if (elemT.cls === 'record') {
      const sz = this.layoutOf(this.recordNameOf(pointee)).size;
      return { code: this.cptrCall('add', base.code, idx.code, String(sz)), elemQ: pointee, rep: 'cptr' };
    }
    return { code: this.cptrCall('add', base.code, idx.code), elemQ: pointee, rep: 'cptr' };
  }

  expr_ArraySubscriptExpr(n) {
    // look through array-to-pointer decay to the underlying storage
    let baseNode = n.inner[0];
    while (baseNode.kind === 'ImplicitCastExpr' && baseNode.castKind === 'ArrayToPointerDecay') baseNode = baseNode.inner[0];
    const base = this.emitExpr(baseNode);
    const idx = this.emitExpr(n.inner[1]);
    const baseQ = desugar(baseNode.type);
    const loc = this.subscriptLoc(base, idx, baseQ);
    if (loc.rep === 'cptr' && !loc.plain) {
      const elemT = parseType(loc.elemQ);
      if (elemT.cls === 'record') return { code: loc.code, prec: PREC.atom, rep: 'cptr', elemQ: loc.elemQ };
      return this.loadFrom(loc.code, loc.elemQ);
    }
    return { code: loc.code, prec: PREC.atom, rep: loc.rep, elemQ: loc.elemQ };
  }

  /** resolve a type string to a known record name: "struct x", "union x", or bare typedef */
  recordNameOf(q) {
    if (!q) return undefined;
    const m = q.match(/^(?:struct|union|enum) (\w+)$/);
    if (m) return this.records.has(m[1]) ? m[1] : m[1];
    if (/^\w+$/.test(q) && this.records.has(q)) return q;
    return m ? m[1] : undefined;
  }

  /** field offset within a byte-packed struct */
  fieldOffset(recName, fieldName) {
    const l = this.layoutOf(recName);
    if (!(fieldName in l.offsets)) throw new Error(`layout: ${recName} has no field ${fieldName}`);
    return l.offsets[fieldName];
  }

  expr_MemberExpr(n) {
    const base = this.emitExpr(n.inner[0]);
    if (base.rep === 'obj') {
      // plain JS object field (function-pointer fields stay plain values)
      const fieldQ = this.fieldTypeOf(n.inner[0], n.name);
      const rep = fieldQ && arrayParts(fieldQ) ? 'buf'
        : fieldQ && parseType(fieldQ).cls === 'ptr' && !/\(/.test(fieldQ) ? 'cptr' : 'val';
      return { code: `${this.group(base, PREC.atom)}.${n.name}`, prec: PREC.atom, rep, elemQ: fieldQ };
    }
    if (base.rep === 'cptr') {
      // byte-packed struct/union location + field offset (0 for union members)
      const bq = desugar(n.inner[0].type);
      const recName = this.recordNameOf(pointeeOf(bq) || bq);
      const off = this.fieldOffset(recName, n.name);
      const fieldQ = this.fieldTypeOf(n.inner[0], n.name);
      const loc = off === 0 ? base.code : this.cptrCall('add', base.code, String(off));
      // record/array fields: the location itself is the value (decays later)
      if (arrayParts(fieldQ) || parseType(fieldQ).cls === 'record') {
        return { code: loc, prec: PREC.atom, rep: 'cptr', elemQ: fieldQ };
      }
      return { ...this.loadFrom(loc, fieldQ), locCode: loc, elemQ: fieldQ };
    }
    throw new Error(`MemberExpr .${n.name} on rep ${base.rep} unsupported (${this.cref(n)})`);
  }

  fieldTypeOf(baseNode, fieldName) {
    const bq = desugar(baseNode.type);
    const recName = this.recordNameOf(pointeeOf(bq) || bq);
    const f = this.records.get(recName)?.fields.find((x) => x.name === fieldName);
    return f?.q;
  }

  expr_ImplicitCastExpr(n) {
    const inner = this.emitExpr(n.inner[0]);
    switch (n.castKind) {
      case 'LValueToRValue':
      case 'NoOp':
      case 'FunctionToPointerDecay':
      case 'BuiltinFnToFnPtr':
      case 'IntegralToBoolean':
      case 'BitCast': // pointer<->pointer
        return { ...inner, _type: nodeType(n) };
      case 'ArrayToPointerDecay':
        if (inner.rep === 'buf') return { code: this.cptrCall('decay', inner.code), prec: PREC.atom, rep: 'cptr' };
        return { ...inner, rep: 'cptr' };
      case 'IntegralCast':
      case 'IntegralConversion':
      case 'IntegralToFloating':
      case 'FloatingToIntegral':
      case 'FloatingCast':
        return { ...this.convert(inner, nodeType(n.inner[0]), nodeType(n)), _type: nodeType(n) };
      case 'NullToPointer':
        return { code: 'null', prec: PREC.atom, const: '0', rep: 'val' };
      default:
        throw new Error(`unsupported implicit cast ${n.castKind} (${this.cref(n)})`);
    }
  }

  expr_CStyleCastExpr(n) {
    // NetHack SIZE(x) idiom: (int)(sizeof(arr) / sizeof(arr[0])) -> arr.length
    const sizeIdiom = this.matchSizeIdiom(n);
    if (sizeIdiom) return { code: sizeIdiom, prec: PREC.atom, rep: 'val' };
    const inner = this.emitExpr(n.inner[0]);
    if (n.castKind === 'NullToPointer') return { code: 'null', prec: PREC.atom, const: '0', rep: 'val' };
    if (n.castKind === 'ToVoid') return { code: `void ${this.group(inner, PREC.unary)}`, prec: PREC.unary, rep: 'val' };
    if (n.castKind === 'BitCast' || n.castKind === 'NoOp') return { ...inner, _type: nodeType(n) };
    return { ...this.convert(inner, nodeType(n.inner[0]), nodeType(n)), _type: nodeType(n) };
  }

  matchSizeIdiom(n) {
    let cur = n;
    while (cur.kind === 'CStyleCastExpr' || cur.kind === 'ImplicitCastExpr' || cur.kind === 'ParenExpr') {
      if (cur.kind === 'ParenExpr') { cur = cur.inner[0]; continue; }
      if (cur.castKind === 'IntegralCast' || cur.castKind === 'NoOp') { cur = cur.inner[0]; continue; }
      return null;
    }
    if (cur.kind !== 'BinaryOperator' || cur.opcode !== '/') return null;
    const [l, r] = cur.inner;
    if (l.kind !== 'UnaryExprOrTypeTraitExpr' || r.kind !== 'UnaryExprOrTypeTraitExpr') return null;
    const arrRef = this.sizeofArrayRef(l);
    const eltRef = this.sizeofArrayRef(r, true);
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
    let arg = n.inner?.[0];
    while (arg && arg.kind === 'ParenExpr') arg = arg.inner[0];
    const q = arg ? desugar(arg.type) : desugar(n.argType); // expr form vs type form
    const size = this.sizeofType(q);
    const t = nodeType(n); // size_t == unsigned long -> 64-bit class
    const code = t.bits === 64 ? `${size}n` : String(size);
    return { code, prec: PREC.atom, const: String(size), rep: 'val' };
  }

  sizeofType(q) {
    const arr = arrayParts(q);
    if (arr) return (arr.count ?? 0) * this.sizeofType(arr.elem);
    if (q.includes('*')) return 8;
    if (/^enum \w+$/.test(q)) return 4;
    const recName = this.recordNameOf(q);
    if (recName) return this.layoutOf(recName).size;
    if (/\bdouble\b/.test(q)) return 8;
    if (/\bfloat\b/.test(q)) return 4;
    if (/\blong\b/.test(q) || q === 'size_t') return 8;
    if (/\bint\b/.test(q)) return 4;
    if (/\bshort\b/.test(q)) return 2;
    if (/\bchar\b/.test(q) || q === 'boolean' || q === 'schar') return 1;
    throw new Error(`sizeof: unsupported type "${q}"`);
  }

  expr_UnaryOperator(n, opts = {}) {
    const [sub] = n.inner;
    const t = nodeType(n);
    const subT = nodeType(sub);
    switch (n.opcode) {
      case '++': case '--': {
        if (subT.cls === 'ptr') {
          // pointer variable inc/dec
          if (sub.kind !== 'DeclRefExpr') throw new Error(`++/-- on non-variable pointer (${this.cref(n)})`);
          const name = this.emitExpr(sub).code;
          const delta = n.opcode === '++' ? '1' : '-1';
          if (opts.stmtPos) return { code: `${name} = ${this.cptrCall('add', name, delta)}`, prec: PREC.assign, rep: 'val' };
          const helper = (n.isPostfix ? 'post' : 'pre') + (n.opcode === '++' ? 'inc' : 'dec');
          return { code: this.cptrCall(helper, `() => ${name}`, `(v) => { ${name} = v; }`), prec: PREC.atom, rep: 'cptr' };
        }
        // scalar location (e.g. tstr[i]++)?
        if (sub.kind === 'ArraySubscriptExpr' || sub.kind === 'UnaryOperator') {
          const loc = this.emitLValue(sub);
          if (loc.kind === 'cptr') {
            if (n.isPostfix && n.opcode === '++') return { code: this.cptrCall('postinc1', loc.code), prec: PREC.atom, rep: 'val' };
            throw new Error(`${n.opcode} on scalar cptr location unsupported (v1) (${this.cref(n)})`);
          }
        }
        return { code: n.isPostfix ? `${this.group(this.emitExpr(sub), PREC.postfix)}${n.opcode}` : `${n.opcode}${this.group(this.emitExpr(sub), PREC.unary)}`, prec: n.isPostfix ? PREC.postfix : PREC.unary, rep: 'val' };
      }
      case '-': case '!': case '~': {
        const e = this.emitExpr(sub);
        return { code: `${n.opcode}${this.group(e, PREC.unary)}`, prec: PREC.unary, rep: 'val' };
      }
      case '&': { // address-of: the cptr location IS the address
        const loc = this.emitLValue(sub);
        if (loc.kind === 'cptr') return { code: loc.code, prec: PREC.atom, rep: 'cptr' };
        throw new Error(`address-of ${loc.kind} unsupported (v1) (${this.cref(n)})`);
      }
      case '*': { // deref
        const e = this.emitExpr(sub);
        const pointee = pointeeOf(desugar(sub.type)) || '';
        if (/\(/.test(pointee)) return { ...e, rep: 'val' }; // function pointer deref: the function itself
        const pt = parseType(pointee);
        if (pt.cls === 'record') return { ...e, rep: 'cptr', elemQ: pointee }; // struct location
        return this.loadFrom(e.code, pointee);
      }
      default:
        throw new Error(`unsupported unary op ${n.opcode} (${this.cref(n)})`);
    }
  }

  /** emit an lvalue: {kind:'var'|'cptr'|'prop', code, elemQ?} */
  emitLValue(n) {
    if (n.kind === 'DeclRefExpr') {
      // struct/union local: the variable itself is the CPtr location
      if (this.recordLocals.has(n.name || n.referencedDecl?.name)) {
        return { kind: 'cptr', code: this.emitExpr(n).code, elemQ: desugar(n.type) };
      }
      return { kind: 'var', code: this.emitExpr(n).code, elemQ: desugar(n.type) };
    }
    if (n.kind === 'ParenExpr') return this.emitLValue(n.inner[0]);
    if (n.kind === 'UnaryOperator' && n.opcode === '*') {
      return { kind: 'cptr', code: this.emitExpr(n.inner[0]).code, elemQ: pointeeOf(desugar(n.inner[0].type)) };
    }
    if (n.kind === 'ArraySubscriptExpr') {
      let baseNode = n.inner[0];
      while (baseNode.kind === 'ImplicitCastExpr' && baseNode.castKind === 'ArrayToPointerDecay') baseNode = baseNode.inner[0];
      const base = this.emitExpr(baseNode);
      const idx = this.emitExpr(n.inner[1]);
      const loc = this.subscriptLoc(base, idx, desugar(baseNode.type));
      if (loc.rep === 'cptr') return { kind: 'cptr', code: loc.code, elemQ: loc.elemQ };
      return { kind: 'prop', code: loc.code, elemQ: loc.elemQ };
    }
    if (n.kind === 'MemberExpr') {
      const base = this.emitExpr(n.inner[0]);
      if (base.rep === 'obj') return { kind: 'prop', code: `${this.group(base, PREC.atom)}.${n.name}`, elemQ: this.fieldTypeOf(n.inner[0], n.name) };
      if (base.rep === 'cptr') {
        const bq = desugar(n.inner[0].type);
        const recName = this.recordNameOf(pointeeOf(bq) || bq);
        const off = this.fieldOffset(recName, n.name);
        return { kind: 'cptr', code: off === 0 ? base.code : this.cptrCall('add', base.code, String(off)), elemQ: this.fieldTypeOf(n.inner[0], n.name) };
      }
    }
    throw new Error(`emitLValue: unsupported ${n.kind} (${this.cref(n)})`);
  }

  expr_BinaryOperator(n, opts = {}) {
    const op = n.opcode;
    const t = nodeType(n);
    const lQ = desugar(n.inner[0].type);
    const rQ = desugar(n.inner[1].type);
    const lT = parseType(lQ), rT = parseType(rQ);

    if (op === '=') {
      const lv = this.emitLValue(n.inner[0]);
      const r = this.emitExpr(n.inner[1]);
      if (lv.kind === 'cptr') {
        // struct/union assignment copies the bytes (C11 6.5.16.1)
        const recM = (lv.elemQ || '').match(/^(?:struct|union) (\w+)$/);
        if (recM) {
          return { code: this.cptrCall('memcpy', lv.code, r.code, String(this.layoutOf(recM[1]).size)), prec: PREC.atom, rep: 'val' };
        }
        return { code: this.storeTo(lv.code, lv.elemQ, r.code), prec: PREC.atom, rep: 'val' };
      }
      return { code: `${lv.code} = ${operand(r, PREC.assign, 'right').code}`, prec: PREC.assign, rep: 'val' };
    }
    if (op === ',') {
      const l = this.emitExpr(n.inner[0], opts);
      const r = this.emitExpr(n.inner[1], opts);
      return { code: `${l.code}, ${operand(r, PREC.comma, 'right').code}`, prec: PREC.comma, rep: r.rep };
    }
    const l0 = this.emitExpr(n.inner[0]);
    const r0 = this.emitExpr(n.inner[1]);

    if (op === '&&' || op === '||') {
      const p = BIN_PREC[op];
      return { code: `${operand(l0, p, 'left').code} ${op} ${operand(r0, p, 'right').code}`, prec: p, rep: 'val' };
    }
    // pointer arithmetic
    if ((op === '+' || op === '-') && (lT.cls === 'ptr' || rT.cls === 'ptr') && !(lT.cls === 'ptr' && rT.cls === 'ptr' && op === '+')) {
      if (lT.cls === 'ptr' && rT.cls === 'ptr') { // ptrdiff (long)
        return { code: this.cptrCall('diff', l0.code, r0.code), prec: PREC.atom, rep: 'val' };
      }
      const [ptrE, intE, intT] = lT.cls === 'ptr' ? [l0, r0, rT] : [r0, l0, lT];
      const pointee = pointeeOf(lT.cls === 'ptr' ? lQ : rQ) || 'char';
      const sz = this.sizeofType(pointee);
      const args = [ptrE.code];
      if (op === '-') args.push(`-(${intE.code})`); else args.push(intE.code);
      if (sz !== 1) args.push(String(sz));
      return { code: this.cptrCall('add', ...args), prec: PREC.atom, rep: 'cptr' };
    }
    if (['==', '!=', '<', '>', '<=', '>='].includes(op)) {
      const p = op === '==' || op === '!=' ? PREC.eq : PREC.rel;
      const fnPtr = lQ.includes('(*') || rQ.includes('(*'); // function pointers compare by identity
      const ptrCmp = !fnPtr && (lT.cls === 'ptr' || rT.cls === 'ptr');
      if (fnPtr && (op === '==' || op === '!=')) {
        const jsop = op === '==' ? '===' : '!==';
        return { code: `${operand(l0, p, 'left').code} ${jsop} ${operand(r0, p, 'right').code}`, prec: p, rep: 'val' };
      }
      if (ptrCmp) {
        if (l0.code === 'null' || r0.code === 'null') {
          const other = l0.code === 'null' ? r0 : l0;
          const nullOp = op === '==' ? '===' : op === '!=' ? '!==' : null;
          if (nullOp) return { code: `${operand(other, p, 'left').code} ${nullOp} null`, prec: p, rep: 'val' };
        }
        if (op === '==' || op === '!=') {
          const call = this.cptrCall('eq', l0.code, r0.code);
          return { code: op === '==' ? call : `!${call}`, prec: op === '==' ? PREC.atom : PREC.unary, rep: 'val' };
        }
        return { code: `${this.cptrCall('cmp', l0.code, r0.code)} ${op} 0`, prec: p, rep: 'val' };
      }
      return { code: `${operand(l0, p, 'left').code} ${op} ${operand(r0, p, 'right').code}`, prec: p, rep: 'val' };
    }
    const p = BIN_PREC[op];
    if (!p) throw new Error(`unsupported binary op ${op} (${this.cref(n)})`);
    let r = r0;
    if ((op === '<<' || op === '>>') && t.cls === 'int' && t.bits === 64) r = this.convert(r0, nodeType(n.inner[1]), t);
    const raw = `${operand(l0, p, 'left').code} ${op} ${operand(r, p, 'right').code}`;
    return this.coerceArith(raw, p, op, t, l0, r0);
  }

  coerceArith(raw, p, op, t, l, r) {
    if (t.cls !== 'int') return { code: raw, prec: p, rep: 'val' };
    if (t.bits === 64) return { code: raw, prec: p, rep: 'val' }; // BigInt ops exact; div/mod truncate like C
    if (['<<', '>>', '&', '|', '^', '%'].includes(op)) {
      if (t.signed) return { code: raw, prec: p, rep: 'val' };
      if (op === '>>') return { code: `${operand(l, PREC.shift, 'left').code} >>> ${operand(r, PREC.shift, 'right').code}`, prec: PREC.shift, rep: 'val' };
      if (op === '%') { this.cmachine.add('u32mod'); return { code: `u32mod(${l.code}, ${r.code})`, prec: PREC.atom, rep: 'val' }; }
      return { code: `(${raw}) >>> 0`, prec: PREC.shift, rep: 'val' };
    }
    if (op === '+' || op === '-') return t.signed ? this.wrapI32(raw) : { code: `(${raw}) >>> 0`, prec: PREC.shift, rep: 'val' };
    if (op === '*') return t.signed ? { code: `Math.imul(${l.code}, ${r.code})`, prec: PREC.atom, rep: 'val' } : { code: `Math.imul(${l.code}, ${r.code}) >>> 0`, prec: PREC.shift, rep: 'val' };
    if (op === '/') {
      if (t.signed) return { code: `${p >= PREC['|'] ? `(${raw})` : raw} | 0`, prec: PREC['|'], rep: 'val' };
      this.cmachine.add('u32div');
      return { code: `u32div(${l.code}, ${r.code})`, prec: PREC.atom, rep: 'val' };
    }
    return { code: raw, prec: p, rep: 'val' };
  }

  wrapI32(raw) {
    return { code: `(${raw}) | 0`, prec: PREC['|'], rep: 'val' };
  }

  expr_CompoundAssignOperator(n) {
    const t = nodeType(n);
    const lv = this.emitLValue(n.inner[0]);
    const r0 = this.emitExpr(n.inner[1]);
    const op = n.opcode;
    const base = op.slice(0, -1);

    if (lv.kind === 'cptr') {
      // compound assign through a pointer location (1-byte pointees in scope)
      if ((base === '+' || base === '-') && parseType(lv.elemQ).cls === 'int' && parseType(lv.elemQ).bits === 8) {
        throw new Error(`+= through char location unsupported (${this.cref(n)})`);
      }
      // read-modify-write; loc must be side-effect-free (hacklib sites are)
      const ld = parseType(lv.elemQ).signed === false ? 'ld1u' : 'ld1s';
      return { code: this.cptrCall('st1', lv.code, `${this.cptrCall(ld, lv.code)} ${base} ${r0.code}`), prec: PREC.atom, rep: 'val' };
    }
    const l = { code: lv.code, prec: PREC.atom };
    // pointer variable compound assignment (bp += len)
    if (parseType(lv.elemQ).cls === 'ptr') {
      const helper = base === '+' ? 'add' : 'sub';
      return { code: `${lv.code} = ${this.cptrCall(helper, lv.code, r0.code)}`, prec: PREC.assign, rep: 'val' };
    }
    if (t.cls === 'int' && t.bits === 64) {
      const r = this.convert(r0, nodeType(n.inner[1]), t);
      return { code: `${lv.code} ${op} ${operand(r, PREC.assign, 'right').code}`, prec: PREC.assign, rep: 'val' };
    }
    if (t.cls === 'int' && t.bits === 32) {
      const r = operand(r0, PREC.add, 'right');
      if (base === '+') return { code: `${lv.code} = (${lv.code} + ${r.code}) | 0`, prec: PREC.assign, rep: 'val' };
      if (base === '-') return { code: `${lv.code} = (${lv.code} - ${r.code}) | 0`, prec: PREC.assign, rep: 'val' };
      if (base === '*') return { code: `${lv.code} = Math.imul(${lv.code}, ${r0.code})`, prec: PREC.assign, rep: 'val' };
      if (base === '/') return { code: `${lv.code} = (${lv.code} / ${r.code}) | 0`, prec: PREC.assign, rep: 'val' };
      return { code: `${lv.code} ${op} ${operand(r0, PREC.assign, 'right').code}`, prec: PREC.assign, rep: 'val' };
    }
    // narrow (char) variable compound assign: compute in int, truncate on store
    if (t.cls === 'int' && t.bits === 8) {
      const helper = parseType(lv.elemQ).signed === false ? 'uchar' : 'schar';
      this.cmachine.add(helper);
      return { code: `${lv.code} = ${helper}(${lv.code} ${base} ${r0.code})`, prec: PREC.assign, rep: 'val' };
    }
    throw new Error(`compound assign ${op} on ${JSON.stringify(t)} unsupported (${this.cref(n)})`);
  }

  expr_ConditionalOperator(n) {
    const c = this.emitExpr(n.inner[0]);
    const a = this.emitExpr(n.inner[1]);
    const b = this.emitExpr(n.inner[2]);
    return { code: `${operand(c, PREC.cond, 'left').code} ? ${a.code} : ${operand(b, PREC.cond, 'right').code}`, prec: PREC.cond, rep: a.rep };
  }

  expr_InitListExpr(n) {
    const q = desugar(n.type);
    const inits = (n.inner || []).filter((c) => c.kind);
    const arrM = q.match(/^(.*)\[(\d*)\]$/);
    if (arrM && /^(struct|union)/.test(arrM[1].trim())) {
      const items = inits.map((c) => this.emitExpr(c).code);
      return { code: `[\n${items.map((s) => '    ' + s).join(',\n')}\n]`, prec: PREC.atom, rep: 'buf' };
    }
    const recM = q.match(/^(?:struct|union) (\w+)$/);
    if (recM && this.records.has(recM[1])) {
      const fields = this.records.get(recM[1]).fields;
      const parts = [];
      for (let i = 0; i < fields.length; i++) {
        const init = inits[i];
        if (!init || init.kind === 'ImplicitValueInitExpr') continue;
        parts.push(`${fields[i].name}: ${this.emitExpr(init).code}`);
      }
      return { code: `{ ${parts.join(', ')} }`, prec: PREC.atom, rep: 'obj' };
    }
    if (recM) return { code: 'null', prec: PREC.atom, rep: 'val' }; // zero-init; overwritten before reads (see rnd.c rnglist)
    if (arrM) {
      const items = inits.filter((c) => c.kind !== 'ImplicitValueInitExpr').map((c) => this.emitExpr(c).code);
      return { code: `[${items.join(', ')}]`, prec: PREC.atom, rep: 'buf' };
    }
    throw new Error(`InitListExpr on "${q}" unsupported (${this.cref(n)})`);
  }

  expr_ImplicitValueInitExpr(n) {
    return { code: '0', prec: PREC.atom, const: '0', rep: 'val' };
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
    const t = nodeType(n);
    // frozen binding: isaac64_init(&ctx, bytes, n) -> ctx = isaac64_init(bytes)
    if (name === 'isaac64_init') {
      let target = args[0];
      if (target.kind === 'UnaryOperator' && target.opcode === '&') target = target.inner[0];
      // the frozen isaac64_init takes the raw Uint8Array, not a CPtr
      let bytesNode = args[1];
      while (bytesNode.kind === 'ImplicitCastExpr') bytesNode = bytesNode.inner[0];
      const bytes = this.emitExpr(bytesNode);
      return { code: `${this.emitExpr(target).code} = isaac64_init(${bytes.code})`, prec: PREC.assign, rep: 'val' };
    }
    if (name === 'isaac64_next_uint64') {
      let target = args[0];
      if (target.kind === 'UnaryOperator' && target.opcode === '&') target = target.inner[0];
      return { code: `isaac64_next_uint64(${this.emitExpr(target).code})`, prec: PREC.atom, rep: 'val' };
    }
    // fortified libc variants: drop the object-size/chk args
    if (name === '__builtin___snprintf_chk') { // (buf, n, flag, objsize, fmt, ...)
      const kept = [args[0], args[1], ...args.slice(4)].map((a) => this.emitExpr(a).code);
      return { code: this.cptrCall('snprintf', ...kept), prec: PREC.atom, rep: 'val' };
    }
    if (name === '__builtin___sprintf_chk') { // (str, flag, objsize, fmt, ...)
      const kept = [args[0], ...args.slice(3)].map((a) => this.emitExpr(a).code);
      return { code: this.cptrCall('sprintf', ...kept), prec: PREC.atom, rep: 'val' };
    }
    if (name === '__builtin___vsnprintf_chk') { // (str, size, flag, objsize, fmt, ap)
      const kept = [args[0], args[1], args[4], args[5]].map((a) => this.emitExpr(a).code);
      return { code: this.cptrCall('vsnprintf', ...kept), prec: PREC.atom, rep: 'val' };
    }
    if (name === '__builtin___strcpy_chk' || name === '__builtin___strcat_chk') { // (dst, src, objsize)
      const kept = [args[0], args[1]].map((a) => this.emitExpr(a).code);
      return { code: this.cptrCall(name.includes('strcpy') ? 'strcpy' : 'strcat', ...kept), prec: PREC.atom, rep: 'cptr' };
    }
    if (name === '__builtin___memcpy_chk') { // (dst, src, n, objsize)
      const kept = [args[0], args[1], args[2]].map((a) => this.emitExpr(a).code);
      return { code: this.cptrCall('memcpy', ...kept), prec: PREC.atom, rep: 'cptr' };
    }
    // varargs builtins (see variadic function emission)
    if (name === '__builtin_va_start') {
      const ap = this.emitExpr(args[0]).code;
      return { code: `${ap} = ${this.vaRest}`, prec: PREC.assign, rep: 'val' };
    }
    if (name === '__builtin_va_end') {
      const ap = this.emitExpr(args[0]).code;
      return { code: `${ap} = null`, prec: PREC.assign, rep: 'val' };
    }
    if (name === 'longjmp' || name === '_longjmp') {
      this.usesCjmp = true;
      return { code: `cjmp.longjmp(${this.setjmpArg(args[0])}, ${this.emitExpr(args[1]).code})`, prec: PREC.atom, rep: 'val' };
    }
    if (name === 'setjmp' || name === '_setjmp') {
      if (!this.setjmpVar) throw new Error(`setjmp outside a recognized if-condition (${this.cref(n)})`);
      this.usesCjmp = true;
      return { code: this.setjmpVar, prec: PREC.atom, rep: 'val' };
    }
    if (name === 'abs') {
      return { code: `Math.abs(${this.emitExpr(args[0]).code})`, prec: PREC.atom, rep: 'val' };
    }
    const callee = this.emitExpr(n.inner[0]);
    const argCodes = args.map((a) => this.emitExpr(a).code);
    if (name && LIBC.has(name)) {
      const rep = ['strcpy', 'strcat', 'strchr', 'strrchr', 'strstr', 'memcpy', 'malloc'].includes(name) ? 'cptr' : 'val';
      return { code: this.cptrCall(name, ...argCodes), prec: PREC.atom, rep };
    }
    return { code: `${this.group(callee, PREC.atom)}(${argCodes.join(', ')})`, prec: PREC.atom, rep: t.cls === 'ptr' ? 'cptr' : 'val' };
  }

  /** identity expression for a jmp_buf argument (decay/member forms) */
  setjmpArg(node) {
    let a = node;
    while (a && (a.kind === 'ImplicitCastExpr' || a.kind === 'ParenExpr' || a.kind === 'CStyleCastExpr')) a = a.inner[0];
    if (a.kind === 'DeclRefExpr' && arrayParts(desugar(a.type))) {
      return this.cptrCall('decay', this.emitExpr(a).code);
    }
    if (a.kind === 'DeclRefExpr') return this.emitExpr(a).code; // pointer variable
    return this.emitLValue(a).code; // member/element: location is the identity
  }

  /** does this subtree contain a setjmp/_setjmp call? */
  hasSetjmp(n) {
    if (!n || typeof n !== 'object') return false;
    if (n.kind === 'CallExpr') {
      const nm = this.calleeName(n);
      if (nm === 'setjmp' || nm === '_setjmp') return true;
    }
    return (n.inner || []).some((c) => this.hasSetjmp(c));
  }

  /**
   * if (setjmp(jb)) / if (setjmp(jb) == 0) / assignment-then-test shapes:
   * emit try/catch with the if re-emitted on both paths; the setjmp call
   * evaluates to 0 on the direct path, to the longjmp value on the catch path
   * (C evaluates the condition once per setjmp return — and so do we).
   */
  emitSetjmpIf(n, indent) {
    const kids = (n.inner || []).filter((c) => c && c.kind);
    const [cond, thenS, elseS] = kids;
    const sj = this.findSetjmp(cond);
    const id = ++this.uniq;
    const idV = `__sj${id}`, valV = `__sv${id}`, errV = `__e${id}`;
    const prevVar = this.setjmpVar;
    const lines = [
      `${indent}{`,
      `${indent}    const ${idV} = cjmp.idOf(${this.setjmpArg(sj.inner[1])});`,
      `${indent}    let ${valV} = 0;`,
      `${indent}    try {`,
    ];
    this.setjmpVar = valV;
    lines.push(...this.emitPlainIf(n, indent + '        '));
    lines.push(`${indent}    } catch (${errV}) {`);
    lines.push(`${indent}        if (!cjmp.matches(${errV}, ${idV})) throw ${errV};`);
    lines.push(`${indent}        ${valV} = cjmp.jbval(${errV});`);
    lines.push(...this.emitPlainIf(n, indent + '        '));
    lines.push(`${indent}    }`);
    lines.push(`${indent}}`);
    this.setjmpVar = prevVar;
    return lines;
  }

  // ----- statements -----

  emitStmt(n, indent) {
    if (!n || !n.kind) return [];
    const fn = this['stmt_' + n.kind];
    if (!fn) {
      if (n.kind.endsWith('Expr') || n.kind.endsWith('Literal') || n.kind.endsWith('Operator')) {
        return [`${indent}${this.emitExpr(n, { stmtPos: true }).code};`];
      }
      throw new Error(`emitStmt: unsupported node kind ${n.kind} (${this.cref(n)})`);
    }
    return fn.call(this, n, indent);
  }

  stmt_CompoundStmt(n, indent) {
    const lines = [`${indent}{`];
    lines.push(...this.emitBlockItems((n.inner || []).filter((x) => x && x.kind), indent + '    '));
    lines.push(`${indent}}`);
    return lines;
  }

  /**
   * Emit a list of block items. A block containing an if-with-setjmp at
   * position k is split there: everything from the if to the end of the
   * block goes into both the try arm (setjmp -> 0) and the catch arm
   * (setjmp -> longjmp value). This matches C: the setjmp handler protects
   * all code that runs after the setjmp returns 0, and a longjmp re-runs
   * the if and everything after it.
   */
  emitBlockItems(items, indent) {
    const sjIdx = items.findIndex((s) => s.kind === 'IfStmt' && this.hasSetjmp((s.inner || []).filter((c) => c && c.kind)[0]));
    if (sjIdx === -1) return items.flatMap((s) => this.emitStmt(s, indent));
    const lines = items.slice(0, sjIdx).flatMap((s) => this.emitStmt(s, indent));
    const rest = items.slice(sjIdx);
    const sjCall = this.findSetjmp((rest[0].inner || []).filter((c) => c && c.kind)[0]);
    const id = ++this.uniq;
    const idV = `__sj${id}`, valV = `__sv${id}`, errV = `__e${id}`;
    const prevVar = this.setjmpVar;
    this.setjmpVar = valV;
    const emitRest = (ind) => [
      ...this.emitPlainIf(rest[0], ind),
      ...rest.slice(1).flatMap((s) => this.emitStmt(s, ind)),
    ];
    lines.push(`${indent}{`);
    lines.push(`${indent}    const ${idV} = cjmp.idOf(${this.setjmpArg(sjCall.inner[1])});`);
    lines.push(`${indent}    let ${valV} = 0;`);
    lines.push(`${indent}    try {`);
    lines.push(...emitRest(indent + '        '));
    lines.push(`${indent}    } catch (${errV}) {`);
    lines.push(`${indent}        if (!cjmp.matches(${errV}, ${idV})) throw ${errV};`);
    lines.push(`${indent}        ${valV} = cjmp.jbval(${errV});`);
    lines.push(...emitRest(indent + '        '));
    lines.push(`${indent}    }`);
    lines.push(`${indent}}`);
    this.setjmpVar = prevVar;
    return lines;
  }

  /** find the first setjmp/_setjmp CallExpr in a subtree */
  findSetjmp(n) {
    if (!n || typeof n !== 'object') return null;
    if (n.kind === 'CallExpr') {
      const nm = this.calleeName(n);
      if (nm === 'setjmp' || nm === '_setjmp') return n;
    }
    for (const c of n.inner || []) {
      const r = this.findSetjmp(c);
      if (r) return r;
    }
    return null;
  }

  stmt_DeclStmt(n, indent) {
    const lines = [];
    for (const d of (n.inner || []).filter((c) => c && c.kind === 'VarDecl')) {
      if (d.storageClass === 'static') continue; // hoisted by emitFunction
      lines.push(`${indent}${this.localVarDecl(d)}`);
    }
    return lines;
  }

  /** storage creation expression for an array-typed variable */
  arrayStorage(q) {
    const arr = arrayParts(q);
    if (!arr) return null;
    if (arrayParts(arr.elem)) { // 2-D char array (visctrl_bufs)
      const inner = arrayParts(arr.elem);
      return `Array.from({ length: ${arr.count} }, () => new Uint8Array(${inner.count}))`;
    }
    if (/\bchar\b/.test(arr.elem)) return `new Uint8Array(${arr.count})`;
    if (/\bint\b/.test(arr.elem) && !/\blong\b/.test(arr.elem)) return `new Array(${arr.count}).fill(0)`;
    throw new Error(`array storage for "${q}" unsupported (v1)`);
  }

  localVarDecl(d) {
    const q = desugar(d.type);
    const init = (d.inner || []).find((c) => c && c.kind);
    const arr = arrayParts(q);
    if (arr) {
      if (init && init.kind === 'StringLiteral') return `let ${d.name} = ${this.cptrCall('bytes', init.value)};`;
      if (init) throw new Error(`array ${d.name} with non-literal init unsupported (${this.cref(d)})`);
      return `let ${d.name} = ${this.arrayStorage(q)};`;
    }
    const t = parseType(q);
    if (t.cls === 'record') {
      // struct/union value local: byte-packed storage, variable holds its CPtr
      const size = this.layoutOf(this.recordNameOf(q)).size;
      if (init) throw new Error(`record local ${d.name} with init unsupported (v1)`);
      this.recordLocals.add(d.name);
      return `let ${d.name} = ${this.cptrCall('alloc', String(size))};`;
    }
    if (init) return `let ${d.name} = ${this.emitExpr(init).code};`;
    return `let ${d.name};`;
  }

  stmt_IfStmt(n, indent) {
    const kids0 = (n.inner || []).filter((c) => c && c.kind);
    if (kids0.length && this.hasSetjmp(kids0[0])) return this.emitSetjmpIf(n, indent);
    return this.emitPlainIf(n, indent);
  }

  emitPlainIf(n, indent) {
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
      if (elseS.kind === 'IfStmt') {
        const elif = this.stmt_IfStmt(elseS, indent);
        lines[lines.length - 1] = elseHead + ' ' + elif[0].trimStart();
        lines.push(...elif.slice(1));
      } else if (elseS.kind === 'CompoundStmt') {
        const block = this.stmt_CompoundStmt(elseS, indent);
        lines[lines.length - 1] = elseHead + ` ${block[0].trimStart()}`;
        lines.push(...block.slice(1));
      } else {
        lines.push(...this.emitStmt(elseS, indent + '    '));
      }
    }
    return lines;
  }

  stmt_ForStmt(n, indent) {
    // clang serializes ForStmt as fixed slots [init, condVar, cond, inc, body]
    // with {} for absent pieces (condVar is C++-only, always {} in C).
    const kids = n.inner || [];
    const body = kids[kids.length - 1];
    const slot = (i) => (kids[i] && kids[i].kind ? kids[i] : null);
    let init = null, cond = null, inc = null;
    if (kids.length === 5) {
      init = slot(0); cond = slot(2); inc = slot(3);
    } else {
      const rest = kids.slice(0, -1).filter((k) => k && k.kind);
      if (rest.length === 3) [init, cond, inc] = rest;
      else if (rest.length === 0) { /* for(;;) */ }
      else throw new Error(`ForStmt shape with ${rest.length} parts unsupported (${this.cref(n)})`);
    }
    const initCode = !init ? '' : init.kind === 'DeclStmt'
      ? this.stmt_DeclStmt(init, '').join(' ').trim().replace(/;$/, '')
      : this.emitExpr(init, { stmtPos: true }).code;
    const condCode = cond ? this.emitExpr(cond).code : '';
    const incCode = inc ? this.emitExpr(inc, { stmtPos: true }).code : '';
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
      return [`${indent}do ${block[0].trimStart()}`, ...block.slice(1, -1), `${indent}} while (${this.emitExpr(cond).code});`];
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
    if (t.cls === 'ptr') return 'CPtr';
    return '*';
  }

  /** find static locals in a function body (they hoist to module scope) */
  collectStaticLocals(fnName, node, out) {
    (function w(n) {
      if (!n || typeof n !== 'object') return;
      if (n.kind === 'VarDecl' && n.storageClass === 'static') out.push(n);
      for (const c of n.inner || []) w(c);
    })(node);
    for (const v of out) this.staticLocals.set(v.id, `__static_${fnName}_${v.name}`);
  }

  hoistStaticLocal(d) {
    const name = this.staticLocals.get(d.id);
    const q = desugar(d.type);
    const init = (d.inner || []).find((c) => c && c.kind);
    if (arrayParts(q)) {
      if (init && init.kind === 'StringLiteral') return `const ${name} = ${this.cptrCall('bytes', init.value)}; /** C ref: ${this.cref(d)} — ${q} (function-static) */`;
      return `const ${name} = ${this.arrayStorage(q)}; /** C ref: ${this.cref(d)} — ${q} (function-static) */`;
    }
    const initCode = init ? this.emitExpr(init).code : q.includes('*') ? 'null' : '0';
    return `let ${name} = ${initCode}; /** C ref: ${this.cref(d)} — ${q} (function-static) */`;
  }

  emitFunction(d) {
    const body = (d.inner || []).find((c) => c && c.kind === 'CompoundStmt');
    const params = (d.inner || []).filter((c) => c && c.kind === 'ParmVarDecl');
    const retQ = d.type.qualType.replace(/\s*\(.*$/, '');
    // static locals hoist to module scope (C lifetime), renamed to stay unique
    this.staticLocals = new Map();
    this.recordLocals = new Set();
    const statics = [];
    this.collectStaticLocals(d.name, body, statics);
    this.vaRest = d.variadic ? '__va' : null;

    const lines = [];
    const paramDoc = params.map((p) => `@param {${this.jsdocType(p.type?.qualType, p.type?.desugaredQualType)}} ${p.name}`).join(' ');
    const retDoc = this.jsdocType(retQ) === 'void' ? '' : ` @returns {${this.jsdocType(retQ)}}`;
    lines.push(`/** C ref: ${this.cref(d)}${paramDoc ? ' — ' + paramDoc : ''}${retDoc} */`);
    const isStatic = d.storageClass === 'static';
    const paramNames = params.map((p) => p.name);
    if (d.variadic) paramNames.push('...__va');
    lines.push(`${isStatic ? '' : 'export '}function ${d.name}(${paramNames.join(', ')}) {`);
    lines.push(...this.emitBlockItems((body.inner || []).filter((x) => x && x.kind), '    '));
    lines.push('}');
    if (statics.length) lines.unshift(...statics.map((s) => this.hoistStaticLocal(s)), '');
    return lines;
  }

  emitTopVar(d) {
    const q = desugar(d.type);
    const init = (d.inner || []).find((c) => c && c.kind);
    const lines = [`/** C ref: ${this.cref(d)} — ${q} */`];
    if (arrayParts(q)) {
      if (init) lines.push(`const ${d.name} = ${this.emitExpr(init).code};`);
      else lines.push(`const ${d.name} = ${this.arrayStorage(q)};`);
      return lines;
    }
    const kw = 'let';
    const initCode = init ? this.emitExpr(init).code : q.includes('*') ? 'null' : '0';
    lines.push(`${kw} ${d.name} = ${initCode};`);
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
    const fields = this.records.get(d.name)?.fields || [];
    return [`/** C ref: ${this.cref(d)} — struct ${d.name} { ${fields.map((f) => f.name).join(', ')} } (memory model v0.5) */`];
  }

  emitModule() {
    const chunks = [];
    for (const d of this.decls) {
      switch (d.kind) {
        case 'FunctionDecl': {
          const hasBody = (d.inner || []).some((c) => c && c.kind === 'CompoundStmt');
          if (!hasBody) break;
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

/** load the hand-written runtime prelude for a file, if one exists */
export function loadPrelude(name) {
  const p = path.join(TOOLS_DIR, 'runtime', `${name}-prelude.js`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trimEnd() : null;
}
