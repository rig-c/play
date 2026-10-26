import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkedLiveFrame, type LiveFrame } from '../src/liveFrame.js';

function frame(): LiveFrame {
  return { generation: 1, count: 1, drawOrder: new Int32Array([0]), vertices: new Float64Array([2, 3]), tint: new Float64Array([1, 1, 1, 1]),
    attachments: Object.freeze([Object.freeze({ slot: 's', slotIndex: 0, attachment: 'named', skin: 'default', placeholder: 'p', kind: 'region' as const, region: 'r', page: 'page', pma: false, blend: 'Normal' as const, offset: 0, count: 2, uvs: Object.freeze([0, 1]), triangles: Object.freeze([0, 1, 2]), dark: null, clip: null })]) };
}

test('held frame and nested buffers become stale; a fresh lease reads the next generation', () => {
  let generation = 1;
  const source = frame();
  const lease = checkedLiveFrame(source, () => generation);
  const vertices = lease.vertices;
  const uv = lease.attachments[0].uvs;
  const attachment = lease.attachments[0];
  assert.equal(vertices[0], 2);
  assert.deepEqual([...lease.attachments].map(value => value.slot), ['s']);
  generation++;
  for (const read of [() => lease.count, () => vertices[0], () => uv[0], () => attachment.slot]) assert.throws(read, /LIVE_FRAME_STALE/);
  assert.equal(checkedLiveFrame(source, () => generation).vertices[1], 3);
});

test('lease rejects writes and backing-store escape routes', () => {
  const lease = checkedLiveFrame(frame(), () => 1);
  assert.throws(() => { (lease.vertices as { [i: number]: number })[0] = 8; }, /LIVE_FRAME_READONLY/);
  assert.throws(() => Reflect.get(lease.vertices, 'buffer'), /LIVE_FRAME_READONLY/);
  assert.throws(() => Reflect.get(lease.vertices, 'forEach')(() => undefined), /LIVE_FRAME_READONLY/);
  assert.throws(() => Reflect.set(lease.attachments[0], 'slot', 'wrong'), /LIVE_FRAME_READONLY/);
  assert.throws(() => Object.preventExtensions(lease), /LIVE_FRAME_READONLY/);
});

test('unguarded borrowed source changes while detached numeric copies remain unchanged', () => {
  const source = frame();
  const before = Array.from(source.vertices);
  (source.vertices as Float64Array)[0] = 9;
  assert.equal(source.vertices[0], 9);
  assert.deepEqual(before, [2, 3]);
});
