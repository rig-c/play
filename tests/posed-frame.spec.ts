import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Keep collection and test execution under Node Playwright, as in CI. Only
// the source contracts run in Bun: rig-c/core exports TypeScript in node_modules,
// which Node's type stripper and Playwright's transform do not load.
const root = fileURLToPath(new URL('..', import.meta.url));
const cases = [
  ["snapshot-equality", "reused indexes equal cold sources for 96 frames per scene; retained snapshots and input poses stay unchanged"],
  ["snapshot-identity", "snapshot containers are fresh, geometry is passed through, and only UVs/triangles are stable across frames"],
  ["dynamic-indexes", "one source follows changing draw order, membership, clips, tint and filter results without identity shortcuts"],
  ["reentrant-filters", "same-source nested filters and interleaved sources cannot overwrite an outer call"],
  ["exception-recovery", "throwing filters and invalid slot rows leave subsequent calls and retained clip maps independent"],
  ["independent-players", "independent players sharing assets survive skin/filter changes and retain old snapshots without drawing"],
  ["bench-cli-inputs", "pose benchmark CLI rejects malformed work and missing fixtures by name"],
] as const;

for (const [name, title] of cases) {
  test(title, async ({}, info) => {
    const result = spawnSync('bun', ['tests/posed-frame.cases.ts', name], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 45_000,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    });
    const trace = [
      `contract: ${name}`,
      `exit: ${result.status}, signal: ${result.signal}`,
      result.error?.stack ?? '',
      result.stdout ?? '',
      result.stderr ?? '',
    ].join('\n');
    await info.attach(`pose-${name}.log`, { body: trace, contentType: 'text/plain' });
    expect(result.error, trace).toBeUndefined();
    expect(result.signal, trace).toBeNull();
    expect(result.status, trace).toBe(0);
    expect(JSON.parse(result.stdout.trim()), trace).toEqual({ contract: name, status: 'passed' });
  });
}
