type Point = { x: number; y: number };
type Offsets = { background: Point; figure: Point; foreground: Point };

export type CameraMode = 'parallax' | 'pan' | 'fixed';

const ORIGIN = { x: 0, y: 0 };
const GAINS = { background: -0.55, figure: 0, foreground: 0.55 };
const TIME_CONSTANT = 0.12; // seconds
const NEUTRAL_THRESHOLD = 0.00001; // normalized, under 0.001 CSS px at the camera limit

export function pointerTarget(clientX: number, clientY: number, viewport: DOMRectReadOnly): Point {
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  return {
    x: clamp(2 * (clientX - viewport.left) / viewport.width - 1),
    y: clamp(1 - 2 * (clientY - viewport.top) / viewport.height),
  };
}

export function easeCamera(current: Point, target: Point, elapsed: number): Point {
  const weight = -Math.expm1(-elapsed / TIME_CONSTANT);
  const ease = (value: number, goal: number) => {
    const next = value + (goal - value) * weight;
    return goal === 0 && Math.abs(next) <= NEUTRAL_THRESHOLD ? 0 : next;
  };
  return { x: ease(current.x, target.x), y: ease(current.y, target.y) };
}

export function cameraLimits(width: number, height: number): Point {
  return { x: Math.min(64, width * 0.1), y: Math.min(40, height * 0.1) };
}

export function planeShift(camera: Point, gain: number): Point {
  // Positive gain opposes camera motion. The camera is Y-up and the screen is Y-down.
  const x = -gain * camera.x;
  const y = gain * camera.y;
  return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y };
}

/** A finite handoff followed by the same elapsed-time pointer easing as the legacy camera. */
export function createCameraHandoff(transitionSeconds: number) {
  let phase: 'automatic' | 'acquiring' | 'centered' | 'tracking' | 'releasing' = 'automatic';
  let weight = 0;
  let pointer = ORIGIN;
  let fromWeight = 0;
  let fromPointer = ORIGIN;
  let elapsed = 0;

  function retarget(next: 'acquiring' | 'releasing'): void {
    phase = next;
    fromWeight = weight;
    fromPointer = pointer;
    elapsed = 0;
  }

  return {
    get weight() { return weight; },
    get pointer() { return pointer; },
    enter() { retarget('acquiring'); },
    leave() { retarget('releasing'); },
    reset() {
      phase = 'automatic';
      pointer = ORIGIN;
      weight = 0;
    },
    painted() {
      // Present the exact acquisition endpoint even if a frame spans it.
      if (phase === 'centered') phase = 'tracking';
    },
    advance(dt: number, target: Point) {
      if (!(dt > 0)) return;
      if (phase === 'tracking') pointer = easeCamera(pointer, target, dt);
      if (phase !== 'acquiring' && phase !== 'releasing') return;

      elapsed += dt;
      const entering = phase === 'acquiring';
      // Seconds accumulated in separate steps can miss the endpoint by an ulp.
      if (elapsed >= transitionSeconds * (1 - Number.EPSILON)) {
        weight = entering ? 1 : 0;
        pointer = ORIGIN;
        phase = entering ? 'centered' : 'automatic';
        return;
      }
      const u = elapsed / transitionSeconds;
      const s = u * u * (3 - 2 * u);
      weight = (1 - s) * fromWeight + s * Number(entering);
      if (entering) pointer = { x: (1 - s) * fromPointer.x, y: (1 - s) * fromPointer.y };
    },
  };
}

export function planeOffsets(camera: Point, mode: CameraMode): Offsets {
  if (mode === 'fixed') return { background: ORIGIN, figure: ORIGIN, foreground: ORIGIN };
  return {
    background: planeShift(camera, mode === 'pan' ? 1 : GAINS.background),
    figure: planeShift(camera, mode === 'pan' ? 1 : GAINS.figure),
    foreground: planeShift(camera, mode === 'pan' ? 1 : GAINS.foreground),
  };
}
