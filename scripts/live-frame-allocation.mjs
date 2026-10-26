/** CPU-only allocation of the real RigPlayer advance/liveFrame API; never draws. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as jsc from 'bun:jsc';
import { RigPlayer } from '../src/player.ts';
import { readModelText } from '../src/loadModel.ts';

const path = process.argv[2];
const animation = process.argv[3];
if (!path || !animation) throw Error('LIVE_ALLOC_INPUT: expected model path and explicit animation');
const requireEvents = process.argv.includes('--require-events');
const mode = process.argv[4]?.startsWith('--') ? undefined : process.argv[4];
const frames = 1024;
function touch(value) { return Array.isArray(value) ? value.length : Number(value); }
if (typeof jsc.noInline !== 'function') throw Error('LIVE_ALLOC_UNAVAILABLE: bun:jsc.noInline needed for unretained allocation control');
jsc.noInline(touch);

if (!mode) {
  const results = [];
  for (const variant of ['production', 'advance-only', 'live-only', 'development', 'snapshot', 'plant']) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), path, animation, variant, ...(requireEvents ? ['--require-events'] : [])], {
      env: { ...process.env, BUN_JSC_useGC: '0' }, encoding: 'utf8', maxBuffer: 8 * 1024 ** 2,
    });
    if (result.status !== 0) throw Error(`LIVE_ALLOC_CHILD: ${variant} exit ${result.status}: ${result.stderr || result.stdout}`);
    results.push(JSON.parse(result.stdout));
  }
  const production = results.find(value => value.mode === 'production');
  if (requireEvents && production.eventKeys === 0) throw Error('LIVE_ALLOC_REQUIRED_EVENTS: input animation has no event keys');
  const planted = results.find(value => value.mode === 'plant');
  const controlDelta = planted.heapBytesPerFrame - production.heapBytesPerFrame;
  const controlPassed = controlDelta >= 16384 * 0.88;
  const zeroAllocationPassed = production.heapBytesPerFrame === 0 && production.arrayBuffersDeltaBytes === 0 && production.externalDeltaBytes === 0;
  const eventDeliveryPassed = production.eventKeys === 0 || production.observedEvents > 0;
  console.log(JSON.stringify({ zeroAllocationPassed, eventDelivery: production.eventKeys === 0 ? 'not applicable: no event keys' : eventDeliveryPassed ? 'observed' : 'missing', protocol: 'live-frame-alloc-v1', frames, results, unretainedControlExpectedBytesPerFrame: 16384, controlDelta, controlPassed }, null, 2));
  if (!controlPassed || !zeroAllocationPassed || !eventDeliveryPassed) process.exit(1);
} else {
  if (process.env.BUN_JSC_useGC !== '0') throw Error('LIVE_ALLOC_GC: child must start with BUN_JSC_useGC=0');
  const text = readFileSync(path, 'utf8');
  const read = readModelText(text, 'allocation input');
  const assets = {
    spec: read.spec, document: read,
    animations: read.doc.animations.map(value => ({ name: value.name, duration: value.duration })),
    skins: read.doc.skins.map(value => value.name), sets: [], stage: null,
    regions: 'data', regionImages: new Map(), pageImages: new Map(), dispose() {},
  };
  // DomRenderer's constructor stores these resources but does no DOM work.
  // No renderer/DOM function is executed in the measured path.
  const player = new RigPlayer(Object.freeze({}), assets, { liveFrameChecks: mode === 'development' });
  player.play(animation);
  if (player.poser !== 'runtime') throw Error(`LIVE_ALLOC_NOT_MEASURABLE: ${player.poser}`);
  const runtime = Reflect.get(player, 'runtimeFrames');
  const eventKeys = runtime.model.animation(animation).eventKeys.length;
  let observedEvents = 0;
  let sink = 0;
  const step = () => {
    if (mode !== 'live-only') {
      player.advance(1 / 60);
      observedEvents += runtime.pose.events.length;
    }
    if (mode === 'advance-only') { sink += touch(player.time); return; }
    const view = mode === 'snapshot' ? player.posedFrame() : player.liveFrame();
    sink += touch(mode === 'snapshot' ? view.order.length : view.count);
    if (mode !== 'snapshot' && view.count > 0) sink += touch(view.vertices[view.attachments[view.drawOrder[0]].offset]);
    if (mode === 'plant') for (let i = 0; i < 256; i++) sink += touch([i, i + 1, i + 2, i + 3]);
  };
  for (let i = 0; i < 2048; i++) step();
  const emptyBefore = process.memoryUsage();
  for (let i = 0; i < frames; i++) sink += touch(i);
  const emptyAfter = process.memoryUsage();
  const instrumentationHeapDeltaBytes = emptyAfter.heapUsed - emptyBefore.heapUsed;
  observedEvents = 0;
  const before = process.memoryUsage();
  for (let i = 0; i < frames; i++) step();
  const after = process.memoryUsage();
  console.log(JSON.stringify({ mode, frames, eventKeys, observedEvents, poser: player.poser, gcDisabled: true, bun: Bun.version,
    modelSha256: createHash('sha256').update(text).digest('hex'),
    heapDeltaBytes: after.heapUsed - before.heapUsed,
    heapBytesPerFrame: (after.heapUsed - before.heapUsed - instrumentationHeapDeltaBytes) / frames,
    instrumentationHeapDeltaBytes, rawHeapBytesPerFrame: (after.heapUsed - before.heapUsed) / frames,
    arrayBuffersDeltaBytes: after.arrayBuffers - before.arrayBuffers,
    externalDeltaBytes: after.external - before.external,
    sink, boundary: 'RigPlayer.advance + liveFrame; no listeners, renderer, DOM or pixel evidence',
  }));
  player.dispose();
}
