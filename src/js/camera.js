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

/**
 * Start a camera stream by specific device ID.
 * Useful for multi-camera setups where you need to target a specific camera.
 *
 * @param {HTMLVideoElement} videoEl - The video element to attach the stream to
 * @param {string} deviceId - The device ID of the camera to use
 * @param {Object} [options] - Optional constraints
 * @param {number} [options.width] - Preferred width (default: 640)
 * @param {number} [options.height] - Preferred height (default: 480)
 * @returns {Promise<MediaStream>} - The camera stream
 */
export async function startCameraById(videoEl, deviceId, options) {
  options = options || {};
  var width = options.width || 640;
  var height = options.height || 480;

  var constraints = {
    video: {
      deviceId: { exact: deviceId },
      width: { ideal: width },
      height: { ideal: height }
    },
    audio: false
  };

  var stream = await navigator.mediaDevices.getUserMedia(constraints);
  videoEl.srcObject = stream;
  return stream;
}
