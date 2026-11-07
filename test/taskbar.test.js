import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appDetailsOf, buttonsOf, flyoutBounds, gaugeOf, jumpListOf, openArg, openSwitch, overlayOf, thumbnailClip, units } from '../desktop/taskbar.js';
import { trayState } from '../desktop/tray.js';
import { agent, snapshot } from './helpers/agents.js';
import { HOUR, MINUTE, NOW } from './helpers/fixture.js';

const DAY = 24 * HOUR;

/** @param {...import('../src/monitor.js').Agent} rows */
const state = (...rows) => trayState(snapshot(rows), NOW);

test('the taskbar button\'s bar: the limit used more, green, yellow from 75% or where its pace reaches 100% before it resets, red from 90%', () => {
  const at = NOW - 10 * MINUTE;
  const S = NOW + 2 * HOUR;
  const sessionReset = { at: S, from: S - 10 * MINUTE, to: S + 5 * MINUTE };
  assert.equal(gaugeOf(undefined, NOW), undefined, 'none without the desktop app');
  assert.equal(gaugeOf({ at: NOW - 6 * HOUR, session: 50 }, NOW), undefined, 'a session\'s limit surely reset since');
  assert.deepEqual(gaugeOf({ at, session: 64, week: 29, sessionReset }, NOW), { v: 64, mode: 'normal' });
  assert.deepEqual(gaugeOf({ at, session: 10, week: 80 }, NOW), { v: 80, mode: 'paused' }, 'the week used more');
  assert.deepEqual(gaugeOf({ at, session: 92, week: 80 }, NOW), { v: 92, mode: 'error' });
  // The session's pace, carried on with the replies: 40 points to go at 30 an hour is before its reset in two hours.
  const tracked = (/** @type {number} */ pace, r = sessionReset) => ({ session: 60, sessionReset: r, sessionPace: pace });
  assert.deepEqual(gaugeOf({ at, session: 55, tracked: tracked(30) }, NOW), { v: 60, mode: 'paused' });
  assert.deepEqual(gaugeOf({ at, session: 55, tracked: tracked(15) }, NOW), { v: 60, mode: 'normal' });
  assert.deepEqual(gaugeOf({ at, session: 55, tracked: tracked(30, { at: S, from: S - HOUR, to: S + HOUR }) }, NOW), { v: 60, mode: 'normal' }, 'its reset not known closely');
  // On a tie the week's, which has no pace here.
  assert.deepEqual(gaugeOf({ at, session: 50, week: 50, tracked: { ...tracked(40), session: 50 } }, NOW), { v: 50, mode: 'normal' });
  assert.deepEqual(gaugeOf({ at, session: 50, week: 49, tracked: { ...tracked(40), session: 50 } }, NOW), { v: 50, mode: 'paused' });
  // The week's pace since its reset five days ago: 72 points is 14.4 a day, 100% in under the two days left.
  const W = { at: NOW + 2 * DAY, from: NOW + 2 * DAY - HOUR, to: NOW + 2 * DAY + HOUR };
  assert.deepEqual(gaugeOf({ at, week: 72, weekReset: W }, NOW), { v: 72, mode: 'paused' });
  assert.deepEqual(gaugeOf({ at, week: 70, weekReset: W }, NOW), { v: 70, mode: 'normal' });
  assert.deepEqual(gaugeOf({ at, week: 72, weekReset: { ...W, from: W.at - 7 * HOUR, to: W.at + 6 * HOUR } }, NOW), { v: 72, mode: 'normal' }, 'its reset not known within 12 hours');
  assert.deepEqual(gaugeOf({ at, week: 100, weekReset: W }, NOW), { v: 100, mode: 'error' });
});

test('the overlay on the taskbar button: how many need you; else the sessions as a ring by what they show; none while all are idle', () => {
  assert.deepEqual(overlayOf(state(agent({ title: 'a', state: 'waiting' }), agent({ title: 'b', blocked: true }), agent({ title: 'c', state: 'working' }))), { count: 2, says: '2 need you' });
  assert.deepEqual(overlayOf(state(agent({ title: 'a', state: 'waiting' }))), { count: 1, says: '1 needs you' });
  assert.deepEqual(overlayOf(state(agent({ title: 'a', unread: true }), agent({ title: 'b', state: 'working' }), agent({ title: 'c', state: 'working' }), agent({ title: 'd' }))), {
    parts: [['unread', 1], ['working', 2], ['background', 0], ['idle', 1]],
    says: '1 unread, 2 at work, 1 idle',
  });
  assert.equal(overlayOf(state(agent({ title: 'a' }), agent({ title: 'b' }))), undefined, 'all idle');
  assert.equal(overlayOf(state()), undefined, 'none running');
});

test('the buttons under the window\'s preview: a session each, seven at most, what matters most first, none for those idle; what one at work does left out, as it says something new every few seconds', () => {
  assert.deepEqual(buttonsOf(state(
    agent({ title: 'Fix the parser', state: 'working', project: 'demo', activity: 'Bash: npm test' }),
    agent({ title: 'Release 2.0', state: 'waiting', project: 'shop', activity: 'waiting: a question: Which branch?' }),
    agent({ title: 'Idle one' }),
    agent({ title: 'Plan', unread: true }),
  )), [
    { key: 's:Release 2.0', level: 'waiting', tooltip: 'Release 2.0 · shop: waiting: a question: Which branch?' },
    { key: 's:Plan', level: 'unread', tooltip: 'Plan: ended its turn' },
    { key: 's:Fix the parser', level: 'working', tooltip: 'Fix the parser · demo: at work' },
  ]);
  const nine = Array.from({ length: 9 }, (_, i) => agent({ title: `w${i}`, state: 'working', lastActive: NOW - i * MINUTE }));
  assert.deepEqual(buttonsOf(state(...nine)).map((b) => b.key), ['s:w0', 's:w1', 's:w2', 's:w3', 's:w4', 's:w5', 's:w6']);
});

test('the jump list: those that need you, those unread and those at work, as many as Windows shows; none for a key a start could not take', () => {
  const s = state(
    agent({ key: 's:1111', title: 'Release 2.0', state: 'waiting', project: 'shop', activity: 'waiting: a question: Which branch?' }),
    agent({ key: 's:2222', title: 'Plan', unread: true, activity: 'Done: the plan is written.' }),
    agent({ key: 's:3333:42', title: 'Fix the parser', state: 'working', project: 'demo', activity: 'Bash: npm test' }),
    agent({ key: 's:4444', title: 'Serving one', commands: [{ summary: 'Bash: Serve the site', ts: NOW - MINUTE }] }),
    agent({ key: 's:5555', title: 'Idle one' }),
    agent({ key: 's:no such key', title: 'Odd', state: 'waiting' }),
  );
  assert.deepEqual(jumpListOf(s, 10), [
    { name: 'Needs you', items: [{ key: 's:1111', level: 'waiting', title: 'Release 2.0 · shop', description: 'waiting: a question: Which branch?' }] },
    { name: 'Unread', items: [{ key: 's:2222', level: 'unread', title: 'Plan', description: 'Done: the plan is written.' }] },
    { name: 'At work', items: [
      { key: 's:3333:42', level: 'working', title: 'Fix the parser · demo', description: 'at work' },
      { key: 's:4444', level: 'background', title: 'Serving one', description: 'waits on what it left running' },
    ] },
  ]);
  assert.deepEqual(jumpListOf(s, 2).map((c) => [c.name, c.items.length]), [['Needs you', 1], ['Unread', 1]], 'those that matter most');
  assert.deepEqual(jumpListOf(s, 0), []);
});

test('a jump list\'s text cut to the UTF-16 units Windows counts, an ellipsis last, never a character cut in two', () => {
  assert.equal(units('abc', 3), 'abc');
  assert.equal(units('abcd', 3), 'ab…');
  assert.equal(units('a😀b', 3), 'a…', 'the emoji is two units');
  assert.equal(units('a😀bc', 4), 'a😀…');
});

test('a start of the app that opens a session: --open=<key>, a key as the monitor makes them, or nothing', () => {
  const key = 's:0a1b2c3d-0000-4000-8000-000000000001:4242';
  assert.equal(openSwitch(key), `--open=${key}`);
  assert.equal(openArg(['agentmonitor.exe', '--hidden', openSwitch(key)]), key);
  assert.equal(openArg(['electron.exe', 'C:\\agentmonitor\\desktop', 'a:0a1b:x1', '--open=a:0a1b:agent_x1.2']), 'a:0a1b:agent_x1.2', 'a switch, not an argument');
  for (const bad of ['--open=', '--open=s:', '--open=s:a b', '--open=x', '--open=S:abc', '--open=s:a/b', '--open', `--open=s:${'a'.repeat(201)}`, '--open= s:a', '--opens:a']) {
    assert.equal(openArg([bad]), undefined, bad);
  }
  assert.equal(openArg(['--open=s:a b', '--open=w:run-1']), 'w:run-1', 'the first that is a key');
});

test("the window's taskbar button: the app's ID, and what a pin made from it starts, by what name and with what icon", () => {
  const ico = 'C:\\Users\\me\\AppData\\Roaming\\agentmonitor\\agentmonitor.ico';
  const electron = 'C:\\git\\agentmonitor\\desktop\\node_modules\\electron\\dist\\electron.exe';
  assert.deepEqual(appDetailsOf('agentmonitor', ico, [electron, 'C:\\git\\agentmonitor\\desktop']), {
    appId: 'agentmonitor', appIconPath: ico, appIconIndex: 0,
    relaunchCommand: `"${electron}" "C:\\git\\agentmonitor\\desktop"`,
    relaunchDisplayName: 'agentmonitor',
  });
  const packaged = appDetailsOf('agentmonitor', ico, ['C:\\Program Files\\agentmonitor\\agentmonitor.exe']);
  assert.equal(packaged.relaunchCommand, '"C:\\Program Files\\agentmonitor\\agentmonitor.exe"', 'the program alone, its spaces quoted');
});

test('the part of the window its preview shows: the top left, the list\'s first lines at the page\'s zoom; all of a window no bigger', () => {
  assert.deepEqual(thumbnailClip({ width: 1100, height: 700 }, 0), { x: 0, y: 0, width: 486, height: 222 });
  assert.deepEqual(thumbnailClip({ width: 1100, height: 700 }, 1), { x: 0, y: 0, width: 584, height: 266 }, 'a fifth bigger');
  assert.deepEqual(thumbnailClip({ width: 400, height: 700 }, 0), { x: 0, y: 0, width: 400, height: 222 });
  assert.deepEqual(thumbnailClip({ width: 400, height: 200 }, 0), { x: 0, y: 0, width: 0, height: 0 }, 'all of it');
});

test('where the flyout opens: against the taskbar holding the tray icon, as near the icon as it fits; by the pointer where the icon is not known', () => {
  const size = { width: 600, height: 400 };
  const pointer = { x: 1000, y: 500 };
  const bottom = { x: 0, y: 0, width: 1920, height: 1032 };
  assert.deepEqual(flyoutBounds({ x: 1800, y: 1040, width: 24, height: 32 }, bottom, size, pointer), { x: 1312, y: 624, width: 600, height: 400 }, 'in the corner');
  assert.deepEqual(flyoutBounds({ x: 900, y: 1040, width: 24, height: 32 }, bottom, size, pointer), { x: 612, y: 624, width: 600, height: 400 }, 'above the icon');
  // In the overflow's box above the taskbar, inside the work area: still against its bottom.
  assert.deepEqual(flyoutBounds({ x: 1700, y: 980, width: 24, height: 24 }, bottom, size, pointer), { x: 1312, y: 624, width: 600, height: 400 });
  const top = { x: 0, y: 40, width: 1920, height: 1040 };
  assert.deepEqual(flyoutBounds({ x: 1800, y: 4, width: 24, height: 32 }, top, size, pointer), { x: 1312, y: 48, width: 600, height: 400 });
  const left = { x: 60, y: 0, width: 1860, height: 1080 };
  assert.deepEqual(flyoutBounds({ x: 18, y: 1000, width: 24, height: 24 }, left, size, pointer), { x: 68, y: 672, width: 600, height: 400 });
  const right = { x: 0, y: 0, width: 1860, height: 1080 };
  assert.deepEqual(flyoutBounds({ x: 1878, y: 1000, width: 24, height: 24 }, right, size, pointer), { x: 1252, y: 672, width: 600, height: 400 });
  // A screen left of the main one.
  assert.deepEqual(flyoutBounds({ x: -120, y: 1040, width: 24, height: 32 }, { ...bottom, x: -1920 }, size, pointer), { x: -608, y: 624, width: 600, height: 400 });
  // Linux: by the pointer, here on a bar at the top.
  const none = { x: 0, y: 0, width: 0, height: 0 };
  assert.deepEqual(flyoutBounds(none, { x: 0, y: 27, width: 1920, height: 1053 }, size, { x: 1850, y: 10 }), { x: 1312, y: 35, width: 600, height: 400 });
  // No bigger than the work area, a margin from its edges.
  assert.deepEqual(flyoutBounds({ x: 1800, y: 1040, width: 24, height: 32 }, bottom, { width: 3000, height: 2000 }, pointer), { x: 8, y: 8, width: 1904, height: 1016 });
});
