import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { expect, type Page, test } from '@playwright/test';
import type { Mount, step1ControlProbe } from './step1-control-probe';

type Probe = Awaited<ReturnType<typeof step1ControlProbe>>;
type Sample = Probe['warm'][number];

const MESHES = 9;
const INDICES_PER_MESH = 6;
const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT;
const EXPECTED = {
  dom: { copies: MESHES, stride: 4 },
  canvas: { copies: 1, stride: 8 },
};
const SCALES = {
  A: { cold: 1, warm: 0.9375 },
  B: { cold: 0.96875, warm: 0.90625 },
};

function expectedSize(mount: 'A' | 'B', phase: 'cold' | 'warm', slot: number) {
  // The authored boxes start at 16.25 on both axes. This oracle reads their
  // source geometry and the keyed scale, with one extra pixel per edge.
  const scale = SCALES[mount][phase];
  const min = Math.floor(16.25 * scale);
  return [384.25 + slot * 4, 288.25 + slot * 4].map(max => Math.ceil(max * scale) - min + 2);
}

function assertDrawn(sample: Sample, phase: 'cold' | 'warm') {
  const label = `${sample.name} ${phase}`;
  const { name } = sample;
  const mode = name === 'C' ? 'canvas' : 'dom';
  const { copies } = EXPECTED[mode];
  expect(sample.mode, label).toBe(mode);
  expect(sample.backend, label).toBe('webgl');
  expect(sample.fallback, label).toBeNull();
  expect([sample.drawn, sample.reused, sample.canvases, sample.clears], label).toEqual([copies, 0, copies, copies]);
  expect(sample.draws, label).toHaveLength(MESHES);
  expect(sample.scissors, label).toHaveLength(copies);
  expect(sample.copies, label).toHaveLength(copies);

  const expectedDraw = (slot: number) => ({
    triangles: true, first: slot * INDICES_PER_MESH, count: INDICES_PER_MESH,
  });
  // The fixture alternates its two page images, so CanvasRenderer draws
  // nine runs within one frame rect, then blits that rect once.
  if (name === 'C') {
    expect(sample.draws, label).toEqual(Array.from({ length: MESHES }, (_, slot) => expectedDraw(slot)));
  }
  const seen = new Set<number>();
  for (const [i, { rect, target }] of sample.scissors.entries()) {
    const [x, bottom, width, height] = rect;
    const [targetWidth, targetHeight] = target;
    if (mode === 'dom') expect(Math.max(...target), label).toBeGreaterThan(2048);
    expect(x, label).toBeGreaterThanOrEqual(0);
    expect(bottom, label).toBeGreaterThanOrEqual(0);
    expect(x + width, label).toBeLessThanOrEqual(targetWidth);
    expect(bottom + height, label).toBeLessThanOrEqual(targetHeight);
    const top = targetHeight - bottom - height;
    const expectedCopy = [x, top, width, height, 0, 0, width, height];
    const matches = sample.copies.filter(copy => copy.rects.every((value, j) => value === expectedCopy[j]) && copy.rects.length === expectedCopy.length);
    expect(matches, `${label} scissor ${i}`).toHaveLength(1);
    const [{ destination, sharedSource }] = matches;
    expect(sharedSource, label).toBe(true);
    expect(destination, label).toBeGreaterThanOrEqual(0);
    expect(seen.has(destination), label).toBe(false);
    seen.add(destination);
    const size = name === 'C' ? [440, 360] : expectedSize(name, phase, destination);
    expect([width, height], `${label} canvas ${destination} copy size`).toEqual(size);
    if (mode === 'dom') expect(sample.draws[i], `${label} canvas ${destination} draw`).toEqual(expectedDraw(destination));
  }
}

function expectedPayloadBytes(mode: Sample['mode']) {
  return MESHES * INDICES_PER_MESH * EXPECTED[mode].stride * FLOAT_BYTES;
}

function assertWarm(warm: Sample) {
  expect(warm.bufferData, `${warm.name} warm buffer allocations`).toEqual([]);
  expect(warm.resources, `${warm.name} warm resources and links`).toEqual({});
  expect(warm.reallocations, `${warm.name} warm canvas reallocations`).toBe(0);
  expect(warm.bufferSubData, `${warm.name} warm uploads`).toHaveLength(1);
  const [upload] = warm.bufferSubData;
  const bytes = expectedPayloadBytes(warm.mode);
  expect(upload).toMatchObject({ bytes, offset: 0, arrayBuffer: true });
  expect(upload.payload).toHaveLength(bytes);
}

function assertFrozen(frozen: Sample) {
  const canvases = EXPECTED[frozen.mode].copies;
  expect(frozen).toMatchObject({
    backend: 'webgl', fallback: null, canvases, drawn: 0, reused: canvases,
    reallocations: 0, clears: 0, glStateCalls: 0,
    bufferData: [], bufferSubData: [], copies: [], draws: [], scissors: [],
  });
  expect(frozen.resources, `${frozen.name} frozen resources and links`).toEqual({});
}

async function sample(page: Page, order: Mount[], readPixels: boolean) {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const probe = await page.evaluate(({ mounts, rgba }) => window.rigPlayHarness.step1ControlProbe(mounts, rgba), { mounts: order, rgba: readPixels });
  console.log(JSON.stringify({
    probe: 'step1-control', order, rasterContexts: probe.rasterContexts, vaoOes: probe.vaoObservation,
    phases: [probe.cold, probe.warm, probe.frozen].map(phase => phase.map(mount => ({
      name: mount.name, mode: mount.mode, backend: mount.backend, drawn: mount.drawn, reused: mount.reused,
      targets: [...new Set(mount.scissors.map(({ target }) => target.join('x')))],
      copies: mount.copies.length, draws: mount.draws.length, scissors: mount.scissors.length,
      allocations: mount.bufferData.map(({ bytes }) => bytes),
      uploads: mount.bufferSubData.map(({ bytes, offset, payload }) => ({
        bytes, offset, sha256: payload && createHash('sha256').update(Buffer.from(payload)).digest('hex'),
      })),
      resources: mount.resources,
    }))),
    rgbaCanvases: probe.rgba.map(mount => mount.canvases.length),
  }));
  expect(probe.rasterContexts, 'both mounts raster through the same context').toBe(1);
  for (const phase of [probe.cold, probe.warm, probe.frozen]) {
    expect(phase.map(mount => mount.name)).toEqual(order);
  }
  for (const cold of probe.cold) assertDrawn(cold, 'cold');
  for (const warm of probe.warm) {
    assertDrawn(warm, 'warm');
    assertWarm(warm);
  }
  for (const frozen of probe.frozen) assertFrozen(frozen);

  const first = probe.cold[0];
  expect(first.bufferData.some(upload => upload.arrayBuffer && upload.bytes >= expectedPayloadBytes(first.mode) && !upload.payload), 'cold buffer storage allocation').toBe(true);
  expect(first.resources.createBuffer, 'cold buffer creation').toBeGreaterThan(0);
  expect(first.resources.linkProgram, 'cold program link').toBeGreaterThan(0);
  expect(first.resources.createTexture, 'cold texture creation').toBeGreaterThan(0);
  expect(first.resources.texImage2D, 'cold texture upload').toBeGreaterThan(0);
  return probe;
}

function assertPixels(solo: Probe, pair: Probe, mount: Mount) {
  const [reference] = solo.rgba;
  const paired = pair.rgba.find(entry => entry.name === mount);
  expect(paired?.canvases).toHaveLength(MESHES);
  expect(reference.canvases).toHaveLength(MESHES);
  for (const [i, expected] of reference.canvases.entries()) {
    const actual = paired!.canvases[i];
    const label = `${mount} canvas ${i} fixed-pose RGBA`;
    expect(expected.ink, label).toBeGreaterThan(0);
    expect([actual.width, actual.height], label).toEqual([expected.width, expected.height]);
    const source = inflateSync(Buffer.from(expected.deflated, 'base64'));
    const output = inflateSync(Buffer.from(actual.deflated, 'base64'));
    expect(source.length, label).toBe(expected.width * expected.height * 4);
    expect(output.equals(source), label).toBe(true);
  }
}

async function assertPairings(page: Page, other: 'B' | 'C', readPixels: boolean) {
  const a = await sample(page, ['A'], readPixels);
  const second = await sample(page, [other], readPixels);
  const firstUpload = a.warm[0].bufferSubData[0];
  const secondUpload = second.warm[0].bufferSubData[0];
  expect(firstUpload.payload).not.toEqual(secondUpload.payload);
  if (other === 'C') expect(firstUpload.bytes).not.toBe(secondUpload.bytes);

  const orders: Mount[][] = [['A', other], [other, 'A']];
  for (const order of orders) {
    const pair = await sample(page, order, readPixels);
    for (const warm of pair.warm) {
      const reference = warm.name === 'A' ? a : second;
      expect(warm.bufferSubData, `${order.join(' then ')} ${warm.name} payload bytes`).toEqual(reference.warm[0].bufferSubData);
      if (readPixels) assertPixels(reference, pair, warm.name);
    }
  }
}

test('warm DOM WebGL uploads one used prefix per dirty mount in both orders', async ({ page, browserName }) => {
  // The call-count contract runs on both engines. Existing packing probes
  // scope exact WebGL readback comparisons to Chromium.
  await assertPairings(page, 'B', browserName === 'chromium');
});

test('warm DOM and Canvas WebGL alternate upload sizes in both orders', async ({ page }) => {
  await assertPairings(page, 'C', false);
});
