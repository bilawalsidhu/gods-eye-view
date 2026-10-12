#!/usr/bin/env node
/**
 * Smoke check for the Capacitor Android shell.
 *
 * Run: `node scripts/mobile/smoke-check.mjs [--require-apk]`.
 *
 * Asserts `dist/index.html` exists, the pinned SDK versions
 * (`compileSdk`/`targetSdk` 37, `minSdk` 24), and the `INTERNET`
 * permission in `AndroidManifest.xml`. The debug APK assertion is
 * conditional: it runs only when `--require-apk` is passed or an
 * Android SDK is present (`ANDROID_HOME`/`ANDROID_SDK_ROOT`); on an
 * SDK-less box only project structure and manifest pins are asserted.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const failures = [];

/**
 * Record a pass/fail assertion and print it.
 * @param {string} label Human-readable check name.
 * @param {boolean} ok Whether the check passed.
 * @param {string} detail Extra context printed on failure.
 * @returns {void}
 */
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`ok - ${label}`);
    return;
  }
  console.log(`FAIL - ${label}${detail ? `: ${detail}` : ''}`);
  failures.push(label);
}

/**
 * Read a repo-relative file, or null when it does not exist.
 * @param {string} rel Path relative to the repo root.
 * @returns {string|null} File text or null.
 */
function readIfExists(rel) {
  const absolute = path.join(root, rel);
  if (!existsSync(absolute)) return null;
  return readFileSync(absolute, 'utf8');
}

// 1. Bundled web assets.
check(
  'dist/index.html exists',
  existsSync(path.join(root, 'dist', 'index.html')),
  'run `npm run build` first',
);

// 2. Android project structure.
const manifestRel = path.join(
  'android',
  'app',
  'src',
  'main',
  'AndroidManifest.xml',
);
const manifest = readIfExists(manifestRel);
check(
  'android/ project exists',
  manifest !== null,
  'run `npx cap add android`',
);
check(
  'android/app/build.gradle exists',
  existsSync(path.join(root, 'android', 'app', 'build.gradle')),
);

// 3. SDK pins live in Gradle files (AGP ignores manifest `uses-sdk`),
// so assert them where they are authoritative.
const gradleText = [
  readIfExists(path.join('android', 'variables.gradle')) ?? '',
  readIfExists(path.join('android', 'app', 'build.gradle')) ?? '',
  readIfExists(path.join('android', 'build.gradle')) ?? '',
].join('\n');
check(
  'compileSdk 37 pinned',
  /compileSdk(?:Version)?\s*[= ]\s*37\b/.test(gradleText),
  'expected compileSdk 37 in android/variables.gradle or build.gradle',
);
check(
  'targetSdk 37 pinned',
  /targetSdk(?:Version)?\s*[= ]\s*37\b/.test(gradleText),
  'expected targetSdk 37 in android/variables.gradle or build.gradle',
);
check(
  'minSdk 24 pinned',
  /minSdk(?:Version)?\s*[= ]\s*24\b/.test(gradleText),
  'expected minSdk 24 in android/variables.gradle or build.gradle',
);

// 4. Manifest permissions.
check(
  'INTERNET permission declared',
  manifest !== null &&
    /<uses-permission[^>]*android\.permission\.INTERNET/.test(manifest),
  manifestRel,
);

// 5. Debug APK: conditional on an SDK build having run.
const apkRel = path.join(
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'debug',
  'app-debug.apk',
);
const sdkPresent =
  (process.env.ANDROID_HOME ?? '') !== '' ||
  (process.env.ANDROID_SDK_ROOT ?? '') !== '';
const requireApk = process.argv.includes('--require-apk') || sdkPresent;
if (requireApk) {
  check(
    'app-debug.apk exists',
    existsSync(path.join(root, apkRel)),
    `run ./scripts/mobile/build-apk.sh (SDK detected: ${sdkPresent})`,
  );
} else {
  console.log('skip - app-debug.apk (no Android SDK on this box)');
}

if (failures.length) {
  console.error(`\nsmoke-check: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nsmoke-check: PASS');
