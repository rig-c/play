import { liveDrawings as drawings } from './liveFrameSource.js';
import { poseRawSetup } from 'rig-c/core';
import { compileRuntime, RuntimePose, type RuntimeAttachment, type RuntimeModel } from 'rig-c/runtime';
import { frameOf, type BlendMode, type FrameSource, type PosedFrame, type PosedSlot } from './posedFrame.js';

/** An indexed, read-only buffer. Buffer mutation methods are deliberately absent. */
export interface LiveNumbers {
  readonly length: number;
  readonly [index: number]: number;
}

/** A borrowed clipping polygon on the oracle fallback. */
export interface LiveClip {
  readonly polygon: LiveNumbers;
  readonly inverse: boolean;
  readonly convex: boolean;
}

/** Static draw metadata resolved once for an attachment. */
export interface LiveAttachment {
  readonly slot: string;
  readonly slotIndex: number;
  readonly attachment: string | null;
  readonly skin: string | null;
  /** Exact table key on the runtime path; unavailable on an oracle snapshot. */
  readonly placeholder: string | null;
  readonly kind: 'region' | 'mesh' | 'none';
  readonly region: string | null;
  readonly page: string | null;
  readonly pma: boolean;
  readonly blend: BlendMode;
  readonly offset: number;
  readonly count: number;
  readonly uvs: LiveNumbers;
  readonly triangles: LiveNumbers;
  readonly dark: LiveNumbers | null;
  readonly clip: LiveClip | null;
}

/**
 * A borrowed frame, valid only until the player's next pose mutation.
 * `drawOrder[0..count)` contains indices into `attachments`; vertices use each
 * attachment's offset/count, and tint uses slotIndex * 4. Production reuses the
 * buffers. Development leases detect stale reads, including held nested views.
 */
export interface LiveFrame {
  readonly generation: number;
  readonly count: number;
  readonly drawOrder: LiveNumbers;
  readonly vertices: LiveNumbers;
  readonly tint: LiveNumbers;
  readonly attachments: readonly LiveAttachment[];
}

/** @internal A stable array facade for the existing renderer interface, without vertex copies. */
function numbers(buffer: Float64Array, offset: number, count: number): number[] {
  const result = new Array<number>(count);
  for (let i = 0; i < count; i++) Object.defineProperty(result, i, {
    enumerable: true, get: () => buffer[offset + i],
  });
  return Object.freeze(result) as number[];
}

/** @internal Deep development lease. No typed-array method can expose writable backing storage. */
export function checkedLiveFrame(frame: LiveFrame, current: () => number): LiveFrame {
  const generation = current();
  const frameGeneration = frame.generation;
  const proxies = new WeakMap<object, object>();
  const check = (): void => {
    if (current() !== generation) throw new Error(`LIVE_FRAME_STALE: borrowed generation ${frameGeneration} was invalidated; call liveFrame() again`);
  };
  const wrap = <T extends object>(value: T): T => {
    const found = proxies.get(value);
    if (found) return found as T;
    // A separate extensible target avoids proxy invariants on frozen metadata.
    const proxy = new Proxy(Array.isArray(value) ? [] : {}, {
      get(_target, property) {
        check();
        if (property === 'buffer' || property === 'set' || property === 'fill' || property === 'copyWithin' || property === 'reverse' || property === 'sort') {
          throw new Error(`LIVE_FRAME_READONLY: ${String(property)} does not expose the live backing store`);
        }
        const item: unknown = Reflect.get(value, property, value);
        if (typeof item === 'function') {
          if (ArrayBuffer.isView(value) && property !== Symbol.iterator) throw new Error(`LIVE_FRAME_READONLY: ${String(property)} is not part of the indexed live buffer interface`);
          return (...args: unknown[]) => {
            check();
            const returned: unknown = Reflect.apply(item, Array.isArray(value) ? proxy : value, args);
            return returned !== null && typeof returned === 'object' ? wrap(returned) : returned;
          };
        }
        return item !== null && typeof item === 'object' ? wrap(item) : item;
      },
      set() { check(); throw new Error('LIVE_FRAME_READONLY: live frame values cannot be assigned'); },
      defineProperty() { check(); throw new Error('LIVE_FRAME_READONLY: live frame values cannot be redefined'); },
      deleteProperty() { check(); throw new Error('LIVE_FRAME_READONLY: live frame values cannot be deleted'); },
      preventExtensions() { check(); throw new Error('LIVE_FRAME_READONLY: live frame objects cannot be reconfigured'); },
      setPrototypeOf() { check(); throw new Error('LIVE_FRAME_READONLY: live frame prototypes cannot be changed'); },
      has(_target, property) { check(); return Reflect.has(value, property); },
      ownKeys() { check(); return Reflect.ownKeys(value); },
      getOwnPropertyDescriptor(_target, property) {
        check();
        if (property === 'length' && Array.isArray(value)) return { value: value.length, writable: true, configurable: false, enumerable: false };
        const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
        return descriptor ? { configurable: true, enumerable: descriptor.enumerable, get: () => Reflect.get(proxy, property) } : undefined;
      },
    });
    proxies.set(value, proxy);
    return proxy as T;
  };
  const lease = wrap(frame);
  const drawing = drawings.get(frame);
  if (drawing) drawings.set(lease, drawing);
  return lease;
}

/** @internal Runtime draw state. Constructed once per document view. */
export class RuntimeFrames {
  readonly model: RuntimeModel;
  readonly pose: RuntimePose;
  readonly renderFrame: PosedFrame = { order: [] };
  readonly live: LiveFrame;
  private readonly order: Int32Array;
  private readonly tint: Float64Array;
  private readonly templates: Array<PosedSlot | null>;
  private readonly colours: ReadonlyArray<readonly number[]>;
  /** Incremented when a draw refresh changes colour without a pose step. */
  revision = 0;
  private readonly previousColor = new Float64Array(4).fill(Number.NaN);
  private drawn = 0;
  private epoch = 0;

  constructor(source: FrameSource, model?: RuntimeModel) {
    this.model = model ?? compileRuntime(source.doc);
    this.pose = new RuntimePose(this.model);
    this.order = new Int32Array(this.model.slots.length);
    this.tint = new Float64Array(this.model.slots.length * 4);
    const colours: number[][] = [];
    const metadata: LiveAttachment[] = [];
    this.templates = this.model.attachments.map((attachment, index) => {
      const identity = attachment as RuntimeAttachment & { readonly skin?: string; readonly placeholder?: string };
      if (identity.skin === undefined || identity.placeholder === undefined) {
        throw new Error(`RUNTIME_DRAW_IDENTITY: attachment ${index} on slot "${this.model.slots[attachment.slot].name}" needs resolved skin and placeholder from rig-c/runtime`);
      }
      const slot = this.model.slots[attachment.slot];
      // This is a load-time oracle read, never a per-frame lookup or poser.
      const doc = { ...source.doc, slots: source.doc.slots.map((value, si) => ({ ...value, setup: si === attachment.slot ? identity.placeholder! : null })) };
      const setup = poseRawSetup(doc);
      const raw = setup.drawn.find(value => value.slot === slot.name);
      const template = frameOf(source, setup).order.find(value => value.slot === slot.name) ?? null;
      const colour = raw?.colour ?? [1, 1, 1, 1];
      colours.push(colour);
      if (template) {
        const vertices = numbers(this.pose.vertices, attachment.offset, attachment.count);
        if (template.kind === 'region') template.corners = vertices;
        else template.vertices = vertices;
        template.tint = numbers(this.tint, attachment.slot * 4, 4) as [number, number, number, number];
      }
      metadata.push(Object.freeze({
        slot: slot.name, slotIndex: attachment.slot, attachment: attachment.name,
        skin: identity.skin, placeholder: identity.placeholder,
        kind: template?.kind ?? 'none', region: template?.kind === 'region' ? template.region : null,
        page: template?.page ?? null, pma: template?.pma ?? false, blend: slot.blend,
        offset: attachment.offset, count: attachment.count,
        uvs: Object.freeze(template?.uvs ?? []), triangles: Object.freeze(template?.kind === 'mesh' ? template.triangles : []),
        dark: template?.dark ? Object.freeze(template.dark) : null, clip: null,
      }));
      return template;
    });
    this.colours = colours;
    const owner = this;
    this.live = Object.freeze({
      get generation() { return owner.epoch; }, get count() { return owner.drawn; },
      drawOrder: this.order, vertices: this.pose.vertices, tint: this.tint, attachments: Object.freeze(metadata),
    });
    drawings.set(this.live, this.renderFrame);
  }

  update(generation: number, color: readonly number[], draws: (slot: string) => boolean, poseChanged = true): void {
    if (poseChanged) this.pose.computeVertices();
    let colorChanged = false;
    for (let c = 0; c < 4; c++) {
      if (!Object.is(this.previousColor[c], color[c])) colorChanged = true;
      this.previousColor[c] = color[c];
    }
    if (colorChanged) this.revision++;
    let count = 0;
    for (let si = 0; si < this.pose.shown.length; si++) {
      const ai = this.pose.shown[si];
      const template = ai < 0 ? null : this.templates[ai];
      if (!template || !this.model.active[this.model.slots[si].bone]) continue;
      const offset = si * 4;
      const colour = this.colours[ai];
      for (let c = 0; c < 4; c++) this.tint[offset + c] = this.pose.light[offset + c] * colour[c] * color[c];
      if (!draws(template.slot)) continue;
      this.order[count] = ai;
      this.renderFrame.order[count++] = template;
    }
    this.renderFrame.order.length = count;
    this.drawn = count;
    this.epoch = generation;
  }

  snapshot(draws?: (slot: string) => boolean): PosedFrame {
    const selected: PosedSlot[] = [];
    for (let si = 0; si < this.pose.shown.length; si++) {
      const ai = this.pose.shown[si];
      const slot = ai < 0 ? null : this.templates[ai];
      if (slot && this.model.active[this.model.slots[si].bone] && (draws === undefined || draws(slot.slot))) selected.push(slot);
    }
    const order = selected.map(slot => {
      const common = { ...slot, tint: slot.tint.slice() as [number, number, number, number] };
      return slot.kind === 'region'
        ? { ...common, kind: 'region' as const, region: slot.region, corners: slot.corners.slice(), page: slot.page, pma: slot.pma, uvs: slot.uvs }
        : { ...common, kind: 'mesh' as const, vertices: slot.vertices.slice(), page: slot.page, pma: slot.pma, uvs: slot.uvs, triangles: slot.triangles, sequence: slot.sequence };
    });
    return { order };
  }
}

/** @internal Oracle fallback keeps the same borrowed-buffer layout, without a zero-allocation claim. */
export function oracleLiveFrame(frame: PosedFrame, identities: ReadonlyMap<string, { attachment: string | null; skin: string | null }>, indices: ReadonlyMap<string, number>): LiveFrame {
  let size = 0;
  for (const slot of frame.order) size += (slot.kind === 'region' ? slot.corners : slot.vertices).length;
  const vertices = new Float64Array(size);
  const tint = new Float64Array(indices.size * 4);
  const drawOrder = new Int32Array(frame.order.length);
  let offset = 0;
  const attachments = frame.order.map((slot, index): LiveAttachment => {
    const points = slot.kind === 'region' ? slot.corners : slot.vertices;
    const slotIndex = indices.get(slot.slot);
    if (slotIndex === undefined) throw new Error(`LIVE_FRAME_SLOT: drawn slot "${slot.slot}" has no setup index`);
    vertices.set(points, offset); tint.set(slot.tint, slotIndex * 4); drawOrder[index] = index;
    const identity = identities.get(slot.slot);
    if (!identity) throw new Error(`LIVE_FRAME_IDENTITY: drawn slot "${slot.slot}" has no coherent identity`);
    const metadata: LiveAttachment = { slot: slot.slot, slotIndex, attachment: identity.attachment, skin: identity.skin, placeholder: null, kind: slot.kind,
      region: slot.kind === 'region' ? slot.region : null, page: slot.page, pma: slot.pma, blend: slot.blend, offset, count: points.length,
      uvs: slot.uvs, triangles: slot.kind === 'mesh' ? slot.triangles : [], dark: slot.dark ?? null, clip: slot.clip ?? null };
    offset += points.length;
    return metadata;
  });
  const live = { generation: frame.generation ?? 0, count: attachments.length, drawOrder, vertices, tint, attachments };
  drawings.set(live, frame);
  return live;
}
