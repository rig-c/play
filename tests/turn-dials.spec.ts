import { expect, test } from '@playwright/test';
import { discoverTurnDials, normalizedDial, type TurnDial } from '../src/turnDials.js';

function slider(bone: string, animation = 'turn', overrides: Record<string, unknown> = {}) {
  return {
    kind: 'slider', name: bone, bone, animation, property: 'rotate',
    local: true, from: -12, to: 0, scale: 0.0625, ...overrides,
  };
}

function model(
  constraints: ReturnType<typeof slider>[],
  animations: readonly { name: string; duration: number }[] = [{ name: 'turn', duration: 1.5 }],
  bones = constraints.map(({ bone }) => bone),
) {
  return { spec: 'rigc-compiled/3', bones: bones.map((name) => ({ name })), constraints, animations };
}

function canonicalDials(prefix = '') {
  return [
    slider(prefix + 'yaw_dial', prefix + 'turn', { name: prefix + 'yaw' }),
    slider(prefix + 'pitch_dial', prefix + 'tilt', { name: prefix + 'pitch' }),
    slider(prefix + 'body_yaw_dial', prefix + 'body_turn'),
  ];
}

function durationsOf(...constraints: ReturnType<typeof slider>[]) {
  return constraints.map(({ animation: name }) => ({ name, duration: 1.5 }));
}

test('reports uncomposed and single-actor dials in yaw, pitch, body order with full names', () => {
  for (const prefix of ['', 'actor:']) {
    const [yaw, pitch, body] = canonicalDials(prefix);
    const doc = model([body, pitch, yaw], durationsOf(yaw, pitch, body));
    expect(discoverTurnDials(doc)).toEqual([
      {
        axis: 'yaw', bone: prefix + 'yaw_dial', slider: prefix + 'yaw', channel: 'rotation', min: -12, max: 12,
        provenance: `model slider ${prefix}yaw → bone ${prefix}yaw_dial, rotate, animation ${prefix}turn`,
      },
      {
        axis: 'pitch', bone: prefix + 'pitch_dial', slider: prefix + 'pitch', channel: 'rotation', min: -12, max: 12,
        provenance: `model slider ${prefix}pitch → bone ${prefix}pitch_dial, rotate, animation ${prefix}tilt`,
      },
      {
        axis: 'body', bone: prefix + 'body_yaw_dial', slider: prefix + 'body_yaw_dial', channel: 'rotation', min: -12, max: 12,
        provenance: `model slider ${prefix}body_yaw_dial → bone ${prefix}body_yaw_dial, rotate, animation ${prefix}body_turn`,
      },
    ]);
  }
});

test('finds a custom body bone through the namespaced body_turn animation', () => {
  const body = slider('actor:body_dial', 'actor:body_turn', { from: -15 });
  const doc = model([body], [{ name: 'actor:body_turn', duration: 1.875 }]);
  expect(discoverTurnDials(doc)).toEqual([{
    axis: 'body', bone: 'actor:body_dial', slider: 'actor:body_dial', channel: 'rotation', min: -15, max: 15,
    provenance: 'model slider actor:body_dial → bone actor:body_dial, rotate, animation actor:body_turn (compiled body_turn binding)',
  }]);
  for (const prefix of ['a:b:', ':']) {
    const binding = slider(prefix + 'body_yaw_dial', prefix + 'body_turn');
    expect(discoverTurnDials(model([binding], durationsOf(binding)))).toEqual([]);
  }
});

test('skips ambiguous axes even when one candidate would be unusable', () => {
  const bothActors = [...canonicalDials('actor:'), ...canonicalDials('other:')];
  expect(discoverTurnDials(model(bothActors, durationsOf(...bothActors)))).toEqual([]);

  const yaw = slider('yaw_dial');
  const pitch = slider('pitch_dial');
  const unusableYaw = slider('yaw_dial', 'missing', { name: 'other_yaw', loop: true });
  expect(discoverTurnDials(model([yaw, unusableYaw, pitch])).map(({ axis }) => axis)).toEqual(['pitch']);
});

test('takes slider offsets, reversed scale and duration from the matching animation', () => {
  const yaw = slider('yaw_dial', 'turn', { from: -4, to: 0.25, scale: 0.125, max: 0.1 });
  const pitch = slider('pitch_dial', 'turn', { from: 10, scale: -0.1 });
  const doc = model([yaw, pitch], [{ name: 'turn', duration: 1 }]);
  expect(discoverTurnDials(doc).map(({ axis, min, max }) => [axis, min, max])).toEqual([
    ['yaw', -6, 2],
    ['pitch', 0, 10],
  ]);
  const runtimeDurations = [{ name: 'turn', duration: 2 }] as const;
  expect(discoverTurnDials(doc, runtimeDurations).map(({ axis, min, max }) => [axis, min, max])).toEqual([
    ['yaw', -6, 10],
    ['pitch', -10, 10],
  ]);
  expect(discoverTurnDials(doc, [])).toEqual([]);
  expect(discoverTurnDials(doc, [{ name: 'turn', duration: 0 }])).toEqual([]);
});

test('maps slider properties to bone channels and keeps the first axis per bone channel', () => {
  const properties: [string, TurnDial['channel']][] = [
    ['rotate', 'rotation'], ['x', 'x'], ['y', 'y'], ['scaleX', 'scaleX'], ['scaleY', 'scaleY'], ['shearY', 'shearY'],
  ];
  for (const [property, channel] of properties) {
    const yaw = slider('yaw_dial', 'body_turn', { property });
    const dials = discoverTurnDials(model([yaw], durationsOf(yaw)));
    expect(dials).toHaveLength(1);
    expect(dials[0]).toMatchObject({ axis: 'yaw', channel });
  }
  const defaults = slider('yaw_dial', 'turn', { property: undefined, from: undefined, to: undefined, scale: undefined });
  expect(discoverTurnDials(model([defaults]))[0]).toMatchObject({ channel: 'rotation', min: 0, max: 1.5 });
});

test('skips missing and unusable bindings and ranges', () => {
  expect(discoverTurnDials(null)).toEqual([]);
  expect(discoverTurnDials({ bones: [] })).toEqual([]);
  expect(discoverTurnDials(model([]))).toEqual([]);

  const yaw = slider('yaw_dial');
  expect(discoverTurnDials(model([yaw], []))).toEqual([]);
  expect(discoverTurnDials(model([yaw], [{ name: 'turn', duration: 1 }], []))).toEqual([]);
  for (const duration of [0, -1, Infinity, NaN]) {
    expect(discoverTurnDials(model([yaw], [{ name: 'turn', duration }]))).toEqual([]);
  }
  for (const overrides of [
    { kind: 'transform' }, { loop: true }, { local: false }, { scale: 0 },
    { scale: Number.MIN_VALUE }, { from: Infinity }, { to: '1' }, { from: 1 },
    { property: 'shearX' }, { property: 'toString' },
  ]) {
    expect(discoverTurnDials(model([slider('yaw_dial', 'turn', overrides)])), JSON.stringify(overrides)).toEqual([]);
  }
});

test('maps normalized input around neutral with independent extents and clamps outside the pad', () => {
  const range = { min: -10, max: 30 };
  expect([-2, -1, -0.5, 0, 0.5, 1, 2].map((value) => normalizedDial(value, range)))
    .toEqual([-10, -10, -5, 0, 15, 30, 30]);
  expect(normalizedDial(-1, { min: 0, max: 10 })).toBe(0);
  expect(normalizedDial(1, { min: -10, max: 0 })).toBe(0);
  expect(normalizedDial(0, { min: 4, max: 10 })).toBe(4);
  expect(normalizedDial(0, { min: -10, max: -4 })).toBe(-4);
});
