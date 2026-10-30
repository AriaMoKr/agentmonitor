// Reading folders that other programs change while they are read: a missing folder or file is
// empty rather than an error, and a JSON file is parsed again only when it changed.
import { readdir, readFile, stat } from 'node:fs/promises';

/**
 * The entries of a folder; none when it is missing or unreadable.
 * @param {string} dir
 */
export async function entries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * A file's stats, or null when it is missing.
 * @param {string} path
 */
export async function statOf(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/** Parsed JSON files, read again only when their size or modification time changes. */
export class JsonFiles {
  constructor() {
    /** @type {Map<string, { size: number, mtimeMs: number, value: any, used: boolean }>} */
    this.cache = new Map();
  }

  /**
   * The parsed file; null when it is missing or was never readable, and the last good value
   * while it is being rewritten.
   * @param {string} path
   * @param {{ size: number, mtimeMs: number } | null} [st] its stats, when already known
   * @returns {Promise<any>}
   */
  async read(path, st) {
    st = st ?? (await statOf(path));
    if (!st) {
      this.cache.delete(path);
      return null;
    }
    const hit = this.cache.get(path);
    if (hit) hit.used = true;
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value;
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      this.cache.set(path, { size: st.size, mtimeMs: st.mtimeMs, value, used: true });
      return value;
    } catch {
      return hit ? hit.value : null;
    }
  }

  /** Forgets the files not read since the last sweep. */
  sweep() {
    for (const [path, hit] of this.cache) {
      if (!hit.used) this.cache.delete(path);
      else hit.used = false;
    }
  }
}

/** Text files split into lines, read again only when they change (for small append-only logs). */
export class TextFiles {
  constructor() {
    /** @type {Map<string, { size: number, mtimeMs: number, lines: string[], used: boolean }>} */
    this.cache = new Map();
  }

  /**
   * The file's lines; none when it is missing.
   * @param {string} path
   * @param {{ size: number, mtimeMs: number } | null} [st]
   * @returns {Promise<string[]>}
   */
  async lines(path, st) {
    st = st ?? (await statOf(path));
    if (!st) {
      this.cache.delete(path);
      return [];
    }
    const hit = this.cache.get(path);
    if (hit) hit.used = true;
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.lines;
    try {
      const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
      this.cache.set(path, { size: st.size, mtimeMs: st.mtimeMs, lines, used: true });
      return lines;
    } catch {
      return hit ? hit.lines : [];
    }
  }

  /** Forgets the files not read since the last sweep. */
  sweep() {
    for (const [path, hit] of this.cache) {
      if (!hit.used) this.cache.delete(path);
      else hit.used = false;
    }
  }
}
