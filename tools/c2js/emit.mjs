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
  coordxy: 'short', size_t: 'unsigned long', ptrdiff_t: 'long', seenV: 'unsigned char', xint16: 'short', xint8: 'signed char', xint32: 'int', xuint8: 'unsigned char', xuint16: 'unsigned short', xuint32: 'unsigned int', aligntyp: 'signed char', quint32: 'unsigned int', winid: 'int', CC_LONG: 'long', utfint: 'unsigned long',
  // Lua 5.4.8 scalar typedefs (llimits.h/lua.h/lobject.h)
  lu_byte: 'unsigned char', ls_byte: 'unsigned char', l_uint32: 'unsigned int', l_int32: 'int', Instruction: 'unsigned int',
  lua_Integer: 'long long', lua_Unsigned: 'unsigned long long', lua_Number: 'double', lua_KContext: 'long long',
  lu_mem: 'unsigned long', l_mem: 'long', l_uacInt: 'unsigned int', StkId: 'StackValue *',
  lua_CFunction: 'void *', lua_KFunction: 'void *', lua_Alloc: 'void *', lua_Writer: 'void *', lua_Reader: 'void *',
  // darwin system types (sys/_types.h / sys/stat.h layouts)
  __int64_t: 'long long', __uint64_t: 'unsigned long long', __int32_t: 'int', __uint32_t: 'unsigned int',
  __int16_t: 'short', __uint16_t: 'unsigned short', __int8_t: 'signed char', __uint8_t: 'unsigned char',
  off_t: 'long long', time_t: 'long', ssize_t: 'long', ino_t: 'unsigned long long', ino64_t: 'unsigned long long',
  dev_t: 'int', mode_t: 'unsigned short', nlink_t: 'unsigned short', uid_t: 'unsigned int', gid_t: 'unsigned int',
  pid_t: 'int', blkcnt_t: 'long long', blksize_t: 'int', useconds_t: 'unsigned int', suseconds_t: 'int',
  va_list: 'char *', genericptr_t: 'void *', nhsym: 'unsigned char', cmdcount_nht: 'long',
  // darwin termios (unixtty.c/ioctl.c)
  cc_t: 'unsigned char', speed_t: 'unsigned long', tcflag_t: 'unsigned long',
};

export function desugar(t) {
  return (t?.desugaredQualType || t?.qualType || '')
    .replace(/\bconst\b|\brestrict\b|\bvolatile\b/g, '')
    .replace(/\b(uint8|uint16|uint32|uint64|sint8|sint16|sint32|sint64|int8_t|int16_t|int32_t|int64_t|uint8_t|uint16_t|uint32_t|uint64_t|uchar|ushort|uint|ulong|coordxy|size_t|ptrdiff_t|seenV|xint16|xint8|xint32|xuint8|xuint16|xuint32|aligntyp|quint32|winid|CC_LONG|utfint|lu_byte|ls_byte|l_uint32|l_int32|Instruction|lua_Integer|lua_Unsigned|lua_Number|lua_KContext|lu_mem|l_mem|l_uacInt|StkId|lua_CFunction|lua_KFunction|lua_Alloc|lua_Writer|lua_Reader|__int64_t|__uint64_t|__int32_t|__uint32_t|__int16_t|__uint16_t|__int8_t|__uint8_t|off_t|time_t|ssize_t|ino_t|ino64_t|dev_t|mode_t|nlink_t|uid_t|gid_t|pid_t|blkcnt_t|blksize_t|useconds_t|suseconds_t|va_list|genericptr_t|nhsym|cmdcount_nht|cc_t|speed_t|tcflag_t)\b/g,
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
  // pointer-to-array: "T (*)[N]" — the pointee is the row array "T [N]"
  const pta = q.match(/^(.*?)\(\s*\*\s*\)(\s*\[.*\])$/);
  if (pta) return `${pta[1].trim()} ${pta[2].trim()}`;
  if (!q.includes('*')) return null;
  return q.replace(/\s*\*\s*$/, '').trim();
}

/** "char[5][5]" -> { elem: 'char[5]', count: 5 }; "int[5]" -> { elem:'int', count:5 } */
function arrayParts(qualType, desugared) {
  const q = (desugared || qualType || '').trim();
  // pointer-to-array "T (*)[N]" is NOT an array: the bracket follows a paren
  // group containing the * (array-of-fn-ptr "int (*[4])(void)" keeps its
  // brackets INSIDE the parens and still matches)
  if (/\(\s*\*[^[\]]*\)\s*\[/.test(q)) return null;
  // peel the FIRST (outermost) bracket, wherever it sits — this also covers
  // function-pointer arrays like "int (*[4])(void)" / "int (*[10][3])(void)"
  const m = q.match(/^(.*?)\[(\d*)\](.*)$/);
  if (!m) return null;
  return { elem: (m[1] + m[3]).trim(), count: m[2] ? Number(m[2]) : null };
}

// JS operator precedence (for minimal parenthesization)
const PREC = { comma: 1, assign: 2, cond: 3, '||': 4, '&&': 5, '|': 6, '^': 7, '&': 8, eq: 9, rel: 10, shift: 11, add: 12, mul: 13, unary: 15, postfix: 16, atom: 18 };
const BIN_PREC = { '||': 4, '&&': 5, '|': 6, '^': 7, '&': 8, '==': 9, '!=': 9, '<': 10, '>': 10, '<=': 10, '>=': 10, '<<': 11, '>>': 11, '>>>': 11, '+': 12, '-': 12, '*': 13, '/': 13, '%': 13 };

/** parenthesize child for use as an operand of an infix op */
function operand(e, parentPrec, side) {
  if (e.prec < parentPrec || (side === 'right' && e.prec === parentPrec)) return { ...e, code: `(${e.code})`, prec: PREC.atom };
  return e;
}

// JS strict-mode reserved words get a $ suffix when used as identifiers
const JS_RESERVED = new Set(('in let class const var function delete typeof new yield await enum static implements interface package private protected public arguments eval this super export import extends finally catch instanceof void with debugger default do else if for while switch case break continue return try throw').split(' '));
export function jsName(name) { return JS_RESERVED.has(name) ? name + '$' : name; }

// libc calls routed to cptr.* (same name)
const LIBC = new Set(['strlen', 'strcpy', 'strcat', 'strncmp', 'strchr', 'strrchr', 'strstr', 'memcpy',
  'malloc', 'free', 'qsort', 'read', 'write', 'isupper', 'tolower', 'sprintf', 'snprintf', 'vsnprintf', 'printf']);

// ------------------------------------------------------------- emitter ----

// bump when emitter behavior changes (invalidates incremental emission)
export const EMIT_VERSION = 3;

export class Emitter {
  constructor({ decls, lineOf, source, fileName, extraRecords, compileCwd, externBoxed, enumValues, recordGlobals, recordArrays }) {
    this.compileCwd = compileCwd;
    this.externBoxed = externBoxed || new Set();
    this.enumValues = enumValues instanceof Map ? enumValues : new Map(enumValues || []);
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
    this.recordGlobals = new Set(recordGlobals || []); // struct/union file-scope vars (byte-packed; seeded corpus-wide from symbols.mjs)
    this.cptrArrays = new Set(recordArrays || []); // byte-packed record arrays (cptr.alloc storage; seeded corpus-wide)
    this.setjmpVar = null; // substitution variable while emitting a setjmp if
    this.uniq = 0;
    this.refs = new Map(); // name -> 'FunctionDecl'|'VarDecl' (cross-file import wiring)
    this.declared = new Set(); // names defined at this file's top level
    this.usesCptr = false;
    this.usesCjmp = false;
    this.anonByLoc = new Map();
    this.collectRecords();
    if (arguments[0].anonByLoc) {
      for (const [k, v] of arguments[0].anonByLoc) {
        const key = `byloc#${k}`;
        if (!this.records.has(key)) this.records.set(key, v);
        this.anonByLoc.set(k, key);
      }
    }
    // header-defined record layouts (full-TU record table from symbols.mjs);
    // main-file records take precedence
    if (extraRecords) {
      for (const [name, rec] of extraRecords) {
        if (!this.records.has(name)) {
          this.records.set(name, { tag: rec.tag, fields: rec.fields.map((f) => ({ name: f.name, q: desugar({ qualType: f.q }), recId: f.recId })) });
        }
      }
    }
  }

  collectRecords() {
    (function walk(n, self) {
      if (!n || typeof n !== 'object') return;
      if (n.kind === 'RecordDecl' && n.completeDefinition) {
        const fields = (n.inner || []).filter((c) => c.kind === 'FieldDecl')
          .map((c) => ({ name: c.name, q: desugar(c.type), recId: self.fieldRecordId(c) }));
        if (fields.length && !self.records.has(n.name || `anon#${n.id}`)) {
          self.records.set(n.name || `anon#${n.id}`, { tag: n.tagUsed || 'struct', fields });
          if (!n.name) {
            const l = n.loc?.line !== undefined ? `${n.loc.line}:${n.loc.col}` : null;
            if (l && !self.anonByLoc.has(l)) {
              self.records.set(`byloc#${l}`, self.records.get(`anon#${n.id}`));
              self.anonByLoc.set(l, `byloc#${l}`);
            }
          }
        }
      }
      for (const c of n.inner || []) walk(c, self);
    })({ kind: 'TranslationUnitDecl', inner: this.decls }, this);
  }

  /** id of the RecordDecl behind a FieldDecl's type, if it's a record type */
  fieldRecordId(fieldNode) {
    let recId;
    (function deep(x) {
      if (!x || typeof x !== 'object' || recId) return;
      if ((x.kind === 'RecordType' || x.kind === 'ElaboratedType') && x.decl?.kind === 'RecordDecl') { recId = x.decl.id; return; }
      for (const c of x.inner || []) deep(c);
    })(fieldNode);
    return recId;
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
        const { size: fs, align } = this.sizeAlignField(f);
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
      const { size, align } = this.sizeAlignField(f);
      off = Math.ceil(off / align) * align;
      offsets[f.name] = off;
      off += size;
      maxAlign = Math.max(maxAlign, align);
    }
    const layout = { size: Math.ceil(off / maxAlign) * maxAlign, align: maxAlign, offsets };
    this.layouts.set(name, layout);
    return layout;
  }

  /** size/align of a field, resolving anonymous record types by recId */
  sizeAlignField(f) {
    try {
      return this.sizeAlign(f.q);
    } catch (e) {
      if (f.recId && this.records.has(`anon#${f.recId}`)) {
        const l = this.layoutOf(`anon#${f.recId}`);
        return { size: l.size, align: l.align };
      }
      throw e;
    }
  }

  sizeAlign(q) {
    const arr = arrayParts(q);
    if (arr) {
      const e = this.sizeAlign(arr.elem);
      return { size: e.size * (arr.count ?? 0), align: e.align };
    }
    if (q.includes('*')) return { size: 8, align: 8 };
    if (/^enum \w+$/.test(q)) return { size: 4, align: 4 };
    const recName = this.recordNameForType(q);
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

  /** convert a raw C string literal to a strict-mode-legal JS literal */
  cStringToJs(raw) {
    // raw includes the surrounding quotes; rewrite octal escapes to hex
    return raw.replace(/\\(\\|[0-7]{1,3}|x[0-9a-fA-F]+|u[0-9a-fA-F]{4}|.)/g, (m, esc) => {
      if (esc === '\\') return '\\\\';
      if (/^[0-7]/.test(esc)) return '\\x' + parseInt(esc, 8).toString(16).padStart(2, '0');
      if (esc === 'a') return '\\x07'; // C \a (bell): not a JS escape
      if (esc === 'e') return '\\x1b'; // GNU \e: not a JS escape
      return '\\' + esc;
    });
  }

  internString(raw) {
    raw = this.cStringToJs(raw);
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
    // pointer -> integer: a stable run-local identity (hash seeds, point2uint)
    if (from.cls === 'ptr' && to.cls === 'int') {
      const a = { code: this.cptrCall('addr', e.code), prec: PREC.atom, rep: 'val' };
      return this.convert(a, { cls: 'int', bits: 64, signed: false }, to);
    }
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

  expr_PredefinedExpr(n) {
    // __func__/__FUNCTION__/__PRETTY_FUNCTION__: clang puts the function
    // name StringLiteral in inner; emit it as a static string
    const lit = (n.inner || []).find((c) => c && c.kind === 'StringLiteral');
    if (!lit) throw new Error(`PredefinedExpr without literal (${this.cref(n)})`);
    return this.expr_StringLiteral(lit);
  }

  expr_ConstantExpr(n) {
    const inner = this.emitExpr(n.inner[0]);
    return { ...inner, const: n.value ?? inner.const };
  }

  expr_DeclRefExpr(n) {
    let name = n.name || n.referencedDecl?.name;
    const refId = n.referencedDecl?.id;
    const refKind = n.referencedDecl?.kind;
    // header enum constants inline as literals (they are compile-time constants)
    if (refKind === 'EnumConstantDecl' && this.enumValues?.has(name)) {
      const v = this.enumValues.get(name);
      return { code: String(v), prec: PREC.atom, const: String(v), rep: 'val' };
    }
    if (name && (refKind === 'FunctionDecl' || refKind === 'VarDecl') && !(refId && this.staticLocals.has(refId))) {
      this.refs.set(name, refKind);
    }
    if (refId && this.staticLocals.has(refId)) name = this.staticLocals.get(refId);
    const bareName = name; // set lookups (recordGlobals/cptrArrays) use undecorated names
    if (this.boxedVars?.has(name) || this.topBoxed?.has(name) || (refKind !== 'FunctionDecl' && this.externBoxed.has(name) && !this.localNames?.has(name))) name = `${jsName(name)}.v`;
    else name = jsName(name);
    const t = nodeType(n);
    const q = desugar(n.type);
    // cptr-backed arrays/records: a same-named local shadows the global unless
    // the ref itself is array/record-typed (then it IS the cptr-backed decl)
    const rep = (this.cptrArrays.has(bareName) && (arrayParts(q) || !this.localNames?.has(bareName))) ? 'cptr'
      : (this.recordGlobals.has(bareName) && ((t.cls === 'record' && !q.includes('*')) || !this.localNames?.has(bareName))) ? 'cptr'
      : arrayParts(q) ? 'buf'
      : this.recordLocals.has(name) ? 'cptr'
      : t.cls === 'record' && !this.isEnumType(q) ? 'obj'
      : t.cls === 'ptr' && !/\(/.test(q) ? 'cptr' : 'val';
    return { code: name, prec: PREC.atom, _type: t, rep };
  }

  /** load a scalar rvalue from a cptr location, by access type */
  loadFrom(locCode, typeQ) {
    const rn = this.recordNameOf(typeQ);
    if (/^enum\s/.test(typeQ || '') || (rn && this.records.get(rn)?.tag === 'enum')) return { code: this.cptrCall('ldI32', locCode), prec: PREC.atom, rep: 'val' };
    const t = parseType(typeQ);
    if (t.cls === 'int' && t.bits === 8) return { code: this.cptrCall(t.signed ? 'ld1s' : 'ld1u', locCode), prec: PREC.atom, rep: 'val' };
    if (t.cls === 'int' && t.bits === 64) return { code: this.cptrCall(t.signed ? 'ldI64' : 'ldU64', locCode), prec: PREC.atom, rep: 'val' };
    if (t.cls === 'int' && t.bits === 32) return { code: this.cptrCall('ldI32', locCode), prec: PREC.atom, rep: 'val' };
    if (t.cls === 'int' && t.bits === 16) return { code: this.cptrCall(t.signed ? 'ldI16' : 'ldU16', locCode), prec: PREC.atom, rep: 'val' };
    if (t.cls === 'f64') return { code: this.cptrCall('ldF64', locCode), prec: PREC.atom, rep: 'val' };
    if (t.cls === 'ptr') return { code: this.cptrCall('ldPtr', locCode), prec: PREC.atom, rep: 'cptr' };
    throw new Error(`loadFrom: unsupported access type "${typeQ}"`);
  }

  storeTo(locCode, typeQ, valueCode) {
    const rn = this.recordNameOf(typeQ);
    if (/^enum\s/.test(typeQ || '') || (rn && this.records.get(rn)?.tag === 'enum')) return this.cptrCall('stI32', locCode, valueCode);
    const t = parseType(typeQ);
    if (t.cls === 'int' && t.bits === 8) return this.cptrCall('st1', locCode, valueCode);
    if (t.cls === 'int' && t.bits === 64) return this.cptrCall('stU64', locCode, valueCode);
    if (t.cls === 'int' && t.bits === 32) return this.cptrCall('stI32', locCode, valueCode);
    if (t.cls === 'int' && t.bits === 16) return this.cptrCall('stI16', locCode, valueCode);
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
      if (arrayParts(arr.elem)) {
        return { code: `${this.group(base, PREC.atom)}[${idx.code}]`, elemQ: arr.elem, rep: 'buf' };
      }
      if (elemT.cls === 'record') {
        const rn = this.recordNameForType(arr.elem);
        if (rn) { // real record element: byte-row storage, scaled location
          const loc = this.cptrCall('add', this.cptrCall('decay', base.code), idx.code, String(this.layoutOf(rn).size));
          return { code: loc, elemQ: arr.elem, rep: 'cptr' };
        }
        return { code: `${this.group(base, PREC.atom)}[${idx.code}]`, elemQ: arr.elem, rep: 'obj' }; // fn-ptr typedef etc: plain JS array
      }
      if (arr.elem === 'int' || arr.elem === 'unsigned int') {
        return { code: `${this.group(base, PREC.atom)}[${idx.code}]`, elemQ: arr.elem, rep: 'val', plain: true };
      }
      // 1-byte element buffer: location through cptr (scale by element size)
      let esz = '1';
      try { const s = this.sizeofType(arr.elem); if (s !== 1) esz = String(s); } catch { /* fn-ptr typedefs etc: stay 1 */ }
      const loc = this.cptrCall('add', this.cptrCall('decay', base.code), idx.code, esz);
      return { code: loc, elemQ: arr.elem, rep: 'cptr' };
    }
    // base is a CPtr
    const pointee = pointeeOf(baseQ);
    if (!pointee) throw new Error('subscript on non-pointer/non-array');
    if (arrayParts(pointee)) {
      // pointer-to-array: scale by the row size; the row stays a location
      return { code: this.cptrCall('add', base.code, idx.code, String(this.sizeofType(pointee))), elemQ: pointee, rep: 'cptr' };
    }
    const elemT = parseType(pointee);
    if (elemT.cls === 'record') {
      const sz = this.layoutOf(this.recordNameForType(pointee)).size;
      return { code: this.cptrCall('add', base.code, idx.code, String(sz)), elemQ: pointee, rep: 'cptr' };
    }
    // scalar pointee: scale by its width (int*/T** subscripts are not bytes)
    let esz = 1;
    try { esz = this.sizeofType(pointee); } catch { /* unknown scalar: stay 1 */ }
    return { code: esz === 1 ? this.cptrCall('add', base.code, idx.code) : this.cptrCall('add', base.code, idx.code, String(esz)), elemQ: pointee, rep: 'cptr' };
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
      // array-typed elements (a row of a multi-dim array) stay a location,
      // like records — parseType alone would say 'ptr' (decay context);
      // enum elements are int-sized values: load them
      if (arrayParts(loc.elemQ) || (elemT.cls === 'record' && !this.isEnumType(loc.elemQ))) return { code: loc.code, prec: PREC.atom, rep: 'cptr', elemQ: loc.elemQ };
      return this.loadFrom(loc.code, loc.elemQ);
    }
    return { code: loc.code, prec: PREC.atom, rep: loc.rep, elemQ: loc.elemQ };
  }

  /** is this type an enum (int-sized value, not record storage)? */
  isEnumType(q) {
    if (!q) return false;
    if (/^enum\s+\w+$/.test(q)) return true;
    const rn = this.recordNameOf(q);
    return !!rn && this.records.get(rn)?.tag === 'enum';
  }

  /** like recordNameOf, but also resolves anonymous record types via loc */
  recordNameForType(q) {
    const named = this.recordNameOf(q);
    if (named && this.records.has(named)) return named;
    if (q && /unnamed|anonymous/.test(q)) {
      const lm = q.match(/:(\d+):(\d+)\)?/);
      if (lm && this.anonByLoc.has(`${lm[1]}:${lm[2]}`)) return this.anonByLoc.get(`${lm[1]}:${lm[2]}`);
    }
    return named;
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
        : fieldQ && parseType(fieldQ).cls === 'ptr' && !/\(/.test(fieldQ) ? 'cptr'
        : fieldQ && !this.isEnumType(fieldQ) && (parseType(fieldQ).cls === 'record' || this.recordNameForType(fieldQ)) ? 'obj' : 'val';
      return { code: `${this.group(base, PREC.atom)}.${n.name}`, prec: PREC.atom, rep, elemQ: fieldQ };
    }
    if (base.rep === 'cptr') {
      // byte-packed struct/union location + field offset (0 for union members)
      const bq = desugar(n.inner[0].type);
      const recName = base.elemRec || this.recordNameForType(pointeeOf(bq) || bq);
      const off = this.fieldOffset(recName, n.name);
      const fi = this.fieldInfoOf(n.inner[0], n.name, recName);
      const fieldQ = fi?.q;
      const loc = off === 0 ? base.code : this.cptrCall('add', base.code, String(off));
      // record/array fields: the location itself is the value (decays later);
      // enum-typed fields are int-sized VALUES — load them, never take the address
      if (arrayParts(fieldQ) || (parseType(fieldQ).cls === 'record' && !this.isEnumType(fieldQ))) {
        return { code: loc, prec: PREC.atom, rep: 'cptr', elemQ: fieldQ, elemRec: this.fieldRecordName(fi) };
      }
      return { ...this.loadFrom(loc, fieldQ), locCode: loc, elemQ: fieldQ };
    }
    throw new Error(`MemberExpr .${n.name} on rep ${base.rep} unsupported (${this.cref(n)})`);
  }

  fieldTypeOf(baseNode, fieldName) {
    return this.fieldInfoOf(baseNode, fieldName)?.q;
  }

  fieldInfoOf(baseNode, fieldName, recNameOverride) {
    const bq = desugar(baseNode.type);
    const recName = recNameOverride || this.recordNameForType(pointeeOf(bq) || bq);
    return this.records.get(recName)?.fields.find((x) => x.name === fieldName);
  }

  /** record name for a field type that may be an anonymous record */
  fieldRecordName(fi) {
    if (!fi) return undefined;
    const byName = this.recordNameOf(fi.q);
    if (byName && this.records.has(byName)) return byName;
    if (fi.recId && this.records.has(`anon#${fi.recId}`)) return `anon#${fi.recId}`;
    return byName;
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
    if (arrRef && eltRef && arrRef === eltRef) {
      // cptr-backed arrays (record/pointer arrays) have no JS .length — use the count
      if (this.cptrArrays.has(arrRef)) {
        const cnt = this.__sizeIdiomCount;
        return cnt ? String(cnt) : null;
      }
      return `${arrRef}.length`;
    }
    return null;
  }

  sizeofArrayRef(uett, viaSubscript = false) {
    let arg = uett.inner?.[0];
    while (arg && arg.kind === 'ParenExpr') arg = arg.inner[0];
    if (!arg) return null;
    let base;
    if (viaSubscript) {
      if (arg.kind !== 'ArraySubscriptExpr') return null;
      base = arg.inner[0];
      while (base.kind === 'ImplicitCastExpr') base = base.inner[0];
    } else {
      base = arg;
    }
    if (base.kind !== 'DeclRefExpr' || !/\[\d*\]/.test(base.type?.qualType || '')) return null;
    const cntM = (base.type.qualType || '').match(/\[(\d+)\]/);
    this.__sizeIdiomCount = cntM ? cntM[1] : null;
    const refId = base.referencedDecl?.id;
    if (refId && this.staticLocals.has(refId)) return this.staticLocals.get(refId);
    return base.name || base.referencedDecl?.name;
  }

  expr_OffsetOfExpr(n) {
    // clang's JSON dump drops offsetof components; recover offsetof(T, f)
    // from source text. The expansion site names a macro (or is a direct
    // offsetof call); BFS through macro bodies for defs containing offsetof;
    // multiple offsetof in one def are matched by per-site occurrence order.
    const loc = n.range?.begin?.expansionLoc || n.range?.begin || {};
    if (!loc.file || loc.offset === undefined) throw new Error(`OffsetOfExpr without expansion site (${this.cref(n)})`);
    const siteFile = path.isAbsolute(loc.file) ? loc.file : path.resolve(this.compileCwd || '.', loc.file);
    const src = this.readSourceCached(siteFile);
    const at = src.slice(loc.offset);
    let matches = null;
    const direct = at.match(/^offsetof\s*\(\s*([\w\s*]+?)\s*,\s*(\w+)\s*\)/);
    if (direct) matches = [[direct[1], direct[2]]];
    else {
      // BFS: outer macro, identifiers in its invocation, then macro bodies
      const ids = [at.match(/^(\w+)/)?.[1], ...[...at.slice(0, 300).matchAll(/\b([a-zA-Z_]\w*)\s*\(/g)].map((m) => m[1])];
      const seen = new Set();
      const queue = ids.filter(Boolean);
      while (queue.length && !matches) {
        const name = queue.shift();
        if (seen.has(name)) continue;
        seen.add(name);
        const def = this.findMacroDef(name, siteFile);
        if (!def) continue;
        const offs = [...def.matchAll(/offsetof\s*\(\s*([\w\s*]+?)\s*,\s*(\w+)\s*\)/g)];
        if (offs.length) { matches = offs.map((m) => [m[1], m[2]]); break; }
        for (const m of def.matchAll(/\b([a-zA-Z_]\w*)\s*\(/g)) queue.push(m[1]);
      }
    }
    if (!matches) throw new Error(`OffsetOfExpr: no offsetof macro found (${this.cref(n)})`);
    if (!this._offsetofSites) this._offsetofSites = new Map();
    const key = `${siteFile}:${loc.offset}`;
    const occ = this._offsetofSites.get(key) || 0;
    this._offsetofSites.set(key, occ + 1);
    const [typeName, memberName] = matches[Math.min(occ, matches.length - 1)];
    const recName = this.recordNameOf(typeName.trim().replace(/^(struct|union)\s+/, ''));
    const off = this.fieldOffset(recName, memberName);
    const t = nodeType(n);
    return { code: t.bits === 64 ? `${off}n` : String(off), prec: PREC.atom, const: String(off), rep: 'val' };
  }

  readSourceCached(file) {
    if (!this._srcCache) this._srcCache = new Map();
    const p = file;
    if (!this._srcCache.has(p)) {
      // resolve relative header paths against known roots
      const candidates = [p, path.resolve(this.compileCwd || '.', p)];
      let text = null;
      for (const c of candidates) { try { text = fs.readFileSync(c, 'utf8'); break; } catch {} }
      if (text === null) throw new Error(`cannot read source ${file}`);
      this._srcCache.set(p, text);
    }
    return this._srcCache.get(p);
  }

  findMacroDef(name, inFile) {
    const dir = path.dirname(path.isAbsolute(inFile) ? inFile : path.resolve(this.compileCwd || '.', inFile));
    const candidates = [];
    for (const d of [dir, path.join(dir, '../include')]) {
      try { for (const f of fs.readdirSync(d)) if (f.endsWith('.h')) candidates.push(path.join(d, f)); } catch {}
    }
    candidates.push(inFile);
    const startRe = new RegExp(`^\\s*#define\\s+${name}\\b`, 'm');
    for (const c of candidates) {
      let text;
      try { text = this.readSourceCached(c); } catch { continue; }
      const m = text.match(startRe);
      if (!m) continue;
      // ^\s* may swallow preceding newlines; anchor on the #define itself
      const defStart = text.indexOf('#define', m.index);
      let end = text.indexOf('\n', defStart);
      while (end > 0 && text[end - 1] === '\\') end = text.indexOf('\n', end + 1);
      return text.slice(defStart, end < 0 ? text.length : end);
    }
    return null;
  }

  expr_AddrLabelExpr(n) {
    // &&label inside a dispatch-table initializer: the label's name; the
    // state machine maps names to numbers via __smNums
    return { code: `"${n.name}"`, prec: PREC.atom, rep: 'val' };
  }

  expr_VAArgExpr(n) {
    // va_arg(ap, T): cursor read honoring default argument promotions
    const ap = this.emitExpr(n.inner[0]).code;
    const t = nodeType(n);
    let tag = 'ptr';
    if (t.cls === 'f64') tag = 'f64';
    else if (t.cls === 'int') {
      if (t.bits === 64) tag = t.signed ? 'i64' : 'u64';
      else tag = t.signed ? 'i32' : 'u32'; // char/short promote to int
    }
    return { code: this.cptrCall('vaArg', ap, `'${tag}'`), prec: PREC.atom, rep: t.cls === 'ptr' ? 'cptr' : 'val' };
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
    const recName = this.recordNameForType(q);
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
          const pointee = pointeeOf(desugar(sub.type)) || 'char';
          const sz = this.sizeofType(pointee);
          const szArg = sz !== 1 ? `, ${sz}` : '';
          // pointer variable inc/dec
          if (sub.kind === 'DeclRefExpr') {
            const name = this.emitExpr(sub).code;
            const delta = n.opcode === '++' ? '1' : '-1';
            const addArgs = sz !== 1 ? `${delta}, ${sz}` : delta;
            if (opts.stmtPos) return { code: `${name} = ${this.cptrCall('add', name, addArgs)}`, prec: PREC.assign, rep: 'val' };
            const helper = (n.isPostfix ? 'post' : 'pre') + (n.opcode === '++' ? 'inc' : 'dec');
            return { code: this.cptrCall(helper, `() => ${name}`, `(v) => { ${name} = v; }${szArg}`), prec: PREC.atom, rep: 'cptr' };
          }
          // pointer member/element inc/dec: read-modify-write through the location
          const loc = this.emitLValue(sub);
          const helper = (n.isPostfix ? 'post' : 'pre') + (n.opcode === '++' ? 'inc' : 'dec');
          if (loc.kind === 'cptr') {
            return { code: this.cptrCall(helper, `() => ${this.cptrCall('ldPtr', loc.code)}`, `(v) => { ${this.cptrCall('stPtr', loc.code, 'v')}; }${szArg}`), prec: PREC.atom, rep: 'cptr' };
          }
          if (loc.kind === 'prop') {
            return { code: this.cptrCall(helper, `() => ${loc.code}`, `(v) => { ${loc.code} = v; }${szArg}`), prec: PREC.atom, rep: 'cptr' };
          }
          throw new Error(`++/-- on pointer lvalue kind ${loc.kind} (${this.cref(n)})`);
        }
        // scalar location (tstr[i]++, ++*count, (*length_p)++, rec->field++, ...)
        let subU = sub;
        while (subU.kind === 'ParenExpr') subU = subU.inner[0];
        if (subU.kind === 'ArraySubscriptExpr' || subU.kind === 'UnaryOperator' || subU.kind === 'MemberExpr') {
          const loc = this.emitLValue(subU);
          if (loc.kind === 'cptr') {
            const t = parseType(loc.elemQ);
            if (t.bits === 8 && n.isPostfix && n.opcode === '++') return { code: this.cptrCall('postinc1', loc.code), prec: PREC.atom, rep: 'val' };
            const one = t.bits === 64 ? '1n' : '1';
            const ld = t.bits === 64 ? 'ldU64' : t.bits === 32 ? 'ldI32' : t.bits === 16 ? 'ldI16' : t.signed ? 'ld1s' : 'ld1u';
            const st = t.bits === 64 ? 'stU64' : t.bits === 32 ? 'stI32' : t.bits === 16 ? 'stI16' : 'st1';
            const delta = n.opcode === '++' ? one : `-${one}`;
            const store = this.cptrCall(st, loc.code, `${this.cptrCall(ld, loc.code)} + ${delta}`);
            // prefix: the store yields the new value; postfix: subtract the
            // signed delta back to recover the old value
            if (!n.isPostfix) return { code: store, prec: PREC.atom, rep: 'val' };
            return { code: `(${store}) - (${delta})`, prec: PREC.add, rep: 'val' };
          }
        }
        return { code: n.isPostfix ? `${this.group(this.emitExpr(sub), PREC.postfix)}${n.opcode}` : `${n.opcode}${this.group(this.emitExpr(sub), PREC.unary)}`, prec: n.isPostfix ? PREC.postfix : PREC.unary, rep: 'val' };
      }
      case '-': case '!': case '~': {
        const e = this.emitExpr(sub);
        // 64-bit ~: JS BigInt ~ is infinite-precision (~0n = -1n); C wraps to
        // the operand width — mask with the operand's signedness
        if (n.opcode === '~' && subT.cls === 'int' && subT.bits === 64) {
          return { code: `BigInt.as${subT.signed === false ? 'Uint' : 'Int'}N(64, ~${this.group(e, PREC.atom)})`, prec: PREC.atom, rep: 'val' };
        }
        return { code: `${n.opcode}${this.group(e, PREC.unary)}`, prec: PREC.unary, rep: 'val' };
      }
      case '&': { // address-of
        // register cross-file refs (the branches below can emit the name
        // without going through expr_DeclRefExpr, e.g. boxed globals)
        if (sub.kind === 'DeclRefExpr') {
          const nm = sub.name || sub.referencedDecl?.name;
          const rk = sub.referencedDecl?.kind;
          if (nm && (rk === 'FunctionDecl' || rk === 'VarDecl') && !(sub.referencedDecl?.id && this.staticLocals.has(sub.referencedDecl?.id))) this.refs.set(nm, rk);
        }
        // address of an array: decays to a pointer to its storage
        if (sub.kind === 'DeclRefExpr' && arrayParts(desugar(sub.type))) {
          const nm = this.emitExpr(sub).code;
          if (this.cptrArrays.has(nm) || this.cptrArrays.has(sub.name || sub.referencedDecl?.name)) {
            return { code: nm, prec: PREC.atom, rep: 'cptr' };
          }
          return { code: this.cptrCall('decay', nm), prec: PREC.atom, rep: 'cptr' };
        }
        // address of a function designator is the function pointer itself
        if (sub.kind === 'DeclRefExpr' && /\(/.test(desugar(sub.type))) {
          return { ...this.emitExpr(sub), rep: 'val' };
        }
        // boxed variable (local, static-local, or global): the box IS the address
        if (sub.kind === 'DeclRefExpr') {
          const bareNm = sub.name || sub.referencedDecl?.name;
          const boxNm = this.staticLocals.get(sub.referencedDecl?.id) || bareNm;
          if (this.boxedVars?.has(boxNm) || (this.externBoxed.has(bareNm) && !this.localNames?.has(bareNm))) {
            // scalar box: the box is its address; record box: the .v storage is
            const sq = desugar(sub.type);
            const recBox = parseType(sq).cls === 'record' && !sq.includes('*') && !this.isEnumType(sq);
            return { code: recBox ? `${jsName(boxNm)}.v` : jsName(boxNm), prec: PREC.atom, rep: 'cptr' };
          }
        }
        // struct/union variable (local, global, or extern): its storage is its address
        if (sub.kind === 'DeclRefExpr' && parseType(desugar(sub.type)).cls === 'record' && !desugar(sub.type).includes('*')) {
          return { code: this.emitExpr(sub).code, prec: PREC.atom, rep: 'cptr' };
        }
        const loc = this.emitLValue(sub);
        if (loc.kind === 'cptr') return { code: loc.code, prec: PREC.atom, rep: 'cptr' };
        if (loc.kind === 'prop' && loc.objCode !== undefined) {
          if (loc.viaArray) { // &arr[i] on a plain JS array: pointer into it
            return { code: this.cptrCall('add', this.cptrCall('decay', loc.objCode), loc.keyCode), prec: PREC.atom, rep: 'cptr' };
          }
          return { code: this.cptrCall('boxProp', loc.objCode, loc.keyCode), prec: PREC.atom, rep: 'cptr' };
        }
        throw new Error(`address-of ${loc.kind} unsupported (v1) (${this.cref(n)})`);
      }
      case '*': { // deref
        const e = this.emitExpr(sub);
        const pointee = pointeeOf(desugar(sub.type)) || '';
        if (/\(/.test(pointee)) return { ...e, rep: 'val' }; // function pointer deref: the function itself
        const pt = parseType(pointee);
        if (pt.cls === 'record' && !this.isEnumType(pointee)) return { ...e, rep: 'cptr', elemQ: pointee }; // struct location
        return this.loadFrom(e.code, pointee);
      }
      case '__extension__': // GNU extension keyword: transparent
        return this.emitExpr(sub);
      default:
        throw new Error(`unsupported unary op ${n.opcode} (${this.cref(n)})`);
    }
  }

  /** emit an lvalue: {kind:'var'|'cptr'|'prop', code, elemQ?} */
  emitLValue(n) {
    if (n.kind === 'DeclRefExpr') {
      // struct/union local: the variable itself is the CPtr location
      const rawName = n.name || n.referencedDecl?.name;
      const refId = n.referencedDecl?.id;
      const hoisted = refId && this.staticLocals.get(refId);
      if (this.recordLocals.has(rawName) || (this.recordGlobals.has(rawName) && (parseType(desugar(n.type)).cls === 'record' || !this.localNames?.has(rawName))) || (hoisted && this.recordLocals.has(hoisted))) {
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
      return { kind: 'prop', code: loc.code, elemQ: loc.elemQ, objCode: base.code, keyCode: idx.code, viaArray: true };
    }
    if (n.kind === 'MemberExpr') {
      const base = this.emitExpr(n.inner[0]);
      if (base.rep === 'obj') return { kind: 'prop', code: `${this.group(base, PREC.atom)}.${n.name}`, elemQ: this.fieldTypeOf(n.inner[0], n.name), objCode: base.code, keyCode: `'${n.name}'` };
      if (base.rep === 'cptr') {
        const bq = desugar(n.inner[0].type);
        const recName = base.elemRec || this.recordNameForType(pointeeOf(bq) || bq);
        const off = this.fieldOffset(recName, n.name);
        return { kind: 'cptr', code: off === 0 ? base.code : this.cptrCall('add', base.code, String(off)), elemQ: this.fieldInfoOf(n.inner[0], n.name, recName)?.q };
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
      if (lv.kind !== 'cptr' && nodeType(n).cls === 'ptr' && !/\(/.test(desugar(n.type))) {
        return { code: `${lv.code} = ${operand(r, PREC.assign, 'right').code}`, prec: PREC.assign, rep: 'cptr' };
      }
      if (lv.kind === 'cptr') {
        // struct/union assignment copies the bytes (C11 6.5.16.1)
        const recName = lv.elemQ && this.recordNameOf(lv.elemQ);
        if (recName && this.records.get(recName)?.tag !== 'enum' && (parseType(lv.elemQ).cls === 'record' || this.records.has(recName))) {
          return { code: this.cptrCall('memcpy', lv.code, r.code, String(this.layoutOf(recName).size)), prec: PREC.atom, rep: 'val' };
        }
        return { code: this.storeTo(lv.code, lv.elemQ, r.code), prec: PREC.atom, rep: 'val' };
      }
      return { code: `${lv.code} = ${operand(r, PREC.assign, 'right').code}`, prec: PREC.assign, rep: r.rep === 'cptr' ? 'cptr' : 'val' };
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
      // C11 6.5.13/14: the result is int 0 or 1 — JS would yield the raw
      // operand (breaks narrow casts/stores of the result, e.g. boolean())
      return { code: `${operand(l0, p, 'left').code} ${op} ${operand(r0, p, 'right').code} ? 1 : 0`, prec: PREC.cond, rep: 'val' };
    }
    // pointer arithmetic
    if ((op === '+' || op === '-') && (lT.cls === 'ptr' || rT.cls === 'ptr') && !(lT.cls === 'ptr' && rT.cls === 'ptr' && op === '+')) {
      if (lT.cls === 'ptr' && rT.cls === 'ptr') { // ptrdiff (long): elements, not bytes
        const pointee = pointeeOf(lQ) || 'char';
        let esz = 1;
        try { esz = this.sizeofType(pointee); } catch { /* unknown: bytes */ }
        const d = this.cptrCall('diff', l0.code, r0.code);
        return { code: esz === 1 ? d : `${d} / ${esz}n`, prec: PREC.div, rep: 'val' };
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
    if (t.bits === 64) {
      // BigInt + - * do NOT wrap: C 64-bit arithmetic does (e.g. 0u-1 wraps to
      // 2^64-1 — without this, unsigned comparisons on the result misfire)
      if (op === '+' || op === '-' || op === '*')
        return { code: `BigInt.as${t.signed === false ? 'Uint' : 'Int'}N(64, ${raw})`, prec: PREC.atom, rep: 'val' };
      return { code: raw, prec: p, rep: 'val' }; // div/mod truncate like C
    }
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
      // read-modify-write through a byte location, width from the pointee
      // type; loc must be side-effect-free (double-emitted — documented caveat)
      const eT = this.isEnumType(lv.elemQ) ? { cls: 'int', bits: 32, signed: true } : parseType(lv.elemQ);
      const rT0 = nodeType(n.inner[1]);
      const ld = this.loadFrom(lv.code, lv.elemQ).code;
      const st = (expr) => ({ code: this.storeTo(lv.code, lv.elemQ, expr), prec: PREC.atom, rep: 'val' });
      if (eT.cls === 'ptr') {
        const helper = base === '+' ? 'add' : 'sub';
        const pointee = pointeeOf(lv.elemQ) || 'char';
        let esz = 1;
        try { esz = this.sizeofType(pointee); } catch { /* unknown: stay 1 */ }
        return st(esz === 1 ? this.cptrCall(helper, ld, r0.code) : this.cptrCall(helper, ld, r0.code, String(esz)));
      }
      if (eT.cls === 'f64') return st(`${ld} ${base} ${operand(r0, PREC.add, 'right').code}`);
      if (eT.bits !== 64 && rT0.cls === 'int' && rT0.bits === 64) {
        // narrow lvalue (8/16/32-bit), 64-bit RHS: clang's compound-assign AST
        // carries no operand casts — compute wide, narrow on store
        const lE = this.convert({ code: ld, prec: PREC.atom, rep: 'val' }, eT, rT0);
        const wide = `${this.group(lE, PREC.atom)} ${base} ${this.group(operand(r0, PREC.add, 'right'), PREC.atom)}`;
        return st(this.convert({ code: wide, prec: PREC.atom, rep: 'val' }, rT0, eT).code);
      }
      if (eT.bits === 64) {
        const r = this.convert(r0, rT0, eT);
        return st(`${ld} ${base} ${this.group(operand(r, PREC.add, 'right'), PREC.atom)}`);
      }
      if (eT.bits === 32 || eT.bits === undefined) {
        const r = operand(r0, PREC.add, 'right');
        if (base === '+') return st(`(${ld} + ${r.code}) | 0`);
        if (base === '-') return st(`(${ld} - ${r.code}) | 0`);
        if (base === '*') return st(`Math.imul(${ld}, ${r0.code})`);
        if (base === '/') return st(`(${ld} / ${r.code}) | 0`);
        return st(`${ld} ${base} ${r.code}`); // % & | ^ << >> — JS matches C int
      }
      // 8/16-bit: the load sign/zero-extends per type, compute in int, the
      // store truncates (st1/stI16) — C's convert-on-assign semantics
      return st(`${ld} ${base} ${operand(r0, PREC.add, 'right').code}`);
    }
    const l = { code: lv.code, prec: PREC.atom };
    // pointer variable compound assignment (bp += len): scale by pointee size
    if (parseType(lv.elemQ).cls === 'ptr') {
      const helper = base === '+' ? 'add' : 'sub';
      const pointee = pointeeOf(lv.elemQ) || 'char';
      let esz = 1;
      try { esz = this.sizeofType(pointee); } catch { /* unknown: stay 1 */ }
      const scaled = esz === 1 ? this.cptrCall(helper, lv.code, r0.code) : this.cptrCall(helper, lv.code, r0.code, String(esz));
      return { code: `${lv.code} = ${scaled}`, prec: PREC.assign, rep: 'val' };
    }
    if (t.cls === 'f64') {
      return { code: `${lv.code} ${op} ${operand(r0, PREC.assign, 'right').code}`, prec: PREC.assign, rep: 'val' };
    }
    if (t.cls === 'int' && t.bits === 64) {
      const r = this.convert(r0, nodeType(n.inner[1]), t);
      return { code: `${lv.code} ${op} ${operand(r, PREC.assign, 'right').code}`, prec: PREC.assign, rep: 'val' };
    }
    // 32-bit-or-narrower lvalue with a 64-bit RHS: clang's compound-assign AST
    // carries no operand casts, so apply usual arithmetic conversions here —
    // compute in the 64-bit common type, narrow on store
    const rT = nodeType(n.inner[1]);
    if (t.cls === 'int' && t.bits <= 32 && rT.cls === 'int' && rT.bits === 64) {
      const lE = this.convert({ code: lv.code, prec: PREC.atom, rep: 'val' }, nodeType(n.inner[0]), rT);
      const wide = { code: `${this.group(lE, PREC.atom)} ${base} ${this.group(operand(r0, PREC.add, 'right'), PREC.atom)}`, prec: PREC.atom, rep: 'val' };
      const narrowed = this.convert(wide, rT, t);
      return { code: `${lv.code} = ${narrowed.code}`, prec: PREC.assign, rep: 'val' };
    }
    if (t.cls === 'int' && t.bits === 32) {
      const r = operand(r0, PREC.add, 'right');
      if (base === '+') return { code: `${lv.code} = (${lv.code} + ${r.code}) | 0`, prec: PREC.assign, rep: 'val' };
      if (base === '-') return { code: `${lv.code} = (${lv.code} - ${r.code}) | 0`, prec: PREC.assign, rep: 'val' };
      if (base === '*') return { code: `${lv.code} = Math.imul(${lv.code}, ${r0.code})`, prec: PREC.assign, rep: 'val' };
      if (base === '/') return { code: `${lv.code} = (${lv.code} / ${r.code}) | 0`, prec: PREC.assign, rep: 'val' };
      return { code: `${lv.code} ${op} ${operand(r0, PREC.assign, 'right').code}`, prec: PREC.assign, rep: 'val' };
    }
    // 16-bit variable compound assign (RHS sits right of the operator:
    // parenthesize at the operator's own precedence, e.g. x -= c ? 2 : 1)
    if (t.cls === 'int' && t.bits === 16) {
      const helper = parseType(lv.elemQ).signed === false ? 'u16' : 'i16';
      this.cmachine.add(helper);
      return { code: `${lv.code} = ${helper}(${lv.code} ${base} ${operand(r0, BIN_PREC[base] ?? PREC.assign, 'right').code})`, prec: PREC.assign, rep: 'val' };
    }
    // narrow (char) variable compound assign: compute in int, truncate on store
    if (t.cls === 'int' && t.bits === 8) {
      const helper = parseType(lv.elemQ).signed === false ? 'uchar' : 'schar';
      this.cmachine.add(helper);
      return { code: `${lv.code} = ${helper}(${lv.code} ${base} ${operand(r0, BIN_PREC[base] ?? PREC.assign, 'right').code})`, prec: PREC.assign, rep: 'val' };
    }
    throw new Error(`compound assign ${op} on ${JSON.stringify(t)} unsupported (${this.cref(n)})`);
  }

  expr_ConditionalOperator(n) {
    const c = this.emitExpr(n.inner[0]);
    const a = this.emitExpr(n.inner[1]);
    const b = this.emitExpr(n.inner[2]);
    // the condition position follows C's logical-OR-expression grammar: a
    // same-precedence (ternary/assignment) condition must be parenthesized —
    // 'right' side forces that for ?:, which is right-associative
    return { code: `${operand(c, PREC.cond, 'right').code} ? ${a.code} : ${operand(b, PREC.cond, 'right').code}`, prec: PREC.cond, rep: a.rep };
  }

  /**
   * Effective element list of an InitListExpr. Clang's JSON has two shapes:
   * elements in `inner` (ImplicitValueInitExpr placeholders for gaps), or —
   * when trailing elements are zero-filled — an `array_filler` array whose
   * [0] is the filler expr and [1..] are the explicit element inits, with
   * `inner` empty. Storage is zero-initialized, so the filler itself needs
   * no stores.
   */
  initListElems(n) {
    const inner = (n.inner || []).filter((c) => c && c.kind);
    if (inner.length || !Array.isArray(n.array_filler)) return inner;
    return n.array_filler.slice(1).filter((c) => c && c.kind);
  }

  expr_InitListExpr(n) {
    const q = desugar(n.type);
    const inits = this.initListElems(n);
    // compound literals of pointer/array-of-fn-ptr type: (T[]){...}
    if (q.includes('(*') || q.trim().endsWith('*')) {
      const items = inits.map((c) => this.emitExpr(c).code);
      return { code: `[${items.join(', ')}]`, prec: PREC.atom, rep: 'buf' };
    }
    const arrM = q.match(/^(.*)\[(\d*)\]$/);
    if (arrM && (/^(struct|union)/.test(arrM[1].trim()) || this.recordNameForType(arrM[1].trim()))) {
      const items = inits.map((c) => this.emitExpr(c).code);
      return { code: `[\n${items.map((s) => '    ' + s).join(',\n')}\n]`, prec: PREC.atom, rep: 'buf' };
    }
    // record literal (named or anonymous): zip initializers with field names
    let initFields = null;
    const recM = q.match(/^(?:struct|union) (\w+)$/);
    const rnForInit = recM ? recM[1] : this.recordNameForType(q);
    if (rnForInit && this.records.has(rnForInit)) initFields = this.records.get(rnForInit).fields;
    else if (/unnamed|anonymous/.test(q)) {
      const lm = q.match(/:(\d+):(\d+)\)?/);
      if (lm && this.anonByLoc.has(`${lm[1]}:${lm[2]}`)) initFields = this.records.get(this.anonByLoc.get(`${lm[1]}:${lm[2]}`)).fields;
    }
    if (initFields) {
      const parts = [];
      for (let i = 0; i < initFields.length; i++) {
        const init = inits[i];
        if (!init || init.kind === 'ImplicitValueInitExpr') continue;
        parts.push(`${initFields[i].name}: ${this.emitExpr(init).code}`);
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
      const lv = this.emitLValue(target);
      if (lv.kind === 'cptr') return { code: this.cptrCall('stPtr', lv.code, `isaac64_init(${bytes.code})`), prec: PREC.atom, rep: 'val' };
      return { code: `${lv.code} = isaac64_init(${bytes.code})`, prec: PREC.assign, rep: 'val' };
    }
    if (name === 'isaac64_next_uint64') {
      let target = args[0];
      if (target.kind === 'UnaryOperator' && target.opcode === '&') target = target.inner[0];
      const lv = this.emitLValue(target);
      const ctxCode = lv.kind === 'cptr' ? this.cptrCall('ldPtr', lv.code) : lv.code;
      return { code: `isaac64_next_uint64(${ctxCode})`, prec: PREC.atom, rep: 'val' };
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
      return { code: `${ap} = ${this.cptrCall('vaList', this.vaRest)}`, prec: PREC.assign, rep: 'val' };
    }
    if (name === '__builtin_va_copy') {
      const dst = this.emitExpr(args[0]).code;
      const src = this.emitExpr(args[1]).code;
      return { code: `${dst} = ${this.cptrCall('vaCopy', src)}`, prec: PREC.assign, rep: 'val' };
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
   * Per-function goto analysis. Returns {
   *   blockLabels: Map(blockNode -> [{name, index, dir}]),
   *   gotoDir: Map(GotoStmt node -> {kind:'break'|'continue', label})
   * } or null when the function has no gotos. Throws on shapes we do not
   * lower (mixed forward/backward per label, goto into nested blocks).
   */
  analyzeGotos(fnName, body) {
    const labels = new Map(); // name -> {block, index}
    const gotos = [];
    const parent = new Map(); // node -> parent node
    (function walk(n, block, par) {
      if (!n || typeof n !== 'object') return;
      if (par) parent.set(n, par);
      const isBlock = n.kind === 'CompoundStmt' || n === body;
      const blk = isBlock ? n : block;
      if (isBlock) {
        const items = (n.inner || []).filter((c) => c && c.kind);
        items.forEach((c, i) => {
          if (c.kind === 'LabelStmt') labels.set(c.name, { name: c.name, block: n, index: i, node: c });
          // labels nested in case chains belong to this block too
          if (c.kind === 'CaseStmt' || c.kind === 'DefaultStmt') {
            (function chain(x) {
              if (!x || typeof x !== 'object') return;
              if (x.kind === 'LabelStmt') labels.set(x.name, { name: x.name, block: n, index: i, node: x });
              for (const cc of x.inner || []) {
                if (cc.kind === 'CaseStmt' || cc.kind === 'DefaultStmt' || cc.kind === 'LabelStmt') chain(cc);
              }
            })(c);
          }
        });
      }
      if (n.kind === 'GotoStmt') gotos.push(n);
      for (const c of n.inner || []) walk(c, blk, n);
    })(body, body, null);
    if (!gotos.length && !labels.size) return null;

    // nearest enclosing block of a node; index of its ancestor item within a block
    const blockOf = (node) => {
      let cur = node;
      while (cur && cur.kind !== 'CompoundStmt' && cur !== body) cur = parent.get(cur);
      return cur;
    };
    const indexWithin2 = (node, block) => {
      let cur = node;
      while (cur && parent.get(cur) !== block) cur = parent.get(cur);
      if (!cur) return -1;
      const items = (block.inner || []).filter((c) => c && c.kind);
      return items.indexOf(cur);
    };
    const ancestorsOf = (node) => {
      const out = [];
      let cur = blockOf(node);
      while (cur) { out.push(cur); cur = parent.get(cur) ? blockOf(parent.get(cur)) : null; }
      return out;
    };

    // index of the goto's ancestor item within the label's block
    const indexWithin = (gotoNode, block) => {
      // walk parents is unavailable; instead search the block subtree
      const items = (block.inner || []).filter((c) => c && c.kind);
      for (let i = 0; i < items.length; i++) {
        if (items[i] === gotoNode) return i;
        let found = false;
        (function deep(x) {
          if (!x || typeof x !== 'object' || found) return;
          if (x === gotoNode) { found = true; return; }
          for (const c of x.inner || []) deep(c);
        })(items[i]);
        if (found) return i;
      }
      return -1;
    };

    const blockLabels = new Map();
    const gotoDir = new Map();
    // declId -> name mapping (GotoStmt links by declId)
    const declIdOf = new Map(); // label name -> declId
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (n.kind === 'LabelStmt') declIdOf.set(n.declId, n.name);
      for (const c of n.inner || []) walk(c);
    })(body);

    for (const g of gotos) {
      const name = declIdOf.get(g.targetLabelDeclId);
      if (!name || !labels.has(name)) throw new Error(`goto: unknown/extern label in ${fnName}`);
      const lab = labels.get(name);
      const idx = indexWithin(g, lab.block);
      if (idx === -1) {
        // cross-block: find the innermost block containing both label and goto
        const la = ancestorsOf(lab.node), ga = ancestorsOf(g);
        const B = la.find((b) => ga.includes(b));
        if (!B) throw new Error(`goto ${name}: no common block with its label in ${fnName} (unsupported)`);
        const itemIdx = indexWithin2(lab.node, B);
        const gIdx = indexWithin2(g, B);
        lab.xblock = { B, itemIdx };
        lab.xsites = lab.xsites || [];
        lab.xsites.push(gIdx);
        gotoDir.set(g, { label: name, index: gIdx, dir: 'xblock' });
        lab.sites = lab.sites || [];
        lab.sites.push(-1); // sentinel: has cross-block sites
        continue;
      }
      gotoDir.set(g, { label: name, index: idx, dir: idx < lab.index ? 'fwd' : 'bwd' });
      lab.sites = lab.sites || [];
      lab.sites.push(idx);
    }
    // labels owned by a switch body: forward-only, region must terminate
    const switchBodies = new Set();
    (function find(n) {
      if (!n || typeof n !== 'object') return;
      if (n.kind === 'SwitchStmt') {
        const b = (n.inner || []).filter((c) => c && c.kind)[1];
        if (b) switchBodies.add(b);
      }
      for (const c of n.inner || []) find(c);
    })(body);
    for (const [name, lab] of labels) {
      // label directly attached to a switch: gotos inside the switch
      // re-dispatch (continue on a do-once loop); gotos before it are
      // forward jumps to the switch start (break to a boundary block)
      if (lab.node?.inner?.[0]?.kind === 'SwitchStmt' && (lab.sites || []).length
          && (lab.sites || []).some((i) => i >= lab.index)) {
        lab.dir = 'swlabel';
        lab.hasFwd = (lab.sites || []).some((i) => i < lab.index);
        lab.hasBwd = (lab.sites || []).some((i) => i >= lab.index);
        if (!blockLabels.has(lab.block)) blockLabels.set(lab.block, []);
        blockLabels.get(lab.block).push(lab);
        continue;
      }
      // backward goto to a label at the top of a switch body: re-dispatch —
      // wrap the whole switch in a labeled one-shot loop, goto -> continue
      if (switchBodies.has(lab.block) && !(lab.sites || []).every((i) => i <= lab.index)) {
        if (lab.index !== 0) throw new Error(`goto ${name}: backward jump to mid-switch label in ${fnName} (unsupported)`);
        lab.dir = 'swloop';
        if (!blockLabels.has(lab.block)) blockLabels.set(lab.block, []);
        blockLabels.get(lab.block).push(lab);
        continue;
      }
      if (switchBodies.has(lab.block)) {
        const items = (lab.block.inner || []).filter((c) => c && c.kind);
        const seq = [];
        let boundary = -1;
        (function expand(list) {
          for (const it of list) {
            if (it.kind === 'CaseStmt' || it.kind === 'DefaultStmt') {
              seq.push(it); // case marker: regions stop at the next one
              // CaseStmt's first child is the value expr; DefaultStmt has none
              const kids = (it.inner || []).filter((c) => c && c.kind);
              expand(it.kind === 'CaseStmt' ? kids.slice(1) : kids);
            } else if (it.kind === 'LabelStmt') {
              if (it.name === name) boundary = seq.length;
              const sub = (it.inner || []).find((c) => c && c.kind && !c.kind.endsWith('Attr') && !c.kind.endsWith('Comment'));
              if (sub) seq.push(sub);
            } else seq.push(it);
          }
        })(items);
        if (!(lab.sites || []).every((i) => i <= lab.index)) throw new Error(`goto: switch-internal label ${name} with backward jump in ${fnName} (unsupported)`);
        let end = boundary;
        while (end < seq.length && seq[end].kind !== 'CaseStmt' && seq[end].kind !== 'DefaultStmt') end++;
        const region = seq.slice(boundary, end);
        const last = region[region.length - 1];
        if (!region.length || (last.kind !== 'ReturnStmt' && last.kind !== 'BreakStmt') || this.regionHasGoto(region)) {
          throw new Error(`goto ${name}: switch-internal label region is not a clean terminating splice in ${fnName} (unsupported)`);
        }
        lab.dir = 'inline';
        lab.region = region;
        if (!blockLabels.has(lab.block)) blockLabels.set(lab.block, []);
        blockLabels.get(lab.block).push({ name, index: lab.index, dir: 'inline', region });
        continue;
      }
      if (lab.xblock) {
        // region = tail of the label's own block after the label
        const items = (lab.block.inner || []).filter((c) => c && c.kind);
        const region = items.slice(lab.index).flatMap((it) => it.kind === 'LabelStmt' ? (it.inner || []).filter((c) => c && c.kind) : [it]);
        const last = region[region.length - 1];
        const terminal = region.length && (last.kind === 'ReturnStmt' || last.kind === 'BreakStmt');
        // Rule 1 (prescribed): forward goto into a terminating region —
        // inline-splice region + terminator at each goto site. Check the
        // outward tail: after the label's innermost construct, only
        // break/return/end may remain up to the control-structure boundary.
        let inlineOk = terminal;
        const outward = [];
        if (!inlineOk) {
          let node = lab.block, par = parent.get(lab.block);
          inlineOk = true;
          while (par && inlineOk) {
            const siblings = (par.inner || []).filter((c) => c && c.kind);
            const after = siblings.slice(siblings.indexOf(node) + 1);
            for (const sib of after) {
              if (sib.kind === 'BreakStmt' || sib.kind === 'ReturnStmt') { outward.push(sib); break; }
              if (sib.kind === 'CaseStmt' || sib.kind === 'DefaultStmt' || sib.kind.endsWith('Attr')) continue;
              inlineOk = false;
              break;
            }
            if (par.kind === 'SwitchStmt' || par.kind === 'ForStmt' || par.kind === 'WhileStmt' || par.kind === 'DoStmt' || par === body) break;
            node = par;
            par = parent.get(par);
          }
        }
        if (inlineOk && this.regionHasGoto(region)) inlineOk = false;
        if (inlineOk) {
          lab.dir = 'inline';
          lab.region = [...region, ...outward];
          for (const st of lab.region) {
            if (st.kind === 'DeclStmt') {
              for (const d of (st.inner || []).filter((c) => c && c.kind === 'VarDecl')) {
                (this.regionHoisted || (this.regionHoisted = new Set())).add(d.name);
              }
            }
          }
          // decls in the label's block BEFORE the label are in scope at the
          // natural position but NOT at goto-site splices in other blocks
          // (C permits jumping past declarations; a spliced JS copy has no
          // `let` in scope — dobuzz's `int bchance; make_bounce:` crashed).
          // Hoist any the region references; aggregates go to sm fallback.
          {
            const refd = new Set();
            (function names(x) {
              if (!x || typeof x !== 'object') return;
              if (x.kind === 'DeclRefExpr') { const nm = x.name || x.referencedDecl?.name; if (nm) refd.add(nm); }
              for (const c of x.inner || []) names(c);
            })({ inner: lab.region });
            for (const it of items.slice(0, lab.index)) {
              if (it.kind !== 'DeclStmt') continue;
              for (const dv of (it.inner || []).filter((c) => c && c.kind === 'VarDecl')) {
                if (!refd.has(dv.name) || dv.storageClass === 'static' || dv.storageClass === 'extern') continue;
                const q = desugar(dv.type);
                if (arrayParts(q) || (parseType(q).cls === 'record' && !this.isEnumType(q) && !q.includes('*'))) {
                  throw new Error(`goto ${name}: spliced region references block-scoped aggregate ${dv.name} in ${fnName} (unsupported)`);
                }
                (this.regionHoisted || (this.regionHoisted = new Set())).add(dv.name);
              }
            }
          }
          if (!blockLabels.has(lab.xblock.B)) blockLabels.set(lab.xblock.B, []);
          blockLabels.get(lab.xblock.B).push(lab);
          continue;
        }
        const allFwd = lab.xsites.every((gi) => gi <= lab.xblock.itemIdx);
        if (!allFwd && !terminal) throw new Error(`goto ${name}: cross-block jump over a non-terminating region in ${fnName} (unsupported)`);
        lab.dir = allFwd ? 'xforward' : 'xterminal';
        lab.hasLoop = (lab.sites || []).some((i) => i > lab.index);
        lab.region = region;
        // The region is re-emitted after the __skip block, OUTSIDE the label's
        // original enclosing blocks. C scopes names declared in those blocks
        // across the label; relocated JS `let` does not — hoist region-referenced
        // scalar decls (chain lab.block up to B, exclusive) to function top.
        // Aggregates can't hoist through this path: throw into the state-machine
        // fallback, which hoists everything.
        {
          const refd = new Set();
          // names used by the relocated region AND by B's items after the
          // label item — both are emitted after the __skip block, outside
          // the scope of decls the skip block swallowed
          const bItems = (lab.xblock.B.inner || []).filter((c) => c && c.kind);
          (function names(x) {
            if (!x || typeof x !== 'object') return;
            if (x.kind === 'DeclRefExpr') { const nm = x.name || x.referencedDecl?.name; if (nm) refd.add(nm); }
            for (const c of x.inner || []) names(c);
          })({ inner: [...region, ...bItems.slice(lab.xblock.itemIdx + 1)] });
          const hoistFromBlock = (blk2, limitIdx) => {
            const its = (blk2.inner || []).filter((c) => c && c.kind);
            for (const it of its.slice(0, limitIdx == null ? its.length : limitIdx)) {
              if (it.kind !== 'DeclStmt') continue;
              for (const dv of (it.inner || []).filter((c) => c && c.kind === 'VarDecl')) {
                if (!refd.has(dv.name) || dv.storageClass === 'static' || dv.storageClass === 'extern') continue;
                const q = desugar(dv.type);
                if (arrayParts(q) || (parseType(q).cls === 'record' && !this.isEnumType(q) && !q.includes('*'))) {
                  throw new Error(`goto ${name}: relocated region references block-scoped aggregate ${dv.name} in ${fnName} (unsupported)`);
                }
                (this.regionHoisted || (this.regionHoisted = new Set())).add(dv.name);
              }
            }
          };
          let blk = lab.block;
          while (blk && blk !== lab.xblock.B) {
            hoistFromBlock(blk, null);
            let cur = parent.get(blk);
            while (cur && cur.kind !== 'CompoundStmt' && cur !== body) cur = parent.get(cur);
            blk = cur;
          }
          // B's own leading items are wrapped in the __skip block, which also
          // cuts their scope off from the dispatch region that follows it
          hoistFromBlock(lab.xblock.B, allFwd ? lab.xblock.itemIdx : null);
        }
        if (!blockLabels.has(lab.xblock.B)) blockLabels.set(lab.xblock.B, []);
        blockLabels.get(lab.xblock.B).push(lab);
        continue;
      }
      // a site inside the label's own substatement (idx == label idx) is a
      // backward jump (it re-enters); only strictly-earlier sites are forward
      lab.dir = (lab.sites || []).every((i) => i < lab.index) ? 'fwd'
        : (lab.sites || []).every((i) => i >= lab.index) ? 'bwd' : 'mixed';
      // labels with no gotos are harmless (C allows them); treat as fwd
      if (!blockLabels.has(lab.block)) blockLabels.set(lab.block, []);
      blockLabels.get(lab.block).push({ name, index: lab.index, dir: lab.dir });
    }
    for (const [, arr] of blockLabels) arr.sort((a, b) => a.index - b.index);
    return { blockLabels, gotoDir };
  }


  // ================= per-function state-machine lowering =================
  //
  // The general fallback for goto shapes the pattern lowerings don't cover.
  // The function body becomes an explicit dispatch loop: labels are states,
  // `goto L` is `__pc = N_L; continue;`, and natural fall-through into a
  // label is `__pc = N_L; continue;` at its position. Constructs containing
  // labels are truncated at the label (the label's tail becomes plain
  // statements in the new case); breaks/continues inside decomposed
  // switches/loops are remapped to state transitions.

  smCollect(fnName, body) {
    const labels = new Map(); // name -> LabelStmt node
    const ordered = [];
    const declIdOf = new Map(); // declId -> name
    (function w(n) {
      if (!n || typeof n !== 'object') return;
      if (n.kind === 'LabelStmt') { labels.set(n.name, n); ordered.push(n.name); declIdOf.set(n.declId, n.name); }
      for (const c of n.inner || []) w(c);
    })(body);
    const nameToNum = new Map(ordered.map((n, i) => [n, i + 1]));
    return { labels, ordered, nameToNum, declIdOf };
  }

  hasLabelInside(n) {
    if (!n || typeof n !== 'object') return false;
    if (n.kind === 'LabelStmt') return true;
    return (n.inner || []).some((c) => this.hasLabelInside(c));
  }

  /** subtree contains a label or any control transfer (goto) */
  hasLabelOrGoto(n) {
    if (!n || typeof n !== 'object') return false;
    if (n.kind === 'LabelStmt' || n.kind === 'GotoStmt' || n.kind === 'IndirectGotoStmt') return true;
    return (n.inner || []).some((c) => this.hasLabelOrGoto(c));
  }

  /** subtree contains a break NOT captured by a nested loop/switch — such a
   * break targets the construct the state machine decomposed away, so its
   * carrier must be decomposed too (else it binds to the dispatch switch). */
  hasUnboundBreak(n) {
    if (!n || typeof n !== 'object') return false;
    if (n.kind === 'BreakStmt') return true;
    if (n.kind === 'ForStmt' || n.kind === 'WhileStmt' || n.kind === 'DoStmt' || n.kind === 'SwitchStmt') return false;
    return (n.inner || []).some((c) => this.hasUnboundBreak(c));
  }

  /** subtree contains a continue NOT captured by a nested loop (switches do
   * NOT capture continue — it still binds to the decomposed outer loop). */
  hasUnboundContinue(n) {
    if (!n || typeof n !== 'object') return false;
    if (n.kind === 'ContinueStmt') return true;
    if (n.kind === 'ForStmt' || n.kind === 'WhileStmt' || n.kind === 'DoStmt') return false;
    return (n.inner || []).some((c) => this.hasUnboundContinue(c));
  }

  /** must this statement be sm-decomposed? labels/gotos always; otherwise
   * break/continue that would bind to the wrong construct after decomposition */
  smMustDecompose(n, ctx) {
    if (this.hasLabelOrGoto(n)) return true;
    if (ctx.breakTo !== undefined && this.hasUnboundBreak(n)) return true;
    if (ctx.continueTo !== undefined && this.hasUnboundContinue(n)) return true;
    return false;
  }

  smOpen(num) {
    this.sm.cases.push(this.sm.cur = { num, lines: [] });
  }

  smClose(cont) {
    if (!this.sm.cur) return;
    this.sm.cur.lines.push(`${this.sm.ind}__pc = ${cont};`, `${this.sm.ind}continue;`);
    this.sm.cur = null;
  }

  smLine(code) {
    this.sm.cur.lines.push(`${this.sm.ind}${code}`);
  }

  /** emit one statement into the state machine (labels/gotos/decomposition) */
  emitSMSeq(items, ctx) {
    for (const it of items) {
      if (!it || !it.kind) continue;
      const ind = this.sm.ind;
      if (it.kind === 'CompoundStmt') { this.emitSMSeq((it.inner || []).filter((c) => c && c.kind), ctx); continue; }
      if (it.kind === 'LabelStmt') {
        const num = this.sm.nameToNum.get(it.name);
        this.smClose(num);
        this.smOpen(num);
        const sub = (it.inner || []).find((c) => c && c.kind && !c.kind.endsWith('Attr') && !c.kind.endsWith('Comment'));
        if (sub) this.emitSMSeq([sub], ctx);
        continue;
      }
      if (it.kind === 'GotoStmt') {
        const num = this.sm.nameToNum.get(this.sm.declIdOf.get(it.targetLabelDeclId));
        if (num === undefined) throw new Error(`sm: goto to unknown label (${this.cref(it)})`);
        this.smLine(`{ __pc = ${num}; continue; }`);
        continue;
      }
      if (it.kind === 'IndirectGotoStmt') {
        const target = this.emitExpr(it.inner[0]).code;
        this.smLine(`{ __pc = __smNums[${target}]; continue; }`);
        continue;
      }
      if (it.kind === 'AddrLabelExpr') {
        // only reachable inside dispatch-table initializers
        this.smLine(`/* &&${it.name} */`);
        continue;
      }
      if (it.kind === 'BreakStmt') {
        this.smLine(ctx.breakTo !== undefined ? `{ __pc = ${ctx.breakTo}; continue; }` : 'break;');
        continue;
      }
      if (it.kind === 'ContinueStmt') {
        this.smLine(ctx.continueTo !== undefined ? `{ __pc = ${ctx.continueTo}; continue; }` : 'continue;');
        continue;
      }
      if (it.kind === 'IfStmt' && this.smMustDecompose(it, ctx)) { this.emitSMIf(it, ctx); continue; }
      // a switch captures its own breaks, but NOT continues aimed at the
      // decomposed outer loop
      if (it.kind === 'SwitchStmt' && (this.hasLabelOrGoto((it.inner || []).filter((c) => c && c.kind)[1]) || (ctx.continueTo !== undefined && this.hasUnboundContinue((it.inner || []).filter((c) => c && c.kind)[1])))) { this.emitSMSwitch(it, ctx); continue; }
      if ((it.kind === 'ForStmt' || it.kind === 'WhileStmt' || it.kind === 'DoStmt') && this.hasLabelOrGoto(it)) { this.emitSMLoop(it, ctx); continue; }
      const lines = this.emitStmt(it, ind);
      for (const l of lines) this.sm.cur.lines.push(l);
    }
  }

  emitSMIf(n, ctx) {
    // dispatcher form: the if never carries branch content across cases;
    // it just transfers to then/else states (no cross-case braces)
    const kids = (n.inner || []).filter((c) => c && c.kind);
    const [cond, thenS, elseS] = kids;
    const cont = this.sm.synth++;
    const thenState = this.sm.synth++;
    const elseState = elseS ? this.sm.synth++ : cont;
    const condCode = this.emitExpr(cond).code;
    // finish the current case with the pure dispatcher
    this.smLine(`if (${condCode}) { __pc = ${thenState}; continue; }`);
    this.smLine(`__pc = ${elseState}; continue;`);
    this.sm.cur = null;
    const branchItems = (s) => s.kind === 'CompoundStmt' ? (s.inner || []).filter((c) => c && c.kind) : [s];
    this.smOpen(thenState);
    this.emitSMSeq(branchItems(thenS), ctx);
    this.smClose(cont);
    if (elseS) {
      this.smOpen(elseState);
      this.emitSMSeq(branchItems(elseS), ctx);
      this.smClose(cont);
    }
    this.smOpen(cont);
  }

  emitSMLoop(n, ctx) {
    // dispatcher form: head state checks the condition and transfers to the
    // body state or the after state; the body state loops back (and the inc
    // state handles the for-increment so `continue` runs it too)
    const kids = (n.inner || []).filter((c) => c && c.kind);
    const cont = this.sm.synth++;
    const head = this.sm.synth++;
    const body = this.sm.synth++;
    const isDo = n.kind === 'DoStmt';
    const isFor = n.kind === 'ForStmt';
    const bodyNode = isDo ? kids[0] : kids[kids.length - 1];
    const bodyItems = bodyNode.kind === 'CompoundStmt' ? (bodyNode.inner || []).filter((c) => c && c.kind) : [bodyNode];
    const incState = isFor ? this.sm.synth++ : head;
    // for-init runs once, in the current case, before entering the head
    if (isFor) {
      const slot = (i) => (kids[i] && kids[i].kind ? kids[i] : null);
      const init = kids.length === 5 ? slot(0) : kids.slice(0, -1).filter((k) => k && k.kind)[0];
      if (init) {
        const code = init.kind === 'DeclStmt' ? this.stmt_DeclStmt(init, this.sm.ind) : [`${this.sm.ind}${this.emitExpr(init, { stmtPos: true }).code};`];
        for (const l of code) this.sm.cur.lines.push(l);
      }
    }
    // current case finishes by entering the head
    this.smLine(`__pc = ${head}; continue;`);
    this.sm.cur = null;
    // head state
    this.smOpen(head);
    if (isFor) {
      const slot = (i) => (kids[i] && kids[i].kind ? kids[i] : null);
      const cond = kids.length === 5 ? slot(2) : kids.slice(0, -1).filter((k) => k && k.kind)[1];
      if (cond) this.smLine(`if (!(${this.emitExpr(cond).code})) { __pc = ${cont}; continue; }`);
      this.smLine(`__pc = ${body}; continue;`);
      this.sm.cur = null;
    } else if (isDo) {
      this.smLine(`__pc = ${body}; continue;`);
      this.sm.cur = null;
    } else {
      this.smLine(`if (!(${this.emitExpr(kids[0]).code})) { __pc = ${cont}; continue; }`);
      this.smLine(`__pc = ${body}; continue;`);
      this.sm.cur = null;
    }
    // body state
    const ctx2 = { ...ctx, breakTo: cont, continueTo: incState };
    this.smOpen(body);
    this.emitSMSeq(bodyItems, ctx2);
    if (isDo) this.smLine(`if (${this.emitExpr(kids[1]).code}) { __pc = ${body}; continue; }`);
    if (isFor) this.smClose(incState); else this.smClose(isDo ? cont : head);
    if (isFor) {
      this.smOpen(incState);
      const slot = (i) => (kids[i] && kids[i].kind ? kids[i] : null);
      const inc = kids.length === 5 ? slot(3) : kids.slice(0, -1).filter((k) => k && k.kind)[2];
      if (inc) this.smLine(`${this.emitExpr(inc, { stmtPos: true }).code};`);
      this.smClose(head);
    }
    this.smOpen(cont);
  }

  emitSMSwitch(n, ctx) {
    // dispatcher form: evaluate once into a temp, then transfer to case
    // states by equality; fallthrough = region ends with the next case state;
    // break = transfer to the continuation state. No nested switch text.
    const kids = (n.inner || []).filter((c) => c && c.kind);
    const [cond, bodyStmt] = kids;
    const cont = this.sm.synth++;
    const tmp = `__sw${this.sm.synth++}`;
    const condCode = this.emitExpr(cond).code;
    this.smLine(`let ${tmp} = ${condCode};`);
    // flatten case clauses into (value|null for default, items[]) in order,
    // expanding chained cases (case A: case B: stmt)
    const clauses = [];
    const pushClause = (value, items) => clauses.push({ value, items });
    const walkCases = (list) => {
      for (const it of list) {
        if (!it || !it.kind) continue;
        if (it.kind === 'CaseStmt' || it.kind === 'DefaultStmt') {
          const kids2 = (it.inner || []).filter((c) => c && c.kind);
          const value = it.kind === 'CaseStmt' ? this.emitExpr(kids2[0]).code : null;
          pushClause(value, []);
          walkCases(it.kind === 'CaseStmt' ? kids2.slice(1) : kids2);
        } else {
          if (!clauses.length) throw new Error(`sm: statement before first case label (${this.cref(it)})`);
          clauses[clauses.length - 1].items.push(it);
        }
      }
    };
    walkCases((bodyStmt.inner || []).filter((c) => c && c.kind));
    // allocate states: one per clause, then emit the transfer chain
    const states = clauses.map(() => this.sm.synth++);
    const defIdx = clauses.findIndex((c) => c.value === null);
    for (let i = 0; i < clauses.length; i++) {
      if (clauses[i].value !== null) {
        this.smLine(`if (${tmp} === ${clauses[i].value}) { __pc = ${states[i]}; continue; }`);
      }
    }
    this.smLine(`__pc = ${defIdx >= 0 ? states[defIdx] : cont}; continue;`);
    this.sm.cur = null;
    // emit each case region
    for (let i = 0; i < clauses.length; i++) {
      this.smOpen(states[i]);
      const next = i + 1 < clauses.length ? states[i + 1] : cont;
      this.emitSMSeq(clauses[i].items, { ...ctx, breakTo: cont });
      this.smClose(next);
    }
    this.smOpen(cont);
  }

  /** hoistable locals used by the state machine (declared inside states) */
  smHoistNames(body) {
    const names = [];
    const seen = new Set();
    (function w(n) {
      if (!n || typeof n !== 'object') return;
      if (n.kind === 'DeclStmt') {
        for (const d of (n.inner || []).filter((c) => c && c.kind === 'VarDecl')) {
          if (d.storageClass === 'static') continue;
          if (!seen.has(d.name)) { seen.add(d.name); names.push(d.name); }
        }
        return;
      }
      for (const c of n.inner || []) w(c);
    })(body);
    return names;
  }

  /**
   * Per-function state-machine lowering for goto shapes the pattern
   * lowerings reject: labels become dispatch states; all control transfer is
   * explicit. Confined to this function.
   */
  emitStateMachine(d, body) {
    const info = this.smCollect(d.name, body);
    this.sm = {
      cases: [], cur: null, ind: '        ',
      nameToNum: info.nameToNum, declIdOf: info.declIdOf,
      synth: info.ordered.length + 1,
    };
    this.smOpen(0);
    const items = (body.inner || []).filter((c) => c && c.kind);
    this.emitSMSeq(items, { endState: -1 });
    this.smClose(-1);
    const cases = this.sm.cases;
    const lines = [];
    // hoisted locals (states share function scope in C); address-taken
    // (boxed) locals must hoist as boxes — every ref uses name.v
    const hoisted = this.smHoistNames(body);
    if (hoisted.length) {
      lines.push(`    let ${hoisted.map((nm) => this.boxedVars?.has(nm) ? `${jsName(nm)} = ${this.cptrCall('box', '0')}` : jsName(nm)).join(', ')};`);
      if (hoisted.some((nm) => this.boxedVars?.has(nm))) this.usesCptr = true;
    }
    // dispatch tables (computed goto) index states by label name
    let usesNumMap = false;
    (function w(n) {
      if (!n || typeof n !== 'object' || usesNumMap) return;
      if (n.kind === 'IndirectGotoStmt' || n.kind === 'AddrLabelExpr') { usesNumMap = true; return; }
      for (const c of n.inner || []) w(c);
    })(body);
    if (usesNumMap) {
      lines.push(`    const __smNums = { ${info.ordered.map((n, i) => `${JSON.stringify(n)}: ${i + 1}`).join(', ')} };`);
    }
    lines.push('    let __pc = 0;');
    lines.push('    __dispatch: while (true) {');
    lines.push('        switch (__pc) {');
    for (const c of cases) {
      const label = c.num === 0 ? '0' : `${c.num}${c.num <= info.ordered.length ? ` /* ${info.ordered[c.num - 1]}: */` : ''}`;
      lines.push(`        case ${label}: {`);
      for (const l of c.lines) lines.push(l);
      lines.push('        }');
    }
    lines.push('        }');
    lines.push('        if (__pc === -1) break __dispatch;');
    lines.push('    }');
    return lines;
  }

  mangleLabel(name) { return `__lbl_${name}`; }

  /** does this statement list contain any goto? (spliced regions must be pure) */
  regionHasGoto(region) {
    let found = false;
    (function w(n) {
      if (!n || typeof n !== 'object' || found) return;
      if (n.kind === 'GotoStmt') { found = true; return; }
      for (const c of n.inner || []) w(c);
    })({ inner: region });
    return found;
  }

  /**
   * Cross-block goto lowering (entry-flag dispatch):
   *  - xforward (all jumps forward in block order): a labeled skip block wraps
   *    the block prefix up to the item K containing the label; inside K the
   *    label's own block is cut at the label with `__go_L = true; break`.
   *    After the skip: `if (__go_L) { <label tail> }`, then the block's
   *    remaining items. Normal flow reaching the label hits the same
   *    flag+break and lands in the same region — one copy, all entries.
   *  - xterminal (some jumps land earlier than the label; region must end in
   *    return/break): one shared skip block wraps the whole block; each
   *    label's block is cut at its label; dispatch regions follow in order.
   */
  emitXBlockItems(items, indent, labelPlan, itemEmit) {
    const xfwd = labelPlan.filter((l) => l.dir === 'xforward');
    const xterm = labelPlan.filter((l) => l.dir === 'xterminal');
    if (xfwd.length && xterm.length) throw new Error('goto: xforward+xterminal labels in one block (unsupported)');
    const emitItem = itemEmit || ((n, ind) => this.emitStmt(n, ind));

    const cutAndEmit = (node, ind, label, mode) => {
      // emit the item containing the label, cutting its block at the label
      const prevCut = this.xblockCut;
      this.xblockCut = new Map([[label.block, { lab: label, mode }]]);
      try {
        return emitItem(node, ind);
      } finally {
        this.xblockCut = prevCut;
      }
    };

    if (xterm.length) {
      const lines = [];
      const flags = xterm.map((l) => `__go_${l.name} = false`).join(', ');
      lines.push(`${indent}let ${flags};`);
      lines.push(`${indent}__skip_all: {`);
      for (const it of items) {
        const lab = xterm.find((l) => l.xblock && items.indexOf(it) === l.xblock.itemIdx);
        if (lab) lines.push(...cutAndEmit(it, indent + '    ', lab, 'terminal'));
        else lines.push(...emitItem(it, indent + '    '));
      }
      lines.push(`${indent}}`);
      for (const lab of xterm) {
        lines.push(`${indent}if (__go_${lab.name}) {`);
        if (lab.hasLoop) {
          // while(true)+break, not do{}while(false) (see bwds comment)
          for (const st of lab.region) if (this.hasUnboundBreak(st) || this.hasUnboundContinue(st)) throw new Error(`goto ${lab.name}: xterminal loop region has unbound break/continue (sm fallback)`);
          lines.push(`${indent}    __lbl_${lab.name}: while (true) {`);
        }
        lines.push(...lab.region.flatMap((x) => this.emitStmt(x, indent + (lab.hasLoop ? '        ' : '    '))));
        if (lab.hasLoop) lines.push(`${indent}        break __lbl_${lab.name};`, `${indent}    }`);
        lines.push(`${indent}}`);
      }
      return lines;
    }

    // xforward: per-label skip block + dispatch at the label's item
    const lines = [];
    let rest = items;
    for (const lab of xfwd.sort((a, b) => a.xblock.itemIdx - b.xblock.itemIdx)) {
      const idx = lab.xblock.itemIdx;
      lines.push(`${indent}let __go_${lab.name} = false;`);
      lines.push(`${indent}__skip_${lab.name}: {`);
      for (const it of rest.slice(0, idx)) lines.push(...emitItem(it, indent + '    '));
      lines.push(...cutAndEmit(rest[idx], indent + '    ', lab, 'forward'));
      lines.push(`${indent}}`);
      lines.push(`${indent}if (__go_${lab.name}) {`);
      if (lab.hasLoop) {
        // while(true)+break, not do{}while(false) (see bwds comment)
        for (const st of lab.region) if (this.hasUnboundBreak(st) || this.hasUnboundContinue(st)) throw new Error(`goto ${lab.name}: xforward loop region has unbound break/continue (sm fallback)`);
        lines.push(`${indent}    __lbl_${lab.name}: while (true) {`);
      }
      lines.push(...lab.region.flatMap((x) => this.emitStmt(x, indent + (lab.hasLoop ? '        ' : '    '))));
      if (lab.hasLoop) lines.push(`${indent}        break __lbl_${lab.name};`, `${indent}    }`);
      lines.push(`${indent}}`);
      // remaining items continue after this label's dispatch; later xforward
      // labels are re-indexed relative to the rest
      const consumed = idx + 1;
      rest = rest.slice(consumed);
      for (const l2 of xfwd) if (l2 !== lab && l2.xblock.itemIdx !== undefined && l2.xblock.itemIdx >= consumed) l2.xblock = { ...l2.xblock, itemIdx: l2.xblock.itemIdx - consumed };
      for (const l2 of xfwd) if (l2 !== lab && l2.xblock.itemIdx !== undefined && l2.xblock.itemIdx < 0) throw new Error(`goto ${l2.name}: multiple xforward labels overlap (unsupported)`);
    }
    for (const it of rest) lines.push(...emitItem(it, indent));
    return lines;
  }

  /**
   * Emit block items with labels lowered:
   *  - forward labels: nested labeled blocks L: { ...region... } with
   *    `goto L` -> `break L` (region = block start .. label position).
   *  - backward labels: labeled loops L: while (true) { ...region... break L; }
   *    with `goto L` -> `continue L` (region = label position .. block end).
   *    NOT do{}while(false): `continue L` on a do-while jumps to the (false)
   *    condition and exits — backward gotos would skip the tail, not loop.
   */
  emitLabeledItems(items, indent, labelPlan, itemEmit) {
    const emitItem = itemEmit || ((x, ind) => this.emitStmt(x, ind));
    const swlabels = labelPlan.filter((l) => l.dir === 'swlabel');
    if (swlabels.length) {
      if (swlabels.length !== labelPlan.length) throw new Error('goto: swlabel label combined with other labels in one block (unsupported)');
      const l = swlabels[0];
      const lines = [];
      if (l.hasFwd) lines.push(`${indent}__fwd_${l.name}: {`);
      const bodyIndent = l.hasFwd ? indent + '    ' : indent;
      lines.push(...items.flatMap((it) => {
        if (it.kind === 'LabelStmt' && it.name === l.name) {
          const sub = (it.inner || []).find((c) => c && c.kind && !c.kind.endsWith('Attr') && !c.kind.endsWith('Comment'));
          if (l.hasBwd) {
            // while(true)+break, not do{}while(false): continue L on a
            // do-while exits instead of re-dispatching (see bwds comment)
            if (this.hasUnboundContinue(sub)) throw new Error(`goto ${l.name}: swlabel region has unbound continue (sm fallback)`);
            return [`${bodyIndent}${this.mangleLabel(l.name)}: while (true) {`, ...this.emitStmt(sub, bodyIndent + '    '), `${bodyIndent}    break ${this.mangleLabel(l.name)};`, `${bodyIndent}}`];
          }
          return this.emitStmt(sub, bodyIndent);
        }
        return this.emitStmt(it, bodyIndent);
      }));
      if (l.hasFwd) lines.push(`${indent}}`);
      return lines;
    }
    if (labelPlan.every((l) => l.dir === 'inline')) {
      // labels are emitted at their natural position; gotos splice the region
      return items.flatMap((x) => emitItem(x, indent));
    }
    const xplans = labelPlan.filter((l) => l.dir === 'xforward' || l.dir === 'xterminal');
    if (xplans.length) {
      // xblock labels combine freely with inline splices; forward labels are
      // converted to inline splices when their regions terminate cleanly
      const others = labelPlan.filter((l) => !xplans.includes(l));
      const seqAll = [];
      const bnd = new Map();
      for (const it of items) {
        if (it.kind === 'LabelStmt') {
          bnd.set(it.name, seqAll.length);
          const sub = (it.inner || []).find((c) => c && c.kind && !c.kind.endsWith('Attr'));
          if (sub) seqAll.push(sub);
        } else seqAll.push(it);
      }
      for (const l of others) {
        if (l.dir === 'inline') continue;
        if (l.dir !== 'fwd') throw new Error(`goto ${l.name}: xblock label combined with backward/mixed labels in one block (unsupported)`);
        const region = seqAll.slice(bnd.get(l.name));
        const last = region[region.length - 1];
        if (!region.length || (last.kind !== 'ReturnStmt' && last.kind !== 'BreakStmt') || this.regionHasGoto(region)) {
          throw new Error(`goto ${l.name}: xblock combined label region is not a clean terminating splice (unsupported)`);
        }
        l.dir = 'inline';
        l.region = region;
      }
      return this.emitXBlockItems(items, indent, xplans);
    }
    let fwds = labelPlan.filter((l) => l.dir === 'fwd');
    const bwds = labelPlan.filter((l) => l.dir === 'bwd');
    const mixed = labelPlan.filter((l) => l.dir === 'mixed');
    if (mixed.length && labelPlan.length > 1) throw new Error('goto: mixed label combined with other labels in one block (unsupported)');
    if (fwds.length && bwds.length) {
      // forward cleanup labels alongside a backward loop: the forward labels
      // become inline splices when their regions terminate (Rule 1)
      const seqAll = [];
      const bnd = new Map();
      for (const it of items) {
        if (it.kind === 'LabelStmt') {
          bnd.set(it.name, seqAll.length);
          const sub = (it.inner || []).find((c) => c && c.kind && !c.kind.endsWith('Attr') && !c.kind.endsWith('Comment'));
          if (sub) seqAll.push(sub);
        } else seqAll.push(it);
      }
      for (const l of fwds) {
        const region = seqAll.slice(bnd.get(l.name));
        const last = region[region.length - 1];
        if (!region.length || (last.kind !== 'ReturnStmt' && last.kind !== 'BreakStmt') || this.regionHasGoto(region)) {
          throw new Error(`goto ${l.name}: forward+backward labels in one block and the region is not a clean terminating splice (unsupported)`);
        }
        l.dir = 'inline';
        l.region = region;
      }
      fwds = [];
    }
    // normalize: replace LabelStmt items by their substatement, remember boundaries
    const seq = [];
    const bounds = new Map(); // label name -> boundary index in seq
    for (const it of items) {
      if (it.kind === 'LabelStmt') {
        bounds.set(it.name, seq.length);
        const sub = (it.inner || []).find((c) => c && c.kind && !c.kind.endsWith('Attr') && !c.kind.endsWith('Comment'));
        if (sub) seq.push(sub);
      } else seq.push(it);
    }
    // hoist leading declarations out of the labeled blocks below: in C a
    // declaration at the top of a block is visible on both sides of a label,
    // but JS `let` inside `L: { ... }` / `__skip_L: { ... }` is not. The tail
    // (and backward re-entry regions) may reference these variables.
    let nLead = 0;
    while (nLead < seq.length && seq[nLead].kind === 'DeclStmt') nLead++;
    if (nLead) {
      const minB = Math.min(...[...bounds.values()]);
      nLead = Math.min(nLead, minB);
    }
    const leadDecls = nLead ? seq.splice(0, nLead) : [];
    if (nLead) for (const [k, v] of bounds) bounds.set(k, v - nLead);
    const leadLines = leadDecls.flatMap((x) => this.emitStmt(x, indent));
    if (mixed.length) {
      // one label, both directions: skip-block for forward jumps, then a
      // labeled loop re-entering at the label for backward jumps
      const name = mixed[0].name;
      const b = bounds.get(name);
      for (const st of seq.slice(b)) if (this.hasUnboundBreak(st) || this.hasUnboundContinue(st)) throw new Error(`goto ${name}: mixed-label region has unbound break/continue (sm fallback)`);
      return [
        ...leadLines,
        `${indent}__skip_${name}: {`,
        ...seq.slice(0, b).flatMap((x) => this.emitStmt(x, indent + '    ')),
        `${indent}}`,
        `${indent}${this.mangleLabel(name)}: for (;;) {`,
        ...seq.slice(b).flatMap((x) => this.emitStmt(x, indent + '    ')),
        `${indent}    break;`,
        `${indent}}`,
      ];
    }
    if (fwds.length) {
      const bs = fwds.map((l) => ({ name: l.name, b: bounds.get(l.name) })).sort((a, b) => a.b - b.b);
      // matryoshka: L1 innermost (region block-start..b1), each next label
      // wraps the previous block plus the slice up to its own boundary
      const regions = [];
      let prev = 0;
      for (const { name, b } of bs) {
        regions.push({ name, seg: seq.slice(prev, b) });
        prev = b;
      }
      const tail = seq.slice(prev);
      let inner = [
        `${indent}${this.mangleLabel(regions[0].name)}: {`,
        ...regions[0].seg.flatMap((x) => this.emitStmt(x, indent + '    ')),
        `${indent}}`,
      ];
      for (let j = 1; j < regions.length; j++) {
        inner = [
          `${indent}${this.mangleLabel(regions[j].name)}: {`,
          ...inner,
          ...regions[j].seg.flatMap((x) => this.emitStmt(x, indent + '    ')),
          `${indent}}`,
        ];
      }
      return [...leadLines, ...inner, ...tail.flatMap((x) => this.emitStmt(x, indent))];
    }
    // backward labels: nest labeled loops (outermost = smallest boundary).
    // `while (true)` + explicit trailing `break L`, NOT `do{}while(false)`:
    // `continue L` on a do-while jumps to the (false) condition and EXITS,
    // so lowered backward gotos would silently skip the region tail instead
    // of looping (this lost the inventory menu: display_pickinv's nextclass).
    const bs = bwds.map((l) => ({ name: l.name, b: bounds.get(l.name) })).sort((a, b) => a.b - b.b);
    for (const st of seq.slice(Math.min(...bs.map((x) => x.b)))) {
      // a bare C break/continue in the region would bind to the synthetic
      // loop instead of the real enclosing loop/switch: not representable here
      if (this.hasUnboundBreak(st) || this.hasUnboundContinue(st))
        throw new Error(`goto: backward-label region has unbound break/continue (sm fallback)`);
    }
    const build = (j, ind) => {
      const start = bs[j].b;
      const end = j + 1 < bs.length ? bs[j + 1].b : seq.length;
      const lines2 = [`${ind}${this.mangleLabel(bs[j].name)}: while (true) {`];
      lines2.push(...seq.slice(start, end).flatMap((x) => this.emitStmt(x, ind + '    ')));
      if (j + 1 < bs.length) lines2.push(...build(j + 1, ind + '    '));
      lines2.push(`${ind}    break ${this.mangleLabel(bs[j].name)};`);
      lines2.push(`${ind}}`);
      return lines2;
    };
    return [...leadLines, ...seq.slice(0, bs[0].b).flatMap((x) => this.emitStmt(x, indent)), ...build(0, indent)];
  }

  stmt_GotoStmt(n, indent) {
    const dir = this.gotoPlan?.gotoDir.get(n);
    if (!dir) throw new Error(`goto outside analyzed function (${this.cref(n)})`);
    const plan = [...(this.gotoPlan.blockLabels.values())].flat().find((l) => l.name === dir.label);
    if (plan.dir === 'inline') {
      // terminating region: splice it in (braced: safe in single-statement arms)
      return [`${indent}{`, ...plan.region.flatMap((x) => this.emitStmt(x, indent + '    ')), `${indent}}`];
    }
    if (plan.dir === 'swlabel') {
      if (dir.index < plan.index) return [`${indent}break __fwd_${dir.label};`]; // forward to the switch
      return [`${indent}continue ${this.mangleLabel(dir.label)};`]; // re-dispatch
    }
    if (plan.dir === 'xforward' || plan.dir === 'xterminal') {
      if (dir.dir === 'bwd') return [`${indent}continue __lbl_${dir.label};`]; // in-region loop
      const target = plan.dir === 'xterminal' ? '__skip_all' : `__skip_${dir.label}`;
      return [`${indent}{ __go_${dir.label} = true; break ${target}; }`];
    }
    if (plan.dir === 'mixed') {
      return [`${indent}${dir.dir === 'fwd' ? `break __skip_${dir.label}` : `continue ${this.mangleLabel(dir.label)}`};`];
    }
    return [`${indent}${plan.dir === 'bwd' ? 'continue' : 'break'} ${this.mangleLabel(dir.label)};`];
  }

  stmt_LabelStmt(n, indent) {
    // labels are consumed by emitLabeledItems; a label reaching here is in a
    // non-analyzed position — emit its substatement (harmless) and note
    const sub = (n.inner || []).find((c) => c && c.kind && !c.kind.endsWith('Attr') && !c.kind.endsWith('Comment'));
    return sub ? this.emitStmt(sub, indent) : [`${indent};`];
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
    if (n.kind.endsWith('Attr') || n.kind === 'FormatAttr' || n.kind.endsWith('Comment')) return []; // attributes/comments are no-ops
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
    lines.push(...this.emitBlockItems((n.inner || []).filter((x) => x && x.kind), indent + '    ', n));
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
  emitBlockItems(items, indent, blockNode) {
    if (blockNode && this.xblockCut?.has(blockNode)) {
      // cut this block at the label: prefix, then flag+break, then stop
      const { lab, mode } = this.xblockCut.get(blockNode);
      const lines = [];
      for (const it of items) {
        if (it.kind === 'LabelStmt' && it.name === lab.name) {
          lines.push(`${indent}__go_${lab.name} = true; break ${mode === 'terminal' ? '__skip_all' : `__skip_${lab.name}`};`);
          return lines;
        }
        lines.push(...this.emitStmt(it, indent));
      }
      return lines; // label not a direct item here; keep going deeper via emitStmt
    }
    const labelPlan = blockNode && !this.smMode && this.gotoPlan?.blockLabels.get(blockNode);
    if (labelPlan && labelPlan.length) {
      if (items.some((s) => s.kind === 'IfStmt' && this.hasSetjmp((s.inner || []).filter((c) => c && c.kind)[0]))) {
        throw new Error('goto+setjmp in one block (unsupported)');
      }
      return this.emitLabeledItems(items, indent, labelPlan);
    }
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
      if (d.storageClass === 'extern') continue; // declaration only — the definition lives elsewhere
      if (this.smMode) { // state-machine mode: names are hoisted to fn top
        const init = (d.inner || []).find((c) => c && c.kind && !c.kind.endsWith('Attr') && !c.kind.endsWith('Comment'));
        const q = desugar(d.type);
        const tgt = this.boxedVars?.has(d.name) ? `${jsName(d.name)}.v` : jsName(d.name);
        if (this.emitHoistedArrayAssign(d, q, init, indent, lines)) continue;
        if (parseType(q).cls === 'record' && !this.isEnumType(q)) {
          const recName = this.recordNameForType(q);
          this.recordLocals.add(jsName(d.name)); // member exprs must take the byte-model path
          lines.push(`${indent}${jsName(d.name)} = ${this.cptrCall('alloc', String(this.layoutOf(recName).size))};`);
          if (init) lines.push(...this.recordInitStores(jsName(d.name), recName, init));
        } else if (init) {
          lines.push(`${indent}${tgt} = ${this.emitExpr(init).code};`);
        }
        continue;
      }
      if (this.regionHoisted?.has(d.name)) {
        const init = (d.inner || []).find((c) => c && c.kind && !c.kind.endsWith('Attr') && !c.kind.endsWith('Comment'));
        if (this.emitHoistedArrayAssign(d, desugar(d.type), init, indent, lines)) continue;
        if (init) lines.push(`${indent}${this.boxedVars?.has(d.name) ? `${jsName(d.name)}.v` : jsName(d.name)} = ${this.emitExpr(init).code};`);
        continue; // declaration hoisted to function top
      }
      lines.push(`${indent}${this.localVarDecl(d)}`);
    }
    return lines;
  }

  /** storage creation expression for an array-typed variable */
  arrayStorage(q) {
    const arr = arrayParts(q);
    if (!arr) return null;
    if (arrayParts(arr.elem)) { // multi-dim: first-bracket peeling — arr.count = rows, inner.count = cols
      const inner = arrayParts(arr.elem);
      const rows = arr.count, cols = inner.count;
      if (arrayParts(inner.elem)) { // 3-D+: nest one more level of row arrays
        return `Array.from({ length: ${rows} }, () => ${this.arrayStorage(arr.elem)})`;
      }
      // flat backing + subarray rows: rows stay contiguous, so pointer-to-array
      // arithmetic and whole-array memset work (decay() unwraps .buf)
      const rowBytes = `${cols} * ${inner.elem.includes('*') ? 8 : this.sizeofType(inner.elem)}`;
      return `(function () { const flat = new Uint8Array(${rows} * (${rowBytes})); const a = []; for (let r = 0; r < ${rows}; r++) a.push(flat.subarray(r * (${rowBytes}), (r + 1) * (${rowBytes}))); a.buf = flat; return a; })()`;
    }
    if (/\bchar\b/.test(arr.elem)) return `new Uint8Array(${arr.count})`;
    if (/\bint\b/.test(arr.elem) && !/\blong\b/.test(arr.elem)) return `new Array(${arr.count}).fill(0)`;
    if (/\bshort\b/.test(arr.elem)) return `new Array(${arr.count}).fill(0)`;
    if (arr.elem.includes('*')) return this.cptrCall('alloc', `${arr.count} * 8`); // pointer elements: ldPtr/stPtr slots
    if (/\blong long\b/.test(arr.elem) || arr.elem === 'unsigned long long') return `new Array(${arr.count}).fill(0n)`;
    if (/^enum\s/.test(arr.elem) || (this.recordNameOf(arr.elem) && this.records.get(this.recordNameOf(arr.elem))?.tag === 'enum')) {
      return `new Array(${arr.count}).fill(0)`; // enum elements are int-sized
    }
    if (arr.elem === 'boolean') return `new Uint8Array(${arr.count})`;
    if (parseType(arr.elem).cls === 'record' || this.recordNameForType(arr.elem)) {
      // struct/union array without initializer: byte-packed elements
      const recName = this.recordNameForType(arr.elem);
      const sz = this.layoutOf(recName).size;
      return this.cptrCall('alloc', `${arr.count} * ${sz}`);
    }
    throw new Error(`array storage for "${q}" unsupported (v1)`);
  }

  /**
   * Hoisted decls (smMode / regionHoisted) leave a bare `let` at fn top; a
   * local ARRAY still needs its storage created at the decl site. Returns
   * true when the decl was array-typed and an assignment was emitted.
   */
  emitHoistedArrayAssign(d, q, init, indent, lines) {
    if (!arrayParts(q)) return false;
    const nm = jsName(d.name);
    if (init && init.kind === 'StringLiteral') {
      lines.push(`${indent}${nm} = ${this.cptrCall('bytes', this.cStringToJs(init.value))};`);
      return true;
    }
    const packed = this.emitBytePackedArray(nm, q, init, `${nm} = `);
    if (packed) { lines.push(`${indent}${packed.join(' ')}`); return true; }
    if (init) lines.push(`${indent}${nm} = ${this.emitExpr(init).code};`);
    else lines.push(`${indent}${nm} = ${this.arrayStorage(q)};`);
    return true;
  }

  localVarDecl(d) {
    const q = desugar(d.type);
    const init = (d.inner || []).find((c) => c && c.kind && !c.kind.endsWith('Attr') && !c.kind.endsWith('Comment'));
    const arr = arrayParts(q);
    const rawName = d.name;
    d = { ...d, name: jsName(rawName) };
    d._rawName = rawName;
    if (arr) {
      if (init && init.kind === 'StringLiteral') return `let ${d.name} = ${this.cptrCall('bytes', this.cStringToJs(init.value))};`;
      const packed = this.emitBytePackedArray(d.name, q, init, `let ${d.name} = `);
      if (packed) return packed.join(' ');
      if (init) return `let ${d.name} = ${this.emitExpr(init).code};`;
      return `let ${d.name} = ${this.arrayStorage(q)};`;
    }
    const t = parseType(q);
    if (t.cls === 'record' && this.isEnumType(q)) {
      if (init) return `let ${d.name} = ${this.emitExpr(init).code};`;
      return `let ${d.name};`;
    }
    if (t.cls === 'record') {
      // struct/union value local: byte-packed storage, variable holds its CPtr
      const recName = this.recordNameForType(q);
      const size = this.layoutOf(recName).size;
      this.recordLocals.add(d.name);
      let code = `let ${d.name} = ${this.cptrCall('alloc', String(size))};`;
      if (init) code += ' ' + this.recordInitStores(d.name, recName, init).join(' ');
      return code;
    }
    if (this.boxedVars?.has(d._rawName || d.name)) {
      this.usesCptr = true;
      return `let ${d.name} = cptr.box(${init ? this.convert(this.emitExpr(init), nodeType(init), t).code : t.bits === 64 ? '0n' : 0});`;
    }
    if (init) return `let ${d.name} = ${this.convert(this.emitExpr(init), nodeType(init), t).code};`;
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
        if (thenWasBlock) lines[last] = elseHead;
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
    const e = (n.inner || []).find((c) => c && c.kind && !c.kind.endsWith('Attr') && !c.kind.endsWith('Comment'));
    return [`${indent}return${e ? ' ' + this.emitExpr(e).code : ''};`];
  }

  stmt_SwitchStmt(n, indent) {
    const kids = (n.inner || []).filter((c) => c && c.kind);
    const [cond, body] = kids;
    if (!body || body.kind !== 'CompoundStmt') throw new Error(`switch without compound body (${this.cref(n)})`);
    // Duff's device check: case/default labels must be reachable from the
    // switch body directly or through case chains only (case-in-loop/if is
    // legal C that JS cannot express)
    const items = (body.inner || []).filter((c) => c && c.kind);
    const self = this;
    (function check(items) {
      for (const it of items) {
        if (it.kind === 'CaseStmt' || it.kind === 'DefaultStmt') {
          check((it.inner || []).filter((c) => c && c.kind).slice(1)); // case chains stay legal
          continue;
        }
        (function walk(x) {
          if (!x || typeof x !== 'object') return;
          if (x.kind === 'SwitchStmt') return; // nested switch: its cases are its own
          if (x.kind === 'CaseStmt' || x.kind === 'DefaultStmt') {
            throw new Error(`duff-style nested case label (${self.cref(n)})`);
          }
          for (const c of x.inner || []) walk(c);
        })(it);
      }
    })(items);
    // C allows declarations between case labels; hoisting keeps JS out of TDZ
    const hoisted = [];
    for (const it of items) {
      if (it.kind === 'DeclStmt') {
        for (const d of (it.inner || []).filter((c) => c.kind === 'VarDecl')) {
          const q = (d.type?.desugaredQualType || d.type?.qualType || '');
          if (/\[/.test(q)) throw new Error(`array decl inside switch body (${this.cref(d)})`);
          hoisted.push(`let ${d.name};`);
        }
      }
    }
    let lines = [];
    for (const h of hoisted) lines.push(`${indent}${h}`);
    lines.push(`${indent}switch (${this.emitExpr(cond).code}) {`);
    const bodyPlan = this.smMode ? [] : (this.gotoPlan?.blockLabels.get(body) || []).filter((l) => l.dir !== 'swloop');
    if (bodyPlan && bodyPlan.length) {
      lines.push(...this.emitLabeledItems(items, indent + '    ', bodyPlan, (it, ind) => this.emitSwitchItem(it, ind)));
    } else {
      for (const it of items) lines.push(...this.emitSwitchItem(it, indent + '    '));
    }
    lines.push(`${indent}}`);
    const swloops = (this.gotoPlan?.blockLabels.get(body) || []).filter((l) => l.dir === 'swloop');
    for (const l of swloops) {
      // while(true)+break, not do{}while(false): continue L on a do-while
      // exits instead of re-dispatching the switch (see bwds comment)
      if (this.hasUnboundContinue(body)) throw new Error(`goto ${l.name}: swloop switch body has unbound continue (sm fallback)`);
      lines = [`${indent}${this.mangleLabel(l.name)}: while (true) {`, ...lines.map((x) => '    ' + x), `${indent}    break ${this.mangleLabel(l.name)};`, `${indent}}`];
    }
    return lines;
  }

  emitSwitchItem(it, indent) {
    if (it.kind === 'LabelStmt') {
      const sub = (it.inner || []).find((c) => c && c.kind && !c.kind.endsWith('Attr') && !c.kind.endsWith('Comment'));
      return sub ? this.emitStmt(sub, indent) : [`${indent};`];
    }
    if (it.kind === 'CaseStmt') {
      const kids = (it.inner || []).filter((c) => c && c.kind);
      const val = this.emitExpr(kids[0]);
      const lines = [`${indent}case ${val.code}:`];
      if (kids.length > 1) lines.push(...this.emitSwitchItem(kids[1], indent));
      return lines;
    }
    if (it.kind === 'DefaultStmt') {
      const kids = (it.inner || []).filter((c) => c && c.kind);
      const lines = [`${indent}default:`];
      if (kids.length) lines.push(...this.emitSwitchItem(kids[0], indent));
      return lines;
    }
    if (it.kind === 'DeclStmt') {
      // hoisted above the switch; keep only the initializers as assignments
      const lines = [];
      for (const d of (it.inner || []).filter((c) => c.kind === 'VarDecl')) {
        const init = (d.inner || []).find((c) => c && c.kind && !c.kind.endsWith('Attr') && !c.kind.endsWith('Comment'));
        if (init) lines.push(`${indent}${d.name} = ${this.emitExpr(init).code};`);
      }
      return lines.length ? lines : [`${indent};`];
    }
    return this.emitStmt(it, indent);
  }

  stmt_AttributedStmt(n, indent) {
    // statement attributes ([[fallthrough]], gcc attrs): transparent — emit
    // the wrapped statement(s), keep the attr as a comment for provenance
    const kids = (n.inner || []).filter((c) => c && c.kind);
    const stmts = kids.filter((c) => !c.kind.endsWith('Attr'));
    const attrs = kids.filter((c) => c.kind.endsWith('Attr')).map((c) => c.kind.replace(/Attr$/, '')).join(',');
    const lines = attrs ? [`${indent}// @${attrs}`] : [];
    for (const st of stmts) lines.push(...this.emitStmt(st, indent));
    return lines;
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

  /** module-scope field stores for a record initializer */
  recordInitStores(name, recName, initNode) {
    const rec = this.records.get(recName);
    if (!rec || !rec.fields) throw new Error(`recordInitStores: unknown record ${recName}`);
    if (initNode.kind !== 'InitListExpr') {
      // whole-record copy initializer: struct x a = b;
      return [`${this.cptrCall('memcpy', name, this.emitExpr(initNode).code, String(this.layoutOf(recName).size))};`];
    }
    const inits = this.initListElems(initNode);
    const lines = [];
    for (let i = 0; i < rec.fields.length; i++) {
      const init = inits[i];
      if (!init || init.kind === 'ImplicitValueInitExpr') continue;
      const f = rec.fields[i];
      const off = this.layoutOf(recName).offsets[f.name];
      const loc = off === 0 ? name : this.cptrCall('add', name, String(off));
      if (!arrayParts(f.q) && (parseType(f.q).cls === 'record' || this.recordNameForType(f.q)) && !this.isEnumType(f.q)) {
        // nested record field: recursive stores (InitListExpr) or whole copy
        const fRecName = this.recordNameForType(f.q);
        if (init.kind === 'InitListExpr') lines.push(...this.recordInitStores(loc, fRecName, init));
        else lines.push(`${this.cptrCall('memcpy', loc, this.emitExpr(init).code, String(this.layoutOf(fRecName).size))};`);
      } else if (arrayParts(f.q)) {
        // array field: string literal or per-element stores
        const a = arrayParts(f.q);
        const elemRec = !this.isEnumType(a.elem) && (parseType(a.elem).cls === 'record' || this.recordNameForType(a.elem)) ? this.recordNameForType(a.elem) : null;
        const esz = this.sizeofType(a.elem);
        if (init.kind === 'StringLiteral') lines.push(`${this.cptrCall('strcpy', loc, this.emitExpr(init).code)};`);
        else if (init.kind === 'InitListExpr') {
          const els = this.initListElems(init);
          for (let j = 0; j < els.length; j++) {
            if (els[j].kind === 'ImplicitValueInitExpr') continue;
            const eloc = this.cptrCall('add', loc, String(j * esz));
            if (elemRec) lines.push(...this.recordInitStores(eloc, elemRec, els[j]));
            else lines.push(`${this.storeTo(eloc, a.elem, this.emitExpr(els[j]).code)};`);
          }
        }
      } else {
        lines.push(`${this.storeTo(loc, f.q, this.emitExpr(init).code)};`);
      }
    }
    return lines;
  }

  hoistStaticLocal(d) {
    const name = this.staticLocals.get(d.id);
    const q = desugar(d.type);
    const init = (d.inner || []).find((c) => c && c.kind && !c.kind.endsWith('Attr') && !c.kind.endsWith('Comment'));
    if (parseType(q).cls === 'record' && !q.includes('*') && !this.isEnumType(q)) {
      const recName = this.recordNameForType(q);
      const size = this.layoutOf(recName).size;
      let out = `let ${name} = ${this.cptrCall('alloc', String(size))}; /** C ref: ${this.cref(d)} — ${q} (function-static) */`;
      if (init) out += "\n" + this.recordInitStores(name, recName, init).join("\n");
      return out;
    }
    if (arrayParts(q)) {
      const arr = arrayParts(q);
      if (init && init.kind === 'StringLiteral') return `const ${name} = ${this.cptrCall('bytes', this.cStringToJs(init.value))}; /** C ref: ${this.cref(d)} — ${q} (function-static) */`;
      const packed = this.emitBytePackedArray(name, q, init, `const ${name} = `);
      if (packed) return packed.join('\n') + ` /** C ref: ${this.cref(d)} — ${q} (function-static) */`;
      if (init) return `const ${name} = ${this.emitExpr(init).code}; /** C ref: ${this.cref(d)} — ${q} (function-static) */`;
      return `const ${name} = ${this.arrayStorage(q)}; /** C ref: ${this.cref(d)} — ${q} (function-static) */`;
    }
    const initCode = init ? this.emitExpr(init).code : q.includes('*') ? 'null' : '0';
    if (this.boxedVars?.has(name)) { // address-taken static: the box is its address
      this.usesCptr = true;
      return `let ${name} = ${this.cptrCall('box', initCode)}; /** C ref: ${this.cref(d)} — ${q} (function-static, boxed) */`;
    }
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
    for (const v of statics) {
      const q = desugar(v.type);
      if (parseType(q).cls === 'record' && !q.includes('*')) this.recordLocals.add(this.staticLocals.get(v.id));
      // hoisted record/pointer/scalar arrays are cptr-backed: register before body emission
      const sa = arrayParts(q);
      if (sa && !arrayParts(sa.elem)) {
        const el = sa.elem;
        if (el.includes('*') || this.isEnumType(el) || /\b(?:int|short|long|double|float)\b/.test(el) || this.recordNameForType(el)) this.cptrArrays.add(this.staticLocals.get(v.id));
      }
    }
    const lines = [];
    let smFallback = false;
    this.regionHoisted = null; // per-function: stale names from a previous fn would suppress real decls
    try {
      this.gotoPlan = this.analyzeGotos(d.name, body);
    } catch (e) {
      if (!/goto|label/i.test(String((e && e.message) || e))) throw e;
      smFallback = true;
    }
    // local names shadow the global externBoxed set
    this.localNames = new Set(params.map((p) => p.name));
    (function walkLocals(n, self) {
      if (!n || typeof n !== 'object') return;
      if (n.kind === 'VarDecl' && n.name && n.storageClass !== 'extern') self.localNames.add(n.name);
      for (const c of n.inner || []) walkLocals(c, self);
    })(body, this);
    // tier-2 address-of: locals/params whose address is taken become boxes
    this.boxedVars = new Set();
    (function walk(n, self) {
      if (!n || typeof n !== 'object') return;
      if (n.kind === 'UnaryOperator' && n.opcode === '&') {
        const sub = n.inner[0];
        if (sub.kind === 'DeclRefExpr') {
          // strip qualifiers before the record test ("const struct x" IS a record).
          // Resolve typedefs with the shared desugar — the slim IR often has only
          // the alias name (e.g. "terrain"), which the raw regex can't classify.
          const q = desugar(sub.type).replace(/\bconst\b|\brestrict\b|\bvolatile\b/g, '').replace(/\s+/g, ' ').trim();
          const nm = sub.name || sub.referencedDecl?.name;
          const isRecordValue = /^(struct|union)\b[^*]*$/.test(q)
            || (!q.includes('*') && !q.includes('[') && !q.includes('(')
                && parseType(q).cls === 'record' && !self.isEnumType(q));
          // hoisted statics have module lifetime and their own storage —
          // box them under their HOISTED name (the box is their address)
          const hoisted = sub.referencedDecl?.id && self.staticLocals.get(sub.referencedDecl.id);
          if (nm && !/\[/.test(q) && !/\(/.test(q) && !isRecordValue && !self.recordLocals.has(nm)) {
            self.boxedVars.add(hoisted || nm);
          }
        }
      }
      for (const c of n.inner || []) walk(c, self);
    })(body, this);
    this.vaRest = d.variadic ? '__va' : null;

    const paramDoc = params.map((p) => `@param {${this.jsdocType(p.type?.qualType, p.type?.desugaredQualType)}} ${p.name}`).join(' ');
    const retDoc = this.jsdocType(retQ) === 'void' ? '' : ` @returns {${this.jsdocType(retQ)}}`;
    lines.push(`/** C ref: ${this.cref(d)}${paramDoc ? ' — ' + paramDoc : ''}${retDoc} */`);
    const isStatic = d.storageClass === 'static';
    const paramNames = params.map((p) => jsName(p.name));
    if (d.variadic) paramNames.push('...__va');
    lines.push(`${isStatic ? '' : 'export '}function ${jsName(d.name)}(${paramNames.join(', ')}) {`);
    for (const p of params) {
      if (this.boxedVars.has(p.name)) {
        this.usesCptr = true;
        lines.push(`    ${jsName(p.name)} = cptr.box(${jsName(p.name)});`);
      }
    }
    // by-value struct params: callers pass a CPtr location; C semantics give
    // the callee its own copy. Register as record locals (byte-model member
    // access) and clone on entry.
    for (const p of params) {
      const q = desugar(p.type);
      if (q.includes('*') || arrayParts(q) || parseType(q).cls !== 'record' || this.isEnumType(q)) continue;
      const recName = this.recordNameForType(q);
      const size = recName && this.layoutOf(recName)?.size;
      if (size == null) continue;
      this.recordLocals.add(p.name);
      this.recordLocals.add(jsName(p.name));
      lines.push(`    ${jsName(p.name)} = ${this.cptrCall('dup', jsName(p.name), String(size))}; // by-value struct param`);
    }
    // regionHoisted decls belong to the pattern lowerings only — the state
    // machine hoists every local itself, so emitting both duplicates `let`s
    const rhLines = [];
    if (this.regionHoisted?.size) {
      rhLines.push(`    let ${[...this.regionHoisted].map((nm) => this.boxedVars?.has(nm) ? `${jsName(nm)} = ${this.cptrCall('box', '0')}` : jsName(nm)).join(', ')};`);
      if ([...this.regionHoisted].some((nm) => this.boxedVars?.has(nm))) this.usesCptr = true;
    }
    if (smFallback) {
      this.smMode = true;
      try {
        lines.push(...this.emitStateMachine(d, body));
      } finally {
        this.smMode = false;
      }
    } else {
      try {
        const bodyLines = this.emitBlockItems((body.inner || []).filter((x) => x && x.kind), '    ', body);
        lines.push(...rhLines, ...bodyLines);
      } catch (e) {
        if (!/goto|label/i.test(String((e && e.message) || e))) throw e;
        // pattern lowerings rejected this function's control flow: fall back
        // to the per-function state machine (labels as dispatch states)
        this.smMode = true;
        try {
          lines.push(...this.emitStateMachine(d, body));
        } finally {
          this.smMode = false;
        }
      }
    }
    lines.push('}');
    if (statics.length) lines.unshift(...statics.map((s) => this.hoistStaticLocal(s)), '');
    return lines;
  }

  /**
   * Byte-packed array declaration for record/pointer/scalar-elem arrays.
   * Returns emitted lines, or null when the array keeps its legacy storage
   * (1-byte char/boolean elems, multi-dim, or unhandled init shape).
   * Registers the name in cptrArrays on success.
   */
  emitBytePackedArray(name, q, init, prefix) {
    const arr = arrayParts(q);
    if (!arr) return null;
    if (arrayParts(arr.elem)) {
      // 2-D array: plain JS array of byte-rows (row selection stays `arr[i]`)
      const inner = arrayParts(arr.elem);
      const el2 = inner.elem;
      let sz2, rec2;
      if (el2.includes('*')) sz2 = 8;
      else if (this.isEnumType(el2)) sz2 = 4;
      else if (/\b(?:int|short|long|double|float)\b/.test(el2)) {
        try { sz2 = this.sizeofType(el2); } catch { return null; }
        if (sz2 === 1) return null; // char 2-D rows: arrayStorage's Uint8Array rows
      } else if ((rec2 = this.recordNameForType(el2)) && !this.isEnumType(el2)) {
        sz2 = this.layoutOf(rec2).size;
      } else return null;
      const inits = init && init.kind === 'InitListExpr' ? this.initListElems(init) : null;
      // first-bracket peeling: arr.count = rows, inner.count = cols
      const rows = arr.count ?? (inits ? inits.length : 0);
      const cols = inner.count ?? 0;
      // flat backing + subarray rows: contiguous rows make pointer-to-array
      // arithmetic (decay(arr) + row*rowbytes) and whole-array memset work
      const lines = [`${prefix}(function () { const flat = new Uint8Array(${rows} * ${cols} * ${sz2}); const a = []; for (let r = 0; r < ${rows}; r++) a.push(flat.subarray(r * ${cols} * ${sz2}, (r + 1) * ${cols} * ${sz2})); a.buf = flat; return a; })();`];
      if (inits) {
        for (let i = 0; i < inits.length; i++) {
          if (inits[i].kind !== 'InitListExpr') continue;
          const els = this.initListElems(inits[i]);
          for (let j = 0; j < els.length; j++) {
            if (els[j].kind === 'ImplicitValueInitExpr') continue;
            const eloc = this.cptrCall('add', this.cptrCall('decay', `${name}[${i}]`), String(j * sz2));
            if (rec2) lines.push(...this.recordInitStores(eloc, rec2, els[j]));
            else lines.push(`${this.storeTo(eloc, el2, this.emitExpr(els[j]).code)};`);
          }
        }
      } else if (init) {
        return null; // non-InitList initializer: caller's fallback
      }
      return lines;
    }
    const el = arr.elem;
    const isRec = !el.includes('*') && !this.isEnumType(el) && (parseType(el).cls === 'record' || this.recordNameForType(el)) && this.recordNameForType(el);
    let sz;
    if (isRec) sz = this.layoutOf(this.recordNameForType(el)).size;
    else if (this.isEnumType(el)) sz = 4;
    else {
      if (!el.includes('*') && !/\b(?:int|short|long|double|float)\b/.test(el)) return null;
      try { sz = this.sizeofType(el); } catch { return null; }
      if (sz === 1) return null; // char/boolean elems keep Uint8Array storage
    }
    this.cptrArrays.add(name);
    const inits = init && init.kind === 'InitListExpr' ? this.initListElems(init) : null;
    const count = arr.count ?? (inits ? inits.length : 0);
    const lines = [`${prefix}${this.cptrCall('alloc', `${count} * ${sz}`)};`];
    if (inits) {
      for (let i = 0; i < inits.length; i++) {
        if (inits[i].kind === 'ImplicitValueInitExpr') continue;
        const loc = this.cptrCall('add', name, String(i * sz));
        if (isRec) lines.push(...this.recordInitStores(loc, this.recordNameForType(el), inits[i]));
        else lines.push(`${this.storeTo(loc, el, this.emitExpr(inits[i]).code)};`);
      }
    } else if (init) {
      this.cptrArrays.delete(name);
      return null; // non-InitList initializer: caller's fallback
    }
    return lines;
  }

  emitTopVar(d) {
    d = { ...d, name: jsName(d.name) };
    const q = desugar(d.type);
    const init = (d.inner || []).find((c) => c && c.kind && !c.kind.endsWith('Attr') && !c.kind.endsWith('Comment'));
    const lines = [`/** C ref: ${this.cref(d)} — ${q} */`];
    const exp = d.storageClass === 'static' ? '' : 'export ';
    if (parseType(q).cls === 'record' && !q.includes('*') && this.recordNameForType(q) && !this.isEnumType(q)) {
      this.recordGlobals.add(d.name);
      const recName = this.recordNameForType(q);
      const size = this.layoutOf(recName).size;
      // record globals can be boxed too (address taken / written cross-TU):
      // refs then use name.v, so the definition must BE a box
      const boxed = this.topBoxed?.has(d.name) || this.externBoxed.has(d.name);
      if (boxed) this.usesCptr = true;
      lines.push(`${exp}let ${d.name} = ${boxed ? this.cptrCall('box', this.cptrCall('alloc', String(size))) : this.cptrCall('alloc', String(size))};`);
      if (init) lines.push(...this.recordInitStores(boxed ? `${d.name}.v` : d.name, recName, init));
      return lines;
    }
    if (arrayParts(q)) {
      const arr = arrayParts(q);
      if (init && init.kind === 'StringLiteral') {
        // char arr[] = "...": modifiable byte storage like any other char array
        lines.push(`${exp}const ${d.name} = ${this.cptrCall('bytes', this.cStringToJs(init.value))};`);
        return lines;
      }
      const packed = this.emitBytePackedArray(d.name, q, init, `${exp}const ${d.name} = `);
      if (packed) { lines.push(...packed); return lines; }
      if (init) lines.push(`${exp}const ${d.name} = ${this.emitExpr(init).code};`);
      else lines.push(`${exp}const ${d.name} = ${this.arrayStorage(q)};`);
      return lines;
    }
    const kw = 'let';
    const t0 = parseType(q);
    const zero = q.includes('*') ? 'null' : t0.bits === 64 ? '0n' : '0';
    if (this.topBoxed?.has(d.name) || this.externBoxed.has(d.name)) {
      this.usesCptr = true;
      lines.push(`${exp}let ${d.name} = cptr.box(${init ? this.convert(this.emitExpr(init), nodeType(init), t0).code : zero});`);
      return lines;
    }
    const initCode = init ? this.convert(this.emitExpr(init), nodeType(init), t0).code : zero;
    lines.push(`${exp}${kw} ${d.name} = ${initCode};`);
    return lines;
  }

  emitEnum(d) {
    const lines = [`/** C ref: ${this.cref(d)} — enum */`];
    let next = 0;
    for (const c of (d.inner || []).filter((x) => x && x.kind === 'EnumConstantDecl')) {
      const init = (c.inner || []).find((x) => x && x.kind);
      const v = init ? Number(this.emitExpr(init).const ?? this.emitExpr(init).code) : next;
      lines.push(`export const ${c.name} = ${v};`);
      next = v + 1;
    }
    return lines;
  }

  emitRecord(d) {
    const fields = this.records.get(d.name)?.fields || [];
    return [`/** C ref: ${this.cref(d)} — struct ${d.name} { ${fields.map((f) => f.name).join(', ')} } (memory model v0.5) */`];
  }

  emitModule() {
    for (const d of this.decls) {
      if (d.kind === 'FunctionDecl') {
        if ((d.inner || []).some((c) => c && c.kind === 'CompoundStmt')) this.declared.add(d.name);
      } else if (d.kind === 'VarDecl' && d.storageClass !== 'extern') this.declared.add(d.name);
      else if (d.kind === 'EnumDecl') {
        for (const c of (d.inner || []).filter((x) => x && x.kind === 'EnumConstantDecl')) this.declared.add(c.name);
      }
    }
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
          if (d.storageClass === 'extern') break; // declaration only; defined elsewhere
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
          if (d.kind.endsWith('Attr') || d.kind.endsWith('Comment')) break; // no-ops
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
