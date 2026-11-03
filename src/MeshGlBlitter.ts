/**
 * Shared offscreen WebGL rasterizer for the mesh (deform) tier.
 *
 * One module-level context serves every renderer instance: browsers cap live
 * WebGL contexts (16 on Chrome/Safari) and a page can hold many renderers, so
 * per-renderer contexts would evict each other. Per flush, every dirty mesh is
 * shelf-packed into a rect of the offscreen canvas, its triangles are drawn
 * textured (atlas page texture, premultiplied alpha), and each rect is blitted
 * onto the mesh's per-part 2d canvas with an unclipped drawImage rect copy.
 * The texture is premultiplied either by the upload or by the exporter — a
 * `pma: true` page arrives that way, so it is uploaded unconverted (textureFor).
 *
 * Why this exists: Safari antialiases canvas2d clip paths, so the standard
 * per-triangle clip+transform+drawImage mapping pays a per-triangle AA-mask
 * cost in the GPU process — invisible to in-callback JS timing, but it
 * rAF-limits heavy scenes. GL rasterizes shared triangle edges seamlessly
 * (no clip, no crack overdraw needed), and the remaining canvas2d work is a
 * plain rect blit.
 *
 * The offscreen buffer is scratch space: rects are scissor-cleared and
 * redrawn every flush and read back in the same task, so neither
 * preserveDrawingBuffer nor cross-frame content is relied on. The buffer
 * grows quantized and never shrinks, mirroring the per-part backing policy
 * (reallocating GPU surfaces per frame is a Safari killer).
 *
 * It only ever holds a size the browser granted in full. The WebGL spec lets
 * the browser hand back a drawing buffer smaller than the canvas's
 * width × height, and Chromium does once the area passes its cap (5760 ×
 * 5760 for an 8192 × 8192 request, measured): drawing and reading back
 * through the canvas's size then copies the wrong texels into every part —
 * rectangles of another part's texture, cloth cut along straight edges, on a
 * zoomed-in stage (rig-c/review#332). So a growth the browser does not grant
 * in full is undone and that area is not asked for again. A batch the granted
 * buffer cannot hold — or one past `maxSize` — is drawn in passes through it,
 * and a job larger than the buffer in tiles (see flush()); the canvas2d path
 * is the caller's for a lost context only, never for size.
 *
 * Page textures are the one thing here with a lifetime, and since this object
 * outlives every renderer they are reference-counted: a renderer retains each
 * page it queues a job for and releases them in dispose(), and the last
 * release deletes the GL texture (a later job re-uploads it). The cache is
 * keyed weakly by the page image, so a consumer that never disposes still
 * loses nothing but GPU memory — this object never pins the caller's image.
 *
 * The canvas render mode (`CanvasRenderer`) draws through the same context: a
 * `FrameJob` is a whole player's frame — every region and mesh as textured,
 * vertex-coloured triangles in draw order, with the blend mode as batch state —
 * into one rect (or tiles of one, past the grant), blitted onto that player's
 * one visible canvas, and rastered in that rect's own frame like a mesh job. It has its own
 * program (colour and optional dark attributes) so the mesh tier's program and
 * its output stay exactly what they were; both share the page textures and
 * their reference counts.
 */

import type { BlendMode } from './posedFrame.js';

// Frozen public topology remains the identity and mutation boundary. Only the
// raster loops read this private, weakly held copy; it never enters a frame.
const triangleReadSources = new WeakMap<object, ArrayLike<number>>();

/** @internal Ordinary indices for raster reads, preserving mutable inputs live. */
export function triangleReadSource(source: ArrayLike<number>): ArrayLike<number> {
  let kept = triangleReadSources.get(source);
  if (kept === undefined) {
    kept = Object.isFrozen(source) ? Array.from(source) : source;
    triangleReadSources.set(source, kept);
  }
  return kept;
}

export interface MeshBlitJob {
  /** Destination per-part canvas; the blit clears its full backing first. */
  canvas: HTMLCanvasElement;
  /** Atlas page image the mesh samples (cached as a GL texture on first use). */
  page: HTMLImageElement;
  /**
   * `page.pma` — whether the page's texels are already premultiplied, which
   * decides whether the upload premultiplies them again (see textureFor). It
   * travels with the page because it describes the page's *pixels*, and the
   * blend below wants them premultiplied exactly once.
   */
  pma: boolean;
  /** Bbox-relative vertices in CSS px, x/y interleaved (indexed via `triangles`). */
  vertices: Float64Array;
  /** Normalized page UVs aligned with `vertices`. */
  uvs: ArrayLike<number>;
  /** Triangle index list into vertex/UV pairs. */
  triangles: ArrayLike<number>;
  /** Backing-store pixels per CSS px. */
  ratio: number;
  /** Rasterized region in device px — the packed rect and the blit both use it. */
  width: number;
  height: number;
}

/**
 * One run of a frame job's triangles: a stretch of the vertex data that samples
 * one page under one blend mode — one draw call.
 */
export interface FrameRun {
  page: HTMLImageElement;
  /** `page.pma`, as for MeshBlitJob. */
  pma: boolean;
  blend: BlendMode;
  /** First vertex of the run (not float) in `FrameJob.data`. */
  first: number;
  /** Vertices in the run — three per triangle. */
  count: number;
}

/**
 * A whole frame of one player (the canvas render mode): unindexed triangles,
 * interleaved per vertex as
 * `x, y, u, v, r, g, b, a` (stride 8) or `x, y, u, v, r, g, b, a, dr, dg, db`
 * (stride 11, the two-colour form, only when the frame carries a dark colour).
 * Positions are device px relative to the job's rect, top-left origin; the
 * colour is premultiplied by its alpha and so is the dark colour. Drawn into
 * one rect of the offscreen buffer, then blitted onto `canvas` in one
 * `drawImage` — or, past the grant, tile by tile (see flushFrame).
 */
export interface FrameJob {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  data: Float32Array;
  stride: 8 | 11;
  runs: FrameRun[];
}

/**
 * Premultiplied-source blend factors per mode — the RGB pair; alpha always
 * takes ONE against the same destination factor, so a mode drawn over
 * transparency still leaves coverage behind for the blit to composite.
 */
const BLEND_FACTORS: Record<BlendMode, readonly [src: number, dst: number]> = {
  Normal: [1 /* ONE */, 0x0303 /* ONE_MINUS_SRC_ALPHA */],
  Additive: [1 /* ONE */, 1 /* ONE */],
  Multiply: [0x0306 /* DST_COLOR */, 0x0303 /* ONE_MINUS_SRC_ALPHA */],
  Screen: [1 /* ONE */, 0x0301 /* ONE_MINUS_SRC_COLOR */],
};

const FRAME_VERTEX_SHADER = `
attribute vec2 aPos;
attribute vec2 aUV;
attribute vec4 aColor;
attribute vec3 aDark;
uniform vec2 uScale;
uniform vec2 uOrigin;
varying vec2 vUV;
varying vec4 vColor;
varying vec3 vDark;
void main() {
  vec2 clip = (aPos - uOrigin) * uScale - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUV = aUV;
  vColor = aColor;
  vDark = aDark;
}`;

/*
 * Two-colour tint over a premultiplied texel t: in straight terms the texel's
 * colour c is mapped to c·light + (1 − c)·dark, with alpha t.a·light.a.
 * Premultiplying that by the output alpha gives
 * t.rgb·(light·a) + (t.a − t.rgb)·(dark·a) — which is why both vertex colours
 * arrive premultiplied. With no dark colour the dark attribute is a constant 0
 * and this is a plain premultiplied vertex-colour multiply.
 */
const FRAME_FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUV;
varying vec4 vColor;
varying vec3 vDark;
void main() {
  vec4 t = texture2D(uTex, vUV);
  gl_FragColor = vec4(t.rgb * vColor.rgb + (t.a - t.rgb) * vDark, t.a * vColor.a);
}`;

/** WebGL contexts this module has created; see glContextCount(). */
let contextsCreated = 0;

/**
 * WebGL contexts this module has created — the whole of the context-cap
 * accounting: one, however many renderers and players draw through it.
 *
 * @internal Read by the test harness; not part of the package API.
 */
export function glContextCount(): number {
  return contextsCreated;
}

const VERTEX_SHADER = `
attribute vec2 aPos;
attribute vec2 aUV;
uniform vec2 uScale;
uniform vec2 uOrigin;
varying vec2 vUV;
void main() {
  // aPos is in the job's own device px, top-left origin (matching the
  // top-left-origin drawImage read of the same rect); uOrigin is the top-left
  // of the viewport window within the job, 0 unless the job passes maxSize.
  vec2 clip = (aPos - uOrigin) * uScale - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUV = aUV;
}`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUV;
void main() {
  gl_FragColor = texture2D(uTex, vUV);
}`;

/** Gap between packed rects; blits are 1:1 unfiltered, so 1px is plenty. */
const GUTTER = 1;
/** Drawing-buffer growth quantum (device px). */
const GROW_STEP = 256;

/**
 * One rect of the offscreen buffer in one pass: a whole job, or one tile of
 * it. `tx`, `ty`, `tw`, `th` are the tile in the job's own device px (the
 * whole job for an untiled one), and `bx`, `by` its top-left in the buffer.
 */
interface Piece {
  job: number;
  tx: number;
  ty: number;
  tw: number;
  th: number;
  bx: number;
  by: number;
  pass: number;
}

/**
 * What the last flush() or flushFrame() did: its jobs, the passes it drew,
 * the pieces it drew in them, and how many of its jobs were tiled.
 *
 * @internal Read by the test harness; not part of the package API.
 */
export interface FlushStats {
  jobs: number;
  passes: number;
  pieces: number;
  tiledJobs: number;
}

/**
 * The buffer phase every piece is placed at: its top-left corner sits at
 * GUTTER modulo ALIGN in both axes, and the buffer's sides are multiples of
 * it, so a job's raster lands on the same phase of the window wherever it is
 * packed and whichever tile of it is drawn. Some rasterizers are invariant
 * under a translation of the window only by whole raster tiles. Measured on
 * one mesh job at pixel ratio 1.75, the buffer's height shifted and nothing
 * else: headless WebKit on macOS (Apple GPU) drew 7–14 pixels one level off
 * at shifts of 1, 2, 3, 4, 7, 8, 15, 16, 31 and 48 px, and identically at 32,
 * 64, 96, 128, 256 and 512; SwiftShader drew identically at every shift.
 * The phase makes macOS WebKit's dom mode exact across tilings; it does not
 * do that for WebKit on Linux, which differs on it too (tests/zoom-buffer.spec.ts
 * says where identity is held). It is kept because it costs nothing else.
 */
const ALIGN = 32;

/** The smallest position at or after `v` on the piece phase (GUTTER modulo ALIGN). */
function onPhase(v: number): number {
  return v + ((((GUTTER - v) % ALIGN) + ALIGN) % ALIGN);
}

/**
 * Shelf-packs pieces, tallest first, into a `bufW`-wide buffer, starting a
 * new pass when a piece would cross `bufH`. Every piece must fit the buffer
 * with its gutter. Sets each piece's position and pass, and returns the
 * height the packing needs (the last pass's, when there are several).
 */
function shelfPack(pieces: Piece[], bufW: number, bufH: number): number {
  // Array.prototype.sort is stable, so equal heights keep job and tile order.
  const order = pieces.slice().sort((a, b) => b.th - a.th);
  let pass = 0;
  let shelfX = GUTTER;
  let shelfY = GUTTER;
  let shelfH = 0;
  let height = GUTTER;
  for (const piece of order) {
    if (shelfX + piece.tw + GUTTER > bufW) {
      shelfY = onPhase(shelfY + shelfH + GUTTER);
      shelfX = GUTTER;
      shelfH = 0;
    }
    if (shelfY + piece.th + GUTTER > bufH) {
      pass++;
      shelfX = GUTTER;
      shelfY = GUTTER;
      shelfH = 0;
      height = GUTTER;
    }
    piece.bx = shelfX;
    piece.by = shelfY;
    piece.pass = pass;
    shelfX = onPhase(shelfX + piece.tw + GUTTER);
    if (piece.th > shelfH) shelfH = piece.th;
    if (shelfY + piece.th + GUTTER > height) height = shelfY + piece.th + GUTTER;
  }
  return height;
}

/** Cache entry for one atlas page: the upload, and how many renderers want it. */
interface PageTexture {
  /** Uploaded lazily, on the first flush that binds this page. */
  texture: WebGLTexture | null;
  /** Live retain() calls outstanding — one per renderer drawing this page. */
  users: number;
  /** The alpha convention `texture` was uploaded under; meaningless without it. */
  pma: boolean;
}

class MeshGlBlitter {
  lost = false;
  /**
   * Page textures created minus deleted, i.e. how many uploads are live right
   * now. Deterministic (no GC in the path), which is what the lifetime tests
   * assert against — see tests/gl-textures.spec.ts.
   */
  liveTextureCount = 0;

  private readonly canvas = document.createElement('canvas');
  private readonly gl: WebGLRenderingContext;
  private readonly uScale: WebGLUniformLocation;
  private readonly uOrigin: WebGLUniformLocation;
  private readonly meshProgram: WebGLProgram;
  private readonly meshPos: number;
  private readonly meshUV: number;
  private readonly frameProgram: WebGLProgram;
  private readonly frameScale: WebGLUniformLocation;
  private readonly frameOrigin: WebGLUniformLocation;
  private readonly framePos: number;
  private readonly frameUV: number;
  private readonly frameColor: number;
  private readonly frameDark: number;
  /** Which program's attribute layout is bound — each flush binds its own. */
  private bound: 'mesh' | 'frame' | null = null;
  /**
   * Weak by the page image on purpose: a consumer that forgets dispose()
   * leaks its texture until context loss, but dropping the image still lets
   * the image (and then the WebGLTexture this entry holds) be collected.
   * Reassigned wholesale on context loss, never iterated.
   */
  private textures = new WeakMap<HTMLImageElement, PageTexture>();
  private readonly maxSize: number;
  /**
   * The smallest drawing-buffer area the browser has refused to grant in full
   * (see the module comment); a growth to this area or more is not attempted.
   */
  private refusedArea = Number.POSITIVE_INFINITY;
  /** Test-only caps on the grant, and the tiling plant — see limitForTesting(). */
  private testArea = Number.POSITIVE_INFINITY;
  private testWidth = Number.POSITIVE_INFINITY;
  private testHeight = Number.POSITIVE_INFINITY;
  private tiling = true;
  /**
   * What the last flush() or flushFrame() did.
   *
   * @internal Read by the test harness; not part of the package API.
   */
  stats: FlushStats = { jobs: 0, passes: 0, pieces: 0, tiledJobs: 0 };
  private vertexData = new Float32Array(8192);
  /** Per-job packed rect origins (a tiled job's first tile), filled by flush(). */
  private packX: number[] = [];
  private packY: number[] = [];

  constructor() {
    const gl = this.canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL unavailable');
    contextsCreated++;
    this.gl = gl;
    // No restore attempt: on loss the renderer falls back to canvas2d and the
    // backend signature re-dirties every mesh, so frames stay complete.
    this.canvas.addEventListener('webglcontextlost', () => {
      this.markLost();
    });

    const program = this.link(VERTEX_SHADER, FRAGMENT_SHADER);
    this.meshProgram = program;
    gl.useProgram(program);
    const uScale = gl.getUniformLocation(program, 'uScale');
    const uOrigin = gl.getUniformLocation(program, 'uOrigin');
    if (!uScale || !uOrigin) throw new Error('mesh program uniforms not found');
    this.uScale = uScale;
    this.uOrigin = uOrigin;
    gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0);
    this.meshPos = gl.getAttribLocation(program, 'aPos');
    this.meshUV = gl.getAttribLocation(program, 'aUV');

    const frame = this.link(FRAME_VERTEX_SHADER, FRAME_FRAGMENT_SHADER);
    this.frameProgram = frame;
    gl.useProgram(frame);
    const frameScale = gl.getUniformLocation(frame, 'uScale');
    const frameOrigin = gl.getUniformLocation(frame, 'uOrigin');
    if (!frameScale || !frameOrigin) throw new Error('frame program uniforms not found');
    this.frameScale = frameScale;
    this.frameOrigin = frameOrigin;
    gl.uniform1i(gl.getUniformLocation(frame, 'uTex'), 0);
    this.framePos = gl.getAttribLocation(frame, 'aPos');
    this.frameUV = gl.getAttribLocation(frame, 'aUV');
    this.frameColor = gl.getAttribLocation(frame, 'aColor');
    this.frameDark = gl.getAttribLocation(frame, 'aDark');

    // One dynamic buffer for both programs; each flush binds its own layout
    // (bindMesh / bindFrame), so neither sees the other's attribute state.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.enable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    // No larger than MAX_VIEWPORT_DIMS, so that a job's window up to maxSize
    // is one viewport (see placePiece), and on the ALIGN grid, so that a
    // window's corner keeps the piece phase.
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;
    const side = Math.min((gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number) || 4096, 8192, viewport?.[0] || 4096, viewport?.[1] || 4096);
    this.maxSize = Math.floor(side / ALIGN) * ALIGN;
  }

  /**
   * Rasterizes every job and blits it onto its per-part canvas. Returns false
   * only when the context is lost, so that the caller draws the batch on its
   * canvas2d path; a batch's size never sends it there.
   *
   * A batch that fits one buffer is one pass, shelf-packed as it always was.
   * One that does not — a zoomed-in stage asks for more than the browser
   * grants, or for more than `maxSize` — is drawn in passes through the
   * largest buffer the browser grants in full: its pieces are shelf-packed
   * into that buffer, a pass is drawn and blitted, and the next pass reuses
   * the buffer. A piece is a whole job, or one tile of a job larger than the
   * buffer.
   *
   * Every piece is rastered in its own job's rect (#187): the vertex upload is
   * relative to the job and nothing else, and the viewport is the job's rect
   * wherever the piece sits. A tile is the same viewport moved so that the
   * tile lands in the buffer, scissored to the tile and blitted into the
   * matching sub-rect of the part canvas — so a pixel does not depend on how
   * its job was packed, which pass drew it, or how it was tiled.
   */
  flush(jobs: MeshBlitJob[]): boolean {
    const gl = this.gl;
    this.stats = { jobs: jobs.length, passes: 0, pieces: 0, tiledJobs: 0 };
    if (this.lost || gl.isContextLost()) return false;

    // One pass if the buffer holds the whole batch: every job whole, shelf-packed.
    let width = Math.max(512, this.canvas.width);
    for (const job of jobs) width = Math.max(width, job.width + GUTTER * 2);
    let pieces: Piece[] = jobs.map((job, i) => ({ job: i, tx: 0, ty: 0, tw: job.width, th: job.height, bx: 0, by: 0, pass: 0 }));
    const height = shelfPack(pieces, width, Number.POSITIVE_INFINITY);
    if (!this.reserve(width, height)) {
      if (!this.acquire(width, height)) return false;
      const planned = this.plan(jobs, this.canvas.width, this.canvas.height);
      if (!planned) return false;
      pieces = planned;
    }
    // Where each job's first piece went, for whoever reads the packing.
    const packX = (this.packX = new Array<number>(jobs.length));
    const packY = (this.packY = new Array<number>(jobs.length));
    for (let k = pieces.length - 1; k >= 0; k--) {
      packX[pieces[k].job] = pieces[k].bx;
      packY[pieces[k].job] = pieces[k].by;
    }
    this.bindMesh();

    // Build one interleaved vertex array for the whole batch (unindexed —
    // meshes are a few hundred triangles, expansion is cheaper than managing
    // index buffers), in each job's own device px: no pack offset is folded
    // in, so the Float32 a vertex is rounded to is the job's alone.
    let floats = 0;
    for (const job of jobs) floats += job.triangles.length * 4;
    if (this.vertexData.length < floats) {
      this.vertexData = new Float32Array(1 << Math.ceil(Math.log2(floats)));
    }
    const data = this.vertexData;
    const firsts = new Array<number>(jobs.length);
    let f = 0;
    for (let i = 0; i < jobs.length; i++) {
      const { vertices, uvs, ratio } = jobs[i];
      const triangles = triangleReadSource(jobs[i].triangles);
      firsts[i] = f / 4;
      for (let t = 0; t < triangles.length; t++) {
        const vi = triangles[t] * 2;
        data[f++] = vertices[vi] * ratio;
        data[f++] = vertices[vi + 1] * ratio;
        data[f++] = uvs[vi];
        data[f++] = uvs[vi + 1];
      }
    }
    if (floats > 0) gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, floats), gl.DYNAMIC_DRAW);

    const cleared = new Uint8Array(jobs.length);
    const bufH = this.canvas.height;
    let start = 0;
    while (start < pieces.length) {
      const pass = pieces[start].pass;
      let end = start;
      while (end < pieces.length && pieces[end].pass === pass) end++;

      let boundPage: HTMLImageElement | null = null;
      for (let k = start; k < end; k++) {
        const piece = pieces[k];
        const job = jobs[piece.job];
        if (job.page !== boundPage) {
          gl.bindTexture(gl.TEXTURE_2D, this.textureFor(job.page, job.pma));
          boundPage = job.page;
        }
        this.placePiece(piece, job.width, job.height, bufH, this.uScale, this.uOrigin);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, firsts[piece.job], job.triangles.length);
      }

      // If the context died mid-batch the draws above were no-ops; report it
      // before blitting stale/blank rects onto the part canvases.
      if (gl.isContextLost()) {
        this.markLost();
        return false;
      }

      // Blit each piece onto its per-part canvas: same-task read (no
      // preserveDrawingBuffer needed), 1:1 device px (no filtering).
      for (let k = start; k < end; k++) {
        const piece = pieces[k];
        const job = jobs[piece.job];
        const ctx = job.canvas.getContext('2d');
        if (!ctx) continue;
        if (!cleared[piece.job]) {
          cleared[piece.job] = 1;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          // Clear the full backing: the previous raster may have been larger.
          ctx.clearRect(0, 0, job.canvas.width, job.canvas.height);
        }
        if (piece.tw > 0 && piece.th > 0) {
          ctx.drawImage(this.canvas, piece.bx, piece.by, piece.tw, piece.th, piece.tx, piece.ty, piece.tw, piece.th);
        }
      }
      this.stats.passes++;
      start = end;
    }
    this.stats.pieces = pieces.length;
    // A job that drew no piece (none on a context it could get) is still cleared.
    for (let i = 0; i < jobs.length; i++) {
      if (cleared[i]) continue;
      const ctx = jobs[i].canvas.getContext('2d');
      if (!ctx) continue;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, jobs[i].canvas.width, jobs[i].canvas.height);
    }
    return true;
  }

  /**
   * Sets the viewport, the two uniforms and the scissor for one piece. The
   * viewport is the job's own rect — or, for a job wider or taller than
   * `maxSize`, the `maxSize` window of it that holds the piece, since a
   * viewport cannot be larger — placed so that the piece's sub-rect lands on
   * the piece's rect of the buffer; the scissor is that rect. Scissor and
   * viewport are bottom-left origin; pieces are placed top-left.
   *
   * The clip-space mapping is `(p - origin) * scale - 1` with `scale` the
   * window's 2 / size, a function of the job and the window alone. Written as
   * `(p - origin) / size * 2 - 1` instead, SwiftShader drew the canvas mode's
   * 6,901 px frame differently in two tilings (51,537 pixels); this form drew
   * them identically, and the mesh tier identically either way.
   */
  private placePiece(piece: Piece, width: number, height: number, bufH: number, scale: WebGLUniformLocation, origin: WebGLUniformLocation): void {
    const gl = this.gl;
    const wx = piece.tx - (piece.tx % this.maxSize);
    const wy = piece.ty - (piece.ty % this.maxSize);
    const ww = Math.min(this.maxSize, width - wx);
    const wh = Math.min(this.maxSize, height - wy);
    // The job's top-left corner in buffer px: off the buffer for a tile past its first.
    const left = piece.bx - piece.tx;
    const top = piece.by - piece.ty;
    gl.viewport(left + wx, bufH - (top + wy) - wh, ww, wh);
    gl.uniform2f(scale, 2 / ww, 2 / wh);
    gl.uniform2f(origin, wx, wy);
    gl.scissor(piece.bx, bufH - piece.by - piece.th, piece.tw, piece.th);
  }

  /**
   * Cuts each rect into pieces that fit a `bufW` × `bufH` buffer with its
   * gutter — a rect that fits is one piece, a larger one is tiled, tiles never
   * crossing a `maxSize` window — and shelf-packs them, tallest first, into
   * consecutive passes of that buffer. A tile starts on the `ALIGN` grid of
   * its job, so its job's corner keeps the buffer phase every piece has.
   * Returns the pieces in pass order, or null when a rect needs tiling and
   * tiling is off (a test-only plant) or the buffer is too small to tile.
   */
  private plan(rects: ArrayLike<{ width: number; height: number }>, bufW: number, bufH: number): Piece[] | null {
    const tileW = Math.floor((bufW - GUTTER * 2) / ALIGN) * ALIGN;
    const tileH = Math.floor((bufH - GUTTER * 2) / ALIGN) * ALIGN;
    const max = this.maxSize;
    const pieces: Piece[] = [];
    for (let i = 0; i < rects.length; i++) {
      const { width, height } = rects[i];
      if (width + GUTTER * 2 <= bufW && height + GUTTER * 2 <= bufH && width <= max && height <= max) {
        pieces.push({ job: i, tx: 0, ty: 0, tw: width, th: height, bx: 0, by: 0, pass: 0 });
        continue;
      }
      if (!this.tiling || tileW <= 0 || tileH <= 0) return null;
      this.stats.tiledJobs++;
      for (let wy = 0; wy < height; wy += max) {
        const wh = Math.min(max, height - wy);
        for (let wx = 0; wx < width; wx += max) {
          const ww = Math.min(max, width - wx);
          for (let ty = wy; ty < wy + wh; ty += tileH) {
            for (let tx = wx; tx < wx + ww; tx += tileW) {
              pieces.push({ job: i, tx, ty, tw: Math.min(tileW, wx + ww - tx), th: Math.min(tileH, wy + wh - ty), bx: 0, by: 0, pass: 0 });
            }
          }
        }
      }
    }
    shelfPack(pieces, bufW, bufH);
    // Stable: a pass keeps the packing's tallest-first order.
    return pieces.sort((a, b) => a.pass - b.pass);
  }

  /** The buffer sides this module will use: `maxSize`, or a test cap below it. */
  private get limitW(): number {
    return Math.floor(Math.min(this.maxSize, this.testWidth) / ALIGN) * ALIGN;
  }

  private get limitH(): number {
    return Math.floor(Math.min(this.maxSize, this.testHeight) / ALIGN) * ALIGN;
  }

  /**
   * Makes the drawing buffer hold at least `width` × `height`, growing it
   * grow-only and quantized, and returns whether it does — as granted, not as
   * asked. A growth the browser grants only in part is undone (the previous
   * size was granted in full) and its area remembered, so a zoom held past
   * the cap declines each frame without reallocating the buffer twice per
   * frame. Resizing clears the buffer, which is fine: every rect is cleared
   * and redrawn anyway.
   */
  private reserve(width: number, height: number): boolean {
    const canvas = this.canvas;
    const gl = this.gl;
    const limitW = this.limitW;
    const limitH = this.limitH;
    if (width > limitW || height > limitH) return false;
    if (width > canvas.width || height > canvas.height) {
      const w = Math.min(limitW, Math.ceil(Math.max(width, canvas.width) / GROW_STEP) * GROW_STEP);
      const h = Math.min(limitH, Math.ceil(Math.max(height, canvas.height) / GROW_STEP) * GROW_STEP);
      if (w * h >= this.refusedArea) return false;
      if (w * h > this.testArea) {
        // The test cap stands for a browser that grants less than this.
        this.refusedArea = w * h;
        return false;
      }
      const previousW = canvas.width;
      const previousH = canvas.height;
      canvas.width = w;
      canvas.height = h;
      if (gl.drawingBufferWidth < w || gl.drawingBufferHeight < h) {
        this.refusedArea = Math.min(this.refusedArea, w * h);
        canvas.width = previousW;
        canvas.height = previousH;
        return false;
      }
    }
    // Held on every flush, not only after a resize: a canvas whose buffer is
    // smaller than itself is exactly the state that draws the wrong texels.
    return gl.drawingBufferWidth === canvas.width && gl.drawingBufferHeight === canvas.height;
  }

  /**
   * Grows the buffer toward `width` × `height` as far as the browser grants
   * in full, for a batch that one buffer cannot hold. The request is shrunk a
   * quantum at a time, larger side first, never below the buffer already
   * held, past every area the browser has refused; each refusal lowers that
   * area, so the search ends — at worst on the buffer already held. Returns
   * false only when even that is not granted in full.
   */
  private acquire(width: number, height: number): boolean {
    const canvas = this.canvas;
    let w = Math.max(canvas.width, Math.min(this.limitW, Math.ceil(width / GROW_STEP) * GROW_STEP));
    let h = Math.max(canvas.height, Math.min(this.limitH, Math.ceil(height / GROW_STEP) * GROW_STEP));
    for (;;) {
      const held = w <= canvas.width && h <= canvas.height;
      if (held || w * h < this.refusedArea) {
        if (this.reserve(w, h)) return true;
        if (held) return false;
      }
      if (w >= h && w - GROW_STEP >= canvas.width) w -= GROW_STEP;
      else if (h - GROW_STEP >= canvas.height) h -= GROW_STEP;
      else if (w - GROW_STEP >= canvas.width) w -= GROW_STEP;
      else {
        w = canvas.width;
        h = canvas.height;
      }
    }
  }

  /**
   * Test-only limits: `area` caps the drawing-buffer area this module will
   * take as granted (a browser that grants less), `width` and `height` cap
   * its sides below `maxSize`, and `tiling: false` is the planted control that declines a job
   * larger than the buffer instead of tiling it. Setting limits drops the
   * buffer held so far, so they hold from the next flush; null lifts them.
   * Viewport windows stay `maxSize`: the caps stand for a smaller grant, not
   * a different GPU.
   *
   * @internal Read by the test harness; not part of the package API.
   */
  limitForTesting(limits: { area?: number; width?: number; height?: number; tiling?: boolean } | null): void {
    this.testArea = limits?.area ?? Number.POSITIVE_INFINITY;
    this.testWidth = limits?.width ?? Number.POSITIVE_INFINITY;
    this.testHeight = limits?.height ?? Number.POSITIVE_INFINITY;
    this.tiling = limits?.tiling ?? true;
    this.refusedArea = Number.POSITIVE_INFINITY;
    if (limits) {
      this.canvas.width = 1;
      this.canvas.height = 1;
    }
  }

  /**
   * Draws one player's frame (the canvas render mode) and blits it onto
   * `job.canvas`, whose full backing is cleared first. Returns false only when
   * the context is lost, so the caller draws the frame on its canvas2d
   * fallback. The frame is one job: drawn into one rect when the buffer holds
   * it, otherwise tiled through passes exactly as flush() tiles a mesh, every
   * tile re-issuing the frame's runs under its own scissor.
   */
  flushFrame(job: FrameJob): boolean {
    const gl = this.gl;
    this.stats = { jobs: 1, passes: 0, pieces: 0, tiledJobs: 0 };
    if (this.lost || gl.isContextLost()) return false;
    let pieces: Piece[];
    if (this.reserve(job.width + GUTTER * 2, job.height + GUTTER * 2)) {
      pieces = [{ job: 0, tx: 0, ty: 0, tw: job.width, th: job.height, bx: GUTTER, by: GUTTER, pass: 0 }];
    } else {
      if (!this.acquire(job.width + GUTTER * 2, job.height + GUTTER * 2)) return false;
      const planned = this.plan([job], this.canvas.width, this.canvas.height);
      if (!planned) return false;
      pieces = planned;
    }
    const bufH = this.canvas.height;
    this.bindFrame(job.stride);

    let vertices = 0;
    for (const run of job.runs) vertices = Math.max(vertices, run.first + run.count);
    if (vertices > 0) gl.bufferData(gl.ARRAY_BUFFER, job.data.subarray(0, vertices * job.stride), gl.DYNAMIC_DRAW);

    const ctx = job.canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    let cleared = false;
    let boundPage: HTMLImageElement | null = null;
    let boundBlend: BlendMode | null = null;
    let start = 0;
    while (start < pieces.length) {
      const pass = pieces[start].pass;
      let end = start;
      while (end < pieces.length && pieces[end].pass === pass) end++;
      for (let k = start; k < end; k++) {
        this.placePiece(pieces[k], job.width, job.height, bufH, this.frameScale, this.frameOrigin);
        gl.clear(gl.COLOR_BUFFER_BIT);
        for (const run of job.runs) {
          if (run.page !== boundPage) {
            gl.bindTexture(gl.TEXTURE_2D, this.textureFor(run.page, run.pma));
            boundPage = run.page;
          }
          if (run.blend !== boundBlend) {
            const [src, dst] = BLEND_FACTORS[run.blend];
            gl.blendFuncSeparate(src, dst, gl.ONE, dst);
            boundBlend = run.blend;
          }
          gl.drawArrays(gl.TRIANGLES, run.first, run.count);
        }
      }
      if (gl.isContextLost()) {
        this.markLost();
        return false;
      }
      // Same-task read, 1:1 device px.
      if (ctx) {
        if (!cleared) {
          cleared = true;
          ctx.clearRect(0, 0, job.canvas.width, job.canvas.height);
        }
        for (let k = start; k < end; k++) {
          const piece = pieces[k];
          if (piece.tw > 0 && piece.th > 0) {
            ctx.drawImage(this.canvas, piece.bx, piece.by, piece.tw, piece.th, piece.tx, piece.ty, piece.tw, piece.th);
          }
        }
      }
      this.stats.passes++;
      start = end;
    }
    this.stats.pieces = pieces.length;
    if (ctx && !cleared) ctx.clearRect(0, 0, job.canvas.width, job.canvas.height);
    return true;
  }

  /** The mesh tier's layout, [x, y, u, v], and its premultiplied source-over. */
  private bindMesh(): void {
    const gl = this.gl;
    if (this.bound !== 'mesh') {
      gl.useProgram(this.meshProgram);
      this.disableAttributes();
      gl.enableVertexAttribArray(this.meshPos);
      gl.enableVertexAttribArray(this.meshUV);
      gl.vertexAttribPointer(this.meshPos, 2, gl.FLOAT, false, 16, 0);
      gl.vertexAttribPointer(this.meshUV, 2, gl.FLOAT, false, 16, 8);
      this.bound = 'mesh';
    }
    // Premultiplied source-over, matching canvas2d triangle compositing. Set on
    // every mesh flush: a frame job in between leaves its last blend behind.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** The frame layout: [x, y, u, v, r, g, b, a], and [dr, dg, db] at stride 11. */
  private bindFrame(stride: 8 | 11): void {
    const gl = this.gl;
    gl.useProgram(this.frameProgram);
    this.disableAttributes();
    const bytes = stride * 4;
    gl.enableVertexAttribArray(this.framePos);
    gl.enableVertexAttribArray(this.frameUV);
    gl.enableVertexAttribArray(this.frameColor);
    gl.vertexAttribPointer(this.framePos, 2, gl.FLOAT, false, bytes, 0);
    gl.vertexAttribPointer(this.frameUV, 2, gl.FLOAT, false, bytes, 8);
    gl.vertexAttribPointer(this.frameColor, 4, gl.FLOAT, false, bytes, 16);
    if (stride === 11) {
      gl.enableVertexAttribArray(this.frameDark);
      gl.vertexAttribPointer(this.frameDark, 3, gl.FLOAT, false, bytes, 32);
    } else {
      // No slot carries a dark colour: a constant zero, which reduces the
      // two-colour form to the plain colour multiply.
      gl.vertexAttrib3f(this.frameDark, 0, 0, 0);
    }
    this.bound = 'frame';
  }

  private disableAttributes(): void {
    const gl = this.gl;
    for (const location of [this.meshPos, this.meshUV, this.framePos, this.frameUV, this.frameColor, this.frameDark]) {
      if (location >= 0) gl.disableVertexAttribArray(location);
    }
  }

  private link(vertex: string, fragment: string): WebGLProgram {
    const gl = this.gl;
    const program = gl.createProgram();
    if (!program) throw new Error('createProgram failed');
    gl.attachShader(program, this.compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, this.compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
  }

  /**
   * Declares one more user of `page`. The upload itself stays lazy (the first
   * flush that binds the page does it) — this only counts, so that the last
   * release() can free the texture instead of the module holding it forever.
   * Callers retain once per page and hand the same page back exactly once;
   * DomRenderer and CanvasRenderer each keep that ledger and settle it in dispose().
   */
  retain(page: HTMLImageElement): void {
    const entry = this.textures.get(page);
    if (entry) entry.users++;
    else this.textures.set(page, { texture: null, users: 1, pma: false });
  }

  /**
   * Gives back one retain(). The GL texture goes when the last user of the
   * page is gone; a later job for the same page simply uploads it again. A
   * page the cache does not know (a release after a context loss dropped
   * everything, or a double dispose) is a no-op, so this is safe to call
   * unconditionally.
   */
  release(page: HTMLImageElement): void {
    const entry = this.textures.get(page);
    if (!entry) return;
    if (--entry.users > 0) return;
    this.textures.delete(page);
    if (!entry.texture) return;
    // deleteTexture is a documented no-op on a lost context rather than a
    // throw, but a lost context has already dropped the cache and zeroed the
    // count — reaching here with `lost` set would mean decrementing twice.
    if (!this.lost && !this.gl.isContextLost()) this.gl.deleteTexture(entry.texture);
    this.liveTextureCount--;
  }

  /**
   * Context loss invalidates every texture handle at once. Drop the cache and
   * the count instead of carrying dead handles (deleting them is pointless —
   * the GPU side is already gone) and let the next frames re-upload if the
   * caller keeps drawing; the renderer meanwhile falls back to canvas2d.
   */
  private markLost(): void {
    this.lost = true;
    this.textures = new WeakMap();
    this.liveTextureCount = 0;
  }

  private compile(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error('createShader failed');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  }

  /**
   * The page's GL texture, uploaded on demand.
   *
   * `pma` is a property of the page's *pixels*, so one image cannot honestly be
   * both: two atlases naming the same image with different `pma:` lines are not
   * a mixed page, one of them is simply wrong about the file. The cache is keyed
   * by the image, so rather than trusting that, a flag that disagrees with the
   * live upload re-uploads under the new one — the pathological case stays
   * correct (at the price of re-uploading while it lasts) instead of silently
   * drawing one of the two atlases wrong.
   */
  private textureFor(page: HTMLImageElement, pma: boolean): WebGLTexture {
    let entry = this.textures.get(page);
    if (entry?.texture) {
      if (entry.pma === pma) return entry.texture;
      this.gl.deleteTexture(entry.texture);
      entry.texture = null;
      this.liveTextureCount--;
    }
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Premultiply at upload so blending and the premultiplied canvas agree —
    // unless the page is already premultiplied (`pma: true`), where doing it
    // again is the second multiply that darkens every semi-transparent texel
    // (#37). The blend below is premultiplied source-over either way, so a pma
    // page is simply uploaded as it is: no conversion, nothing lost.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, pma ? 0 : 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, page);
    // Linear, no mips, clamped — NPOT-safe in WebGL1.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (!entry) {
      // Nobody retained this page — not a path this package takes, since the
      // renderer retains as it queues each job. Cache it anyway so the batch
      // does not re-upload per flush; with no users only a context loss (or
      // the image being collected, which takes the weak entry with it) clears
      // it, which is exactly the old behavior for a caller that opts out.
      entry = { texture: null, users: 0, pma };
      this.textures.set(page, entry);
    }
    entry.pma = pma;
    entry.texture = texture;
    this.liveTextureCount++;
    return texture;
  }
}

let shared: MeshGlBlitter | null | undefined;

/**
 * The module-level blitter, created on first use. Returns null when WebGL is
 * unavailable or the shared context has been lost — callers then stay on the
 * canvas2d path.
 */
export function getMeshGlBlitter(): MeshGlBlitter | null {
  if (shared === undefined) {
    try {
      shared = new MeshGlBlitter();
    } catch {
      shared = null;
    }
  }
  return shared && !shared.lost ? shared : null;
}
