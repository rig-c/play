import type { LiveFrame } from './liveFrame.js';
import type { PosedFrame } from './posedFrame.js';

/** @internal Renderer association; contains no poser dependency. */
export const liveDrawings = new WeakMap<object, PosedFrame>();

/** @internal Resolve a borrowed view to its preallocated renderer facade. */
export function renderFrameOf(frame: PosedFrame | LiveFrame): PosedFrame {
  if ('order' in frame) return frame;
  // Reading the generation makes a checked stale lease fail before drawing.
  void frame.generation;
  const drawing = liveDrawings.get(frame);
  if (!drawing) throw new Error('LIVE_FRAME_SOURCE: renderer needs a liveFrame() borrowed from a player');
  return drawing;
}

