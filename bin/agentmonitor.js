#!/usr/bin/env node
// agentmonitor: the Claude agents running on this computer, and the ones active lately, live in
// a terminal. Run it with --help for the options; README.md says what it reads and shows.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseDuration } from '../src/format.js';
import { Monitor } from '../src/monitor.js';
import { VIEWS } from '../src/panels.js';
import { banner, serve, TOKEN, urls } from '../src/serve.js';
import { runTui } from '../src/tui.js';
import { AGENTS_SHOWN, makeTheme, table } from '../src/view.js';

const HELP = `Usage: agentmonitor [options]

Shows the Claude Code sessions on this computer (in a terminal, the desktop app,
an IDE or the background) that are running or were active lately, with what
each is doing, and the subagents and workflows they started. Live in a
terminal; printed once when the output is not one; with --serve, as a web page.

Options:
  -s, --since <time>     how far back "recently active" reaches (default 24h)
  -i, --interval <time>  how often to read everything again (default 1s)
  -a, --agents <which>   agents listed under their session: running (default),
                         all, or none
  -e, --hide-ended       list only the sessions that run
      --show-archived    list the sessions archived in the desktop app too
  -1, --once             print the table once and exit
      --json             print what was found as JSON and exit
      --dir <path>       Claude Code's config folder (default: $CLAUDE_CONFIG_DIR,
                         else ~/.claude)
      --bell             ring the bell when a session starts waiting for you,
                         or finishes its turn (b turns it on or off; with
                         --serve, the page beeps)
      --view <name>      the view below the list to start with: board (the
                         default), overview, floor, bands, lanes, ticker,
                         pipeline, files, chart, share, today, tank, radar or
                         spark (v and V step through them)
      --ascii            draw with ASCII only
      --color, --no-color  colors on or off (default: on in a terminal,
                         off with NO_COLOR set)
      --no-mouse         leave the mouse to the terminal (to select text)
      --serve            serve the list and the details as a web page instead,
                         read only, at an address it prints, which holds a token
      --host <address>   where --serve listens: 127.0.0.1 (the default) is this
                         computer only; 0.0.0.0, every network it is on (then
                         its address is printed as a QR code too, for a phone)
      --port <n>         --serve's port (default 7420; 0 for any free one)
      --token <t>        the token in --serve's address, to keep it the same
                         (16 or more letters, digits, - and _; default: random)
  -v, --version
  -h, --help

Times: 30s, 5m, 2h, 1d, 1w.
Keys: arrows move, Enter shows details, / filters, s sorts, e cycles the
sessions that ended (on but those archived, off, all), a cycles agents, w
cycles the window, b turns the bell on or off, v and V cycle the views below
the list, ? help, q quits. The mouse: a click selects, a double click shows
details, the wheel moves. The web page takes the same keys and clicks; anyone
with its address sees what it shows.
`;

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`agentmonitor: ${message}\nRun agentmonitor --help for the options.\n`);
  process.exit(2);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      since: { type: 'string', short: 's' },
      interval: { type: 'string', short: 'i' },
      agents: { type: 'string', short: 'a' },
      'hide-ended': { type: 'boolean', short: 'e' },
      'show-archived': { type: 'boolean' },
      once: { type: 'boolean', short: '1' },
      json: { type: 'boolean' },
      dir: { type: 'string' },
      bell: { type: 'boolean' },
      view: { type: 'string' },
      ascii: { type: 'boolean' },
      color: { type: 'boolean' },
      'no-color': { type: 'boolean' },
      'no-mouse': { type: 'boolean' },
      serve: { type: 'boolean' },
      host: { type: 'string' },
      port: { type: 'string' },
      token: { type: 'string' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  }));
} catch (e) {
  fail(/** @type {Error} */ (e).message);
}

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (values.version) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

let windowMs = 24 * 3_600_000;
let intervalMs = 1000;
try {
  if (values.since !== undefined) windowMs = parseDuration(values.since);
  if (values.interval !== undefined) intervalMs = Math.max(250, parseDuration(values.interval));
} catch (e) {
  fail(/** @type {Error} */ (e).message);
}
const agents = /** @type {import('../src/view.js').AgentsShown} */ (values.agents ?? 'running');
if (!AGENTS_SHOWN.includes(agents)) fail(`--agents takes ${AGENTS_SHOWN.join(', ')}, not '${values.agents}'`);
// Without --view, the viewer's own: the board.
const view = values.view;
if (view !== undefined && !VIEWS.some((v) => v.name === view)) fail(`--view takes ${VIEWS.map((v) => v.name).join(', ')}, not '${view}'`);
if (view !== undefined && (values.once || values.json)) fail('--view does not go with --once or --json');
if (values.serve && (values.once || values.json)) fail('--serve does not go with --once or --json');
for (const o of /** @type {const} */ (['host', 'port', 'token'])) if (values[o] !== undefined && !values.serve) fail(`--${o} goes with --serve`);
let port = 7420;
if (values.port !== undefined) {
  if (!/^\d{1,5}$/.test(values.port) || Number(values.port) > 65535) fail(`--port takes a number from 0 to 65535, not '${values.port}'`);
  port = Number(values.port);
}
if (values.token !== undefined && !TOKEN.test(values.token)) fail('--token takes 16 or more letters, digits, - and _');

const dir = resolve(values.dir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')));
const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY) && !values.once && !values.json;
// Printed once, the usage waits for the transcripts it is carried on with.
const monitor = new Monitor({ dir, windowMs, wait: !interactive && !values.serve });
const forced = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0';
const color = values['no-color'] ? false : values.color || forced || (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
const ascii = Boolean(values.ascii);
const showEnded = !values['hide-ended'];
const showArchived = Boolean(values['show-archived']);

if (values.serve) {
  const host = values.host ?? '127.0.0.1';
  /** @type {import('../src/serve.js').Served} */
  let served;
  try {
    served = await serve(monitor, {
      host, port, token: values.token, intervalMs, ascii, agents, showEnded, showArchived, bell: Boolean(values.bell), view,
      log: (line) => process.stdout.write(`${line}\n`),
    });
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    const why = err.code === 'EADDRINUSE' ? `port ${port} is in use: try another --port, or --port 0 for any free one` : `cannot listen on ${host} port ${port}: ${err.message}`;
    process.stderr.write(`agentmonitor: ${why}\n`);
    process.exit(1);
  }
  process.stdout.write(banner(host, urls(host, served.port, served.token), { color, ascii, windows: process.platform === 'win32' }));
  await new Promise((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, resolve);
  });
  await served.close();
  process.exit(0);
}

if (interactive) {
  await runTui(monitor, {
    intervalMs, color, ascii, bell: Boolean(values.bell), agents, showEnded, showArchived, view, mouse: !values['no-mouse'],
  });
  process.exit(0);
}

const snap = await monitor.refresh();
if (values.json) {
  // The events, the tool calls and turns, and the usage's samples are many and long: the views
  // draw them (and what a point came to at each, which a snapshot printed once has not read). So
  // are the drops, gone in half a minute, and the folders of the sessions not listed.
  const left = new Set(['events', 'calls', 'turns', 'history', 'perPoint', 'drops', 'cwds']);
  process.stdout.write(JSON.stringify(snap, (k, v) => (left.has(k) ? undefined : v), 2) + '\n');
} else {
  const width = process.stdout.columns || Number(process.env.COLUMNS) || 160;
  process.stdout.write(table(snap, { width, now: snap.at, agents, showEnded, showArchived }, makeTheme({ color, ascii, animate: false })));
}
