// Linux autostart (XDG autostart .desktop entry) helpers.
//
// Electron's app.setLoginItemSettings() only works on Windows and macOS. On
// Linux the standard mechanism is a .desktop file in
//   $XDG_CONFIG_HOME/autostart  (usually ~/.config/autostart)
// This module keeps the entry-building logic pure and testable; main.cjs does
// the actual filesystem writes at runtime (the app writing its own autostart
// preference is a settings action, never an action on analyzed data).
'use strict';

const path = require('node:path');
const os = require('node:os');

const AUTOSTART_FILE_NAME = 'inspect-it.desktop';
const ENABLED_MARKER = 'X-GNOME-Autostart-enabled=true';

/** Directory for XDG autostart entries (honors $XDG_CONFIG_HOME). */
function autostartDir(env = process.env, homedir = os.homedir()) {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg && xdg.trim() ? path.join(xdg, 'autostart') : path.join(homedir, '.config', 'autostart');
}

/** Full path to this app's autostart entry. */
function autostartFilePath(dir) {
  return path.join(dir, AUTOSTART_FILE_NAME);
}

/**
 * Build the .desktop entry content. execPath must be a shell-escaped absolute
 * path to the AppImage or installed binary; it is quoted inside the file.
 */
function buildAutostartDesktopEntry(execPath, options = {}) {
  const name = options.name || 'Inspect It';
  const comment = options.comment || 'Drop anything. Understand it.';
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name}`,
    `Comment=${comment}`,
    `Exec="${execPath}"`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n');
}

/** True when an existing entry has not been disabled by the user. */
function isEntryEnabled(content) {
  return typeof content === 'string' && content.includes(ENABLED_MARKER) && !/^Hidden=true$/m.test(content);
}

module.exports = {
  AUTOSTART_FILE_NAME,
  autostartDir,
  autostartFilePath,
  buildAutostartDesktopEntry,
  isEntryEnabled
};
