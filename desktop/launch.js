// What starts the agentmonitor app with no terminal, where it is not a Windows shortcut (main.js
// makes those with Electron): on Linux, a desktop entry, in the applications menu, and with
// --hidden in the autostart folder, to start in the tray at login. For the Windows shortcut, the
// CLSID of the notifications' activator, and which shortcuts Electron's notifications wrote of
// their own. Pure, so the tests can tell.
import { createHash } from 'node:crypto';

/** The namespace of the app's name-based UUIDs. */
const NAMESPACE = '5d0653aa-c1dd-42fe-baef-3123e11ecad6';

/**
 * A freedesktop.org desktop entry that runs `command`.
 * @param {string[]} command the program and its arguments
 * @param {string} icon the path of a PNG
 */
export function desktopEntry(command, icon) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=agentmonitor',
    'Comment=The Claude agents on this computer',
    `Exec=${value(command.map(execArg).join(' '))}`,
    `Icon=${value(icon)}`,
    'Terminal=false',
    'Categories=Development;Utility;',
    '',
  ].join('\n');
}

/**
 * An argument in Exec: % doubled (it begins a field code), and quoted when it holds a space or
 * anything else the spec reserves, with ", `, $ and \ escaped in the quotes.
 * @param {string} arg
 */
function execArg(arg) {
  const s = arg.replace(/%/g, '%%');
  return s && !/[\s"'\\><~|&;$*?#()`]/.test(s) ? s : `"${s.replace(/["`$\\]/g, '\\$&')}"`;
}

/**
 * A string value: a backslash escaped (so one in quotes takes four), and the characters a line
 * can't hold.
 * @param {string} s
 */
function value(s) {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

/**
 * The CLSID of the activator of the app's notifications on Windows, for its Start menu shortcut:
 * a UUID of version 5 from its ID, the same from one run to the next. Electron's notifications
 * want a shortcut named after the program's product name, with the app's ID and an activator's
 * CLSID, and take the CLSID of the one there as theirs, which they register; packaged, that
 * shortcut is the app's own, and with this CLSID they leave it as it is, where without one they
 * would write it again, without its icon, and register a new CLSID, in each run.
 * @param {string} id
 * @returns {string} in braces, as Electron's writeShortcutLink takes it
 */
export function toastClsidOf(id) {
  const hash = createHash('sha1').update(Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex')).update(id, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex', 0, 16).toUpperCase();
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`;
}

/**
 * @typedef {object} Shortcut a Start menu shortcut, as Electron's readShortcutLink reads it
 * @property {string} path
 * @property {string} [target]
 * @property {string} [args]
 * @property {string} [appUserModelId]
 */

/**
 * The shortcuts that Electron's notifications wrote of their own for the app where it is not
 * packaged: with its ID, of its program alone, no arguments, and not its own. They name theirs
 * after the program's product name, Electron. The Start menu lists one shortcut for an ID, one
 * with no arguments before one with them, else the first by name, and leaves hidden ones out; the
 * app's own, not packaged, has its folder as an argument, so the Start menu lists theirs for the
 * app, as Electron, and a taskbar that combines its buttons shows its icon, Electron's.
 * @param {Shortcut[]} links
 * @param {string} own the app's own shortcut
 * @param {string} program the program that runs the app
 * @param {string} id the app's ID
 * @returns {string[]} their paths
 */
export function electronShortcuts(links, own, program, id) {
  const same = (/** @type {string | undefined} */ a, /** @type {string} */ b) => (a ?? '').toLowerCase() === b.toLowerCase();
  return links.filter((l) => l.appUserModelId === id && same(l.target, program) && !l.args && !same(l.path, own)).map((l) => l.path);
}
