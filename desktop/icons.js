// The agentmonitor app's icons, drawn here rather than kept as image files. The tray's is a dark
// tile with the glyph of what matters most now, in the list's colors: ◆ a session needs you, • a
// turn ended unread, ● one is at work, ◎ one waits on what it left running in the background, ○
// all are idle, a grey ○ none runs. In its other looks, the glyphs of up to four sessions, the
// glyph in a ring of the plan's usage, the glyph of one at work turning, or how many need you on
// a yellow tile; the taskbar button's overlay is that count, or a ring of the sessions by what
// they show. The app's, for its window and the Start menu, is the tile with three rows of the
// list. As PNG, which Electron takes, and as ICO, which a Windows shortcut and a jump list name.
import { deflateSync } from 'node:zlib';

/** @typedef {'waiting' | 'unread' | 'working' | 'background' | 'idle' | 'none'} Level what the tray shows: what matters most */
/** @typedef {[number, number, number]} Color red, green and blue, 0 to 255 */
/**
 * @typedef {(x: number, y: number) => number} Shape how far a point is outside it, less than 0
 *   inside, on a grid of 16 by 16 whatever the icon's size
 */

/** The grid the shapes are on: 16 units across, a pixel each at 16 pixels. */
const GRID = 16;

// The web page's colors, dark.
const TILE = /** @type {Color} */ ([30, 30, 30]);
const EDGE = /** @type {Color} */ ([112, 112, 112]);
const TEXT = /** @type {Color} */ ([150, 150, 150]);
const GREEN = /** @type {Color} */ ([35, 209, 139]);
const YELLOW = /** @type {Color} */ ([229, 229, 16]);
const BLUE = /** @type {Color} */ ([59, 142, 234]);
const CYAN = /** @type {Color} */ ([41, 184, 219]);
const GREY = /** @type {Color} */ ([138, 138, 138]);
const RED = /** @type {Color} */ ([241, 76, 76]);
/** The usage's ring where it is not lit. */
const DIM = /** @type {Color} */ ([70, 70, 70]);

/**
 * A rectangle with round corners.
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 * @param {number} radius
 * @returns {Shape}
 */
const rounded = (x0, y0, x1, y1, radius) => (x, y) => {
  const qx = Math.abs(x - (x0 + x1) / 2) - ((x1 - x0) / 2 - radius);
  const qy = Math.abs(y - (y0 + y1) / 2) - ((y1 - y0) / 2 - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
};

/** @param {number} cx @param {number} cy @param {number} radius @returns {Shape} */
const disc = (cx, cy, radius) => (x, y) => Math.hypot(x - cx, y - cy) - radius;

/** A circle's line, `w` wide. @param {number} cx @param {number} cy @param {number} radius @param {number} w @returns {Shape} */
const ring = (cx, cy, radius, w) => (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - radius) - w / 2;

/** A square on its corner, `radius` from its middle to a corner. @param {number} cx @param {number} cy @param {number} radius @returns {Shape} */
const diamond = (cx, cy, radius) => (x, y) => (Math.abs(x - cx) + Math.abs(y - cy) - radius) / Math.SQRT2;

/** The band `w` wide along the inside of a shape's edge. @param {Shape} shape @param {number} w @returns {Shape} */
const edge = (shape, w) => (x, y) => Math.abs(shape(x, y) + w / 2) - w / 2;

/** Shapes as one. @param {...Shape} shapes @returns {Shape} */
const union = (...shapes) => (x, y) => Math.min(...shapes.map((s) => s(x, y)));

/**
 * Part of a circle's line, `w` wide, from the angle `t0` to `t1`, clockwise from the top; its ends
 * cut straight across, toward the middle.
 * @param {number} cx @param {number} cy @param {number} radius @param {number} w
 * @param {number} t0 @param {number} t1 more than t0
 * @returns {Shape}
 */
function arc(cx, cy, radius, w, t0, t1) {
  const band = ring(cx, cy, radius, w);
  if (t1 - t0 >= 2 * Math.PI) return band;
  const [c0, s0, c1, s1] = [Math.cos(t0), Math.sin(t0), Math.cos(t1), Math.sin(t1)];
  return (x, y) => {
    const [px, py] = [x - cx, y - cy];
    // How far past each end's line a point is, toward the side the arc is not on: the line from
    // the middle at angle t is along (sin t, -cos t), y growing down.
    const past0 = -(px * c0 + py * s0);
    const past1 = px * c1 + py * s1;
    // Up to half a turn, the wedge between the lines is where both are on its side; more, where either is.
    const wedge = t1 - t0 <= Math.PI ? Math.max(past0, past1) : Math.min(past0, past1);
    return Math.max(band(x, y), wedge);
  };
}

const TILE_SHAPE = rounded(0.5, 0.5, 15.5, 15.5, 3.5);
/** @type {[Shape, Color][]} */
const BASE = [[TILE_SHAPE, TILE], [edge(TILE_SHAPE, 1), EDGE]];

/**
 * A level's glyph, its middle at (cx, cy), `s` times as big as alone on the tile; a ring's line
 * no thinner than 1.2, small or not.
 * @param {Level} level
 * @param {number} [cx]
 * @param {number} [cy]
 * @param {number} [s]
 * @returns {[Shape, Color]}
 */
function glyph(level, cx = 8, cy = 8, s = 1) {
  const line = Math.max(1.5 * s, 1.2);
  switch (level) {
    case 'waiting': return [diamond(cx, cy, 5.5 * s), YELLOW];
    case 'unread': return [disc(cx, cy, 3.5 * s), BLUE];
    case 'working': return [disc(cx, cy, 4 * s), GREEN];
    // The idle ring with a dot in it, as ◎ is the idle ○ with something in it.
    case 'background': return [union(ring(cx, cy, 3.75 * s, line), disc(cx, cy, 1.5 * s)), CYAN];
    case 'idle': return [ring(cx, cy, 3.75 * s, line), CYAN];
    default: return [ring(cx, cy, 3.75 * s, line), GREY];
  }
}

/** Each level's color in the ring of the sessions: its glyph's, but idle's grey, for the rest to stand out. @type {Record<Level, Color>} */
const SHADES = { waiting: YELLOW, unread: BLUE, working: GREEN, background: CYAN, idle: GREY, none: GREY };

/** Where the glyphs of two, three or four sessions go on the tile. @type {[number, number][][]} */
const PLACES = [
  [], [[8, 8]],
  [[4.75, 8], [11.25, 8]],
  [[4.75, 4.75], [11.25, 4.75], [8, 11.25]],
  [[4.75, 4.75], [11.25, 4.75], [4.75, 11.25], [11.25, 11.25]],
];

/** The digits and +, three cells across and five down, a row at a time: what a count is drawn with. @type {Record<string, string[]>} */
const FONT = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '011', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
};

/**
 * Text in FONT's cells, each `cell` units square, from (x0, y0) at its top left, a cell between
 * characters: each run of cells in a row one rectangle.
 * @param {string} text
 * @param {number} x0
 * @param {number} y0
 * @param {number} cell
 * @returns {Shape}
 */
function lettering(text, x0, y0, cell) {
  /** @type {Shape[]} */
  const shapes = [];
  [...text].forEach((ch, k) => {
    const left = x0 + 4 * k * cell;
    FONT[ch].forEach((row, j) => {
      for (const m of row.matchAll(/1+/g)) {
        const at = m.index ?? 0;
        shapes.push(rounded(left + at * cell, y0 + j * cell, left + (at + m[0].length) * cell, y0 + (j + 1) * cell, 0));
      }
    });
  });
  return union(...shapes);
}

/** The app's: three rows of the list, each a glyph and a line of text. @type {[Shape, Color][]} */
const ROWS = [
  [disc(4.5, 4.5, 1.4), GREEN], [rounded(7, 3.85, 12.5, 5.15, 0.65), TEXT],
  [diamond(4.5, 8, 1.8), YELLOW], [rounded(7, 7.35, 11, 8.65, 0.65), TEXT],
  [ring(4.5, 11.5, 1.15, 0.6), CYAN], [rounded(7, 10.85, 12, 12.15, 0.65), TEXT],
];

/**
 * Shapes drawn one over another on a square `size` pixels wide, their edges smoothed: a pixel
 * the edge crosses takes as much of the shape's color as the shape covers of it.
 * @param {number} size
 * @param {[Shape, Color][]} layers the first at the bottom
 * @returns {Buffer} the pixels as red, green, blue and alpha, row after row
 */
export function draw(size, layers) {
  const out = Buffer.alloc(size * size * 4);
  const unit = GRID / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) * unit;
      const y = (j + 0.5) * unit;
      // Premultiplied by alpha while they are laid over one another.
      let [r, g, b, a] = [0, 0, 0, 0];
      for (const [shape, [cr, cg, cb]] of layers) {
        const cover = Math.max(0, Math.min(1, 0.5 - shape(x, y) / unit));
        if (!cover) continue;
        r = cr * cover + r * (1 - cover);
        g = cg * cover + g * (1 - cover);
        b = cb * cover + b * (1 - cover);
        a = cover + a * (1 - cover);
      }
      const o = (j * size + i) * 4;
      if (a > 0) [out[o], out[o + 1], out[o + 2]] = [Math.round(r / a), Math.round(g / a), Math.round(b / a)];
      out[o + 3] = Math.round(a * 255);
    }
  }
  return out;
}

/**
 * The tray's icon for what matters most, as PNG.
 * @param {Level} level
 * @param {number} size in pixels
 */
export function trayIcon(level, size) {
  return png(size, size, draw(size, [...BASE, glyph(level)]));
}

/** The tile alone: the tray's icon between its flashes. @param {number} size in pixels */
export function tileIcon(size) {
  return png(size, size, draw(size, BASE));
}

/**
 * A glyph for each session, up to four, what matters most first, left to right and down: the
 * tray's icon in that look. One alone, or none, is the tray's own icon.
 * @param {Level[]} levels
 * @param {number} size in pixels
 */
export function sessionsIcon(levels, size) {
  const shown = levels.slice(0, 4);
  if (shown.length < 2) return trayIcon(shown[0] ?? 'none', size);
  return png(size, size, draw(size, [...BASE, ...shown.map((level, i) => glyph(level, ...PLACES[shown.length][i], 0.55))]));
}

/**
 * The glyph of what matters most in a ring of the plan's usage, lit as far round from the top as
 * the limit is used: green, yellow or red as the taskbar button's bar is.
 * @param {Level} level
 * @param {number} used from 0 to 1
 * @param {'normal' | 'paused' | 'error'} mode
 * @param {number} size in pixels
 */
export function usageIcon(level, used, mode, size) {
  const lit = Math.max(0, Math.min(1, used)) * 2 * Math.PI;
  /** @type {[Shape, Color][]} */
  const layers = [...BASE, [ring(8, 8, 5.5, 2), DIM]];
  if (lit > 0) layers.push([arc(8, 8, 5.5, 2, 0, lit), mode === 'error' ? RED : mode === 'paused' ? YELLOW : GREEN]);
  layers.push(glyph(level, 8, 8, 0.6));
  return png(size, size, draw(size, layers));
}

/** How many steps the glyph of one at work takes to turn once. */
export const TURNS = 12;

/**
 * The glyph of one at work, turning: a third of a ring round a dot, at step `step` of TURNS.
 * @param {number} step
 * @param {number} size in pixels
 */
export function turningIcon(step, size) {
  const from = (((step % TURNS) + TURNS) % TURNS) * ((2 * Math.PI) / TURNS);
  return png(size, size, draw(size, [...BASE, [arc(8, 8, 4.5, 2, from, from + (2 * Math.PI) / 3), GREEN], [disc(8, 8, 1.75), GREEN]]));
}

/**
 * How many sessions need you, dark on a yellow tile: the taskbar button's overlay, and the tray's
 * icon in that look. More than nine, 9+.
 * @param {number} n
 * @param {number} size in pixels
 */
export function countIcon(n, size) {
  const text = n > 9 ? '9+' : String(Math.max(0, Math.floor(n)));
  const cell = text.length > 1 ? 1.5 : 2;
  const [w, h] = [(4 * text.length - 1) * cell, 5 * cell];
  return png(size, size, draw(size, [[TILE_SHAPE, YELLOW], [lettering(text, (GRID - w) / 2, (GRID - h) / 2, cell), TILE]]));
}

/**
 * The sessions as a ring on the tile, a part for each level as long as how many show it, round
 * from the top, a gap between the parts: the taskbar button's overlay while none needs you.
 * @param {[Level, number][]} parts in the order they go round
 * @param {number} size in pixels
 */
export function donutIcon(parts, size) {
  const some = parts.filter(([, k]) => k > 0);
  const total = some.reduce((n, [, k]) => n + k, 0);
  if (!total) return trayIcon('none', size);
  /** @type {[Shape, Color][]} */
  const layers = [...BASE];
  let at = 0;
  for (const [level, k] of some) {
    const span = (k / total) * 2 * Math.PI;
    const gap = some.length > 1 ? Math.min(0.3, span / 3) : 0;
    layers.push([arc(8, 8, 4.5, 3, at + gap / 2, at + span - gap / 2), SHADES[level]]);
    at += span;
  }
  return png(size, size, draw(size, layers));
}

/**
 * A glyph's tray icon as ICO, at the sizes a jump list asks for: for the items of its sessions.
 * @param {Level} level
 */
export function glyphIco(level) {
  return ico([16, 20, 24, 32, 40, 48].map((size) => ({ size, png: trayIcon(level, size) })));
}

/**
 * The app's icon, as PNG.
 * @param {number} size in pixels
 */
export function appIcon(size) {
  return png(size, size, draw(size, [...BASE, ...ROWS]));
}

/** The app's icon as ICO, at every size Windows asks for: for its program, window and shortcut. */
export function appIco() {
  return ico([16, 20, 24, 32, 40, 48, 64, 128, 256].map((size) => ({ size, png: appIcon(size) })));
}

/** The CRC-32 of each byte, for PNG's checksums. */
const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

/**
 * The CRC-32 of bytes, as a PNG chunk ends with.
 * @param {Uint8Array} bytes
 */
export function crc32(bytes) {
  let c = -1;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Pixels as a PNG file: 8 bits each of red, green, blue and alpha, every row unfiltered.
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba as draw() makes them
 */
export function png(width, height, rgba) {
  const row = width * 4;
  const raw = Buffer.alloc((row + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (row + 1) + 1, y * row, (y + 1) * row);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  // 8 bits a sample; color with alpha; deflate; adaptive filters; not interlaced.
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A PNG chunk: its length, type, data and checksum.
 * @param {string} type
 * @param {Buffer} data
 */
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/**
 * An ICO file of PNG images, each its own size: what a Windows shortcut and window take, at
 * every size the screen wants.
 * @param {{ size: number, png: Buffer }[]} images square, 256 pixels at most
 */
export function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  // Reserved, an icon (not a cursor), how many.
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png: data }, i) => {
    const at = 6 + 16 * i;
    // Width and height, 0 for 256; no palette; reserved; one plane, 32 bits a pixel.
    head[at] = head[at + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.png)]);
}
