function getComlink() {
  const Comlink = globalThis.Comlink;
  if (!Comlink) {
    throw new Error('Comlink is not available. Ensure lib/comlink.min.js is loaded before the app script.');
  }
  return Comlink;
}

export async function initDetector({ onReady, onError } = {}) {
  try {
    const Comlink = getComlink();
    const workerUrl = new URL('../../lib/apriltag.js', import.meta.url);
    const Apriltag = Comlink.wrap(new Worker(workerUrl));

    return await new Apriltag(
      Comlink.proxy(() => {
        onReady?.();
      }),
    );
  } catch (err) {
    console.error('Failed to initialize detector:', err);
    onError?.(err);
    return null;
  }
}
