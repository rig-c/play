import type { Plugin } from 'vite';

/** Development-only instrumentation: never imported into the library build. */
export function loadProfilePlugin(): Plugin {
  return {
    name: 'load-profile',
    enforce: 'pre',
    transform(source, id) {
      if (id.split('?')[0].endsWith('/src/DomRenderer.ts') && !id.includes('/base.generated/')) {
        const boundary = 'drawAtlasRegion(view.el as HTMLCanvasElement, atlas, band < 1 ? band : undefined);';
        if (source.split(boundary).length !== 2) throw new Error('LOAD_PROFILE_BOUNDARY: rigid raster');
        return source.replace(boundary, `const __rigidStart = performance.now();
        ${boundary}
        globalThis.__loadTrace?.push({ name: 'rigid-region-raster', start: __rigidStart, end: performance.now() });`);
      }
      const coreReader = id.split('?')[0].endsWith('/rig-c/src/core/index.ts');
      const textureReader = id.split('?')[0].endsWith('/src/DomTexture.ts');
      if (!coreReader && !textureReader && !id.split('?')[0].endsWith('/src/loadModel.ts')) return;
      const replacements: [string, string][] = coreReader ? [
        ['value = JSON.parse(text);', "value = __sync('core-json-parse', () => JSON.parse(text));"],
      ] : textureReader ? [
        ['unpremultiply(page, width, height);', "__sync('page-unpremultiply', () => unpremultiply(page, width, height));"],
        ['pixels = ctx.getImageData(0, 0, width, height);', "pixels = __sync('page-readback', () => ctx.getImageData(0, 0, width, height));"],
        ['const data = pixels.data;', 'const __pixelStart = performance.now();\n  const data = pixels.data;'],
        ['ctx.putImageData(pixels, 0, 0);', "__record('page-unpremultiply-loop', __pixelStart);\n  __sync('page-writeback', () => ctx.putImageData(pixels, 0, 0));"],
        ['ctx.drawImage(source, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.sw, plan.sh);', "__sync('region-draw-submit', () => ctx.drawImage(source, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.sw, plan.sh));"],
        ["const blob = await new Promise<Blob>((resolve, reject) => {\n    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');\n  });", "const blob = await __async('region-png-encode-wait', () => new Promise<Blob>((resolve, reject) => {\n    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');\n  }));"],
      ] : [
        ['readModel(text, where)', "__sync('model-read-including-parse', () => readModel(text, where))"],
        ['parsed: JSON.parse(text) as unknown', "parsed: __sync('sequence-json-parse', () => JSON.parse(text)) as unknown"],
        ['await fetchText(fetchImpl, modelUrl)', "await __async('model-fetch-body', () => fetchText(fetchImpl, modelUrl))"],
        ['await loadImage(resolvePage(page.name, modelUrl), crossOrigin)', "await __async('page-fetch-onload', () => loadImage(resolvePage(page.name, modelUrl), crossOrigin))"],
        ['await loadSets(fetchImpl, modelUrl, options.setsUrl, read.doc)', "await __async('sets-fetch-read', () => loadSets(fetchImpl, modelUrl, options.setsUrl, read.doc))"],
        ['await unpackRegions(pages, pageImages, { encoding: regions })', "await __async('region-cuts', () => unpackRegions(pages, pageImages, { encoding: regions }))"],
      ];
      for (const [from, to] of replacements) {
        if (source.split(from).length !== 2) throw new Error(`LOAD_PROFILE_BOUNDARY: expected exactly one ${from}`);
        source = source.replace(from, to);
      }
      return source + `
function __record(name, start) {
  globalThis.__loadTrace?.push({name, start, end: performance.now()});
}
function __sync(name, fn) {
  const start = performance.now();
  try { return fn(); } finally { __record(name, start); }
}
async function __async(name, fn) {
  const start = performance.now();
  try { return await fn(); } finally { __record(name, start); }
}
`;
    },
  };
}
