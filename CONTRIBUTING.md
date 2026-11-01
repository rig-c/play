# Contributing

`@rig-c/play` renders compiled `rig-c` models (`skeleton.model.json`) in the browser as plain DOM elements or on a single canvas. Read [AGENTS.md](AGENTS.md) before writing a first patch.

## Getting the code running

From a clone, with [Bun](https://bun.sh) 1.4+ and Node.js 22+ on `PATH`:

```sh
bun install --frozen-lockfile
bun run fetch-assets
bun run dev
```

`bun run fetch-assets` builds the gallery and test rigs into `public/rigs/` (`predev` and `prebuild` run it automatically). `bun run dev` starts the local Vite demo server, and `bun run preview` serves a built demo.

## Before you open a pull request

Run the offline README and release-workflow checks, the demo and library builds, and the pack list check from `package.json` and `.github/workflows/ci.yml`:

```sh
node scripts/check-readme.mjs
node --test scripts/check-readme.test.mjs
bun test scripts/release-workflow.test.ts
bun run build
bun run build:lib
npm pack --dry-run
```

Browser verification runs through Playwright over headless Chromium and WebKit (install browsers with `PLAYWRIGHT_SKIP_BROWSER_GC=1 bunx playwright install chromium webkit`; set a distinct `TEST_PORT` when running multiple checkouts):

```sh
bun run test
bun run bench:build
```

Run single spec files locally (`bunx playwright test tests/<name>.spec.ts --project=chromium`) and let CI or an isolated runner execute the full Chromium + WebKit `bun run test` suite. `bun run bench` (and `bun run bench:dev`) runs a heavy 64-rig browser benchmark — run it only on an otherwise idle machine, or pass `-- --headless` (`node scripts/bench.mjs --headless`) for deterministic counter verification without GPU timing claims.

## Reporting a change

- **Issue first.** Open an issue before making a change, naming the model or test rig, the renderer mode, the verbatim output or counter/pixel reading, and what you expected.
- **One issue per pull request.** Keep each pull request scoped to a single issue.
- **Conventional Commits.** Write commit messages, code, and documentation in English using [Conventional Commits](https://www.conventionalcommits.org/) with a scope (`feat(dom):`, `fix(webgl):`, `test(parity):`, `docs(readme):`).

## Where further rules live

- [AGENTS.md](AGENTS.md) — architecture invariants, measurement rules, README scope, and testing policy.
- [RELEASING.md](RELEASING.md) — release workflow and alias package verification.
- [docs/REFERENCE.md](docs/REFERENCE.md) — API, live-frame, and renderer reference.
- [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE) — attribution and MIT licence terms.
