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
 * - `tests/harness.html` — a browser test harness that exposes the loading
 *   path (loadModel / unpackRegions / revokeRegions) and the renderer probes
 *   to Playwright, so tests can call the library directly instead of
 *   inferring it from the demo's stats line.
 * - `tests/oracle.html` — the independent WebGL raster comparison.
 *
 * The npm package is built separately by `scripts/build-lib.mjs`
 * (`bun run build:lib`) from `src/index.ts`.
 */
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        demo: 'index.html',
        wind: 'wind.html',
        parallax: 'parallax.html',
        harness: 'tests/harness.html',
        oracle: 'tests/oracle.html',
      },
    },
  },
});
