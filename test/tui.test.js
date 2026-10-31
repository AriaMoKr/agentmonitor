import assert from 'node:assert/strict';
import { test } from 'node:test';
import { width } from '../src/format.js';
import { runTui } from '../src/tui.js';
import { agent, snapshot } from './helpers/agents.js';
import { HOUR, MINUTE } from './helpers/fixture.js';
import { fakeTerminal, until } from './helpers/screen.js';

/**
 * A monitor that hands out the snapshots made by `snaps`, one per refresh (the last again and again).
 * @param {(() => import('../src/monitor.js').Snapshot)[]} snaps
 */
function fakeMonitor(snaps) {
  let i = 0;
  return {
    dir: '/home/me/.claude',
    windowMs: 24 * HOUR,
    /** @type {string | undefined} */
    focus: undefined,
    refreshes: 0,
    async refresh() {
      this.refreshes++;
      return snaps[Math.min(i++, snaps.length - 1)]();
    },
  };
}

/** Three sessions, as of `now`: one at work, one idle, one that ended. */
function sessions(now = Date.now()) {
  return snapshot([
    agent({
      key: 's:a', title: 'Fix the parser', state: 'working', project: 'demo', sessionId: 'aaaa', kind: 'cli', cwd: '/work/demo',
      activity: 'Bash: npm test', activityKind: 'tool', activityAt: now - 5000, lastActive: now - 5000,
      events: [{ ts: now - MINUTE, kind: 'prompt', text: 'fix the parser please' }, { ts: now - 5000, kind: 'tool', text: 'Bash: npm test' }],
    }),
    agent({
      key: 's:b', title: 'Write the docs', state: 'idle', project: 'docs', sessionId: 'bbbb', kind: 'desktop', cwd: '/work/docs',
      activity: 'The README is done.', activityKind: 'reply', lastActive: now - MINUTE,
      events: [{ ts: now - 2 * MINUTE, kind: 'prompt', text: 'write the README' }, { ts: now - MINUTE, kind: 'reply', text: 'The README is done.' }],
    }),
    agent({ key: 's:c', title: 'Old work', state: 'ended', live: false, project: 'old', sessionId: 'cccc', lastActive: now - 3 * HOUR }),
  ], { at: now });
}

/**
 * Runs the monitor in a fake terminal, for the test to type into and read.
 * @param {import('node:test').TestContext} t
 * @param {ReturnType<typeof fakeMonitor>} monitor
 * @param {{ cols?: number, rows?: number, bell?: boolean, mouse?: boolean, repaintMs?: number }} [o]
 */
function start(t, monitor, { cols = 100, rows = 16, bell = false, mouse = true, repaintMs = 60_000 } = {}) {
  const term = fakeTerminal(cols, rows);
  const done = runTui(/** @type {any} */ (monitor), {
    intervalMs: 60_000, color: false, ascii: false, bell, agents: 'running', showEnded: true, mouse, repaintMs, stdin: term.stdin, stdout: term.stdout,
  });
  // Ends the monitor when a test failed before it quit.
  t.after(() => term.stdin.write('\x03'));
  const text = () => term.screen.text();
  return {
    term,
    done,
    text,
    /** @param {string} keys */
    type: (keys) => term.stdin.write(keys),
    /** @param {(text: string) => boolean} check */
    until: (check) => until(() => check(text()), text),
    /** The line on screen that holds `s`. @param {string} s */
    line: (s) => term.screen.lines().find((l) => l.includes(s)) ?? '',
    /** Where on screen `s` is: its column and line. @param {string} s */
    find: (s) => {
      const y = term.screen.lines().findIndex((l) => l.includes(s));
      return { x: term.screen.lines()[y]?.indexOf(s) ?? -1, y };
    },
    /** A left click, pressed and let go, as a terminal reports it. @param {number} x @param {number} y */
    click: (x, y) => term.stdin.write(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`),
  };
}

test('the list: the selection moves, the details open, tab goes to the next, escape goes back', async (t) => {
  const tui = start(t, fakeMonitor([() => sessions()]));
  await tui.until((s) => s.includes('Fix the parser') && s.includes('Old work'));
  assert.match(tui.text(), /Claude agents {2}● 1 working {2}○ 1 idle {2}· 1 ended/);
  assert.ok(tui.line('Fix the parser').startsWith('>'), 'the first row is selected');
  tui.type('j');
  await tui.until(() => tui.line('Write the docs').startsWith('>'));
  assert.ok(!tui.line('Fix the parser').startsWith('>'));
  tui.type('\r');
  await tui.until((s) => s.includes('esc back'));
  assert.match(tui.term.screen.lines()[0], /Write the docs +idle$/);
  assert.match(tui.text(), /Last {7}The README is done\./);
  assert.match(tui.text(), /Session {4}bbbb · desktop/);
  assert.match(tui.text(), /you {4}write the README/);
  tui.type('\t');
  await tui.until(() => /Old work +ended$/.test(tui.term.screen.lines()[0]));
  assert.match(tui.text(), /Resume {5}claude --resume cccc/);
  tui.type('\x1b');
  await tui.until((s) => s.includes('NAME'));
  assert.ok(tui.line('Old work').startsWith('>'), 'the row last shown in details is selected');
  tui.type('q');
  await tui.done;
  assert.deepEqual(tui.term.rawModes, [true, false]);
  assert.ok(tui.term.screen.raw.startsWith('\x1b[?1049h'), 'drawn on the alternate screen');
  assert.ok(tui.term.screen.raw.endsWith('\x1b[?1049l'), 'and the screen put back');
});

test('help, the filter, sorting and hiding the sessions that ended', async (t) => {
  const tui = start(t, fakeMonitor([() => sessions()]));
  await tui.until((s) => s.includes('Old work'));
  tui.type('?');
  await tui.until((s) => s.includes('States') && s.includes('Keys'));
  tui.type('x');
  await tui.until((s) => s.includes('NAME'));
  tui.type('/');
  await tui.until((s) => s.includes('keep  esc clear'));
  tui.type('docs');
  await tui.until((s) => s.includes('/docs') && !s.includes('Fix the parser'));
  assert.match(tui.text(), /Write the docs/);
  tui.type('\r');
  await tui.until((s) => s.includes('filter "docs"'));
  tui.type('\x1b');
  await tui.until((s) => s.includes('Fix the parser'));
  tui.type('s');
  await tui.until((s) => s.includes('sorted by most recent'));
  tui.type('e');
  await tui.until((s) => s.includes('hiding the sessions that ended') && !s.includes('Old work'));
  tui.type('q');
  await tui.done;
});

test('the bell rings when a session finishes its turn; w steps the window; ctrl-c quits', async (t) => {
  const now = Date.now();
  const finished = () => {
    const snap = sessions(now);
    Object.assign(snap.rows[0], { state: 'idle', activity: 'All tests pass.', activityKind: 'reply', activityAt: now });
    return snap;
  };
  const monitor = fakeMonitor([() => sessions(now), finished]);
  const tui = start(t, monitor, { bell: true });
  await tui.until((s) => s.includes('Fix the parser'));
  assert.equal(tui.term.screen.bells, 0);
  tui.type('r');
  await tui.until((s) => s.includes('All tests pass.'));
  assert.equal(tui.term.screen.bells, 1);
  tui.type('w');
  await tui.until((s) => s.includes('recently active: the last 3d'));
  assert.equal(monitor.windowMs, 72 * HOUR);
  tui.type('\x03');
  await tui.done;
  assert.equal(tui.term.screen.bells, 1);
  assert.deepEqual(tui.term.rawModes, [true, false]);
});

test("an agent's details have the monitor read its transcript, done or not", async (t) => {
  const now = Date.now();
  const withAgent = () => {
    const snap = sessions(now);
    snap.rows[0].children = [agent({ key: 'a:x:1', type: 'subagent', title: 'look around', state: 'done', live: false, lastActive: now - MINUTE })];
    return snap;
  };
  const monitor = fakeMonitor([withAgent]);
  const tui = start(t, monitor);
  await tui.until((s) => s.includes('Fix the parser'));
  tui.type('a');
  await tui.until((s) => s.includes('look around'));
  tui.type('j');
  await tui.until(() => tui.line('look around').startsWith('>'));
  const before = monitor.refreshes;
  tui.type('\r');
  await tui.until((s) => s.includes('esc back'));
  assert.equal(monitor.focus, 'a:x:1');
  await until(() => monitor.refreshes > before);
  tui.type('\x1b');
  await tui.until((s) => s.includes('NAME'));
  assert.equal(monitor.focus, undefined);
  tui.type('q');
  await tui.done;
});

test('the mouse: a click selects, a second opens, the wheel moves, a key below and a title act', async (t) => {
  const tui = start(t, fakeMonitor([() => sessions()]));
  await tui.until((s) => s.includes('Old work'));
  assert.ok(tui.term.screen.raw.startsWith('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J\x1b[?1000h\x1b[?1006h'), 'the terminal is asked to report the mouse');
  // On Windows the console passes the mouse's modes on to the terminal only in raw mode.
  assert.ok(tui.term.rawAt[0] <= tui.term.screen.raw.indexOf('\x1b[?1000h'), 'once in raw mode');
  tui.click(10, tui.find('Old work').y);
  await tui.until(() => tui.line('Old work').startsWith('>'));
  tui.click(10, tui.find('Old work').y);
  await tui.until((s) => s.includes('esc back'));
  assert.match(tui.term.screen.lines()[0], /Old work +ended$/);
  tui.type('\x1b[<64;10;5M');
  tui.click(tui.find('esc back').x, 15);
  await tui.until((s) => s.includes('NAME'));
  assert.ok(tui.line('Old work').startsWith('>'));
  tui.type('\x1b[<64;10;5M');
  await tui.until(() => tui.line('Write the docs').startsWith('>'));
  tui.type('\x1b[<65;10;5M\x1b[<65;10;5M');
  await tui.until(() => tui.line('Old work').startsWith('>'));
  tui.click(tui.find('? help').x, 15);
  await tui.until((s) => s.includes('States'));
  assert.match(tui.text(), /click {9}select a row/);
  tui.click(0, 0);
  await tui.until((s) => s.includes('NAME'));
  tui.click(tui.find('NAME').x, 1);
  await tui.until((s) => s.includes('sorted by name'));
  assert.ok(tui.find('Old work').y < tui.find('Write the docs').y, 'by name');
  tui.type('q');
  await tui.done;
  assert.ok(tui.term.screen.raw.endsWith('\x1b[?1006l\x1b[?1000l\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l'), 'and told to stop before the screen is put back');
  assert.deepEqual(tui.term.rawModes, [true, false]);
  assert.ok(tui.term.screen.raw.lastIndexOf('\x1b[?1000l') < tui.term.rawAt[1], 'while still in raw mode');
});

test("the mouse in the details: a click on an agent opens its details; and --no-mouse leaves it off", async (t) => {
  const now = Date.now();
  const withAgent = () => {
    const snap = sessions(now);
    snap.rows[0].children = [agent({ key: 'a:x:1', type: 'subagent', title: 'look around', state: 'done', live: false, lastActive: now - MINUTE })];
    return snap;
  };
  const monitor = fakeMonitor([withAgent]);
  const tui = start(t, monitor);
  await tui.until((s) => s.includes('Fix the parser'));
  tui.type('\r');
  await tui.until((s) => s.includes('look around'));
  tui.click(10, tui.find('look around').y);
  await tui.until(() => /look around +done$/.test(tui.term.screen.lines()[0]));
  assert.equal(monitor.focus, 'a:x:1');
  tui.type('q');
  await tui.until((s) => s.includes('NAME'));
  tui.type('q');
  await tui.done;

  const off = start(t, fakeMonitor([() => sessions()]), { mouse: false });
  await off.until((s) => s.includes('Old work'));
  off.type('?');
  await off.until((s) => s.includes('States'));
  assert.doesNotMatch(off.text(), /click/);
  off.type('xq');
  await off.done;
  assert.ok(!off.term.screen.raw.includes('\x1b[?1000'), 'the mouse is left to the terminal');
});

test('a resized terminal is drawn again at its new size', async (t) => {
  const tui = start(t, fakeMonitor([() => sessions()]));
  await tui.until((s) => s.includes('Fix the parser'));
  Object.assign(tui.term.stdout, { columns: 50, rows: 10 });
  tui.term.stdout.emit('resize');
  await tui.until((s) => s.includes('Claude agents') && tui.term.screen.lines().every((l) => width(l) <= 50));
  assert.ok(tui.term.screen.lines().slice(10).every((l) => l === ''), 'nothing below the new last row');
  tui.type('q');
  await tui.done;
});

test('every line is drawn again now and then, for a terminal that lost some and said nothing', async (t) => {
  const tui = start(t, fakeMonitor([() => sessions()]), { repaintMs: 300 });
  await tui.until((s) => s.includes('Write the docs') && s.includes('1/3'));
  // The screen gone, as in the desktop app's Terminal panel, with no resize to say so: the lines
  // that do not change (the titles, an idle row, the footer) come back too.
  tui.term.screen.clear();
  await tui.until((s) => s.includes('NAME') && s.includes('Write the docs') && s.includes('1/3'));
  tui.type('q');
  await tui.done;
});
