/**
 * C-style printf implementation for NetHack transpilation.
 * Supports a subset of the full format specifier inventory used by NetHack 5.0.
 * @module
 */

/**
 * @typedef {number|bigint|string|null|undefined} PrintfArg
 */

/**
 * @typedef {Object} Spec
 * @property {boolean} left - left-align flag '-'
 * @property {boolean} plus - plus sign flag '+'
 * @property {boolean} space - space flag ' '
 * @property {boolean} alt - alternate form flag '#'
 * @property {boolean} zero - zero-pad flag '0'
 * @property {number|undefined} width - field width
 * @property {number|undefined} precision - precision
 * @property {string} conv - conversion character
 * @property {boolean} isLong - length modifier 'l'
 * @property {boolean} isUnsigned - conversion is unsigned (%u %x %X)
 * @property {boolean} isUpper - uppercase hex / sign? not used
 */

/**
 * Parse a format specifier starting at 'fmt[pos]' which is '%'.
 * Returns the parsed specifier and the index of the character after the conversion.
 * @param {string} fmt - format string
 * @param {number} pos - index of '%'
 * @returns {[Spec, number]} parsed spec and new position
 */
function parseSpec(fmt, pos) {
  let i = pos + 1;
  const spec = {
    left: false,
    plus: false,
    space: false,
    alt: false,
    zero: false,
    width: undefined,
    precision: undefined,
    conv: '',
    isLong: false,
    isUnsigned: false,
    isUpper: false
  };
  // flags
  while (i < fmt.length) {
    const ch = fmt[i];
    if (ch === '-') spec.left = true;
    else if (ch === '+') spec.plus = true;
    else if (ch === ' ') spec.space = true;
    else if (ch === '#') spec.alt = true;
    else if (ch === '0') spec.zero = true;
    else break;
    i++;
  }
  // width
  let widthStr = '';
  while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') {
    widthStr += fmt[i++];
  }
  if (widthStr) spec.width = parseInt(widthStr, 10);
  // precision
  if (i < fmt.length && fmt[i] === '.') {
    i++;
    let precStr = '';
    while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') {
      precStr += fmt[i++];
    }
    // if no digits, precision is 0
    spec.precision = precStr ? parseInt(precStr, 10) : 0;
  }
  // length modifier
  if (i < fmt.length && (fmt[i] === 'l' || fmt[i] === 'L')) {
    // handle 'll' as well but NetHack only uses 'l'
    spec.isLong = true;
    i++;
    if (i < fmt.length && fmt[i] === 'l') i++; // skip extra l
  }
  // conversion
  if (i < fmt.length) {
    const conv = fmt[i++];
    spec.conv = conv;
    spec.isUnsigned = (conv === 'u' || conv === 'x' || conv === 'X');
    spec.isUpper = (conv === 'X');
  }
  return [spec, i];
}

/**
 * Format a numeric value according to the spec.
 * Handles %d, %i, %u, %x, %X, %ld, %lu, %lx, etc.
 * @param {Spec} spec - parsed specifier
 * @param {PrintfArg} arg - argument
 * @returns {string}
 */
function formatNumber(spec, arg) {
  let value = (typeof arg === 'bigint') ? arg : BigInt(Math.trunc(arg));
  // C semantics: a negative value under an unsigned conversion is
  // reinterpreted two's-complement at the conversion's width.
  if (spec.isUnsigned && value < 0n) {
    value = BigInt.asUintN(spec.isLong ? 64 : 32, value);
  }
  let isNegative = false;
  let absValue = value;
  if (!spec.isUnsigned) {
    if (value < 0n) {
      isNegative = true;
      absValue = -value;
    }
  }
  // Determine base
  let base = 10;
  if (spec.conv === 'x' || spec.conv === 'X') base = 16;
  let digits = absValue.toString(base);
  if (spec.isUpper) digits = digits.toUpperCase();
  // precision
  let precision = spec.precision;
  if (precision !== undefined) {
    if (precision === 0 && value === 0n) digits = '';
    else {
      while (digits.length < precision) digits = '0' + digits;
    }
  }
  // alternate form for hex
  let prefix = '';
  if (spec.alt && base === 16 && value !== 0n) {
    prefix = spec.isUpper ? '0X' : '0x';
  }
  // sign prefix
  if (!spec.isUnsigned && !isNegative) {
    if (spec.plus) prefix = '+' + prefix;
    else if (spec.space) prefix = ' ' + prefix;
  }
  if (isNegative) prefix = '-' + prefix;
  // width handling
  let body = prefix + digits;
  if (spec.width !== undefined) {
    let padLen = spec.width - body.length;
    if (padLen > 0) {
      if (spec.left) {
        body += ' '.repeat(padLen);
      } else if (spec.zero && spec.precision === undefined) {
        // zero-pad: insert zeros after sign/prefix
        // find position after prefix
        let prefixLen = prefix.length;
        body = prefix + '0'.repeat(padLen) + digits;
      } else {
        body = ' '.repeat(padLen) + body;
      }
    }
  }
  return body;
}

/**
 * Format a string argument for %s.
 * @param {Spec} spec - parsed specifier
 * @param {PrintfArg} arg - argument, expected string or null/undefined
 * @returns {string}
 */
function formatString(spec, arg) {
  let str;
  if (arg === null || arg === undefined) {
    str = '(null)';
  } else {
    str = String(arg);
  }
  // precision truncates
  if (spec.precision !== undefined) {
    if (spec.precision === 0) str = '';
    else if (str.length > spec.precision) str = str.slice(0, spec.precision);
  }
  // width
  if (spec.width !== undefined && str.length < spec.width) {
    const pad = spec.width - str.length;
    if (spec.left) str += ' '.repeat(pad);
    else str = ' '.repeat(pad) + str;
  }
  return str;
}

/**
 * Format a character for %c.
 * Note: the space flag is ignored for %c on macOS libc.
 * @param {Spec} spec - parsed specifier
 * @param {PrintfArg} arg - char code (number)
 * @returns {string}
 */
function formatChar(spec, arg) {
  const ch = String.fromCharCode(Number(arg));
  let str = ch;
  if (spec.width !== undefined && str.length < spec.width) {
    const pad = spec.width - str.length;
    if (spec.left) str += ' '.repeat(pad);
    else str = ' '.repeat(pad) + str;
  }
  return str;
}

/**
 * Format a pointer for %p.
 * @param {Spec} spec - parsed specifier
 * @param {PrintfArg} arg - string already in "0x..." form or number
 * @returns {string}
 */
function formatPointer(spec, arg) {
  let str;
  if (arg === null || arg === undefined) {
    str = '0x0';
  } else if (typeof arg === 'number') {
    // if number, format as hex with 0x prefix
    str = '0x' + arg.toString(16);
  } else {
    str = String(arg);
  }
  // width
  if (spec.width !== undefined && str.length < spec.width) {
    const pad = spec.width - str.length;
    if (spec.left) str += ' '.repeat(pad);
    else str = ' '.repeat(pad) + str;
  }
  return str;
}

/**
 * Format a percent literal.
 * @returns {string}
 */
function formatPercent() {
  return '%';
}

/**
 * Main sprintf implementation.
 * @param {string} fmt - format string
 * @param {...PrintfArg} args - arguments
 * @returns {string}
 */
function sprintf(fmt, ...args) {
  let out = '';
  let argIdx = 0;
  let i = 0;
  while (i < fmt.length) {
    const ch = fmt[i];
    if (ch === '%') {
      // Handle '%%'
      if (i + 1 < fmt.length && fmt[i + 1] === '%') {
        out += '%';
        i += 2;
        continue;
      }
      const [spec, next] = parseSpec(fmt, i);
      i = next;
      const arg = args[argIdx++];
      let part = '';
      switch (spec.conv) {
        case 'd':
        case 'i':
        case 'u':
        case 'x':
        case 'X':
          part = formatNumber(spec, arg);
          break;
        case 'c':
          part = formatChar(spec, arg);
          break;
        case 's':
          part = formatString(spec, arg);
          break;
        case 'p':
          part = formatPointer(spec, arg);
          break;
        case '%':
          part = '%';
          break;
        default:
          // Unknown spec, preserve as literal? Shouldn't happen.
          part = '%' + spec.conv;
          break;
      }
      out += part;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * snprintf: write formatted string into a Uint8Array, NUL-terminated.
 * Returns would-be length (excluding NUL).
 * @param {Uint8Array} buf - destination buffer
 * @param {number} n - size of buffer
 * @param {string} fmt - format string
 * @param {...PrintfArg} args - arguments
 * @returns {number}
 */
function snprintf(buf, n, fmt, ...args) {
  const full = sprintf(fmt, ...args);
  const len = full.length;
  if (n > 0) {
    const copyLen = Math.min(n - 1, len);
    for (let i = 0; i < copyLen; i++) {
      buf[i] = full.charCodeAt(i);
    }
    buf[copyLen] = 0; // NUL
  }
  return len;
}

export { sprintf, snprintf };
