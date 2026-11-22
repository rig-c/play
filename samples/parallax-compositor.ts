type Point = { x: number; y: number };
type Size = { width: number; height: number };
type PlaneBox = Point & Size;
type Plane = { image: HTMLCanvasElement; box: PlaneBox };
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

function planeShift(camera: Point, gain: number): Point {
  // Positive gain opposes camera motion. The camera is Y-up and the screen is Y-down.
  return { x: -gain * camera.x, y: gain * camera.y };
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  return ctx;
}

function artwork(box: PlaneBox, ratio: number, paint: (ctx: CanvasRenderingContext2D) => void): Plane {
  const image = document.createElement('canvas');
  image.width = Math.ceil(box.width * ratio);
  image.height = Math.ceil(box.height * ratio);
  const ctx = context(image);
  ctx.scale(image.width / box.width, image.height / box.height);
  ctx.translate(-box.x, -box.y);
  paint(ctx);
  return { image, box };
}

function backgroundPlane(width: number, height: number, ratio: number): Plane {
  const limit = cameraLimits(width, height);
  // Pan's unit gain gives the background its largest absolute shift.
  const padX = Math.ceil(limit.x) + 2;
  const padY = Math.ceil(limit.y) + 2;
  const box = { x: -padX, y: -padY, width: width + 2 * padX, height: height + 2 * padY };
  return artwork(box, ratio, ctx => {
    const sky = ctx.createLinearGradient(0, 0, 0, height * 0.82);
    sky.addColorStop(0, '#142632');
    sky.addColorStop(1, '#49686d');
    ctx.fillStyle = sky;
    ctx.fillRect(box.x, box.y, box.width, box.height);

    ctx.fillStyle = '#e7bd82';
    ctx.beginPath();
    ctx.arc(width * 0.69, height * 0.31, Math.min(width, height) * 0.11, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#283f48';
    const ridge = [[-0.2, 0.58], [0.12, 0.42], [0.29, 0.58], [0.45, 0.49], [0.64, 0.63], [0.83, 0.44], [1.2, 0.64]];
    ctx.beginPath();
    ctx.moveTo(box.x, height * 0.64);
    for (const [x, y] of ridge) ctx.lineTo(x * width, y * height);
    ctx.lineTo(box.x + box.width, height * 0.64);
    ctx.lineTo(box.x + box.width, height * 0.8);
    ctx.lineTo(box.x, height * 0.8);
    ctx.fill();

    ctx.fillStyle = '#20363e';
    ctx.fillRect(box.x, height * 0.79, box.width, height + padY - height * 0.79);
    ctx.strokeStyle = '#37535a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const y of [0.79, 0.84, 0.93, 1.08]) {
      ctx.moveTo(box.x, y * height);
      ctx.lineTo(box.x + box.width, y * height);
    }
    for (let i = -7; i <= 7; i++) {
      ctx.moveTo(width * 0.5 + i * width * 0.057, height * 0.79);
      ctx.lineTo(width * 0.5 + i * width * 0.18, height + padY);
    }
    ctx.stroke();
  });
}

function foregroundPlane(width: number, height: number, ratio: number): Plane {
  return artwork({ x: 0, y: 0, width, height }, ratio, ctx => {
    const unit = Math.min(width, height);
    for (const x of [width * 0.18, width * 0.82]) {
      const y = height * 0.92;
      ctx.fillStyle = '#12242c';
      ctx.fillRect(x - unit * 0.026, y - unit * 0.016, unit * 0.052, unit * 0.025);
      ctx.fillRect(x - unit * 0.013, y - unit * 0.21, unit * 0.026, unit * 0.21);
      ctx.fillStyle = '#e48b60';
      ctx.fillRect(x - unit * 0.013, y - unit * 0.21, unit * 0.026, unit * 0.017);
      ctx.fillStyle = '#79a7a5';
      ctx.fillRect(x - unit * 0.013, y - unit * 0.178, unit * 0.026, unit * 0.005);
    }
  });
}

export function createCompositor(canvas: HTMLCanvasElement, figureSource: HTMLCanvasElement) {
  const ctx = context(canvas);

  return function layout(width: number, height: number, ratio: number, figureBox: PlaneBox) {
    canvas.width = Math.ceil(width * ratio);
    canvas.height = Math.ceil(height * ratio);
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);

    const background = backgroundPlane(width, height, ratio);
    const figure = { image: figureSource, box: figureBox };
    const foreground = foregroundPlane(width, height, ratio);

    function draw(plane: Plane, shift: Point): void {
      const { x, y, width, height } = plane.box;
      ctx.drawImage(plane.image, x + shift.x, y + shift.y, width, height);
    }

    return function composite(camera: Point, mode: CameraMode): Offsets {
      const offsets = mode === 'fixed'
        ? { background: ORIGIN, figure: ORIGIN, foreground: ORIGIN }
        : {
          background: planeShift(camera, mode === 'pan' ? 1 : GAINS.background),
          figure: planeShift(camera, mode === 'pan' ? 1 : GAINS.figure),
          foreground: planeShift(camera, mode === 'pan' ? 1 : GAINS.foreground),
        };
      ctx.clearRect(0, 0, width, height);
      draw(background, offsets.background);
      draw(figure, offsets.figure);
      draw(foreground, offsets.foreground);
      return offsets;
    };
  };
}
