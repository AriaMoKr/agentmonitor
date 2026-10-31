import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { test } from 'node:test';
import { clean } from '../src/format.js';
import { parseInput, runs, serve, urls } from '../src/serve.js';
import { cellAt, keyInput, wheelSteps } from '../src/web/app.js';
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
 * @typedef {{ title: string, lines: import('../src/serve.js').Run[][], text: string[] }} Screen
 */

/**
 * Serves `monitor` on a free port of this computer, for the test to ask.
 * @param {import('node:test').TestContext} t
 * @param {ReturnType<typeof fakeMonitor>} monitor
 * @param {{ intervalMs?: number, ascii?: boolean, pageTtlMs?: number, maxPages?: number }} [o]
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
    logs,
    /** @param {string} path @param {RequestInit} [init] */
    get: (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init }),
    /**
     * A page's screen after what it sends: its lines as runs, and as text.
     * @param {string} page
     * @param {string[]} [inputs]
     * @param {{ w?: number, h?: number }} [size]
     * @returns {Promise<Screen>}
     */
    async screen(page, inputs = [], { w = 100, h = 12 } = {}) {
      const query = new URLSearchParams({ page, w: String(w), h: String(h) });
      for (const i of inputs) query.append('i', i);
      const res = await fetch(`${base}/${TOKEN}/screen?${query}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
      const body = await res.json();
      return { ...body, text: body.lines.map((/** @type {import('../src/serve.js').Run[]} */ l) => l.map((r) => r[0]).join('')) };
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
  assert.match(text[1], /NAME +PROJECT/);
  // The session that waits comes first, selected: its line drawn inverse, the title as it is.
  assert.match(selected({ title, lines, text }), /^ ◆ <img src=x onerror=alert\(1\)…/);
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
  // Back to the list, and a filter typed.
  a = await s.screen('page-aaaa', ['k:escape', 'c:/', 'c:d', 'c:o', 'c:c', 'c:s', 'k:enter']);
  assert.match(a.text.at(-1) ?? '', /filter "docs"/);
  assert.doesNotMatch(a.text.join('\n'), /Fix the parser/);
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

test('the agents in the pages\' details are read; pages that stop asking are forgotten, and the oldest of too many', async (t) => {
  const monitor = fakeMonitor(() => sessions());
  const s = await start(t, monitor, { pageTtlMs: 300, maxPages: 2 });
  await s.screen('page-one-1');
  const reads = monitor.refreshes;
  const one = await s.screen('page-one-1', ['k:down', 'k:down', 'k:enter']);
  assert.match(one.text[0], /Explore the code/);
  assert.deepEqual([...monitor.focus], ['a:aaaa:x1']);
  assert.equal(monitor.refreshes, reads + 1, 'read again at once, for its transcript');
  // What a page sends acts on what it was shown: a new page is shown the list first.
  await s.screen('page-two-2', ['k:down', 'k:enter']);
  assert.deepEqual([...monitor.focus], ['a:aaaa:x1']);
  await s.screen('page-two-2', ['k:down', 'k:enter']);
  assert.deepEqual([...monitor.focus].sort(), ['a:aaaa:x1', 's:a']);
  // A third page, one too many: the first, which asked longest ago, is forgotten.
  await s.screen('page-three');
  assert.deepEqual([...monitor.focus], ['s:a']);
  assert.equal(s.logs.filter((l) => /^\d\d:\d\d:\d\d {2}page opened from 127\.0\.0\.1$/.test(l)).length, 3);
  // It comes back to a new view, the list; and the second, now the oldest, is forgotten.
  assert.match((await s.screen('page-one-1')).text[1], /NAME/);
  assert.deepEqual([...monitor.focus], []);
  await s.screen('page-three', ['k:down', 'k:enter']);
  assert.deepEqual([...monitor.focus], ['s:a']);
  // The pages that stopped asking for a while are forgotten.
  await sleep(400);
  await s.screen('page-four');
  assert.deepEqual([...monitor.focus], []);
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

test('what a page sends: keys by name, characters, clicks and the wheel; nothing else', () => {
  assert.deepEqual(parseInput('k:up'), { name: 'up' });
  assert.deepEqual(parseInput('k:backtab'), { name: 'backtab' });
  assert.deepEqual(parseInput('c:a'), { name: 'a', ch: 'a' });
  assert.deepEqual(parseInput('c: '), { name: ' ', ch: ' ' });
  assert.deepEqual(parseInput('c:é'), { name: 'é', ch: 'é' });
  assert.deepEqual(parseInput('m:3,14'), { name: 'mouse', mouse: { button: 'left', x: 3, y: 14, release: false, motion: false, double: false } });
  assert.equal(parseInput('d:3,14')?.mouse?.double, true);
  assert.equal(parseInput('w:up')?.mouse?.button, 'wheelup');
  assert.equal(parseInput('w:down')?.mouse?.button, 'wheeldown');
  for (const bad of ['', 'up', 'k:', 'k:quit', 'k:Up', 'c:', 'c:ab', 'c:\x1b', 'c:\t', 'c:\u202e', 'c:\u00a0', 'm:3', 'm:-1,2', 'm:1,2,3', 'm:12345,1', 'w:left', 'x:1']) {
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
  const source = readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(/);
});
