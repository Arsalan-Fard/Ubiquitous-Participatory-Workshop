const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const detectionsEl = document.getElementById('detections');
const errorMsg = document.getElementById('error');

const ctx = overlay.getContext('2d');

let currentStream = null;
let apriltag = null;
let isProcessing = false;
let animationId = null;

// Initialize AprilTag detector
async function initDetector() {
    try {
        const Apriltag = Comlink.wrap(new Worker('lib/apriltag.js'));
        apriltag = await new Apriltag(Comlink.proxy(() => {
            statusEl.textContent = 'Detector: Ready';
            console.log('AprilTag detector initialized');
        }));
    } catch (err) {
        console.error('Failed to initialize detector:', err);
        statusEl.textContent = 'Detector: Failed to load';
    }
}

// Start the detector initialization
initDetector();

async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'environment',
                width: { ideal: 640 },
                height: { ideal: 480 }
            },
            audio: false
        });

        currentStream = stream;
        video.srcObject = stream;

        video.onloadedmetadata = () => {
            overlay.width = video.videoWidth;
            overlay.height = video.videoHeight;
            startProcessing();
        };

        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
        errorMsg.textContent = '';
    } catch (err) {
        console.error('Error accessing camera:', err);
        if (err.name === 'NotAllowedError') {
            errorMsg.textContent = 'Camera access denied. Please allow camera permissions.';
        } else if (err.name === 'NotFoundError') {
            errorMsg.textContent = 'No camera found on this device.';
        } else {
            errorMsg.textContent = 'Error accessing camera: ' + err.message;
        }
    }
}

function stopCamera() {
    isProcessing = false;
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
        currentStream = null;
    }
    video.srcObject = null;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    detectionsEl.textContent = '';
    startBtn.style.display = 'inline-block';
    stopBtn.style.display = 'none';
}

function startProcessing() {
    isProcessing = true;
    processFrame();
}

async function processFrame() {
    if (!isProcessing || !apriltag) {
        animationId = requestAnimationFrame(processFrame);
        return;
    }

    // Draw video frame to get pixel data
    ctx.drawImage(video, 0, 0, overlay.width, overlay.height);
    const imageData = ctx.getImageData(0, 0, overlay.width, overlay.height);
    const pixels = imageData.data;

    // Convert to grayscale
    const grayscale = new Uint8Array(overlay.width * overlay.height);
    for (let i = 0, j = 0; i < pixels.length; i += 4, j++) {
        grayscale[j] = Math.round((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3);
    }

    // Detect tags
    try {
        const detections = await apriltag.detect(grayscale, overlay.width, overlay.height);

        // Clear overlay
        ctx.clearRect(0, 0, overlay.width, overlay.height);

        // Draw detections
        if (detections && detections.length > 0) {
            detections.forEach(det => {
                drawDetection(det);
            });
            detectionsEl.textContent = `Detected ${detections.length} tag(s): ${detections.map(d => 'ID ' + d.id).join(', ')}`;
        } else {
            detectionsEl.textContent = 'No tags detected';
        }
    } catch (err) {
        console.error('Detection error:', err);
    }

    animationId = requestAnimationFrame(processFrame);
}

function drawDetection(det) {
    const corners = det.corners;

    // Draw quadrilateral
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    ctx.lineTo(corners[1].x, corners[1].y);
    ctx.lineTo(corners[2].x, corners[2].y);
    ctx.lineTo(corners[3].x, corners[3].y);
    ctx.closePath();
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Draw corner points
    ctx.fillStyle = '#ff0000';
    corners.forEach(corner => {
        ctx.beginPath();
        ctx.arc(corner.x, corner.y, 5, 0, 2 * Math.PI);
        ctx.fill();
    });

    // Draw tag ID at center
    const centerX = det.center.x;
    const centerY = det.center.y;

    ctx.font = 'bold 24px Arial';
    ctx.fillStyle = '#00ff00';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ID: ' + det.id, centerX, centerY);
}

startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);
