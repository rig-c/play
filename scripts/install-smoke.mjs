// Exercise an actual npm installation, never the checkout's source conditions.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const [flag, input, ...extra] = process.argv.slice(2);
if (!['--tarball', '--spec'].includes(flag) || !input || extra.length) {
  throw new Error('usage: node scripts/install-smoke.mjs --tarball <path> | --spec <name@version>');
}
const target = flag === '--tarball' ? resolve(input) : input;
const fixture = 'walk';
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootEntry = '@rig-c/play';
const composedEntry = '@rig-c/play/composed-take';
const sandbox = await realpath(await mkdtemp(resolve(tmpdir(), 'play-install-')));
let browser;
let server;
function npm(args) {
  const run = spawnSync('npm', args, {
    cwd: sandbox, stdio: 'inherit', timeout: 120_000,
  });
  if (run.error || run.status !== 0) throw new Error(`npm ${args[0]} failed: ${run.error ?? run.status}`);
}
try {
  npm(['init', '-y']);
  npm(['install', '--no-audit', '--no-fund', '--', target]);
  const packageDir = resolve(sandbox, 'node_modules', rootEntry);
  const installed = JSON.parse(await readFile(resolve(packageDir, 'package.json'), 'utf8'));
  // Current tarballs must expose the subpath. A historical registry spec may
  // predate it and still exercises the root entry.
  const withComposed = flag === '--tarball' || Object.hasOwn(installed.exports ?? {}, './composed-take');
  const entries = withComposed ? [rootEntry, composedEntry] : [rootEntry];
  // Resolve by package name under Node's default conditions, then use the same
  // installed entries in the browser.
  const resolved = spawnSync(process.execPath, ['--input-type=module', '-e',
    'console.log(JSON.stringify(process.argv.slice(1).map(name => import.meta.resolve(name))));',
    '--', ...entries], { cwd: sandbox, encoding: 'utf8', timeout: 10_000 });
  if (resolved.status !== 0) throw new Error(`installed import failed: ${resolved.stderr}`);
  const urls = JSON.parse(resolved.stdout);
  const imports = Object.fromEntries(entries.map((name, i) => {
    const path = fileURLToPath(urls[i]);
    if (!path.startsWith(`${packageDir}${sep}`)) throw new Error(`${name} escaped installation`);
    return [name, `/${relative(sandbox, path).split(sep).join('/')}`];
  }));
  await cp(resolve(checkout, 'public/rigs', fixture), resolve(sandbox, 'rig'), { recursive: true });
  if (withComposed) {
    const source = resolve(checkout, 'tests/fixtures/composed-direction/overscan');
    const destination = resolve(sandbox, 'composed-rig');
    await mkdir(destination);
    for (const file of ['skeleton.model.json', 'skeleton.png']) {
      await cp(resolve(source, file), resolve(destination, file));
    }
  }
  await writeFile(resolve(sandbox, 'index.html'), `<!doctype html>
<div id="stage" style="position:relative;width:512px;height:512px"></div>
${withComposed ? '<div id="composed-stage" style="position:relative;width:128px;height:128px"></div>' : ''}
<script type="importmap">${JSON.stringify({ imports })}</script>
<script type="module">
import * as play from '@rig-c/play';
function drawnPixels(canvas) {
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let drawn = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) drawn++;
  return drawn;
}
try {
  const assets = await play.loadModel({ modelUrl: '/rig/skeleton.model.json' });
  const player = new play.RigPlayer(document.querySelector('#stage'), assets, { mode: 'canvas' });
  player.play('walk');
  await new Promise(requestAnimationFrame);
  player.frame(1 / 60);
  await new Promise(requestAnimationFrame);
  const result = { pixels: drawnPixels(document.querySelector('#stage canvas')) };
  player.dispose();
  assets.dispose();
  if (${withComposed}) {
    const { mountComposedTake } = await import('@rig-c/play/composed-take');
    const take = await mountComposedTake(document.querySelector('#composed-stage'), {
      modelUrl: '/composed-rig/skeleton.model.json',
      animation: 'idle',
      loop: true,
      backend: 'canvas2d',
      autoStart: false,
      planes: {
        background: { role: 'backdrop', slots: ['backdrop'] },
        figure: { role: 'figure', slots: ['actor:background', 'actor:torso', 'actor:lantern', 'actor:face', 'actor:eye_r', 'actor:eye_l'] },
        foreground: { role: 'overlay', slots: ['foreground'], gain: 0.55 },
      },
    });
    try {
      result.sameRigPlayer = take.player.constructor === play.RigPlayer;
      result.sameCanvasRenderer = take.player.renderer.constructor === play.CanvasRenderer;
      take.advance(1 / 60);
      take.render();
      result.composedPixels = drawnPixels(take.canvas);
    } finally {
      take.dispose();
    }
  }
  window.smoke = result;
} catch (error) { window.smoke = { error: String(error.stack || error) }; }
</script>`);
  // The only served root is the empty consumer directory, including copied
  // fixture assets and npm's installed files. No runtime route reaches checkout.
  server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const path = resolve(sandbox, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!path.startsWith(`${sandbox}${sep}`)) { res.writeHead(403).end(); return; }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.smoke);
  const result = await page.evaluate(() => window.smoke);
  console.log(JSON.stringify({ package: installed.name, version: installed.version, fixture, ...result }));
  if (errors.length || result.error || !(result.pixels > 0)) {
    throw new Error(`installed render failed: ${result.error ?? (errors.join('\n') || 'no drawn pixels')}`);
  }
  if (withComposed && (!(result.composedPixels > 0) || !result.sameRigPlayer || !result.sameCanvasRenderer)) {
    throw new Error(`installed composed render or constructor identity failed: ${JSON.stringify(result)}`);
  }
} finally {
  await browser?.close();
  if (server) await new Promise(done => server.close(done));
  await rm(sandbox, { recursive: true, force: true });
}
