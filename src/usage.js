// How much of the plan's usage limits is used, as the Claude desktop app samples it about every
// 15 minutes while it runs: plan-usage-history.json in its data folder, its samples in percent of
// the session's limit (a window of five hours) and of the week's. It keeps no reset times there, so
// they are worked out from the samples: the week's limit resets at the same time each week, where
// its percent dropped before, and the session's five hours after its window began, on the
// 10-minute mark at or before its first use, where its percent began to rise. The percents are
// carried on from the latest sample to now with what this computer's replies used since
// (src/ledger.js), at as many points for so much as the samples rose by with them lately.
import { join } from 'node:path';
import { JsonFiles } from './files.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SESSION = 5 * HOUR;
const WEEK = 7 * DAY;
/** Samples further apart than this can hide a reset: the percent grown back past where it was. */
const GAP = 45 * MINUTE;
/** Two samples further apart than this are no rise to scale by: a reset can come between. */
const RISE = 30 * MINUTE;
/**
 * The rises a percent is scaled by: the latest, back from its last sample till so many points
 * or so long before it, and the fewest points that will do.
 * @typedef {{ points: number, within: number, least: number }} Rises
 * @type {Rises}
 */
const SESSION_RISES = { points: 60, within: 3 * DAY, least: 10 };
/** @type {Rises} */
const WEEK_RISES = { points: 20, within: WEEK, least: 5 };
/**
 * The server begins a session's window on the 10-minute mark at or before its first use, and so
 * resets it on one: every reset its limit errors in the transcripts named was (quotaLimits).
 */
const MARK = 10 * MINUTE;

/**
 * @typedef {object} Usage the app's latest sample, and when the limits it measures reset
 * @property {number} at when it was taken (ms)
 * @property {number} [session] percent of the session's limit used: five hours (u.fh)
 * @property {number} [week] percent of the week's (u.sd: seven days)
 * @property {Reset} [sessionReset] when the session's limit resets
 * @property {Reset} [weekReset] when the week's resets
 * @property {Tracked} [tracked] the percents carried on to a later time
 */

/**
 * @typedef {object} Tracked the percents carried on from the latest sample with this computer's
 *   replies since; each one only where the samples tell how
 * @property {number} at the time they are for (ms)
 * @property {number} [session]
 * @property {Reset} [sessionReset] the end of the window the replies began
 * @property {number} [week]
 * @property {Reset} [weekReset]
 */

/**
 * @typedef {object} Reset when a limit resets, as far as the samples tell (ms)
 * @property {number} at the likeliest time
 * @property {number} from the earliest it can be
 * @property {number} to the latest
 */

/** @typedef {{ t: number, v: number }} Point a sample's time and one of its percents */
/** @typedef {{ session: Point[], week: Point[] }} Points the percents of an org's samples, in time order */
/** @typedef {{ usage: Usage, points: Points }} Told what the app's file tells */

export class PlanUsage {
  /**
   * @param {() => Promise<string[]>} dirs the app's data folders, looked up on each read
   * @param {import('./ledger.js').Ledger} [ledger] this computer's replies, to carry the samples on with
   */
  constructor(dirs, ledger) {
    this.dirs = dirs;
    this.ledger = ledger;
    this.files = new JsonFiles();
    /** What each file's JSON tells, while the file is unchanged (and so its JSON the same object). @type {WeakMap<object, Told | undefined>} */
    this.told = new WeakMap();
    this.readAt = -Infinity;
    /** @type {Usage | undefined} */
    this.usage = undefined;
  }

  /**
   * The latest sample in the app's folders, carried on to `now` where the replies tell how; read
   * again at most every `maxAgeMs`. The replies are read in the background unless `wait`: until
   * the first read of them has finished, the sample alone.
   * @param {number} now
   * @param {{ maxAgeMs?: number, wait?: boolean }} [o]
   * @returns {Promise<Usage | undefined>}
   */
  async read(now, { maxAgeMs = 5000, wait = false } = {}) {
    if (now - this.readAt < maxAgeMs) return this.usage;
    this.readAt = now;
    /** @type {Told | undefined} */
    let latest;
    for (const dir of await this.dirs()) {
      const json = await this.files.read(join(dir, 'plan-usage-history.json'));
      if (!json || typeof json !== 'object') continue;
      if (!this.told.has(json)) this.told.set(json, tell(json));
      const told = this.told.get(json);
      if (told && (!latest || told.usage.at > latest.usage.at)) latest = told;
    }
    this.files.sweep();
    let usage = latest?.usage;
    if (latest && this.ledger) {
      const replies = await this.ledger.read(now, repliesSince(latest.points, now), { wait });
      const tracked = replies && track(latest.points, replies, now, latest.usage.weekReset);
      if (tracked) usage = { ...latest.usage, tracked };
    }
    this.usage = usage;
    return usage;
  }
}

const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const percent = (/** @type {unknown} */ v) => {
  const n = num(v);
  return n === undefined || n < 0 ? undefined : Math.round(n);
};
const mod = (/** @type {number} */ n, /** @type {number} */ m) => ((n % m) + m) % m;
/** The 10-minute mark at or before `t`. @param {number} t */
const mark = (t) => t - mod(t, MARK);

/**
 * What plan-usage-history.json tells: { version, samples: [{ t, org, u: { fh, sd } }] }, with t in
 * ms and fh and sd in percent. Its latest sample, and when the limits reset, from the samples of
 * the same org; undefined when it has none.
 * @param {unknown} o the file, parsed
 * @returns {Usage | undefined}
 */
export function usageOf(o) {
  return tell(o)?.usage;
}

/**
 * What plan-usage-history.json tells (usageOf), and the percents of the samples it comes from.
 * @param {unknown} o the file, parsed
 * @returns {Told | undefined}
 */
function tell(o) {
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
  const p = { session: points('session'), week: points('week') };
  const sessionAt = latest.session !== undefined ? sessionReset(p.session) : undefined;
  const weekAt = latest.week !== undefined ? weekReset(p.week) : undefined;
  const usage = {
    at: latest.t,
    ...(latest.session !== undefined ? { session: latest.session } : {}),
    ...(latest.week !== undefined ? { week: latest.week } : {}),
    ...(sessionAt ? { sessionReset: sessionAt } : {}),
    ...(weekAt ? { weekReset: weekAt } : {}),
  };
  return { usage, points: p };
}

/**
 * When the session's limit resets: five hours after its window began, on the 10-minute mark at or
 * before the first use after the last reset. That use came about the last sample before its
 * percent rose from 0 (the first use reads 0% for a while), or soon after a reset between the two
 * samples its percent dropped between (a new window, begun on the reset's mark mostly), and by the
 * first sample after either. Where the samples don't show it (the app was not running then, or two
 * samples are too far apart to be sure no reset came between), all that is known is that it began
 * within the five hours before the last sample. A window begun with next to nothing used while the
 * app was not running reads 0% when it starts again, and so seems to begin later than it did.
 * Undefined while the percent is 0: no window, or next to nothing used in it.
 * @param {Point[]} p the session's percents, in time order
 * @returns {Reset | undefined}
 */
export function sessionReset(p) {
  const last = p.at(-1);
  if (!last || last.v <= 0) return undefined;
  // The window began after this time, or about at it where the percent rose from 0.
  let after = last.t - SESSION;
  let rose = false;
  let dropped = false;
  let i = p.length - 1;
  for (; i > 0; i--) {
    const prev = p[i - 1];
    if (prev.t <= last.t - SESSION || p[i].t - prev.t > GAP) break;
    if (prev.v === 0 || prev.v > p[i].v) {
      after = prev.t;
      rose = prev.v === 0;
      dropped = !rose;
      break;
    }
  }
  // The marks it can have begun on: that time's where it rose from 0, else from the next one on,
  // to the mark of the first sample after. Likeliest the first where it rose or dropped (the use
  // went on from the last 0, or from the reset), else the middle.
  const to = mark(p[i].t);
  const from = Math.min(to, mark(after) + (rose ? 0 : MARK));
  const at = rose || dropped ? from : from + Math.round((to - from) / 2 / MARK) * MARK;
  return { at: at + SESSION, from: from + SESSION, to: to + SESSION };
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

/**
 * How far back this computer's replies are needed to carry the samples on (track): to the
 * earliest of the rises each percent is scaled by, as the samples alone tell them, or to its last
 * sample, and a window's length before that, for the windows to begin where they did. Eight days
 * back at most.
 * @param {Points} p
 * @param {number} now
 */
export function repliesSince(p, now) {
  /** @type {number[]} */
  const times = [];
  for (const [q, o] of /** @type {[Point[], Rises][]} */ ([[p.session, SESSION_RISES], [p.week, WEEK_RISES]])) {
    const last = q.at(-1);
    if (last) times.push(last.t, ...rises(q, o).map(([a]) => a.t));
  }
  return Math.max(now - 8 * DAY, Math.min(now, ...times) - SESSION);
}

/**
 * The percents carried on from the last samples to `now` with this computer's replies since, at
 * as many points for so much use as the latest rises of the samples came to (each between two
 * samples close together, after the time the replies are known from). The session's: what its
 * window used since the sample when the sample was in that window too, else all its window used,
 * and 0 with no window; the windows those the replies began. The week's: what it used since the
 * sample, or since its reset when one came between, and only with that reset known. Each one only
 * where its rises come to enough points; undefined when neither does.
 * @param {Points} p
 * @param {import('./ledger.js').Replies} replies
 * @param {number} now
 * @param {Reset} [weekAt] the week's next reset after its last sample
 * @returns {Tracked | undefined}
 */
export function track(p, { from, replies }, now, weekAt) {
  const sum = [0];
  for (const r of replies) sum.push(/** @type {number} */ (sum.at(-1)) + r.x);
  /** What the replies written in (a, b] used. @param {number} a @param {number} b */
  const used = (a, b) => sum[writtenBy(replies, b)] - sum[writtenBy(replies, a)];
  const starts = windowsOf(replies);
  /**
   * Points for each of use, over the rises `keep` keeps.
   * @param {Point[]} q @param {Rises} o @param {(a: Point, b: Point) => boolean} keep
   */
  const scale = (q, o, keep) => {
    let up = 0;
    let x = 0;
    for (const [a, b] of rises(q, o, (a, b) => a.t >= from && keep(a, b))) {
      up += b.v - a.v;
      x += used(a.t, b.t);
    }
    return up >= o.least && x > 0 ? up / x : undefined;
  };
  /** @type {Tracked} */
  const out = { at: now };
  const s = p.session.at(-1);
  // Rises within a window the replies began: none of use elsewhere alone, none across a reset.
  const a = s && scale(p.session, SESSION_RISES, (x, y) => {
    const w = windowAt(starts, y.t);
    return w !== undefined && windowAt(starts, x.t) === w;
  });
  if (s && a !== undefined) {
    const w = windowAt(starts, now);
    if (w === undefined) out.session = 0;
    else {
      const v = s.v > 0 && windowAt(starts, s.t) === w ? s.v + a * used(s.t, now) : a * used(w - 1, now);
      out.session = Math.min(100, Math.round(v));
      const end = w + SESSION;
      out.sessionReset = { at: end, from: end, to: end };
    }
  }
  const last = p.week.at(-1);
  const b = last && weekAt && scale(p.week, WEEK_RISES, () => true);
  if (last && weekAt && b !== undefined) {
    if (now < weekAt.at) {
      out.week = Math.min(100, Math.round(last.v + b * used(last.t, now)));
      out.weekReset = weekAt;
    } else {
      // Reset since: what was used since the latest reset, and the next a week on.
      const k = Math.floor((now - weekAt.at) / WEEK);
      out.week = Math.min(100, Math.round(b * used(weekAt.at + k * WEEK, now)));
      const on = (k + 1) * WEEK;
      out.weekReset = { at: weekAt.at + on, from: weekAt.from + on, to: weekAt.to + on };
    }
  }
  return out.session !== undefined || out.week !== undefined ? out : undefined;
}

/**
 * The rises of a percent to scale it by: two samples close together, the percent not down nor at
 * the limit, those `keep` keeps; from the last sample back till they come to `o.points` points,
 * or to `o.within` before it.
 * @param {Point[]} q in time order
 * @param {Rises} o
 * @param {(a: Point, b: Point) => boolean} [keep]
 * @returns {[Point, Point][]}
 */
function rises(q, o, keep = () => true) {
  /** @type {[Point, Point][]} */
  const out = [];
  const last = q.at(-1);
  let up = 0;
  for (let k = q.length - 1; last && k > 0 && up < o.points && q[k].t > last.t - o.within; k--) {
    const [a, b] = [q[k - 1], q[k]];
    if (b.t - a.t > RISE || b.v < a.v || b.v >= 100 || !keep(a, b)) continue;
    out.push([a, b]);
    up += b.v - a.v;
  }
  return out;
}

/**
 * The starts of the session windows the replies began: once the last one has ended, one begins on
 * the 10-minute mark at or before the first reply asked for, as the server begins them, and lasts
 * five hours.
 * @param {import('./ledger.js').Reply[]} replies in the order written
 */
function windowsOf(replies) {
  /** @type {number[]} */
  const starts = [];
  let end = -Infinity;
  for (const r of replies) {
    if (r.asked >= end) {
      const start = mark(r.asked);
      starts.push(start);
      end = start + SESSION;
    }
  }
  return starts;
}

/**
 * The start of the window `t` is in; undefined when it is in none.
 * @param {number[]} starts in time order
 * @param {number} t
 */
function windowAt(starts, t) {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  const start = starts[lo - 1];
  return start !== undefined && t < start + SESSION ? start : undefined;
}

/**
 * How many of the replies were written by `t`.
 * @param {import('./ledger.js').Reply[]} replies in the order written
 * @param {number} t
 */
function writtenBy(replies, t) {
  let lo = 0;
  let hi = replies.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (replies[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
