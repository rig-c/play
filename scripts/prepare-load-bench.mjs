import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Immutable origin revision, before this lane's edits. Never read a local clone.
const revision = '4f2cc2c080a8c04fd2d7588ebf5015bf1fac69ac';
const response = await fetch(`https://raw.githubusercontent.com/rig-c/play/${revision}/src/loadModel.ts`);
if (!response.ok) throw Error(`LOAD_BASELINE_FETCH: ${response.status}`);
const text = await response.text();
if (!text.includes('export async function loadModel(')) throw Error('LOAD_BASELINE_SHAPE');
writeFileSync('bench/load-base.generated.ts', text.replace("from './DomTexture.js'", "from '../src/DomTexture.js'"));
const archiveResponse = await fetch(`https://codeload.github.com/rig-c/play/tar.gz/${revision}`);
if (!archiveResponse.ok) throw Error(`LOAD_BASELINE_ARCHIVE: ${archiveResponse.status}`);
const archive = Buffer.from(await archiveResponse.arrayBuffer());
const listing = spawnSync('tar', ['-tzf', '-'], { input: archive, encoding: 'utf8' });
if (listing.status !== 0) throw Error(listing.stderr);
const top = listing.stdout.split('\n')[0].split('/')[0];
if (!/^play-[a-f0-9]+$/.test(top)) throw Error('LOAD_BASELINE_ARCHIVE_ROOT');
mkdirSync('bench/base.generated', { recursive: true });
const extract = spawnSync('tar', ['-xzf', '-', '-C', 'bench/base.generated', '--strip-components=1', `${top}/src`], { input: archive, encoding: 'utf8' });
if (extract.status !== 0) throw Error(extract.stderr);
if (readFileSync('bench/base.generated/src/loadModel.ts', 'utf8') !== text) throw Error('LOAD_BASELINE_SOURCE_MISMATCH');
writeFileSync('bench/load-base.generated.ts', "export { loadModel, RigPlayer } from './base.generated/src/index';\n");
mkdirSync('bench-results/203', { recursive: true });
writeFileSync('bench-results/203/baseline.json', JSON.stringify({ revision, loaderSha256: createHash('sha256').update(text).digest('hex'), archiveSha256: createHash('sha256').update(archive).digest('hex') }, null, 2));
