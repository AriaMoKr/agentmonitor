// agentmonitor's version, as the package.json beside src/ says it: the repository's in a checkout,
// and in a release the manifest desktop/build.js writes in resources/app, of the version its
// program carries. The help's first line, --version and the agentmonitor app's tray tooltip give
// it. Read once, as the module loads.
import { readFileSync } from 'node:fs';

/**
 * The version a package.json gives; '' where it can't be read, or what it says is not a version's
 * characters alone (it is drawn on the screen).
 * @param {URL | string} path
 */
export function versionAt(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))?.version;
    return typeof v === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(v) ? v : '';
  } catch {
    return '';
  }
}

/** agentmonitor's version, such as 0.2.6; '' where its package.json is not at hand. */
export const VERSION = versionAt(new URL('../package.json', import.meta.url));
