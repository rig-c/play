import { CanvasRenderer, loadModel, RigPlayer, type PosedFrame } from '../src/index';

function mismatch(a: unknown, b: unknown, path = 'frame'): string | null {
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) ? null : `${path}: ${a} != ${b}`;
  if (a === b) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return `${path}: ${String(a)} != ${String(b)}`;
  const left = Object.keys(a), right = Object.keys(b);
  if (left.length !== right.length || left.some(key => !right.includes(key))) return `${path}: different keys`;
  for (const key of left) {
    const found = mismatch((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function pixels(player: RigPlayer): Uint8ClampedArray {
  const renderer = player.renderer as CanvasRenderer;
  const canvas = renderer.canvas;
  const copy = document.createElement('canvas');
  copy.width = canvas.width; copy.height = canvas.height;
  const ctx = copy.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0);
  return ctx.getImageData(0, 0, copy.width, copy.height).data;
}

export async function liveFrameProbe(rig: string, mutant: 'none' | 'vertices' | 'snapshot' | 'lease' = 'none') {
  const assets = await loadModel({ modelUrl: `/rigs/${rig}/skeleton.model.json` });
  const rows: Array<{ animation: string; poser: string; frames: number; numeric: string[]; pixelDifferences: number; pixelValues: number; contentPixels: number; snapshotKept: boolean; stale: boolean; nestedStale: boolean; rendererStale: boolean; readonly: boolean; drawIdentity: boolean | null }> = [];
  try {
    for (const animation of assets.animations) {
      const roots = [document.createElement('div'), document.createElement('div')];
      roots.forEach(root => document.body.append(root));
      const runtime = new RigPlayer(roots[0], assets, { mode: 'canvas', liveFrameChecks: mutant !== 'lease' });
      const oracle = new RigPlayer(roots[1], assets, { mode: 'canvas', poser: 'oracle' });
      try {
        runtime.play(animation.name); oracle.play(animation.name);
        if (mutant === 'snapshot' && runtime.poser === 'runtime') {
          runtime.posedFrame = () => (Reflect.get(runtime, 'runtimeFrames') as { renderFrame: PosedFrame }).renderFrame;
        }
        const numeric: string[] = [];
        let pixelDifferences = 0, pixelValues = 0, contentPixels = 0;
        let stale = false, nestedStale = false, rendererStale = false, readonly = false;
        let drawIdentity: boolean | null = null;
        const held = runtime.posedFrame();
        const kept = JSON.stringify(held);
        let count = 0;
        for (const step of [0, 0.125, 0.375, 0.75]) {
          const lease = runtime.liveFrame();
          const nested = lease.vertices;
          runtime.advance(step); oracle.advance(step);
          if (step > 0) {
            try { void lease.count; } catch (error) { stale = String(error).includes('LIVE_FRAME_STALE'); }
            try { void nested.length; } catch (error) { nestedStale = String(error).includes('LIVE_FRAME_STALE'); }
            try { runtime.renderer.render(lease); } catch (error) { rendererStale = String(error).includes('LIVE_FRAME_STALE'); }
          }
          if (mutant === 'vertices' && runtime.poser === 'runtime') {
            const raw = (Reflect.get(runtime, 'runtimeFrames') as { pose: { vertices: Float64Array } }).pose.vertices;
            for (let i = 0; i < raw.length; i += 2) Reflect.set(raw, String(i), raw[i] + 20);
          }
          const a = runtime.posedFrame(), b = oracle.posedFrame();
          const difference = mismatch(a, b);
          if (difference) numeric.push(difference);
          const identityDifference = mismatch(runtime.slotIdentity(), oracle.slotIdentity(), 'identity');
          if (identityDifference) numeric.push(identityDifference);
          const view = runtime.liveFrame();
          if (view.count !== a.order.length) numeric.push(`live count ${view.count} != snapshot ${a.order.length}`);
          for (let i = 0; i < view.count; i++) {
            const attachment = view.attachments[view.drawOrder[i]];
            const slot = a.order[i];
            if (attachment.slot !== slot.slot) numeric.push(`live slot ${attachment.slot} != snapshot ${slot.slot}`);
            const points = slot.kind === 'region' ? slot.corners : slot.vertices;
            for (let c = 0; c < points.length; c++) if (!Object.is(view.vertices[attachment.offset + c], points[c])) numeric.push(`live vertex ${attachment.slot}[${c}] differs`);
            for (let c = 0; c < 4; c++) if (!Object.is(view.tint[attachment.slotIndex * 4 + c], slot.tint[c])) numeric.push(`live tint ${attachment.slot}[${c}] differs`);
          }
          try { Reflect.set(view.vertices, '0', 123); } catch (error) { readonly = String(error).includes('LIVE_FRAME_READONLY'); }
          const bounds = oracle.bounds();
          if (bounds) {
            const viewport = { x: Math.floor(bounds.x) - 2, y: Math.floor(bounds.y) - 2, width: Math.ceil(bounds.width) + 5, height: Math.ceil(bounds.height) + 5 };
            (runtime.renderer as CanvasRenderer).viewport = viewport;
            (oracle.renderer as CanvasRenderer).viewport = viewport;
            runtime.draw(); oracle.draw();
            const pa = pixels(runtime), pb = pixels(oracle);
            if (pa.length !== pb.length) numeric.push('pixel dimensions differ');
            else { pixelValues += pa.length; for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) pixelDifferences++; for (let i = 3; i < pb.length; i += 4) if (pb[i] > 0) contentPixels++; }
          }
          count++;
        }
        if (runtime.poser === 'runtime') {
          const productionRoot = document.createElement('div'); document.body.append(productionRoot);
          const production = new RigPlayer(productionRoot, assets, { mode: 'canvas', liveFrameChecks: false });
          try {
            production.play(animation.name);
            const before = production.liveFrame();
            const vertices = before.vertices, tint = before.tint, order = before.drawOrder, attachments = before.attachments;
            production.advance(0.1);
            const after = production.liveFrame();
            drawIdentity = before === after && vertices === after.vertices && tint === after.tint && order === after.drawOrder && attachments === after.attachments;
          } finally { production.dispose(); productionRoot.remove(); }
        } else drawIdentity = null; // Not measurable on the oracle fallback.
        rows.push({ animation: animation.name, poser: runtime.poser, frames: count, numeric, pixelDifferences, pixelValues, contentPixels, snapshotKept: JSON.stringify(held) === kept, stale, nestedStale, rendererStale, readonly, drawIdentity });
      } finally { runtime.dispose(); oracle.dispose(); roots.forEach(root => root.remove()); }
    }
    return { rig, rows };
  } finally { assets.dispose(); }
}

export async function liveFrameTransitions() {
  const assets = await loadModel({ modelUrl: '/rigs/turned/skeleton.model.json' });
  const root = document.createElement('div'); document.body.append(root);
  const runtime = new RigPlayer(root, assets, { mode: 'canvas', liveFrameChecks: true });
  try {
    const name = assets.animations[0].name;
    runtime.play(name);
    runtime.advance(0.35);
    const before = runtime.posedFrame();
    const live = runtime.liveFrame();
    const at = runtime.time;
    runtime.setAlpha(0, 0.5);
    const composedReason = runtime.poser;
    let oldStale = false;
    try { void live.count; } catch (error) { oldStale = String(error).includes('LIVE_FRAME_STALE'); }
    const composedTime = runtime.time;
    runtime.dispose();
    let disposed = false;
    try { runtime.liveFrame(); } catch (error) { disposed = String(error).includes('LIVE_FRAME_DISPOSED'); }
    return { beforeCount: before.order.length, at, composedTime, composedReason, oldStale, disposed };
  } finally { runtime.dispose(); root.remove(); assets.dispose(); }
}
