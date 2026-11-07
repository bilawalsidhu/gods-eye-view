import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const FOLDER_NAME = 'GEV History';
const LABEL_TTL_MS = 5 * 60 * 1000;
const lookups = new Map();
const names = new Map();
const driveLetter = (dir) =>
  path.parse(path.resolve(dir)).root.slice(0, 1).toUpperCase();

/** The folder name that labels a volume on Mac and Linux, else null. */
export function mountName(dir, platform = process.platform) {
  const parts = String(dir)
    .split(/[\\/]+/)
    .filter(Boolean);
  if (platform === 'darwin' && parts[0] === 'Volumes') return parts[1] ?? null;
  if (platform !== 'linux') return null;
  if (parts[0] === 'media') return parts[2] ?? null;
  if (parts[0] === 'run' && parts[1] === 'media') return parts[3] ?? null;
  if (parts[0] === 'mnt') return parts[1] ?? null;
  return null;
}

/**
 * The name a person gave a drive ("Backup"), or '' when it has none or cannot
 * be read. Windows is asked once per drive and the answer is kept for a few
 * minutes, so a status poll never waits on it.
 */
export function volumeLabel(dir, { platform = process.platform } = {}) {
  if (platform !== 'win32')
    return Promise.resolve(mountName(dir, platform) ?? '');
  const letter = driveLetter(dir);
  if (!/^[A-Z]$/.test(letter)) return Promise.resolve('');
  const hit = lookups.get(letter);
  if (hit && Date.now() - hit.at < LABEL_TTL_MS) return hit.promise;
  const promise = new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `([System.IO.DriveInfo]'${letter}').VolumeLabel`,
      ],
      { timeout: 4000, windowsHide: true },
      (error, stdout) => {
        const name = error ? '' : String(stdout).trim();
        names.set(letter, name);
        resolve(name);
      },
    );
  });
  lookups.set(letter, { at: Date.now(), promise });
  return promise;
}

/**
 * How to name a folder's drive for a person, without waiting: "D: Backup" on
 * Windows, the volume name on Mac and Linux, '' for the system disk. Starts a
 * lookup, so the name appears from the second poll.
 */
export function peekVolumeLabel(dir, { platform = process.platform } = {}) {
  volumeLabel(dir, { platform });
  if (platform !== 'win32') return mountName(dir, platform) ?? '';
  const name = names.get(driveLetter(dir)) ?? '';
  return `${driveLetter(dir)}:${name ? ` ${name}` : ''}`;
}

function space(dir) {
  try {
    const info = statfsSync(dir);
    return {
      freeBytes: Number(info.bavail) * Number(info.bsize),
      totalBytes: Number(info.blocks) * Number(info.bsize),
    };
  } catch {
    return null;
  }
}

/**
 * Places a recording could go: every other drive or mounted volume, with its
 * space. `main` marks the one the recording is on now.
 */
export function listDrives({
  mainDir,
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  const main = path.resolve(mainDir ?? '.');
  let mainDevice = null;
  try {
    mainDevice = statSync(main).dev;
  } catch {
    // The main folder does not exist yet.
  }
  const found = [];
  const add = (root, label) => {
    const info = space(root);
    if (!info) return;
    let isMain;
    if (platform === 'win32')
      isMain =
        path.parse(root).root.toLowerCase() ===
        path.parse(main).root.toLowerCase();
    else {
      try {
        isMain = statSync(root).dev === mainDevice;
      } catch {
        isMain = false;
      }
    }
    found.push({
      path: path.join(root, FOLDER_NAME),
      label,
      ...info,
      main: isMain,
    });
  };
  if (platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ')
      add(`${letter}:${path.sep}`, `${letter}:`);
  } else {
    const user = path.basename(home);
    const parents =
      platform === 'darwin'
        ? ['/Volumes']
        : [path.join('/media', user), path.join('/run/media', user), '/mnt'];
    for (const parent of parents) {
      let names = [];
      try {
        names = readdirSync(parent);
      } catch {
        continue;
      }
      for (const name of names) {
        const root = path.join(parent, name);
        try {
          if (statSync(root).isDirectory()) add(root, name);
        } catch {
          // A volume that went away while listing.
        }
      }
    }
  }
  return found;
}

/**
 * Checks a folder for recording: it must be an absolute path, exist (or sit
 * directly inside a folder that does, so a missing drive is never "created"
 * on the main disk), and accept a file. Returns { ok, path, freeBytes, error }.
 */
export function checkFolder(input) {
  const text = String(input ?? '').trim();
  if (!text || !path.isAbsolute(text))
    return {
      ok: false,
      error: 'Give the full path of a folder, such as E:\\GEV History',
    };
  const folder = path.resolve(text);
  try {
    let exists = true;
    try {
      exists = statSync(folder).isDirectory();
      if (!exists)
        return { ok: false, error: 'That path is a file, not a folder' };
    } catch {
      exists = false;
    }
    if (!exists) {
      const parent = path.dirname(folder);
      let parentOk = false;
      try {
        parentOk = statSync(parent).isDirectory();
      } catch {
        // Not there.
      }
      if (!parentOk || parent === folder)
        return {
          ok: false,
          error:
            'The drive or parent folder was not found. Is the drive plugged in?',
        };
      mkdirSync(folder);
    }
    const probe = path.join(folder, `.gev-write-test-${process.pid}`);
    writeFileSync(probe, 'x');
    rmSync(probe);
  } catch (error) {
    return {
      ok: false,
      error: `Cannot write there: ${error.code || error.message}`,
    };
  }
  return {
    ok: true,
    path: folder,
    freeBytes: space(folder)?.freeBytes ?? null,
  };
}

/** The database file for a chosen folder. */
export const historyFileIn = (folder) => path.join(folder, 'history.sqlite');
