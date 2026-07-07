import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Write a file atomically: write to `<path>.tmp`, then rename over the target.
 * The rename is atomic on the same volume, so a crash / Ctrl+C / disk-full
 * mid-write can truncate only the .tmp file — never the real one. Used for the
 * accumulated state files (geocode cache, TABS detail cache, history) and the
 * published outputs, all of which are expensive or impossible to rebuild.
 */
export function writeFileAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/**
 * Load a JSON state file. A *missing* file is a normal first run → fallback.
 * A file that exists but doesn't parse is corrupt accumulated state; returning
 * the fallback would silently wipe it on the next save, so fail loudly instead.
 */
export function loadStateFile(path, fallback = {}) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return fallback; // doesn't exist yet
  }
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${path} exists but is not valid JSON (${err.message}). ` +
        `Refusing to run and overwrite accumulated state — restore it (e.g. git checkout) or delete it to start fresh.`
    );
  }
}
