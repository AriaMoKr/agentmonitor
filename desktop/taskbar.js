// What the agentmonitor app shows on its taskbar button and beside it, of what the tray worked
// out: the plan's usage as the button's bar, how many sessions need you or the sessions by what
// they show as its overlay, a button for each session under its preview and the part of the
// window the preview shows, and the jump list of its sessions; where the tray's flyout opens; and
// the session a start of the app asks it to open. Pure, so the tests can tell; main.js shows it
// with Electron.
import { limitsOf, sessionEnd, weekPace } from '../src/view.js';

/**
 * @typedef {import('./tray.js').TrayState} TrayState
 * @typedef {import('./tray.js').Session} Session
 * @typedef {import('./tray.js').Shown} Shown
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How many buttons Windows puts under a window's preview at most. */
const MAX_BUTTONS = 7;
/** The most a jump list item's description holds: Windows leaves out an item with a longer one. */
const MAX_DESCRIPTION = 255;
/** A key the app can be started to open: a session's or an agent's, as the monitor makes them. */
const KEY = /^[a-z]:[A-Za-z0-9:._-]{1,200}$/;
/** What a start of the app asks it to open. */
const OPEN = '--open=';

/**
 * @typedef {object} Gauge the plan's usage as the taskbar button's bar: the limit used more
 * @property {number} v the percent used
 * @property {'normal' | 'paused' | 'error'} mode the bar's color, as Windows names them: green;
 *   yellow from 75%, or where at its pace it reaches 100% before it resets; red from 90%
 */

/**
 * The plan's usage as a bar: the session's limit or the week's, whichever is used more (the
 * week's on a tie), as the list shows it; colored as the list colors its percent, and yellow too
 * where at its pace it reaches 100% before it resets, as below the list. None without the
 * desktop app's samples.
 * @param {import('../src/usage.js').Usage | undefined} u
 * @param {number} now
 * @returns {Gauge | undefined}
 */
export function gaugeOf(u, now) {
  if (!u) return undefined;
  const { session, week } = limitsOf(u, now);
  /** @type {{ l: import('../src/view.js').Limit, end: number | undefined, pace: number | undefined, unit: number }[]} */
  const limits = [];
  if (session) limits.push({ l: session, end: sessionEnd(session.reset), pace: session.pace, unit: HOUR });
  if (week) {
    const r = week.reset;
    const end = r && r.to - r.from <= 12 * HOUR ? r.at : undefined;
    limits.push({ l: week, end, pace: end === undefined ? undefined : weekPace(u, week, end, now), unit: DAY });
  }
  if (!limits.length) return undefined;
  const { l, end, pace, unit } = limits.reduce((a, b) => (b.l.v >= a.l.v ? b : a));
  const short = end !== undefined && pace !== undefined && pace > 0 && l.v < 100 && now + ((100 - l.v) / pace) * unit < end;
  return { v: l.v, mode: l.v >= 90 ? 'error' : l.v >= 75 || short ? 'paused' : 'normal' };
}

/**
 * @typedef {{ count: number, says: string } | { parts: [Shown, number][], says: string }} Overlay
 *   the taskbar button's overlay: how many need you, or the sessions by what they show, round
 *   from the top; and what it says in words, for a screen reader
 */

/**
 * The overlay on the taskbar button: how many sessions need you, while any does; else, while any
 * is unread, at work or in the background, the sessions as a ring by what they show; none while
 * all are idle.
 * @param {TrayState} state
 * @returns {Overlay | undefined}
 */
export function overlayOf(state) {
  const t = state.tally;
  if (t.waiting) return { count: t.waiting, says: `${t.waiting} need${t.waiting === 1 ? 's' : ''} you` };
  if (!t.unread && !t.working && !t.background) return undefined;
  return { parts: [['unread', t.unread], ['working', t.working], ['background', t.background], ['idle', t.idle]], says: state.counts };
}

/** A session's title and project, one line. @param {Session} s */
const named = (s) => `${s.title}${s.project ? ` · ${s.project}` : ''}`;

/** What a session shows, in words, for one with nothing said of what it does. @type {Record<Shown, string>} */
const WORDS = { waiting: 'needs you', unread: 'ended its turn', working: 'at work', background: 'waits on what it left running', idle: 'idle' };

/**
 * What a session does, for text that stays a while (a tooltip, the jump list): what it waits for
 * or came to, as it says; for one at work, which says something new every few seconds, that it is
 * at work, so that the text is not written again each time.
 * @param {Session} s
 */
const says = (s) => (s.level === 'working' ? WORDS.working : s.activity || WORDS[s.level]);

/**
 * The buttons under the window's preview on the taskbar, a session each, seven at most: those
 * that need you first, then those unread, at work and in the background; none for those idle.
 * Each with its glyph, and as its tooltip its title, project and what it does.
 * @param {TrayState} state
 * @returns {{ key: string, level: Shown, tooltip: string }[]}
 */
export function buttonsOf(state) {
  return state.sessions
    .filter((s) => s.level !== 'idle')
    .slice(0, MAX_BUTTONS)
    .map((s) => ({ key: s.key, level: s.level, tooltip: `${named(s)}: ${says(s)}` }));
}

/**
 * @typedef {object} JumpItem a session in the jump list
 * @property {string} key what the app is started to open: --open=<key>
 * @property {Shown} level its glyph
 * @property {string} title its title and project
 * @property {string} description what it does, the item's tooltip
 */

/**
 * The jump list's sessions: a category for those that need you, one for those unread, one for
 * those at work or in the background, each the latest first; as many in all as `most` (as many
 * as Windows shows at least), those that matter most first. None for those idle, nor for one
 * whose key a start of the app could not take.
 * @param {TrayState} state
 * @param {number} most
 * @returns {{ name: string, items: JumpItem[] }[]}
 */
export function jumpListOf(state, most) {
  let room = Math.max(0, most);
  /** @type {[string, Shown[]][]} */
  const categories = [['Needs you', ['waiting']], ['Unread', ['unread']], ['At work', ['working', 'background']]];
  return categories
    .map(([name, levels]) => {
      const items = state.sessions
        .filter((s) => levels.includes(s.level) && KEY.test(s.key))
        .slice(0, room)
        .map((s) => ({ key: s.key, level: s.level, title: units(named(s), 100), description: units(says(s), MAX_DESCRIPTION) }));
      room -= items.length;
      return { name, items };
    })
    .filter((c) => c.items.length);
}

/**
 * At most `n` UTF-16 units of `s`, as Windows counts a string's length, an ellipsis last where it
 * is cut; never a character cut in two.
 * @param {string} s
 * @param {number} n
 */
export function units(s, n) {
  if (s.length <= n) return s;
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > n - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/**
 * The switch that starts the app to open a session in its window.
 * @param {string} key
 */
export const openSwitch = (key) => `${OPEN}${key}`;

/**
 * The session or agent a start of the app asks it to open, by its key: --open=<key>, as the jump
 * list's items start it. Undefined where none is asked, or what is asked is not a key.
 * @param {string[]} argv
 * @returns {string | undefined}
 */
export function openArg(argv) {
  for (const a of argv) {
    if (a.startsWith(OPEN) && KEY.test(a.slice(OPEN.length))) return a.slice(OPEN.length);
  }
  return undefined;
}

/**
 * The part of the window its preview on the taskbar shows, for its text to be read there: the top
 * left, the list's first dozen lines with their names, as the page draws them at its zoom (type
 * of 14 pixels, 1.25 of it a line, about 0.6 of it a column, inside a margin of 8 and 6); all of
 * it, an empty region, where the window is no bigger than that.
 * @param {{ width: number, height: number }} content the window's content
 * @param {number} zoom the page's zoom level: each step of 1 a fifth bigger
 * @returns {Rect}
 */
export function thumbnailClip(content, zoom) {
  const z = 1.2 ** zoom;
  const width = Math.round((16 + 56 * 8.4) * z);
  const height = Math.round((12 + 12 * 17.5) * z);
  if (width >= content.width && height >= content.height) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: 0, y: 0, width: Math.min(width, content.width), height: Math.min(height, content.height) };
}

/**
 * Where the tray's flyout opens: against the edge of the screen's work area that the taskbar
 * holding the tray icon is on (the edge the icon is past, or nearest), as near the icon as it
 * fits; by the pointer where the icon's bounds are not known (on Linux). No bigger than the work
 * area, a margin from its edges.
 * @param {Rect} icon the tray icon's bounds; no width where they are not known
 * @param {Rect} area the work area of the screen it is on
 * @param {{ width: number, height: number }} size
 * @param {{ x: number, y: number }} pointer
 * @param {number} [margin]
 * @returns {Rect}
 */
export function flyoutBounds(icon, area, size, pointer, margin = 8) {
  const width = Math.max(0, Math.min(size.width, area.width - 2 * margin));
  const height = Math.max(0, Math.min(size.height, area.height - 2 * margin));
  const [cx, cy] = icon.width > 0 && icon.height > 0 ? [icon.x + icon.width / 2, icon.y + icon.height / 2] : [pointer.x, pointer.y];
  const gaps = { bottom: area.y + area.height - cy, top: cy - area.y, right: area.x + area.width - cx, left: cx - area.x };
  const side = /** @type {(keyof typeof gaps)[]} */ (['bottom', 'top', 'right', 'left']).reduce((a, b) => (gaps[b] < gaps[a] ? b : a));
  /** @param {number} v @param {number} lo @param {number} hi */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const [left, right] = [area.x + margin, area.x + area.width - width - margin];
  const [top, bottom] = [area.y + margin, area.y + area.height - height - margin];
  const x = side === 'left' ? left : side === 'right' ? right : clamp(cx - width / 2, left, right);
  const y = side === 'top' ? top : side === 'bottom' ? bottom : clamp(cy - height / 2, top, bottom);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
