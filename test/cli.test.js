import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { width } from '../src/format.js';
import { HOUR, makeConfig, MINUTE, rec, sessionId } from './helpers/fixture.js';

const BIN = fileURLToPath(new URL('../bin/agentmonitor.js', import.meta.url));

/**
 * This environment without the variables agentmonitor reads, and with `env`.
 * @param {Record<string, string>} [env]
 */
function environment(env = {}) {
  const base = { ...process.env };
  for (const k of ['FORCE_COLOR', 'NO_COLOR', 'CLAUDE_CONFIG_DIR', 'COLUMNS']) delete base[k];
  return { ...base, ...env };
}

/**
 * Runs agentmonitor with its output piped, as a script would, in an environment without the
 * variables it reads unless given.
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: environment(env), timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? Number(err.code) : 0, stdout, stderr });
    });
  });
}

test('--help and --version', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: agentmonitor \[options\]/);
  const version = await run(['-v']);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
});

test('a wrong option ends with status 2, saying why', async () => {
  for (const [args, why] of /** @type {[string[], RegExp][]} */ ([
    [['--since', 'soon'], /not a duration: 'soon'/],
    [['--interval', 'often'], /not a duration: 'often'/],
    [['--agents', 'some'], /--agents takes running, all, none, not 'some'/],
    [['--bogus'], /Unknown option '--bogus'/],
    [['extra'], /Unexpected argument 'extra'/],
    [['--host', '0.0.0.0'], /--host goes with --serve/],
    [['--port', '8080'], /--port goes with --serve/],
    [['--token', 'abcdefghijklmnop'], /--token goes with --serve/],
    [['--serve', '--once'], /--serve does not go with --once or --json/],
    [['--serve', '--json'], /--serve does not go with --once or --json/],
    [['--serve', '--port', 'http'], /--port takes a number from 0 to 65535, not 'http'/],
    [['--serve', '--port', '65536'], /--port takes a number from 0 to 65535, not '65536'/],
    [['--serve', '--token', 'too-short'], /--token takes 16 or more letters, digits, - and _/],
    [['--serve', '--token', 'sixteen chars ok'], /--token takes 16 or more letters, digits, - and _/],
  ])) {
    const r = await run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, why);
    assert.match(r.stderr, /Run agentmonitor --help/);
  }
});

test('--once prints a table of the sessions, and so does a run whose output is not a terminal', async (t) => {
  const cfg = makeConfig(t);
  const now = Date.now();
  const live = sessionId();
  cfg.transcript(live, [rec.prompt('Live session', now - 5 * MINUTE), rec.tool('toolu_1', 'Bash', { command: 'npm test' }, now - 10_000, { effort: 'xhigh' })]);
  // This test's process (a Node) stands in for a Claude Code process.
  cfg.registry({ pid: process.pid, sessionId: live, cwd: '/work/live', status: 'busy', statusUpdatedAt: now - 10_000 });
  const ended = sessionId();
  cfg.transcript(ended, [rec.prompt('Ended session', now - 2 * HOUR), rec.reply('All done.', now - 2 * HOUR + 5000)], { mtime: now - 2 * HOUR + 5000 });
  for (const args of [['--once'], []]) {
    const { code, stdout, stderr } = await run([...args, '--dir', cfg.dir], { COLUMNS: '120' });
    assert.equal(code, 0, stderr);
    const lines = stdout.trimEnd().split('\n');
    // Its command has run for 10s: it waits on a tool.
    assert.match(lines[0], /^ Claude agents {2}◐ 1 in a tool {2}· 1 ended$/);
    assert.match(lines[1], /NAME +PROJECT +KIND +MODEL +EFFORT +CTX +ACTIVITY +LAST$/);
    assert.match(stdout, /◐ Live session +live +cli +opus 5\.5 +xhigh +60k +Bash: npm test +\d+s +\d+s\n/);
    assert.match(stdout, /· Ended session +demo .*All done\. +1h\n/);
    for (const l of lines) assert.ok(width(l) <= 120, l);
    assert.doesNotMatch(stdout, /\x1b\[/, 'no colors in a pipe');
  }
});

test('--json prints what was found, without the events', async (t) => {
  const cfg = makeConfig(t);
  const now = Date.now();
  const id = sessionId();
  cfg.transcript(id, [rec.prompt('Json session', now - HOUR), rec.reply('Hello.', now - HOUR + 1000)], { mtime: now - HOUR + 1000 });
  const { code, stdout } = await run(['--json', '--dir', cfg.dir]);
  assert.equal(code, 0);
  const snap = JSON.parse(stdout);
  assert.equal(snap.found, true);
  assert.equal(snap.windowMs, 24 * HOUR);
  assert.deepEqual(snap.rows.map((/** @type {any} */ r) => [r.title, r.state, r.activity]), [['Json session', 'ended', 'Hello.']]);
  assert.doesNotMatch(stdout, /"events"/);
});

test('--since and --hide-ended; a folder with no sessions', async (t) => {
  const cfg = makeConfig(t);
  const now = Date.now();
  cfg.transcript(sessionId(), [rec.prompt('Two hours ago', now - 2 * HOUR)], { mtime: now - 2 * HOUR });
  assert.match((await run(['--once', '--dir', cfg.dir])).stdout, /Two hours ago/);
  assert.match((await run(['--once', '--since', '1h', '--dir', cfg.dir])).stdout, /No Claude agents running or active in the last 1h\./);
  assert.doesNotMatch((await run(['--once', '-e', '--dir', cfg.dir])).stdout, /Two hours ago/);
  const empty = makeConfig(t);
  assert.match((await run(['--once', '--dir', empty.dir])).stdout, /No Claude Code sessions found in /);
});

test('--serve prints the address of the web view, on this computer only, and serves it there', async (t) => {
  const cfg = makeConfig(t);
  const now = Date.now();
  cfg.transcript(sessionId(), [rec.prompt('Served session', now - 5 * MINUTE), rec.reply('Done.', now - 4 * MINUTE)], { mtime: now - 4 * MINUTE });
  const token = 'cli-test-token-0123456789';
  const child = spawn(process.execPath, [BIN, '--serve', '--port', '0', '--token', token, '--dir', cfg.dir], { env: environment() });
  t.after(() => child.kill());
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => (out += d));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`not ready: ${out}`)), 20_000);
    child.stdout.on('data', () => {
      if (!out.includes('Ctrl+C stops it.')) return;
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once('exit', (code) => reject(new Error(`ended with ${code}: ${out}`)));
  });
  const m = /^The web view, read only, at:\n {2}(http:\/\/127\.0\.0\.1:\d+\/cli-test-token-0123456789\/)\nOnly this computer can open it; /.exec(out);
  assert.ok(m, out);
  const page = await fetch(m[1]);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<script type="module" src="app.js">/);
  const screen = await (await fetch(`${m[1]}screen?page=cli-page-1&w=120&h=10`)).json();
  assert.ok(screen.lines.some((/** @type {[string][]} */ l) => l.map((r) => r[0]).join('').includes('Served session')), JSON.stringify(screen.lines));
  assert.equal((await fetch(m[1].replace(token, 'not-the-token-0123456789'))).status, 404);
});

test('colors: on with --color or FORCE_COLOR, off with --no-color', async (t) => {
  const cfg = makeConfig(t);
  const now = Date.now();
  cfg.transcript(sessionId(), [rec.prompt('Colorful', now - HOUR)], { mtime: now - HOUR });
  assert.match((await run(['--once', '--color', '--dir', cfg.dir])).stdout, /\x1b\[/);
  assert.match((await run(['--once', '--dir', cfg.dir], { FORCE_COLOR: '1' })).stdout, /\x1b\[/);
  assert.doesNotMatch((await run(['--once', '--color', '--no-color', '--dir', cfg.dir])).stdout, /\x1b\[/);
});
