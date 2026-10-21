import { openTrack, openTracks, physicsClockStep, underNoSkin, underSkin, type RawPose, type LiveTrack, type LiveTracks } from 'rig-c/core';
import { RigPlayer, type BoneAdjust, type BoneAdjustContext, type ModelAssets, type PhysicsParameterPatch, type PhysicsParameters } from '../src/index';
import type { ReadDocument } from '../src/loadModel';
import { loadRig } from './rigFrames';

const dt = 1 / 60;
const defaults: PhysicsParameters = { strength: 100, damping: 0.85, inertia: 0.5, wind: 0, gravity: 0, mix: 1 };
const declared: PhysicsParameters = { strength: 60, damping: 0.8, inertia: 0.4, wind: 12, gravity: 12, mix: 0.9 };
const patch: PhysicsParameters = { strength: 75, damping: 0.3, inertia: 0.6, wind: 7, gravity: 8, mix: 0.7 };
const keys = Object.keys(patch) as Array<keyof PhysicsParameters>;
const words = (p: RigPlayer) => ['root', 'link', 'spare', 'optional'].flatMap((name) => {
  const b = p.bone(name); return [b.x, b.y, b.a, b.b, b.c, b.d, b.rotationX, b.rotationY, b.scaleX, b.scaleY];
});
const coreWords = (pose: RawPose) => pose.bones.flatMap((b) => [b.worldX, b.worldY, b.a, b.b, b.c, b.d, b.rotationX, b.rotationY, b.scaleX, b.scaleY]);
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** Public calls only: no private parameter/state map access or alternate solver. */
export async function liveCoreProbe(group: 'adjust' | 'physics' | 'lifetime') {
  const assets = await loadRig('parameters', { regions: 'data' });
  const roots: HTMLElement[] = [];
  const players: RigPlayer[] = [];
  const rows: Array<{ label: string; pass: boolean; detail?: unknown }> = [];
  function check(label: string, pass: boolean, detail?: unknown) { rows.push({ label, pass, detail }); }
  function equal(label: string, a: unknown, b: unknown) { check(label, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b }); }
  function player(tracks = false, adjust?: BoneAdjust, skin?: string, mode: 'dom' | 'canvas' = 'canvas', input = assets) {
    const root = document.createElement('div'); document.body.append(root); roots.push(root);
    const p = new RigPlayer(root, input, { tracks, adjust, skin, mode }); players.push(p); return p;
  }
  function core(tracks: boolean, animation = 'idle', skin?: string, adjust?: BoneAdjust) {
    const doc = (assets.document as ReadDocument).doc;
    const view = skin === undefined ? underNoSkin(doc) : underSkin(doc, skin);
    if (!tracks) {
      const live = openTrack(view, animation, { loop: true, reset: 'animation', adjust, clock: physicsClockStep });
      return { live: live as LiveTrack | LiveTracks, pose: live.first };
    }
    const live = openTracks(view, { reset: 'animation', adjust, clock: physicsClockStep });
    live.setAnimation(0, animation, { loop: true, mixDuration: 0 });
    return { live: live as LiveTrack | LiveTracks, pose: live.start() };
  }
  function walk(p: RigPlayer, time: number) {
    for (let i = 0, n = Math.floor(time / dt); i < n; i++) p.advance(dt);
    const rest = time - p.time; if (rest > 0) p.advance(rest);
  }
  try {
    if (group === 'adjust') {
      for (const tracks of [false, true]) {
        const calls: BoneAdjustContext[] = [];
        const adjust: BoneAdjust = (bones, ctx) => { calls.push({ ...ctx }); bones.bone('root').rotation = (ctx.trackTime ?? 0) * 37; };
        const p = player(tracks, adjust); p.play('idle');
        equal(`initial ctx ${tracks}`, calls.at(-1), { trackTime: 0, animation: 'idle', globalTime: 0 });
        const count = calls.length; p.pause(); p.frame(dt); p.frame(0); p.mode = 'dom'; p.mode = 'canvas';
        equal(`pause zero mode schedule ${tracks}`, calls.length, count);
        p.repose(); equal(`repose time ${tracks}`, calls.at(-1), { trackTime: 0, animation: 'idle', globalTime: 0 }); p.resume();
        p.timeScale = 2; p.advance(0.25);
        equal(`scaled ctx ${tracks}`, calls.at(-1), { trackTime: 0.5, animation: 'idle', globalTime: 0.5 });
        p.advance(1); equal(`loop unwrapped ${tracks}`, calls.at(-1), { trackTime: 2.5, animation: 'idle', globalTime: 2.5 });
        p.play('idle', { loop: false }); p.timeScale = 1; p.advance(1.25);
        equal(`held nonloop ${tracks}`, calls.at(-1), { trackTime: 1.25, animation: 'idle', globalTime: p.time });
        p.play('idle'); p.advance(0.9); // nonzero displayed time while the seek frontier opens
        for (const t of [1.137, 0, 0.25, 1.137, 0.25, 2.2]) {
          p.seek(t);
          const continuous = player(tracks, (b, ctx) => { b.bone('root').rotation = (ctx.trackTime ?? 0) * 37; });
          continuous.play('idle'); walk(continuous, t);
          check(`seek bone bits ${tracks}/${t}`, same(words(p), words(continuous)));
          equal(`seek geometry ${tracks}/${t}`, p.posedFrame(), continuous.posedFrame());
        }
        const unary = player(tracks, (bones) => { bones.bone('root').rotation = 23; });
        const binary = player(tracks, (bones, _ctx) => { bones.bone('root').rotation = 23; });
        unary.play('idle'); binary.play('idle'); unary.advance(dt); binary.advance(dt);
        check(`unary identical ${tracks}`, same(words(unary), words(binary)));
        const fn = p.adjust; equal(`getter identity ${tracks}`, p.adjust === fn, true);
        p.adjust = null; equal(`nullable adjust ${tracks}`, p.adjust, null);
      }
      const calls: BoneAdjustContext[] = [];
      const p = player(true, (_b, c) => calls.push({ ...c }));
      p.play('idle', { track: 1 });
      equal('no base entry null/null', calls.at(-1), { trackTime: null, animation: null, globalTime: 0 });
      p.advance(0.4); let n = calls.length;
      p.play('idle', { mix: 0.5 });
      equal('one call after composition', calls.length - n, 1);
      equal('new current entry differs from global', calls.at(-1), { trackTime: 0, animation: 'idle', globalTime: 0.4 });
      p.advance(0.2); n = calls.length; p.repose(); equal('repose exactly once', calls.length - n, 1);
      p.queue('idle', { delay: 0.3, mix: 0.1 }); p.advance(0.2); p.advance(0.1);
      const queued = p.entry(); equal('queue current context', calls.at(-1)?.trackTime, queued?.trackTime);
      check('queue restarts entry clock', (queued?.trackTime ?? 10) < p.time, { queued, ctx: calls.at(-1) });
      p.clear(0, { mix: 0.5 }); p.advance(0.1);
      equal('empty entry numeric time null name', calls.at(-1), { trackTime: p.entry()?.trackTime, animation: null, globalTime: p.time });
      check('empty time is numeric', typeof calls.at(-1)?.trackTime === 'number');
      p.advance(1); p.advance(dt); equal('entry context after mix follows actual current entry', calls.at(-1), { trackTime: p.entry()?.trackTime ?? null, animation: p.entry()?.animation ?? null, globalTime: p.time });
      let error = ''; try { p.adjust = () => { throw new Error('adjust failure'); }; } catch (e) { error = String(e); }
      check('callback errors retain core refusal', error.includes('adjust failure'), error);
    }
    if (group === 'physics') {
      const source = JSON.stringify((assets.document as ReadDocument).doc);
      for (const tracks of [false, true]) {
        const p = player(tracks); const control = player(tracks);
        for (const op of ['set', 'read', 'clear']) {
          let error = ''; try {
            if (op === 'set') p.setPhysicsParameters('declared', patch);
            else if (op === 'read') p.readPhysicsParameters('declared'); else p.clearPhysicsParameters('declared');
          } catch (e) { error = String(e); }
          check(`preplay refusal ${tracks}/${op}`, error.includes('declared') && error.includes('no live track'), error);
        }
        p.play('idle'); control.play('idle');
        equal(`declared ${tracks}`, p.readPhysicsParameters('declared'), { override: null, effective: declared });
        equal(`defaults ${tracks}`, p.readPhysicsParameters('defaults'), { override: null, effective: defaults });
        equal(`never active ${tracks}`, p.readPhysicsParameters('optional_phys'), { override: null, effective: null });
        const defaultPlayer = player(tracks); defaultPlayer.play('idle');
        for (const field of keys) {
          defaultPlayer.setPhysicsParameters('defaults', { [field]: patch[field] });
          equal(`default pending patch ${tracks}/${field}`, defaultPlayer.readPhysicsParameters('defaults'), { override: { [field]: patch[field] }, effective: defaults });
          defaultPlayer.repose();
          equal(`default field effective ${tracks}/${field}`, defaultPlayer.readPhysicsParameters('defaults').effective, { ...defaults, [field]: patch[field] });
          defaultPlayer.clearPhysicsParameters('defaults'); defaultPlayer.repose();
          equal(`default field clear ${tracks}/${field}`, defaultPlayer.readPhysicsParameters('defaults'), { override: null, effective: defaults });
        }
        p.setPhysicsParameters('optional_phys', patch); p.repose();
        equal(`inactive pending is not fabricated effective ${tracks}`, p.readPhysicsParameters('optional_phys'), { override: patch, effective: null });
        p.clearPhysicsParameters('optional_phys'); control.repose();
        const ref = core(tracks);
        // Match the explicit zero-step evaluation above on this public core control too.
        ref.pose = ref.live.step(0);
        for (let i = 0; i < 45; i++) { p.advance(dt); control.advance(dt); ref.pose = ref.live.step(dt); }
        for (const field of keys) {
          const before = p.readPhysicsParameters('declared'); const pose = words(p); const time = p.time; const gen = p.generation;
          p.setPhysicsParameters('declared', { [field]: patch[field] }); ref.live.setPhysicsParameters('declared', { [field]: patch[field] });
          equal(`pending old effective ${tracks}/${field}`, p.readPhysicsParameters('declared').effective, before.effective);
          check(`setter no pose time change ${tracks}/${field}`, same(words(p), pose) && p.time === time && p.generation === gen);
          p.advance(dt); ref.pose = ref.live.step(dt); control.advance(dt);
          equal(`field effective ${tracks}/${field}`, p.readPhysicsParameters('declared').effective?.[field], patch[field]);
          check(`public core bits ${tracks}/${field}`, same(words(p), coreWords(ref.pose)));
        }
        equal(`merged patch ${tracks}`, p.readPhysicsParameters('declared').override, patch);
        const detached = p.readPhysicsParameters('declared');
        (detached.override as { damping: number }).damping = 999; (detached.effective as { damping: number }).damping = 999;
        equal(`detached reads ${tracks}`, p.readPhysicsParameters('declared'), ref.live.readPhysicsParameters('declared'));
        const before = p.readPhysicsParameters('declared');
        for (const [name, invalid, token] of [
          ['missing', { damping: 1 }, 'missing'], ['aim', { damping: 1 }, 'aim'],
          ['declared', { strength: 333, unknown: 1 }, 'unknown'],
          ...keys.map((k) => ['declared', { strength: 333, [k]: NaN }, k]),
          ['declared', { wind: Infinity }, 'wind'], ['declared', { mix: 'bad' }, 'mix'],
        ] as Array<[string, unknown, string]>) {
          let error = ''; try { p.setPhysicsParameters(name, invalid as PhysicsParameterPatch); } catch (e) { error = String(e); }
          check(`atomic named refusal ${tracks}/${token}`, error.includes(name) && error.includes(token), error);
          equal(`no partial update ${tracks}/${token}`, p.readPhysicsParameters('declared'), before);
        }
        equal(`other constraint untouched ${tracks}`, p.readPhysicsParameters('defaults'), { override: null, effective: defaults });
        equal(`other player untouched ${tracks}`, control.readPhysicsParameters('declared').override, null);
        const held = words(p); const effective = p.readPhysicsParameters('declared').effective;
        p.clearPhysicsParameters('declared'); ref.live.clearPhysicsParameters('declared');
        equal(`clear pending ${tracks}`, p.readPhysicsParameters('declared'), { override: null, effective });
        check(`clear preserves held history ${tracks}`, same(words(p), held));
        p.advance(dt); ref.pose = ref.live.step(dt); control.advance(dt);
        check(`clear matched history control ${tracks}`, same(words(p), coreWords(ref.pose)));
        check(`clear is not instant untouched history ${tracks}`, !same(words(p), words(control)));
        equal(`authored resumes ${tracks}`, p.readPhysicsParameters('declared').effective, declared);
        const damp = player(tracks); const calm = player(tracks); damp.play('idle'); calm.play('idle');
        for (let i = 0; i < 45; i++) { damp.moved({ rotation: 2 }); calm.moved({ rotation: 2 }); damp.advance(dt); calm.advance(dt); }
        check(`stimulated equal before damping ${tracks}`, same(words(damp), words(calm)));
        // Damping updates velocity after offset: two native ticks expose it in this next evaluated pose.
        damp.setPhysicsParameters('declared', { damping: 0.1 }); damp.advance(2 * dt); calm.advance(2 * dt);
        check(`next step damping changes transform ${tracks}`, !same(words(damp), words(calm)), { damp: damp.bone('link'), control: calm.bone('link') });
      }
      const cloth = await loadRig('cloth', { regions: 'data' });
      try {
        for (const tracks of [false, true]) {
          const damp = player(tracks, undefined, undefined, 'canvas', cloth);
          const control = player(tracks, undefined, undefined, 'canvas', cloth);
          const view = underNoSkin((cloth.document as ReadDocument).doc);
          const ref = tracks ? openTracks(view, { reset: 'animation', clock: physicsClockStep })
            : openTrack(view, 'hang', { loop: true, reset: 'animation', clock: physicsClockStep });
          if ('start' in ref) { ref.setAnimation(0, 'hang', { loop: true, mixDuration: 0 }); ref.start(); }
          damp.play('hang'); control.play('hang');
          for (let i = 0; i < 45; i++) {
            damp.moved({ rotation: 2 }); control.moved({ rotation: 2 }); ref.physicsRotate(0, 0, 2);
            damp.advance(dt); control.advance(dt); ref.step(dt);
          }
          damp.setPhysicsParameters('link_1_phys', { damping: 0.1 }); ref.setPhysicsParameters('link_1_phys', { damping: 0.1 });
          // One evaluation with two native solver ticks; all three receive the identical partition.
          damp.advance(2 * dt); control.advance(2 * dt); const raw = ref.step(2 * dt);
          check(`cloth next evaluation (two native ticks) damping changes transform ${tracks}`, damp.bone('link_1').a !== control.bone('link_1').a,
            { damp: damp.bone('link_1'), control: control.bone('link_1') });
          for (const b of raw.bones) {
            const actual = damp.bone(b.name);
            check(`cloth public core exact ${tracks}/${b.name}`, same([actual.x, actual.y, actual.a, actual.b, actual.c, actual.d], [b.worldX, b.worldY, b.a, b.b, b.c, b.d]));
          }
        }
      } finally { cloth.dispose(); }
      equal('shared model immutable', JSON.stringify((assets.document as ReadDocument).doc), source);
    }
    if (group === 'lifetime') {
      for (const tracks of [false, true]) for (const mode of ['dom', 'canvas'] as const) {
        let patchedCalls = 0, plainCalls = 0;
        const q = player(tracks, () => { patchedCalls++; }, undefined, mode);
        const control = player(tracks, () => { plainCalls++; }, undefined, mode);
        q.play('idle'); control.play('idle');
        const before = patchedCalls;
        q.setPhysicsParameters('declared', { damping: 0.4 });
        q.readPhysicsParameters('declared'); q.clearPhysicsParameters('declared');
        q.setPhysicsParameters('declared', { damping: 0.4 });
        equal(`forwarders never evaluate ${tracks}/${mode}`, patchedCalls, before);
        for (const t of [0, 0.2, 0.2, 0, 0.237]) {
          q.seek(t); control.seek(t);
          equal(`seek no extra callbacks ${tracks}/${mode}/${t}`, patchedCalls, plainCalls);
        }
        q.play('idle'); control.play('idle');
        equal(`new play no extra callbacks ${tracks}/${mode}`, patchedCalls, plainCalls);
        equal(`new first effective authored ${tracks}/${mode}`, q.readPhysicsParameters('declared').effective,
          tracks ? { ...declared, damping: 0.4 } : declared);
        q.seek(0); control.seek(0);
        q.skin = 'active'; control.skin = 'active';
        equal(`skin reopen no extra callbacks ${tracks}/${mode}`, patchedCalls, plainCalls);
        equal(`skin first authored pending ${tracks}/${mode}`, q.readPhysicsParameters('declared'), { override: { damping: 0.4 }, effective: declared });
        q.play('idle', { track: 1 }); control.play('idle', { track: 1 });
        equal(`promotion no extra callbacks ${tracks}/${mode}`, patchedCalls, plainCalls);
      }
      // Animated effective values make stale frontier/core read caches observable.
      const p = player(); p.play('keyed');
      const reference = (time: number, damping?: number, skin?: string) => {
        const ref = core(false, 'keyed', skin);
        if (damping !== undefined) ref.live.setPhysicsParameters('declared', { damping });
        for (let i = 0, n = Math.floor(time / dt); i < n; i++) ref.pose = ref.live.step(dt);
        const rest = time - ref.live.trackTime; if (rest > 0) ref.pose = ref.live.step(rest);
        return ref;
      };
      for (const t of [0.8, 0.2, 0, 0.8, 0.2, 0.237, 0.237]) {
        p.seek(t); const ref = reference(t);
        check(`animated warm seek bits ${t}`, same(words(p), coreWords(ref.pose)));
        equal(`animated warm seek effective ${t}`, p.readPhysicsParameters('declared'), ref.live.readPhysicsParameters('declared'));
      }
      p.setPhysicsParameters('declared', { damping: 0.4 });
      for (const t of [0, 0.8, 0.2, 0.2]) {
        p.seek(t); const ref = reference(t, 0.4);
        check(`patch invalidates warm seek ${t}`, same(words(p), coreWords(ref.pose)));
        equal(`patched warm read ${t}`, p.readPhysicsParameters('declared'), ref.live.readPhysicsParameters('declared'));
      }
      const hold = p.readPhysicsParameters('declared'); p.clearPhysicsParameters('declared');
      equal('clear does not evaluate after cached seek', p.readPhysicsParameters('declared'), { override: null, effective: hold.effective });
      p.repose(); equal('clear resumes authored keys on repose', p.readPhysicsParameters('declared'), reference(p.time).live.readPhysicsParameters('declared'));
      p.seek(0.2); equal('clear invalidates exact cache', p.readPhysicsParameters('declared'), reference(0.2).live.readPhysicsParameters('declared'));
      p.setPhysicsParameters('declared', { damping: 0.4 }); p.skin = 'active';
      check('skin replays standing patch', same(words(p), coreWords(reference(p.time, 0.4, 'active').pose)));
      equal('skin activates parameter read', p.readPhysicsParameters('optional_phys').effective, defaults);
      p.skin = undefined; equal('new inactive lifetime has no fabricated effective', p.readPhysicsParameters('optional_phys').effective, null);
      p.play('idle'); equal('new play retains pending patch', p.readPhysicsParameters('declared'), { override: { damping: 0.4 }, effective: declared });
      for (const tracks of [false, true]) {
        const q = player(tracks); q.play('idle'); q.setPhysicsParameters('declared', { mix: 0.3 }); q.seek(0.3);
        const ref = core(tracks); ref.live.setPhysicsParameters('declared', { mix: 0.3 });
        for (let i = 0; i < Math.floor(0.3 / dt); i++) ref.pose = ref.live.step(dt);
        const rest = 0.3 - ref.live.trackTime; if (rest > 0) ref.pose = ref.live.step(rest);
        check(`replay standing patch bits ${tracks}`, same(words(q), coreWords(ref.pose)));
        q.seek(0); equal(`zero seek first pose authored ${tracks}`, q.readPhysicsParameters('declared'), { override: { mix: 0.3 }, effective: declared });
        q.seek(0.3); q.play('idle', { track: 1 });
        equal(`promotion keeps override ${tracks}`, q.readPhysicsParameters('declared').override, { mix: 0.3 });
        q.repose(); equal(`promotion effective ${tracks}`, q.readPhysicsParameters('declared').effective?.mix, 0.3);
      }
    }
    return { group, rows };
  } finally { for (const p of players) p.dispose(); for (const root of roots) root.remove(); assets.dispose(); }
}
