// The agentmonitor app's icons, drawn here rather than kept as image files. The tray's is a dark
// tile with the glyph of what matters most now, in the list's colors: ◆ a session needs you, • a
// turn ended unread, ● one is at work, ○ all are idle, a grey ○ none runs. The app's, for its
// window and the Start menu, is the tile with three rows of the list. As PNG, which Electron
// takes, and as ICO, which a Windows shortcut names.
import { deflateSync } from 'node:zlib';

/** @typedef {'waiting' | 'unread' | 'working' | 'idle' | 'none'} Level what the tray shows: what matters most */
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

const TILE_SHAPE = rounded(0.5, 0.5, 15.5, 15.5, 3.5);
/** @type {[Shape, Color][]} */
const BASE = [[TILE_SHAPE, TILE], [edge(TILE_SHAPE, 1), EDGE]];

/** @type {Record<Level, [Shape, Color]>} */
const GLYPHS = {
  waiting: [diamond(8, 8, 5.5), YELLOW],
  unread: [disc(8, 8, 3.5), BLUE],
  working: [disc(8, 8, 4), GREEN],
  idle: [ring(8, 8, 3.75, 1.5), CYAN],
  none: [ring(8, 8, 3.75, 1.5), GREY],
};

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
  return png(size, size, draw(size, [...BASE, GLYPHS[level]]));
}

/**
 * The app's icon, as PNG.
 * @param {number} size in pixels
 */
export function appIcon(size) {
  return png(size, size, draw(size, [...BASE, ...ROWS]));
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
