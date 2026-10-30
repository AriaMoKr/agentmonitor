#!/usr/bin/env node
// agentmonitor: the Claude agents running on this computer, and the ones active lately, live in
// a terminal. Run it with --help for the options; README.md says what it reads and shows.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseDuration } from '../src/format.js';
import { Monitor } from '../src/monitor.js';
import { runTui } from '../src/tui.js';
import { AGENTS_SHOWN, makeTheme, table } from '../src/view.js';

const HELP = `Usage: agentmonitor [options]

Shows the Claude Code sessions on this computer (in a terminal, the desktop app,
an IDE or the background) that are running or were active lately, with what
each is doing, and the subagents and workflows they started. Live in a
terminal; printed once when the output is not one.

Options:
  -s, --since <time>     how far back "recently active" reaches (default 24h)
  -i, --interval <time>  how often to read everything again (default 1s)
  -a, --agents <which>   agents listed under their session: running (default),
                         all, or none
  -e, --hide-ended       list only the sessions that run
  -1, --once             print the table once and exit
      --json             print what was found as JSON and exit
      --dir <path>       Claude Code's config folder (default: $CLAUDE_CONFIG_DIR,
                         else ~/.claude)
      --bell             ring the bell when a session starts waiting for you,
                         or finishes its turn
      --ascii            draw with ASCII only
      --color, --no-color  colors on or off (default: on in a terminal,
                         off with NO_COLOR set)
  -v, --version
  -h, --help

Times: 30s, 5m, 2h, 1d, 1w.
Keys: arrows move, Enter shows details, / filters, s sorts, e hides ended,
a cycles agents, w cycles the window, ? help, q quits.
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
      once: { type: 'boolean', short: '1' },
      json: { type: 'boolean' },
      dir: { type: 'string' },
      bell: { type: 'boolean' },
      ascii: { type: 'boolean' },
      color: { type: 'boolean' },
      'no-color': { type: 'boolean' },
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

const dir = resolve(values.dir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')));
const monitor = new Monitor({ dir, windowMs });
const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY) && !values.once && !values.json;
const forced = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0';
const color = values['no-color'] ? false : values.color || forced || (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
const ascii = Boolean(values.ascii);

if (interactive) {
  await runTui(monitor, { intervalMs, color, ascii, bell: Boolean(values.bell), agents, showEnded: !values['hide-ended'] });
  process.exit(0);
}

const snap = await monitor.refresh();
if (values.json) {
  // The events are many and long; the details view shows them.
  process.stdout.write(JSON.stringify(snap, (k, v) => (k === 'events' ? undefined : v), 2) + '\n');
} else {
  const width = process.stdout.columns || Number(process.env.COLUMNS) || 160;
  process.stdout.write(table(snap, { width, now: snap.at, agents, showEnded: !values['hide-ended'] }, makeTheme({ color, ascii, animate: false })));
}
