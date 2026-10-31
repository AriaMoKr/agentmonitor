// The Claude desktop app's records of its Code tab sessions:
// claude-code-sessions/<account>/<org>/local_<id>.json in the app's data folder, with the
// session's title, whether it is archived, its model, effort and permission mode, and when it was
// last opened and its last turn started or ended: from those, which ones the app shows as unread.
// Keyed here by the Claude Code session ID (cliSessionId) they run.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { entries, JsonFiles } from './files.js';

/** The most openings of sessions remembered. */
const MAX_OPENINGS = 10_000;

/**
 * @typedef {object} DesktopSession
 * @property {string} id the app's ID: 'local_<uuid>'
 * @property {string} cliSessionId
 * @property {string} [title]
 * @property {string} [cwd]
 * @property {boolean} archived
 * @property {string} [model]
 * @property {string} [effort]
 * @property {string} [permissionMode]
 * @property {number} [createdAt]
 * @property {number} [lastActivityAt]
 * @property {number} [openedAt] when it was last opened in the app (lastFocusedAt)
 * @property {number} [turnEdgeAt] when a turn last started or ended (lastTurnEdgeAt)
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
    this.noteOpenings(all);
    this.byCliSession = byCliSession;
    return byCliSession;
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

/**
 * @param {Record<string, any>} o
 * @returns {DesktopSession | null}
 */
export function toDesktopSession(o) {
  const str = (/** @type {unknown} */ v) => (typeof v === 'string' && v ? v : undefined);
  const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const cliSessionId = str(o.cliSessionId);
  if (!cliSessionId) return null;
  return {
    id: str(o.sessionId) ?? '',
    cliSessionId,
    title: str(o.title),
    cwd: str(o.cwd),
    archived: o.isArchived === true,
    model: str(o.model),
    effort: str(o.effort),
    permissionMode: str(o.permissionMode),
    createdAt: num(o.createdAt),
    lastActivityAt: num(o.lastActivityAt),
    openedAt: num(o.lastFocusedAt),
    turnEdgeAt: num(o.lastTurnEdgeAt),
  };
}
