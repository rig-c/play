import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { build } from 'vite';
import type { ColdWebglWindow } from './cold-webgl-probe';

test('cold canvas: the first three meshed renders use WebGL', async ({ playwright, browserName, baseURL }) => {
  const bundle = await build({
    configFile: false, logLevel: 'silent',
    build: { write: false, lib: { entry: resolve('tests/cold-webgl-probe.ts'), formats: ['es'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!('output' in output)) throw new Error('Expected a cold WebGL probe bundle');
  const entry = output.output.find(item => item.type === 'chunk' && item.isEntry);
  if (entry?.type !== 'chunk') throw new Error('Missing cold WebGL probe entry');

  const plant = process.env.PLAY_COLD_WEBGL_DECLINE_FIRST_GRANT === '1';
  // Launch independently of the worker browser, which other tests can warm.
  const browser = await playwright[browserName].launch({ headless: true, timeout: 15_000 });
  try {
    const page = await browser.newPage({ baseURL });
    await page.route('**/cold-webgl-probe.html', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><script type="module" src="/cold-webgl-probe.js"></script>',
    }));
    await page.route('**/cold-webgl-probe.js', route => route.fulfill({
      contentType: 'text/javascript', body: entry.code,
    }));
    await page.goto('/cold-webgl-probe.html', { timeout: 15_000 });
    await page.waitForFunction(() => Boolean((window as ColdWebglWindow).renderColdWebgl), undefined, { polling: 20, timeout: 10_000 });
    const result = await page.evaluate(decline => (window as ColdWebglWindow).renderColdWebgl(decline), plant);
    console.log(JSON.stringify({ browserName, version: browser.version(), plant, ...result }));

    expect(result.frames).toHaveLength(3);
    for (const sample of result.frames) {
      const { frame, backendActive, backendFallbackReason } = sample;
      const label = `frame ${frame}: backend=${backendActive}, reason=${backendFallbackReason}`;
      // Use the same verdict in plant mode and check all frames even if one fails.
      expect.soft({ backendActive, backendFallbackReason }, label).toEqual({ backendActive: 'webgl', backendFallbackReason: null });
      expect(sample.meshCount, `${label}, mesh count`).toBeGreaterThan(0);
      expect(sample.drawCalls, `${label}, draw calls`).toBeGreaterThan(0);
      expect(sample.trianglesDrawn, `${label}, triangles drawn`).toBeGreaterThan(0);
      expect(sample.framesReused, `${label}, reused frames`).toBe(0);
      expect(sample.blits, `${label}, WebGL blits`).toBe(backendActive === 'webgl' ? 1 : 0);
    }
    expect(result.contextsBefore, 'contexts before the first render').toBe(0);
    expect(result.distinctMeshPoses, 'distinct mesh poses').toBe(3);
    if (plant) expect(result.plantedWidthReads, 'first render read the planted grant').toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
});
