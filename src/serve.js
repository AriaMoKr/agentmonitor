// The web view: the monitor's list and details as a page a browser keeps up to date, on this
// computer, or on others when it listens on their network. Read only: it answers GET and HEAD,
// and what a page sends, its keys and clicks, moves only that page's view. Every address begins
// with a token, random unless given, that only the addresses printed hold (and, for a phone, the
// QR code printed of the first). Text from the files reaches the page as JSON strings, which the
// page puts in as text, never as markup.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { hostname, networkInterfaces } from 'node:os';
import { clean, clock, graphemes } from './format.js';
import { qr, qrLines } from './qr.js';
import { makeTheme } from './view.js';
import { Viewer } from './viewer.js';

/**
 * @typedef {import('./keys.js').Key} Key
 * @typedef {import('./keys.js').Mouse} Mouse
 * @typedef {import('node:http').IncomingMessage} Request
 * @typedef {import('node:http').ServerResponse} Response
 * @typedef {{ viewer: Viewer, seen: number, read: boolean }} Page a page's view, when the page
 *   last asked, and whether what it sent wants everything read again before it is answered
 * @typedef {{ port: number, token: string, snapshot: () => Promise<import('./monitor.js').Snapshot | null>, close: () => Promise<void> }} Served
 *   where it listens, the latest read (made again first when older than the interval, as for a
 *   page), and how to stop it
 * @typedef {[string] | [string, string] | [string, string, number]} Run text, its classes, and
 *   for characters outside ASCII the columns they take, which the page gives them
 * @typedef {Key | { filter: string } | { drag: 'up' | 'down' }} Input what a page sent: a key, a
 *   click or a turn of the wheel, the filter as typed so far in its text field (where a phone's
 *   keyboard types), or a finger dragged a line's height
 */

/** What a token may hold: 16 or more letters, digits, - and _. */
export const TOKEN = /^[A-Za-z0-9_-]{16,}$/;
/** What a page's ID may hold. */
const PAGE = /^[A-Za-z0-9_-]{8,40}$/;
/** The most inputs one request carries. */
const MAX_INPUTS = 64;
/** The most characters of a filter typed in a page's text field (its maxlength). */
const MAX_FILTER = 200;
/** The keys a page sends by name. */
const KEYS = new Set(['up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'enter', 'escape', 'backspace', 'tab', 'backtab', 'delete']);

// The page runs its own script and style and nothing else: no inline script, nothing from
// elsewhere, no frames; and nothing is kept or sent on.
const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const TEXT = 'text/plain; charset=utf-8';

/** The page's files, by the name asked for after the token. */
const FILES = /** @type {Record<string, [string, string]>} */ ({
  '': ['index.html', 'text/html; charset=utf-8'],
  'app.js': ['app.js', 'text/javascript; charset=utf-8'],
  'app.css': ['app.css', 'text/css; charset=utf-8'],
});

/** A random token: 24 characters, 144 bits. */
export function newToken() {
  return randomBytes(18).toString('base64url');
}

/**
 * Serves the web view until closed.
 * @param {import('./monitor.js').Monitor} monitor
 * @param {object} o
 * @param {string} [o.host] the address to listen on: 127.0.0.1, this computer only, unless told
 * @param {number} [o.port] 0 for any free one
 * @param {string} [o.token] the first part of every address; random unless given
 * @param {number} o.intervalMs how old what a page is shown may be before it is read again
 * @param {boolean} o.ascii
 * @param {import('./view.js').AgentsShown} o.agents
 * @param {boolean} o.showEnded
 * @param {boolean} [o.bell] whether a page's bell starts on
 * @param {number} [o.pageTtlMs] how long a page that stopped asking keeps its view
 * @param {number} [o.maxPages] how many pages' views are kept at most
 * @param {(line: string) => void} [o.log] told of each page opened, and of errors
 * @returns {Promise<Served>}
 */
export async function serve(monitor, { host = '127.0.0.1', port = 7420, token = newToken(), intervalMs, ascii, agents, showEnded, bell = false, pageTtlMs = 10 * 60_000, maxPages = 50, log = () => {} }) {
  if (!TOKEN.test(token)) throw new Error('a token is 16 or more letters, digits, - or _');
  const t = makeTheme({ color: true, ascii, animate: false, web: true });
  const files = new Map(Object.entries(FILES).map(([name, [file, type]]) => [name, { body: readFileSync(new URL(`./web/${file}`, import.meta.url)), type }]));
  const expected = Buffer.from(token);
  /** @type {Map<string, Page>} in the order they last asked: the first, longest ago */
  const pages = new Map();
  /** @type {import('./monitor.js').Snapshot | null} */
  let snap = null;
  let readAt = 0;
  let lastError = '';
  /** @type {Promise<void> | undefined} */
  let reading;
  /** @type {Promise<void> | undefined} */
  let next;

  /** Reads everything again; asked while a read is under way, once more after it. */
  function read() {
    if (reading) {
      return (next ??= reading.then(() => {
        next = undefined;
        return read();
      }));
    }
    reading = monitor.refresh().then(
      (s) => {
        snap = s;
        lastError = '';
      },
      (e) => {
        const message = `could not read: ${clean(/** @type {Error} */ (e).message)}`;
        if (message !== lastError) log(message);
        lastError = message;
        for (const p of pages.values()) p.viewer.say(message);
      },
    ).finally(() => {
      readAt = Date.now();
      reading = undefined;
    });
    return reading;
  }

  /** The read under way, or one started when the last is older than the interval. */
  function current() {
    if (reading) return reading;
    return Date.now() - readAt >= intervalMs ? read() : Promise.resolve();
  }

  /** The agents in the pages' details: their transcripts are read, done or not. */
  function focusAll() {
    monitor.focus = new Set([...pages.values()].flatMap((p) => p.viewer.focus ?? []));
  }

  /**
   * The page with this ID, made when new. The pages that stopped asking a while ago are
   * forgotten, and when there are too many, the one that asked longest ago.
   * @param {string} id
   * @param {string} from the address it asked from
   * @returns {Page}
   */
  function pageFor(id, from) {
    const now = Date.now();
    let page = pages.get(id);
    pages.delete(id);
    let dropped = false;
    for (const [k, p] of pages) {
      if (now - p.seen < pageTtlMs && pages.size < maxPages) break;
      pages.delete(k);
      dropped = true;
    }
    if (!page) {
      const made = /** @type {Page} */ ({ seen: now, read: false });
      made.viewer = new Viewer({
        monitor,
        t,
        agents,
        showEnded,
        bell,
        refresh: () => {
          made.read = true;
        },
        onFocus: (key) => {
          focusAll();
          if (key?.startsWith('a:')) made.read = true;
        },
      });
      page = made;
      log(`${clock(now, now)}  page opened from ${from}`);
    }
    page.seen = now;
    pages.set(id, page);
    if (dropped) focusAll();
    return page;
  }

  /** The page's title: how many sessions wait for you, and this computer's name. */
  function title() {
    const waiting = snap?.rows.filter((r) => r.state === 'waiting' || r.blocked).length ?? 0;
    return `${waiting ? `(${waiting}) ` : ''}Claude agents on ${clean(hostname())}`;
  }

  /**
   * A page's screen, after what it sent: ?page=<id>&w=<columns>&h=<lines>&i=<input>&i=...
   * Its title, whether its bell is on and rings now, and its lines, with where the keys on them
   * are and the filter, and whether it is being typed; with quiet=1, for a page out of sight,
   * all but the lines and what goes with them.
   * @param {Request} req
   * @param {Response} res
   * @param {URLSearchParams} query
   */
  async function screen(req, res, query) {
    const id = query.get('page') ?? '';
    const sent = query.getAll('i');
    const inputs = sent.map(parseInput);
    if (!PAGE.test(id) || sent.length > MAX_INPUTS || inputs.includes(undefined)) return send(req, res, 400, 'bad request\n', TEXT);
    const page = pageFor(id, address(req));
    const view = page.viewer;
    // What it sent acts on the screen it was last sent.
    for (const input of /** @type {Input[]} */ (inputs)) {
      if ('filter' in input) view.typeFilter(input.filter);
      else if ('drag' in input) view.drag(input.drag === 'up');
      else if (input.mouse) view.mouse(input.mouse);
      else view.key(input);
    }
    await current();
    if (page.read) {
      page.read = false;
      await read();
    }
    /**
     * @type {{ title: string, bell: boolean, ring: boolean, lines?: Run[][], keys?: [number, number, number, string][],
     *   filter?: string, typing?: boolean }}
     */
    const answer = { title: title(), bell: view.ui.bell, ring: snap ? view.rings(snap) : false };
    if (query.get('quiet') !== '1') {
      const width = number(query.get('w'), 20, 500, 80);
      const height = number(query.get('h'), 5, 200, 24);
      answer.lines = view.lines(snap, { width, height, now: Date.now() }).map(runs);
      // Where a click presses a key ([line, from column, up to column, key]), and the filter: a
      // phone shows its keyboard only for a tap, so the page opens it at a tap on / itself.
      answer.keys = view.hits.flatMap((h) => ('key' in h.action ? [/** @type {[number, number, number, string]} */ ([h.y, h.x0, h.x1, h.action.key])] : []));
      answer.filter = view.ui.filter;
      answer.typing = view.ui.editingFilter;
    }
    send(req, res, 200, JSON.stringify(answer), 'application/json; charset=utf-8');
  }

  /**
   * @param {Request} req
   * @param {Response} res
   */
  async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'only GET and HEAD\n', TEXT, { Allow: 'GET, HEAD' });
    // The path and the query taken apart by hand: read as a URL, a path that begins with // would
    // be a host.
    const target = req.url ?? '';
    const q = target.indexOf('?');
    const [, first = '', ...rest] = (q < 0 ? target : target.slice(0, q)).split('/');
    const given = Buffer.from(first);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return send(req, res, 404, 'not found\n', TEXT);
    if (!rest.length) return send(req, res, 302, '', TEXT, { Location: `/${token}/` });
    const name = rest.join('/');
    if (name === 'screen') return screen(req, res, new URLSearchParams(q < 0 ? '' : target.slice(q + 1)));
    const file = files.get(name);
    if (!file) return send(req, res, 404, 'not found\n', TEXT);
    send(req, res, 200, file.body, file.type);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`error: ${clean(/** @type {Error} */ (e).message)}`);
      if (res.headersSent) res.destroy();
      else send(req, res, 500, 'error\n', TEXT);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  server.on('error', (e) => log(`error: ${clean(e.message)}`));
  // Ready for the first page.
  read();
  return {
    port: /** @type {import('node:net').AddressInfo} */ (server.address()).port,
    token,
    snapshot: async () => {
      await current();
      return snap;
    },
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

/**
 * @param {Request} req
 * @param {Response} res
 * @param {number} status
 * @param {string | Buffer} body
 * @param {string} type
 * @param {Record<string, string>} [extra] more headers
 */
function send(req, res, status, body, type, extra = {}) {
  const data = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { ...HEADERS, 'Content-Type': type, 'Content-Length': String(data.length), ...extra });
  res.end(req.method === 'HEAD' ? undefined : data);
}

/**
 * Where a request came from: an IPv4 address without the IPv6 form it can come in.
 * @param {Request} req
 */
function address(req) {
  return clean(req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '');
}

/**
 * A whole number from a query, kept from `lo` to `hi`; `fallback` when there is none.
 * @param {string | null} text
 * @param {number} lo
 * @param {number} hi
 * @param {number} fallback
 */
function number(text, lo, hi, fallback) {
  const n = Number.parseInt(text ?? '', 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

/**
 * One thing a page sent: 'k:<name>' a key by its name, 'c:<character>' a character typed,
 * 'm:<x>,<y>' a click on a cell and 'd:<x>,<y>' the second click of a double click, 'w:up' or
 * 'w:down' a turn of the wheel, 't:up' or 't:down' a finger dragged a line's height, 'f:<text>'
 * the filter as typed so far in the page's text field. Undefined for anything else.
 * @param {string} input
 * @returns {Input | undefined}
 */
export function parseInput(input) {
  const kind = input.slice(0, 2);
  const value = input.slice(2);
  /** @type {(button: Mouse['button'], x?: number, y?: number, double?: boolean) => Key} */
  const mouse = (button, x = 0, y = 0, double = false) => ({ name: 'mouse', mouse: { button, x, y, release: false, motion: false, double } });
  switch (kind) {
    case 'k:':
      return KEYS.has(value) ? { name: value } : undefined;
    case 'c:':
      return typed(value) ? { name: value, ch: value } : undefined;
    case 'm:':
    case 'd:': {
      const m = /^(\d{1,4}),(\d{1,4})$/.exec(value);
      return m ? mouse('left', Number(m[1]), Number(m[2]), kind === 'd:') : undefined;
    }
    case 'w:':
      return value === 'up' || value === 'down' ? mouse(value === 'up' ? 'wheelup' : 'wheeldown') : undefined;
    case 't:':
      return value === 'up' || value === 'down' ? { drag: value } : undefined;
    case 'f:':
      return { filter: typedText(value) };
  }
  return undefined;
}

/**
 * Whether `s` is one character a key types: a space, or one grapheme with no control in it.
 * @param {string} s
 */
function typed(s) {
  return s === ' ' || (s !== '' && s.length <= 16 && clean(s) === s && graphemes(s).length === 1);
}

/**
 * Text typed in a text field, as the characters keys type: other spaces (a tab, a no-break
 * space) made spaces, and controls left out; MAX_FILTER characters at most.
 * @param {string} s
 */
function typedText(s) {
  return graphemes(s).slice(0, MAX_FILTER).map(([g]) => (typed(g) ? g : /^\s+$/.test(g) ? ' ' : '')).join('');
}

const SGR = /\x1b\[([0-9;]*)m/g;
/** @type {Record<number, string>} */
const COLORS = { 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan' };
const ASCII = /^[\x20-\x7e]*$/;

/**
 * A line drawn for a terminal, as runs for the page: its text in pieces of one style, with the
 * styles (SGR) made classes: b bold, d dim, i inverse, and the colors. Characters outside ASCII
 * are runs of their own, one for each character and the same ones after it, with the columns
 * they take: the page gives them a box that wide, since a font without them draws them from
 * another font, at its width.
 * @param {string} line
 * @returns {Run[]}
 */
export function runs(line) {
  /** @type {Run[]} */
  const out = [];
  let bold = false;
  let dim = false;
  let inverse = false;
  let color = '';
  let at = 0;
  const flush = (/** @type {string} */ text) => {
    if (text) pieces(text, [bold && 'b', dim && 'd', inverse && 'i', color].filter(Boolean).join(' '), out);
  };
  for (const m of line.matchAll(SGR)) {
    flush(line.slice(at, m.index));
    at = m.index + m[0].length;
    for (const code of (m[1] || '0').split(';').map(Number)) {
      if (code === 0) [bold, dim, inverse, color] = [false, false, false, ''];
      else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 7) inverse = true;
      else if (COLORS[code]) color = COLORS[code];
    }
  }
  flush(line.slice(at));
  return out;
}

/**
 * Text in one style as runs: printable ASCII together, and each other character with the same
 * ones after it.
 * @param {string} text
 * @param {string} cls
 * @param {Run[]} out
 */
function pieces(text, cls, out) {
  const plain = (/** @type {string} */ s) => {
    if (s) out.push(cls ? [s, cls] : [s]);
  };
  if (ASCII.test(text)) return plain(text);
  let ascii = '';
  /** @type {[string, number, number] | undefined} a character, its columns, how many in a row */
  let run;
  const end = () => {
    if (run) out.push([run[0].repeat(run[2]), cls, run[1] * run[2]]);
    run = undefined;
  };
  for (const [g, w] of graphemes(text)) {
    if (ASCII.test(g)) {
      end();
      ascii += g;
      continue;
    }
    plain(ascii);
    ascii = '';
    if (run && run[0] !== g) end();
    if (run) run[2]++;
    else run = [g, w, 1];
  }
  end();
  plain(ascii);
}

/** The MACs of virtual networks' adapters, by their makers' prefixes: Hyper-V's (WSL's too), VMware's, VirtualBox's, Parallels', Docker's, QEMU's and Xen's. */
const VIRTUAL_MAC = /^(?:00:15:5d|00:50:56|00:0c:29|00:05:69|00:1c:14|0a:00:27|08:00:27|00:1c:42|02:42|52:54:00|00:16:3e)/i;

/**
 * The addresses to open the web view at: the one it listens on, or when that is every
 * interface, each of this computer's network addresses, and its own. The likeliest for a phone
 * on the same Wi-Fi come first: a virtual network's last (this computer's side of one mostly ends
 * in .1, as WSL's, Hyper-V's or Docker's, and a hypervisor's adapter has its maker's MAC), and
 * before them a home network's 192.168..., then 10..., then 172.16 to 172.31, then the rest.
 * @param {string} host as listened on
 * @param {number} port
 * @param {string} token
 * @param {ReturnType<typeof networkInterfaces>} [nets]
 * @returns {string[]}
 */
export function urls(host, port, token, nets = networkInterfaces()) {
  const url = (/** @type {string} */ h) => `http://${h.includes(':') ? `[${h}]` : h}:${port}/${token}/`;
  if (host !== '0.0.0.0' && host !== '::' && host !== '') return [url(host)];
  /** @type {Map<string, number>} each address, and its rank: the lower, the likelier */
  const own = new Map();
  for (const n of Object.values(nets).flatMap((list) => list ?? [])) {
    const a = n.address;
    if (n.family !== 'IPv4' || n.internal || own.has(a)) continue;
    const kind = a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : /^172\.(?:1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3;
    own.set(a, (a.endsWith('.1') ? 8 : 0) + (VIRTUAL_MAC.test(n.mac ?? '') ? 4 : 0) + kind);
  }
  return [...[...own].sort((a, b) => a[1] - b[1]).map(([a]) => url(a)), url('127.0.0.1')];
}

/**
 * What --serve prints once it listens: its addresses; the first as a QR code, for a phone's
 * camera, unless only this computer can open it or there are no colors to draw it in; and what
 * to know.
 * @param {string} host as listened on
 * @param {string[]} list its addresses, as urls() gives them
 * @param {{ color: boolean, ascii: boolean, windows: boolean }} opts
 * @returns {string}
 */
export function banner(host, list, { color, ascii, windows }) {
  const local = /^(?:127\.|::1$|localhost$)/.test(host);
  const lines = ['The web view, read only, at:', ...list.map((u) => `  ${u}`)];
  const code = color && list.length && !/^http:\/\/(?:127\.|\[::1\]|localhost:)/.test(list[0]) ? qr(list[0]) : undefined;
  if (code) lines.push(`A phone's camera opens ${list.length > 1 ? 'the first' : 'it'} from this code:`, ...qrLines(code, { ascii }).map((l) => `  ${l}`));
  lines.push(local ? 'Only this computer can open it; with --host 0.0.0.0, the others on its networks can too.' : 'Anyone with the address sees what it shows.');
  if (!local && windows) lines.push('Windows can ask whether Node.js may take connections: other computers reach it once allowed.');
  lines.push('Ctrl+C stops it.');
  return lines.map((l) => `${l}\n`).join('');
}
