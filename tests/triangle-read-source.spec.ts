import { expect, test } from '@playwright/test';
import { triangleReadSource } from '../src/MeshGlBlitter.js';

test('raster reads keep public frozen topology isolated and preserve its values', () => {
  const source = Object.freeze([0, 1, 2, 2, 3, 0]);
  const kept = triangleReadSource(source);
  expect(kept).not.toBe(source);
  expect(Object.isFrozen(kept)).toBe(false);
  expect(Array.from(kept)).toEqual(source);
  expect(triangleReadSource(source)).toBe(kept);
  expect(Reflect.set(source, '0', 9)).toBe(false);
  expect(Array.from(kept)).toEqual([0, 1, 2, 2, 3, 0]);
});

test('mutable caller indices stay live, including typed arrays', () => {
  for (const source of [[0, 1, 2], new Uint16Array([0, 1, 2])]) {
    const kept = triangleReadSource(source);
    expect(kept).toBe(source);
    source[0] = 2;
    expect(kept[0]).toBe(2);
    expect(triangleReadSource(source)).toBe(source);
  }
});
