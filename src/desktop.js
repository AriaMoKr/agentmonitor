// The Claude desktop app's records of its Code tab sessions:
// claude-code-sessions/<account>/<org>/local_<id>.json in the app's data folder, with the
// session's title, whether it is archived, its model, effort and permission mode, whether
// ultracode is on, the app's summary of its last turn, and when it was last opened and its last
// turn started or ended: from those, which ones the app shows as unread. Keyed here by the Claude
// Code session ID (cliSessionId) they run, and by those they ran before it (priorCliSessionIds): a
// session can go on in a new one, after a rewind say.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { entries, JsonFiles } from './files.js';

/** The most openings of sessions remembered. */
const MAX_OPENINGS = 10_000;

/**
 * @typedef {object} TurnSummary the app's summary of a session's last turn (postTurnSummary),
 *   written a few seconds after the turn ended, and not after every one
 * @property {string} category 'completed', 'blocked' (on something only the user can do),
 *   'review_ready'...
 * @property {string} detail what the turn came to, in a few words
 * @property {string} [needs] what the user is to do, when it is blocked
 * @property {string} [for] the uuid of the transcript record it sums up: the turn's last
 *
 * @typedef {object} DesktopSession
 * @property {string} id the app's ID: 'local_<uuid>'
 * @property {string} cliSessionId
 * @property {string} [title]
 * @property {string} [cwd]
 * @property {boolean} archived
 * @property {string} [model]
 * @property {string} [effort]
 * @property {string} [permissionMode]
 * @property {boolean} [ultracode] whether ultracode is on for it (sessionSettings.ultracode);
 *   undefined when the app keeps no settings for it: none set, or a session started elsewhere
 * @property {number} [createdAt]
 * @property {number} [lastActivityAt]
 * @property {number} [openedAt] when it was last opened in the app (lastFocusedAt)
 * @property {number} [turnEdgeAt] when a turn last started or ended (lastTurnEdgeAt)
 * @property {TurnSummary} [summary]
 * @property {string[]} prior the Claude Code sessions it ran before its current one
 *   (priorCliSessionIds)
 * @property {{ parent: string, at: number }[]} rewinds when it was rewound, and from which of
 *   them (rewindEdges)
 *
 * @typedef {object} EarlierRun a Claude Code session that a desktop app session ran before its
 *   current one
 * @property {DesktopSession} session
 * @property {number} [rewoundAt] when the session was rewound from it, if it was
 */

/**
 * The app's data folders that may hold its sessions on this platform: %APPDATA%\Claude and the
 * Microsoft Store app's %LOCALAPPDATA%\Claude-Data\claude_<publisher>\ on Windows,
 * ~/Library/Application Support/Claude on macOS, ~/.config/Claude elsewhere.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @returns {Promise<string[]>}
 */
export async function desktopDataDirs(env = process.env, platform = process.platform) {
  const home = homedir();
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const store = join(local, 'Claude-Data');
    const packaged = (await entries(store)).filter((e) => e.isDirectory()).map((e) => join(store, e.name));
    return [join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude'), ...packaged];
  }
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support', 'Claude')];
  return [join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude')];
}

export class DesktopSessions {
  /** @param {() => Promise<string[]>} dirs the app's data folders, looked up on each read */
  constructor(dirs) {
    this.dirs = dirs;
    this.files = new JsonFiles();
    /** @type {Map<string, DesktopSession>} */
    this.byCliSession = new Map();
    /** @type {Map<string, EarlierRun>} */
    this.byPriorRun = new Map();
    this.readAt = -Infinity;
    /**
     * @type {{ id: string, at: number }[]} the openings of sessions in the app, oldest first: a
     * record keeps only its last, so those seen before are remembered here
     */
    this.openings = [];
  }

  /**
   * The sessions by Claude Code session ID, read again at most every `maxAgeMs`.
   * @param {number} now
   * @param {number} [maxAgeMs]
   */
  async read(now, maxAgeMs = 5000) {
    if (now - this.readAt < maxAgeMs) return this.byCliSession;
    this.readAt = now;
    /** @type {string[]} */
    const paths = [];
    for (const base of await this.dirs()) {
      const root = join(base, 'claude-code-sessions');
      for (const account of await entries(root)) {
        if (!account.isDirectory()) continue;
        for (const org of await entries(join(root, account.name))) {
          if (!org.isDirectory()) continue;
          const dir = join(root, account.name, org.name);
          for (const f of await entries(dir)) if (f.isFile() && /^local_.+\.json$/.test(f.name)) paths.push(join(dir, f.name));
        }
      }
    }
    const raws = await Promise.all(paths.map((p) => this.files.read(p)));
    this.files.sweep();
    /** @type {Map<string, DesktopSession>} */
    const byCliSession = new Map();
    /** @type {DesktopSession[]} */
    const all = [];
    for (const o of raws) {
      const s = o && typeof o === 'object' ? toDesktopSession(o) : null;
      if (!s) continue;
      all.push(s);
      const known = byCliSession.get(s.cliSessionId);
      if (!known || (s.lastActivityAt ?? 0) > (known.lastActivityAt ?? 0)) byCliSession.set(s.cliSessionId, s);
    }
    /** @type {Map<string, EarlierRun>} */
    const byPriorRun = new Map();
    for (const s of all) {
      for (const id of s.prior) {
        const known = byPriorRun.get(id)?.session;
        if (known && (known.lastActivityAt ?? 0) >= (s.lastActivityAt ?? 0)) continue;
        const rewound = s.rewinds.filter((r) => r.parent === id).map((r) => r.at);
        byPriorRun.set(id, { session: s, rewoundAt: rewound.length ? Math.min(...rewound) : undefined });
      }
    }
    this.noteOpenings(all);
    this.byCliSession = byCliSession;
    this.byPriorRun = byPriorRun;
    return byCliSession;
  }

  /**
   * The desktop app session that ran this Claude Code session before its current one, as last
   * read.
   * @param {string} cliSessionId
   * @returns {EarlierRun | undefined}
   */
  earlierRun(cliSessionId) {
    return this.byPriorRun.get(cliSessionId);
  }

  /**
   * Adds the openings the records show to those seen before.
   * @param {DesktopSession[]} sessions
   */
  noteOpenings(sessions) {
    const seen = new Set(this.openings.map((o) => `${o.id} ${o.at}`));
    let added = false;
    for (const s of sessions) {
      if (s.openedAt === undefined || seen.has(`${s.id} ${s.openedAt}`)) continue;
      this.openings.push({ id: s.id, at: s.openedAt });
      added = true;
    }
    if (!added) return;
    this.openings.sort((a, b) => a.at - b.at);
    if (this.openings.length > MAX_OPENINGS) this.openings.splice(0, this.openings.length - MAX_OPENINGS);
  }

  /**
   * The session open in the app at `at`, as far as the openings seen tell: the last one opened.
   * @param {number} at
   * @returns {string | undefined}
   */
  openAt(at) {
    // The first opening after `at`; the one before it was open.
    let lo = 0;
    let hi = this.openings.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.openings[mid].at <= at) lo = mid + 1;
      else hi = mid;
    }
    return this.openings[lo - 1]?.id;
  }

  /**
   * Whether the app shows a session as unread (its blue dot): its last turn ended after it was
   * last opened, while another session was open. For a session not at work, whose last turn edge
   * is its end. The app keeps its own list, with the dots set by hand, where the monitor does not
   * read; and of the openings before the monitor started it knows only each session's last.
   * @param {DesktopSession} s
   */
  unread(s) {
    const end = s.turnEdgeAt ?? s.lastActivityAt;
    if (s.archived || end === undefined || (s.openedAt ?? -Infinity) >= end) return false;
    return this.openAt(end) !== s.id;
  }
}

const str = (/** @type {unknown} */ v) => (typeof v === 'string' && v ? v : undefined);
const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * @param {Record<string, any>} o
 * @returns {DesktopSession | null}
 */
export function toDesktopSession(o) {
  const cliSessionId = str(o.cliSessionId);
  if (!cliSessionId) return null;
  const settings = o.sessionSettings && typeof o.sessionSettings === 'object' ? o.sessionSettings : undefined;
  return {
    id: str(o.sessionId) ?? '',
    cliSessionId,
    title: str(o.title),
    cwd: str(o.cwd),
    archived: o.isArchived === true,
    model: str(o.model),
    effort: str(o.effort),
    permissionMode: str(o.permissionMode),
    ultracode: settings ? settings.ultracode === true : undefined,
    createdAt: num(o.createdAt),
    lastActivityAt: num(o.lastActivityAt),
    openedAt: num(o.lastFocusedAt),
    turnEdgeAt: num(o.lastTurnEdgeAt),
    summary: summaryOf(o),
    prior: Array.isArray(o.priorCliSessionIds) ? o.priorCliSessionIds.filter((id) => str(id) && id !== cliSessionId) : [],
    rewinds: Array.isArray(o.rewindEdges)
      ? o.rewindEdges.flatMap((e) => {
        const parent = str(e?.parent);
        const at = num(e?.at);
        return parent && at !== undefined ? [{ parent, at }] : [];
      })
      : [],
  };
}

/**
 * The app's summary of a session's last turn, when it says anything.
 * @param {Record<string, any>} o the session's record
 * @returns {TurnSummary | undefined}
 */
function summaryOf(o) {
  const p = o.postTurnSummary;
  if (!p || typeof p !== 'object') return undefined;
  const detail = str(p.status_detail);
  const needs = str(p.needs_action);
  if (!detail && !needs) return undefined;
  return { category: str(p.status_category) ?? '', detail: detail ?? '', needs, for: str(p.summarizes_uuid) ?? str(o.postTurnSummaryFor) };
}
