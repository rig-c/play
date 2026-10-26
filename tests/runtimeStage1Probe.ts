import { CanvasRenderer, loadModel, RigPlayer, type RigEvent, type RigComplete } from '../src/index';

import { mismatch as difference } from './liveFrameProbe';

type Delivery = { kind: 'event'; value: RigEvent } | { kind: 'complete'; value: RigComplete };

/** Public listener delivery, including a listener replacing the active animation. */
export async function runtimeEventsProbe(reentrant = false, drop = false) {
  const assets = await loadModel({ modelUrl: '/rigs/turned/skeleton.model.json' });
  const roots = [document.createElement('div'), document.createElement('div')];
  roots.forEach(root => document.body.append(root));
  const players = [new RigPlayer(roots[0], assets), new RigPlayer(roots[1], assets, { poser: 'oracle' })];
  const deliveries: Delivery[][] = [[], []];
  const held: Array<{ value: RigEvent; text: string } | null> = [null, null];
  try {
    const animation = assets.animations[0].name;
    for (let index = 0; index < players.length; index++) {
      const player = players[index];
      let replaced = false;
      player.on('event', value => {
        deliveries[index].push({ kind: 'event', value });
        held[index] ??= { value, text: JSON.stringify(value) };
        if (reentrant && !replaced) { replaced = true; player.play(animation); }
      });
      player.on('complete', value => deliveries[index].push({ kind: 'complete', value }));
      player.play(animation);
    }
    if (drop) {
      const state = Reflect.get(players[0], 'runtimeFrames') as { pose: object };
      Object.defineProperty(state.pose, 'events', { get: () => [] });
    }
    for (const dt of [0.125, 0.125, 0.5, 0.5, 1.25, 0.75]) for (const player of players) player.advance(dt);
    return { poser: players[0].poser, deliveries, difference: difference(deliveries[0], deliveries[1]),
      heldUnchanged: held.every(value => value !== null && JSON.stringify(value.value) === value.text) };
  } finally { players.forEach(player => player.dispose()); assets.dispose(); roots.forEach(root => root.remove()); }
}

function capture(player: RigPlayer): Uint8ClampedArray {
  const source = (player.renderer as CanvasRenderer).canvas;
  const canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
  const context = canvas.getContext('2d')!; context.drawImage(source, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

/** The route supplies two skins with a required bone, animated root and event keys. */
export async function runtimeSkinProbe(wrongSkin = false) {
  const assets = await loadModel({ modelUrl: '/rigs/turned/skeleton.model.json' });
  const roots = [document.createElement('div'), document.createElement('div')]; roots.forEach(root => document.body.append(root));
  const players = [new RigPlayer(roots[0], assets, { mode: 'canvas', liveFrameChecks: true }), new RigPlayer(roots[1], assets, { mode: 'canvas', poser: 'oracle' })];
  const deliveries: RigEvent[][] = [[], []];
  try {
    for (let i = 0; i < players.length; i++) { players[i].on('event', event => deliveries[i].push(event)); players[i].play(assets.animations[0].name); players[i].advance(1.375); }
    const rows = [];
    for (const skin of ['alt', 'default', undefined, 'alt']) {
      const held = players[0].posedFrame(), saved = JSON.stringify(held), lease = players[0].liveFrame();
      players[0].skin = wrongSkin && skin === 'alt' ? 'default' : skin;
      players[1].skin = skin;
      let stale = false;
      try { void lease.count; } catch (error) { stale = String(error).includes('LIVE_FRAME_STALE'); }
      const state = Reflect.get(players[0], 'runtimeFrames') as { pose: { events: readonly { name: string }[] } } | null;
      const pending = state?.pose.events.map(event => event.name) ?? null;
      const bounds = players[1].bounds(); let pixelDifferences = 0, pixelValues = 0;
      if (bounds) {
        const viewport = { x: Math.floor(bounds.x) - 2, y: Math.floor(bounds.y) - 2, width: Math.ceil(bounds.width) + 5, height: Math.ceil(bounds.height) + 5 };
        for (const player of players) { (player.renderer as CanvasRenderer).viewport = viewport; player.draw(); }
        const a = capture(players[0]), b = capture(players[1]); pixelValues = a.length;
        if (a.length !== b.length) pixelDifferences++;
        else for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) pixelDifferences++;
      }
      rows.push({ skin: skin ?? null, poser: players[0].poser, time: players[0].time,
        frameDifference: difference(players[0].posedFrame(), players[1].posedFrame()),
        identityDifference: difference(players[0].slotIdentity(), players[1].slotIdentity()),
        pending, stale, snapshotKept: JSON.stringify(held) === saved, pixelDifferences, pixelValues });
    }
    for (const player of players) player.advance(0.5);
    return { rows, deliveries, deliveryDifference: difference(deliveries[0], deliveries[1]) };
  } finally { players.forEach(player => player.dispose()); assets.dispose(); roots.forEach(root => root.remove()); }
}
