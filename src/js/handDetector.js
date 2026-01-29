/**
 * Initialize hand detector using MediaPipe in an isolated iframe.
 * The iframe is positioned over the video to display hand skeleton.
 */
export async function initHandDetector({ onReady, onError, videoContainer } = {}) {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border: none;
      pointer-events: none;
      z-index: 20;
      background: transparent;
    `;
    iframe.setAttribute('allowtransparency', 'true');
    iframe.src = new URL('../../lib/hand-iframe.html', import.meta.url).href;

    // Append to video container if provided, otherwise body
    const container = videoContainer || document.body;
    container.appendChild(iframe);

    let requestId = 0;
    const pendingRequests = new Map();

    window.addEventListener('message', (event) => {
      if (event.source !== iframe.contentWindow) return;

      if (event.data.type === 'ready') {
        onReady?.();
        resolve({
          detect(imageData, width, height) {
            return new Promise((resolveDetect) => {
              const id = requestId++;
              pendingRequests.set(id, resolveDetect);

              // Create a copy of the buffer to transfer (transfer detaches the original)
              const buffer = new Uint8ClampedArray(imageData).buffer;

              iframe.contentWindow.postMessage({
                type: 'detect',
                imageData: buffer,
                width,
                height,
                requestId: id
              }, '*', [buffer]); // Transfer the ArrayBuffer
            });
          },
          resize(width, height) {
            iframe.contentWindow.postMessage({
              type: 'resize',
              width,
              height
            }, '*');
          }
        });
      } else if (event.data.type === 'result') {
        const resolveDetect = pendingRequests.get(event.data.requestId);
        if (resolveDetect) {
          pendingRequests.delete(event.data.requestId);
          resolveDetect(event.data.hands);
        }
      } else if (event.data.type === 'error') {
        console.error('Hand detector error:', event.data.error);
        onError?.(new Error(event.data.error));
        resolve(null);
      }
    });

    iframe.onerror = () => {
      console.error('Failed to load hand detector iframe');
      onError?.(new Error('Failed to load hand detector iframe'));
      resolve(null);
    };
  });
}
