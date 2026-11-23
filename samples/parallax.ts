import { CanvasRenderer, RigPlayer, loadModel } from '../src/index.js';
import { cameraLimits, createCompositor, easeCamera, pointerTarget, type CameraMode } from './parallax-compositor.js';

export async function mountParallax(): Promise<RigPlayer> {
  const stage = document.querySelector<HTMLCanvasElement>('#stage')!;
  const mode = document.querySelector<HTMLSelectElement>('#camera-mode')!;
  const status = document.querySelector<HTMLParagraphElement>('#status')!;
  const cameraPosition = document.querySelector<HTMLOutputElement>('#camera-position')!;
  const readouts = {
    background: document.querySelector<HTMLOutputElement>('#background-shift')!,
    figure: document.querySelector<HTMLOutputElement>('#figure-shift')!,
    foreground: document.querySelector<HTMLOutputElement>('#foreground-shift')!,
  };

  const assets = await loadModel({ modelUrl: 'rigs/figure/skeleton.model.json', regions: 'none' });
  const player = new RigPlayer(document.createElement('div'), assets, { mode: 'canvas' });
  const renderer = player.renderer;
  if (!(renderer instanceof CanvasRenderer) || !assets.stage) throw new Error('The figure needs a canvas and a stage box');
  const box = assets.stage;
  renderer.viewport = box;
  player.play('walk');

  // A repeatable still for comparisons. The camera continues to run on the frame loop.
  const time = Number(new URLSearchParams(location.search).get('time') ?? NaN);
  if (Number.isFinite(time) && time >= 0) {
    player.seek(time);
    player.pause();
  }

  const layoutCompositor = createCompositor(stage, renderer.canvas);
  const neutral = { x: 0, y: 0 };
  let camera = neutral;
  let target = neutral;
  let limits: ReturnType<typeof cameraLimits>;
  let composite: ReturnType<typeof layoutCompositor>;

  stage.addEventListener('pointermove', event => {
    if (event.isPrimary) target = pointerTarget(event.clientX, event.clientY, stage.getBoundingClientRect());
  });
  const recenter = (event: PointerEvent) => { if (event.isPrimary) target = neutral; };
  stage.addEventListener('pointerleave', recenter);
  stage.addEventListener('pointercancel', recenter);

  const format = ({ x, y }: { x: number; y: number }) => {
    const px = (value: number) => (Math.round(value * 10) / 10).toFixed(1);
    return `${px(x)}, ${px(y)} px`;
  };

  function drawScene(): void {
    const selected = mode.value as CameraMode;
    const offset = { x: camera.x * limits.x, y: camera.y * limits.y };
    const shifts = composite(offset, selected);
    cameraPosition.value = format(selected === 'fixed' ? neutral : offset);
    readouts.background.value = format(shifts.background);
    readouts.figure.value = format(shifts.figure);
    readouts.foreground.value = format(shifts.foreground);
  }

  function layout(): void {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const ratio = devicePixelRatio;
    const scale = Math.min(width * 0.5 / box.width, height * 0.72 / box.height);
    renderer.pixelRatio = scale * ratio;
    limits = cameraLimits(width, height);
    composite = layoutCompositor(width, height, ratio, {
      x: (width - box.width * scale) / 2,
      y: height * 0.81 - box.height * scale,
      width: box.width * scale,
      height: box.height * scale,
    });
    player.draw();
    drawScene();
  }

  status.textContent = 'Move the pointer over the scene. Plane offsets use screen axes (+Y down).';
  layout();
  new ResizeObserver(layout).observe(stage);

  let last = performance.now();
  requestAnimationFrame(function tick(now) {
    const elapsed = Math.max(0, (now - last) / 1000);
    last = now;
    player.frame(Math.min(elapsed, 1 / 15));
    camera = easeCamera(camera, target, elapsed);
    drawScene();
    requestAnimationFrame(tick);
  });
  return player;
}
