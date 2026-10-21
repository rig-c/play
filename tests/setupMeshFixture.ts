/** Literal reader input, independent of compiler-generated expectations. */
export const base = {
  kind: 'mesh', name: 'display-name', vertices: { weighted: false, xy: [3, 0, 0, 0, 0, 4] },
  uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], hull: 3,
};
export const weighted = {
  kind: 'mesh', vertices: { weighted: true, bindings: [
    [{ bone: 'a', x: 3, y: 0, weight: 0.25 }, { bone: 'b', x: 9, y: 0, weight: 0.75 }],
    [{ bone: 'a', x: 0.1, y: 0, weight: 0.1 }, { bone: 'b', x: -0.2, y: 0.3, weight: 0.7 }],
    [{ bone: 'b', x: 0, y: 4, weight: 1 }],
  ] }, uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], hull: 3,
};
export const skin = (name: string, attachments: Record<string, unknown>, bones: string[] = []) => ({ name, attachments, bones, constraints: {} });
export const links = {
  linked: { kind: 'linkedmesh', skin: 'default', slot: 's', source: 'base', timelines: true },
  independent: { kind: 'linkedmesh', skin: 'default', slot: 's', source: 'base', timelines: false },
};
export function literalModel(options: {
  skins?: ReturnType<typeof skin>[];
  bones?: Record<string, unknown>[];
  slots?: { name: string; bone: string; setup: string | null }[];
  slider?: boolean;
} = {}) {
  const skins = options.skins ?? [skin('default', {
    s: { base, alternate: weighted, ...links, bare: { ...base, hull: undefined },
      region: { kind: 'region', width: 4, height: 4, atlas: { width: 4, height: 4, offsetX: 0, offsetY: 0, originalWidth: 4, originalHeight: 4 } },
      box: { kind: 'boundingbox', vertices: { weighted: false, xy: [0, 0, 4, 0, 0, 4] } },
      clip: { kind: 'clipping', vertices: { weighted: false, xy: [0, 0, 4, 0, 0, 4] }, end: 't' },
      path: { kind: 'path', vertices: { weighted: false, xy: [0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0] }, vertexCount: 6, closed: false, constantSpeed: false, lengths: [3, 4] },
    }, t: { linked: links.linked }, inactive: { base },
  }, ['sleep'])];
  const animations = options.slider ? [{ name: 'deform', duration: 1, bones: [], slots: [],
    constraints: { ik: [], transform: [], path: [], physics: [], slider: [] },
    attachments: [{ name: 'default', slots: [{ name: 's', attachments: [{ name: 'base', deform: [{ time: 0, vertices: [1, 2] }, { time: 1, vertices: [3, 4] }] }] }] }], drawOrder: [], events: [] }] : [];
  return {
    spec: 'rigc-compiled/3', referenceScale: 100, stage: null,
    bones: options.bones ?? [{ name: 'root' }, { name: 'a', parent: 'root', x: 5, y: 7 }, { name: 'b', parent: 'root', x: -1, y: 2 }, { name: 'sleep', parent: 'root', x: 50, skinRequired: true }],
    slots: options.slots ?? [{ name: 's', bone: 'a', setup: 'base' }, { name: 't', bone: 'b', setup: null }, { name: 'inactive', bone: 'sleep', setup: null }],
    skins, constraints: options.slider ? [{ kind: 'slider', name: 'dial', declaredIn: 'rig', animation: 'deform', time: 0.5 }] : [], events: [], animations,
    editorOrder: { skins: skins.map(s => ({ name: s.name, slots: Object.keys(s.attachments) })), animations: animations.map(a => a.name) },
    images: [], pageGrids: [], droppedStates: [], absentParts: [], meshBones: {}, meshes: {}, physics: [], deformTransforms: [], trackDerivations: [], rig: {},
    pages: [], spine: { sha256: '0'.repeat(64) },
  };
}
