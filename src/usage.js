// How much of the plan's usage limits is used, as the Claude desktop app samples it about every
// 15 minutes while it runs: plan-usage-history.json in its data folder, its samples in percent of
// the session's limit (a window of five hours) and of the week's. It keeps no reset times there, so
// they are worked out from the samples: the week's limit resets at the same time each week, where
// its percent dropped before, and the session's five hours after its window began, on the
// 10-minute mark at or before its first use, where its percent began to rise. The percents are
// carried on from the latest sample to now with what this computer's replies used since
// (src/ledger.js), at as many points for so much as the samples rose by with them lately: each
// model's use at its own rate where the rises tell the models apart, as the plan counts some
// models' tokens for more than their prices against each other say, else all at one; and each
// one's pace with the last hour's. A rise with none of this computer's use in it was use elsewhere
// (another computer, the Claude apps), and tells nothing of how much the use here counts for: it
// is left out. Use elsewhere at the same time as here can't be told apart, and counts as this
// computer's. At those rates too, what each session and model used of each limit, and the points
// the replies just written add: to the session's, or where it is not carried on to the week's.
// What they used in all, each week's at the rates its own rises came to, as the plan counts the
// same use for more in one week than in another; the week now, where its rises tell none (this
// computer not used in them), at the latest week's that do. A plan changed shows where the week's
// percent dropped at no reset of it: the rises before then measured other limits, and are not
// used. For the chart, what a point of the week came to at each sample, as the plans changed.
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
/**
 * The week's: all of a week's, for the runs of them to tell the models apart (fit). Over the
 * samples of two weeks, carried on from each, as close at a few hours as its latest 20 points, and
 * closer at a day or two.
 * @type {Rises}
 */
const WEEK_RISES = { points: Infinity, within: WEEK, least: 5 };
/** What a point of the week came to lately, for the chart (perPointOf): its latest 20. @type {Rises} */
const POINT_RISES = { points: 20, within: WEEK, least: 5 };
/**
 * The server begins a session's window on the 10-minute mark at or before its first use, and so
 * resets it on one: every reset its limit errors in the transcripts named was (quotaLimits).
 */
const MARK = 10 * MINUTE;
/** A limit's pace is the last hour's, when the replies are known for so long of it at least. */
const PACE_LEAST = 15 * MINUTE;

/**
 * @typedef {object} Usage the app's latest sample, and when the limits it measures reset
 * @property {number} at when it was taken (ms)
 * @property {number} [session] percent of the session's limit used: five hours (u.fh)
 * @property {number} [week] percent of the week's (u.sd: seven days)
 * @property {Reset} [sessionReset] when the session's limit resets
 * @property {Reset} [weekReset] when the week's resets
 * @property {Points} [history] the percents of the samples of its org, in time order
 * @property {Point} [changed] the week's first sample after the plan last seems to have changed
 *   (changeOf): the week's pace and its split count from it, where that is after its reset
 * @property {Point[]} [changes] the week's first sample after each time the plan seems to have
 *   changed, oldest first (changesOf), the last of them `changed`
 * @property {Tracked} [tracked] the percents carried on to a later time
 * @property {true} [reading] the replies to carry them on with are still being read (the first
 *   read of them, at the monitor's start, takes some seconds): the sample alone till then
 * @property {{ session?: number, week?: number }} [perUse] the points of each limit for each of use
 *   (a reply's x), as the replies carry them on: of all the use its rises came to, and so of each
 *   model's that has no rate of its own
 * @property {{ session?: [string, number][], week?: [string, number][] }} [perModel] the models'
 *   own points of each limit for each of their use, where its rises tell them apart (fit)
 * @property {Point[]} [perPoint] what this computer's replies used (their x) for a point of the
 *   week, at each of its samples they tell it for (perPointOf): read with `history`
 * @property {{ session?: Share, week?: Share, all?: Share }} [split] what this computer's replies
 *   used of each, as carried on: the session's in its window, the week's since its reset or the
 *   plan's change, the later; and all those read, in the week's points, each week's at the rates its
 *   own rises came to (Followed's weeks)
 * @property {Drop[]} [drops] the replies of the last half minute, as they add to the session's, or
 *   where it is not carried on to the week's
 */

/**
 * @typedef {object} Share what this computer's replies used of a limit, in its points, by
 *   session and by model, the most first
 * @property {number} from the time they are counted from
 * @property {number} to the time they are counted to
 * @property {[string, number][]} sessions by session ID
 * @property {[string, number][]} models
 *
 * @typedef {object} Drop a reply just written, as it adds to a limit
 * @property {number} t when it was written
 * @property {number} seen when the read that found it began
 * @property {'session' | 'week'} limit the limit it adds to
 * @property {number} v its points of that limit
 * @property {string} [session]
 */

/**
 * @typedef {object} Tracked the percents carried on from the latest sample with this computer's
 *   replies since; each one only where the samples tell how
 * @property {number} at the time they are for (ms)
 * @property {number} [session]
 * @property {Reset} [sessionReset] the end of the window the replies began
 * @property {number} [sessionPace] the session's points an hour, at the pace of the last hour's
 *   replies (of the part of it they are known for)
 * @property {number} [week]
 * @property {Reset} [weekReset]
 * @property {number} [weekPace] the week's points an hour, at the pace of the last hour's replies
 *   (as the session's)
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
    /** @type {import('./ledger.js').Replies | undefined} the replies, as last read */
    this.replies = undefined;
    /**
     * What a point of the week came to, while the samples and the replies it is worked out from
     * are the same objects.
     * @type {{ told: Told, list: import('./ledger.js').Reply[], from: number, value: Point[] } | undefined}
     */
    this.worth = undefined;
  }

  /**
   * The latest sample in the app's folders, carried on to `now` where the replies tell how; read
   * again at most every `maxAgeMs`. The replies are read in the background unless `wait`: until
   * the first read of them has finished, the sample alone, marked `reading`, and read again at
   * each call, to be carried on as soon as they are. With `since`, they are read back to then at
   * least, samples or none, and kept in `replies`. With `history`, back to the week's first sample
   * too, for what a point of the week came to at each sample (perPoint).
   * @param {number} now
   * @param {{ maxAgeMs?: number, wait?: boolean, since?: number, history?: boolean }} [o]
   * @returns {Promise<Usage | undefined>}
   */
  async read(now, { maxAgeMs = 5000, wait = false, since, history = false } = {}) {
    if (now - this.readAt < maxAgeMs && !this.usage?.reading) return this.usage;
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
    const backs = [latest && repliesSince(latest.points, now, latest.usage.changed), since, history ? latest?.points.week[0]?.t : undefined];
    const back = Math.min(...backs.filter((t) => t !== undefined));
    if (back !== Infinity && this.ledger) {
      const replies = await this.ledger.read(now, back, { wait });
      this.replies = replies;
      // Not read yet: they are, in the background (waited for, a read that failed is all there is).
      if (usage && !replies && !wait) usage = { ...usage, reading: true };
      const f = latest && replies ? follow(latest.points, replies, now, latest.usage.weekReset, latest.usage.changed) : undefined;
      if (latest && replies && f?.tracked) {
        const perUse = { ...(f.a ? { session: f.a.all } : {}), ...(f.b ? { week: f.b.all } : {}) };
        const perModel = { ...(f.a?.by.size ? { session: [...f.a.by] } : {}), ...(f.b?.by.size ? { week: [...f.b.by] } : {}) };
        usage = { ...latest.usage, tracked: f.tracked, perUse, ...(perModel.session || perModel.week ? { perModel } : {}), ...splitOf(f, replies, now) };
      }
      const perPoint = history && latest && replies ? this.perPointOf(latest, replies) : [];
      if (usage && perPoint.length) usage = { ...usage, perPoint };
    }
    this.usage = usage;
    return usage;
  }

  /**
   * What a point of the week came to at each sample (perPointOf), worked out again only when the
   * samples or the replies changed.
   * @param {Told} told
   * @param {import('./ledger.js').Replies} r
   */
  perPointOf(told, r) {
    const w = this.worth;
    if (w && w.told === told && w.list === r.replies && w.from === r.from) return w.value;
    const value = perPointOf(told.points.week, r, told.usage.changes ?? []);
    this.worth = { told, list: r.replies, from: r.from, value };
    return value;
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
  const weekly = weekReset(p.week);
  const weekAt = latest.week !== undefined ? weekly : undefined;
  const changes = changesOf(p.week, weekly);
  const changed = changes.at(-1);
  const usage = {
    at: latest.t,
    ...(latest.session !== undefined ? { session: latest.session } : {}),
    ...(latest.week !== undefined ? { week: latest.week } : {}),
    ...(sessionAt ? { sessionReset: sessionAt } : {}),
    ...(weekAt ? { weekReset: weekAt } : {}),
    ...(changed ? { changed, changes } : {}),
    history: p,
  };
  return { usage, points: p };
}

/**
 * Where the plan seems to have changed: each drop of the week's percent that none of its weekly
 * resets came within, as when a new plan's limits begin (or the limits are reset once, for
 * everyone); the sample after each, the first under the new limits, oldest first. None where no
 * reset is known to tell one by.
 * @param {Point[]} p the week's percents, in time order
 * @param {Reset} [at] one of its weekly resets
 * @returns {Point[]}
 */
export function changesOf(p, at) {
  /** @type {Point[]} */
  const out = [];
  if (!at) return out;
  for (let i = 1; i < p.length; i++) {
    const [a, b] = [p[i - 1], p[i]];
    if (b.v >= a.v - 1 || b.t - a.t >= WEEK) continue;
    // The first of the resets to end after the sample before the drop: whether it began by the one after.
    const k = Math.floor((a.t - at.to) / WEEK) + 1;
    if (at.from + k * WEEK > b.t) out.push(b);
  }
  return out;
}

/**
 * When the plan last seems to have changed (changesOf): the first sample under its limits.
 * Undefined where there is no such drop, or no reset is known to tell one by.
 * @param {Point[]} p the week's percents, in time order
 * @param {Reset} [at] one of its weekly resets
 * @returns {Point | undefined}
 */
export function changeOf(p, at) {
  return changesOf(p, at).at(-1);
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
 * sample, and a window's length before that, for the windows to begin where they did. Fifteen days
 * back at most: all the week's rises of a sample a week old (the app not run since), none of an
 * older one's.
 * @param {Points} p
 * @param {number} now
 * @param {Point} [changed] the plan's last change (changeOf): no rise before it is used
 */
export function repliesSince(p, now, changed) {
  /** @type {number[]} */
  const times = [];
  const after = changed?.t ?? -Infinity;
  for (const [q, o] of /** @type {[Point[], Rises][]} */ ([[p.session, SESSION_RISES], [p.week, WEEK_RISES]])) {
    const last = q.at(-1);
    if (last) times.push(last.t, ...rises(q, o, (a) => a.t >= after).map(([a]) => a.t));
  }
  return Math.max(now - 15 * DAY, Math.min(now, ...times) - SESSION);
}

/**
 * The percents carried on from the last sample to `now` with this computer's replies since, at as
 * many points for so much use as the latest rises of the samples came to (each between two samples
 * close together, after the time the replies are known from and the plan's last change, and with
 * some of this computer's use in it: a rise with none was use elsewhere): each model's use at its
 * own rate where the rises tell the models apart (fit), else all at one. The week's, where its
 * last week of rises tells none, at those of the latest week before whose rises do. A
 * percent the last sample leaves out, not at all, as it tells nothing of it now. The session's:
 * what its window used since the sample when the sample was in that window too, else all its
 * window used, and 0 with no window; the windows those the replies began; and in a window its
 * pace, the points the last hour's replies came to, in whatever window they were, as an hour's
 * worth. The week's: what it used since the sample, or since its reset when one came between, and
 * only with that reset known; and its pace as the session's. Each one only where its rises come to
 * enough points; undefined when neither does.
 * @param {Points} p
 * @param {import('./ledger.js').Replies} replies
 * @param {number} now
 * @param {Reset} [weekAt] the week's next reset after its last sample
 * @param {Point} [changed] the plan's last change (changeOf, from the week's percents)
 * @returns {Tracked | undefined}
 */
export function track(p, replies, now, weekAt, changed = changeOf(p.week, weekAt)) {
  return follow(p, replies, now, weekAt, changed).tracked;
}

/**
 * @typedef {object} Rates a limit's points for each of use (a reply's x), as its rises came to
 * @property {number} all over all the use in them
 * @property {Map<string, number>} by each model's own, where they tell the models apart (fit): by
 *   its name, '' for none
 *
 * @typedef {{ up: number, x: Map<string, number> }} Run rises one after another: the points they
 *   came to, and each model's use over them
 */

/**
 * A reply's points for each of its use: its model's own, else that of all use.
 * @param {Rates} r
 * @param {string | undefined} model
 */
const rateOf = (r, model) => r.by.get(model ?? '') ?? r.all;

/**
 * @typedef {object} Followed what track works out: the percents carried on, and what they were
 *   carried on with, for the shares (splitOf)
 * @property {Tracked} [tracked]
 * @property {Rates} [a] the session's points for each of use (a reply's x)
 * @property {number} [window] the start of the session's window now
 * @property {Rates} [b] the week's points for each of use: as its last week of rises came to, else
 *   as the latest week's before whose rises tell them
 * @property {number} [weekFrom] when the week's limit last reset, or the plan last changed where
 *   that is later (its first sample under the new limits)
 * @property {Week[]} [weeks] the weeks back to the first reply, oldest first, the week now last
 *
 * @typedef {object} Week a week of the week's limit, from a reset to the next (a change of plan
 *   begins one too), and the rates its replies count at: those its own rises came to, as the plan
 *   counts the same use for more in one week than in another; where they don't tell them (too few,
 *   or under another plan), the next week's, as if under the plan there is now; and the week now
 *   at the rates the percent is carried on with
 * @property {number} from when it began
 * @property {Rates} rates
 */

/**
 * track's work.
 * @param {Points} p
 * @param {import('./ledger.js').Replies} replies
 * @param {number} now
 * @param {Reset} [weekAt]
 * @param {Point} [changed]
 * @returns {Followed}
 */
function follow(p, { from, replies }, now, weekAt, changed) {
  /** @type {Followed} */
  const f = {};
  /**
   * What the replies written in (a, b] came to, each at its model's rate.
   * @param {Rates} r @param {number} a @param {number} b
   */
  const points = (r, a, b) => {
    let v = 0;
    for (let i = writtenBy(replies, a), end = writtenBy(replies, b); i < end; i++) v += rateOf(r, replies[i].model) * replies[i].x;
    return v;
  };
  const starts = windowsOf(replies);
  // The rises the replies are known for, under the limits there are now.
  const after = Math.max(from, changed?.t ?? -Infinity);
  /** What the replies came to, all told, by each one written: use[i] that of the first i. */
  const use = [0];
  for (const r of replies) use.push(/** @type {number} */ (use.at(-1)) + r.x);
  /**
   * Whether the plan rose between two samples with none of this computer's use between them: use
   * elsewhere (another computer, the Claude apps), which tells nothing of how much the use here
   * counts for. A rise of no points goes on a run all the same.
   * @param {Point} a @param {Point} b
   */
  const elsewhere = (a, b) => b.v > a.v && use[writtenBy(replies, b.t)] <= use[writtenBy(replies, a.t)];
  /**
   * The rates over the rises `keep` keeps, back from sample `till` (the last): of all the use in
   * them, and each model's where the runs of them tell it apart from the others' (fit). Only rises
   * with some of the use here, where the plan rose.
   * @param {Point[]} q @param {Rises} o @param {(a: Point, b: Point) => boolean} keep @param {number} [till]
   * @returns {Rates | undefined}
   */
  const scale = (q, o, keep, till) => {
    /** @type {Run[]} */
    const runs = [];
    /** @type {Point | undefined} where the last rise began: one that ends there goes on its run */
    let joins;
    let up = 0;
    let x = 0;
    // The latest first.
    for (const [a, b] of rises(q, o, (a, b) => a.t >= after && !elsewhere(a, b) && keep(a, b), till)) {
      let run = b === joins ? runs.at(-1) : undefined;
      if (!run) {
        run = { up: 0, x: new Map() };
        runs.push(run);
      }
      run.up += b.v - a.v;
      up += b.v - a.v;
      for (let i = writtenBy(replies, a.t), end = writtenBy(replies, b.t); i < end; i++) {
        const m = replies[i].model ?? '';
        run.x.set(m, (run.x.get(m) ?? 0) + replies[i].x);
        x += replies[i].x;
      }
      joins = a;
    }
    return up >= o.least && x > 0 ? { all: up / x, by: fit(runs, up / x, o.least) } : undefined;
  };
  // A pace: the points the last hour's replies came to, as an hour's worth; of the part of it they
  // are known for, when that is long enough.
  const since = Math.max(now - HOUR, from);
  const paced = now - since >= PACE_LEAST;
  /** At these rates. @param {Rates} r */
  const pace = (r) => (points(r, since, now) * HOUR) / (now - since);
  /** @type {Tracked} */
  const out = { at: now };
  // Each percent from the last sample alone: the samples before tell nothing of one it leaves out.
  const latest = Math.max(p.session.at(-1)?.t ?? -Infinity, p.week.at(-1)?.t ?? -Infinity);
  const s = p.session.at(-1)?.t === latest ? p.session.at(-1) : undefined;
  // Rises within a window the replies began: none of use elsewhere alone, none across a reset.
  const a = s && scale(p.session, SESSION_RISES, (x, y) => {
    const w = windowAt(starts, y.t);
    return w !== undefined && windowAt(starts, x.t) === w;
  });
  if (s && a) {
    f.a = a;
    const w = windowAt(starts, now);
    if (w === undefined) out.session = 0;
    else {
      f.window = w;
      const v = s.v > 0 && windowAt(starts, s.t) === w ? s.v + points(a, s.t, now) : points(a, w - 1, now);
      out.session = Math.min(100, Math.round(v));
      const end = w + SESSION;
      out.sessionReset = { at: end, from: end, to: end };
      if (paced) out.sessionPace = pace(a);
    }
  }
  const last = p.week.at(-1)?.t === latest ? p.week.at(-1) : undefined;
  if (last && weekAt) {
    // The reset the week now began at: the one before the next, or where one came since the last
    // sample, the latest (-1 and k weeks on from the next).
    const k = now < weekAt.at ? -1 : Math.floor((now - weekAt.at) / WEEK);
    const reset = weekAt.at + k * WEEK;
    // Since the reset, or the plan's change where later: the percents before were of other limits.
    // (A reset since came after any change, which is a sample.)
    const begun = k < 0 ? Math.max(reset, changed?.t ?? -Infinity) : reset;
    // The weeks before, back to the first reply: each from a reset to the next, or to the plan's
    // change, which begins one; and the rates its own rises came to, where they tell them.
    const first = Math.max(from, replies[0]?.t ?? Infinity);
    const cuts = [first, begun, ...(changed ? [changed.t] : [])];
    for (let t = reset; t > first; t -= WEEK) cuts.push(t);
    const edges = [...new Set(cuts)].filter((t) => t >= first && t <= begun).sort((x, y) => x - y);
    const own = edges.slice(1).map((end, i) => scale(p.week, WEEK_RISES, (x, y) => x.t >= edges[i] && y.t <= end, writtenBy(p.week, end) - 1));
    // The week now's: as its last week of rises came to, else as the latest week's whose rises
    // tell them, as on a computer not used in any of its rises (the plan used elsewhere).
    const b = scale(p.week, WEEK_RISES, () => true) ?? own.findLast((r) => r !== undefined);
    if (b) {
      f.b = b;
      f.weekFrom = begun;
      // From the last sample, or where a reset came since, what was used since it; the next reset
      // a week on from that.
      out.week = Math.min(100, Math.round(k < 0 ? last.v + points(b, last.t, now) : points(b, reset, now)));
      const on = (k + 1) * WEEK;
      out.weekReset = k < 0 ? weekAt : { at: weekAt.at + on, from: weekAt.from + on, to: weekAt.to + on };
      if (paced) out.weekPace = pace(b);
      // Each week at its own rates, else at the next week's; the week now at those it is carried
      // on with.
      /** @type {Week[]} */
      const weeks = [{ from: begun, rates: b }];
      for (let i = own.length - 1; i >= 0; i--) weeks.unshift({ from: edges[i], rates: own[i] ?? weeks[0].rates });
      f.weeks = weeks;
    }
  }
  if (out.session !== undefined || out.week !== undefined) f.tracked = out;
  return f;
}

/** How long a reply just written counts as one, for the drops (ms). */
const DROPS = 30_000;

/**
 * What this computer's replies used of each limit, as track carried it on (each at its model's
 * rate): the session's in the window now, the week's since its reset or the plan's change, the
 * later (from the time the replies are known, if later still), and all the replies read, in the
 * week's points, each week's at its own rates (Followed's weeks); and the replies of the last half
 * minute, as they add to the session's, or where it is not carried on (its points for them not
 * known) to the week's.
 * @param {Followed} f
 * @param {import('./ledger.js').Replies} r
 * @param {number} now
 * @returns {{ split: { session?: Share, week?: Share, all?: Share }, drops: Drop[] }}
 */
function splitOf(f, r, now) {
  /**
   * @param {Week[]} weeks the rates the replies count at, by when they were written: each week's
   *   from its start (the first's before it too)
   * @param {number} from
   * @returns {Share}
   */
  const share = (weeks, from) => {
    /** @type {Map<string, number>} */
    const sessions = new Map();
    /** @type {Map<string, number>} */
    const models = new Map();
    let w = 0;
    for (let i = writtenBy(r.replies, from - 1); i < r.replies.length && r.replies[i].t <= now; i++) {
      const x = r.replies[i];
      while (w + 1 < weeks.length && weeks[w + 1].from <= x.t) w++;
      const v = rateOf(weeks[w].rates, x.model) * x.x;
      sessions.set(x.session ?? '', (sessions.get(x.session ?? '') ?? 0) + v);
      models.set(x.model ?? '', (models.get(x.model ?? '') ?? 0) + v);
    }
    const most = (/** @type {Map<string, number>} */ m) => [...m].sort((a, b) => b[1] - a[1]);
    return { from, to: now, sessions: most(sessions), models: most(models) };
  };
  /** All at these rates. @param {Rates} rates @returns {Week[]} */
  const all = (rates) => [{ from: -Infinity, rates }];
  /** @type {{ session?: Share, week?: Share, all?: Share }} */
  const split = {};
  if (f.a && f.window !== undefined) split.session = share(all(f.a), Math.max(f.window, r.from));
  if (f.b && f.weekFrom !== undefined) {
    split.week = share(all(f.b), Math.max(f.weekFrom, r.from));
    // What each session came to in all, as far back as the replies are read (with `history`, the
    // week's first sample), each week's at its own rates: an estimate of the use before the plan's
    // change too, as if under it.
    split.all = share(f.weeks ?? all(f.b), r.from);
  }
  /** @type {Drop[]} */
  const drops = [];
  /** @type {[Drop['limit'], Rates] | undefined} */
  const into = f.a ? ['session', f.a] : f.b ? ['week', f.b] : undefined;
  if (into) {
    const [limit, rates] = into;
    for (let i = writtenBy(r.replies, now - DROPS); i < r.replies.length; i++) {
      const x = r.replies[i];
      if (x.t <= now) drops.push({ t: x.t, seen: x.seen ?? x.t, limit, v: rateOf(rates, x.model) * x.x, ...(x.session ? { session: x.session } : {}) });
    }
  }
  return { split, drops };
}

/**
 * What this computer's replies used (their x) for a point of the week at each of its samples, all
 * of it together: over the latest 20 points of rises back from that sample, after the time the
 * replies are known from and the plan's change before it, where they come to enough points; a
 * rise with none of the use here (use elsewhere) left out, as track leaves it out. A plan's first
 * samples have none, till its rises come to enough.
 * @param {Point[]} q the week's percents, in time order
 * @param {import('./ledger.js').Replies} replies
 * @param {Point[]} changes the plan's changes (changesOf), oldest first
 * @returns {Point[]} each sample's time, and the use a point came to then
 */
export function perPointOf(q, { from, replies }, changes) {
  // What the replies written by each sample used, all told.
  /** @type {Map<Point, number>} */
  const by = new Map();
  let total = 0;
  let j = 0;
  for (const s of q) {
    for (; j < replies.length && replies[j].t <= s.t; j++) total += replies[j].x;
    by.set(s, total);
  }
  /** Whether the plan rose with none of the use here between two samples. @param {Point} a @param {Point} b */
  const elsewhere = (a, b) => b.v > a.v && /** @type {number} */ (by.get(b)) <= /** @type {number} */ (by.get(a));
  /** @type {Point[]} */
  const out = [];
  let c = 0;
  for (let i = 1; i < q.length; i++) {
    while (c < changes.length && changes[c].t <= q[i].t) c++;
    const after = Math.max(from, changes[c - 1]?.t ?? -Infinity);
    let up = 0;
    let x = 0;
    for (const [a, b] of rises(q, POINT_RISES, (a, b) => a.t >= after && !elsewhere(a, b), i)) {
      up += b.v - a.v;
      x += /** @type {number} */ (by.get(b)) - /** @type {number} */ (by.get(a));
    }
    if (up >= POINT_RISES.least && x > 0) out.push({ t: q[i].t, v: x / up });
  }
  return out;
}

/**
 * The rises of a percent to scale it by: two samples close together, the percent not down nor at
 * the limit, those `keep` keeps; from sample `end` (the last) back till they come to `o.points`
 * points, or to `o.within` before it.
 * @param {Point[]} q in time order
 * @param {Rises} o
 * @param {(a: Point, b: Point) => boolean} [keep]
 * @param {number} [end]
 * @returns {[Point, Point][]}
 */
function rises(q, o, keep = () => true, end = q.length - 1) {
  /** @type {[Point, Point][]} */
  const out = [];
  const last = q[end];
  let up = 0;
  for (let k = end; last && k > 0 && up < o.points && q[k].t > last.t - o.within; k--) {
    const [a, b] = [q[k - 1], q[k]];
    if (b.t - a.t > RISE || b.v < a.v || b.v >= 100 || !keep(a, b)) continue;
    out.push([a, b]);
    up += b.v - a.v;
  }
  return out;
}

/**
 * Each model's points for each of its use, where a limit's rises tell the models apart: by least
 * squares over the runs of them, each run's points against each model's use over it (the run, not
 * each rise, as the percents are whole numbers: a run's points are off by one at most, however long
 * it is). The models fitted are those whose use comes to `least` points or more at the rate of all
 * of it, two or more of them, with more than twice as many runs; the others' use is taken off at
 * that rate. None where a model's use went much as the others' did (the fit cannot tell them
 * apart), or where it leaves one at less than a third of that rate or more than three times. Over
 * the samples of two weeks, the week's percent rose about 40% more for each of Claude Fable 5.2's
 * use than for Claude Opus 5.5's, as weighed (src/ledger.js), and as much for Opus 5.5's as before
 * Fable 5.2 was used.
 * @param {Run[]} runs
 * @param {number} all the points for each of use over all of them
 * @param {number} least
 * @returns {Map<string, number>}
 */
function fit(runs, all, least) {
  /** @type {Map<string, number>} */
  const totals = new Map();
  for (const r of runs) for (const [m, v] of r.x) totals.set(m, (totals.get(m) ?? 0) + v);
  const models = [...totals].filter(([, v]) => v * all >= least).map(([m]) => m);
  /** @type {Map<string, number>} */
  const out = new Map();
  const n = models.length;
  if (n < 2 || runs.length <= 2 * n) return out;
  // The normal equations, each row with its right-hand side last.
  const rows = models.map(() => new Array(n + 1).fill(0));
  for (const r of runs) {
    let rest = r.up;
    for (const [m, v] of r.x) if (!models.includes(m)) rest -= v * all;
    models.forEach((m, i) => {
      const xi = r.x.get(m) ?? 0;
      models.forEach((k, j) => {
        rows[i][j] += xi * (r.x.get(k) ?? 0);
      });
      rows[i][n] += xi * rest;
    });
  }
  const rates = solve(rows);
  if (!rates || rates.some((v) => !(v > all / 3 && v < all * 3))) return out;
  models.forEach((m, i) => out.set(m, rates[i]));
  return out;
}

/**
 * The solution of normal equations (a symmetric matrix, each row with its right-hand side last),
 * by elimination in order: undefined where what is left of a model's column once the models before
 * it are taken out is under a twentieth of it, as its use then went too much as theirs did.
 * @param {number[][]} rows
 * @returns {number[] | undefined}
 */
function solve(rows) {
  const n = rows.length;
  const m = rows.map((r) => [...r]);
  for (let c = 0; c < n; c++) {
    if (!(m[c][c] > rows[c][c] / 20)) return undefined;
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  /** @type {number[]} */
  const v = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let k = r + 1; k < n; k++) s -= m[r][k] * v[k];
    v[r] = s / m[r][r];
  }
  return v;
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
 * How many of the replies were written by `t`; or of a percent's points, how many were sampled by
 * then.
 * @param {{ t: number }[]} replies in the order written
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
