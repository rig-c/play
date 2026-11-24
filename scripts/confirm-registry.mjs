// Confirm the canonical release and its selected aliases from registry reads.
import { execFile } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ALIASES, compareTarballs, sameContentLine } from './alias-tarball.mjs';

const CANONICAL = '@rig-c/play';
const DEFAULT_WAIT_MS = 15 * 60_000;
const DEFAULT_POLL_MS = 30_000;
const USAGE = `Usage: node scripts/confirm-registry.mjs <version> [${ALIASES.join(' ')}]`;
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;
const exec = promisify(execFile);

function milliseconds(key, fallback) {
  const value = process.env[key];
  if (value === undefined) return fallback;
  const ms = Number(value);
  if (!/^\d+$/.test(value) || ms < 1 || ms > 2_147_483_647) {
    throw new Error(`${key} must be a positive integer in milliseconds`);
  }
  return ms;
}

async function run(command, args, deadline, options) {
  const timeout = Math.floor(deadline - performance.now());
  if (timeout <= 0) return undefined;
  try {
    const { stdout, stderr } = await exec(command, args, { ...options, timeout, killSignal: 'SIGKILL' });
    return { status: 0, stdout, stderr };
  } catch (error) {
    if (error.killed && error.signal === 'SIGKILL') return undefined;
    if (typeof error.code === 'number') {
      return { status: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    throw new Error(`${command} ${args[0]} failed to run (${error.code ?? error.signal ?? error.message})`);
  }
}

async function poll(check, deadline, pollMs) {
  while (deadline - performance.now() >= 1) {
    const value = await check();
    if (value !== undefined) return value;
    const remaining = Math.floor(deadline - performance.now());
    if (remaining > 0) await delay(Math.min(pollMs, remaining));
  }
}

async function fetchTarball(spec, work, npm) {
  // A failed pack may leave a partial file. Each attempt starts in an empty directory.
  const destination = mkdtempSync(join(work, 'pack-'));
  let tarball;
  try {
    const result = await npm('pack', spec, '--ignore-scripts', '--pack-destination', destination);
    if (result?.status !== 0) return undefined;
    const files = readdirSync(destination).filter(file => file.endsWith('.tgz'));
    if (files.length !== 1) return undefined;
    const path = join(destination, files[0]);
    const stat = lstatSync(path);
    if (stat.isFile() && stat.size > 0) tarball = path;
    return tarball;
  } finally {
    if (tarball === undefined) rmSync(destination, { recursive: true, force: true });
  }
}

async function main([version, ...requested]) {
  if (!EXACT_VERSION.test(version ?? '') || requested.some(alias => !ALIASES.includes(alias))) {
    console.error(USAGE);
    return 2;
  }
  const waitMs = milliseconds('CONFIRM_WAIT_MS', DEFAULT_WAIT_MS);
  const pollMs = milliseconds('CONFIRM_POLL_MS', DEFAULT_POLL_MS);
  const deadline = performance.now() + waitMs;
  const aliases = requested.length ? [...new Set(requested)] : ALIASES;
  const packages = [CANONICAL, ...aliases].map(name => ({ name, spec: `${name}@${version}` }));
  const work = mkdtempSync(join(tmpdir(), 'play-confirm-registry-'));
  try {
    const npm = (...args) => run('npm', [
      ...args, '--prefer-online', '--fetch-retries=0', '--loglevel=error', '--cache', join(work, 'npm-cache'),
    ], deadline, { cwd: work });

    // Poll every view and pack independently against one deadline. Completed probes stop polling.
    const probes = packages.flatMap(entry => [
      poll(async () => {
        const result = await npm('view', entry.spec, 'version');
        if (result?.status === 0 && result.stdout.trim() === version) return version;
      }, deadline, pollMs).then(value => { entry.version = value; }),
      poll(() => fetchTarball(entry.spec, work, npm), deadline, pollMs)
        .then(value => { entry.tarball = value; }),
    ]);
    // Wait for children to finish before removing the directories they use, even after a probe fails.
    for (const result of await Promise.allSettled(probes)) {
      if (result.status === 'rejected') throw result.reason;
    }

    const window = waitMs === DEFAULT_WAIT_MS ? '15 minutes' : `${waitMs} ms`;
    let missing = false;
    for (const { spec, version: served, tarball } of packages) {
      if (served && tarball) console.log(`${spec} served (npm view version ${served})`);
      else {
        missing = true;
        console.error(`${spec} was not served within ${window}: confirmation NOT taken; re-run the confirm`);
      }
    }
    if (missing) return 3;

    const [canonical, ...earlierNames] = packages;
    let differs = false;
    // The deadline governs registry visibility. A tarball served on the last
    // poll still gets its local comparison.
    for (const alias of earlierNames) {
      const reading = compareTarballs(canonical.tarball, alias.tarball);
      if (reading.name !== canonical.name) {
        reading.faults.push(`package/package.json in ${canonical.spec} declares ${JSON.stringify(reading.name)}`);
      }
      if (reading.alias !== alias.name) {
        reading.faults.push(`package/package.json in ${alias.spec} declares ${JSON.stringify(reading.alias)}`);
      }
      if (reading.faults.length === 0) {
        console.log(sameContentLine(reading));
      } else {
        differs = true;
        console.log(`FAIL  ALIAS_SAME_CONTENT: ${alias.name} differs from ${canonical.name} beyond its name:`);
        for (const fault of reading.faults) console.log(`        ${fault}`);
      }
    }
    return differs ? 1 : 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`confirm-registry: ${error.message}`);
  process.exitCode = 2;
}
