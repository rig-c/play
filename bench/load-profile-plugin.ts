import type { Plugin } from 'vite';

/** Development-only instrumentation: never imported into the library build. */
export function loadProfilePlugin(): Plugin {
  return {
    name: 'load-profile',
    enforce: 'pre',
    transform(source, id) {
      const coreReader = id.split('?')[0].endsWith('/rig-c/src/core/index.ts');
      if (!coreReader && !id.split('?')[0].endsWith('/src/loadModel.ts')) return;
      const replacements: [string, string][] = coreReader ? [
        ['value = JSON.parse(text);', "value = __sync('core-json-parse', () => JSON.parse(text));"],
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
