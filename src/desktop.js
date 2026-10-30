// The Claude desktop app's records of its Code tab sessions:
// claude-code-sessions/<account>/<org>/local_<id>.json in the app's data folder, with the
// session's title, whether it is archived, its model, effort and permission mode. Keyed here by
// the Claude Code session ID (cliSessionId) they run.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { entries, JsonFiles } from './files.js';

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
    for (const o of raws) {
      const s = o && typeof o === 'object' ? toDesktopSession(o) : null;
      if (!s) continue;
      const known = byCliSession.get(s.cliSessionId);
      if (!known || (s.lastActivityAt ?? 0) > (known.lastActivityAt ?? 0)) byCliSession.set(s.cliSessionId, s);
    }
    this.byCliSession = byCliSession;
    return byCliSession;
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
  };
}
