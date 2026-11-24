import { mountComposedTake } from './composed-take.js';
import { planeOffsets, type CameraMode } from './parallax-compositor.js';

const fixtureRoot = 'tests/fixtures/composed-direction';
const slots = {
  background: ['backdrop'],
  figure: ['actor:background', 'actor:torso', 'actor:lantern', 'actor:face', 'actor:eye_r', 'actor:eye_l'],
  foreground: ['foreground'],
} as const;
const planes = ['background', 'figure', 'foreground'] as const;
const cameraUnitShift = {
  fixed: planeOffsets({ x: 1, y: 1 }, 'fixed').background,
  parallax: planeOffsets({ x: 1, y: 1 }, 'parallax').background,
  pan: planeOffsets({ x: 1, y: 1 }, 'pan').background,
};

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function cameraMode(value: string | null): CameraMode {
  return value === 'parallax' || value === 'pan' ? value : 'fixed';
}

function pixels(x: number, y: number): string {
  const px = (value: number) => (Math.round(value * 100) / 100).toFixed(2);
  return `${px(x)}, ${px(y)}`;
}

function showStatus(status: HTMLElement, message: string, refused = false): void {
  status.textContent = message;
  status.toggleAttribute('data-refused', refused);
}

async function mountReview(): Promise<void> {
  const root = element('stage');
  const status = element('status');
  const fixture = element<HTMLSelectElement>('fixture');
  const camera = element<HTMLSelectElement>('camera-mode');
  const url = new URL(location.href);
  const requestedFixture = url.searchParams.get('fixture');
  fixture.value = requestedFixture === 'original' || requestedFixture === 'clip' ? requestedFixture : 'overscan';
  camera.value = cameraMode(url.searchParams.get('camera'));
  fixture.addEventListener('change', () => {
    const next = new URL(location.href);
    next.searchParams.set('fixture', fixture.value);
    location.assign(next);
  });

  const take = await mountComposedTake(root, {
    modelUrl: `${fixtureRoot}/${fixture.value}/skeleton.model.json`,
    animation: 'idle',
    loop: true,
    slots,
  });
  take.canvas.setAttribute('aria-label', 'Composed take with a background, figure and foreground');

  const still = Number(url.searchParams.get('time') ?? NaN);
  const frozen = Number.isFinite(still) && still >= 0 && still < 4;
  if (frozen) {
    take.player.seek(still);
    take.player.pause();
  }

  let lastRefusal = take.refusal;
  function showRefusal(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    showStatus(status, `${message} Active camera: ${take.mode}.`, true);
  }

  function selectCamera(): void {
    const selected = cameraMode(camera.value);
    try {
      take.setCamera(selected);
      const movement = selected === 'fixed' ? 'Fixed camera.' : 'Move the pointer over the stage.';
      showStatus(status, `${movement} ${frozen ? `Pose held at ${still} s.` : 'Playing the four-second idle loop.'}`);
    } catch (error) {
      showRefusal(error);
    }
    lastRefusal = take.refusal;
  }

  const cameraPosition = element('camera-position');
  const cameraLimit = element('camera-limit');
  const readouts = planes.map(plane => ({
    plane,
    shift: element(`${plane}-shift`),
    limit: element(`${plane}-limit`),
  }));

  function updateLimits(): void {
    const selected = cameraMode(camera.value);
    const { x, y } = selected === 'fixed' ? { x: 0, y: 0 } : take.cameraExcursion;
    const shifts = planeOffsets({ x, y }, selected);
    cameraLimit.textContent = pixels(x, y);
    for (const { plane, limit } of readouts) {
      limit.textContent = pixels(Math.abs(shifts[plane].x), Math.abs(shifts[plane].y));
    }
  }

  camera.disabled = false;
  camera.addEventListener('change', () => {
    const next = new URL(location.href);
    next.searchParams.set('camera', camera.value);
    history.replaceState(null, '', next);
    selectCamera();
    updateLimits();
  });
  selectCamera();
  updateLimits();
  const observer = new ResizeObserver(updateLimits);
  observer.observe(root);

  function showPixels(target: HTMLElement, x: number, y: number): void {
    const value = pixels(x, y);
    if (target.textContent !== value) target.textContent = value;
  }

  let frame = requestAnimationFrame(function readFrame() {
    if (take.refusal !== lastRefusal) {
      lastRefusal = take.refusal;
      if (lastRefusal) showRefusal(lastRefusal);
    }
    const offsets = take.offsets;
    const unit = cameraUnitShift[take.mode];
    showPixels(cameraPosition, unit.x === 0 ? 0 : offsets.background.x / unit.x, unit.y === 0 ? 0 : offsets.background.y / unit.y);
    for (const { plane, shift } of readouts) showPixels(shift, offsets[plane].x, offsets[plane].y);
    frame = requestAnimationFrame(readFrame);
  });

  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    cancelAnimationFrame(frame);
    observer.disconnect();
    take.dispose();
  });
}

void mountReview().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  showStatus(element('status'), message, true);
});
