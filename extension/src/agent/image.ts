/** JPEG resizing inside the service worker (OffscreenCanvas). No DOM, no dependencies. */

export interface Jpeg {
  /** Raw base64 (no data-URL prefix) — what the brain wants in `screenshot_b64`. */
  b64: string;
  width: number;
  height: number;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

/** Downscales a captured image so its longer side is ≤ `maxPx`, re-encoding as JPEG at `quality`. */
export async function shrinkJpeg(dataUrl: string, maxPx: number, quality: number): Promise<Jpeg> {
  const src = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(src);
  try {
    const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
    const width = Math.max(1, Math.round(bmp.width * scale));
    const height = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
    ctx.drawImage(bmp, 0, 0, width, height);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return { b64: await blobToBase64(out), width, height };
  } finally {
    bmp.close();
  }
}

export const toDataUrl = (j: Jpeg) => `data:image/jpeg;base64,${j.b64}`;
