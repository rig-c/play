/** Run the existing exact live-frame browser probe on an enumerated census. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium, webkit } from '@playwright/test';
if (process.argv.includes('--help')) {
  console.log('node scripts/runtime-corpus-browser.mjs <census.json> <base-url> <out.json>');
  process.exit(0);
}
const [censusFile, base, out] = process.argv.slice(2);
if (!censusFile || !base || !out) throw Error('CORPUS_BROWSER_ARGUMENTS');
const census = JSON.parse(readFileSync(censusFile, 'utf8'));
const records = [];
let failed = false;
for (const [engine, type] of Object.entries({ chromium, webkit })) {
  const browser = await type.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(new URL('/tests/harness.html', base).href);
    await page.waitForFunction(() => Boolean(window.rigPlayHarness));
    for (const input of census.inputs) {
      const response = await fetch(new URL(`/${input.rig}/skeleton.model.json`, base));
      if (!response.ok) throw Error(`CORPUS_BROWSER_MODEL_HTTP: ${input.rig} ${response.status}`);
      const modelSha256 = createHash('sha256').update(new Uint8Array(await response.arrayBuffer())).digest('hex');
      if (modelSha256 !== input.sha256) throw Error(`CORPUS_BROWSER_MODEL_HASH: ${input.rig} ${modelSha256} != ${input.sha256}`);
      // The existing probe resolves /rigs/<name>; ../bench selects public examples.
      const name = input.rig.startsWith('rigs/') ? input.rig.slice(5) : `../${input.rig}`;
      const result = await page.evaluate(name => window.rigPlayHarness.liveFrameProbe(name), name);
      if (JSON.stringify(result.rows.map(row => row.animation).sort()) !== JSON.stringify([...input.animations].sort())) {
        throw Error(`CORPUS_BROWSER_ANIMATIONS: ${input.rig} differs from the census`);
      }
      for (const row of result.rows) {
        row.pixelStatus = row.pixelValues > 0 && row.contentPixels > 0 ? 'measured' : 'no drawable content at sampled times';
        if (row.numeric.length || (row.pixelStatus === 'measured' && row.pixelDifferences) || !row.snapshotKept || !row.stale || !row.nestedStale || !row.rendererStale || !row.readonly || (row.poser === 'runtime' && !row.drawIdentity)) failed = true;
      }
      records.push({ engine, rig: input.rig, modelSha256, rows: result.rows, noAnimations: !result.rows.length });
      console.log('RUNTIME_CORPUS_BROWSER', JSON.stringify(records.at(-1)));
      writeFileSync(out, JSON.stringify({ protocol: 'runtime-corpus-browser-v1', records, failed }, null, 2) + '\n');
    }
  } finally { await browser.close(); }
}
if (failed) process.exit(1);
