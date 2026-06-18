/**
 * ClearNano — Watermark Worker
 * Runs reverseAlphaBlend off the main thread.
 * Receives pixel buffers via Transferable ArrayBuffers for zero-copy transfer.
 */
self.onmessage = function (e) {
  const { id, pixels, maskPixels } = e.data;

  try {
    const data = new Uint8ClampedArray(pixels);
    const maskData = new Uint8ClampedArray(maskPixels);
    const MAX_ALPHA = 0.99;

    for (let i = 0; i < data.length; i += 4) {
      const maxChannel = Math.max(maskData[i], maskData[i + 1], maskData[i + 2]);
      let alpha = maxChannel / 255.0;
      if (alpha === 0) continue;
      alpha = Math.min(alpha, MAX_ALPHA);

      const inv = 1.0 - alpha;
      data[i]     = Math.max(0, Math.min(255, Math.round((data[i]     - alpha * 255) / inv)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round((data[i + 1] - alpha * 255) / inv)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round((data[i + 2] - alpha * 255) / inv)));
    }

    self.postMessage({ id, pixels: data.buffer }, [data.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
