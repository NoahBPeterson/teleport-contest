#!/usr/bin/env python3
"""gen_ops_gate.py — generate fixtures/ops_gate.c: every C operator over every
pair of scalar types and every kind of storage, on edge values.

The transpiler represents C integers in several ways (JS numbers, BigInt for
64-bit, bytes in a buffer for struct fields and arrays, boxes for address-taken
locals), so each operator is worth testing on each combination. Python's exact
integers decide which inputs would be undefined in C; those are left out, so
the program is clean under -fsanitize=undefined and every printed line has one
right answer. Results go to stdout; test-ops.mjs diffs native against JS.
"""
import itertools, random, sys

T = {  # name: (bits, signed, rank)
    'char': (8, 1, 1), 'signed char': (8, 1, 1), 'unsigned char': (8, 0, 1),
    'short': (16, 1, 2), 'unsigned short': (16, 0, 2),
    'int': (32, 1, 3), 'unsigned': (32, 0, 3),
    'long': (64, 1, 4), 'unsigned long': (64, 0, 4),
    'long long': (64, 1, 5), 'unsigned long long': (64, 0, 5),
}
SHORT = {t: t.replace('unsigned long long', 'ull').replace('long long', 'll').replace('unsigned long', 'ul')
         .replace('unsigned char', 'uc').replace('signed char', 'sc').replace('unsigned short', 'us')
         .replace('unsigned', 'ui') for t in T}

def lim(t):
    b, s, _ = T[t]
    return (-(1 << (b - 1)), (1 << (b - 1)) - 1) if s else (0, (1 << b) - 1)

def vals(t):
    lo, hi = lim(t)
    c = {lo, lo + 1, hi, hi - 1, 0, 1, 2, 3, 7, 8, 31, 32, 63, 100, 127, 128, 255, 256, 1000, 65535, 65536,
         1 << 30, 1 << 31, (1 << 31) + 1, (1 << 32) - 1, 1 << 32, 1 << 40, 1 << 53, (1 << 53) + 1}
    c |= {-x for x in list(c)}
    return sorted(x for x in c if lo <= x <= hi)

def lit(t, v):
    b, s, _ = T[t]
    if b == 64 or v > 2147483647 or v < -2147483648:
        if s:
            return f'(-9223372036854775807LL - 1)' if v == -(1 << 63) else f'{v}LL'
        return f'{v}ULL'
    return f'(-2147483647 - 1)' if v == -(1 << 31) else str(v)

def promote(t):
    return 'int' if T[t][2] < 3 else t

def usual(a, b):
    a, b = promote(a), promote(b)
    if a == b:
        return a
    (ba, sa, ra), (bb, sb, rb) = T[a], T[b]
    if sa == sb:
        return a if ra > rb else b
    u, s = (a, b) if not sa else (b, a)
    if T[u][2] >= T[s][2]:
        return u
    if T[s][0] > T[u][0]:
        return s
    return {'long': 'unsigned long', 'long long': 'unsigned long long', 'int': 'unsigned'}[s]

def wrap(t, v):
    b, s, _ = T[t]
    v &= (1 << b) - 1
    if s and v >= 1 << (b - 1):
        v -= 1 << b
    return v

def fits(t, v):
    lo, hi = lim(t)
    return lo <= v <= hi

def cdiv(a, b):
    q = abs(a) // abs(b)
    return q if (a < 0) == (b < 0) else -q

def binval(op, a, ta, b, tb):
    """Value of `a op b`, or None if C leaves it undefined."""
    if op in ('<<', '>>'):
        rt = promote(ta)
        x, n = wrap(rt, a), b
        if n < 0 or n >= T[rt][0]:
            return None
        if op == '>>':
            return x >> n
        if T[rt][1]:
            if x < 0 or not fits(rt, x << n):
                return None
            return x << n
        return wrap(rt, x << n)
    rt = usual(ta, tb)
    x, y = wrap(rt, a), wrap(rt, b)
    if op in ('<', '<=', '>', '>=', '==', '!='):
        return int({'<': x < y, '<=': x <= y, '>': x > y, '>=': x >= y, '==': x == y, '!=': x != y}[op])
    if op in ('/', '%'):
        if y == 0 or (T[rt][1] and x == lim(rt)[0] and y == -1):
            return None
        q = cdiv(x, y)
        return q if op == '/' else x - q * y
    r = {'+': x + y, '-': x - y, '*': x * y, '&': x & y, '|': x | y, '^': x ^ y}[op]
    if T[rt][1]:
        return r if fits(rt, r) else None
    return wrap(rt, r)

out = []
fns = []
rnd = random.Random(20261105)
idn = 0

def pfmt(t):
    return ('%llu', 'unsigned long long') if not T[t][1] else ('%lld', 'long long')

def pairs(ta, tb, f, cap):
    ps = [(a, b) for a in vals(ta) for b in vals(tb) if f(a, b) is not None]
    rnd.shuffle(ps)
    return ps[:cap]

def emit(body_for, ta, tb, ps, decl=''):
    """One function looping over (A[i], B[i])."""
    global idn
    if not ps:
        return
    idn += 1
    name = f'f{idn}'
    out.append(f'static void {name}(void)\n{{\n'
               f'    static const {ta} A[] = {{ {", ".join(lit(ta, p[0]) for p in ps)} }};\n'
               f'    static const {tb} B[] = {{ {", ".join(lit(tb, p[1]) for p in ps)} }};\n'
               f'    int i;\n{decl}\n    for (i = 0; i < {len(ps)}; i++) {{\n{body_for(idn)}    }}\n}}\n')
    fns.append(name)

def show(fid, t, expr):
    f, c = pfmt(t)
    return f'        printf("{fid} %d {f}\\n", i, ({c}) ({expr}));\n'

BIN = ['+', '-', '*', '/', '%', '<<', '>>', '&', '|', '^', '<', '<=', '>', '>=', '==', '!=']
CMP = {'<', '<=', '>', '>=', '==', '!='}
COMPOUND = ['+', '-', '*', '/', '%', '<<', '>>', '&', '|', '^']
types = list(T)

# ---- a op b on locals, over every pair of types
for ta, tb in itertools.product(types, types):
    for op in BIN:
        rt = 'int' if op in CMP else promote(ta) if op in ('<<', '>>') else usual(ta, tb)
        ps = pairs(ta, tb, lambda a, b: binval(op, a, ta, b, tb), 12)
        emit(lambda fid, op=op, rt=rt, ta=ta, tb=tb:
             f'        {ta} a = A[i];\n        {tb} b = B[i];\n' + show(fid, rt, f'a {op} b'), ta, tb, ps)

# ---- struct fields, one record per width as NetHack's structs mix them
fields = ''.join(f'    {t} f_{SHORT[t].replace(" ", "_")};\n' for t in types)
out.insert(0, f'struct rec {{\n{fields}    unsigned b1 : 1;\n    unsigned b3 : 3;\n    unsigned b7 : 7;\n    int sb4 : 4;\n}};\n'
              'static struct rec grec;\n')
fname = lambda t: 'f_' + SHORT[t].replace(' ', '_')

def compound_targets(t):
    fn = fname(t)
    return [
        ('local', '', 'x', ''),
        ('field', 'struct rec *p = &grec;\n', f'p->{fn}', ''),
        ('dot', '', f'grec.{fn}', ''),
        ('elem', f'    static {t} arr[3];\n', 'arr[1]', ''),
        ('deref', f'    {t} box_;\n    {t} *q = &box_;\n', '*q', ''),
    ]

# ---- x op= b and assignment across storage kinds
for ta in types:
    for tb in ['char', 'unsigned char', 'short', 'int', 'unsigned', 'long', 'unsigned long', ta]:
        for op in COMPOUND:
            def f(a, b):
                r = binval(op, a, ta, b, tb)
                return r
            ps = pairs(ta, tb, f, 6)
            for tag, decl, lv, _ in compound_targets(ta):
                d = '    ' + decl.strip() if decl else ''
                if tag == 'local':
                    d = f'    {ta} x;'
                emit(lambda fid, lv=lv, op=op, tb=tb, ta=ta:
                     f'        {tb} b = B[i];\n        {lv} = A[i];\n        {lv} {op}= b;\n' + show(fid, ta, lv), ta, tb, ps, d)
        # plain assignment converts
        ps = [(a, b) for a in vals(ta)[:1] for b in vals(tb)]
        for tag, decl, lv, _ in compound_targets(ta):
            d = '    ' + decl.strip() if decl else ''
            if tag == 'local':
                d = f'    {ta} x;'
            emit(lambda fid, lv=lv, tb=tb, ta=ta:
                 f'        {tb} b = B[i];\n        {lv} = b;\n' + show(fid, ta, lv), ta, tb, ps, d)

# ---- ++ -- ! ~ - + on every storage kind; result of the expression and the variable
for ta in types:
    vs = vals(ta)
    for tag, decl, lv, _ in compound_targets(ta):
        d = '    ' + decl.strip() if decl else ''
        if tag == 'local':
            d = f'    {ta} x;'
        for op, safe in (('({})++', 1), ('({})--', -1), ('++{}', 1), ('--{}', -1)):
            # narrow types promote, so ++ wraps at conversion; int and wider must not overflow
            ps = [(v, 0) for v in vs if T[ta][2] < 3 or not T[ta][1] or fits(ta, v + safe)]
            emit(lambda fid, lv=lv, op=op, ta=ta:
                 f'        {lv} = A[i];\n' + show(fid, 'long long' if T[ta][1] else 'unsigned long long', op.format(lv)) + show(fid, ta, lv),
                 ta, 'int', ps, d)
    rt = promote(ta)
    ps = [(v, 0) for v in vs if T[rt][1] == 0 or v != lim(rt)[0]]
    emit(lambda fid, ta=ta, rt=rt: f'        {ta} a = A[i];\n' + show(fid, rt, '-a') + show(fid, rt, '~a') + show(fid, 'int', '!a'),
         ta, 'int', ps)

# ---- casts between every pair, from each storage kind
for ta, tb in itertools.product(types, types):
    ps = [(v, 0) for v in vals(ta)]
    emit(lambda fid, ta=ta, tb=tb: f'        {ta} a = A[i];\n' + show(fid, tb, f'({tb}) a'), ta, 'int', ps)
    emit(lambda fid, ta=ta, tb=tb: f'        grec.{fname(ta)} = A[i];\n' + show(fid, tb, f'({tb}) grec.{fname(ta)}'), ta, 'int', ps)

# ---- ?: with mixed arms, logical operators, array index of each type
for ta, tb in itertools.product(types, types):
    rt = usual(ta, tb)
    ps = pairs(ta, tb, lambda a, b: 0, 6)
    emit(lambda fid, ta=ta, tb=tb, rt=rt:
         f'        {ta} a = A[i];\n        {tb} b = B[i];\n' + show(fid, rt, 'a ? a : b') + show(fid, rt, 'b ? a : b')
         + show(fid, 'int', 'a && b') + show(fid, 'int', 'a || b') + show(fid, 'int', '!a == !b'), ta, tb, ps)
    if T[ta][1] == 0 or T[tb][0] >= 0:
        ps2 = [(v, 0) for v in vals(ta) if 0 <= v <= 3]
        emit(lambda fid, ta=ta, tb=tb:
             f'        static const {tb} tab[4] = {{ {lit(tb, lim(tb)[0])}, {lit(tb, lim(tb)[1])}, 1, 0 }};\n'
             f'        {ta} k = A[i];\n        const {tb} *pt = tab;\n' + show(fid, tb, 'tab[k]') + show(fid, tb, 'pt[k]') + show(fid, tb, '*(pt + k)'),
             ta, 'int', ps2)

# ---- bit-fields: store truncates, read extends, compound ops stay in range
for tb in ['char', 'unsigned char', 'short', 'int', 'unsigned', 'long', 'unsigned long']:
    ps = [(0, b) for b in vals(tb)]
    for fld, width, signed in (('b1', 1, 0), ('b3', 3, 0), ('b7', 7, 0), ('sb4', 4, 1)):
        emit(lambda fid, fld=fld, tb=tb:
             f'        {tb} b = B[i];\n        struct rec *p = &grec;\n        p->{fld} = b;\n' + show(fid, 'int', f'p->{fld}')
             + f'        p->{fld} += 1;\n' + show(fid, 'int', f'p->{fld}') + f'        p->{fld} ^= 1;\n' + show(fid, 'int', f'grec.{fld}')
             + show(fid, 'int', f'!p->{fld}') + show(fid, 'int', f'p->{fld} ? 5 : 6'),
             'int', tb, ps)

# clang's JSON AST for one big file exceeds what JS can read as a string, so shard.
SHARDS = 6
outdir = sys.argv[1]
preamble, bodies = out[0], out[1:]
for k in range(SHARDS):
    pick = [(b, f) for i, (b, f) in enumerate(zip(bodies, fns)) if i % SHARDS == k]
    with open(f'{outdir}/ops_gate_{k}.c', 'w') as o:
        o.write('/* Generated by tools/c2js/gen_ops_gate.py — do not edit. */\n')
        o.write('#define _FORTIFY_SOURCE 0\n#include <stdio.h>\n\n' + preamble + '\n')
        o.write('\n'.join(b for b, _ in pick))
        o.write('\nint main(void)\n{\n' + ''.join(f'    {f}();\n' for _, f in pick) + '    return 0;\n}\n')
