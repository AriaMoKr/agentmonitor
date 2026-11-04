// The LevelDB reader, on folders written as LevelDB writes them (test/helpers/leveldb.js): its
// checksums, Snappy, the logs read as they grow, the tables, the MANIFEST that says which are
// live, and the newest value of each key asked for across them; and Local Storage's keys.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { localStorageKeys, localStorageText } from '../src/desktop.js';
import { crc32c, LevelDb, logRecords, unsnappy } from '../src/leveldb.js';
import { batchOf, editOf, fileName, logOf, snappyOf, storageKey, storageValue, tableOf, writeDb } from './helpers/leveldb.js';

/**
 * A folder for one test, removed after it.
 * @param {import('node:test').TestContext} t
 */
function folder(t) {
  const root = mkdtempSync(join(tmpdir(), 'agentmonitor-leveldb-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const key = (/** @type {string} */ s) => Buffer.from(s);

/** What a read finds, as text. @param {LevelDb} db */
const values = async (db) => Object.fromEntries([...(await db.read())].map(([k, v]) => [k, v.toString()]));

/** Appends records to a log or a MANIFEST, as its writer goes on. @param {string} path @param {Buffer[]} records */
const append = (path, records) => appendFileSync(path, logOf(records, statSync(path).size));

test('CRC-32C, which LevelDB checks its records and blocks with', () => {
  assert.equal(crc32c(Buffer.from('123456789')), 0xe3069283);
  assert.equal(crc32c(Buffer.from('1234'), Buffer.from('56789')), 0xe3069283, 'in parts');
  assert.equal(crc32c(Buffer.alloc(32)), 0x8a9136aa);
  assert.equal(crc32c(Buffer.alloc(32, 0xff)), 0x62a8ab43);
});

test('Snappy: literals, copies of what came before (overlapping too), and what is not Snappy', () => {
  const lit = (/** @type {string} */ s) => Buffer.concat([Buffer.of((s.length - 1) << 2), Buffer.from(s)]);
  // A copy of 9 from 3 back, its offset in 1 byte; a run from 1 back, in 2; from 4 back, in 4.
  assert.equal(unsnappy(Buffer.concat([Buffer.of(13), lit('abc'), Buffer.of(0x15, 3), lit('X')])).toString(), 'abcabcabcabcX');
  assert.equal(unsnappy(Buffer.concat([Buffer.of(10), lit('z'), Buffer.of(0x22, 1, 0)])).toString(), 'z'.repeat(10));
  assert.equal(unsnappy(Buffer.concat([Buffer.of(8), lit('wxyz'), Buffer.of(0x0f, 4, 0, 0, 0)])).toString(), 'wxyzwxyz');
  // A literal whose length takes 2 bytes after its tag, in a block whose length takes 2.
  const long = 'q'.repeat(300);
  assert.equal(unsnappy(Buffer.concat([Buffer.of(0xac, 0x02, 61 << 2, 0x2b, 0x01), Buffer.from(long)])).toString(), long);
  for (const bad of [
    Buffer.of(4, 0x01, 1), // a copy from before anything was written
    Buffer.concat([Buffer.of(5), lit('a')]), // short of its length
    Buffer.concat([Buffer.of(1), lit('ab')]), // past it
    Buffer.of(3, 0x08, 0x61), // a literal cut short
    Buffer.of(0xff, 0xff, 0xff, 0xff, 0x7f), // longer than any block
  ]) assert.throws(() => unsnappy(bad));
  const text = Buffer.from(`${'the quick brown fox '.repeat(40)}${'z'.repeat(500)}${'0123456789'.repeat(300)}`);
  const packed = snappyOf(text);
  assert.ok(packed.length < text.length / 4, 'copies made');
  assert.deepEqual(unsnappy(packed), text);
});

test("a log's records, fragments put together, and where to go on from when one is cut short", () => {
  // A block's last 3 bytes padding; one with 7 left, a header's, so an empty first fragment; one
  // in four fragments; an empty one.
  const records = [5, 32_746, 60, 0, 32_680, 70_000, 1, 100].map((n, i) => Buffer.alloc(n, i + 1));
  const log = logOf(records);
  const whole = logRecords(log);
  assert.deepEqual(whole.records, records);
  assert.equal(whole.next, log.length);
  // Cut anywhere, as a writer leaves it: the records whole before the cut, then the rest.
  const cuts = [0, 1, 6, 7, 12, 32_765, 32_766, 32_768, 32_769, 65_529, 65_535, 65_536, 65_543, log.length - 1];
  for (let cut = 0; cut < log.length; cut += 1999) cuts.push(cut);
  for (const cut of cuts) {
    const a = logRecords(log.subarray(0, cut));
    const b = logRecords(log.subarray(a.next), a.next);
    assert.deepEqual([...a.records, ...b.records], records, `cut at ${cut}`);
    assert.equal(b.next, log.length);
  }
  // A record whose checksum fails is taken for one still being written: the read stops before it.
  const bad = Buffer.from(log);
  bad[log.length - 50] ^= 1;
  const read = logRecords(bad);
  assert.equal(read.records.length, records.length - 1);
  assert.equal(read.next, log.length - 107);
});

test('the newest value of the keys asked for: of the tables the MANIFEST holds live, and the log', async (t) => {
  const dir = folder(t);
  const [k1, k2, k3, k4, other] = ['k1', 'k2', 'k3', 'k4', 'other'].map(key);
  const manifest = join(dir, 'MANIFEST-000001');
  const log7 = join(dir, fileName(7, 'log'));
  writeDb(dir, {
    edits: [
      editOf({ comparator: true, log: 7, nextFile: 8, lastSeq: 0 }),
      editOf({ added: [[0, 4], [0, 5]], lastSeq: 4 }),
      // A compaction moved table 6 down and took 4 away (its file left behind).
      editOf({ removed: [[0, 4]], added: [[1, 6]], lastSeq: 6 }),
    ],
    tables: {
      4: tableOf([[k1, 99, key('stale')]]),
      5: tableOf([[k1, 1, key('one')], [k2, 2, key('two')], [k4, 4, key('cuatro')], [other, 3, key('x'.repeat(300))]], { snappy: true }),
      6: tableOf([[k1, 5, key('uno')], [k3, 6]]),
    },
    logs: { 7: [batchOf(10, [[k2, key('dos')], [other, key('y')]])] },
  });
  const db = new LevelDb(dir, [k1, k2, k3, k4]);
  assert.deepEqual(await values(db), { k1: 'uno', k2: 'dos', k4: 'cuatro' });
  assert.equal(db.tables.get(5)?.length, 3, 'the keys asked for alone');

  // Written to the log since: only that is read.
  append(log7, [batchOf(12, [[k3, key('tres')], [k1]])]);
  assert.deepEqual(await values(db), { k2: 'dos', k3: 'tres', k4: 'cuatro' });
  assert.equal(db.logs.get(7)?.at, statSync(log7).size);
  // A table is read once: it never changes.
  writeFileSync(join(dir, fileName(5, 'ldb')), 'not a table any more');
  assert.equal((await values(db)).k4, 'cuatro');

  // A batch half written, then whole.
  const more = logOf([batchOf(14, [[k2, key('two again')]])], statSync(log7).size);
  appendFileSync(log7, more.subarray(0, 10));
  assert.equal((await values(db)).k2, 'dos', 'not yet whole');
  appendFileSync(log7, more.subarray(10));
  assert.equal((await values(db)).k2, 'two again');

  // A flush: what the log held goes to a table, the MANIFEST says so, and a new log begins.
  writeFileSync(join(dir, fileName(8, 'ldb')), tableOf([[k2, 14, key('two again')], [k3, 12, key('tres')], [k1, 13]]));
  append(manifest, [editOf({ log: 9, added: [[0, 8]], lastSeq: 14 })]);
  unlinkSync(log7);
  writeFileSync(join(dir, fileName(9, 'log')), logOf([batchOf(15, [[k3, key('drei')]])]));
  assert.deepEqual(await values(db), { k2: 'two again', k3: 'drei', k4: 'cuatro' });
  assert.deepEqual([...db.logs.keys()], [9]);

  // A compaction: three tables in one, the deletion of k1 and what it deleted dropped.
  writeFileSync(join(dir, fileName(10, 'ldb')), tableOf([[k2, 14, key('two again')], [k3, 12, key('tres')], [k4, 4, key('cuatro')]], { snappy: true }));
  append(manifest, [editOf({ removed: [[0, 5], [1, 6], [0, 8]], added: [[1, 10]], lastSeq: 15 })]);
  for (const n of [4, 5, 6, 8]) unlinkSync(join(dir, fileName(n, 'ldb')));
  assert.deepEqual(await values(db), { k2: 'two again', k3: 'drei', k4: 'cuatro' });
  assert.deepEqual([...db.tables.keys()], [10]);

  // A table the MANIFEST names that is not there yet is looked for again.
  append(manifest, [editOf({ added: [[0, 12]] })]);
  assert.equal((await values(db)).k1, undefined);
  writeFileSync(join(dir, fileName(12, 'ldb')), tableOf([[k1, 20, key('back')]]));
  assert.equal((await values(db)).k1, 'back');

  // Opened again with a new MANIFEST: read from its start.
  writeFileSync(join(dir, 'MANIFEST-000013'), logOf([editOf({ comparator: true, log: 9, added: [[1, 10]] })]));
  writeFileSync(join(dir, 'CURRENT'), 'MANIFEST-000013\n');
  assert.deepEqual(await values(db), { k2: 'two again', k3: 'drei', k4: 'cuatro' });
});

test("a folder missing, or not LevelDB's, holds nothing", async (t) => {
  const dir = folder(t);
  assert.deepEqual(await values(new LevelDb(join(dir, 'none'), [key('k')])), {});
  writeFileSync(join(dir, 'CURRENT'), 'junk\n');
  assert.deepEqual(await values(new LevelDb(dir, [key('k')])), {});
  writeFileSync(join(dir, 'CURRENT'), 'MANIFEST-000001\n');
  assert.deepEqual(await values(new LevelDb(dir, [key('k')])), {}, 'its MANIFEST missing');
});

test("Local Storage's keys and values, as Chromium keeps them: in Latin-1, or UTF-16", async (t) => {
  const dir = folder(t);
  const origin = 'https://claude.ai';
  writeDb(dir, {
    edits: [editOf({ comparator: true, log: 3 })],
    logs: { 3: [batchOf(1, [[storageKey(origin, 'plain'), storageValue('{"a":1}')], [storageKey(origin, 'wide', true), storageValue('{"b":"é→"}', true)], [storageKey('https://other.example', 'plain'), storageValue('no')]])] },
  });
  const plain = localStorageKeys(origin, 'plain');
  const wide = localStorageKeys(origin, 'wide');
  assert.deepEqual(plain[0], storageKey(origin, 'plain'));
  assert.deepEqual(wide[1], storageKey(origin, 'wide', true));
  const found = await new LevelDb(dir, [...plain, ...wide]).read();
  assert.deepEqual([...found.values()].map(localStorageText), ['{"a":1}', '{"b":"é→"}']);
  assert.equal(localStorageText(Buffer.of(7, 65)), '', 'written neither way');
});
