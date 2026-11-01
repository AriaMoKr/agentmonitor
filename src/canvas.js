// A grid of cells to draw on, for the views below the list that place things rather than write
// lines: text put at a place, each grapheme in its cells (a wide one in two), clipped to the
// grid; dots put at a finer place, two across and four down a cell, drawn as the Braille pattern
// of the cell's dots (with --ascii, as a mark of where in the cell they are); and the grid as
// lines, each run of one style styled once.
import { graphemes } from './format.js';

/** @typedef {(s: string) => string} Style a theme's style, such as t.green */
/** @typedef {{ g: string, style?: Style, dots?: number }} Cell a grapheme (a wide one's second cell holds ''), and the dots put in it */

/** The bit of each dot of a Braille cell, by its row and its column. */
const DOT_BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
/** The dots of a cell's top half, and of its bottom half. */
const TOP = 0x01 | 0x08 | 0x02 | 0x10;
const BOTTOM = 0x04 | 0x20 | 0x40 | 0x80;

export class Canvas {
  /**
   * @param {number} w columns
   * @param {number} h lines
   */
  constructor(w, h) {
    this.w = Math.max(0, Math.floor(w));
    this.h = Math.max(0, Math.floor(h));
    /** @type {Cell[][]} */
    this.rows = Array.from({ length: this.h }, () => Array.from({ length: this.w }, () => ({ g: ' ' })));
  }

  /**
   * Puts `text` (one line, cleaned) from column `x` of line `y` on, in `style`: what goes past the
   * grid is left out, a wide grapheme only where both its cells are on it.
   * @param {number} x
   * @param {number} y
   * @param {string} text
   * @param {Style} [style]
   * @returns {number} the column after it
   */
  put(x, y, text, style) {
    x = Math.floor(x);
    y = Math.floor(y);
    const row = this.rows[y];
    for (const [g, w] of graphemes(text)) {
      if (w === 0) continue;
      if (row && x >= 0 && x + w <= this.w) {
        for (let i = 0; i < w; i++) this.clear(row, x + i);
        row[x] = { g, style };
        if (w === 2) row[x + 1] = { g: '', style };
      }
      x += w;
    }
    return x;
  }

  /**
   * Makes the cell at `x` free to be drawn on: a wide grapheme it is half of leaves a space in its
   * other half.
   * @param {Cell[]} row
   * @param {number} x
   */
  clear(row, x) {
    if (row[x]?.g === '' && x > 0) row[x - 1] = { g: ' ' };
    if (row[x + 1]?.g === '') row[x + 1] = { g: ' ' };
    row[x] = { g: ' ' };
  }

  /**
   * Whether the `n` cells of line `y` from `x` on are on the grid and hold no text (dots may be
   * there): where more can be put without covering what was.
   * @param {number} x
   * @param {number} y
   * @param {number} n
   */
  free(x, y, n) {
    const row = this.rows[y];
    if (!row || x < 0 || x + n > this.w) return false;
    for (let i = x; i < x + n; i++) if (row[i].g !== ' ') return false;
    return true;
  }

  /**
   * The text in the cells of line `y` from `x` on, `n` of them: what is drawn there.
   * @param {number} x
   * @param {number} y
   * @param {number} [n]
   */
  textAt(x, y, n = 1) {
    return (this.rows[y] ?? []).slice(x, x + n).map((c) => (c.dots ? '.' : c.g)).join('');
  }

  /**
   * A dot at (x, y) on a grid twice as wide as the cells and four times as tall, in `style`: the
   * cell takes the style of the last dot put in it.
   * @param {number} x
   * @param {number} y
   * @param {Style} [style]
   */
  dot(x, y, style) {
    x = Math.round(x);
    y = Math.round(y);
    const cx = Math.floor(x / 2);
    const cy = Math.floor(y / 4);
    if (x < 0 || y < 0 || cx >= this.w || cy >= this.h) return;
    const row = this.rows[cy];
    const dots = row[cx].dots ?? 0;
    if (!dots) this.clear(row, cx);
    row[cx] = { g: ' ', style, dots: dots | DOT_BITS[y % 4][x % 2] };
  }

  /**
   * Dots from (x0, y0) to (x1, y1), every `step`th of them (a dotted line for more than 1).
   * @param {number} x0
   * @param {number} y0
   * @param {number} x1
   * @param {number} y1
   * @param {Style} [style]
   * @param {number} [step]
   */
  line(x0, y0, x1, y1, style, step = 1) {
    const n = Math.max(Math.abs(Math.round(x1) - Math.round(x0)), Math.abs(Math.round(y1) - Math.round(y0)));
    for (let i = 0; i <= n; i++) {
      if (i % step) continue;
      const f = n ? i / n : 0;
      this.dot(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, style);
    }
  }

  /**
   * The grid as lines of `w` columns, styled: a cell of dots as their Braille pattern, or with
   * `ascii` as ' (the dots in its top half), . (in its bottom half) or : (in both).
   * @param {boolean} [ascii]
   * @returns {string[]}
   */
  lines(ascii = false) {
    return this.rows.map((row) => {
      let out = '';
      let run = '';
      /** @type {Style | undefined} */
      let at;
      for (const c of row) {
        const g = !c.dots ? c.g : !ascii ? String.fromCodePoint(0x2800 + c.dots) : c.dots & TOP && c.dots & BOTTOM ? ':' : c.dots & TOP ? "'" : '.';
        if (c.style !== at) {
          out += at && run ? at(run) : run;
          run = '';
          at = c.style;
        }
        run += g;
      }
      return out + (at && run ? at(run) : run);
    });
  }
}
