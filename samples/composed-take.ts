import { mountComposedTake as mount, type ComposedTakeOptions as NamedTakeOptions, type MountedTake } from '../src/composed-take.js';
import type { planeOffsets } from '../src/composed-camera.js';

export { ComposedTakeError, type ComposedPlane } from '../src/composed-take.js';

type LegacyTakeOptions = Omit<NamedTakeOptions, 'planes' | 'autoSweep' | 'transitionMs' | 'pointerTurn'> & {
  slots: { background: readonly string[]; figure: readonly string[]; foreground?: readonly string[] };
  planes?: never;
  autoSweep?: never;
  transitionMs?: never;
  pointerTurn?: never;
};

export type ComposedTakeOptions = LegacyTakeOptions | (NamedTakeOptions & { slots?: never });

// Repository demos and fixtures can still mount takes with legacy slot bindings.
export const mountComposedTake = mount as {
  (root: HTMLElement, options: LegacyTakeOptions): Promise<MountedTake<ReturnType<typeof planeOffsets>>>;
  (root: HTMLElement, options: ComposedTakeOptions): Promise<MountedTake>;
};
