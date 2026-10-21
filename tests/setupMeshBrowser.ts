import { poseRawSetup, underNoSkin, underSkin } from 'rig-c/core';
import { loadModel, readSetupMesh, RigPlayer, type BoneWorld, type ModelAssets, type SetupMeshTarget } from '../src/index';
import type { ReadDocument } from '../src/loadModel';
import { readSetupMesh as reviewRead, placeSetupMesh, type SetupMeshRead } from './setupMeshReviewReference';

const CODES = { unavailable: 'TEST_MODEL', select: 'TEST_SELECT', noMesh: 'TEST_MESH', invalid: 'TEST_INVALID', subject: 'the mesh is', selectText: 'select a slot' };
const totals = () => ({ meshes: 0, coordinates: 0, worstDelta: 0 });

/** Test-only explanation of the different inputs: weighted setup deform is
 * added after reading stored float32 coordinates; its sum stays a double.
 * The immutable Review reference above intentionally remains stored-only. */
function setupDeformReplay(mesh: SetupMeshRead, deform: readonly number[], world: (bone: string) => BoneWorld): number[] {
  const out: number[] = [];
  let k = 0;
  for (const influences of mesh.vertices) {
    let wx = 0, wy = 0;
    for (const binding of influences) {
      const bone = world(binding.bone);
      const x = mesh.weighted ? Math.fround(binding.x) + deform[k] : deform[k];
      const y = mesh.weighted ? Math.fround(binding.y) + deform[k + 1] : deform[k + 1];
      const weight = mesh.weighted ? Math.fround(binding.weight) : 1;
      k += 2;
      wx += (x * bone.a + y * bone.b + bone.x) * weight;
      wy += (x * bone.c + y * bone.d + bone.y) * weight;
    }
    out.push(wx, wy);
  }
  return out;
}

/** Every named mesh of each public build, under no skin, each named skin and all. */
export async function setupMeshGalleryProbe() {
  const report = { builds: 0, views: 0, selected: totals(), nonselected: totals(), differences: [] as string[],
    coreSetup: { meshes: 0, coordinates: 0, bitMismatches: 0, worstDelta: 0 },
    reviewExplanation: { deformedMeshes: 0, differingMeshes: 0, differingCoordinates: 0, explainedDifferingCoordinates: 0, unexplainedCoordinates: 0 },
    contractFailures: [] as string[],
    rows: [] as { build: string; skin: string | null; selected: ReturnType<typeof totals>; nonselected: ReturnType<typeof totals> }[] };
  for (const recipe of ['walk', 'flex', 'squash', 'portrait', 'nod', 'look', 'ride']) for (const suffix of ['', '-packed']) {
    const build = recipe + suffix;
    const assets = await loadModel({ modelUrl: `/rigs/${build}/skeleton.model.json`, regions: 'none', setsUrl: null });
    const { doc, parsed } = assets.document as ReadDocument;
    const before = JSON.stringify([doc, parsed]);
    try {
      for (const skin of [null, ...assets.skins, 'all']) {
        const view = skin === null ? underNoSkin(doc) : underSkin(doc, skin);
        const pose = poseRawSetup(view);
        const root = document.createElement('div');
        const player = new RigPlayer(root, assets, { mode: 'canvas', ...(skin === null ? {} : { skin }) });
        const row = { build, skin, selected: totals(), nonselected: totals() };
        try {
          // This is the old caller's setup-pose source. Check it is exactly
          // the same matrix input before asking the fixed Review formula.
          for (const bone of pose.bones) {
            const own = player.bone(bone.name);
            if (![own.x, own.y, own.a, own.b, own.c, own.d].every((v, i) => Object.is(v, [bone.worldX, bone.worldY, bone.a, bone.b, bone.c, bone.d][i])))
              throw new Error(`${build}/${skin}: setup matrix mismatch for ${bone.name}`);
          }
          const tables = skin === null ? doc.skins.filter(s => s.name === 'default') : skin === 'all' ? doc.skins : doc.skins.filter(s => s.name === skin || s.name === 'default');
          const keys = new Map<string, Set<string>>();
          for (const table of tables) for (const [slot, entries] of Object.entries(table.attachments)) {
            let names = keys.get(slot); if (!names) { names = new Set(); keys.set(slot, names); }
            for (const key of Object.keys(entries)) names.add(key);
          }
          for (const [slot, names] of keys) for (const attachment of names) {
            // Resolve the requested view with named-skin priority over fallback.
            const record = (skin !== null && skin !== 'all' ? doc.skins.find(s => s.name === skin)?.attachments[slot]?.[attachment] : undefined)
              ?? tables.find(s => s.attachments[slot]?.[attachment])?.attachments[slot]?.[attachment];
            if (record?.kind !== 'mesh' && record?.kind !== 'linkedmesh') continue;
            const got = readSetupMesh(assets, { slot, attachment, skin });
            const reference = reviewRead(parsed, slot, { skin: got.skin, attachment }, CODES);
            if (!reference.ok) throw new Error(reference.code);
            const expected = placeSetupMesh(reference.mesh, name => player.bone(name));
            if (expected === null || got.vertices.length !== expected.length) throw new Error(`${build}/${skin}/${slot}/${attachment}: reference shape`);
            const shown = pose.shown.find(s => s.slot === slot && s.placeholder === attachment && s.skin === got.skin);
            const domain = shown ? 'selected' : 'nonselected';
            if (shown) {
              const raw = pose.drawn.find(d => d.slot === slot);
              if (!raw || raw.vertices.length !== got.vertices.length) throw new Error(`${build}/${skin}/${slot}: raw setup shape`);
              report.coreSetup.meshes++;
              report.coreSetup.coordinates += got.vertices.length;
              for (let i = 0; i < got.vertices.length; i++) {
                if (!Object.is(got.vertices[i], raw.vertices[i])) report.coreSetup.bitMismatches++;
                report.coreSetup.worstDelta = Math.max(report.coreSetup.worstDelta, Math.abs(got.vertices[i] - raw.vertices[i]));
              }
            }
            const replay = shown?.deform === undefined ? expected : setupDeformReplay(reference.mesh, shown.deform, name => player.bone(name));
            if (shown?.deform !== undefined) report.reviewExplanation.deformedMeshes++;
            let meshDiffers = false;
            row[domain].meshes++; row[domain].coordinates += got.vertices.length;
            report[domain].meshes++; report[domain].coordinates += got.vertices.length;
            for (let i = 0; i < expected.length; i++) {
              const delta = Math.abs(got.vertices[i] - expected[i]);
              row[domain].worstDelta = Math.max(row[domain].worstDelta, delta);
              report[domain].worstDelta = Math.max(report[domain].worstDelta, delta);
              if (!Object.is(got.vertices[i], replay[i])) report.reviewExplanation.unexplainedCoordinates++;
              if (!Object.is(got.vertices[i], expected[i])) {
                meshDiffers = true;
                report.reviewExplanation.differingCoordinates++;
                if (Object.is(got.vertices[i], replay[i])) report.reviewExplanation.explainedDifferingCoordinates++;
              }
              if (delta !== 0 && report.differences.length < 12) report.differences.push(`${build}/${skin}/${slot}/${attachment} ${domain} coordinate ${i}: ${got.vertices[i]} vs ${expected[i]} delta ${delta}`);
            }
            if (meshDiffers) report.reviewExplanation.differingMeshes++;
            if (JSON.stringify(got.triangles) !== JSON.stringify(reference.mesh.triangles) || got.hull !== reference.mesh.hull)
              report.contractFailures.push(`${build}/${skin}/${slot}/${attachment}: topology mismatch`);
          }
        } finally { player.dispose(); root.remove(); }
        report.rows.push(row); report.views++;
      }
      if (JSON.stringify([doc, parsed]) !== before) throw new Error(`${build}: model mutated`);
      report.builds++;
    } finally { assets.dispose(); }
  }
  return report;
}

/** Caller-made test players only; the read itself never touches a player. */
export async function setupMeshPlayerProbe() {
  const report = { states: [] as string[], reads: 0, differences: [] as string[] };
  for (const state of ['setup', 'playing', 'paused', 'mixed', 'physics-held']) {
    const rig = state === 'physics-held' ? 'cloth' : 'figure';
    const assets = await loadModel({ modelUrl: `/rigs/${rig}/skeleton.model.json` });
    const read = assets.document as ReadDocument;
    const sourceBefore = JSON.stringify([read.doc, read.parsed]);
    const roots = [document.createElement('div'), document.createElement('div')];
    roots.forEach(root => { root.style.cssText = 'position:absolute;left:300px;top:450px;transform:scale(.5,-.5);'; document.body.append(root); });
    const poses = [0, 0]; const events: string[][] = [[], []];
    const players = roots.map((root, i) => new RigPlayer(root, assets, { meshBackend: 'canvas2d', tracks: state === 'mixed', adjust: () => { poses[i]++; } }));
    const snapshot = (p: RigPlayer, i: number) => JSON.stringify({ time: p.time, generation: p.generation,
      entries: [p.entry(0), p.entry(1)], identity: p.slotIdentity(), frame: p.posedFrame(),
      bones: read.doc.bones.map(b => p.bone(b.name)), events: events[i], poses: poses[i], dom: roots[i].innerHTML,
      pixels: Array.from(roots[i].querySelectorAll('canvas'), canvas => canvas.toDataURL()),
    });
    try {
      for (let i = 0; i < players.length; i++) {
        const player = players[i];
        player.on('event', e => events[i].push(JSON.stringify(e)));
        player.on('complete', e => events[i].push(JSON.stringify(e)));
        if (state !== 'setup') {
          const animation = rig === 'cloth' ? 'hang' : 'walk';
          player.play(animation);
          if (state === 'mixed') player.play(animation, { track: 1, mix: 0.4, alpha: 0.5 });
          player.advance(0.35);
          if (state === 'paused' || state === 'physics-held') player.pause();
        }
        player.draw();
      }
      await Promise.all(roots.flatMap(root => Array.from(root.querySelectorAll('img'), image => image.decode())));
      const targetRecord = read.doc.skins.find(s => s.name === 'default')!;
      const candidate = Object.entries(targetRecord.attachments).flatMap(([slot, table]) => Object.entries(table).filter(([, a]) => a.kind === 'mesh').map(([attachment]) => ({ slot, attachment })))[0];
      if (!candidate) throw new Error(`${rig}: no mesh target`);
      const target: SetupMeshTarget = candidate;
      const expected = readSetupMesh(assets, target);
      const identities = players.map(p => p.slotIdentity());
      const arrays = players[0].posedFrame().order.filter(s => s.kind === 'mesh').map(s => ({ slot: s.slot, uvs: s.uvs, triangles: s.triangles }));
      const before = snapshot(players[0], 0);
      // Any construction/rendering during the read would write the DOM.
      const observer = new MutationObserver(() => {});
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      try {
        for (let i = 0; i < 1000; i++) {
          const result = readSetupMesh(assets, target);
          if (JSON.stringify(result) !== JSON.stringify(expected)) throw new Error(`${state}: setup result drift`);
          result.vertices.fill(123); result.triangles.reverse();
          report.reads++;
        }
        if (observer.takeRecords().length) report.differences.push(`${state}: DOM mutation during reads`);
      } finally { observer.disconnect(); }
      if (snapshot(players[0], 0) !== before) report.differences.push(`${state}: held state changed`);
      for (let i = 0; i < players.length; i++) if (players[i].slotIdentity() !== identities[i]) report.differences.push(`${state}: identity cache invalidated`);
      for (const previous of arrays) {
        const slot = players[0].posedFrame().order.find(s => s.slot === previous.slot);
        if (slot?.kind !== 'mesh' || slot.uvs !== previous.uvs || slot.triangles !== previous.triangles) report.differences.push(`${state}: topology cache changed`);
      }
      players.forEach(p => p.draw());
      if (snapshot(players[0], 0) !== snapshot(players[1], 1)) report.differences.push(`${state}: held control differs`);
      players.forEach(p => { p.resume(); p.frame(1 / 60); });
      if (snapshot(players[0], 0) !== snapshot(players[1], 1)) report.differences.push(`${state}: next frame/control differs`);
      if (JSON.stringify([read.doc, read.parsed]) !== sourceBefore) report.differences.push(`${state}: assets mutated`);
      report.states.push(state);
    } finally { players.forEach(p => p.dispose()); roots.forEach(root => root.remove()); assets.dispose(); }
  }
  return report;
}

/** Bounded #149 diagnosis: stored-only Review compatibility versus selected setup geometry. */
export async function setupMeshLookDiagnosisProbe() {
  const assets = await loadModel({ modelUrl: '/rigs/look/skeleton.model.json', regions: 'none', setsUrl: null });
  const { doc, parsed } = assets.document as ReadDocument;
  const view = underNoSkin(doc);
  const pose = poseRawSetup(view);
  const root = document.createElement('div');
  const player = new RigPlayer(root, assets, { mode: 'canvas' });
  const before = JSON.stringify([doc, parsed]);
  try {
    const rows = [];
    let rawWorstDelta = 0;
    let matricesExact = true;
    for (const bone of pose.bones) {
      const own = player.bone(bone.name);
      matricesExact &&= [own.x, own.y, own.a, own.b, own.c, own.d].every((v, i) => Object.is(v, [bone.worldX, bone.worldY, bone.a, bone.b, bone.c, bone.d][i]));
    }
    for (const shown of pose.shown) {
      if (shown.geometry.kind !== 'mesh') continue;
      const got = readSetupMesh(assets, { slot: shown.slot, attachment: shown.placeholder });
      const raw = pose.drawn.find(d => d.slot === shown.slot)!;
      if (raw.vertices.length !== got.vertices.length) throw new Error('raw setup shape mismatch');
      rawWorstDelta = Math.max(rawWorstDelta, ...got.vertices.map((v, i) => Math.abs(v - raw.vertices[i])));
      const read = reviewRead(parsed, shown.slot, { skin: shown.skin, attachment: shown.placeholder }, CODES);
      if (!read.ok) throw new Error(read.code);
      const reference = placeSetupMesh(read.mesh, name => player.bone(name));
      if (!reference) throw new Error('nonfinite Review reference');
      const firstIndex = got.vertices.findIndex((v, i) => v !== reference[i]);
      const geometry = shown.geometry;
      const first = firstIndex < 0 ? null : (() => {
        const vertexIndex = Math.floor(firstIndex / 2);
        const influences = read.mesh.vertices[vertexIndex];
        const bindingOffset = read.mesh.weighted ? read.mesh.vertices.slice(0, vertexIndex).reduce((n, v) => n + v.length * 2, 0) : vertexIndex * 2;
        const traces = influences.map((b, index) => {
          const matrix = player.bone(b.bone);
          const fx = Math.fround(b.x), fy = Math.fround(b.y), weight = read.mesh.weighted ? Math.fround(b.weight) : 1;
          const deformX = shown.deform?.[bindingOffset + index * 2] ?? 0;
          const deformY = shown.deform?.[bindingOffset + index * 2 + 1] ?? 0;
          const coreX = read.mesh.weighted ? fx + deformX : shown.deform?.[vertexIndex * 2] ?? fx;
          const coreY = read.mesh.weighted ? fy + deformY : shown.deform?.[vertexIndex * 2 + 1] ?? fy;
          return { stored: b, frounded: { x: fx, y: fy, weight }, matrix,
            selectedDeform: { x: deformX, y: deformY }, coreLocal: { x: coreX, y: coreY },
            reviewTerm: { x: (fx * matrix.a + fy * matrix.b + matrix.x) * weight, y: (fx * matrix.c + fy * matrix.d + matrix.y) * weight },
            coreTerm: { x: (coreX * matrix.a + coreY * matrix.b + matrix.x) * weight, y: (coreX * matrix.c + coreY * matrix.d + matrix.y) * weight },
            extraFroundAfterDeform: { x: Math.fround(coreX), y: Math.fround(coreY) },
          };
        });
        const coreBindings = geometry.vertices.weighted ? geometry.vertices.bindings[vertexIndex] : null;
        return { coordinateIndex: firstIndex, vertexIndex, core: got.vertices[firstIndex], rawSetup: raw.vertices[firstIndex], review: reference[firstIndex],
          delta: Math.abs(got.vertices[firstIndex] - reference[firstIndex]), traces,
          storedBindingsExact: coreBindings === null ? null : coreBindings.length === influences.length && coreBindings.every((b, i) => b.bone === influences[i].bone && Object.is(b.x, influences[i].x) && Object.is(b.y, influences[i].y) && Object.is(b.weight, influences[i].weight)),
          reconstructedCore: traces.reduce((sum, t) => sum + (firstIndex % 2 ? t.coreTerm.y : t.coreTerm.x), 0),
          reconstructedReview: traces.reduce((sum, t) => sum + (firstIndex % 2 ? t.reviewTerm.y : t.reviewTerm.x), 0),
        };
      })();
      rows.push({ slot: shown.slot, attachment: shown.placeholder, skin: shown.skin, coordinates: got.vertices.length,
        hasSetupDeform: shown.deform !== undefined, deformLength: shown.deform?.length ?? 0,
        reviewWorstDelta: Math.max(...got.vertices.map((v, i) => Math.abs(v - reference[i]))), firstDifference: first });
    }
    return { rawWorstDelta, matricesExact, rows, inputUnchanged: before === JSON.stringify([doc, parsed]),
      setupConstraints: (parsed as { constraints: unknown }).constraints };
  } finally { player.dispose(); root.remove(); assets.dispose(); }
}
