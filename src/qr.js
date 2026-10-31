// QR codes (ISO/IEC 18004), for a phone's camera to open the web view's address with: the text's
// bytes (byte mode; an address is ASCII), error correction level M, which lets a code lose 15%
// and still read, in the smallest of versions 1 to 10 that holds them (213 bytes at most), with
// the mask the standard's penalty scores best. Drawn for a terminal in black and white.

// Level M, versions 1 to 10: each block's error correction codewords, and how many blocks.
const EC = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** The light modules around a code, which a reader needs to find it. */
const QUIET = 4;

// GF(256) modulo x^8 + x^4 + x^3 + x^2 + 1: the powers of 2, and their logarithms.
const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = EXP[i + 255] = x;
  LOG[x] = i;
  x = x & 0x80 ? (x << 1) ^ 0x11d : x << 1;
}
const times = (/** @type {number} */ a, /** @type {number} */ b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** @type {((y: number, x: number) => boolean)[]} the masks: whether the module in row y, column x turns over */
const MASKS = [
  (y, x) => (y + x) % 2 === 0,
  (y) => y % 2 === 0,
  (y, x) => x % 3 === 0,
  (y, x) => (y + x) % 3 === 0,
  (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
];

/**
 * Reed-Solomon error correction for a block's data: the remainder of its polynomial times x^n,
 * divided by (x - 1)(x - 2)(x - 4)...(x - 2^(n-1)), as n codewords.
 * @param {number[]} data
 * @param {number} n
 * @returns {number[]}
 */
export function correction(data, n) {
  /** The divisor's coefficients, the highest first. */
  let divisor = [1];
  for (let i = 0; i < n; i++) divisor = [...divisor, 0].map((c, j) => c ^ (j ? times(divisor[j - 1], EXP[i]) : 0));
  const rest = new Array(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ rest[0];
    rest.shift();
    rest.push(0);
    for (let j = 0; j < n; j++) rest[j] ^= times(divisor[j + 1], factor);
  }
  return rest;
}

/**
 * A version's codewords: all of them, and those of data at level M; the rest correct errors.
 * @param {number} version
 */
export function codewords(version) {
  // The modules left for them: all but the finder patterns with their separators, the timing
  // patterns, the format's, the alignment patterns (but where they cross the timing) and the version's.
  const aligns = version === 1 ? 0 : Math.floor(version / 7) + 2;
  const modules = (16 * version + 128) * version + 64 - (aligns ? (25 * aligns - 10) * aligns - 55 : 0) - (version >= 7 ? 36 : 0);
  const all = Math.floor(modules / 8);
  return { all, data: all - EC[version - 1] * BLOCKS[version - 1] };
}

/**
 * The rows, and the columns, of the alignment patterns' centers: none in version 1, then row 6
 * and the 7th from the end, and from version 7 the one halfway.
 * @param {number} version
 * @returns {number[]}
 */
export function alignments(version) {
  const last = 4 * version + 10;
  return version === 1 ? [] : version < 7 ? [6, last] : [6, (6 + last) / 2, last];
}

/**
 * The format's 15 bits for level M (00) and a mask: the 5 of data and 10 of BCH code, XOR
 * 101010000010010.
 * @param {number} mask
 */
export function formatBits(mask) {
  let rest = mask;
  for (let i = 0; i < 10; i++) rest = (rest << 1) ^ ((rest >> 9) * 0x537);
  return ((mask << 10) | rest) ^ 0x5412;
}

/**
 * The version's 18 bits, from version 7 on: its 6 and 12 of BCH code.
 * @param {number} version
 */
export function versionBits(version) {
  let rest = version;
  for (let i = 0; i < 12; i++) rest = (rest << 1) ^ ((rest >> 11) * 0x1f25);
  return (version << 12) | rest;
}

/**
 * Puts the format's bits in a code: around the top left finder, and split between the other two
 * with the dark module beside them.
 * @param {(y: number, x: number, on: boolean) => void} set
 * @param {number} size
 * @param {number} bits
 */
function placeFormat(set, size, bits) {
  const bit = (/** @type {number} */ i) => ((bits >> i) & 1) === 1;
  for (let i = 0; i < 6; i++) set(i, 8, bit(i));
  set(7, 8, bit(6));
  set(8, 8, bit(7));
  set(8, 7, bit(8));
  for (let i = 9; i < 15; i++) set(8, 14 - i, bit(i));
  for (let i = 0; i < 8; i++) set(8, size - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) set(size - 15 + i, 8, bit(i));
  set(size - 8, 8, true);
}

/**
 * The standard's penalty for a code, the lower the easier to read: runs of 5 or more modules
 * alike in a row or a column, 2 by 2 squares alike, what looks like a finder pattern (1:1:3:1:1
 * beside 4 light modules, the light beyond the code among them), and dark modules far from half.
 * @param {boolean[][]} code
 */
export function penalty(code) {
  const size = code.length;
  let score = 0;
  for (const line of [...code, ...code.map((_, x) => code.map((row) => row[x]))]) {
    for (let i = 0; i < size; ) {
      let j = i;
      while (j < size && line[j] === line[i]) j++;
      if (j - i >= 5) score += j - i - 2; // 3 for 5 alike, and 1 for each more
      i = j;
    }
    const s = `0000${line.map((on) => (on ? 1 : 0)).join('')}0000`;
    for (let k = s.indexOf('1011101'); k !== -1; k = s.indexOf('1011101', k + 1)) {
      if (s.startsWith('0000', k - 4) || s.startsWith('0000', k + 7)) score += 40;
    }
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const on = code[y][x];
      if (code[y][x + 1] === on && code[y + 1][x] === on && code[y + 1][x + 1] === on) score += 3;
    }
  }
  const dark = code.reduce((n, row) => n + row.filter(Boolean).length, 0);
  return score + 10 * Math.floor(Math.abs((100 * dark) / (size * size) - 50) / 5);
}

/**
 * A QR code of text: its modules row by row, true for dark, without the light border around it;
 * none when the text does not fit in version 10.
 * @param {string} text
 * @param {number} [mask] 0 to 7; by default the one the penalty scores best
 * @returns {boolean[][] | undefined}
 */
export function qr(text, mask) {
  const bytes = new TextEncoder().encode(text);
  // Before the bytes go the mode (4 bits) and their count (8 bits, 16 from version 10).
  let version = 1;
  while (version <= 10 && 4 + (version < 10 ? 8 : 16) + 8 * bytes.length > 8 * codewords(version).data) version++;
  if (version > 10) return undefined;
  const { all, data } = codewords(version);

  /** @type {number[]} */
  const bits = [];
  const put = (/** @type {number} */ value, /** @type {number} */ n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, 8 * data - bits.length)); // the end, as far as there is room
  put(0, (8 - (bits.length % 8)) % 8);
  /** @type {number[]} */
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((w, b) => (w << 1) | b, 0));
  for (let pad = 0xec; words.length < data; pad ^= 0xec ^ 0x11) words.push(pad);

  // The data in blocks, the last ones a codeword longer when they do not share it evenly, each
  // with its error correction; then a codeword from each block in turn, the data's first.
  const count = BLOCKS[version - 1];
  const ec = EC[version - 1];
  const short = Math.floor(all / count) - ec;
  /** @type {{ part: number[], fix: number[] }[]} */
  const blocks = [];
  for (let b = 0, at = 0; b < count; b++) {
    const length = short + (b < count - (all % count) ? 0 : 1);
    const part = words.slice(at, at + length);
    at += length;
    blocks.push({ part, fix: correction(part, ec) });
  }
  /** @type {number[]} */
  const stream = [];
  for (let i = 0; i <= short; i++) for (const { part } of blocks) if (i < part.length) stream.push(part[i]);
  for (let i = 0; i < ec; i++) for (const { fix } of blocks) stream.push(fix[i]);

  const size = 4 * version + 17;
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (/** @type {number} */ y, /** @type {number} */ x, /** @type {boolean} */ on) => {
    dark[y][x] = on;
    fixed[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // The finder patterns in three corners, each with its light separator inside the code.
  for (const [cy, cx] of [[3, 3], [3, size - 4], [size - 4, 3]]) {
    for (let y = Math.max(0, cy - 4); y <= Math.min(size - 1, cy + 4); y++) {
      for (let x = Math.max(0, cx - 4); x <= Math.min(size - 1, cx + 4); x++) {
        const d = Math.max(Math.abs(y - cy), Math.abs(x - cx));
        set(y, x, d !== 2 && d !== 4);
      }
    }
  }
  const centers = alignments(version);
  for (const cy of centers) {
    for (const cx of centers) {
      if ((cy === 6 && (cx === 6 || cx === size - 7)) || (cy === size - 7 && cx === 6)) continue; // a finder's corner
      for (let y = cy - 2; y <= cy + 2; y++) {
        for (let x = cx - 2; x <= cx + 2; x++) set(y, x, Math.max(Math.abs(y - cy), Math.abs(x - cx)) !== 1);
      }
    }
  }
  placeFormat(set, size, 0); // its places, kept for the mask's
  if (version >= 7) {
    const v = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const on = ((v >> i) & 1) === 1;
      set(Math.floor(i / 3), size - 11 + (i % 3), on);
      set(size - 11 + (i % 3), Math.floor(i / 3), on);
    }
  }
  // The codewords' bits, from the bottom right, two columns at a time, up and down by turns, past
  // the modules already set; any left over stay light.
  for (let right = size - 1, i = 0; right > 0; right -= 2) {
    if (right === 6) right = 5; // the timing pattern's column
    const up = ((right + 1) & 2) === 0;
    for (let n = 0; n < size; n++) {
      const y = up ? size - 1 - n : n;
      for (const x of [right, right - 1]) {
        if (fixed[y][x]) continue;
        dark[y][x] = i < 8 * stream.length && ((stream[i >> 3] >> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }

  const masked = (/** @type {number} */ m) => {
    const code = dark.map((row, y) => row.map((on, x) => on !== (!fixed[y][x] && MASKS[m](y, x))));
    placeFormat((y, x, on) => {
      code[y][x] = on;
    }, size, formatBits(m));
    return code;
  };
  if (mask !== undefined) return masked(mask);
  let best = masked(0);
  let least = penalty(best);
  for (let m = 1; m < 8; m++) {
    const code = masked(m);
    const score = penalty(code);
    if (score < least) [best, least] = [code, score];
  }
  return best;
}

/**
 * A QR code drawn for a terminal, black on bright white whatever its theme, with the light border
 * around it: a line holds two rows of modules (▀ in the top one's color on the bottom one's), or
 * with ascii one row, two spaces a module in the background's color.
 * @param {boolean[][]} code
 * @param {{ ascii?: boolean }} [opts]
 * @returns {string[]}
 */
export function qrLines(code, { ascii = false } = {}) {
  const size = code.length + 2 * QUIET;
  const on = (/** @type {number} */ y, /** @type {number} */ x) => code[y - QUIET]?.[x - QUIET] === true;
  /** @type {string[]} */
  const lines = [];
  for (let y = 0; y < size; y += ascii ? 1 : 2) {
    let line = '';
    let last = '';
    for (let x = 0; x < size; x++) {
      const sgr = ascii ? (on(y, x) ? '40' : '107') : `${on(y, x) ? '30' : '97'};${on(y + 1, x) ? '40' : '107'}`;
      if (sgr !== last) line += `\x1b[${sgr}m`;
      last = sgr;
      line += ascii ? '  ' : '▀';
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines;
}
