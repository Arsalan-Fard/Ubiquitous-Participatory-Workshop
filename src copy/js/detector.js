function getComlink() {
  var Comlink = globalThis.Comlink;
  if (Comlink === undefined || Comlink === null) {
    throw new Error('Comlink is not available. Ensure lib/comlink.min.js is loaded before the app script.');
  }
  return Comlink;
}

export async function initDetector(options) {
  options = options || {};
  var onReady = options.onReady;
  var onError = options.onError;

  try {
    var Comlink = getComlink();
    var workerUrl = new URL('../../lib/apriltag.js', import.meta.url);
    var Apriltag = Comlink.wrap(new Worker(workerUrl));

    return await new Apriltag(
      Comlink.proxy(function () {
        if (onReady) onReady();
      })
    );
  } catch (err) {
    console.error('Failed to initialize detector:', err);
    if (onError) onError(err);
    return null;
  }
}
