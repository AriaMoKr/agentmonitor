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
 * @param {{ cols?: number, rows?: number, bell?: boolean }} [o]
 */
function start(t, monitor, { cols = 100, rows = 16, bell = false } = {}) {
  const term = fakeTerminal(cols, rows);
  const done = runTui(/** @type {any} */ (monitor), {
    intervalMs: 60_000, color: false, ascii: false, bell, agents: 'running', showEnded: true, stdin: term.stdin, stdout: term.stdout,
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
