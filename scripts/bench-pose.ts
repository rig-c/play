import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { type ModelAssets, readModelText } from '../src/loadModel.js';
import { RigPlayer } from '../src/player.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface PoseBenchOptions {
  rig?: string;
  model?: string;
  animation?: string;
  skin?: string;
  counts: number[];
  warmup: number;
  samples: number;
  dt: number;
}

/** Read only the compiled model: no images, DOM, region extraction or renderer calls. */
export function readPoseAssets(model: string): ModelAssets {
  return readPoseInput(model).assets;
}

function readPoseInput(model: string) {
  let input: Buffer;
  try {
    input = readFileSync(model);
  } catch (error) {
    throw new Error(`Cannot read model ${JSON.stringify(model)}; run \`bun run fetch-assets\` for repository fixtures.`, { cause: error });
  }
  const document = readModelText(input.toString('utf8'), model);
  const assets: ModelAssets = {
    spec: document.spec,
    animations: document.doc.animations.map((a) => ({ name: a.name, duration: a.timelines.duration })),
    skins: document.doc.skins.map((s) => s.name),
    sets: [], stage: null, regions: 'data',
    regionImages: new Map(), pageImages: new Map(), document,
    dispose() {},
  };
  return { assets, modelSHA256: createHash('sha256').update(input).digest('hex') };
}

export function posePlayer(assets: ModelAssets, skin?: string): RigPlayer {
  // DomRenderer's constructor only stores the root. Fail if this measurement
  // ever starts touching it: advance/posedFrame must not draw or read layout.
  const root = new Proxy({} as HTMLElement, {
    get() { throw new Error('pose benchmark accessed the DOM root'); },
    set() { throw new Error('pose benchmark changed the DOM root'); },
  });
  return new RigPlayer(root, assets, { skin });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function runPoseBenchmark(options: PoseBenchOptions) {
  const model = options.model ?? resolve(root, 'public/rigs', options.rig ?? 'look', 'skeleton.model.json');
  const { assets, modelSHA256 } = readPoseInput(model);
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { devDependencies: { 'rig-c': string } };
  const animation = options.animation ?? assets.animations[0]?.name;
  if (animation === undefined) throw new Error('pose benchmark needs an animation');
  if (!assets.animations.some((a) => a.name === animation)) throw new Error(`No animation named ${JSON.stringify(animation)}`);
  const results = options.counts.map((count) => {
    const players: RigPlayer[] = [];
    try {
      for (let i = 0; i < count; i++) {
        const player = posePlayer(assets, options.skin);
        players.push(player);
        player.play(animation, { loop: true });
      }
      let slots = 0;
      const step = () => {
        for (const player of players) {
          player.advance(options.dt);
          slots += player.posedFrame().order.length;
        }
      };
      for (let i = 0; i < options.warmup; i++) step();
      slots = 0;
      const timings: number[] = [];
      for (let i = 0; i < options.samples; i++) {
        const start = performance.now();
        step();
        timings.push(performance.now() - start);
      }
      const p50Ms = median(timings);
      return { count, p50Ms, p50MsPerPlayer: p50Ms / count, slots, generation: players[0].generation, time: players[0].time };
    } finally {
      for (const player of players) player.dispose();
    }
  });
  return {
    measurement: 'advance+posedFrame', render: false,
    runtime: { name: process.versions.bun ? 'bun' : 'node', version: process.versions.bun ?? process.versions.node },
    corePin: manifest.devDependencies['rig-c'], modelSHA256, loop: true,
    iterationOrder: 'for each player: advance(dt), posedFrame()',
    percentileConvention: 'p50 of sorted batch samples: middle sample if odd, arithmetic mean of the middle two if even; per-player p50 is batch p50 / count',
    rig: options.model === undefined ? options.rig ?? 'look' : null,
    animation, skin: options.skin ?? null,
    warmup: options.warmup, samples: options.samples, dt: options.dt,
    results,
  };
}

export function parsePoseBenchArgs(args: string[]): PoseBenchOptions {
  const options: PoseBenchOptions = { counts: [1, 100], warmup: 60, samples: 300, dt: 1 / 60 };
  const positiveInteger = (value: string, flag: string, minimum = 1) => {
    const n = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < minimum) throw new Error(`${flag} must be an integer >= ${minimum}`);
    return n;
  };
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--') || value.length === 0) throw new Error(`Missing value for ${flag}`);
    switch (flag) {
      case '--rig':
        if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('--rig must name a repository fixture');
        options.rig = value; break;
      case '--model': options.model = resolve(value); break;
      case '--animation': options.animation = value; break;
      case '--skin': options.skin = value; break;
      case '--counts': options.counts = value.split(',').map((n) => positiveInteger(n, flag)); break;
      case '--warmup': options.warmup = positiveInteger(value, flag, 0); break;
      case '--samples': options.samples = positiveInteger(value, flag); break;
      case '--dt':
        options.dt = Number(value);
        if (!(options.dt > 0) || !Number.isFinite(options.dt)) throw new Error('--dt must be finite and positive');
        break;
      default: throw new Error(`Unknown option ${flag}`);
    }
  }
  if (options.rig !== undefined && options.model !== undefined) throw new Error('Choose --rig or --model');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(runPoseBenchmark(parsePoseBenchArgs(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
