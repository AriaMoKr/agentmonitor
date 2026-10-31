import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignments, codewords, correction, formatBits, penalty, qr, qrLines, versionBits } from '../src/qr.js';

const ADDRESS = 'http://192.168.1.23:7420/AbCdEfGhIjKlMnOpQrStUvWx/';
const LONG = Array.from({ length: 200 }, (_, i) => String.fromCharCode(33 + ((i * 37) % 94))).join('');

/**
 * A code's modules from their bits, row by row, packed in base64.
 * @param {string} base64
 * @param {number} size
 */
function unpack(base64, size) {
  const bytes = Buffer.from(base64, 'base64');
  return Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => ((bytes[(y * size + x) >> 3] >> (7 - ((y * size + x) & 7))) & 1) === 1));
}

/**
 * The modules a drawing shows, read back from its colors: ▀ in black (30) or white (97) on black
 * (40) or white (107), two rows a line; with ascii, two spaces a module on black or white.
 * @param {string[]} lines
 * @param {boolean} [ascii]
 */
function read(lines, ascii = false) {
  /** @type {boolean[][]} */
  const rows = [];
  for (const line of lines) {
    let [fg, bg] = ['', ''];
    /** @type {[boolean[], boolean[]]} */
    const pair = [[], []];
    for (const piece of line.split(/(\x1b\[[\d;]*m)/)) {
      const sgr = /^\x1b\[([\d;]*)m$/.exec(piece);
      if (sgr) {
        for (const p of sgr[1].split(';')) {
          if (p === '0') [fg, bg] = ['', ''];
          else if (p === '30' || p === '97') fg = p;
          else bg = p;
        }
        continue;
      }
      if (ascii) {
        assert.match(piece, /^( {2})*$/);
        for (let i = 0; i < piece.length; i += 2) pair[0].push(bg === '40');
      } else {
        assert.match(piece, /^▀*$/);
        for (let i = 0; i < piece.length; i++) {
          pair[0].push(fg === '30');
          pair[1].push(bg === '40');
        }
      }
    }
    rows.push(...(ascii ? [pair[0]] : pair));
  }
  return rows;
}

/**
 * A code with the 4 light modules around it that a reader needs.
 * @param {boolean[][]} code
 */
function bordered(code) {
  const light = () => new Array(code.length + 8).fill(false);
  return [...Array.from({ length: 4 }, light), ...code.map((row) => [false, false, false, false, ...row, false, false, false, false]), ...Array.from({ length: 4 }, light)];
}

test('error correction: the codewords of the standard\'s example, and of HELLO WORLD in 1-M', () => {
  // ISO/IEC 18004, annex I: 01234567 in version 1-M.
  assert.deepEqual(correction([16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17], 10), [165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
  assert.deepEqual(correction([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('the format\'s bits at level M for each mask, and the version\'s from version 7, as the standard has them', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(formatBits), [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0]);
  assert.deepEqual([7, 8, 9, 10].map(versionBits), [0x07c94, 0x085bc, 0x09a99, 0x0a4d3]);
});

test('where the alignment patterns are, and how many codewords each version has', () => {
  assert.deepEqual([1, 2, 6, 7, 10].map(alignments), [[], [6, 18], [6, 34], [6, 22, 38], [6, 28, 50]]);
  const versions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual(versions.map((v) => codewords(v).all), [26, 44, 70, 100, 134, 172, 196, 242, 292, 346]);
  assert.deepEqual(versions.map((v) => codewords(v).data), [16, 28, 44, 64, 86, 108, 124, 154, 182, 216]);
});

test('the smallest version that holds the text: as many bytes as the standard says each holds at level M', () => {
  const holds = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  holds.forEach((n, i) => {
    assert.equal(qr('x'.repeat(n))?.length, 4 * (i + 1) + 17, `${n} bytes`);
    if (i < 9) assert.equal(qr('x'.repeat(n + 1))?.length, 4 * (i + 2) + 17, `${n + 1} bytes`);
  });
  assert.equal(qr('x'.repeat(214)), undefined);
  assert.equal(qr('é'.repeat(107)), undefined); // 214 bytes in UTF-8
  assert.equal(qr(ADDRESS)?.length, 33);
});

test('the codes are module for module those qrcode-generator makes with the same mask', () => {
  // Kazuhiko Arase's, as npm 10's qrcode-terminal has it: version 1 with mask 0, 4 with 2 (in two
  // blocks), 10 with 5 (five blocks, one longer, and the version's bits).
  const v1 = [
    '#######.....#.#######',
    '#.....#.#.#.#.#.....#',
    '#.###.#..#.##.#.###.#',
    '#.###.#..#.#..#.###.#',
    '#.###.#.#..##.#.###.#',
    '#.....#..###..#.....#',
    '#######.#.#.#.#######',
    '.........##..........',
    '#.#.#.#..#..#...#..#.',
    '.#####.#.#.#..###..##',
    '...####.#.##...###.##',
    '##..##.##..##...#....',
    '##.#.##..###...#....#',
    '........#.##.####..##',
    '#######..##.#########',
    '#.....#...###......#.',
    '#.###.#.#...##.#...#.',
    '#.###.#...#.#..##.##.',
    '#.###.#.#.###.###...#',
    '#.....#..#..#..#...#.',
    '#######.#.##...###.##',
  ];
  assert.deepEqual(qr('agentmonitor'), v1.map((row) => [...row].map((c) => c === '#')));
  assert.deepEqual(qr(ADDRESS), unpack('/kXXv8Efp1BusX9Lt11xxduskjLsFxxhB/qqqv4BZksAvndoPiaISvsc0mmawhdC1cb2EyXJp3xQDF7pyh0rvXucLtB4GO4Y6/tfxVK6zAZOrft12HVVRTk7BkhOsMUrCn2dr5l4+gBHWkU/gejq0Fti0Vut0i/V1D6QzuvhC9EE9Qs8/pYZmQA=', 33));
  assert.deepEqual(qr(LONG), unpack('/j0ytq4vP8Fea17bWJBuuC53wbXLt1AuyxMXpdumGxvw3hLsEaVLEvHxB/qqqqqqqv4BqehG6N4Agr1kfz5zZ2Cyk9273/qr0o6AAPJGzpGEWqALWPp4bhuP7PaY50gLlGUkNs6wkMKNEZhIT8agIWT9RlEMEwxwYOJ9CluKvm787WDUYMOlYj1CM5IRUvN4/pcWoEAW6ZVFZTMXF3xvR8vwa93RUm48U1B9Q3WoXgibrmh2an9MuOw/7Xmv/aT+zxa3NG2p8WCouwqlg1rTxsFdEgMkWz774PgjI+s4lsgviex1y5/VtD1wjcJtsU+5u4xRgHH/gvrWaZMfF8Dehk9rFzeu3NUc5qrNxgVjHa/sbnoNGxQByCUlLbokKzgWHR5S+H4S/9vumgPpyDd2/mUvIZZnjkJBYud1RrSno0SPBpOt93V/Ypxk7KkWAjHxmQIdQlfcA5d6fri7/YBIPvHq2kR/iSYa1ScqkE24dGmwUeujGm/1gG/10YA4xGUDEukIzSkLJy8ENSJfmbYc/rRk1Rxj/wA=', 57));
});

test('the mask is the one the penalty scores lowest; what the penalty counts', () => {
  for (const text of ['agentmonitor', ADDRESS, LONG]) {
    const scores = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => penalty(/** @type {boolean[][]} */ (qr(text, m))));
    assert.deepEqual(qr(text), qr(text, scores.indexOf(Math.min(...scores))), text);
  }
  // All light, 21 by 21: 42 runs of 21 (19 each), 400 squares (3 each), and no dark at all (100).
  assert.equal(penalty(Array.from({ length: 21 }, () => new Array(21).fill(false))), 42 * 19 + 400 * 3 + 100);
});

test('a code drawn for a terminal: two rows a line, black on bright white, with its border; with ascii, spaces', () => {
  const code = /** @type {boolean[][]} */ (qr(ADDRESS));
  const lines = qrLines(code);
  assert.equal(lines.length, 21); // 33 modules and 8 of border, two rows a line
  assert.deepEqual(read(lines), [...bordered(code), new Array(41).fill(false)]); // the last line's lower half is light
  assert.ok(lines.every((l) => l.endsWith('\x1b[0m')));
  const ascii = qrLines(code, { ascii: true });
  assert.equal(ascii.length, 41);
  assert.deepEqual(read(ascii, true), bordered(code));
  assert.ok(ascii.every((l) => /^[\x1b\x20-\x7e]*$/.test(l)));
});
