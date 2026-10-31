// The web view's page: asks the server for the screen every second, at the size the window
// holds, and draws its lines; sends it the keys typed, the clicks and the wheel, which the
// server's view of this page answers; and beeps when the server says its bell rings. What the
// server sends goes in as text, never as markup.

/** Keys by their names in a KeyboardEvent, as the monitor names them. */
const KEYS = new Map([
  ['ArrowUp', 'up'], ['ArrowDown', 'down'], ['ArrowLeft', 'left'], ['ArrowRight', 'right'],
  ['Home', 'home'], ['End', 'end'], ['PageUp', 'pageup'], ['PageDown', 'pagedown'],
  ['Enter', 'enter'], ['Escape', 'escape'], ['Backspace', 'backspace'], ['Delete', 'delete'],
]);
/** How far the wheel turns for a step, in pixels: a notch is about 100 in most browsers. */
const WHEEL_STEP = 50;
/**
 * How often the page asks while it is in sight (ms); and while it is out of sight, for its title
 * and its bell only.
 */
const EVERY = 1000;
const HIDDEN_EVERY = 3000;
/** How soon it asks again when the server could not be reached, or answered with an error. */
const RETRY = 3000;
/** The most inputs one request sends, as the server takes them. */
const MAX_INPUTS = 64;
/** What the bell needs, said while it is on and the browser has not let the page sound yet. */
const HINT = 'The bell rings once you click or press a key on this page.';

/**
 * What a key sends: 'k:<name>' for a key with a name, 'c:<character>' for one that types;
 * undefined for a key left to the browser: one with Ctrl, Alt or Cmd (but AltGr, which types).
 * @param {{ key: string, shiftKey?: boolean, ctrlKey?: boolean, altKey?: boolean, metaKey?: boolean, altGraph?: boolean, isComposing?: boolean }} e
 * @returns {string | undefined}
 */
export function keyInput(e) {
  if (e.isComposing) return undefined;
  if ((e.ctrlKey || e.altKey || e.metaKey) && !e.altGraph) return undefined;
  if (e.key === 'Tab') return e.shiftKey ? 'k:backtab' : 'k:tab';
  const name = KEYS.get(e.key);
  if (name) return `k:${name}`;
  // A key that types gives its character; the others give names: 'Shift', 'F5', 'Dead'.
  return [...e.key].length === 1 ? `c:${e.key}` : undefined;
}

/**
 * The cell at a point.
 * @param {number} x
 * @param {number} y the point, from the screen's top left
 * @param {{ w: number, h: number }} cell a cell's size
 */
export function cellAt(x, y, cell) {
  return { x: Math.max(0, Math.floor(x / cell.w)), y: Math.max(0, Math.floor(y / cell.h)) };
}

/**
 * A turn of the wheel as steps of WHEEL_STEP pixels, with what was left over from before.
 * @param {number} rest what was left over
 * @param {number} delta the event's deltaY
 * @param {number} mode its deltaMode: pixels (0), lines (1) or pages (2)
 * @param {number} line a line's height in pixels
 * @param {number} page a page's
 * @returns {[number, number]} the steps (up is less than 0), and what is left over
 */
export function wheelSteps(rest, delta, mode, line, page) {
  const px = rest + delta * (mode === 1 ? line : mode === 2 ? page : 1);
  const steps = Math.trunc(px / WHEEL_STEP);
  return [steps, px - steps * WHEEL_STEP];
}

/**
 * A run of a line as a node: its text, and in a span, its classes and the box that characters
 * outside ASCII get. Only ever text: what the server sends is never read as markup.
 * @param {Document} doc
 * @param {unknown} run [text, classes, columns]
 * @returns {Node}
 */
export function runNode(doc, run) {
  const [text, cls, cols] = Array.isArray(run) ? run : [];
  const t = typeof text === 'string' ? text : '';
  if (!cls && typeof cols !== 'number') return doc.createTextNode(t);
  const span = doc.createElement('span');
  if (typeof cls === 'string') span.className = cls;
  if (typeof cols === 'number') {
    span.classList.add('cell');
    span.style.width = `${cols}ch`;
  }
  span.textContent = t;
  return span;
}

/**
 * The bell: a short tone, on a sound that a click or a key let play.
 * @param {AudioContext} audio
 */
export function beep(audio) {
  const at = audio.currentTime;
  const tone = audio.createOscillator();
  const gain = audio.createGain();
  tone.frequency.value = 880;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.2, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.4);
  tone.connect(gain).connect(audio.destination);
  tone.start(at);
  tone.stop(at + 0.45);
}

/** A random ID for this page, which its tab keeps across reloads. */
function pageId() {
  try {
    const kept = sessionStorage.getItem('agentmonitor-page');
    if (kept && /^[A-Za-z0-9_-]{8,40}$/.test(kept)) return kept;
  } catch {
    // No storage: a new view on each load.
  }
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    sessionStorage.setItem('agentmonitor-page', id);
  } catch {
    // As above.
  }
  return id;
}

function start() {
  const screen = /** @type {HTMLElement} */ (document.getElementById('screen'));
  const banner = /** @type {HTMLElement} */ (document.getElementById('banner'));
  const probe = /** @type {HTMLElement} */ (document.getElementById('probe'));
  const id = pageId();
  let cell = { w: 8, h: 17.5 };
  let size = { w: 80, h: 24 };
  /** @type {string[]} what was typed, clicked and turned, not sent yet */
  const queue = [];
  /** @type {string[]} the lines on the screen, as they came */
  const drawn = [];
  /** @type {unknown[] | undefined} lines that came while text was selected, drawn once it is not */
  let held;
  /** @type {AudioContext | undefined} the bell's sound, made at a click or a key */
  let audio;
  /** whether the server says this page's bell is on */
  let bellOn = false;
  /** why the server can't be asked, said at the bottom */
  let error = '';
  let wheel = 0;
  let busy = false;
  let again = false;
  let gone = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  /** The size of a cell, and how many columns and lines the window holds. */
  function measure() {
    const r = probe.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) cell = { w: r.width / 10, h: r.height };
    size = { w: Math.floor(screen.clientWidth / cell.w), h: Math.floor(screen.clientHeight / cell.h) };
  }

  const selecting = () => {
    const s = document.getSelection();
    return Boolean(s && !s.isCollapsed);
  };

  /** Says the error at the bottom, or else what the bell needs. */
  function note() {
    const text = error || (bellOn && audio?.state !== 'running' ? HINT : '');
    banner.textContent = text;
    banner.hidden = !text;
    banner.classList.toggle('note', !error);
  }

  /** Readies the bell's sound: a browser lets a page make one only after a click or a key on it. */
  function unlock() {
    if (audio?.state === 'running') return;
    try {
      audio ??= new AudioContext();
      audio.resume().then(note, () => {});
    } catch {
      // No sound in this browser.
    }
  }

  /**
   * Takes the server's answer: the title and the bell at once, the lines unless text is
   * selected, when the screen holds still so that the selection stays.
   * @param {unknown} data { title, bell, ring, lines }
   */
  function take(data) {
    const { title, bell, ring, lines } = /** @type {Record<string, unknown>} */ (data ?? {});
    if (typeof title === 'string') document.title = title;
    bellOn = bell === true;
    if (ring === true && audio?.state === 'running') beep(audio);
    if (!Array.isArray(lines)) return;
    if (selecting()) held = lines;
    else draw(lines);
  }

  /** Draws the lines that changed. @param {unknown[]} lines */
  function draw(lines) {
    held = undefined;
    lines.forEach((line, y) => {
      const json = JSON.stringify(line);
      if (drawn[y] === json) return;
      drawn[y] = json;
      const div = screen.children[y] ?? screen.appendChild(document.createElement('div'));
      div.replaceChildren(...(Array.isArray(line) ? line : []).map((run) => runNode(document, run)));
    });
    while (screen.children.length > lines.length) screen.lastElementChild?.remove();
    drawn.length = lines.length;
  }

  /** Asks for the screen, with what is queued: one request at a time. */
  async function ask() {
    clearTimeout(timer);
    if (gone) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    again = false;
    const query = new URLSearchParams({ page: id, w: String(size.w), h: String(size.h) });
    // Out of sight, only the title and the bell.
    if (document.hidden) query.set('quiet', '1');
    for (const input of queue.splice(0, MAX_INPUTS)) query.append('i', input);
    let wait = document.hidden ? HIDDEN_EVERY : EVERY;
    try {
      const res = await fetch(`screen?${query}`, { cache: 'no-store' });
      if (res.status === 404) {
        gone = true;
        error = 'This address is not served any more: agentmonitor was stopped, or started again with another token.';
      } else if (!res.ok) {
        error = `agentmonitor answered ${res.status}; asking again.`;
        wait = RETRY;
      } else {
        take(await res.json());
        error = '';
      }
    } catch {
      error = 'agentmonitor cannot be reached; asking again.';
      wait = RETRY;
    }
    note();
    busy = false;
    if (gone) return;
    if (again || queue.length) ask();
    else timer = setTimeout(ask, wait);
  }

  /** @param {string} input */
  function send(input) {
    queue.push(input);
    ask();
  }

  // Any click or key on the page lets the bell sound.
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', (e) => {
    unlock();
    const input = keyInput({
      key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
      altGraph: e.getModifierState('AltGraph'), isComposing: e.isComposing,
    });
    if (!input) return;
    e.preventDefault();
    send(input);
  });
  // A double click selects a word, which would make it no click.
  screen.addEventListener('mousedown', (e) => {
    if (e.detail > 1) e.preventDefault();
  });
  screen.addEventListener('click', (e) => {
    // A drag that selected text is no click, nor is a third click.
    if (e.button !== 0 || e.detail > 2 || selecting()) return;
    const r = screen.getBoundingClientRect();
    const { x, y } = cellAt(e.clientX - r.left, e.clientY - r.top, cell);
    send(`${e.detail === 2 ? 'd' : 'm'}:${x},${y}`);
  });
  screen.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [steps, rest] = wheelSteps(wheel, e.deltaY, e.deltaMode, cell.h, screen.clientHeight);
    wheel = rest;
    for (let i = 0; i < Math.min(Math.abs(steps), 10); i++) queue.push(steps < 0 ? 'w:up' : 'w:down');
    if (steps) ask();
  }, { passive: false });
  document.addEventListener('selectionchange', () => {
    if (held && !selecting()) draw(held);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) ask();
  });
  window.addEventListener('resize', () => {
    measure();
    ask();
  });
  measure();
  ask();
  // The font can come after the first measure.
  document.fonts?.ready.then(() => {
    measure();
    ask();
  });
}

if (typeof document !== 'undefined') start();
