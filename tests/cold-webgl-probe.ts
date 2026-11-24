import { CanvasRenderer } from '../src/CanvasRenderer';
import { glContextCount } from '../src/MeshGlBlitter';
import { frameAt, loadRig } from './rigFrames';

// As in the grant fallback probe, deny even the held buffer. Intercept the
// context as the first render creates it so the plant needs no warm-up draw.
function renderWithDeclinedGrant(render: () => void): number {
  const getContext = HTMLCanvasElement.prototype.getContext;
  let restoreWidth: (() => void) | undefined;
  let widthReads = 0;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
    const context = Reflect.apply(getContext, this, [type, ...args]);
    if (type === 'webgl' && context && !restoreWidth) {
      const own = Object.getOwnPropertyDescriptor(context, 'drawingBufferWidth');
      Object.defineProperty(context, 'drawingBufferWidth', {
        configurable: true,
        get: () => { widthReads++; return 0; },
      });
      restoreWidth = () => {
        if (own) Object.defineProperty(context, 'drawingBufferWidth', own);
        else Reflect.deleteProperty(context, 'drawingBufferWidth');
      };
    }
    return context;
  } as typeof getContext;
  try {
    render();
    return widthReads;
  } finally {
    HTMLCanvasElement.prototype.getContext = getContext;
    restoreWidth?.();
  }
}

async function renderColdWebgl(declineFirstGrant: boolean) {
  const assets = await loadRig('glow');
  const root = document.createElement('div');
  document.body.append(root);
  const renderer = new CanvasRenderer(root, assets.pageImages);
  renderer.backend = 'webgl';
  renderer.pixelRatio = 0.5;
  try {
    const contextsBefore = glContextCount();
    const meshPoses = new Set<string>();
    let plantedWidthReads = 0;
    const frames = [0, 0.2, 0.4].map((time, index) => {
      const pose = frameAt(assets, 'burn', time);
      const meshes = pose.order.filter(slot => slot.kind === 'mesh');
      meshPoses.add(JSON.stringify(meshes.map(mesh => mesh.vertices)));
      if (index === 0 && declineFirstGrant) {
        plantedWidthReads = renderWithDeclinedGrant(() => renderer.render(pose));
      } else {
        renderer.render(pose);
      }
      return {
        frame: index + 1, time, meshCount: meshes.length,
        backendActive: renderer.backendActive,
        backendFallbackReason: renderer.backendFallbackReason,
        drawCalls: renderer.drawCalls,
        trianglesDrawn: renderer.trianglesDrawn,
        framesReused: renderer.framesReused,
        blits: renderer.blits,
      };
    });
    return { contextsBefore, contextsAfter: glContextCount(), distinctMeshPoses: meshPoses.size, plantedWidthReads, frames };
  } finally {
    renderer.dispose();
    root.remove();
    assets.dispose();
  }
}

export type ColdWebglWindow = typeof window & {
  renderColdWebgl: typeof renderColdWebgl;
};

(window as ColdWebglWindow).renderColdWebgl = renderColdWebgl;
