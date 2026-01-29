export async function startCameraStream(videoEl, constraints) {
  var stream = await navigator.mediaDevices.getUserMedia(constraints);
  videoEl.srcObject = stream;
  return stream;
}

export function stopCameraStream(stream) {
  if (!stream) return;
  var tracks = stream.getTracks();
  for (var i = 0; i < tracks.length; i++) {
    tracks[i].stop();
  }
}

export function waitForVideoMetadata(videoEl) {
  if (videoEl.readyState >= 1 && videoEl.videoWidth && videoEl.videoHeight) return Promise.resolve();

  return new Promise(function (resolve) {
    function handler() {
      videoEl.removeEventListener('loadedmetadata', handler);
      resolve();
    }
    videoEl.addEventListener('loadedmetadata', handler, { once: true });
  });
}
