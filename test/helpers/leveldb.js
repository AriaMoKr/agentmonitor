// LevelDB folders for the tests, written as LevelDB writes them: logs of write batches in 32 KiB
// blocks, tables (one data block, stored as it is or Snappy-compressed, its index and footer), a
// MANIFEST of version edits that names them, and CURRENT; and keys and values as Chromium's
// Local Storage keeps them.
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32c, masked } from '../../src/leveldb.js';

const BLOCK = 32_768;
/** The sequence numbers of the batches written, each above the one before. */
let seq = 0;

/** @param {number | bigint} n */
export function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Buffer.from(out);
}

/** @param {Buffer} b */
const slice = (b) => Buffer.concat([varint(b.length), b]);

/**
 * Records as a log holds them, from `start` in the file: in blocks, a header each (its checksum,
 * length and type), split in fragments where one does not fit, a block's last few bytes padding.
 * @param {Buffer[]} records
 * @param {number} [start]
 */
export function logOf(records, start = 0) {
  /** @type {Buffer[]} */
  const out = [];
  let pos = start;
  for (const rec of records) {
    let left = rec;
    let first = true;
    for (;;) {
      if (BLOCK - (pos % BLOCK) < 7) {
        out.push(Buffer.alloc(BLOCK - (pos % BLOCK)));
        pos += BLOCK - (pos % BLOCK);
      }
      const n = Math.min(left.length, BLOCK - (pos % BLOCK) - 7);
      const last = n === left.length;
      const type = first && last ? 1 : first ? 2 : last ? 4 : 3;
      const data = left.subarray(0, n);
      const header = Buffer.alloc(7);
      header.writeUInt32LE(masked(crc32c(Uint8Array.of(type), data)), 0);
      header.writeUInt16LE(n, 4);
      header[6] = type;
      out.push(header, data);
      pos += 7 + n;
      left = left.subarray(n);
      first = false;
      if (last) break;
    }
  }
  return Buffer.concat(out);
}

/**
 * A write batch: its sequence number, then each put ([key, value]) or deletion ([key]).
 * @param {number} seq
 * @param {([Buffer, Buffer] | [Buffer])[]} ops
 */
export function batchOf(seq, ops) {
  const head = Buffer.alloc(12);
  head.writeBigUInt64LE(BigInt(seq), 0);
  head.writeUInt32LE(ops.length, 8);
  return Buffer.concat([head, ...ops.map(([key, value]) => (value ? Buffer.concat([Uint8Array.of(1), slice(key), slice(value)]) : Buffer.concat([Uint8Array.of(0), slice(key)])))]);
}

/**
 * Snappy's raw format, as a simple compressor writes it: copies of 4 bytes or more found in the
 * 4 KiB before (from up to 2047 back in 2 bytes, else in 3), literals between them.
 * @param {Buffer} src
 */
export function snappyOf(src) {
  /** @type {Buffer[]} */
  const out = [varint(src.length)];
  /** @param {number} from @param {number} to */
  const literal = (from, to) => {
    for (let s = from; s < to; s += 256) {
      const n = Math.min(256, to - s);
      out.push(n <= 60 ? Buffer.of((n - 1) << 2) : Buffer.of(60 << 2, n - 1), src.subarray(s, s + n));
    }
  };
  let lit = 0;
  let i = 0;
  while (i + 4 <= src.length) {
    let best = 0;
    let offset = 0;
    for (let j = i - 1; j >= Math.max(0, i - 4096) && best < 64; j--) {
      let n = 0;
      while (n < 64 && i + n < src.length && src[j + n] === src[i + n]) n++;
      if (n > best) [best, offset] = [n, i - j];
    }
    if (best < 4) {
      i++;
      continue;
    }
    literal(lit, i);
    if (best <= 11 && offset < 2048) out.push(Buffer.of(((offset >> 8) << 5) | ((best - 4) << 2) | 1, offset & 0xff));
    else out.push(Buffer.of(((best - 1) << 2) | 2, offset & 0xff, offset >> 8));
    i += best;
    lit = i;
  }
  literal(lit, src.length);
  return Buffer.concat(out);
}

/**
 * A block of keys and values, as a table holds them: each key after the first of a run of 16
 * sharing its prefix with the one before, then where each run begins.
 * @param {[Buffer, Buffer][]} kvs
 */
function blockOf(kvs) {
  /** @type {Buffer[]} */
  const out = [];
  /** @type {number[]} */
  const restarts = [0];
  let size = 0;
  let prev = Buffer.alloc(0);
  kvs.forEach(([key, value], i) => {
    let shared = 0;
    if (i % 16 === 0) {
      if (i) restarts.push(size);
    } else while (shared < prev.length && shared < key.length && prev[shared] === key[shared]) shared++;
    const entry = Buffer.concat([varint(shared), varint(key.length - shared), varint(value.length), key.subarray(shared), value]);
    out.push(entry);
    size += entry.length;
    prev = key;
  });
  const tail = Buffer.alloc(4 * restarts.length + 4);
  restarts.forEach((r, i) => tail.writeUInt32LE(r, 4 * i));
  tail.writeUInt32LE(restarts.length, 4 * restarts.length);
  return Buffer.concat([...out, tail]);
}

/**
 * A key as a table holds it: then its sequence number and type, 1 a value, 0 a deletion.
 * @param {Buffer} key
 * @param {number} seq
 * @param {number} type
 */
export function internalKey(key, seq, type) {
  const tag = Buffer.alloc(8);
  tag.writeBigUInt64LE((BigInt(seq) << 8n) | BigInt(type), 0);
  return Buffer.concat([key, tag]);
}

/**
 * A table of entries, [key, seq, value] (no value: a deletion), sorted as LevelDB sorts them:
 * its data block, a metaindex with nothing in it, its index and its footer.
 * @param {([Buffer, number, Buffer] | [Buffer, number])[]} list
 * @param {{ snappy?: boolean }} [o] whether its data block is compressed
 */
export function tableOf(list, { snappy = false } = {}) {
  const sorted = [...list].sort(([a, s], [b, t]) => Buffer.compare(a, b) || t - s);
  /** @type {Buffer[]} */
  const out = [];
  let pos = 0;
  /** @param {Buffer} contents @param {number} type */
  const put = (contents, type) => {
    const body = type === 1 ? snappyOf(contents) : contents;
    const trailer = Buffer.alloc(5);
    trailer[0] = type;
    trailer.writeUInt32LE(masked(crc32c(body, Uint8Array.of(type))), 1);
    out.push(body, trailer);
    const handle = Buffer.concat([varint(pos), varint(body.length)]);
    pos += body.length + 5;
    return handle;
  };
  const keys = sorted.map(([key, seq, value]) => internalKey(key, seq, value ? 1 : 0));
  const data = put(blockOf(sorted.map(([, , value], i) => [keys[i], value ?? Buffer.alloc(0)])), snappy ? 1 : 0);
  const meta = put(blockOf([]), 0);
  const index = put(blockOf([[keys.at(-1) ?? Buffer.alloc(8), data]]), 0);
  const footer = Buffer.alloc(48);
  Buffer.concat([meta, index]).copy(footer);
  footer.writeBigUInt64LE(0xdb4775248b80fb57n, 40);
  return Buffer.concat([...out, footer]);
}

/**
 * A MANIFEST's version edit: the log, the tables added ([level, number]) and removed.
 * @param {{ log?: number, nextFile?: number, lastSeq?: number, added?: [number, number][], removed?: [number, number][], comparator?: boolean }} o
 */
export function editOf({ log, nextFile, lastSeq, added = [], removed = [], comparator = false }) {
  const parts = [];
  if (comparator) parts.push(varint(1), slice(Buffer.from('leveldb.BytewiseComparator')));
  if (log !== undefined) parts.push(varint(2), varint(log));
  if (nextFile !== undefined) parts.push(varint(3), varint(nextFile));
  if (lastSeq !== undefined) parts.push(varint(4), varint(lastSeq));
  for (const [level, num] of removed) parts.push(varint(6), varint(level), varint(num));
  for (const [level, num] of added) parts.push(varint(7), varint(level), varint(num), varint(1000), slice(Buffer.from('a')), slice(Buffer.from('z')));
  return Buffer.concat(parts);
}

/** A file's name as LevelDB gives it. @param {number} num @param {string} ext */
export const fileName = (num, ext) => `${String(num).padStart(6, '0')}.${ext}`;

/**
 * A LevelDB folder: CURRENT naming the MANIFEST, its edits, and the tables and logs by number.
 * @param {string} dir
 * @param {{ manifest?: number, edits: Buffer[], tables?: Record<number, Buffer>, logs?: Record<number, Buffer[]> }} o
 *   the logs' records
 */
export function writeDb(dir, { manifest = 1, edits, tables = {}, logs = {} }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CURRENT'), `MANIFEST-${String(manifest).padStart(6, '0')}\n`);
  writeFileSync(join(dir, `MANIFEST-${String(manifest).padStart(6, '0')}`), logOf(edits));
  writeFileSync(join(dir, 'LOCK'), '');
  for (const [num, table] of Object.entries(tables)) writeFileSync(join(dir, fileName(Number(num), 'ldb')), table);
  for (const [num, records] of Object.entries(logs)) writeFileSync(join(dir, fileName(Number(num), 'log')), logOf(records));
}

/**
 * A key of a page's Local Storage, as Chromium keeps it: '_', the origin, a 0 byte, then the name
 * after 1 (Latin-1) or 0 (UTF-16).
 * @param {string} origin
 * @param {string} name
 * @param {boolean} [utf16]
 */
export const storageKey = (origin, name, utf16 = false) =>
  Buffer.concat([Buffer.from(`_${origin}\0`, 'latin1'), Buffer.of(utf16 ? 0 : 1), Buffer.from(name, utf16 ? 'utf16le' : 'latin1')]);

/** A Local Storage value: 1 then Latin-1, or 0 then UTF-16. @param {string} text @param {boolean} [utf16] */
export const storageValue = (text, utf16 = false) => Buffer.concat([Buffer.of(utf16 ? 0 : 1), Buffer.from(text, utf16 ? 'utf16le' : 'latin1')]);

/**
 * A page's Local Storage folder (Local Storage/leveldb), its items [name, text] written in one
 * batch to its log, with the keys Chromium keeps beside them; once it is there, a batch appended.
 * @param {string} dir
 * @param {string} origin
 * @param {[string, string][]} items
 */
export function writeLocalStorage(dir, origin, items) {
  const ops = /** @type {[Buffer, Buffer][]} */ (items.map(([name, text]) => [storageKey(origin, name), storageValue(text)]));
  const log = join(dir, fileName(3, 'log'));
  seq += 100;
  if (existsSync(join(dir, 'CURRENT'))) {
    appendFileSync(log, logOf([batchOf(seq, ops)], statSync(log).size));
    return;
  }
  ops.unshift([Buffer.from('VERSION'), Buffer.from('1')], [Buffer.from(`META:${origin}`), Buffer.of(8, 1, 16, 2)]);
  writeDb(dir, { edits: [editOf({ comparator: true, log: 3, nextFile: 4, lastSeq: 0 })], logs: { 3: [batchOf(seq, ops)] } });
}
