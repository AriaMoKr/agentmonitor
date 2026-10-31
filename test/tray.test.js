import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { appIcon, crc32, ico, png, trayIcon } from '../desktop/icons.js';
import { desktopEntry } from '../desktop/launch.js';
import { menuLabel, notices, trayState } from '../desktop/tray.js';
import { timeOfDay } from '../src/format.js';
import { sessionStates } from '../src/viewer.js';
import { agent, snapshot } from './helpers/agents.js';
import { HOUR, MINUTE, NOW } from './helpers/fixture.js';

/**
 * A PNG read back, every chunk's checksum checked: its size and its pixels as red, green, blue
 * and alpha.
 * @param {Buffer} file
 */
function readPng(file) {
  assert.deepEqual([...file.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  /** @type {Record<string, Buffer[]>} */
  const chunks = {};
  /** @type {string[]} */
  const order = [];
  for (let at = 8; at < file.length;) {
    const length = file.readUInt32BE(at);
    const type = file.toString('latin1', at + 4, at + 8);
    assert.equal(file.readUInt32BE(at + 8 + length), crc32(file.subarray(at + 4, at + 8 + length)), `${type}'s checksum`);
    (chunks[type] ??= []).push(file.subarray(at + 8, at + 8 + length));
    order.push(type);
    at += 12 + length;
  }
  assert.deepEqual(order, ['IHDR', 'IDAT', 'IEND']);
  const head = chunks.IHDR[0];
  const [width, height] = [head.readUInt32BE(0), head.readUInt32BE(4)];
  assert.deepEqual([...head.subarray(8)], [8, 6, 0, 0, 0], '8 bits of RGBA, not interlaced');
  const raw = inflateSync(Buffer.concat(chunks.IDAT));
  assert.equal(raw.length, (width * 4 + 1) * height);
  const px = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width * 4 + 1)], 0, 'no filter');
    raw.copy(px, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  }
  /** @param {number} x @param {number} y */
  const at = (x, y) => [...px.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
  return { width, height, at };
}

test('the tray shows what matters most: a session that needs you, a turn ended unread, one at work, all idle, none running', () => {
  /** @param {...import('../src/monitor.js').Agent} rows */
  const level = (...rows) => trayState(snapshot(rows), NOW).level;
  assert.equal(level(agent({ title: 'a' }), agent({ title: 'b', state: 'waiting' }), agent({ title: 'c', state: 'working' })), 'waiting');
  assert.equal(level(agent({ title: 'a', blocked: true }), agent({ title: 'b', unread: true })), 'waiting', 'blocked: something only you can do');
  assert.equal(level(agent({ title: 'a', unread: true }), agent({ title: 'b', state: 'working' })), 'unread');
  assert.equal(level(agent({ title: 'a', state: 'working', inTool: true }), agent({ title: 'b' })), 'working');
  assert.equal(level(agent({ title: 'a', state: 'active', live: false })), 'working', 'its transcript moving');
  assert.equal(level(agent({ title: 'a' }), agent({ title: 'b', state: 'ended', live: false })), 'idle');
  assert.equal(level(agent({ title: 'a', state: 'ended', live: false })), 'none');
  assert.equal(level(), 'none');
});

test('its tooltip and its menu: the counts, the plan\'s usage as the list\'s first line has it, and the sessions that need you, then those unread', () => {
  const S = NOW + 2 * HOUR + 7 * MINUTE;
  const snap = snapshot([
    agent({ title: 'Fix the parser', state: 'working', project: 'demo' }),
    agent({ title: 'Release 2.0', state: 'waiting', project: 'shop', lastActive: NOW - 2 * MINUTE }),
    agent({ title: 'Plan the migration', unread: true, project: 'infra', lastActive: NOW - 10_000 }),
    agent({ title: 'Pick a provider', blocked: true, project: 'shop', lastActive: NOW - MINUTE }),
    agent({ title: 'Idle one' }),
    agent({ title: 'Ended one', state: 'ended', live: false }),
  ], { usage: { at: NOW - 10 * MINUTE, session: 64, week: 29, sessionReset: { at: S, from: S - 10 * MINUTE, to: S + 5 * MINUTE } } });
  const s = trayState(snap, NOW);
  const usage = `session 64% resets ${timeOfDay(NOW + 2 * HOUR + 5 * MINUTE)} · week 29%`;
  assert.deepEqual({ ...s, listed: undefined }, {
    level: 'waiting',
    needs: 2,
    counts: '2 need you, 1 unread, 1 at work, 1 idle',
    usage,
    tooltip: `Claude agents: 2 need you, 1 unread, 1 at work, 1 idle\n${usage}`,
    listed: undefined,
  });
  assert.deepEqual(s.listed, [
    { key: 's:Pick a provider', label: '◇ Pick a provider · shop' },
    { key: 's:Release 2.0', label: '◆ Release 2.0 · shop' },
    { key: 's:Plan the migration', label: '• Plan the migration · infra' },
  ], 'those that need you first, the latest first');

  const one = trayState(snapshot([agent({ title: 'x', state: 'waiting' })]), NOW);
  assert.equal(one.counts, '1 needs you');
  assert.deepEqual([one.usage, one.tooltip], ['', 'Claude agents: 1 needs you'], 'no usage without the desktop app');
  assert.equal(trayState(snapshot([]), NOW).tooltip, 'Claude agents: none running');
  // A title from the files: one clean line, cut; eight sessions at most.
  const rows = Array.from({ length: 10 }, (_, i) => agent({ key: `s:${i}`, title: `\x1b[31mRed\x1b[0m\nline ${'x'.repeat(80)}`, state: 'waiting', lastActive: NOW - i * MINUTE }));
  const many = trayState(snapshot(rows), NOW).listed;
  assert.equal(many.length, 8);
  assert.equal(many[0].label, `◆ Red line ${'x'.repeat(50)}…`);
});

test('a notification when a session starts waiting or ends its turn, once; more than three at once, one says how many', () => {
  /** @type {Map<string, string>} */
  let before = new Map();
  /** @param {import('../src/monitor.js').Agent[]} rows */
  const step = (rows) => {
    const snap = snapshot(rows);
    const n = notices(before, snap);
    before = sessionStates(snap);
    return n;
  };
  /** @param {import('../src/monitor.js').State} state @param {Partial<import('../src/monitor.js').Agent>} [o] */
  const row = (state, o = {}) => agent({ key: 's:a', title: 'Release 2.0', state, activity: 'Bash: npm test', ...o });
  assert.deepEqual(step([row('working')]), [], 'a session seen for the first time');
  const asks = row('waiting', { activity: 'waiting: a question: Which branch?' });
  assert.deepEqual(step([asks]), [{ title: 'Release 2.0', body: 'waiting: a question: Which branch?' }]);
  assert.deepEqual(step([asks]), [], 'once');
  assert.deepEqual(step([row('working')]), []);
  assert.deepEqual(step([row('idle', { activity: 'Done:\x1b[2m the tests\npass.' })]), [{ title: 'Release 2.0', body: 'Done: the tests pass.' }], 'its turn ended; the text clean');
  assert.deepEqual(step([row('working')]), []);
  assert.deepEqual(step([row('idle', { title: '', activity: '' })]), [{ title: 'untitled', body: 'ended its turn' }]);
  assert.deepEqual(step([row('idle')]), [], 'idle still');

  const four = (/** @type {import('../src/monitor.js').State} */ state) => ['a', 'b', 'c', 'd'].map((k) => agent({ key: `s:${k}`, title: k, state }));
  step(four('working'));
  assert.deepEqual(step(four('idle')), [{ title: 'Claude agents', body: '4 sessions need you or ended their turn' }]);
});

test('a menu item\'s text: one line, an & doubled on Windows and Linux, where it would mark a key', () => {
  assert.equal(menuLabel('Tom & Jerry\x1b[31m\nshow', 'win32'), 'Tom && Jerry show');
  assert.equal(menuLabel('Tom & Jerry', 'linux'), 'Tom && Jerry');
  assert.equal(menuLabel('Tom & Jerry', 'darwin'), 'Tom & Jerry');
});

test('Linux\'s desktop entry: Exec\'s arguments quoted as the spec says, % doubled, a backslash escaped twice in quotes', () => {
  assert.equal(desktopEntry(['/opt/my apps/electron', '/home/me/agentmonitor/desktop', '--hidden'], '/home/me/.config/agentmonitor/agentmonitor.png'), [
    '[Desktop Entry]',
    'Type=Application',
    'Name=agentmonitor',
    'Comment=The Claude agents on this computer',
    'Exec="/opt/my apps/electron" /home/me/agentmonitor/desktop --hidden',
    'Icon=/home/me/.config/agentmonitor/agentmonitor.png',
    'Terminal=false',
    'Categories=Development;Utility;',
    '',
  ].join('\n'));
  const odd = desktopEntry(['/a/b', '50%', 'it\'s "$x" \\ `y`', ''], '/i\\con.png').split('\n');
  assert.equal(odd[4], 'Exec=/a/b 50%% "it\'s \\\\"\\\\$x\\\\" \\\\\\\\ \\\\`y\\\\`" ""');
  assert.equal(odd[5], 'Icon=/i\\\\con.png');
});

test('the icons: PNG with each chunk\'s checksum right, the glyph in the middle in its color, the corners clear; an ICO of them', () => {
  // CRC-32's check value, as the standard gives it.
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const tile = [30, 30, 30, 255];
  /** @type {Record<import('../desktop/icons.js').Level, number[]>} */
  const middle = { waiting: [229, 229, 16, 255], unread: [59, 142, 234, 255], working: [35, 209, 139, 255], idle: tile, none: tile };
  for (const [level, color] of Object.entries(middle)) {
    for (const size of [16, 20, 24, 32]) {
      const icon = readPng(trayIcon(/** @type {import('../desktop/icons.js').Level} */ (level), size));
      assert.deepEqual([icon.width, icon.height], [size, size]);
      assert.deepEqual(icon.at(size / 2, size / 2), color, `${level} at ${size}`);
      assert.equal(icon.at(0, 0)[3], 0, 'a corner clear');
      assert.equal(icon.at(size - 1, size - 1)[3], 0);
    }
  }
  // The idle glyph is a ring: its line in cyan, beside the clear middle.
  assert.deepEqual(readPng(trayIcon('idle', 16)).at(11, 7), [41, 184, 219, 255]);
  assert.deepEqual(readPng(trayIcon('waiting', 16)).at(3, 3), tile, 'the tile around the glyph');
  // The app's: a green dot, a yellow diamond and a cyan ring down the left, each with a line.
  const app = readPng(appIcon(32));
  assert.deepEqual([app.at(8, 8), app.at(8, 15)], [[35, 209, 139, 255], [229, 229, 16, 255]]);
  assert.deepEqual(app.at(20, 9), [150, 150, 150, 255]);

  const images = [16, 32, 256].map((size) => ({ size, png: appIcon(size) }));
  const file = ico(images);
  assert.deepEqual([file.readUInt16LE(0), file.readUInt16LE(2), file.readUInt16LE(4)], [0, 1, 3]);
  images.forEach(({ size, png: data }, i) => {
    const e = 6 + 16 * i;
    assert.deepEqual([file[e], file[e + 1], file[e + 2], file[e + 3], file.readUInt16LE(e + 4), file.readUInt16LE(e + 6)], [size % 256, size % 256, 0, 0, 1, 32]);
    const [length, offset] = [file.readUInt32LE(e + 8), file.readUInt32LE(e + 12)];
    assert.ok(file.subarray(offset, offset + length).equals(data), `the ${size} pixel image`);
  });
  assert.equal(file.length, 6 + 16 * 3 + images.reduce((n, i) => n + i.png.length, 0));
  // Any pixels make a PNG.
  assert.deepEqual(readPng(png(2, 1, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))).at(1, 0), [5, 6, 7, 8]);
});
