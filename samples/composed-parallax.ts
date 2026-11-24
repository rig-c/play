import { mountComposedTake, type ComposedTakeOptions } from './composed-take.js';
import { planeOffsets, type CameraMode } from './parallax-compositor.js';

const fixtureRoot = 'tests/fixtures/composed-direction';
const slots = {
  background: ['backdrop'],
  figure: ['actor:background', 'actor:torso', 'actor:lantern', 'actor:face', 'actor:eye_r', 'actor:eye_l'],
  foreground: ['foreground'],
} as const;
const publicPlaneLabels = { background: 'Background', figure: 'Figure', foreground: 'Foreground' };
export const DEMO_TRANSITION_MS = 120;
export const DEMO_SWEEP_PERIOD_SECONDS = 12;
export const DEMO_SWEEP_EXCURSION = { x: 24, y: 0 } as const;
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

interface ComposedParallaxOptions {
  take: ComposedTakeOptions;
  poseDuration: number;
  planeLabels?: Readonly<Record<string, string>>;
  /** Camera gains to display for planes whose gains are inferred by the take. */
  inferredGains?: Readonly<Record<string, number>>;
}

export async function mountComposedParallax(options: ComposedParallaxOptions) {
  const root = element('stage');
  const status = element('status');
  const camera = element<HTMLSelectElement>('camera-mode');
  const namedPlanes = options.take.planes;
  const url = new URL(location.href);
  camera.value = cameraMode(url.searchParams.get('camera') ?? options.take.camera ?? null);

  const take = await mountComposedTake(root, { ...options.take, camera: 'fixed' });
  take.canvas.setAttribute('aria-label', 'Composed take');

  const still = Number(url.searchParams.get('time') ?? NaN);
  const frozen = Number.isFinite(still) && still >= 0 && still < options.poseDuration;
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
      const movement = selected === 'fixed' ? 'Fixed camera.' : namedPlanes && selected === 'parallax'
        ? 'Move into the stage to take control. Leave to resume automatic motion.'
        : 'Move the pointer over the stage.';
      showStatus(status, `${movement} ${frozen ? `Pose held at ${still} s.` : 'Playing the idle loop.'}`);
    } catch (error) {
      showRefusal(error);
    }
    lastRefusal = take.refusal;
  }

  const cameraPosition = element('camera-position');
  const cameraLimit = element('camera-limit');
  if (namedPlanes) {
    element('camera-reading-label').textContent = 'Pointer target (+Y up)';
    element('camera-limits-note').hidden = false;
  }
  const planeRows = element<HTMLTableSectionElement>('plane-readouts');
  planeRows.replaceChildren();
  const labels: Readonly<Record<string, string>> = options.planeLabels ?? publicPlaneLabels;
  const readouts = Object.keys(namedPlanes ?? publicPlaneLabels).map(plane => {
    const row = planeRows.insertRow();
    const heading = document.createElement('th');
    heading.scope = 'row';
    heading.textContent = labels[plane] ?? plane;
    row.append(heading);
    const shift = row.insertCell();
    const limit = row.insertCell();
    shift.id = `${plane}-shift`;
    limit.id = `${plane}-limit`;
    shift.textContent = '—';
    return { plane, shift, limit };
  });

  function updateLimits(): void {
    const selected = cameraMode(camera.value);
    const { x, y } = selected === 'fixed' ? { x: 0, y: 0 } : take.cameraExcursion;
    const shifts = planeOffsets({ x, y }, selected) as Readonly<Record<string, { x: number; y: number }>>;
    cameraLimit.textContent = pixels(x, y);
    for (const { plane, limit } of readouts) {
      if (selected !== 'parallax' || !namedPlanes) {
        const shift = namedPlanes ? { x, y } : shifts[plane];
        limit.textContent = pixels(Math.abs(shift.x), Math.abs(shift.y));
        continue;
      }
      const definition = namedPlanes[plane];
      const gain = definition.gain ?? options.inferredGains?.[plane]
        ?? (definition.role === 'figure' ? 0 : definition.role === 'backdrop' ? -0.55 : undefined);
      const sweep = options.take.autoSweep?.maxDisplacement;
      limit.textContent = gain === undefined ? '—' : pixels(
        Math.abs(gain) * Math.max(x, sweep?.x ?? 0), Math.abs(gain) * Math.max(y, sweep?.y ?? 0),
      );
    }
  }

  camera.disabled = false;
  function changeCamera(): void {
    const next = new URL(location.href);
    next.searchParams.set('camera', camera.value);
    history.replaceState(null, '', next);
    selectCamera();
    updateLimits();
  }
  camera.addEventListener('change', changeCamera);
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
    if (namedPlanes) {
      const { x, y } = take.cameraTarget;
      showPixels(cameraPosition, take.mode === 'fixed' ? 0 : x, take.mode === 'fixed' ? 0 : y);
    } else {
      const unit = cameraUnitShift[take.mode];
      showPixels(cameraPosition, unit.x === 0 ? 0 : offsets.background.x / unit.x, unit.y === 0 ? 0 : offsets.background.y / unit.y);
    }
    for (const { plane, shift } of readouts) showPixels(shift, offsets[plane].x, offsets[plane].y);
    frame = requestAnimationFrame(readFrame);
  });

  function dispose(): void {
    window.removeEventListener('pagehide', onPageHide);
    camera.removeEventListener('change', changeCamera);
    camera.disabled = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    take.dispose();
  }

  function onPageHide(event: PageTransitionEvent): void {
    if (!event.persisted) dispose();
  }

  window.addEventListener('pagehide', onPageHide);
  return { take, dispose };
}

export function mountPublicComposedParallax(): void {
  const fixture = element<HTMLSelectElement>('fixture');
  const motion = element<HTMLSelectElement>('camera-motion');
  const url = new URL(location.href);
  const requested = url.searchParams.get('fixture');
  fixture.value = requested === 'original' || requested === 'clip' ? requested : 'overscan';
  motion.value = url.searchParams.get('motion') === 'handoff' ? 'handoff' : 'legacy';
  for (const [param, select] of [['fixture', fixture], ['motion', motion]] as const) {
    select.addEventListener('change', () => {
      const next = new URL(location.href);
      next.searchParams.set(param, select.value);
      location.assign(next);
    });
  }

  const modelUrl = `${fixtureRoot}/${fixture.value}/skeleton.model.json`;
  const take = { modelUrl, animation: 'idle', loop: true } as const;

  void mountComposedParallax({
    take: motion.value === 'handoff' ? {
      ...take,
      planes: {
        background: { slots: slots.background, role: 'backdrop' },
        figure: { slots: slots.figure, role: 'figure' },
        foreground: { slots: slots.foreground, role: 'overlay', gain: 0.55 },
      },
      transitionMs: DEMO_TRANSITION_MS,
      autoSweep: { periodSeconds: DEMO_SWEEP_PERIOD_SECONDS, maxDisplacement: DEMO_SWEEP_EXCURSION },
    } : { ...take, slots },
    poseDuration: 4,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    showStatus(element('status'), message, true);
  });
}
