import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { test } from 'node:test';
import { clean } from '../src/format.js';
import { qr, qrLines } from '../src/qr.js';
import { banner, parseInput, runs, serve, urls } from '../src/serve.js';
import { beep, cellAt, dragSteps, keyAt, keyInput, wheelSteps } from '../src/web/app.js';
import { agent, snapshot } from './helpers/agents.js';
import { HOUR, MINUTE } from './helpers/fixture.js';

const TOKEN = 'test-token-0123456789';

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A monitor whose every read hands out what `make` makes.
 * @param {() => import('../src/monitor.js').Snapshot} make
 */
function fakeMonitor(make) {
  return {
    dir: '/home/me/.claude',
    windowMs: 24 * HOUR,
    /** @type {Set<string>} */
    focus: new Set(),
    refreshes: 0,
    async refresh() {
      this.refreshes++;
      return make();
    },
  };
}

/** Two sessions as of now: one at work, with an agent, and one waiting, whose title is markup. */
function sessions(now = Date.now()) {
  return snapshot([
    agent({
      key: 's:a', title: 'Fix the parser', state: 'working', project: 'demo', sessionId: 'aaaa', kind: 'cli',
      activity: 'Bash: npm test', activityKind: 'tool', activityAt: now - 5000, lastActive: now - 5000,
      children: [agent({
        key: 'a:aaaa:x1', type: 'subagent', title: 'Explore the code', state: 'running', lastActive: now - 2000,
        events: [{ ts: now - 2000, kind: 'tool', text: 'Grep: parse' }],
      })],
    }),
    agent({
      key: 's:b', title: '<img src=x onerror=alert(1)> & "docs"', state: 'waiting', project: 'docs', sessionId: 'bbbb', kind: 'desktop',
      activity: 'Allow Bash?', lastActive: now - MINUTE,
    }),
  ], { at: now });
}

/**
 * @typedef {{ title: string, bell: boolean, ring: boolean, lines: import('../src/serve.js').Run[][], keys: [number, number, number, string][],
 *   filter: string, typing: boolean, fast?: boolean, text: string[] }} Screen
 */

/**
 * Serves `monitor` on a free port of this computer, for the test to ask.
 * @param {import('node:test').TestContext} t
 * @param {ReturnType<typeof fakeMonitor>} monitor
 * @param {{ intervalMs?: number, ascii?: boolean, bell?: boolean, view?: string, pageTtlMs?: number, maxPages?: number, onQuit?: () => void,
 *   elsewhere?: Record<string, (key: string) => void>, showArchived?: boolean }} [o]
 */
async function start(t, monitor, o = {}) {
  /** @type {string[]} */
  const logs = [];
  const served = await serve(/** @type {any} */ (monitor), {
    host: '127.0.0.1', port: 0, token: TOKEN, intervalMs: 60_000, ascii: false, agents: 'running', showEnded: true, log: (l) => logs.push(l), ...o,
  });
  t.after(() => served.close());
  const base = `http://127.0.0.1:${served.port}`;
  return {
    served,
    logs,
    /** @param {string} path @param {RequestInit} [init] */
    get: (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init }),
    /**
     * A page's screen after what it sends: its lines as runs, and as text; quiet, as a page out
     * of sight asks, none.
     * @param {string} page
     * @param {string[]} [inputs]
     * @param {{ w?: number, h?: number, quiet?: boolean }} [o]
     * @returns {Promise<Screen>}
     */
    async screen(page, inputs = [], { w = 100, h = 12, quiet = false } = {}) {
      const query = new URLSearchParams({ page, w: String(w), h: String(h) });
      if (quiet) query.set('quiet', '1');
      for (const i of inputs) query.append('i', i);
      const res = await fetch(`${base}/${TOKEN}/screen?${query}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
      const body = await res.json();
      return { ...body, text: body.lines?.map((/** @type {import('../src/serve.js').Run[]} */ l) => l.map((r) => r[0]).join('')) ?? [] };
    },
  };
}

/**
 * The selected row's text: the line drawn inverse.
 * @param {Screen} s
 */
const selected = (s) => s.text[s.lines.findIndex((l) => l.some((r) => r[1]?.split(' ').includes('i')))] ?? '';

test('the page, its script and its style, with headers that keep them to themselves', async (t) => {
  const s = await start(t, fakeMonitor(() => sessions()));
  const page = await s.get(`/${TOKEN}/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  const csp = page.headers.get('content-security-policy') ?? '';
  for (const rule of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'none'"]) {
    assert.ok(csp.includes(rule), rule);
  }
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const html = await page.text();
  assert.match(html, /<script type="module" src="app.js"><\/script>/);
  assert.doesNotMatch(html, /<script>|<style|\sstyle=|\son\w+=/, 'no inline script or style');
  for (const [name, type] of [['app.js', 'text/javascript; charset=utf-8'], ['app.css', 'text/css; charset=utf-8']]) {
    const res = await s.get(`/${TOKEN}/${name}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), type);
    assert.equal(await res.text(), readFileSync(new URL(`../src/web/${name}`, import.meta.url), 'utf8'));
  }
  const head = await s.get(`/${TOKEN}/`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(html)));
  assert.equal(await head.text(), '');
});

test('only the addresses under the token are served, and only to GET and HEAD', async (t) => {
  const s = await start(t, fakeMonitor(() => sessions()));
  for (const path of [
    '/', '/favicon.ico', `/${TOKEN.slice(0, -1)}/`, `/${TOKEN}x/`, `/${TOKEN.replace(/.$/, 'X')}/`,
    `/${TOKEN}/nope`, `/${TOKEN}/web/app.js`, `/${TOKEN}/screen/x`, `//${TOKEN}/`, `/x/${TOKEN}/`,
  ]) {
    const res = await s.get(path);
    assert.equal(res.status, 404, path);
    assert.equal(await res.text(), 'not found\n');
  }
  const bare = await s.get(`/${TOKEN}`);
  assert.equal(bare.status, 302);
  assert.equal(bare.headers.get('location'), `/${TOKEN}/`);
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const res = await s.get(`/${TOKEN}/screen?page=page-aaaa`, { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
  }
  for (const query of [
    '', 'page=short', 'page=no%20spaces', 'page=page-aaaa&i=x:1', 'page=page-aaaa&i=c:ab', 'page=page-aaaa&i=k:quit',
    `page=page-aaaa${'&i=k:up'.repeat(65)}`,
  ]) {
    const res = await s.get(`/${TOKEN}/screen?${query}`);
    assert.equal(res.status, 400, query);
  }
});

test('the screen comes as runs of text and classes; the text from the files stays text', async (t) => {
  const s = await start(t, fakeMonitor(() => sessions()));
  const { title, lines, text } = await s.screen('page-aaaa');
  assert.equal(title, `(1) Claude agents on ${clean(hostname())}`, 'with the sessions that wait for you');
  assert.equal(text.length, 12);
  for (const l of text) assert.ok(l.length <= 100, l);
  assert.match(text[0], /^ Claude agents {2}● 1 working {2}◆ 1 waiting {2}1 agent at work +\d\d:\d\d:\d\d $/);
  assert.match(text[1], /PROJECT +NAME/);
  // The session that waits comes first, selected: its line drawn inverse, the title as it is.
  assert.match(selected({ title, lines, text }), /^ ◆ docs +<img src=x onerror=alert\(1\)…/);
  assert.match((await s.screen('page-aaaa', ['k:enter'])).text[0], /^ ◆ <img src=x onerror=alert\(1\)> & "docs" +waiting $/);
  const row = text.findIndex((l) => l.includes('Fix the parser'));
  // A glyph outside ASCII is a run of its own, with the column it takes.
  assert.deepEqual(lines[row].find((r) => r[0] === '●'), ['●', 'green', 1]);
  assert.ok(lines[0].some((r) => r[0] === 'Claude agents' && r[1] === 'b'), 'the title in bold');
  // The footer has no q: a page is closed, not quit.
  assert.match(text.at(-1) ?? '', /\? help/);
  assert.doesNotMatch(text.at(-1) ?? '', /quit/);

  const ascii = await start(t, fakeMonitor(() => sessions()), { ascii: true });
  const plain = await ascii.screen('page-aaaa');
  for (const run of plain.lines.flat()) {
    assert.match(run[0], /^[\x20-\x7e]*$/, 'ASCII only');
    assert.equal(run.length < 3, true, 'no boxes');
  }
});

test('a session archived in the desktop app and ended counts for nothing in the title, blocked or not; e lists it, as a page started so does', async (t) => {
  const make = () => {
    const snap = sessions();
    snap.rows.push(agent({ key: 's:z', title: 'Pick a provider', state: 'ended', live: false, archived: true, blocked: true, project: 'shop', lastActive: Date.now() - HOUR }));
    return snap;
  };
  const s = await start(t, fakeMonitor(make));
  const first = await s.screen('page-aaaa');
  assert.equal(first.title, `(1) Claude agents on ${clean(hostname())}`, 'the session that waits, not the one put away');
  assert.ok(!first.text.some((l) => l.includes('Pick a provider')));
  // e: none that ended, then all.
  const all = await s.screen('page-aaaa', ['c:e', 'c:e']);
  assert.ok(all.text.some((l) => l.includes('Pick a provider')), all.text.join('\n'));
  assert.equal(all.title, first.title, 'listed, still not counted');
  const started = await start(t, fakeMonitor(make), { showArchived: true });
  assert.ok((await started.screen('page-bbbb')).text.some((l) => l.includes('Pick a provider')));
});

test('keys move the selection and open the details; each page keeps a view of its own', async (t) => {
  const s = await start(t, fakeMonitor(() => sessions()));
  let a = await s.screen('page-aaaa');
  assert.match(selected(a), /<img src=x/);
  a = await s.screen('page-aaaa', ['k:down']);
  assert.match(selected(a), /Fix the parser/);
  a = await s.screen('page-aaaa', ['k:enter']);
  assert.match(a.text[0], /Fix the parser +working/);
  assert.match(a.text.at(-1) ?? '', /esc back/);
  const b = await s.screen('page-bbbb');
  assert.match(b.text[1], /NAME/);
  assert.match(selected(b), /<img src=x/);
  // q does nothing here; ? shows the help, which has no quitting in it.
  const help = (await s.screen('page-bbbb', ['c:q', 'c:?'], { h: 30 })).text.join('\n');
  assert.match(help, /Keys/);
  assert.match(help, /drag +select text/);
  assert.doesNotMatch(help, /quit|shift\+drag/);
  // Taller than the window: it scrolls.
  const end = (await s.screen('page-bbbb', ['k:end'], { h: 30 })).text;
  assert.match(end.join('\n'), /radar[\s\S]*spark[\s\S]*any other key or a click goes back/);
  assert.match(end.at(-1) ?? '', /^ esc back .* \d+-(\d+)\/\1 $/);
  // Back to the list, and a filter typed.
  a = await s.screen('page-aaaa', ['k:escape', 'c:/', 'c:d', 'c:o', 'c:c', 'c:s', 'k:enter']);
  assert.match(a.text.at(-1) ?? '', /filter "docs"/);
  assert.doesNotMatch(a.text.join('\n'), /Fix the parser/);
});

test('in the agentmonitor app q quits, from the list or the footer; in the help and the details it goes back, in the filter it is typed', async (t) => {
  let quits = 0;
  const s = await start(t, fakeMonitor(() => sessions()), { onQuit: () => quits++ });
  let a = await s.screen('page-aaaa');
  assert.match(a.text.at(-1) ?? '', /\? help {2}q quit/);
  const help = (await s.screen('page-aaaa', ['c:?'], { h: 30 })).text.join('\n');
  assert.match(help, /r {13}read again {6}q {20}quit \(q in the details goes back\)/);
  a = await s.screen('page-aaaa', ['c:q', 'k:enter', 'c:q', 'c:/', 'c:q']);
  assert.equal(quits, 0);
  assert.match(a.text[1], /NAME/);
  assert.deepEqual([a.filter, a.typing], ['q', true]);
  // In the list it quits: the page answered first, with no lines, and what came after the q not done.
  a = await s.screen('page-aaaa', ['k:escape', 'c:q', 'k:down']);
  assert.equal(quits, 1);
  assert.deepEqual([a.lines, a.title], [undefined, `(1) Claude agents on ${clean(hostname())}`]);
  a = await s.screen('page-aaaa');
  assert.match(selected(a), /<img src=x/, 'not moved down');
  // A click on it in the footer.
  const [line, from] = a.keys.find((k) => k[3] === 'q') ?? [];
  await s.screen('page-aaaa', [`m:${from},${line}`]);
  assert.equal(quits, 2);
});

test('in the agentmonitor app a session opened in its flyout opens in its window, as the app opens one there', async (t) => {
  /** @type {string[]} */
  const opened = [];
  const s = await start(t, fakeMonitor(() => sessions()), { elsewhere: { 'page-flyout': (key) => opened.push(key) } });
  await s.screen('page-flyout');
  let f = await s.screen('page-flyout', ['k:enter']);
  assert.deepEqual(opened, ['s:b']);
  assert.match(f.text[1], /NAME/, 'the flyout stays with its list');
  // One click on a row opens it, as there is nothing to step into here.
  const y = f.text.findIndex((l) => l.includes('Fix the parser'));
  f = await s.screen('page-flyout', [`m:10,${y}`]);
  assert.deepEqual(opened, ['s:b', 's:a']);
  assert.match(selected(f), /Fix the parser/);
  // The other pages open it themselves; one named as an object's own property is no exception.
  for (const page of ['page-window', 'constructor']) {
    await s.screen(page);
    assert.match((await s.screen(page, ['k:enter'])).text[0], /^ ◆ <img src=x onerror=alert\(1\)> & "docs" +waiting $/, page);
  }
  assert.deepEqual(opened, ['s:b', 's:a']);
  // The app opens one in its window's page, for the window to show; in one not seen yet too, as it starts.
  s.served.open('page-window', 's:a');
  assert.match((await s.screen('page-window')).text[0], /Fix the parser +working/);
  s.served.open('page-started', 's:b');
  assert.match((await s.screen('page-started')).text[0], /^ ◆ <img src=x/);
  s.served.open('no', 's:a');
  assert.equal(s.logs.filter((l) => l.includes('page opened')).length, 4, 'not a page\'s ID: none made');
});

test('the board below the list at first; v and V step through the views, and one that moves of itself has its page ask more often, where there is room for it', async (t) => {
  const s = await start(t, fakeMonitor(() => sessions()));
  let a = await s.screen('page-aaaa', [], { h: 30 });
  assert.match(a.text.join('\n'), / ─ Board ─/);
  assert.equal(a.fast, undefined);
  a = await s.screen('page-aaaa', ['c:V'], { h: 30 });
  assert.match(a.text.join('\n'), / ─ Floor ─/);
  assert.match(a.text.at(-1) ?? '', /^ floor: each session as a figure/);
  assert.equal(a.fast, true);
  assert.equal((await s.screen('page-aaaa', [], { h: 5 })).fast, undefined, 'no room for it');
  assert.equal((await s.screen('page-aaaa', [], { h: 30, quiet: true })).fast, undefined, 'out of sight');
  a = await s.screen('page-aaaa', ['c:V'], { h: 30 });
  assert.match(a.text.at(-1) ?? '', /^ overview: the selected session/);
  assert.equal(a.fast, undefined);
  a = await s.screen('page-bbbb', [], { h: 30 });
  assert.deepEqual([/ ─ Board ─/.test(a.text.join('\n')), a.fast], [true, undefined], 'each page has its own');
  const radar = await start(t, fakeMonitor(() => sessions()), { view: 'radar' });
  a = await radar.screen('page-aaaa', [], { h: 30 });
  assert.match(a.text.join('\n'), / ─ Radar ─/);
  assert.equal(a.fast, true, 'with --view');
});

test('a click selects a row, a double click opens it, a click on a title sorts; the wheel moves', async (t) => {
  const s = await start(t, fakeMonitor(() => sessions()));
  let a = await s.screen('page-aaaa');
  const y = a.text.findIndex((l) => l.includes('Fix the parser'));
  a = await s.screen('page-aaaa', [`m:10,${y}`]);
  assert.match(selected(a), /Fix the parser/);
  a = await s.screen('page-aaaa', [`d:10,${y}`]);
  assert.match(a.text[0], /Fix the parser +working/);
  a = await s.screen('page-aaaa', ['k:escape', 'w:down']);
  assert.match(selected(a), /Explore the code/);
  a = await s.screen('page-aaaa', ['w:up', 'w:up']);
  assert.match(selected(a), /<img src=x/);
  a = await s.screen('page-aaaa', [`m:${a.text[1].indexOf('NAME')},1`]);
  assert.match(a.text.at(-1) ?? '', /sorted by name/);
});

test('a finger\'s drag takes the list\'s selection with it, and the text of the details and of the help', async (t) => {
  const s = await start(t, fakeMonitor(() => {
    const snap = sessions();
    snap.rows[0].events = Array.from({ length: 50 }, (_, k) => ({ ts: Date.now() - (50 - k) * 1000, kind: /** @type {const} */ ('reply'), text: `event ${k}` }));
    return snap;
  }));
  let a = await s.screen('page-aaaa');
  assert.match(selected(a), /<img src=x/);
  a = await s.screen('page-aaaa', ['t:down']);
  assert.match(selected(a), /Fix the parser/, 'a row down, as the finger went');
  a = await s.screen('page-aaaa', ['t:down', 't:up', 't:up']);
  assert.match(selected(a), /<img src=x/);
  // In the details a finger going down brings back what is older, a line for a line.
  a = await s.screen('page-aaaa', ['t:down', 'k:enter', 't:down', 't:down'], { h: 30 });
  assert.match(a.text.join('\n'), /Activity \(2 newer below\)/);
  a = await s.screen('page-aaaa', ['t:up'], { h: 30 });
  assert.match(a.text.join('\n'), /Activity \(1 newer below\)/);
  // In the help, going up, what is further down.
  const phone = { w: 43, h: 20 };
  a = await s.screen('page-aaaa', ['k:escape', 'c:?', 't:up', 't:up'], phone);
  assert.match(a.text.at(-1) ?? '', / 3-21\/\d+ $/);
  a = await s.screen('page-aaaa', ['t:down', 't:down', 't:down'], phone);
  assert.match(a.text.at(-1) ?? '', / 1-19\/\d+ $/);
});

test('what a phone needs: where / is, for its tap to open the keyboard, and the filter typed in the page\'s field', async (t) => {
  const s = await start(t, fakeMonitor(() => sessions()));
  let a = await s.screen('page-aaaa');
  assert.deepEqual([a.filter, a.typing], ['', false]);
  const slash = a.keys.find((k) => k[3] === '/');
  assert.ok(slash, JSON.stringify(a.keys));
  const [y, x0, x1] = slash;
  assert.equal(y, a.text.length - 1, 'in the footer');
  assert.equal(a.text[y].slice(x0, x1), '/ filter');
  a = await s.screen('page-aaaa', [`m:${x0},${y}`]);
  assert.equal(a.typing, true);
  assert.deepEqual(a.keys.map((k) => k[3]), ['enter', 'escape'], 'keep and clear');
  // What the field holds, sent whole as it changes.
  a = await s.screen('page-aaaa', ['f:do', 'f:docs']);
  assert.deepEqual([a.filter, a.typing], ['docs', true]);
  assert.match(a.text.at(-1) ?? '', /^ \/docs /);
  assert.doesNotMatch(a.text.join('\n'), /Fix the parser/);
  a = await s.screen('page-aaaa', ['k:enter']);
  assert.deepEqual([a.filter, a.typing], ['docs', false]);
  assert.match(a.text.at(-1) ?? '', /filter "docs"/);
  // Out of sight, none of it.
  const quiet = await s.screen('page-aaaa', [], { quiet: true });
  assert.deepEqual([quiet.keys, quiet.filter, quiet.typing], [undefined, undefined, undefined]);
  // Only in the list, as /: not in the details.
  a = await s.screen('page-aaaa', ['k:enter', 'f:parser']);
  assert.match(a.text[0], /<img src=x/);
  assert.deepEqual([a.filter, a.typing], ['docs', false]);
  assert.deepEqual(a.keys.map((k) => k[3]), ['escape', 'tab']);
});

test('the agents selected in the pages are read; pages that stop asking are forgotten, and the oldest of too many', async (t) => {
  const monitor = fakeMonitor(() => sessions());
  const s = await start(t, monitor, { pageTtlMs: 300, maxPages: 2 });
  await s.screen('page-one-1');
  assert.deepEqual([...monitor.focus], ['s:b'], 'its first row, selected at the start');
  const reads = monitor.refreshes;
  const one = await s.screen('page-one-1', ['k:down', 'k:down', 'k:enter']);
  assert.match(one.text[0], /Explore the code/);
  assert.deepEqual([...monitor.focus], ['a:aaaa:x1']);
  assert.equal(monitor.refreshes, reads + 1, 'read again at once, for its transcript');
  // What a page sends acts on what it was shown: a new page is shown the list first.
  await s.screen('page-two-2', ['k:down', 'k:enter']);
  const focus = () => [...monitor.focus].sort();
  assert.deepEqual(focus(), ['a:aaaa:x1', 's:b']);
  await s.screen('page-two-2', ['k:down', 'k:enter']);
  assert.deepEqual(focus(), ['a:aaaa:x1', 's:a']);
  // A third page, one too many: the first, which asked longest ago, is forgotten.
  await s.screen('page-three');
  assert.deepEqual(focus(), ['s:a', 's:b']);
  assert.equal(s.logs.filter((l) => /^\d\d:\d\d:\d\d {2}page opened from 127\.0\.0\.1$/.test(l)).length, 3);
  // It comes back to a new view, the list; and the second, now the oldest, is forgotten.
  assert.match((await s.screen('page-one-1')).text[1], /NAME/);
  assert.deepEqual(focus(), ['s:b']);
  await s.screen('page-three', ['k:down', 'k:enter']);
  assert.deepEqual(focus(), ['s:a', 's:b']);
  // The pages that stopped asking for a while are forgotten.
  await sleep(400);
  await s.screen('page-four', [], { quiet: true });
  assert.deepEqual(focus(), []);
});

test('a read serves every page, and is made again when older than the interval, or for r', async (t) => {
  const monitor = fakeMonitor(() => sessions());
  const s = await start(t, monitor, { intervalMs: 300 });
  await s.screen('page-aaaa');
  await s.screen('page-bbbb');
  assert.equal(monitor.refreshes, 1);
  const r = await s.screen('page-aaaa', ['c:r']);
  assert.equal(monitor.refreshes, 2);
  assert.match(r.text.at(-1) ?? '', /reading again/);
  await sleep(350);
  await s.screen('page-bbbb');
  assert.equal(monitor.refreshes, 3);
  // w steps the window for "recently active", which every page shares.
  await s.screen('page-bbbb', ['c:w']);
  assert.equal(monitor.windowMs, 72 * HOUR);
  assert.equal(monitor.refreshes, 4);
});

test('the latest read, as the agentmonitor app\'s tray asks for it: the pages\' own, read again once older than the interval', async (t) => {
  const monitor = fakeMonitor(() => sessions());
  const s = await start(t, monitor, { intervalMs: 300 });
  const snap = await s.served.snapshot();
  assert.deepEqual(snap?.rows.map((r) => r.key), ['s:a', 's:b']);
  await s.screen('page-aaaa');
  assert.equal(await s.served.snapshot(), snap, 'the same read');
  assert.equal(monitor.refreshes, 1);
  await sleep(350);
  const again = await s.served.snapshot();
  assert.equal(monitor.refreshes, 2);
  assert.notEqual(again, snap);
  assert.equal((await s.screen('page-aaaa')).text.some((l) => l.includes('Fix the parser')), true);
  assert.equal(monitor.refreshes, 2, 'which the page is shown');
});

test('a page\'s bell: on with b or --bell, it rings once when a session ends its turn or starts waiting', async (t) => {
  const now = Date.now();
  /** @type {import('../src/monitor.js').State} */
  let state = 'working';
  const monitor = fakeMonitor(() => {
    const snap = sessions(now);
    snap.rows[0].state = state;
    return snap;
  });
  // Read on every ask.
  const s = await start(t, monitor, { intervalMs: 0 });
  // Wide enough for the footer to have the bell.
  let a = await s.screen('page-aaaa', [], { w: 160 });
  assert.deepEqual([a.bell, a.ring], [false, false]);
  assert.match(a.text.at(-1) ?? '', /b bell:off {2}\? help/);
  state = 'idle';
  assert.equal((await s.screen('page-aaaa')).ring, false, 'not with the bell off');
  a = await s.screen('page-aaaa', ['c:b']);
  assert.deepEqual([a.bell, a.ring], [true, false], 'nor for what changed while it was off');
  assert.match(a.text.at(-1) ?? '', /the bell rings when a session needs you or ends its turn/);
  state = 'working';
  assert.equal((await s.screen('page-aaaa')).ring, false, 'back at work');
  state = 'idle';
  assert.equal((await s.screen('page-aaaa')).ring, true, 'its turn ended');
  assert.equal((await s.screen('page-aaaa')).ring, false, 'once');
  // Out of sight, a page asks for its title and its bell, and no lines.
  state = 'waiting';
  const quiet = await s.screen('page-aaaa', [], { quiet: true });
  assert.equal(quiet.lines, undefined);
  assert.equal(quiet.ring, true, 'it waits for you');
  assert.equal(quiet.title, `(2) Claude agents on ${clean(hostname())}`);
  // Each page has a bell of its own.
  assert.equal((await s.screen('page-bbbb')).bell, false);

  const on = await start(t, fakeMonitor(() => sessions()), { bell: true });
  const b = await on.screen('page-bbbb', [], { w: 160 });
  assert.deepEqual([b.bell, b.ring], [true, false], 'on from the start, ringing for nothing yet');
  assert.match(b.text.at(-1) ?? '', /b bell:on/);
});

test('a read that fails is said on the pages and logged once; the last screen stays', async (t) => {
  let fail = false;
  const monitor = fakeMonitor(() => {
    if (fail) throw new Error('disk on fire');
    return sessions();
  });
  const s = await start(t, monitor, { intervalMs: 50 });
  await s.screen('page-aaaa');
  fail = true;
  await sleep(60);
  let a = await s.screen('page-aaaa');
  assert.match(a.text.at(-1) ?? '', /could not read: disk on fire/);
  assert.ok(a.text.some((l) => l.includes('Fix the parser')), 'what was read before');
  await sleep(60);
  a = await s.screen('page-aaaa');
  assert.deepEqual(s.logs.filter((l) => l.includes('could not read')), ['could not read: disk on fire']);
});

test('runs: the styles made classes, and characters outside ASCII in boxes as wide as they are', () => {
  assert.deepEqual(runs(' \x1b[1mClaude agents\x1b[0m  \x1b[1;33m◆\x1b[0m 1 waiting'), [[' '], ['Claude agents', 'b'], ['  '], ['◆', 'b yellow', 1], [' 1 waiting']]);
  assert.deepEqual(runs('\x1b[2m────\x1b[0m'), [['────', 'd', 4]], 'the same character over and over, in one box');
  assert.deepEqual(runs('ab漢字 ok…'), [['ab'], ['漢', '', 2], ['字', '', 2], [' ok'], ['…', '', 1]]);
  assert.deepEqual(runs('\x1b[7m> x \x1b[32m●\x1b[0m end'), [['> x ', 'i'], ['●', 'i green', 1], [' end']]);
  assert.deepEqual(runs('👍🏽!'), [['👍🏽', '', 2], ['!']], 'one grapheme of two code points');
  assert.deepEqual(runs('\x1b[0m'), []);
});

test('what a page sends: keys by name, characters, clicks, the wheel, a finger\'s drag and a filter typed; nothing else', () => {
  assert.deepEqual(parseInput('f:docs'), { filter: 'docs' });
  assert.deepEqual(parseInput('f:'), { filter: '' });
  assert.deepEqual(parseInput('f:fix  the '), { filter: 'fix  the ' }, 'its spaces as typed');
  assert.deepEqual(parseInput('f:a\tb c‮d\x1be'), { filter: 'a b cde' }, 'other spaces made spaces, controls left out');
  assert.deepEqual(parseInput(`f:${'é'.repeat(300)}`), { filter: 'é'.repeat(200) }, 'as long as the field takes');
  assert.deepEqual(parseInput('k:up'), { name: 'up' });
  assert.deepEqual(parseInput('k:backtab'), { name: 'backtab' });
  assert.deepEqual(parseInput('c:a'), { name: 'a', ch: 'a' });
  assert.deepEqual(parseInput('c: '), { name: ' ', ch: ' ' });
  assert.deepEqual(parseInput('c:é'), { name: 'é', ch: 'é' });
  assert.deepEqual(parseInput('m:3,14'), { name: 'mouse', mouse: { button: 'left', x: 3, y: 14, release: false, motion: false, double: false } });
  assert.equal(parseInput('d:3,14')?.mouse?.double, true);
  assert.equal(parseInput('w:up')?.mouse?.button, 'wheelup');
  assert.equal(parseInput('w:down')?.mouse?.button, 'wheeldown');
  assert.deepEqual(parseInput('t:up'), { drag: 'up' });
  assert.deepEqual(parseInput('t:down'), { drag: 'down' });
  for (const bad of ['', 'up', 'k:', 'k:quit', 'k:Up', 'c:', 'c:ab', 'c:\x1b', 'c:\t', 'c:\u202e', 'c:\u00a0', 'm:3', 'm:-1,2', 'm:1,2,3', 'm:12345,1', 'w:left', 't:', 't:left', 'x:1']) {
    assert.equal(parseInput(bad), undefined, JSON.stringify(bad));
  }
});

test('the addresses printed: the one listened on, or for every interface, each network address', () => {
  const nets = /** @type {any} */ ({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
    eth0: [{ address: '192.168.1.5', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    wifi: [{ address: '10.0.0.7', family: 'IPv4', internal: false }, { address: '192.168.1.5', family: 'IPv4', internal: false }],
  });
  assert.deepEqual(urls('127.0.0.1', 7420, 'tok', nets), ['http://127.0.0.1:7420/tok/']);
  assert.deepEqual(urls('localhost', 7420, 'tok', nets), ['http://localhost:7420/tok/']);
  assert.deepEqual(urls('::1', 7420, 'tok', nets), ['http://[::1]:7420/tok/']);
  const all = ['http://192.168.1.5:7420/tok/', 'http://10.0.0.7:7420/tok/', 'http://127.0.0.1:7420/tok/'];
  assert.deepEqual(urls('0.0.0.0', 7420, 'tok', nets), all);
  assert.deepEqual(urls('::', 7420, 'tok', nets), all);
  // The likeliest for a phone first: 192.168..., 10..., 172.16 to 172.31, then the rest; but a
  // virtual network's after them all: this computer's side of one (.1, as Hyper-V's Default
  // Switch and WSL's here) after an adapter with a hypervisor's MAC (Hyper-V's, Parallels').
  const ip = (/** @type {string} */ address, mac = 'ac:b4:80:01:02:03') => [{ address, family: 'IPv4', internal: false, mac }];
  const many = /** @type {any} */ ({
    wsl: ip('172.26.96.1', '00:15:5d:aa:bb:cc'), vpn: ip('100.64.1.2', '00:00:00:00:00:00'), switch: ip('192.168.64.1', '00:15:5D:AA:BB:CD'),
    corp: ip('10.1.2.3'), odd: ip('172.32.0.1'), external: ip('192.168.1.40', '00:15:5d:aa:bb:ce'), wifi: ip('192.168.1.23'), parallels: ip('10.211.55.2', '00:1c:42:00:00:08'),
  });
  assert.deepEqual(urls('0.0.0.0', 7420, 'tok', many).map((u) => new URL(u).hostname), [
    '192.168.1.23', '10.1.2.3', '100.64.1.2', '192.168.1.40', '10.211.55.2', '172.32.0.1', '192.168.64.1', '172.26.96.1', '127.0.0.1',
  ]);
});

test('what --serve prints: its addresses, the first as a QR code for a phone, and what to know', () => {
  const lan = ['http://192.168.1.5:7420/tok/', 'http://10.0.0.7:7420/tok/', 'http://127.0.0.1:7420/tok/'];
  const opts = { color: true, ascii: false, windows: false };
  assert.equal(
    banner('127.0.0.1', ['http://127.0.0.1:7420/tok/'], opts),
    'The web view, read only, at:\n  http://127.0.0.1:7420/tok/\nOnly this computer can open it; with --host 0.0.0.0, the others on its networks can too.\nCtrl+C stops it.\n',
  );
  const out = banner('0.0.0.0', lan, { ...opts, windows: true }).split('\n');
  const code = qrLines(/** @type {boolean[][]} */ (qr(lan[0]))).map((l) => `  ${l}`);
  assert.deepEqual(out, [
    'The web view, read only, at:', ...lan.map((u) => `  ${u}`),
    'A phone\'s camera opens the first from this code:', ...code,
    'Anyone with the address sees what it shows.',
    'Windows can ask whether Node.js may take connections: other computers reach it once allowed.',
    'Ctrl+C stops it.', '',
  ]);
  assert.equal(code.length, 19); // 28 bytes, so version 3: 29 modules and 8 of border, two rows a line
  // One address: "it". With ascii, spaces; without colors, or with only this computer's own, no code.
  assert.match(banner('192.168.1.5', [lan[0]], opts), /\nA phone's camera opens it from this code:\n/);
  assert.ok(banner('192.168.1.5', [lan[0]], { ...opts, ascii: true }).split('\n').every((l) => /^[\x1b\x20-\x7e]*$/.test(l)));
  assert.doesNotMatch(banner('0.0.0.0', lan, { ...opts, color: false }), /camera|\x1b/);
  assert.doesNotMatch(banner('0.0.0.0', ['http://127.0.0.1:7420/tok/'], opts), /camera/);
});

test('the page\'s script: keys as the monitor names them, cells, the wheel; never markup', () => {
  assert.equal(keyInput({ key: 'ArrowUp' }), 'k:up');
  assert.equal(keyInput({ key: 'PageDown' }), 'k:pagedown');
  assert.equal(keyInput({ key: 'Enter' }), 'k:enter');
  assert.equal(keyInput({ key: 'Escape' }), 'k:escape');
  assert.equal(keyInput({ key: 'Tab' }), 'k:tab');
  assert.equal(keyInput({ key: 'Tab', shiftKey: true }), 'k:backtab');
  assert.equal(keyInput({ key: 'j' }), 'c:j');
  assert.equal(keyInput({ key: 'G', shiftKey: true }), 'c:G');
  assert.equal(keyInput({ key: '/' }), 'c:/');
  assert.equal(keyInput({ key: ' ' }), 'c: ');
  assert.equal(keyInput({ key: '@', ctrlKey: true, altKey: true, altGraph: true }), 'c:@', 'AltGr types');
  for (const e of [
    { key: 'c', ctrlKey: true }, { key: 'r', metaKey: true }, { key: 'f', altKey: true }, { key: 'Shift', shiftKey: true },
    { key: 'F5' }, { key: 'Dead' }, { key: 'a', isComposing: true }, { key: 'constructor' },
  ]) {
    assert.equal(keyInput(e), undefined, JSON.stringify(e));
  }
  assert.deepEqual(cellAt(17, 40, { w: 8, h: 17.5 }), { x: 2, y: 2 });
  assert.deepEqual(cellAt(-3, 0, { w: 8, h: 17.5 }), { x: 0, y: 0 });
  assert.deepEqual(wheelSteps(0, 100, 0, 17.5, 500), [2, 0]);
  assert.deepEqual(wheelSteps(30, 40, 0, 17.5, 500), [1, 20]);
  assert.deepEqual(wheelSteps(0, -3, 1, 17.5, 500), [-1, -2.5]);
  assert.deepEqual(wheelSteps(0, 1, 2, 17.5, 500), [10, 0]);
  assert.deepEqual(dragSteps(0, -40, 17.5), [-2, -5]);
  assert.deepEqual(dragSteps(-5, 10, 17.5), [0, 5]);
  assert.deepEqual(dragSteps(5, 30, 17.5), [2, 0]);
  assert.deepEqual(dragSteps(3, 10, 0), [0, 13], 'no steps before a line is measured');
  const keys = [[11, 21, 29, '/'], [11, 31, 44, 's'], 'junk', [11, 1, 9]];
  assert.equal(keyAt(keys, 21, 11), '/');
  assert.equal(keyAt(keys, 28, 11), '/');
  assert.equal(keyAt(keys, 29, 11), undefined, 'between the keys');
  assert.equal(keyAt(keys, 21, 10), undefined, 'on another line');
  assert.equal(keyAt(keys, 1, 11), undefined, 'no key named');
  const source = readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(/);
});

test('the page\'s bell: a short tone, from now to under half a second on', () => {
  /** @type {unknown[][]} */
  const calls = [];
  const audio = {
    currentTime: 0,
    destination: 'speakers',
    createOscillator: () => ({
      frequency: { value: 0 },
      connect: (/** @type {any} */ to) => to,
      start: (/** @type {number} */ at) => calls.push(['start', at]),
      stop: (/** @type {number} */ at) => calls.push(['stop', at]),
    }),
    createGain: () => ({
      gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: (/** @type {string} */ to) => calls.push(['to', to]),
    }),
  };
  beep(/** @type {any} */ (audio));
  assert.deepEqual(calls, [['to', 'speakers'], ['start', 0], ['stop', 0.45]]);
});
