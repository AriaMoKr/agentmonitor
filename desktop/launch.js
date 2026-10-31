// What starts the agentmonitor app with no terminal, where it is not a Windows shortcut (main.js
// makes those with Electron): on Linux, a desktop entry, in the applications menu, and with
// --hidden in the autostart folder, to start in the tray at login. Pure, so the tests can tell.

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
