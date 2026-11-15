// Exercise an actual npm installation, never the checkout's source conditions.
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const sandbox = await mkdtemp(resolve(tmpdir(), 'play-install-'));
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
  const installed = JSON.parse(await readFile(resolve(sandbox, 'node_modules/@rig-c/play/package.json'), 'utf8'));
  // Node resolves the installed exports map by package name with consumer
  // conditions. The import map gives the browser that same resolved entry.
  const resolved = spawnSync(process.execPath, ['--input-type=module', '-e',
    'console.log(import.meta.resolve("@rig-c/play"))'], { cwd: sandbox, encoding: 'utf8', timeout: 10_000 });
  if (resolved.status !== 0) throw new Error(`installed import failed: ${resolved.stderr}`);
  const entry = relative(sandbox, fileURLToPath(resolved.stdout.trim()));
  if (entry.startsWith('..') || resolve(sandbox, entry) === sandbox) throw new Error('entry escaped installation');
  await cp(resolve(checkout, 'public/rigs', fixture), resolve(sandbox, 'rig'), { recursive: true });
  const imports = JSON.stringify({ imports: { '@rig-c/play': `/${entry.split(sep).join('/')}` } });
  await writeFile(resolve(sandbox, 'index.html'), `<!doctype html>
<div id="stage" style="position:relative;width:512px;height:512px"></div>
<script type="importmap">${imports}</script>
<script type="module">
import { loadModel, RigPlayer } from '@rig-c/play';
try {
  const assets = await loadModel({ modelUrl: '/rig/skeleton.model.json' });
  const player = new RigPlayer(document.querySelector('#stage'), assets, { mode: 'canvas' });
  player.play('walk');
  await new Promise(requestAnimationFrame);
  player.frame(1 / 60);
  await new Promise(requestAnimationFrame);
  const canvas = document.querySelector('#stage canvas');
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let drawn = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) drawn++;
  window.smoke = { pixels: drawn };
  player.dispose();
  assets.dispose();
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
} finally {
  await browser?.close();
  if (server) await new Promise(done => server.close(done));
  await rm(sandbox, { recursive: true, force: true });
}
