#!/usr/bin/env node
/**
 * npm run env:init — set up the two env files from .env.example, and move
 * every key out of .env into .env.local.
 *
 *   npm run env:init                 create .env.local (SECTION 1: SECRETS,
 *                                    owner-only) and .env (SECTION 2: SETTINGS)
 *                                    where missing, then move each key line
 *                                    found in .env into .env.local — into its
 *                                    placeholder, or appended if it has none
 *   npm run env:init -- --dry-run    show what would happen; write nothing
 *
 * The line with a value is the one kept; a blank placeholder never replaces a
 * value (rules: planSecretMigration() in src/secretEnv.mjs). Never prints a
 * value — only names. Keys are written to .env.local BEFORE they leave .env;
 * an existing file is rewritten in place (its owner, mode and any ACL stay)
 * with an owner-only recovery copy beside it until the write lands. Running it
 * again changes nothing.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from './project-root.mjs';
import {
  SECRETS_FILE,
  SETTINGS_FILE,
  envFilesFromTemplate,
  planSecretMigration,
} from '../src/secretEnv.mjs';

const TEMPLATE_FILE = '.env.example';

function list(names) {
  return names.length ? names.join(', ') : '(none)';
}

/** Create a file that must not exist yet; secrets owner-only. */
function createFile(filepath, text, mode) {
  writeFileSync(filepath, text, { flag: 'wx', mode });
}

/**
 * Rewrite an existing file in place — same inode, so its owner, mode and any
 * ACL stay — with an owner-only copy of the new text beside it until the
 * write has landed.
 */
function rewriteFile(filepath, text) {
  const recovery = `${filepath}.env-init-tmp`;
  writeFileSync(recovery, text, { mode: 0o600 });
  writeFileSync(filepath, text);
  unlinkSync(recovery);
}

export function runEnvInit({ root, argv = [], log = console.log } = {}) {
  const dryRun = argv.includes('--dry-run') || argv.includes('-n');
  const unknown = argv.filter((arg) => !['--dry-run', '-n'].includes(arg));
  if (unknown.length) {
    log(`env:init: unknown option ${unknown.join(' ')}`);
    log('usage: npm run env:init [-- --dry-run]');
    return 64;
  }
  const at = (name) => path.join(root, name);
  if (!existsSync(at(TEMPLATE_FILE))) {
    log(`env:init: ${TEMPLATE_FILE} not found in ${root}`);
    return 1;
  }
  const files = envFilesFromTemplate(readFileSync(at(TEMPLATE_FILE), 'utf8'));
  const localExists = existsSync(at(SECRETS_FILE));
  const envExists = existsSync(at(SETTINGS_FILE));
  const plan = planSecretMigration(
    envExists ? readFileSync(at(SETTINGS_FILE), 'utf8') : '',
    localExists ? readFileSync(at(SECRETS_FILE), 'utf8') : files.secrets,
  );
  const create = dryRun ? 'would create' : 'created ';
  log(
    localExists
      ? `kept     ${SECRETS_FILE} (already exists; never replaced)`
      : `${create} ${SECRETS_FILE} (owner-only)`,
  );
  log(
    envExists
      ? `kept     ${SETTINGS_FILE} (already exists; never replaced)`
      : `${create} ${SETTINGS_FILE}`,
  );
  if (plan.changed) {
    const move = dryRun ? 'would move' : 'moved';
    log(`\nKeys found in ${SETTINGS_FILE}:`);
    log(`${move} into ${SECRETS_FILE}: ${list(plan.moved)}`);
    log(`already in ${SECRETS_FILE}: ${list(plan.alreadyThere)}`);
    log(`blank placeholders: ${list(plan.dropped)}`);
    if (plan.duplicates.length) {
      log(
        `repeated in ${SETTINGS_FILE}: ${list(plan.duplicates)} — the last value is live, ` +
          'earlier ones are kept as comments.',
      );
    }
    if (plan.conflicts.length) {
      log(
        `CHECK ${list(plan.conflicts)}: a different value in each file. The ${SECRETS_FILE} ` +
          `one stays live; the ${SETTINGS_FILE} one is kept beneath it as a comment.`,
      );
    }
  }
  if (dryRun) {
    log('dry run: nothing written.');
    return 0;
  }
  // 1. Keys land in .env.local first.
  if (!localExists) createFile(at(SECRETS_FILE), plan.local, 0o600);
  else if (plan.localChanged) rewriteFile(at(SECRETS_FILE), plan.local);
  // 2. Only then do they leave .env.
  if (!envExists) createFile(at(SETTINGS_FILE), files.settings, 0o644);
  else if (plan.changed) {
    rewriteFile(at(SETTINGS_FILE), plan.env);
    log(`${SETTINGS_FILE} now holds settings only.`);
  }
  log(
    `\nPut keys in ${SECRETS_FILE} (SECTION 1) and settings in ${SETTINGS_FILE} (SECTION 2).`,
  );
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runEnvInit({
    root: projectRoot(import.meta.url),
    argv: process.argv.slice(2),
  });
}
