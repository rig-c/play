import { createAtlasRegions, drawAtlasRegion, unpackRegions, revokeRegions, type PageLayout } from '../src/DomTexture';
import type { ReadDocument } from '../src/loadModel';
import { loadRig } from './rigFrames';

/** Diagnostic equality controls: no tolerance fitted to observed deltas. */
export async function atlasNativeRoundtrip() {
  const rows = [];
  for (const rig of ['figure-packed', 'flex-packed', 'sets-packed', 'look-packed', 'turned', 'named']) {
    const assets = await loadRig(rig);
    const original = (assets.document as ReadDocument).doc.pages!;
    for (const pma of rig === 'figure-packed' ? [false, true] : [false]) {
      // A flag-only PMA control uses exactly the same input bytes on both
      // producers. The existing PMA artwork fixture is independently tested.
      const layout: readonly PageLayout[] = pma ? original.map(p => ({ ...p, pma: true })) : original;
      const urls = pma ? await unpackRegions(layout, assets.pageImages) : assets.regionImages;
      let nativeChanged = 0, roundtripChanged = 0, repeatedNativeChanged = 0;
      let alphaChanged = 0, opaqueChanged = 0, transparentChanged = 0, peak = 0, channels = 0, premultipliedPeak = 0;
      const histogram: Record<string, Record<string, number>> = { opaque: {}, translucent: {}, transparent: {} };
      const byAlpha: Record<string, number> = {};
      const overOneSamples: unknown[] = [];
      const readImage = async (url: string) => {
        const img = new Image(); img.src = url; await img.decode();
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height).data;
      };
      for (const [name, entry] of createAtlasRegions(layout, assets.pageImages)) {
        const c = document.createElement('canvas'); drawAtlasRegion(c, entry);
        const x = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        const y = await readImage(urls.get(name)!.url);
        // Same producer with exactly one additional PNG encode/decode cycle.
        const z = await readImage(c.toDataURL('image/png'));
        const repeated = document.createElement('canvas'); drawAtlasRegion(repeated, entry);
        const q = repeated.getContext('2d')!.getImageData(0, 0, repeated.width, repeated.height).data;
        if (x.length !== y.length || y.length !== z.length || z.length !== q.length) throw Error('ROUNDTRIP_DIMENSIONS');
        channels += x.length;
        for (let i = 0; i < x.length; i++) {
          const a = x[(i & ~3) + 3];
          if ((i & 3) !== 3) {
            const bucket = a === 255 ? 'opaque' : a === 0 ? 'transparent' : 'translucent';
            const key = String(y[i] - x[i]); histogram[bucket][key] = (histogram[bucket][key] ?? 0) + 1;
            const equivalent = Math.abs(x[i] - y[i]) * a / 255;
            premultipliedPeak = Math.max(premultipliedPeak, equivalent);
            if (equivalent > 1 && overOneSamples.length < 8) {
              const at = i & ~3, pixel = at / 4;
              overOneSamples.push({ region: name, pixel: [pixel % c.width, Math.floor(pixel / c.width)], channel: i & 3, direct: Array.from(x.slice(at, at + 4)), roundtrip: Array.from(z.slice(at, at + 4)), readyUrl: Array.from(y.slice(at, at + 4)), equivalent });
            }
          }
          if (y[i] !== z[i]) roundtripChanged++;
          if (x[i] !== q[i]) repeatedNativeChanged++;
          const delta = Math.abs(x[i] - y[i]);
          if (!delta) continue;
          nativeChanged++; peak = Math.max(peak, delta);
          if ((i & 3) === 3) alphaChanged++;
          else { if (a === 255) opaqueChanged++; if (a === 0) transparentChanged++; byAlpha[a] = (byAlpha[a] ?? 0) + 1; }
        }
      }
      rows.push({ rig, pma, channels, nativeChanged, roundtripChanged, repeatedNativeChanged, alphaChanged, opaqueChanged, transparentChanged, peak, premultipliedPeak, histogram, byAlpha, overOneSamples });
      if (pma) revokeRegions(urls);
    }
    assets.dispose();
  }
  const normal = [11, 22, 33, 255], edge = [...normal]; edge[0] ^= 1;
  return { rows, controls: { normalEqual: normal.every((n, i) => n === normal[i]), oneChannelDefect: normal.filter((n, i) => n !== edge[i]).length === 1 } };
}
