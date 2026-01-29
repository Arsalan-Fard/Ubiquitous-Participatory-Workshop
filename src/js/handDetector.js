/**
 * Initialize hand detector using MediaPipe in an isolated iframe.
 * The iframe is positioned over the video to display hand skeleton.
 */
export async function initHandDetector(options) {
  options = options || {};
  var onReady = options.onReady;
  var onError = options.onError;
  var videoContainer = options.videoContainer;

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
    iframe.src = new URL('../../lib/hand-iframe.html', import.meta.url).href;

    // Append to video container if provided, otherwise body
    var container = videoContainer || document.body;
    container.appendChild(iframe);

    var requestId = 0;
    var pendingRequests = {};

    window.addEventListener('message', function (event) {
      if (event.source !== iframe.contentWindow) return;

      if (event.data.type === 'ready') {
        if (onReady) onReady();
        resolve({
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
          }
        });
      } else if (event.data.type === 'result') {
        var resolveDetect = pendingRequests[event.data.requestId];
        if (resolveDetect) {
          delete pendingRequests[event.data.requestId];
          resolveDetect(event.data.hands);
        }
      } else if (event.data.type === 'error') {
        console.error('Hand detector error:', event.data.error);
        if (onError) onError(new Error(event.data.error));
        resolve(null);
      }
    });

    iframe.onerror = function () {
      console.error('Failed to load hand detector iframe');
      if (onError) onError(new Error('Failed to load hand detector iframe'));
      resolve(null);
    };
  });
}
