#!/usr/bin/env node
/** Load benchmark, not a device FPS benchmark. Fresh-context cold, second-load warm.
 * node scripts/load-bench.mjs --runs 12 [--dry-run] [--port 4383]
 * Requires scripts/fetch-load-assets.sh, scripts/fetch-assets.sh and the isolated
 * bench/oracle npm ci. Baseline comes from origin at the pinned revision, never a clone.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const args = process.argv.slice(2);
if (args.includes('--help')) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
const value = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const runs = Number(value('--runs', '12'));
const port = Number(value('--port', '4383'));
const dry = args.includes('--dry-run');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--runs' || args[i] === '--port') { i++; continue; }
  if (args[i] !== '--dry-run') throw Error(`LOAD_UNKNOWN_ARG: ${args[i]}`);
}
if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('LOAD_ARGS');
const rigs = [
  { name: 'spineboy', model: '/bench/spineboy/skeleton.model.json', json: '/bench/spineboy/spineboy-pro.json', atlas: '/bench/spineboy/spineboy.atlas', animation: 'walk' },
  { name: 'raptor', model: '/bench/raptor/skeleton.model.json', json: '/bench/raptor/raptor-pro.json', atlas: '/bench/raptor/raptor.atlas', animation: 'walk' },
  { name: 'wind-wave', model: '/rigs/wind-wave/skeleton.model.json', json: '/rigs/wind-wave/skeleton.json', atlas: '/rigs/wind-wave/skeleton.atlas', animation: 'idle' },
].flatMap(rig => ['none', 'blob'].map(regions => ({ ...rig, name: `${rig.name}/${regions === 'none' ? 'canvas' : 'dom'}`, regions })));
for (const rig of rigs) for (const key of ['model', 'json', 'atlas']) {
  if (!existsSync(`public${rig[key]}`)) throw Error(`LOAD_INPUT_MISSING: ${rig[key]}`);
}
mkdirSync('bench-results/203', { recursive: true });
const inputHashes = {};
const sourceHashes = {};
for (const path of [...readdirSync('src').filter(p => p.endsWith('.ts')).map(p => `src/${p}`), ...readdirSync('bench/base.generated/src').filter(p => p.endsWith('.ts')).map(p => `bench/base.generated/src/${p}`), 'bench/load-base.generated.ts', 'bench/load.ts', 'bench/load-profile-plugin.ts', 'bench/vite.config.ts', 'scripts/prepare-load-bench.mjs', 'scripts/check-load-profile.mjs', 'scripts/load-bench.mjs', 'bun.lock', 'bench/oracle/package-lock.json']) {
  sourceHashes[path] = createHash('sha256').update(readFileSync(path)).digest('hex');
}
for (const rig of rigs) for (const key of ['model', 'json', 'atlas']) inputHashes[rig[key]] = createHash('sha256').update(readFileSync(`public${rig[key]}`)).digest('hex');
function hashPages(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) hashPages(path);
    else if (/\.(png|webp|jpe?g)$/.test(entry.name) || entry.name === 'sets.json') inputHashes[path] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
}
for (const dir of new Set(rigs.map(r => dirname(`public${r.model}`)))) hashPages(dir);
process.env.LOAD_PROFILE = '1';
const server = await createServer({ configFile: 'bench/vite.config.ts', server: { port, strictPort: true } });
let browser;
const rows = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  for (const rig of rigs) {
    for (let i = 0; i < (dry ? 1 : runs); i++) {
      const order = i % 2 === 0 ? ['base', 'candidate', 'official'] : ['official', 'candidate', 'base'];
      const snapshots = {};
      for (const arm of order) {
        const context = await browser.newContext({ viewport: { width: 640, height: 640 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
        try {
          const page = await context.newPage();
          const errors = [];
          let requests = [];
          page.on('request', r => requests.push(new URL(r.url()).pathname));
          page.on('pageerror', e => errors.push(e.message));
          page.on('requestfailed', r => errors.push(`request ${r.url()}: ${r.failure()?.errorText}`));
          page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
          await page.goto(`http://localhost:${port}/load.html`);
          await page.waitForFunction(() => !!window.loadBench, null, { timeout: 30000 }).catch(e => { throw Error(`${e.message}\n${errors.join('\n')}`); });
          for (const cache of ['cold', 'warm']) {
            requests = [];
            const sample = await page.evaluate(({ arm, rig, dry }) => window.loadBench.run(arm, rig, rig.regions, dry), { arm, rig, dry });
            if (errors.length) throw Error(errors.join('\n'));
            if ((rig.regions === 'none' || arm === 'official') && !sample.glRenderers.length) throw Error(`LOAD_GL_UNAVAILABLE: ${rig.name} ${arm}`);
            if (arm !== 'official') {
              if (requests.filter(p => p === rig.model).length !== 1) throw Error(`LOAD_MODEL_FETCH_COUNT: ${rig.name} ${arm} ${cache}`);
              for (const phase of ['core-json-parse', 'model-read-including-parse', 'sequence-json-parse', 'first-pose', 'first-frame-assembly', 'first-draw-submit-including-upload']) {
                if (sample.spans.filter(s => s.name === phase).length !== 1) throw Error(`LOAD_PHASE_COUNT: ${phase}`);
              }
              snapshots[`${arm}-${cache}`] = sample.snapshot;
              if (!JSON.parse(sample.snapshot).frame.order.length) throw Error(`LOAD_EMPTY_FRAME: ${rig.name}`);
            }
            delete sample.snapshot;
            rows.push({ rig: rig.name, pair: i, cache, requests, ...sample });
            if (dry) {
              if (arm === 'candidate' && cache === 'cold' && rig.regions === 'blob') await page.evaluate(rig => window.loadBench.verifyRegionEncodings(rig), rig);
              if (cache === 'cold') await page.screenshot({ path: `bench-results/203/${rig.name.replace('/', '-')}-${arm}.png` });
              await page.evaluate(() => window.loadBench.cleanup());
            }
          }
        } finally { await context.close(); }
      }
      for (const cache of ['cold', 'warm']) if (snapshots[`base-${cache}`] !== snapshots[`candidate-${cache}`]) throw Error(`LOAD_POSE_MISMATCH: ${rig.name} ${cache}`);
      console.log(`${rig.name} pair ${i + 1}: ${dry ? 'frames / RawPoses / region pixels' : 'frames'} equal; cold/warm collected`);
    }
  }
  const quantile = (a, q) => { a = [...a].sort((x,y) => x-y); return a[Math.max(0, Math.ceil(a.length * q) - 1)]; };
  const stats = a => ({ p50: quantile(a, .5), p95: quantile(a, .95), iqr: quantile(a, .75) - quantile(a, .25), min: Math.min(...a), max: Math.max(...a) });
  const summary = [];
  const envelope = (row, name) => {
    const spans = row.spans.filter(s => s.name === name);
    if (name === 'texture-upload-submit' || name.startsWith('gl-') || ['page-unpremultiply', 'page-readback', 'page-unpremultiply-loop', 'page-writeback', 'region-draw-submit', 'rigid-region-raster'].includes(name)) return spans.length ? spans.reduce((sum, s) => sum + s.end - s.start, 0) : null;
    return spans.length ? Math.max(...spans.map(s => s.end)) - Math.min(...spans.map(s => s.start)) : null;
  };
  for (const rig of rigs) for (const cache of ['cold', 'warm']) for (const arm of ['base', 'candidate', 'official']) {
    const set = rows.filter(r => r.rig === rig.name && r.cache === cache && r.arm === arm);
    const phases = {};
    const pairedPhaseDeltaMs = {};
    const base = rows.filter(r => r.rig === rig.name && r.cache === cache && r.arm === 'base');
    for (const name of new Set(set.flatMap(r => r.spans.map(s => s.name)))) {
      // Concurrent page loads: envelope, not sum of overlapping durations.
      const measured = set.map(r => envelope(r, name)).filter(v => v !== null);
      phases[name] = { n: measured.length, ...stats(measured) };
      const deltas = set.flatMap(r => {
        const a = envelope(base.find(b => b.pair === r.pair), name), b = envelope(r, name);
        return a === null || b === null ? [] : [b - a];
      });
      if (deltas.length) pairedPhaseDeltaMs[name] = { n: deltas.length, ...stats(deltas) };
    }
    summary.push({ rig: rig.name, cache, arm, n: set.length, submitMs: stats(set.map(r => r.submitMs)), glCompletedMs: stats(set.map(r => r.glCompletedMs)), firstFrameReadyMs: stats(set.map(r => r.firstFrameReadyMs)), paintOpportunityMs: stats(set.map(r => r.paintOpportunityMs)), pairedSubmitDeltaMs: stats(set.map(r => r.submitMs - base.find(b => b.pair === r.pair).submitMs)), pairedGlCompletedDeltaMs: stats(set.map(r => r.glCompletedMs - base.find(b => b.pair === r.pair).glCompletedMs)), pairedFirstFrameReadyDeltaMs: stats(set.map(r => r.firstFrameReadyMs - base.find(b => b.pair === r.pair).firstFrameReadyMs)), pairedPaintOpportunityDeltaMs: stats(set.map(r => r.paintOpportunityMs - base.find(b => b.pair === r.pair).paintOpportunityMs)), phases, pairedPhaseDeltaMs });
  }
  writeFileSync('bench-results/203/load-results.json', JSON.stringify({ schema: 'load-profile/2', dry, browser: browser.version(), caveat: 'Headless Chromium CPU/submission and software GPU path; GL queue completion is recorded separately; no device FPS, physical GPU execution, or display latency claim. Async loads cannot share one animation frame; alternating paired fresh contexts replace same-frame AB. Module import precedes t0. Cold means fresh browser context, not empty OS/network/server caches. Warm means second asset load with fresh player and renderer.', sourceHashes, inputHashes, rows, summary }, null, 2));
  console.log(`load profile: ${rows.length} samples; ${summary.length} summary rows; ${dry ? 'DRY RUN (timings not evidence)' : 'measured'}; bench-results/203/load-results.json`);
} finally {
  await browser?.close(); await server.close();
}
