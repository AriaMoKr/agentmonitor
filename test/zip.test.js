import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { crc32 } from '../desktop/icons.js';
import { ZipWriter, dos, zip } from '../desktop/zip.js';

/**
 * A zip read back by the format's rules, as Node has no reader of zips: from the end of its
 * directory, each entry of the directory, the file's own header it points to (which says the
 * same), and the file's data, inflated where it was deflated and checked against its size and
 * CRC-32. The files, then the directory, then its end, with nothing between or after them.
 * @param {Buffer} file
 */
function unzip(file) {
  const u16 = (/** @type {number} */ at) => file.readUInt16LE(at);
  const u32 = (/** @type {number} */ at) => file.readUInt32LE(at);
  const end = file.length - 22;
  assert.equal(u32(end), 0x06054b50, 'the directory\'s end, last');
  // The first disk, the directory on it, as many entries on it as in all; no comment.
  const [count, size, start] = [u16(end + 10), u32(end + 12), u32(end + 16)];
  assert.deepEqual([u16(end + 4), u16(end + 6), u16(end + 8), u16(end + 20)], [0, 0, count, 0]);
  assert.equal(start + size, end, 'the directory just before its end');
  const files = [];
  let at = start;
  let next = 0;
  for (let i = 0; i < count; i++) {
    assert.equal(u32(at), 0x02014b50, `the directory's entry ${i}`);
    const entry = {
      made: u16(at + 4), needs: u16(at + 6), flags: u16(at + 8), method: u16(at + 10), time: u16(at + 12), date: u16(at + 14),
      crc: u32(at + 16), packed: u32(at + 20), size: u32(at + 24),
    };
    const length = u16(at + 28);
    // No extra field or comment, the first disk, no attributes, its file just after the last.
    assert.deepEqual([u16(at + 30), u16(at + 32), u16(at + 34), u16(at + 36), u32(at + 38), u32(at + 42)], [0, 0, 0, 0, 0, next]);
    const name = file.subarray(at + 46, at + 46 + length);
    at += 46 + length;
    const local = next;
    assert.equal(u32(local), 0x04034b50, `the header of ${name}`);
    assert.deepEqual(
      [u16(local + 4), u16(local + 6), u16(local + 8), u16(local + 10), u16(local + 12), u32(local + 14), u32(local + 18), u32(local + 22), u16(local + 26), u16(local + 28)],
      [entry.needs, entry.flags, entry.method, entry.time, entry.date, entry.crc, entry.packed, entry.size, length, 0],
    );
    assert.ok(file.subarray(local + 30, local + 30 + length).equals(name));
    const body = file.subarray(local + 30 + length, local + 30 + length + entry.packed);
    const data = entry.method === 8 ? inflateRawSync(body) : Buffer.from(body);
    assert.equal(data.length, entry.size);
    assert.equal(crc32(data), entry.crc, `the CRC-32 of ${name}`);
    next = local + 30 + length + entry.packed;
    files.push({ ...entry, name: name.toString('utf8'), data });
  }
  assert.equal(next, start, 'the directory just after the files');
  assert.equal(at, end);
  return files;
}

test('a zip: each file deflated where that makes it smaller, else stored, with its size, CRC-32 and time, its name in UTF-8; then the directory of them all, in order', () => {
  const time = new Date(2026, 10, 1, 13, 45, 58);
  // Bytes that do not compress: SHA-256 of a count, over and over.
  const noise = Buffer.concat(Array.from({ length: 32 }, (_, i) => createHash('sha256').update(String(i)).digest()));
  const files = [
    { name: 'agentmonitor.exe', data: Buffer.from('MZ'.repeat(2000)) },
    { name: 'resources/app/src/view.js', data: Buffer.from('// '.repeat(100)) },
    { name: 'empty', data: Buffer.alloc(0) },
    { name: 'noise.bin', data: noise },
    { name: 'locales/naïve café ✓.txt', data: Buffer.from('é') },
  ];
  const read = unzip(zip(files.map((f) => ({ ...f, time }))));
  assert.deepEqual(read.map((f) => f.name), files.map((f) => f.name));
  read.forEach((f, i) => assert.ok(f.data.equals(files[i].data), f.name));
  assert.deepEqual(read.map((f) => f.method), [8, 8, 0, 0, 0]);
  for (const f of read) {
    // Version 2.0, made on MS-DOS (no Unix permissions), names in UTF-8 and nothing after the data.
    assert.deepEqual([f.made, f.needs, f.flags], [20, 20, 0x0800], f.name);
    assert.deepEqual([f.time, f.date], dos(time));
    assert.ok(f.method === 8 ? f.packed < f.size : f.packed === f.size, f.name);
  }
  // None: only the directory's end.
  assert.equal(zip([]).length, 22);
  assert.deepEqual(unzip(zip([])), []);
  // Written as it goes, in parts, the same as made in memory.
  const parts = [];
  const writer = new ZipWriter((b) => parts.push(Buffer.from(b)));
  for (const f of files) writer.add(f.name, f.data, time);
  writer.end();
  assert.ok(parts.length > files.length);
  assert.ok(Buffer.concat(parts).equals(zip(files.map((f) => ({ ...f, time })))));
});

test('a file\'s time as MS-DOS keeps it: local time, to two seconds, from 1980 to 2107', () => {
  assert.deepEqual(dos(new Date(2026, 10, 1, 13, 45, 59)), [(13 << 11) | (45 << 5) | 29, (46 << 9) | (11 << 5) | 1]);
  assert.deepEqual(dos(new Date(1980, 0, 1, 0, 0, 0)), [0, (1 << 5) | 1]);
  // Before 1980 the first time it has, after 2107 the last.
  assert.deepEqual(dos(new Date(1970, 0, 1)), [0, (1 << 5) | 1]);
  const last = [(23 << 11) | (59 << 5) | 29, (127 << 9) | (12 << 5) | 31];
  assert.deepEqual(dos(new Date(2107, 11, 31, 23, 59, 59)), last);
  assert.deepEqual(dos(new Date(2200, 5, 1)), last);
});

test('without Zip64 a zip holds fewer than 65,535 files, and less than 4 GB: past that an error, before anything is written', () => {
  const written = [];
  const full = new ZipWriter((b) => written.push(b));
  full.count = 65534;
  assert.throws(() => full.add('one more', Buffer.alloc(0)), /65,535 files/);
  // Not 4 GB written for a test: as though it had been.
  const big = new ZipWriter((b) => written.push(b));
  big.offset = 0xffffffff - 30;
  assert.throws(() => big.add('one more', Buffer.alloc(0)), /4 GB/);
  big.offset = 0xffffffff - 22;
  assert.throws(() => big.end(), /4 GB/);
  assert.deepEqual(written, []);
});
