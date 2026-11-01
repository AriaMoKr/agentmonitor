// A zip file, written as it goes, for the agentmonitor app's release (build.js), so that it needs
// no zip program: each file deflated, or stored where that is no bigger, with its CRC-32; at the
// end the directory of them all. Names in UTF-8, with / between folders, and no entries of their
// own for the folders. No Zip64: fewer than 65,535 files, each and all of them under 4 GB.
import * as zlib from 'node:zlib';
import { crc32 } from './icons.js';

/** zlib's CRC-32 where Node has it (22.2 on), else the one icons.js works out for PNG. */
const crcOf = typeof zlib.crc32 === 'function' ? (/** @type {Buffer} */ b) => zlib.crc32(b) : crc32;
/** The most a field of 4 bytes, or of 2, holds. */
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** Version 2.0 of the format: what deflate needs, and what this writes. */
const VERSION = 20;
/** The flag that says the names are UTF-8. */
const UTF8 = 0x0800;

export class ZipWriter {
  /** @param {(chunk: Buffer) => void} write takes each part of the file, in order */
  constructor(write) {
    this.write = write;
    /** how many bytes were written */
    this.offset = 0;
    /** @type {Buffer[]} the directory's entries, written at the end */
    this.directory = [];
    this.count = 0;
  }

  /**
   * A file into the zip.
   * @param {string} name its path in the zip, with / between folders
   * @param {Buffer} data
   * @param {Date} [time] when it was last changed
   */
  add(name, data, time = new Date()) {
    if (this.count >= MAX16 - 1) throw new Error('a zip without Zip64 holds fewer than 65,535 files');
    if (data.length >= MAX32) throw new Error(`${name} is 4 GB or more: a zip without Zip64 holds less`);
    const path = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const deflated = packed.length < data.length;
    const body = deflated ? packed : data;
    const crc = crcOf(data);
    const [dosTime, dosDate] = dos(time);
    const at = this.offset;
    if (at + 30 + path.length + body.length >= MAX32) throw new Error('the zip comes to 4 GB or more: without Zip64 it holds less');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(deflated ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    this.put(local);
    this.put(path);
    this.put(body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    // Made by MS-DOS (0 in the high byte), as Windows' own zips are: no Unix permissions.
    entry.writeUInt16LE(VERSION, 4);
    entry.writeUInt16LE(VERSION, 6);
    entry.writeUInt16LE(UTF8, 8);
    entry.writeUInt16LE(deflated ? 8 : 0, 10);
    entry.writeUInt16LE(dosTime, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(path.length, 28);
    // No extra field or comment, on the first disk, no attributes: a plain file.
    entry.writeUInt32LE(at, 42);
    this.directory.push(entry, path);
    this.count++;
  }

  /** The directory of the files, and its end: the zip is whole. */
  end() {
    const start = this.offset;
    const size = this.directory.reduce((n, b) => n + b.length, 0);
    if (start + size + 22 >= MAX32) throw new Error('the zip comes to 4 GB or more: without Zip64 it holds less');
    for (const b of this.directory) this.put(b);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    // This disk and the directory's are the first; no comment.
    end.writeUInt16LE(this.count, 8);
    end.writeUInt16LE(this.count, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(start, 16);
    this.put(end);
    this.directory = [];
  }

  /** @param {Buffer} b */
  put(b) {
    this.write(b);
    this.offset += b.length;
  }
}

/**
 * Files as a zip, in memory.
 * @param {{ name: string, data: Buffer, time?: Date }[]} files
 */
export function zip(files) {
  /** @type {Buffer[]} */
  const parts = [];
  const z = new ZipWriter((b) => parts.push(b));
  for (const f of files) z.add(f.name, f.data, f.time);
  z.end();
  return Buffer.concat(parts);
}

/**
 * A time as MS-DOS keeps it, in local time to two seconds, from 1980 to 2107: [time, date].
 * @param {Date} t
 */
export function dos(t) {
  const year = t.getFullYear();
  if (year < 1980) return [0, (1 << 5) | 1];
  if (year > 2107) return [(23 << 11) | (59 << 5) | 29, (127 << 9) | (12 << 5) | 31];
  return [(t.getHours() << 11) | (t.getMinutes() << 5) | (t.getSeconds() >> 1), ((year - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate()];
}
