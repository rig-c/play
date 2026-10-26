/** Same-frame CPU A/A and A/B on the pinned #58 host; the legacy adapter still consumes snapshots. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const probeOnly = process.argv.includes('--probe-only');
const skeletons = process.argv.includes('--raptor-only') ? ['raptor'] : ['spineboy', 'raptor'];
const host = resolve('node_modules/.cache/adapters-host');
const out = resolve('test-results/runtime-bench');
mkdirSync(out, { recursive: true });
const productBundle = readFileSync('dist/index.js', 'utf8');
const productBundleSha256 = createHash('sha256').update(productBundle).digest('hex');
// The default-product comparison serves the canonical package bytes unchanged.
writeFileSync(resolve(host, 'public/play-candidate.js'), productBundle);
const bundleSha256 = productBundleSha256;
const server = spawn('bunx', ['--no-install', 'vite', '--host', '127.0.0.1', '--port', '4351', '--strictPort'], { cwd: host, env: { ...process.env, RIG_BENCH: '1' }, stdio: 'inherit' });
const url = 'http://127.0.0.1:4351/bench/index.html';
// Pool exclusion does not prove that Windows or queue-external GPU work is idle.
const windows = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$c = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"; $g = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue | Where-Object { $_.UtilizationPercentage -gt 0 } | Select-Object Name,UtilizationPercentage); @{cpuPercent=$c.PercentProcessorTime; activeGpuEngines=$g} | ConvertTo-Json -Depth 4 -Compress`], { encoding: 'utf8', timeout: 10000 });
let machineObservation;
try { machineObservation = windows.status === 0 ? { status: 'observed', windows: JSON.parse(windows.stdout), queueOutsidePool: 'not verified' } : { status: 'unavailable', detail: String(windows.error ?? windows.stderr), queueOutsidePool: 'not verified' }; }
catch (error) { machineObservation = { status: 'unavailable', detail: String(error), queueOutsidePool: 'not verified' }; }
console.log('RUNTIME_BENCH_MACHINE', JSON.stringify(machineObservation));

let browser;
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const q = p => sorted[Math.floor((sorted.length - 1) * p)];
  return { p50Ms: q(.5), p95Ms: q(.95), p05Ms: q(.05), iqrMs: q(.75) - q(.25), samples: values.length };
}
try {
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* server starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!ready) throw Error('BENCH_HOST_START: server not ready');
  browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'] });
  const page = await browser.newPage();
  await page.route('**/bench/main.ts', async route => {
    const response = await route.fetch();
    let body = await response.text();
    let constructors = 0, loaders = 0;
    body = body.replace(/const RigCtor = arm === ["']rig-c-pixi-compare["'] \? requireCompareBundle\(\)\.PixiRig : PixiRig\d*;/g, () => {
      constructors++; return 'const RigCtor = arm === "rig-c-pixi-compare" ? requireCompareBundle().PixiRig : globalThis.__PlayBaseRig;';
    });
    body = body.replace(/const loader = arm === ["']rig-c-pixi-compare["'] \? requireCompareBundle\(\)\.loadModel : loadModel\d*;/g, () => {
      loaders++; return 'const loader = arm === "rig-c-pixi-compare" ? requireCompareBundle().loadModel : globalThis.__NewPlay.loadModel;';
    });
    if (constructors !== 1 || loaders !== 1) throw Error(`BENCH_BINDINGS: constructor ${constructors}, loader ${loaders}; expected one each`);
    await route.fulfill({ response, body });
  });
  await page.goto(url);
  await page.waitForFunction(() => Boolean(window.__rigBench));
  await page.evaluate(async () => {
    const play = await import('/play-candidate.js');
    const adapter = await import('/packages/pixi/src/index.ts');
    globalThis.__NewPlay = play;
    globalThis.__PlayCandidateMode = 'oracle';
    const make = candidate => class extends adapter.PixiRig {
      constructor(assets, options) {
        super(assets, options);
        this.player.dispose();
        Object.defineProperty(this, 'player', { value: new play.RigPlayer(document.createElement('div'), assets, { mode: 'canvas', poser: candidate ? globalThis.__PlayCandidateMode : 'oracle', liveFrameChecks: false }), writable: false, configurable: true });

      }
      play(name, options) {
        super.play(name, options);
        const expected = !candidate || globalThis.__PlayCandidateMode === 'oracle' ? 'oracle:' : 'runtime';
        if (!this.player.poser.startsWith(expected)) throw Error(`BENCH_POSER_NOT_MEASURABLE: ${this.player.poser}, expected ${expected}`);
      }
    };
    globalThis.__PlayBaseRig = make(false);
    globalThis.__PlayCandidateRig = make(true);
    await window.__rigBench.registerCompareBundle({ label: 'same-play-candidate', moduleCode: 'export const loadModel = globalThis.__NewPlay.loadModel; export const PixiRig = globalThis.__PlayCandidateRig;' });
  });
  const rows = [];
  const coverage = [];
  for (const skeleton of skeletons) {
    const exact = await page.evaluate(async skeleton => {
      const play = globalThis.__NewPlay;
      const assets = await play.loadModel({ modelUrl: `/bench/${skeleton}/skeleton.model.json`, regions: 'none' });
      const a = new play.RigPlayer(document.createElement('div'), assets, { mode: 'canvas', poser: 'oracle' });
      const b = new play.RigPlayer(document.createElement('div'), assets, { mode: 'canvas', liveFrameChecks: false });
      try {
        a.play('walk'); b.play('walk');
        const defaultPoser = b.poser;
        if (b.poser !== 'runtime') return { skeleton, pass: false, status: 'not measurable', reason: b.poser };
        let values = 0;
        const compare = (left, right, path) => {
          if (typeof left === 'number' && typeof right === 'number') { values++; if (!Object.is(left, right)) throw Error(`BENCH_EXACT: ${path} ${left} != ${right}`); return; }
          if (left === right) return;
          if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') throw Error(`BENCH_EXACT: ${path} differs`);
          const keys = Object.keys(left);
          if (keys.length !== Object.keys(right).length) throw Error(`BENCH_EXACT: ${path} key count differs`);
          for (const key of keys) compare(left[key], right[key], `${path}.${key}`);
        };
        for (const dt of [0, .125, .375, .75]) { a.advance(dt); b.advance(dt); compare(a.posedFrame(), b.posedFrame(), skeleton); }
        return { skeleton, values, pass: true, defaultPoser, eventsIgnored: 0, poser: 'runtime' };
      } finally { a.dispose(); b.dispose(); assets.dispose(); }
    }, skeleton);
    console.log('RUNTIME_BENCH_EXACT', JSON.stringify(exact));
    coverage.push(exact);
    if (!exact.pass || probeOnly) continue;
    for (const mode of ['oracle', 'auto']) {
      await page.evaluate(mode => { globalThis.__PlayCandidateMode = mode; }, mode);
      for (const arm of ['rig-c-pixi', 'rig-c-pixi-compare']) {
        const correctness = await page.evaluate(({ skeleton, arm }) => window.__rigBench.checkCorrectness(skeleton, { arm, times: [0, .35, .7] }), { skeleton, arm });
        if (!correctness.pass) throw Error(`BENCH_CORRECTNESS: ${skeleton} ${mode} ${arm}: ${JSON.stringify(correctness)}`);
      }
      for (const instances of [1, 100]) {
        const result = await page.evaluate(({ skeleton, instances }) => window.__rigBench.runSameFramePair(skeleton, ['rig-c-pixi', 'rig-c-pixi-compare'], instances, { warmupFrames: 60, measuredFrames: 180 }), { skeleton, instances });
        if (!result.drawCallsPass || !result.halves.every(half => half.pass)) throw Error(`BENCH_SHARED_CORRECTNESS: ${skeleton} ${mode} ${instances}`);
        result.control = mode === 'oracle' ? 'AA' : 'AB';
        result.candidatePoser = mode === 'oracle' ? 'oracle' : exact.poser;
        result.eventsIgnored = 0;
        result.eventAsymmetry = null;
        result.bundleSha256 = bundleSha256;
        result.poseDifference = stats(result.frames.map(frame => frame.arms[1].poseMs - frame.arms[0].poseMs));
        result.submitDifference = stats(result.frames.map(frame => frame.arms[1].submitMs - frame.arms[0].submitMs));
        result.cpuDifference = stats(result.frames.map(frame => frame.arms[1].cpuMs - frame.arms[0].cpuMs));
        result.gpu = await page.evaluate(() => window.__rigBench.getGpuInfo());
        writeFileSync(resolve(out, `${skeleton}-${instances}-${result.control}.json`), JSON.stringify(result, null, 2));
        rows.push({ skeleton, instances, control: result.control, candidatePoser: result.candidatePoser, eventsIgnored: result.eventsIgnored, eventAsymmetry: result.eventAsymmetry, pose: result.poseDifference, submit: result.submitDifference, cpu: result.cpuDifference, gpuStatus: result.gpuStatus });
      }
    }
  }
  const report = { protocol: 'play-runtime-default-same-frame-v1', adapterHost: '0880a6404e62ec03fba158124eb7b5abdc5f013e', bundleSha256, productBundleSha256, eventPolicy: 'default delivery, no ignore or model injection', machineObservation, coverage, probeOnly, timingStatus: rows.length ? 'measured covered inputs' : 'not measurable', boundary: 'same play code and legacy Pixi adapter; oracle vs runtime, both using posedFrame snapshots; not the adapters#56 direct-buffer path', rows };
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log('RUNTIME_BENCH_REPORT', JSON.stringify(report));
  if (!probeOnly && rows.length === 0) throw Error('BENCH_NOT_MEASURABLE: no input selected the runtime');
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
  }
}
