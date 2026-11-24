import type { BoneLocals } from './player.js';

export type TurnAxis = 'yaw' | 'pitch' | 'body';

/** A discovered slider's input range in the driven bone channel's local units. */
export interface TurnDial {
  axis: TurnAxis;
  bone: string;
  slider: string;
  channel: keyof BoneLocals;
  min: number;
  max: number;
  provenance: string;
}

const canonicalBones = {
  yaw: 'yaw_dial',
  pitch: 'pitch_dial',
  body: 'body_yaw_dial',
} as const;

const channels = new Map<string, keyof BoneLocals>([
  ['rotate', 'rotation'],
  ['x', 'x'],
  ['y', 'y'],
  ['scaleX', 'scaleX'],
  ['scaleY', 'scaleY'],
  ['shearY', 'shearY'],
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function unprefixed(name: string): string {
  const separator = name.indexOf(':');
  return separator > 0 ? name.slice(separator + 1) : name;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Reads the turn sliders in parsed compiled model JSON, in yaw, pitch, body order.
 * Supply the matching ModelAssets.animations to use runtime animation durations.
 */
export function discoverTurnDials(
  model: unknown,
  durations?: readonly { name: string; duration: number }[],
): TurnDial[] {
  const doc = record(model);
  if (!doc || !Array.isArray(doc.bones) || !Array.isArray(doc.constraints)) return [];

  const bones = new Set(doc.bones.map((row: unknown) => record(row)?.name));
  const sliders = doc.constraints.flatMap((row: unknown) => {
    const constraint = record(row);
    if (constraint?.kind !== 'slider') return [];
    const { name, bone, animation } = constraint;
    if (typeof name !== 'string' || typeof bone !== 'string' || !bones.has(bone)) return [];
    return [{ constraint, name, bone, animation }];
  });
  const animationRows: readonly unknown[] = durations ?? (Array.isArray(doc.animations) ? doc.animations : []);
  const animations = animationRows.map(record);
  const result: TurnDial[] = [];

  for (const axis of ['yaw', 'pitch', 'body'] as const) {
    const canonical = canonicalBones[axis];
    // Count bindings before checking their usability. An unusable binding still makes the axis ambiguous.
    const candidates = sliders.filter(({ bone, animation }) => unprefixed(bone) === canonical ||
      (axis === 'body' && typeof animation === 'string' && unprefixed(animation) === 'body_turn'));
    if (candidates.length !== 1) continue;

    const { constraint, name, bone, animation } = candidates[0];
    if (!constraint.local || constraint.loop || typeof animation !== 'string') continue;
    const property = constraint.property ?? 'rotate';
    const channel = typeof property === 'string' ? channels.get(property) : undefined;
    const duration = animations.find((row) => row?.name === animation)?.duration;
    const from = constraint.from ?? 0;
    const to = constraint.to ?? 0;
    const scale = constraint.scale ?? 1;
    if (!channel || !finite(duration) || duration <= 0 ||
      !finite(from) || !finite(to) || !finite(scale) || scale === 0) continue;

    // Invert the slider mapping at animation times zero and duration.
    const start = from - to / scale;
    const end = from + (duration - to) / scale;
    const min = Math.min(start, end);
    const max = Math.max(start, end);
    if (!finite(min) || !finite(max) || min === max || min > 0 || max < 0) continue;
    if (result.some((dial) => dial.bone === bone && dial.channel === channel)) continue;

    const binding = unprefixed(bone) === canonical ? '' : ' (compiled body_turn binding)';
    result.push({
      axis,
      bone,
      slider: name,
      channel,
      min,
      max,
      provenance: `model slider ${name} → bone ${bone}, ${property}, animation ${animation}${binding}`,
    });
  }
  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value)) || 0;
}

/** Maps normalized input around zero, interpolating each side of the range independently. */
export function normalizedDial(value: number, range: { min: number; max: number }): number {
  const input = clamp(value, -1, 1);
  const neutral = clamp(0, range.min, range.max);
  const endpoint = input < 0 ? range.min : range.max;
  return clamp(neutral + Math.abs(input) * (endpoint - neutral), range.min, range.max);
}
