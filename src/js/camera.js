export async function startCameraStream(videoEl, constraints) {
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  videoEl.srcObject = stream;
  return stream;
}

export function stopCameraStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
}

export function waitForVideoMetadata(videoEl) {
  if (videoEl.readyState >= 1 && videoEl.videoWidth && videoEl.videoHeight) return Promise.resolve();

  return new Promise((resolve) => {
    const handler = () => {
      videoEl.removeEventListener('loadedmetadata', handler);
      resolve();
    };
    videoEl.addEventListener('loadedmetadata', handler, { once: true });
  });
}
