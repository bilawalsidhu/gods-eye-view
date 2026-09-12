import { spawn as spawnProcess, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { localVoiceInstallPlan } from '../src/voice/localVoiceSetupCore.mjs';
import { incompleteDownloadBytes } from './local-ai-realtime.mjs';
import {
  readProfile,
  runLocalStep,
  setupLocalVoice,
  stepCommand,
  weightsPresent,
} from './setup-local-voice.mjs';

/**
 * The dev server's half of the in-app local voice install.
 *
 * Same shape as the key panel: the browser asks for status, posts once to
 * start, and polls that same status while it runs. Every command comes from the
 * profile through setup-local-voice.mjs — nothing the browser sends is ever run,
 * and the route that exposes this is gated by the key panel's admission check.
 */
export function createLocalVoiceInstaller({
  environment = process.env,
  spawnImpl = spawnProcess,
  platform = process.platform,
  architecture = process.arch,
  homeDirectory = os.homedir(),
  profileDir = undefined,
  downloadedBytes = null,
  probeBinary = (executable) => spawnSync(executable, ['--version'], { encoding: 'utf8' }).status === 0,
} = {}) {
  let steps = [];
  let state = 'idle';
  let error = '';

  const home = () => path.resolve(
    environment.GEV_LOCAL_AI_HOME || path.join(homeDirectory, '.local', 'share', 'localai'),
  );
  const modelsDir = () => path.join(home(), 'models');
  const backendsDir = () => path.join(home(), 'backends');
  const profileOptions = profileDir ? { profileDir } : {};
  const bytes = () => (downloadedBytes ? downloadedBytes() : incompleteDownloadBytes(modelsDir()));
  const childEnvironment = () => ({
    ...environment,
    GEV_LOCAL_AI_HOME: home(),
    LOCALAI_MODELS_PATH: modelsDir(),
    LOCALAI_BACKENDS_PATH: backendsDir(),
  });

  const profileOrNull = () => {
    try {
      return readProfile(profileDir);
    } catch {
      return null;
    }
  };

  /** LocalAI itself is a package install; the panel shows that command rather than running brew. */
  function hasLocalAi() {
    try {
      return probeBinary(environment.GEV_LOCAL_AI_BIN || 'local-ai');
    } catch {
      return false;
    }
  }

  /** A profile is installable here unless an mlx stage meets the wrong machine. */
  function supported() {
    const profile = profileOrNull();
    if (!profile) return false;
    if (!profile.backends.includes('mlx')) return true;
    return platform === 'darwin' && architecture === 'arm64';
  }

  function readiness() {
    try {
      setupLocalVoice({ environment, platform, architecture, checkOnly: true, ...profileOptions });
      return { ready: true, detail: '' };
    } catch (failure) {
      return { ready: false, detail: String(failure?.message || failure) };
    }
  }

  function status() {
    const { ready, detail } = readiness();
    return {
      binary: hasLocalAi(),
      supported: supported(),
      ready,
      detail,
      state,
      error,
      bytes: state === 'running' ? bytes() : 0,
      steps: steps.map(({ id, kind, label, state: stepState }) => ({ id, kind, label, state: stepState })),
    };
  }

  function runCommand(spec) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(spec.command, spec.args, {
        cwd: home(),
        env: spec.environment,
        shell: false,
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('exit', (code) => (code === 0
        ? resolve()
        : reject(new Error(`${path.basename(spec.command)} ${spec.args[0]} exited with ${code}`))));
    });
  }

  async function run() {
    for (const step of steps) {
      if (step.state === 'done') continue;
      step.state = 'running';
      try {
        const spec = stepCommand(step, {
          executable: environment.GEV_LOCAL_AI_BIN || 'local-ai',
          backendsDir: backendsDir(),
          modelsDir: modelsDir(),
          environment: childEnvironment(),
        });
        if (spec) await runCommand(spec);
        else runLocalStep(step, { ...profileOptions, modelsDir: modelsDir(), backendsDir: backendsDir() });
        step.state = 'done';
      } catch (failure) {
        step.state = 'failed';
        state = 'failed';
        error = String(failure?.message || failure);
        return;
      }
    }
    state = 'done';
  }

  /** Idempotent while running: a second click returns the run already in flight. */
  function start() {
    if (state === 'running') return status();
    const profile = profileOrNull();
    if (!profile) {
      state = 'failed';
      error = 'No local voice profile found';
      return status();
    }
    if (!supported()) {
      state = 'failed';
      error = 'The mlx stage in this profile requires an Apple Silicon Mac';
      return status();
    }
    if (!hasLocalAi()) {
      state = 'failed';
      error = 'LocalAI is not installed — run: brew install localai';
      return status();
    }
    fs.mkdirSync(modelsDir(), { recursive: true });
    fs.mkdirSync(backendsDir(), { recursive: true });
    const cachedRepos = profile.weights
      .filter(({ repoId }) => weightsPresent(modelsDir(), repoId))
      .map(({ repoId }) => repoId);
    steps = localVoiceInstallPlan(profile, { cachedRepos })
      .map((step) => ({ ...step, state: step.cached ? 'done' : 'pending' }));
    state = 'running';
    error = '';
    void run();
    return status();
  }

  return { status, start };
}
