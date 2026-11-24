import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Build entries:
 *
 * - `index.html` — the demo (and the perf oracle; see docs/BENCHMARK.md). `?rig=` also
 *   reaches the repository's test rigs (tests/rigs/), which the parity and
 *   invariant scenes draw.
 * - `wind.html` — the wind page (#124): a rig named by `?model=` under wind
 *   and gravity sliders, dragged to move it.
 * - `parallax.html` — a pointer camera over three synthetic planes.
 * - `composed-parallax.html` — the camera over a public composed take.
 * - `tests/harness.html` — a browser test harness that exposes the loading
 *   path (loadModel / unpackRegions / revokeRegions) and the renderer probes
 *   to Playwright, so tests can call the library directly instead of
 *   inferring it from the demo's stats line.
 * - `tests/composed-take-harness.html` — the composed take browser probes.
 * - `tests/oracle.html` — the independent WebGL raster comparison.
 *
 * The npm package is built separately by `scripts/build-lib.mjs`
 * (`bun run build:lib`) from `src/index.ts`.
 */
export default defineConfig({
  plugins: [{
    name: 'composed-direction-fixtures',
    apply: 'build',
    buildStart() {
      // Keep each model beside its named atlas page at the same URL as in dev.
      const fixtureRoot = 'tests/fixtures/composed-direction';
      const emit = (path: string) => {
        const fileName = `${fixtureRoot}/${path}`;
        const sourceFile = fileURLToPath(new URL(fileName, import.meta.url));
        this.addWatchFile(sourceFile);
        this.emitFile({ type: 'asset', fileName, source: readFileSync(sourceFile) });
      };
      emit('LICENSE.txt');
      for (const variant of ['original', 'overscan', 'clip']) {
        for (const asset of ['skeleton.model.json', 'skeleton.atlas', 'skeleton.png']) {
          emit(`${variant}/${asset}`);
        }
      }
    },
  }],
  build: {
    rollupOptions: {
      input: {
        demo: 'index.html',
        wind: 'wind.html',
        parallax: 'parallax.html',
        composedParallax: 'composed-parallax.html',
        harness: 'tests/harness.html',
        composedTakeHarness: 'tests/composed-take-harness.html',
        oracle: 'tests/oracle.html',
      },
    },
  },
});
