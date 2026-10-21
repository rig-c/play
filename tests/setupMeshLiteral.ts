import { CoreInputError, poseRawSetup, underNoSkin } from 'rig-c/core';
import { MeshAttachment, Physics, Skeleton, SkeletonJson, TextureRegion, type AttachmentLoader } from '@esotericsoftware/spine-webgl';
import { loadModel, readSetupMesh, type ModelAssets, type SetupMeshTarget } from '../src/index';
import type { ReadDocument } from '../src/loadModel';
import { base, literalModel, skin, weighted } from './setupMeshFixture';

async function loadLiteral(raw = literalModel()): Promise<ModelAssets> {
  return loadModel({ modelUrl: 'https://fixture.test/skeleton.model.json', setsUrl: null, regions: 'none',
    fetch: async () => new Response(JSON.stringify(raw)) });
}
async function hash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
function refusal(assets: ModelAssets, target: SetupMeshTarget) {
  try { readSetupMesh(assets, target); return { coreError: false, message: 'ACCEPTED' }; }
  catch (e) { return { coreError: e instanceof CoreInputError, message: (e as Error).message }; }
}
// Official, independently posed expectations: no player/core matrix or formula.
function official(raw: ReturnType<typeof literalModel>, name: 'base' | 'alternate', bone = 'a'): number[] {
  const unused = (): never => { throw new Error('literal oracle only creates meshes'); };
  const loader: AttachmentLoader = {
    newMeshAttachment: (_skin, _placeholder, name, _path, sequence) => {
      // Sequence.update computes UVs even for a geometry-only oracle. Supply
      // a real region; no texture upload or renderer is involved in this read.
      const region = new TextureRegion();
      region.u2 = region.v2 = 1;
      region.width = region.height = region.originalWidth = region.originalHeight = 4;
      sequence.regions.fill(region);
      return new MeshAttachment(name, sequence);
    },
    newRegionAttachment: unused, newBoundingBoxAttachment: unused, newPathAttachment: unused,
    newPointAttachment: unused, newClippingAttachment: unused,
  };
  const data = new SkeletonJson(loader).readSkeletonData({ skeleton: { spine: '4.3.13' },
    bones: raw.bones, slots: [{ name: 's', bone, attachment: 'base' }],
    skins: [{ name: 'default', attachments: { s: {
      base: { type: 'mesh', uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], vertices: [3, 0, 0, 0, 0, 4], hull: 3 },
      alternate: { type: 'mesh', uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], vertices: [2, 1, 3, 0, 0.25, 2, 9, 0, 0.75, 2, 1, 0.1, 0, 0.1, 2, -0.2, 0.3, 0.7, 1, 2, 0, 4, 1], hull: 3 },
    } } }], animations: {} });
  const skeleton = new Skeleton(data);
  skeleton.setupPose(); skeleton.update(0); skeleton.updateWorldTransform(Physics.reset);
  const mesh = data.defaultSkin!.getAttachment(0, name) as MeshAttachment;
  const xy = new Array<number>(mesh.worldVerticesLength);
  mesh.computeWorldVertices(skeleton, skeleton.slots[0], 0, xy.length, xy, 0, 2);
  return xy;
}


export async function setupMeshLiteralProbe() {
  const simple = await loadLiteral(literalModel({ bones: [{ name: 'a', x: 5, y: 7 }, { name: 'b', x: -1, y: 2 }],
    slots: [{ name: 's', bone: 'a', setup: 'base' }], skins: [skin('default', { s: { base, alternate: weighted,
      decimal: { ...base, vertices: { weighted: false, xy: [0.1, 0, 0, 0, 0, 4] } } } })] }));
  const literal = {
    translated: readSetupMesh(simple, { slot: 's', attachment: 'base' }).vertices.slice(0, 2),
    weighted: readSetupMesh(simple, { slot: 's', attachment: 'alternate' }).vertices.slice(0, 2),
    decimal: readSetupMesh(simple, { slot: 's', attachment: 'decimal' }).vertices[0],
  };
  simple.dispose();
  const officialPairs = [];
  for (const bones of [literalModel().bones, [{ name: 'root', rotation: 23, scaleX: -2, scaleY: 0.7, shearY: 11 },
    { name: 'a', parent: 'root', x: 5, y: 7, scaleX: 0.4, scaleY: 1.8 }, { name: 'b', parent: 'root', x: -1, y: 2, rotation: -17 }]]) {
    const raw = literalModel({ bones, slots: [{ name: 's', bone: 'a', setup: 'base' }], skins: [skin('default', { s: { base, alternate: weighted } })] });
    const assets = await loadLiteral(raw);
    for (const attachment of ['base', 'alternate'] as const) officialPairs.push({ actual: readSetupMesh(assets, { slot: 's', attachment }), expected: official(raw, attachment) });
    assets.dispose();
  }
  const raw = literalModel();
  const assets = await loadLiteral(raw);
  const doc = (assets.document as ReadDocument).doc;
  const beforeHash = await hash(doc);
  const linked = readSetupMesh(assets, { slot: 't', attachment: 'linked' });
  const identity = { linked, linkedExpected: official(raw, 'base', 'b'),
    alternate: readSetupMesh(assets, { slot: 's', attachment: 'alternate' }).attachment,
    noHull: readSetupMesh(assets, { slot: 's', attachment: 'bare' }).hull,
    inactive: readSetupMesh(assets, { slot: 'inactive', attachment: 'base' }).vertices,
    activatedX: readSetupMesh(assets, { slot: 'inactive', attachment: 'base', skin: 'default' }).vertices[0],
  };
  const errorTargets: SetupMeshTarget[] = [{ slot: 'missing-slot', attachment: 'base' }, { slot: 's', attachment: 'missing-attachment' },
    { slot: 's', attachment: 'display-name' }, { slot: 's', attachment: 'base', skin: 'missing-skin' },
    ...['region', 'box', 'clip', 'path'].map(attachment => ({ slot: 's', attachment }))];
  const errors = errorTargets.map(target => ({ target, ...refusal(assets, target) }));
  const first = readSetupMesh(assets, { slot: 's', attachment: 'base' });
  const expected = structuredClone(first);
  const other = await loadLiteral(raw);
  first.vertices.fill(999); first.triangles.reverse(); first.hull = 0; first.skin = 'changed';
  const detached = { expected, again: readSetupMesh(assets, { slot: 's', attachment: 'base' }), other: readSetupMesh(other, { slot: 's', attachment: 'base' }),
    beforeHash, afterHash: await hash(doc), otherHash: await hash((other.document as ReadDocument).doc) };
  other.dispose(); assets.dispose();

  const reordered = { ...weighted, vertices: { bindings: weighted.vertices.bindings.map(row => row.map(b => ({ weight: b.weight, y: b.y, x: b.x, bone: b.bone }))), weighted: true } };
  const named = await loadLiteral(literalModel({ skins: [skin('default', { s: { base, alternate: weighted } }), skin('named', { s: { alternate: reordered, other: base } })] }));
  const different = await loadLiteral(literalModel({ skins: [skin('default', { s: { base } }), skin('named', { s: { base: { ...base, triangles: [2, 1, 0] } } })] }));
  const ambiguityBefore = await hash((different.document as ReadDocument).doc);
  const skins = {
    fallback: readSetupMesh(named, { slot: 's', attachment: 'base', skin: 'named' }).skin,
    named: readSetupMesh(named, { slot: 's', attachment: 'other', skin: 'named' }).skin,
    noSkinOther: refusal(named, { slot: 's', attachment: 'other' }),
    all: readSetupMesh(named, { slot: 's', attachment: 'alternate', skin: 'all' }),
    namedWeighted: readSetupMesh(named, { slot: 's', attachment: 'alternate', skin: 'named' }),
    nullSkin: readSetupMesh(named, { slot: 's', attachment: 'base', skin: null }),
    omittedSkin: readSetupMesh(named, { slot: 's', attachment: 'base' }),
    ambiguous: refusal(different, { slot: 's', attachment: 'base', skin: 'all' }),
    ambiguityBefore, ambiguityAfter: await hash((different.document as ReadDocument).doc),
  };
  named.dispose(); different.dispose();

  const sliderAssets = await loadLiteral(literalModel({ slider: true }));
  const storedAssets = await loadLiteral();
  const sliderDoc = (sliderAssets.document as ReadDocument).doc;
  const sliderBefore = await hash(sliderDoc);
  const slider = {
    selected: readSetupMesh(sliderAssets, { slot: 's', attachment: 'base' }).vertices,
    rawSetup: poseRawSetup(underNoSkin(sliderDoc)).drawn[0].vertices,
    stored: readSetupMesh(storedAssets, { slot: 's', attachment: 'base' }).vertices,
    unselected: ['linked', 'independent'].map(attachment => readSetupMesh(sliderAssets, { slot: 's', attachment }).vertices),
    beforeHash: sliderBefore, afterHash: await hash(sliderDoc),
  };
  sliderAssets.dispose(); storedAssets.dispose();
  const overflow = await loadLiteral(literalModel({ bones: [{ name: 'a', scaleX: 1e308 }],
    slots: [{ name: 's', bone: 'a', setup: 'base' }], skins: [skin('default', { s: { base } })] }));
  const overflowBefore = await hash((overflow.document as ReadDocument).doc);
  const nonfinite = { refusal: refusal(overflow, { slot: 's', attachment: 'base' }), beforeHash: overflowBefore, afterHash: await hash((overflow.document as ReadDocument).doc) };
  overflow.dispose();
  return { literal, officialPairs, identity, errors, detached, skins, slider, nonfinite };
}
