// A LevelDB folder that another program writes as it is read (Chromium keeps a page's Local
// Storage in one): the newest value of the keys asked for, from the tables its MANIFEST holds
// live and the writes in its logs. Read only, its LOCK never touched. A table never changes once
// written, so each is read once, for those keys alone; the MANIFEST and the logs only grow, so
// only what was appended to them is read again. Snappy, which compresses the tables' blocks, is
// decompressed here: no dependencies.
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entries, readRange, statOf } from './files.js';

/** A log's blocks: no record crosses one, and fewer bytes left in one than a header are padding. */
const BLOCK = 32_768;
const HEADER = 7;
/** A log record's types: a record whole, or its first, middle or last fragment. */
const FULL = 1;
const FIRST = 2;
const MIDDLE = 3;
const LAST = 4;
/** What a table ends with. */
const MAGIC = 0xdb4775248b80fb57n;
/** The most a block may decompress to: LevelDB's are a few kilobytes. */
const MAX_BLOCK = 64 << 20;
/** How many times a read goes again when the MANIFEST changed as it read. */
const TRIES = 3;

/**
 * @typedef {{ key: Buffer, seq: bigint, value: Buffer | null }} Entry a key's value as of a
 *   sequence number; null where it was deleted
 * @typedef {object} Manifest the MANIFEST as far as it was read
 * @property {string} name its file, as CURRENT names it
 * @property {number} at where its next record begins
 * @property {Set<number>} tables the live tables' numbers
 * @property {number} log the log that holds what no table holds yet
 * @property {number} prevLog an older one that may still, or 0
 */

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

/**
 * CRC-32C (Castagnoli) of the parts, one after another.
 * @param {...Uint8Array} parts
 */
export function crc32c(...parts) {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A CRC as LevelDB stores it: rotated, and a constant added.
 * @param {number} crc
 */
export const masked = (crc) => ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;

/** Bytes read in order from a buffer: varints, and slices a varint gives the length of. */
class Reader {
  /** @param {Buffer} buf @param {number} [pos] @param {number} [end] */
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = Math.min(end, buf.length);
  }

  get left() {
    return this.end - this.pos;
  }

  byte() {
    if (this.pos >= this.end) throw new Error('read past the end');
    return this.buf[this.pos++];
  }

  /** A varint: a length, an offset, a file's number. */
  num() {
    let v = 0;
    for (let mul = 1; mul <= 2 ** 49; mul *= 128) {
      const b = this.byte();
      v += (b & 0x7f) * mul;
      if (b < 0x80) {
        if (v > Number.MAX_SAFE_INTEGER) break;
        return v;
      }
    }
    throw new Error('a varint too big');
  }

  /** A varint passed over, whatever its size. */
  skip() {
    for (let i = 0; i < 10; i++) if (this.byte() < 0x80) return;
    throw new Error('a varint too long');
  }

  /** @param {number} n */
  bytes(n) {
    if (n > this.left) throw new Error('read past the end');
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  /** A slice: its length, then its bytes. */
  slice() {
    return this.bytes(this.num());
  }
}

/**
 * Snappy's raw format, decompressed: the length it comes to, then literals, and copies of what
 * came before them (which may overlap what they write).
 * @param {Buffer} src
 */
export function unsnappy(src) {
  const r = new Reader(src);
  const length = r.num();
  if (length > MAX_BLOCK) throw new Error('snappy: too long');
  const out = Buffer.alloc(length);
  let o = 0;
  while (r.left > 0) {
    const tag = r.byte();
    let n;
    let offset = 0;
    switch (tag & 3) {
      case 0:
        // A literal, its length in the tag, or in the 1 to 4 bytes after it.
        n = tag >> 2;
        if (n >= 60) {
          const size = n - 59;
          n = 0;
          for (let i = 0; i < size; i++) n += r.byte() * 2 ** (8 * i);
        }
        n += 1;
        break;
      case 1:
        // A copy of 4 to 11 bytes, from up to 2047 back.
        n = ((tag >> 2) & 7) + 4;
        offset = ((tag >> 5) << 8) | r.byte();
        break;
      case 2:
        n = (tag >> 2) + 1;
        offset = r.byte();
        offset |= r.byte() << 8;
        break;
      default:
        n = (tag >> 2) + 1;
        for (let i = 0; i < 4; i++) offset += r.byte() * 2 ** (8 * i);
    }
    if (o + n > length) throw new Error('snappy: past its length');
    if ((tag & 3) === 0) {
      r.bytes(n).copy(out, o);
      o += n;
      continue;
    }
    if (offset === 0 || offset > o) throw new Error('snappy: a copy from before the start');
    for (const end = o + n; o < end; o++) out[o] = out[o - offset];
  }
  if (o !== length) throw new Error('snappy: short of its length');
  return out;
}

/**
 * The whole records of a log (a .log or a MANIFEST) in `buf`, the file's bytes from `start` (where
 * a record begins), their fragments put together; and where the first one not read whole begins,
 * to go on from once more is written. A header or a record cut short, or one whose checksum fails,
 * is taken for one still being written: the read stops there.
 * @param {Buffer} buf
 * @param {number} [start]
 * @returns {{ records: Buffer[], next: number }}
 */
export function logRecords(buf, start = 0) {
  /** @type {Buffer[]} */
  const records = [];
  /** @type {Buffer[]} the fragments of the record being put together */
  let parts = [];
  let pos = 0;
  let next = start;
  for (;;) {
    const room = BLOCK - ((start + pos) % BLOCK);
    if (room < HEADER) {
      // The block's padding.
      if (pos + room > buf.length) break;
      pos += room;
      if (!parts.length) next = start + pos;
      continue;
    }
    if (pos + HEADER > buf.length) break;
    const length = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6];
    if (type === 0 && length === 0) {
      // Space set aside, not written: the rest of the block is passed over, as LevelDB does, once
      // something is written after it.
      if (pos + room >= buf.length) break;
      pos += room;
      parts = [];
      next = start + pos;
      continue;
    }
    if (HEADER + length > room || pos + HEADER + length > buf.length) break;
    const data = buf.subarray(pos + HEADER, pos + HEADER + length);
    if (masked(crc32c(Uint8Array.of(type), data)) !== buf.readUInt32LE(pos)) break;
    pos += HEADER + length;
    if (type === FULL) {
      records.push(data);
      parts = [];
    } else if (type === FIRST) parts = [data];
    else if (type === MIDDLE && parts.length) parts.push(data);
    else if (type === LAST && parts.length) {
      records.push(Buffer.concat([...parts, data]));
      parts = [];
    } else parts = [];
    if (!parts.length) next = start + pos;
  }
  return { records, next };
}

/**
 * A write batch's puts and deletions, each with its sequence number.
 * @param {Buffer} rec
 * @returns {Entry[]}
 */
export function batchEntries(rec) {
  if (rec.length < 12) throw new Error('a batch too short');
  const seq = rec.readBigUInt64LE(0);
  const count = rec.readUInt32LE(8);
  const r = new Reader(rec, 12);
  /** @type {Entry[]} */
  const out = [];
  for (let i = 0; i < count; i++) {
    const tag = r.byte();
    if (tag > 1) throw new Error(`a batch's entry of type ${tag}`);
    const key = r.slice();
    out.push({ key, seq: seq + BigInt(i), value: tag === 1 ? r.slice() : null });
  }
  return out;
}

/**
 * A table's block, its checksum checked, decompressed.
 * @param {Buffer} buf the table
 * @param {Reader} handle where it is: its offset and size
 */
function blockAt(buf, handle) {
  const off = handle.num();
  const size = handle.num();
  if (off + size + 5 > buf.length) throw new Error('a block past the end');
  const contents = buf.subarray(off, off + size);
  const type = buf[off + size];
  if (masked(crc32c(contents, Uint8Array.of(type))) !== buf.readUInt32LE(off + size + 1)) throw new Error('a block whose checksum fails');
  if (type === 0) return contents;
  if (type === 1) return unsnappy(contents);
  throw new Error(`a block compressed as ${type}`);
}

/**
 * A block's keys and values, each key's prefix shared with the one before put back.
 * @param {Buffer} block
 * @returns {Generator<[Buffer, Buffer]>}
 */
function* blockEntries(block) {
  if (block.length < 4) return;
  const restarts = block.readUInt32LE(block.length - 4);
  const r = new Reader(block, 0, Math.max(0, block.length - 4 - 4 * restarts));
  let key = Buffer.alloc(0);
  while (r.left > 0) {
    const shared = r.num();
    const own = r.num();
    const size = r.num();
    if (shared > key.length) throw new Error('a key sharing more than the one before');
    key = Buffer.concat([key.subarray(0, shared), r.bytes(own)]);
    yield [key, r.bytes(size)];
  }
}

/**
 * A table's entries for the keys wanted, read through its index.
 * @param {Buffer} buf the table's file
 * @param {(key: Buffer) => boolean} wanted
 * @returns {Entry[]}
 */
export function tableEntries(buf, wanted) {
  if (buf.length < 48 || buf.readBigUInt64LE(buf.length - 8) !== MAGIC) throw new Error('not a table');
  const footer = new Reader(buf, buf.length - 48, buf.length - 8);
  // The metaindex, the filter's: not needed.
  footer.skip();
  footer.skip();
  /** @type {Entry[]} */
  const out = [];
  for (const [, handle] of blockEntries(blockAt(buf, footer))) {
    for (const [ikey, value] of blockEntries(blockAt(buf, new Reader(handle)))) {
      // The key, then its sequence number and type: 1 a value, 0 a deletion.
      if (ikey.length < 8) continue;
      const key = ikey.subarray(0, ikey.length - 8);
      if (!wanted(key)) continue;
      const tag = ikey.readBigUInt64LE(ikey.length - 8);
      out.push({ key: Buffer.from(key), seq: tag >> 8n, value: (tag & 0xffn) === 1n ? Buffer.from(value) : null });
    }
  }
  return out;
}

/**
 * A MANIFEST's version edit, applied: the tables added and removed, and the logs.
 * @param {Manifest} m
 * @param {Buffer} edit
 */
export function applyEdit(m, edit) {
  const r = new Reader(edit);
  while (r.left > 0) {
    const tag = r.num();
    if (tag === 1) r.slice();
    else if (tag === 2) m.log = r.num();
    else if (tag === 3 || tag === 4) r.skip();
    else if (tag === 5) {
      r.num();
      r.slice();
    } else if (tag === 6) {
      r.num();
      m.tables.delete(r.num());
    } else if (tag === 7) {
      r.num();
      m.tables.add(r.num());
      r.skip();
      r.slice();
      r.slice();
    } else if (tag === 9) m.prevLog = r.num();
    else throw new Error(`a version edit's tag ${tag}`);
  }
}

/** @param {string} name @returns {Manifest} */
const emptyManifest = (name) => ({ name, at: 0, tables: new Set(), log: 0, prevLog: 0 });

/** A file's number as LevelDB names it: at least 6 digits. @param {number} num */
const stem = (num) => String(num).padStart(6, '0');

/**
 * Bytes [start, end) of a file.
 * @param {string} path
 * @param {number} start
 * @param {number} end
 */
async function readPart(path, start, end) {
  const fh = await open(path, 'r');
  try {
    return await readRange(fh, start, end);
  } finally {
    await fh.close();
  }
}

/** A LevelDB folder, kept up to date: the newest value of each key asked for. */
export class LevelDb {
  /**
   * @param {string} dir
   * @param {Buffer[]} keys the keys to read; the others are passed over
   */
  constructor(dir, keys) {
    this.dir = dir;
    const names = new Set(keys.map((k) => k.toString('latin1')));
    const lengths = new Set(keys.map((k) => k.length));
    /** @param {Buffer} key */
    this.wanted = (key) => lengths.has(key.length) && names.has(key.toString('latin1'));
    this.manifest = emptyManifest('');
    /** @type {Map<number, Entry[]>} each live table's entries for the keys */
    this.tables = new Map();
    /** @type {Map<number, { at: number, entries: Map<string, Entry> }>} each log's, as far as it was read */
    this.logs = new Map();
  }

  /**
   * Brings it up to date: the newest value of each key asked for, by the key in Latin-1, none for
   * one deleted or never written. A folder missing, or not LevelDB's, has none. One that changed
   * as it was read is read again; what it could not read yet is read next time.
   * @returns {Promise<Map<string, Buffer>>}
   */
  async read() {
    for (let i = 0; i < TRIES; i++) {
      try {
        if (!(await this.update())) break;
      } catch {
        break;
      }
    }
    return this.newest();
  }

  /** Reads what changed; true when the MANIFEST grew as it read, which a flush or a compaction does. */
  async update() {
    const name = (await readFile(join(this.dir, 'CURRENT'), 'latin1').catch(() => '')).trim();
    if (!/^MANIFEST-\d+$/.test(name)) {
      this.manifest = emptyManifest('');
      this.tables.clear();
      this.logs.clear();
      return false;
    }
    if (name !== this.manifest.name) this.manifest = emptyManifest(name);
    const size = await this.readManifest();
    const m = this.manifest;
    for (const num of this.tables.keys()) if (!m.tables.has(num)) this.tables.delete(num);
    const names = new Set((await entries(this.dir)).map((e) => e.name));
    for (const num of m.tables) if (!this.tables.has(num)) await this.readTable(num, names);
    const first = m.prevLog ? Math.min(m.log, m.prevLog) : m.log;
    const logs = [...names].flatMap((n) => {
      const log = /^(\d+)\.log$/.exec(n);
      return log && Number(log[1]) >= first ? [Number(log[1])] : [];
    });
    for (const num of this.logs.keys()) if (!logs.includes(num)) this.logs.delete(num);
    for (const num of logs) await this.readLog(num);
    return ((await statOf(join(this.dir, name)))?.size ?? 0) > size;
  }

  /** Reads what was appended to the MANIFEST; returns its size as read. */
  async readManifest() {
    const path = join(this.dir, this.manifest.name);
    const st = await statOf(path);
    if (!st) throw new Error('no MANIFEST');
    // Written anew: read again from its start.
    if (st.size < this.manifest.at) this.manifest = emptyManifest(this.manifest.name);
    const m = this.manifest;
    if (st.size > m.at) {
      const { records, next } = logRecords(await readPart(path, m.at, st.size), m.at);
      for (const edit of records) applyEdit(m, edit);
      m.at = next;
    }
    return st.size;
  }

  /**
   * A live table's entries for the keys, read once: it never changes. One not there (taken away
   * by a compaction this read has not seen yet) is looked for again next time; one that is not a
   * table has none.
   * @param {number} num
   * @param {Set<string>} names the folder's files
   */
  async readTable(num, names) {
    const name = [`${stem(num)}.ldb`, `${stem(num)}.sst`].find((n) => names.has(n));
    if (!name) return;
    let buf;
    try {
      buf = await readFile(join(this.dir, name));
    } catch {
      return;
    }
    try {
      this.tables.set(num, tableEntries(buf, this.wanted));
    } catch {
      this.tables.set(num, []);
    }
  }

  /**
   * Reads what was appended to a log: the newest entry of each key wanted.
   * @param {number} num
   */
  async readLog(num) {
    const path = join(this.dir, `${stem(num)}.log`);
    const st = await statOf(path);
    if (!st) {
      this.logs.delete(num);
      return;
    }
    let log = this.logs.get(num);
    // Written anew: read again from its start.
    if (!log || st.size < log.at) this.logs.set(num, (log = { at: 0, entries: new Map() }));
    if (st.size === log.at) return;
    const { records, next } = logRecords(await readPart(path, log.at, st.size), log.at);
    for (const rec of records) {
      let batch;
      try {
        batch = batchEntries(rec);
      } catch {
        continue;
      }
      for (const e of batch) {
        if (!this.wanted(e.key)) continue;
        const k = e.key.toString('latin1');
        const had = log.entries.get(k);
        if (!had || e.seq > had.seq) log.entries.set(k, { key: Buffer.from(e.key), seq: e.seq, value: e.value && Buffer.from(e.value) });
      }
    }
    log.at = next;
  }

  /**
   * The newest value of each key, of the tables and the logs read.
   * @returns {Map<string, Buffer>}
   */
  newest() {
    /** @type {Map<string, Entry>} */
    const best = new Map();
    /** @param {Entry} e */
    const take = (e) => {
      const k = e.key.toString('latin1');
      const had = best.get(k);
      if (!had || e.seq > had.seq) best.set(k, e);
    };
    for (const list of this.tables.values()) list.forEach(take);
    for (const log of this.logs.values()) log.entries.forEach(take);
    /** @type {Map<string, Buffer>} */
    const out = new Map();
    for (const [k, e] of best) if (e.value) out.set(k, e.value);
    return out;
  }
}
