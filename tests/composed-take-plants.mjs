import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const compositor = 'src/composed-camera.ts';
const mount = 'src/composed-take.ts';
const fixture = 'tests/fixtures/composed-direction';
const model = `${fixture}/overscan/skeleton.model.json`;
const plantPattern = (row, name) => `C2-${row} ${name}`;

function replace(directory, file, before, after) {
  const target = join(directory, file);
  const source = readFileSync(target, 'utf8');
  if (source.split(before).length !== 2) throw new Error(`Expected exactly one match in ${file}: ${before}`);
  writeFileSync(target, source.replace(before, after));
}

const code = (id, row, test, expected, file, before, after) => ({
  id, grep: plantPattern(row, test), expected, change: directory => replace(directory, file, before, after),
});
const raster = (id, test, expected, before, after) => ({
  ...code(id, 7, test, expected, mount, before, after), checkRaster: true,
});
const mutation = (id, row, test, expected, change) => ({ id, grep: plantPattern(row, test), expected, change });
const clamps = 'clamps Y-up pointer';
const gains = 'applies landed signed gains';
const fixed = 'Fixed and settled neutral';
const clock = 'identical source time and pose bytes';
const order = 'preserves complete model order';
const cover = 'backdrop remains opaque';
const crop = 'crops full authored geometry';
const clipRaster = 'renders the displaced attachment clip';
const clipAssertions = ['attachment clip scene RGBA', 'attachment clip isolated figure RGBA'];
const nativeFrameTransform = '        positioned = transformFrame(frame, shiftFor, { centered, clipInStockSpace: true });';
const refuse = (name) => `refuses ${name}`;
const named = (name) => `named refusal for ${name}`;
const namedOrder = 'accepts a small tables overlay';
const backdropGain = 'scales inherited tables gain with an explicit backdrop gain';
const coveredHole = 'accepts a covered base hole behind the figure';
const visibleHole = 'refuses a visible hole in the composited backdrop';
const backdropAudit = 'auditBackdrop({ order }, renderer.viewport!, renderer.pixelRatio)';
const handoff = 'centers on enter and returns to the live baked phase';
const sweep = 'runs the 12-second horizontal still sweep';

const plants = [
  code('pointer-unclamped', 1, clamps, 'clamp Y-up elapsed', compositor,
    'Math.max(-1, Math.min(1, value))', 'value'),
  code('pointer-y-down', 1, clamps, 'clamp Y-up elapsed', compositor,
    'y: clamp(1 - 2 * (clientY - viewport.top) / viewport.height)',
    'y: clamp(2 * (clientY - viewport.top) / viewport.height - 1)'),
  code('pointer-per-frame', 1, clamps, 'clamp Y-up elapsed', compositor,
    'const weight = -Math.expm1(-elapsed / TIME_CONSTANT);', 'const weight = 0.2;'),
  code('pointer-rig-delta-cap', 1, clamps, 'clamp Y-up elapsed', mount,
    'advance(Math.min(elapsed, 1 / 15), elapsed);', 'advance(Math.min(elapsed, 1 / 15));'),
  ...['pointerleave', 'pointercancel'].map(event =>
    code(`no-${event}`, 1, `${event} eases`, event, mount,
      `    root.addEventListener('${event}', recenter, true);\n`, '')),
  code('reverse-translation', 2, gains, 'parallax gains', compositor,
    'const x = -gain * camera.x;\n  const y = gain * camera.y;', 'const x = gain * camera.x;\n  const y = -gain * camera.y;'),
  code('figure-unanchored', 2, gains, 'parallax gains figure', compositor, 'figure: 0, foreground: 0.55', 'figure: 0.25, foreground: 0.55'),
  code('parallax-is-pan', 2, gains, 'parallax gains', compositor,
    'background: -0.55, figure: 0, foreground: 0.55', 'background: 1, figure: 1, foreground: 1'),
  code('unequal-pan', 2, gains, 'pan gains figure', compositor,
    "figure: planeShift(camera, mode === 'pan' ? 1 : GAINS.figure)",
    "figure: planeShift(camera, mode === 'pan' ? 0.7 : GAINS.figure)"),
  code('fixed-one-pixel', 3, fixed, 'fixed ordinary RGBA', mount,
    'renderer.viewport = native ? stage :', 'renderer.viewport = native ? { ...stage, x: stage.x + 1 } :'),
  mutation('static-foreground', 3, fixed, 'fixed ordinary RGBA', directory => {
    replace(directory, mount, '    poser.play(take.name, { loop: true });',
      `    poser.play(take.name, { loop: true });
    const stillForeground = poser.posedFrame(null).order.find(slot => slot.slot === 'foreground')!;`);
    replace(directory, mount, '      return { frame, backdrop: checkFrame(frame, planes) };',
      `      frame.order = frame.order.map(slot => slot.slot === 'foreground' ? stillForeground : slot);
      return { frame, backdrop: checkFrame(frame, planes) };`);
  }),
  code('pointer-time-into-poser', 4, clock, 'pointer-independent source clock', mount,
    'poser.advance(rigElapsed);', 'poser.advance(rigElapsed + Math.abs(target.x) * 0.005);'),
  code('camera-offset-into-poser', 4, clock, 'pointer-independent source clock', mount,
    'poser.advance(rigElapsed);', 'poser.advance(rigElapsed + Math.abs(camera.y) * 0.005);'),
  code('actor-background-on-backdrop', 5, order, 'actor:background stays on the figure', mount,
    'shifts[planes.get(slot.slot)!]', "shifts[slot.slot === 'actor:background' ? 'background' : planes.get(slot.slot)!]"),
  code('foreground-under-figure', 5, order, 'exact draw order and one draw per slot', mount,
    '      const shifts = planeOffsets(', `      frame = { ...frame, order: [...frame.order].sort((a, b) =>
        Number(b.slot === 'foreground') - Number(a.slot === 'foreground')) };
      const shifts = planeOffsets(`),
  code('missing-torso', 5, order, 'exact draw order and one draw per slot', mount,
    '      const shifts = planeOffsets(', `      frame = { ...frame, order: frame.order.filter(slot => slot.slot !== 'actor:torso') };
      const shifts = planeOffsets(`),
  code('unbound-foreground', 8, refuse('unbound existing foreground'), named('unbound existing foreground'), mount,
    '  const missing = [...drawable]', `  if (drawable.has('foreground') && !planes.has('foreground')) planes.set('foreground', 'figure');
  const missing = [...drawable]`),
  mutation('zero-padding', 6, cover, 'COMPOSED_BACKDROP_COVERAGE', directory => {
    for (const name of ['skeleton.model.json', 'skeleton.png', 'skeleton.atlas']) {
      cpSync(join(directory, fixture, 'original', name), join(directory, fixture, 'overscan', name));
    }
  }),
  ...[['x', 'width'], ['y', 'height']].map(([axis, dimension]) =>
    mutation(`undersized-${axis}`, 6, cover, 'COMPOSED_BACKDROP_COVERAGE', directory => {
      const path = join(directory, model);
      const doc = JSON.parse(readFileSync(path, 'utf8'));
      const plate = doc.skins[0].attachments.backdrop.backdrop;
      if (plate[dimension] !== 158) throw new Error(`Expected authored 158 px plate ${dimension}`);
      plate[dimension] = 136;
      writeFileSync(path, JSON.stringify(doc));
    })),
  raster('early-stage-crop', crop, ['stage crop RGBA', 'isolated full-geometry crop RGBA'],
    nativeFrameTransform,
    `        const clip: PosedClip = { convex: true, inverse: false, polygon: [-64, 0, 64, 0, 64, 128, -64, 128] };
        const cropped = { ...frame, order: frame.order.map(slot => slot.slot.startsWith('actor:') ? { ...slot, clip } : slot) };
        positioned = transformFrame(cropped, shiftFor, { centered, clipInStockSpace: true });`),
  code('viewport-is-clipped-bounds', 7, crop, 'viewport is original stage', mount,
    'renderer.viewport = native ? stage :', 'renderer.viewport = native ? { ...stage, width: 120 } :'),
  code('fixed-polygon', 7, 'moves an authored attachment polygon', 'polygon and figure move together', mount,
    'polygon: transform(clip.polygon)', 'polygon: clip.polygon'),
  {
    ...mutation('clip-offset-one-css-pixel', 7, clipRaster, clipAssertions, directory => {
      const clipCache = '  const clips = new Map<PosedClip, PosedClip>();';
      replace(directory, mount, clipCache, `${clipCache}\n  const offsetClips = new Map<PosedClip, PosedClip>();`);
      const transform = '    const transform = (xy: number[], delta = shift) => xy.map((value, i) => i % 2 === 0';
      // Shift each input clip once before it feeds both the presented and stock coordinates.
      replace(directory, mount, transform, `    if (slot.clip) {
      const original = slot.clip;
      const offset = offsetClips.get(original) ?? {
        ...original, polygon: original.polygon.map((value, i) => i % 2 === 0 ? value + 1 : value),
      };
      offsetClips.set(original, offset);
      slot = { ...slot, clip: offset };
    }
${transform}`);
    }),
    checkRaster: true,
  },
  raster('clip-on-wrong-plane', clipRaster, clipAssertions,
    nativeFrameTransform,
    `        const clip = frame.order.find(slot => slot.clip)?.clip;
        const wrongPlane = { ...frame, order: frame.order.map(slot => slot.slot === 'backdrop' || slot.clip
          ? { ...slot, clip: slot.slot === 'backdrop' ? clip : undefined }
          : slot) };
        positioned = transformFrame(wrongPlane, shiftFor, { centered, clipInStockSpace: true });`),
  raster('figure-offset-one-css-pixel', clipRaster, clipAssertions,
    'return { x: x * stage.width / layout.cssWidth, y: y * stage.height / layout.cssHeight };',
    `const figureOffset = planes.get(slot.slot) === 'figure' ? 1 : 0;
        return { x: (x + figureOffset) * stage.width / layout.cssWidth, y: y * stage.height / layout.cssHeight };`),
  code('missing-stage-accepted', 8, refuse('missing stage'), named('missing stage'), mount,
    '    const stage = requireStage(assets.stage);',
    '    const stage = assets.stage ?? { x: -64, y: 0, width: 128, height: 128 };'),
  code('nonloop-accepted', 8, refuse('loop disabled'), named('loop disabled'), mount,
    'if (options.loop !== true)', 'if (false)'),
  code('missing-animation-accepted', 8, refuse('named animation missing'), named('named animation missing'), mount,
    'assets.animations.find(animation => animation.name === options.animation);',
    "assets.animations.find(animation => animation.name === options.animation) ?? assets.animations.find(animation => animation.name === 'idle');"),
  code('missing-slot-accepted', 8, refuse('missing actor slot'), named('missing actor slot'), mount,
    '  if (missing.length) {', "  for (const slot of missing.splice(0)) planes.set(slot, 'figure');\n  if (missing.length) {"),
  code('unknown-slot-accepted', 8, refuse('unknown slot'), named('unknown slot'), mount,
    'if (!drawable.has(slot) || planes.has(slot))', 'if (planes.has(slot))'),
  code('duplicate-slot-accepted', 8, refuse('duplicate slot'), named('duplicate slot'), mount,
    'if (!drawable.has(slot) || planes.has(slot))', 'if (!drawable.has(slot))'),
  code('cross-plane-clip-accepted', 8, refuse('shared cross-plane clip'), named('shared cross-plane clip'), mount,
    'if (owner !== undefined && owner !== plane)', 'if (false)'),
  code('transparency-accepted', 8, refuse('transparent backdrop'), named('transparent backdrop'), mount,
    'if (lastNonOpaque) throw fail(', 'if (false) throw fail('),
  ...[['X', 'x'], ['Y', 'y']].map(([axis, suffix]) =>
    code(`short-${suffix}-accepted`, 8, refuse(`short backdrop ${axis} axis`), named(`short backdrop ${axis} axis`), mount,
      "].filter(Boolean);\n    if (uncovered.length) throw fail(`uncovered geometric edges ${uncovered.join(', ')}`);",
      '].filter(Boolean);\n    if (uncovered.length) return;')),
  code('named-tables-requires-stage-fill', 9, namedOrder, 'plane "tables"', mount,
    "    if (role === 'overlay') continue;\n", ''),
  code('named-tables-ignores-authored-ratio', 9, namedOrder, 'named tables gain', mount,
    'backdropGain * (baked.amplitudeX / reference.amplitudeX)', 'backdropGain'),
  code('named-tables-ignores-backdrop-gain-override', 9, backdropGain, 'inherited tables gain with backdrop override', mount,
    'backdropGain * (baked.amplitudeX / reference.amplitudeX)', 'BACKDROP_GAIN * (baked.amplitudeX / reference.amplitudeX)'),
  code('named-audits-base-without-overlay', 9, coveredHole, 'COMPOSED_BACKDROP_COVERAGE: plane "backdrop"', mount,
    backdropAudit, 'auditBackdrop({ order: order.slice(0, 1) }, renderer.viewport!, renderer.pixelRatio)'),
  code('named-figure-masks-composite-hole', 9, visibleHole, 'visible composited backdrop hole refusal', mount,
    backdropAudit, 'auditBackdrop(frame, renderer.viewport!, renderer.pixelRatio)'),
  code('named-backdrop-alpha-accepted', 9, 'refuses the named backdrop alpha-hole', 'named backdrop alpha-hole refusal', mount,
    '      if (nonOpaque) {\n        throw plateCoverageError(backdrop, next, `${nonOpaque}',
    '      if (false) {\n        throw plateCoverageError(backdrop, next, `${nonOpaque}'),
  code('named-backdrop-edge-ignored', 9, 'refuses the named backdrop left-edge', 'named backdrop left-edge detail', mount,
    "distances[i](x, y) * winding < -tolerance)));\n    if (uncovered.length) throw fail(`uncovered geometric edges ${uncovered.join(', ')}`);",
    "distances[i](x, y) * winding < -tolerance)));\n    void uncovered;"),
  code('named-skips-center', 10, handoff, ['enter blends the live backdrop toward center', 'center rendered before applying the pointer'], compositor,
    "enter() { retarget('acquiring'); }", "enter() { phase = 'tracking'; weight = 1; }"),
  code('named-never-returns-to-baked', 10, handoff, ['leave blends toward the advancing backdrop', 'leave reaches the current baked phase'], mount,
    "      if (mode === 'parallax') handoff.leave();\n", ''),
  code('named-handoff-pauses-figure', 10, handoff, 'live source clock', mount,
    '    function advance(rigElapsed: number, cameraElapsed = rigElapsed): void {\n      if (disposed || stopped) return;\n      advanceCamera(cameraElapsed);\n      syncTurn(mode);\n      poser.advance(rigElapsed);',
    '    function advance(rigElapsed: number, cameraElapsed = rigElapsed): void {\n      if (disposed || stopped) return;\n      advanceCamera(cameraElapsed);\n      syncTurn(mode);\n      if (!named || handoff.weight === 0) poser.advance(rigElapsed);'),
  code('named-touch-takes-camera', 11, sweep, 'touch stays automatic', mount,
    "event.pointerType === 'touch' || (event.type === 'pointerenter' && !boundaryEvent(event))", "(event.type === 'pointerenter' && !boundaryEvent(event))"),
];

const worktree = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [requestedOutput, selection = 'baseline'] = process.argv.slice(2);
if (selection === '--list') {
  console.log(plants.map(({ id, grep }) => `${id}\t${grep}`).join('\n'));
  process.exit(0);
}
if (!requestedOutput || !isAbsolute(requestedOutput) || (selection !== 'baseline' && selection !== 'all' && selection !== 'plants' && selection !== 'preflight' && !plants.some(plant => plant.id === selection))) {
  throw new Error('Usage: node tests/composed-take-plants.mjs /absolute/scratch/directory [baseline|preflight|plants|all|plant-id]');
}
const output = resolve(requestedOutput);
const relation = relative(worktree, output);
if (!relation || (!relation.startsWith('..') && !isAbsolute(relation))) throw new Error('Choose a scratch directory outside the tested worktree');
mkdirSync(output, { recursive: true });
const run = mkdtempSync(join(output, `${selection}-`));
const deps = join(worktree, 'node_modules');
const playwright = join(deps, '@playwright/test/cli.js');
const vite = join(deps, 'vite/bin/vite.js');
const inputs = [
  'package.json', 'src', 'samples', 'composed-parallax.html',
  'tests/composed-take.spec.ts', 'tests/composed-take-harness.ts', 'tests/composed-take-harness.html',
  ...['original', 'overscan', 'clip'].map(variant => join(fixture, variant)),
];
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function inventory(directory) {
  const files = new Map();
  function walk(path) {
    for (const item of readdirSync(join(directory, path), { withFileTypes: true })) {
      const child = join(path, item.name);
      if (item.isDirectory()) walk(child);
      if (item.isFile()) files.set(child, sha(join(directory, child)));
    }
  }
  walk('.');
  return files;
}

function snapshot(directory) {
  mkdirSync(directory);
  for (const input of inputs) {
    const destination = join(directory, input);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(worktree, input), destination, { recursive: true });
  }
}

function portNumber() {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.on('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

function errorsFor(report) {
  const results = [];
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          results.push({
            title: spec.title, project: test.projectName, status: result.status,
            errors: (result.errors ?? []).map(error => error.message ?? String(error)),
            raster: (result.attachments ?? []).filter(attachment => attachment.name === 'composed-crop-raster')
              .map(attachment => JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8'))),
          });
        }
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites ?? []) visit(suite);
  return results;
}

console.log(`Scratch run ${run}`);
const frozen = join(run, 'frozen-input');
snapshot(frozen);
const before = inventory(frozen);
writeJson(join(run, 'frozen-sha256.json'), Object.fromEntries(before));

function prepare(plant) {
  const id = plant?.id ?? 'baseline';
  const record = join(run, id);
  const directory = join(record, 'checkout');
  const logs = join(record, 'evidence');
  mkdirSync(logs, { recursive: true });
  cpSync(frozen, directory, { recursive: true, errorOnExist: true });
  plant?.change(directory);
  const after = inventory(directory);
  const changes = [...after].filter(([path, digest]) => before.get(path) !== digest)
    .map(([path, digest]) => ({ path, cleanSha256: before.get(path), plantedSha256: digest }));
  if (plant && !changes.length) throw new Error(`No file changed for ${id}`);
  writeJson(join(logs, 'changed-sha256.json'), changes);
  return { id, record, directory, logs, changes };
}

async function runCase(plant) {
  const { id, record, directory, logs, changes } = prepare(plant);
  symlinkSync(deps, join(directory, 'node_modules'), 'dir');

  const port = await portNumber();
  const baseURL = `http://127.0.0.1:${port}`;
  const readinessURL = `${baseURL}/tests/composed-take-harness.html`;
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const viteCommand = [process.execPath, vite, '--config', 'composed-vite.config.mjs',
    '--host', '127.0.0.1', '--port', String(port), '--strictPort'].map(quote).join(' ');
  writeFileSync(join(directory, 'composed-vite.config.mjs'), "export default { cacheDir: './composed-vite-cache', logLevel: 'error' };\n");
  writeFileSync(join(directory, 'composed-playwright.config.mjs'), `export default {
  testDir: './tests', workers: 1, retries: 0, timeout: 60_000,
  expect: { timeout: 10_000 }, outputDir: ${JSON.stringify(join(logs, 'playwright'))},
  reporter: [['list'], ['json', { outputFile: ${JSON.stringify(join(logs, 'playwright.json'))} }]],
  use: { baseURL: ${JSON.stringify(baseURL)}, viewport: { width: 900, height: 640 }, deviceScaleFactor: 1 },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: { command: ${JSON.stringify(viteCommand)}, url: ${JSON.stringify(readinessURL)}, timeout: 20_000, reuseExistingServer: false },
};\n`);
  const args = [playwright, 'test', 'composed-take.spec.ts', '--config=composed-playwright.config.mjs'];
  if (plant) args.push('--grep', plant.grep);
  const tmp = join(record, 'tmp');
  mkdirSync(tmp);
  const env = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  if (plant) delete env.COMPOSED_TAKE_EVIDENCE;
  else if (env.COMPOSED_TAKE_EVIDENCE) env.COMPOSED_TAKE_EVIDENCE = resolve(env.COMPOSED_TAKE_EVIDENCE);

  const result = spawnSync(process.execPath, args, { cwd: directory, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(logs, 'stdout.log'), result.stdout ?? '');
  writeFileSync(join(logs, 'stderr.log'), result.stderr ?? '');
  const receipt = {
    executable: process.execPath, args, cwd: directory, viteCommand, status: result.status,
    signal: result.signal, error: result.error?.message, changedFiles: changes.length,
    report: 'playwright.json',
  };
  writeJson(join(logs, 'command.json'), receipt);
  const report = join(logs, 'playwright.json');
  const results = existsSync(report) ? errorsFor(JSON.parse(readFileSync(report, 'utf8'))) : [];
  let verified = result.status === 0;
  if (plant) {
    const signatures = Array.isArray(plant.expected) ? plant.expected : [plant.expected];
    verified = result.status === 1 && results.length === 4 && ['chromium', 'webkit'].every(project =>
      results.filter(entry => entry.project === project).length === 2) && results.every(entry =>
      entry.status === 'failed' && entry.errors.some(error => signatures.some(signature => error.includes(signature))));
    if (plant.checkRaster) {
      const cells = results.map(entry => {
        const measurement = entry.raster.find(reading => reading.engine === entry.project && reading.views.some(view =>
          view.maxChannelDelta > 4 && signatures.includes(view.assertion) &&
          entry.errors.some(error => error.includes(view.assertion))));
        return measurement && `${entry.project}/${measurement.backend}`;
      });
      verified &&= ['chromium', 'webkit'].every(project =>
        ['canvas2d', 'webgl'].every(backend => cells.includes(`${project}/${backend}`)));
    }
  }
  writeJson(join(logs, 'verdict.json'), { id, verified, results });
  console.log(`${id}\texit ${result.status}\t${results.length} cells\t${verified ? 'verified' : 'unexpected'}\t${logs}`);
  return verified;
}

if (selection === 'preflight') {
  const summary = plants.map(plant => {
    try {
      const { id, changes } = prepare(plant);
      return { id, changes };
    } catch (error) {
      return { id: plant.id, error: String(error) };
    }
  });
  writeJson(join(run, 'preflight.json'), summary);
  const failed = summary.filter(record => record.error);
  console.log(`${summary.length - failed.length}/${summary.length} plants verified their source or fixture preimages and changed hashes`);
  for (const row of failed) console.error(`${row.id}: ${row.error}`);
  process.exit(Number(failed.length > 0));
}

const selected = selection === 'baseline' ? [undefined]
  : selection === 'all' ? [undefined, ...plants]
    : selection === 'plants' ? plants : plants.filter(plant => plant.id === selection);
for (const plant of selected) {
  if (!await runCase(plant)) {
    console.error(`Stopped at ${plant?.id ?? 'baseline'}; preserved snapshot and failure logs at ${run}`);
    process.exitCode = 1;
    break;
  }
}
