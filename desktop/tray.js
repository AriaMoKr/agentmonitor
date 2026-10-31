// What the agentmonitor app's tray icon says of a snapshot: the glyph of what matters most (a
// session that needs you, a turn ended unread, one at work, one waiting on what it left running
// in the background, all idle, none running), its tooltip, the sessions its menu lists, and what
// is worth a notification. Pure, so the tests can tell; main.js shows it with Electron.
import { clean, truncate } from '../src/format.js';
import { makeTheme, shown, usageParts } from '../src/view.js';
import { ringing } from '../src/viewer.js';

/**
 * @typedef {import('../src/monitor.js').Agent} Agent
 * @typedef {import('../src/monitor.js').Snapshot} Snapshot
 * @typedef {import('./icons.js').Level} Level
 */

/** Text with no styles: the glyphs, and the usage in words. */
const plain = makeTheme({ color: false, ascii: false, animate: false });

/** How many sessions the menu lists at most. */
const MAX_LISTED = 8;
/** How many notifications one read makes at most: more, and one says how many. */
const MAX_NOTICES = 3;
/** The most a Windows tooltip holds. */
const MAX_TOOLTIP = 127;

/**
 * @typedef {object} TrayState
 * @property {Level} level what matters most: the tray icon's glyph
 * @property {number} needs how many sessions need you: waiting for you, or blocked
 * @property {string} counts the sessions by what they show: '1 needs you, 3 at work, 5 idle'
 * @property {string} usage the plan's usage as the list's first line says it; '' when none
 * @property {string} tooltip
 * @property {{ key: string, label: string }[]} listed those that need you, then those unread,
 *   the latest first: a glyph, the title and the project
 */

/**
 * What the tray says of `snap`.
 * @param {Snapshot} snap
 * @param {number} now
 * @returns {TrayState}
 */
export function trayState(snap, now) {
  let [needs, unread, work, background, idle] = [0, 0, 0, 0, 0];
  /** @type {Agent[]} */
  const listed = [];
  for (const r of snap.rows) {
    const s = shown(r);
    if (s === 'waiting' || s === 'blocked') needs++;
    else if (s === 'unread') unread++;
    else if (s === 'working' || s === 'tool' || s === 'active') work++;
    else if (s === 'background') background++;
    else if (s === 'idle') idle++;
    if (s === 'waiting' || s === 'blocked' || s === 'unread') listed.push(r);
  }
  /** @type {Level} */
  const level = needs ? 'waiting' : unread ? 'unread' : work ? 'working' : background ? 'background' : idle ? 'idle' : 'none';
  const counts = [
    needs && `${needs} need${needs === 1 ? 's' : ''} you`, unread && `${unread} unread`, work && `${work} at work`,
    background && `${background} in the background`, idle && `${idle} idle`,
  ].filter(Boolean).join(', ') || 'none running';
  // As the list's first line has it: a reset after its percent, the parts apart.
  const usage = usageParts(snap.usage, now, plain).map(([s, , of], i) => (i ? (of ? ' ' : plain.sep) : '') + s).join('');
  const needsFirst = (/** @type {Agent} */ a) => (shown(a) === 'unread' ? 1 : 0);
  return {
    level,
    needs,
    counts,
    usage,
    tooltip: `Claude agents: ${counts}${usage ? `\n${usage}` : ''}`.slice(0, MAX_TOOLTIP),
    listed: listed
      .sort((a, b) => needsFirst(a) - needsFirst(b) || b.lastActive - a.lastActive)
      .slice(0, MAX_LISTED)
      .map((a) => ({
        key: a.key,
        label: `${plain.glyphs[shown(a)]} ${truncate(clean(a.title) || 'untitled', 60)}${a.project ? `${plain.sep}${truncate(clean(a.project), 24)}` : ''}`,
      })),
  };
}

/** @typedef {{ title: string, body: string }} Notice a notification's text */

/**
 * What is worth a notification in `snap`, as the bell rings for it: each session that started
 * waiting for you or ended its turn since `before` (each session's state as last seen), with what
 * it is doing or what it came to. More than three at once, one notice says how many.
 * @param {Map<string, string>} before
 * @param {Snapshot} snap
 * @returns {Notice[]}
 */
export function notices(before, snap) {
  const rows = ringing(before, snap);
  if (rows.length > MAX_NOTICES) return [{ title: 'Claude agents', body: `${rows.length} sessions need you or ended their turn` }];
  return rows.map((r) => ({
    title: truncate(clean(r.title) || 'untitled', 64),
    body: truncate(clean(r.activity), 180) || (r.state === 'waiting' ? 'waits for you' : 'ended its turn'),
  }));
}

/**
 * Text for a menu item: one line; on Windows and Linux with an & doubled, which would else mark
 * the letter after it as the item's key.
 * @param {string} text
 * @param {string} platform as process.platform says it
 */
export function menuLabel(text, platform) {
  const s = clean(text);
  return platform === 'darwin' ? s : s.replace(/&/g, '&&');
}
