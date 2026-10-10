'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Append-only file logger with one rotation (`<name>.log` -> `<name>.old.log`)
 * when the file passes MAX_BYTES. Never throws: logging must not take the
 * application down.
 * @param {string} directory
 * @param {string} name
 */
function createLogger(directory, name) {
  const file = path.join(directory, `${name}.log`);
  let ready = false;
  const prepare = () => {
    if (ready) return true;
    try {
      fs.mkdirSync(directory, { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
        fs.renameSync(file, path.join(directory, `${name}.old.log`));
      }
      ready = true;
    } catch {
      ready = false;
    }
    return ready;
  };
  const write = (level, message) => {
    if (!prepare()) return;
    try {
      fs.appendFileSync(
        file,
        `${new Date().toISOString()} ${level} ${message}\n`,
      );
    } catch {
      // Best effort.
    }
  };
  return {
    file,
    info: (message) => write('INFO', message),
    error: (message) => write('ERROR', message),
    raw: (chunk) => write('OUT ', String(chunk).replace(/\s+$/, '')),
  };
}

module.exports = { createLogger };
