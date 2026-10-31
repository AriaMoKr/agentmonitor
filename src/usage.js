// How much of the plan's usage limits is used, as the Claude desktop app samples it about every
// 15 minutes while it runs: plan-usage-history.json in its data folder, its samples in percent of
// the session's limit (a window of five hours) and of the week's. It keeps no reset times there, so
// they are worked out from the samples: the week's limit resets at the same time each week, where
// its percent dropped before, and the session's five hours after its percent began to rise.
import { join } from 'node:path';
import { JsonFiles } from './files.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SESSION = 5 * HOUR;
const WEEK = 7 * 24 * HOUR;
/** Samples further apart than this can hide a reset: the percent grown back past where it was. */
const GAP = 45 * MINUTE;

/**
 * @typedef {object} Usage the app's latest sample, and when the limits it measures reset
 * @property {number} at when it was taken (ms)
 * @property {number} [session] percent of the session's limit used: five hours (u.fh)
 * @property {number} [week] percent of the week's (u.sd: seven days)
 * @property {Reset} [sessionReset] when the session's limit resets
 * @property {Reset} [weekReset] when the week's resets
 */

/**
 * @typedef {object} Reset when a limit resets, as far as the samples tell (ms)
 * @property {number} at the likeliest time
 * @property {number} from the earliest it can be
 * @property {number} to the latest
 */

/** @typedef {{ t: number, v: number }} Point a sample's time and one of its percents */

export class PlanUsage {
  /** @param {() => Promise<string[]>} dirs the app's data folders, looked up on each read */
  constructor(dirs) {
    this.dirs = dirs;
    this.files = new JsonFiles();
    /** What each file's JSON tells, while the file is unchanged (and so its JSON the same object). @type {WeakMap<object, Usage | undefined>} */
    this.told = new WeakMap();
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
      const json = await this.files.read(join(dir, 'plan-usage-history.json'));
      if (!json || typeof json !== 'object') continue;
      if (!this.told.has(json)) this.told.set(json, usageOf(json));
      const u = this.told.get(json);
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
const mod = (/** @type {number} */ n, /** @type {number} */ m) => ((n % m) + m) % m;

/**
 * What plan-usage-history.json tells: { version, samples: [{ t, org, u: { fh, sd } }] }, with t in
 * ms and fh and sd in percent. Its latest sample, and when the limits reset, from the samples of
 * the same org; undefined when it has none.
 * @param {unknown} o the file, parsed
 * @returns {Usage | undefined}
 */
export function usageOf(o) {
  const raw = o && typeof o === 'object' && Array.isArray(/** @type {any} */ (o).samples) ? /** @type {any[]} */ (/** @type {any} */ (o).samples) : [];
  /** @type {{ t: number, org: unknown, session?: number, week?: number }[]} */
  const samples = [];
  for (const s of raw) {
    const t = s && typeof s === 'object' ? num(s.t) : undefined;
    if (t === undefined || !s.u || typeof s.u !== 'object') continue;
    const session = percent(s.u.fh);
    const week = percent(s.u.sd);
    if (session !== undefined || week !== undefined) samples.push({ t, org: s.org, session, week });
  }
  samples.sort((a, b) => a.t - b.t);
  const latest = samples.at(-1);
  if (!latest) return undefined;
  const mine = samples.filter((s) => s.org === latest.org);
  /** @param {'session' | 'week'} k @returns {Point[]} */
  const points = (k) => mine.flatMap((s) => (s[k] === undefined ? [] : [{ t: s.t, v: /** @type {number} */ (s[k]) }]));
  const sessionAt = latest.session !== undefined ? sessionReset(points('session')) : undefined;
  const weekAt = latest.week !== undefined ? weekReset(points('week')) : undefined;
  return {
    at: latest.t,
    ...(latest.session !== undefined ? { session: latest.session } : {}),
    ...(latest.week !== undefined ? { week: latest.week } : {}),
    ...(sessionAt ? { sessionReset: sessionAt } : {}),
    ...(weekAt ? { weekReset: weekAt } : {}),
  };
}

/**
 * When the session's limit resets: five hours after its window began, with the first use after
 * the last reset. That was about the last sample before its percent rose from 0 (the first use
 * reads 0% for a while), or between the two samples its percent dropped between (a reset, and a
 * new window), and by the first sample after either. Where the samples don't show it (the app was
 * not running then, or two samples are too far apart to be sure no reset came between), all that
 * is known is that it began within the five hours before the last sample. A window begun with
 * next to nothing used while the app was not running reads 0% when it starts again, and so seems
 * to begin later than it did. Undefined while the percent is 0: no window, or next to nothing
 * used in it.
 * @param {Point[]} p the session's percents, in time order
 * @returns {Reset | undefined}
 */
export function sessionReset(p) {
  const last = p.at(-1);
  if (!last || last.v <= 0) return undefined;
  let from = last.t - SESSION;
  let rose = false;
  let i = p.length - 1;
  for (; i > 0; i--) {
    const prev = p[i - 1];
    if (prev.t <= last.t - SESSION || p[i].t - prev.t > GAP) break;
    if (prev.v === 0 || prev.v > p[i].v) {
      from = prev.t;
      rose = prev.v === 0;
      break;
    }
  }
  const to = p[i].t;
  return { at: (rose ? from : (from + to) / 2) + SESSION, from: from + SESSION, to: to + SESSION };
}

/**
 * When the week's limit resets next after the last sample. It resets at the same time each week,
 * which shows where the percent dropped between two samples: the time of the week the most drops
 * agree on (of two such times, the one a later drop agrees on), on the hour when one is in it, as
 * the resets have been. Undefined until two drops agree: a drop alone can be a reset made once,
 * for everyone, on another day.
 * @param {Point[]} p the week's percents, in time order
 * @returns {Reset | undefined}
 */
export function weekReset(p) {
  const last = p.at(-1);
  /** @type {[number, number][]} each drop: after the first time and by the second */
  const drops = [];
  for (let i = 1; i < p.length; i++) {
    if (p[i].v < p[i - 1].v - 1 && p[i].t - p[i - 1].t < WEEK) drops.push([p[i - 1].t, p[i].t]);
  }
  if (!last || !drops.length) return undefined;
  // For each minute of the week, the drops that could have been a reset at it, and the last one.
  const minutes = WEEK / MINUTE;
  const votes = new Uint16Array(minutes);
  const lastVote = new Int32Array(minutes).fill(-1);
  drops.forEach(([a, b], d) => {
    for (let m = Math.floor(a / MINUTE) + 1; m <= Math.floor(b / MINUTE); m++) {
      votes[mod(m, minutes)]++;
      lastVote[mod(m, minutes)] = d;
    }
  });
  const most = votes.reduce((a, b) => Math.max(a, b), 0);
  if (most < 2) return undefined;
  /** @type {[number, number][]} the runs of minutes with the most votes, first and last */
  const runs = [];
  for (let m = 0; m < minutes; m++) {
    if (votes[m] !== most) continue;
    const run = runs.at(-1);
    if (run && run[1] === m - 1) run[1] = m;
    else runs.push([m, m]);
  }
  // A run at the end of the week goes on at its start.
  if (runs.length > 1 && runs[0][0] === 0 && /** @type {[number, number]} */ (runs.at(-1))[1] === minutes - 1) {
    /** @type {[number, number]} */ (runs.at(-1))[1] = /** @type {[number, number]} */ (runs.shift())[1] + minutes;
  }
  /** The latest drop that voted for a run. @param {[number, number]} run */
  const recent = ([first, final]) => {
    let d = -1;
    for (let m = first; m <= final; m++) d = Math.max(d, lastVote[mod(m, minutes)]);
    return d;
  };
  const [lo, hi] = runs.reduce((a, b) => (recent(b) > recent(a) ? b : a));
  if (hi - lo >= minutes - 1) return undefined;
  const hour = Math.round((lo + hi) / 2 / 60) * 60;
  const likely = hour >= lo && hour <= hi ? hour : Math.round((lo + hi) / 2);
  const base = last.t - mod(last.t, WEEK);
  /** @param {number} k weeks on from the last sample's */
  const reset = (k) => ({ at: base + k * WEEK + likely * MINUTE, from: base + k * WEEK + lo * MINUTE, to: base + k * WEEK + hi * MINUTE });
  let k = -1;
  while (reset(k).to <= last.t) k++;
  // The last drop was this reset when it falls in its time: then the next is a week on.
  const [a, b] = /** @type {[number, number]} */ (drops.at(-1));
  if (a < reset(k).to && b > reset(k).from) k++;
  return reset(k);
}
