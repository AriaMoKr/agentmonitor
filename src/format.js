// Text and numbers for the monitor's screen: terminal-safe one-line strings, their width in
// columns, fitting them to a column, and short forms of durations, sizes, token counts, model
// names, the way a session was started and the tool call an agent is in.

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;
// C0 and C1 controls, DEL, the line and paragraph separators and the bidi overrides and isolates.
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g;

/**
 * One line of text that is safe to print: escape sequences and control characters taken out
 * (transcripts hold whatever the tools printed), runs of whitespace made one space.
 * @param {unknown} value
 * @returns {string}
 */
export function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(ANSI, '').replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u;
// East Asian Wide and Fullwidth blocks (the emoji are found by EMOJI).
const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18cff],
  [0x1b000, 0x1b2ff], [0x1f200, 0x1f2ff], [0x20000, 0x3fffd],
];

/**
 * The columns one grapheme takes in a terminal: 0 for marks and format characters, 2 for
 * emoji and East Asian wide characters, else 1.
 * @param {string} g
 */
function graphemeWidth(g) {
  const cp = /** @type {number} */ (g.codePointAt(0));
  if (cp >= 0x20 && cp < 0x7f) return 1;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (ZERO_WIDTH.test(g)) return 0;
  if (EMOJI.test(g)) return 2;
  for (const [lo, hi] of WIDE) {
    if (cp < lo) break;
    if (cp <= hi) return 2;
  }
  return 1;
}

/**
 * `s` as its graphemes, each with the columns it takes in a terminal.
 * @param {string} s
 * @returns {[string, number][]}
 */
export function graphemes(s) {
  return Array.from(segmenter.segment(s), ({ segment }) => /** @type {[string, number]} */ ([segment, graphemeWidth(segment)]));
}

/**
 * The columns `s` takes in a terminal.
 * @param {string} s
 */
export function width(s) {
  if (PRINTABLE_ASCII.test(s)) return s.length;
  let w = 0;
  for (const { segment } of segmenter.segment(s)) w += graphemeWidth(segment);
  return w;
}

/**
 * `s` cut to at most `cols` columns, ending in `ellipsis` when cut.
 * @param {string} s
 * @param {number} cols
 * @param {string} [ellipsis]
 */
export function truncate(s, cols, ellipsis = '…') {
  if (cols <= 0) return '';
  if (width(s) <= cols) return s;
  const room = cols - width(ellipsis);
  if (room < 0) return '';
  if (PRINTABLE_ASCII.test(s)) return s.slice(0, room) + ellipsis;
  let out = '';
  let used = 0;
  for (const { segment } of segmenter.segment(s)) {
    const w = graphemeWidth(segment);
    if (used + w > room) break;
    out += segment;
    used += w;
  }
  return out + ellipsis;
}

/**
 * `s` in exactly `cols` columns: cut with an ellipsis, or padded with spaces on the right
 * (align 'left') or the left (align 'right').
 * @param {string} s
 * @param {number} cols
 * @param {'left' | 'right'} [align]
 * @param {string} [ellipsis]
 */
export function fit(s, cols, align = 'left', ellipsis = '…') {
  if (cols <= 0) return '';
  const t = truncate(s, cols, ellipsis);
  const pad = ' '.repeat(Math.max(0, cols - width(t)));
  return align === 'right' ? pad + t : t + pad;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** @type {Record<string, number>} */
const UNITS = { ms: 1, s: SECOND, m: MINUTE, h: HOUR, d: DAY, w: 7 * DAY };

/**
 * How long ago, in one short unit: 'now', '42s', '5m', '3h' (up to 47h), '2d'.
 * @param {number} ms
 */
export function ago(ms) {
  if (!Number.isFinite(ms) || ms < SECOND) return 'now';
  const s = Math.floor(ms / SECOND);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * A duration in two units: '42s', '3m05s', '1h02m', '2d03h'.
 * @param {number} ms
 */
export function elapsed(ms) {
  const s = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / SECOND) : 0;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`;
}

/**
 * Milliseconds from '90s', '30m', '2h', '1.5d', '1w' or '500ms'; a bare number is seconds.
 * @param {string} text
 */
export function parseDuration(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?\s*$/i.exec(String(text));
  if (!m) throw new Error(`not a duration: '${text}' (try 30s, 5m, 2h or 1d)`);
  return Math.round(Number(m[1]) * UNITS[(m[2] || 's').toLowerCase()]);
}

/**
 * A window's length as it was likely written: '30m', '6h', '24h', '7d'.
 * @param {number} ms
 */
export function durationLabel(ms) {
  if (ms >= 2 * DAY && ms % DAY === 0) return `${ms / DAY}d`;
  if (ms >= HOUR && ms % HOUR === 0) return `${ms / HOUR}h`;
  if (ms >= MINUTE && ms % MINUTE === 0) return `${ms / MINUTE}m`;
  return `${Math.round(ms / SECOND)}s`;
}

/** @param {number} x */
const oneDecimal = (x) => x.toFixed(1).replace(/\.0$/, '');

/**
 * A token count in at most four characters: '950', '9.5k', '112k', '1.2M'; '' for none.
 * @param {number | undefined} n
 */
export function tokens(n) {
  if (!n || !Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return String(Math.round(n));
  if (n < 9950) return `${oneDecimal(n / 1000)}k`;
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  if (n < 9_950_000) return `${oneDecimal(n / 1e6)}M`;
  return `${Math.round(n / 1e6)}M`;
}

/**
 * A file size: '512 B', '822 KB', '53.1 MB'.
 * @param {number} n
 */
export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${oneDecimal(n / 1024 ** 2)} MB`;
  return `${oneDecimal(n / 1024 ** 3)} GB`;
}

/**
 * A model ID made short: 'claude-opus-5-5' → 'opus 5.5', 'claude-sonnet-4-5-20250929' →
 * 'sonnet 4.5', a Bedrock ID likewise; any other model as it is. '' for Claude Code's
 * '<synthetic>' messages.
 * @param {string | undefined} model
 */
export function shortModel(model) {
  if (!model || model === '<synthetic>') return '';
  let s = String(model)
    .replace(/^(?:.*[./])?claude-/, '')
    .replace(/-\d{8}(?:-v\d+(?::\d+)?)?$/, '')
    .replace(/\[1m\]$/i, ' 1M');
  s = s.replace(/^([a-z]+)-(\d+)-(\d+)(?=$| )/, '$1 $2.$3').replace(/^([a-z]+)-(\d+)(?=$| )/, '$1 $2');
  return clean(s);
}

/**
 * How a session was started, from its registry record or transcript: 'desktop' (the Claude
 * app's Code tab), 'vscode', 'cli' (a terminal), 'sdk', or 'bg' for a background session.
 * @param {{ entrypoint?: string, kind?: string }} s
 */
export function kindLabel({ entrypoint, kind }) {
  if (kind && kind !== 'interactive') return 'bg';
  switch (entrypoint) {
    case undefined:
    case '':
      return '';
    case 'claude-desktop':
    case 'claude-desktop-3p':
    case 'local-agent':
      return 'desktop';
    case 'claude-vscode':
      return 'vscode';
    case 'cli':
      return 'cli';
    case 'sdk-cli':
    case 'sdk-ts':
    case 'sdk-py':
      return 'sdk';
    default:
      return clean(entrypoint).replace(/^claude-/, '');
  }
}

/**
 * The last part of a path written on any system: 'C:\\git\\my\\pv' → 'pv'.
 * @param {string | undefined} path
 */
export function lastPart(path) {
  if (!path) return '';
  const parts = String(path).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(path);
}

/**
 * `path` relative to `base` when it is inside it (any case on Windows), else as it is.
 * @param {string | undefined} path
 * @param {string | undefined} base
 */
export function relativeTo(path, base) {
  if (!path) return '';
  if (!base) return path;
  const norm = (/** @type {string} */ p) => p.replace(/[\\/]+$/, '');
  const b = norm(base);
  const windows = /^[a-z]:[\\/]/i.test(b) || b.startsWith('\\\\');
  const head = path.slice(0, b.length);
  const same = windows ? head.toLowerCase() === b.toLowerCase() : head === b;
  if (same && /^[\\/]/.test(path.slice(b.length))) return path.slice(b.length + 1);
  return path;
}

/**
 * The first line of the first string a tool's input holds (for tools this file does not know).
 * @param {Record<string, unknown>} input
 */
function firstString(input) {
  for (const v of Object.values(input)) if (typeof v === 'string' && v.trim()) return v;
  return '';
}

/**
 * A tool's name made short: MCP tools ('mcp__server__tool') as 'server:tool', without a
 * server that is only an ID.
 * @param {string} name
 */
export function toolName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return clean(name);
  const server = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(m[1]) ? '' : `${m[1]}:`;
  return clean(server + m[2]);
}

/**
 * A tool call in one line: the tool and what it works on, as 'Bash: npm test',
 * 'Edit: src/a.js', 'Agent: Explore: find the parser'.
 * @param {string} name
 * @param {unknown} input
 * @param {string} [cwd] paths inside it are shown relative to it
 */
export function toolSummary(name, input, cwd) {
  const i = /** @type {Record<string, any>} */ (input && typeof input === 'object' ? input : {});
  const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '');
  let detail = '';
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      detail = str(i.description) || str(i.command);
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      detail = relativeTo(str(i.file_path) || str(i.notebook_path), cwd);
      break;
    case 'Grep':
      detail = str(i.pattern) + (i.path ? ` in ${relativeTo(str(i.path), cwd)}` : '');
      break;
    case 'Glob':
      detail = str(i.pattern);
      break;
    case 'WebFetch':
      detail = str(i.url);
      break;
    case 'WebSearch':
    case 'ToolSearch':
      detail = str(i.query);
      break;
    case 'Agent':
    case 'Task':
      detail = [str(i.subagent_type), str(i.description)].filter(Boolean).join(': ');
      break;
    case 'Workflow':
      detail = str(i.name) || /\bname:\s*['"]([^'"]+)['"]/.exec(str(i.script))?.[1] || lastPart(str(i.scriptPath));
      break;
    case 'Skill':
      detail = str(i.skill);
      break;
    case 'TodoWrite':
      detail = 'the to-do list';
      break;
    default:
      detail = firstString(i);
  }
  const label = toolName(name);
  detail = clean(detail);
  return detail ? `${label}: ${detail}` : label;
}

/** @param {number} n */
const two = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A moment as local time: 'HH:MM:SS' on the day of `now`, else 'Mon DD HH:MM'.
 * @param {number} ts
 * @param {number} now
 */
export function clock(ts, now) {
  if (!ts) return '';
  const d = new Date(ts);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) {
    return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  }
  return `${MONTHS[d.getMonth()]} ${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
