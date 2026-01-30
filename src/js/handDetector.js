// Track all detector instances for message routing
var detectorInstances = {};
var instanceCounter = 0;

/**
 * Initialize hand detector using MediaPipe in an isolated iframe.
 * The iframe is positioned over the video to display hand skeleton.
 *
 * Supports multiple instances via the instanceId option for dual-camera setups.
 *
 * @param {Object} options
 * @param {Function} [options.onReady] - Callback when detector is ready
 * @param {Function} [options.onError] - Callback on error
 * @param {HTMLElement} [options.videoContainer] - Container to append iframe to
 * @param {string} [options.instanceId] - Unique ID for this detector instance (auto-generated if not provided)
 * @returns {Promise<{detect: Function, instanceId: string, destroy: Function}|null>}
 */
export async function initHandDetector(options) {
  options = options || {};
  var onReady = options.onReady;
  var onError = options.onError;
  var videoContainer = options.videoContainer;
  var instanceId = options.instanceId || 'detector_' + (instanceCounter++);

  return new Promise(function (resolve) {
    var iframe = document.createElement('iframe');
    iframe.style.position = 'absolute';
    iframe.style.top = '0';
    iframe.style.left = '0';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    iframe.style.pointerEvents = 'none';
    iframe.style.zIndex = '20';
    iframe.style.background = 'transparent';
    iframe.setAttribute('allowtransparency', 'true');
    iframe.setAttribute('data-instance-id', instanceId);
    iframe.src = new URL('../../lib/hand-iframe.html', import.meta.url).href;

    // Append to video container if provided, otherwise body
    var container = videoContainer || document.body;
    container.appendChild(iframe);

    var requestId = 0;
    var pendingRequests = {};

    // Message handler specific to this instance
    function messageHandler(event) {
      if (event.source !== iframe.contentWindow) return;

      if (event.data.type === 'ready') {
        if (onReady) onReady();

        var detector = {
          instanceId: instanceId,
          detect: function (imageData, width, height) {
            return new Promise(function (resolveDetect) {
              var id = requestId++;
              pendingRequests[id] = resolveDetect;

              // Create a copy of the buffer to transfer (transfer detaches the original)
              var buffer = new Uint8ClampedArray(imageData).buffer;

              iframe.contentWindow.postMessage(
                {
                  type: 'detect',
                  imageData: buffer,
                  width: width,
                  height: height,
                  requestId: id
                },
                '*',
                [buffer]
              ); // Transfer the ArrayBuffer
            });
          },
          destroy: function () {
            window.removeEventListener('message', messageHandler);
            if (iframe.parentNode) {
              iframe.parentNode.removeChild(iframe);
            }
            delete detectorInstances[instanceId];
          }
        };

        detectorInstances[instanceId] = detector;
        resolve(detector);
      } else if (event.data.type === 'result') {
        var resolveDetect = pendingRequests[event.data.requestId];
        if (resolveDetect) {
          delete pendingRequests[event.data.requestId];
          resolveDetect(event.data.hands);
        }
      } else if (event.data.type === 'error') {
        console.error('Hand detector error (' + instanceId + '):', event.data.error);
        if (onError) onError(new Error(event.data.error));
        resolve(null);
      }
    }

    window.addEventListener('message', messageHandler);

    iframe.onerror = function () {
      console.error('Failed to load hand detector iframe (' + instanceId + ')');
      if (onError) onError(new Error('Failed to load hand detector iframe'));
      resolve(null);
    };
  });
}

/**
 * Get a detector instance by its ID.
 * @param {string} instanceId
 * @returns {Object|null}
 */
export function getHandDetector(instanceId) {
  return detectorInstances[instanceId] || null;
}

/**
 * Destroy all detector instances.
 */
export function destroyAllHandDetectors() {
  var ids = Object.keys(detectorInstances);
  for (var i = 0; i < ids.length; i++) {
    var detector = detectorInstances[ids[i]];
    if (detector && detector.destroy) {
      detector.destroy();
    }
  }
}
