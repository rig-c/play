/** Prepare the immutable adapters #58 host; run on Nova before timing. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pin = '0880a6404e62ec03fba158124eb7b5abdc5f013e';
const host = resolve('node_modules/.cache/adapters-host');
mkdirSync(host, { recursive: true });
const archive = resolve('node_modules/.cache/adapters-host.tar.gz');
const response = await fetch(`https://codeload.github.com/rig-c/adapters/tar.gz/${pin}`);
if (!response.ok) throw Error(`BENCH_HOST_FETCH: HTTP ${response.status}`);
writeFileSync(archive, new Uint8Array(await response.arrayBuffer()));
function run(command, cwd = host) {
  const result = spawnSync(command[0], command.slice(1), { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw Error(`BENCH_HOST_COMMAND: ${command.join(' ')} exit ${result.status}`);
}
run(['tar', '-xzf', archive, '--strip-components=1', '-C', host]);
const mainHash = createHash('sha256').update(readFileSync(resolve(host, 'bench/main.ts'))).digest('hex');
if (mainHash !== '498d68ddb6c8d0397bd271adae8d54d9afe15e105097e324ea72550116b0010d') throw Error(`BENCH_HOST_PIN: main hash ${mainHash}`);
run(['bun', 'install', '--frozen-lockfile']);
run(['bun', 'scripts/prepare-oracle.mjs']);
run(['bun', 'run', 'build:libraries']);
run(['bun', 'run', 'fetch-assets']);
console.log('BENCH_HOST_READY', JSON.stringify({ pin, mainHash, archiveSha256: createHash('sha256').update(readFileSync(archive)).digest('hex') }));
