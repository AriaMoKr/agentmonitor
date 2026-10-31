// A terminal for the tests: a fake TTY pair for runTui, and a screen that applies what the
// monitor writes (cursor moves, erases and text; colors and modes ignored) to a grid, so a test
// reads what a terminal would show.
import { PassThrough, Writable } from 'node:stream';
import { width } from '../../src/format.js';

export class Screen {
  /** @param {number} cols @param {number} rows */
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.x = 0;
    this.y = 0;
    this.bells = 0;
    /** everything written, as written */
    this.raw = '';
    /** @type {string[][]} */
    this.grid = [];
    this.clear();
  }

  clear() {
    this.grid = Array.from({ length: this.rows }, () => Array(this.cols).fill(' '));
  }

  /** @param {string} data */
  write(data) {
    this.raw += data;
    let i = 0;
    while (i < data.length) {
      if (data[i] === '\x1b') {
        const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(data.slice(i, i + 40));
        if (m) {
          this.control(m[1], m[2]);
          i += m[0].length;
        } else i += 2;
        continue;
      }
      const ch = String.fromCodePoint(/** @type {number} */ (data.codePointAt(i)));
      i += ch.length;
      if (ch === '\x07') this.bells++;
      else if (ch === '\r') this.x = 0;
      else if (ch === '\n') this.y = Math.min(this.rows - 1, this.y + 1);
      else {
        const w = width(ch);
        if (w === 0) continue;
        // No wrapping (the monitor turns it off): past the edge, the last column is written over.
        this.grid[this.y][this.x] = ch;
        if (w === 2 && this.x + 1 < this.cols) this.grid[this.y][this.x + 1] = '';
        this.x = Math.min(this.cols - 1, this.x + w);
      }
    }
  }

  /** @param {string} params @param {string} final */
  control(params, final) {
    if (final === 'H') {
      const [row, col] = params.split(';').map((n) => Number(n) || 1);
      this.y = Math.min(this.rows - 1, (row ?? 1) - 1);
      this.x = Math.min(this.cols - 1, (col ?? 1) - 1);
    } else if (final === 'J') {
      if (params === '2') this.clear();
      else for (let y = this.y; y < this.rows; y++) for (let x = y === this.y ? this.x : 0; x < this.cols; x++) this.grid[y][x] = ' ';
    } else if (final === 'K') {
      for (let x = this.x; x < this.cols; x++) this.grid[this.y][x] = ' ';
    }
  }

  /** The screen's lines, without trailing spaces. */
  lines() {
    return this.grid.map((r) => r.join('').trimEnd());
  }

  text() {
    return this.lines().join('\n');
  }
}

/**
 * A fake terminal: stdin to type into, stdout drawing on a Screen.
 * @param {number} cols
 * @param {number} rows
 */
export function fakeTerminal(cols, rows) {
  const screen = new Screen(cols, rows);
  const stdout = /** @type {NodeJS.WriteStream} */ (/** @type {unknown} */ (new Writable({
    write(chunk, _enc, done) {
      screen.write(chunk.toString());
      done();
    },
  })));
  Object.assign(stdout, { isTTY: true, columns: cols, rows });
  const stdin = /** @type {NodeJS.ReadStream} */ (/** @type {unknown} */ (new PassThrough()));
  /** @type {boolean[]} */
  const rawModes = [];
  /** @type {number[]} how much had been written when each raw mode was set */
  const rawAt = [];
  Object.assign(stdin, {
    isTTY: true,
    /** @param {boolean} on */
    setRawMode(on) {
      rawModes.push(on);
      rawAt.push(screen.raw.length);
      return stdin;
    },
  });
  return { stdin, stdout, screen, rawModes, rawAt };
}

/**
 * Waits until `check` holds, or fails after `ms`.
 * @param {() => boolean} check
 * @param {() => string} [describe] what to say when it never holds
 * @param {number} [ms]
 */
export async function until(check, describe = () => '', ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting${describe() ? `; the screen:\n${describe()}` : ''}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
