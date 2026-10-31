// How much of the plan's usage limits is used, as the Claude desktop app samples it about every
// 15 minutes while it runs: plan-usage-history.json in its data folder, its samples in percent of
// the session's limit (a window of five hours) and of the week's. It keeps no reset times there.
import { join } from 'node:path';
import { JsonFiles } from './files.js';

/**
 * @typedef {object} Usage the app's latest sample
 * @property {number} at when it was taken (ms)
 * @property {number} [session] percent of the session's limit used: five hours (u.fh)
 * @property {number} [week] percent of the week's (u.sd: seven days)
 */

export class PlanUsage {
  /** @param {() => Promise<string[]>} dirs the app's data folders, looked up on each read */
  constructor(dirs) {
    this.dirs = dirs;
    this.files = new JsonFiles();
    this.readAt = -Infinity;
    /** @type {Usage | undefined} */
    this.usage = undefined;
  }

  /**
   * The latest sample in the app's folders, read again at most every `maxAgeMs`.
   * @param {number} now
   * @param {number} [maxAgeMs]
   * @returns {Promise<Usage | undefined>}
   */
  async read(now, maxAgeMs = 5000) {
    if (now - this.readAt < maxAgeMs) return this.usage;
    this.readAt = now;
    /** @type {Usage | undefined} */
    let latest;
    for (const dir of await this.dirs()) {
      const u = latestSample(await this.files.read(join(dir, 'plan-usage-history.json')));
      if (u && (!latest || u.at > latest.at)) latest = u;
    }
    this.files.sweep();
    this.usage = latest;
    return latest;
  }
}

const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const percent = (/** @type {unknown} */ v) => {
  const n = num(v);
  return n === undefined || n < 0 ? undefined : Math.round(n);
};

/**
 * The latest sample of those plan-usage-history.json holds: { version, samples: [{ t, org,
 * u: { fh, sd } }] }, with t in ms and fh and sd in percent; undefined when it has none.
 * @param {unknown} o the file, parsed
 * @returns {Usage | undefined}
 */
export function latestSample(o) {
  const samples = o && typeof o === 'object' && Array.isArray(/** @type {any} */ (o).samples) ? /** @type {any[]} */ (/** @type {any} */ (o).samples) : [];
  /** @type {Usage | undefined} */
  let latest;
  for (const s of samples) {
    const at = s && typeof s === 'object' ? num(s.t) : undefined;
    if (at === undefined || !s.u || typeof s.u !== 'object' || (latest && at <= latest.at)) continue;
    const session = percent(s.u.fh);
    const week = percent(s.u.sd);
    if (session === undefined && week === undefined) continue;
    latest = { at, ...(session !== undefined ? { session } : {}), ...(week !== undefined ? { week } : {}) };
  }
  return latest;
}
