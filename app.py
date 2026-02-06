import argparse
import atexit
from pathlib import Path
import threading
import time

import cv2
from flask import Flask, Response, abort, jsonify, send_from_directory

try:
  from pupil_apriltags import Detector
except Exception:
  Detector = None


ROOT_DIR = Path(__file__).resolve().parent

app = Flask(__name__, static_folder=str(ROOT_DIR), static_url_path="")

camera_lock = threading.Lock()
frame_lock = threading.Lock()
apriltag_lock = threading.Lock()
stream_clients_lock = threading.Lock()
shutdown_event = threading.Event()

camera = None
camera_source = None
camera_thread = None
apriltag_thread = None
apriltag_detector = None

latest_frame = None
latest_jpeg = None
latest_frame_seq = 0
latest_frame_updated_at = 0.0
latest_frame_width = 0
latest_frame_height = 0

latest_apriltags = []
latest_apriltag_updated_at = 0.0
apriltag_error = None
stream_clients = 0


def parse_source(value: str):
  try:
    return int(value)
  except (TypeError, ValueError):
    return value


def init_camera(source) -> None:
  global camera, camera_source
  with camera_lock:
    if camera is not None and camera.isOpened():
      camera.release()
    camera = cv2.VideoCapture(source)
    camera_source = source
    if not camera.isOpened():
      raise RuntimeError(f"Could not open camera source: {source}")


def _map_detection(det):
  corners = []
  for pt in det.corners:
    corners.append({"x": float(pt[0]), "y": float(pt[1])})

  center = {"x": float(det.center[0]), "y": float(det.center[1])}

  return {
    "id": int(det.tag_id),
    "center": center,
    "corners": corners,
    "decision_margin": float(det.decision_margin),
  }


def camera_loop(jpeg_quality: int) -> None:
  global latest_frame, latest_jpeg, latest_frame_seq
  global latest_frame_updated_at, latest_frame_width, latest_frame_height

  encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), int(jpeg_quality)]

  while not shutdown_event.is_set():
    with camera_lock:
      local_camera = camera

    if local_camera is None:
      time.sleep(0.01)
      continue

    success, frame = local_camera.read()
    if not success or frame is None:
      time.sleep(0.01)
      continue

    height, width = frame.shape[:2]
    jpeg_bytes = None

    with stream_clients_lock:
      should_encode = stream_clients > 0

    if should_encode:
      ok, buffer = cv2.imencode(".jpg", frame, encode_params)
      if ok:
        jpeg_bytes = buffer.tobytes()

    with frame_lock:
      latest_frame = frame
      latest_jpeg = jpeg_bytes if should_encode else None
      latest_frame_width = int(width)
      latest_frame_height = int(height)
      latest_frame_seq += 1
      latest_frame_updated_at = time.time()


def apriltag_loop(max_fps: float) -> None:
  global latest_apriltags, latest_apriltag_updated_at, apriltag_error

  if Detector is None or apriltag_detector is None:
    with apriltag_lock:
      apriltag_error = "pupil_apriltags_not_available"
    return

  interval = 1.0 / max(1.0, float(max_fps))
  last_seq = -1

  while not shutdown_event.is_set():
    frame = None
    seq = -1

    with frame_lock:
      if latest_frame is not None:
        frame = latest_frame
        seq = latest_frame_seq

    if frame is None:
      time.sleep(0.01)
      continue

    if seq == last_seq:
      time.sleep(0.005)
      continue

    last_seq = seq

    try:
      gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
      detections = apriltag_detector.detect(gray, estimate_tag_pose=False)
      mapped = [_map_detection(det) for det in detections]

      with apriltag_lock:
        latest_apriltags = mapped
        latest_apriltag_updated_at = time.time()
        apriltag_error = None
    except Exception as exc:
      with apriltag_lock:
        apriltag_error = str(exc)

    if interval > 0:
      time.sleep(interval)


def start_workers(jpeg_quality: int, apriltag_fps: float) -> None:
  global camera_thread, apriltag_thread

  if camera_thread is None or not camera_thread.is_alive():
    camera_thread = threading.Thread(target=camera_loop, args=(jpeg_quality,), daemon=True)
    camera_thread.start()

  if apriltag_thread is None or not apriltag_thread.is_alive():
    apriltag_thread = threading.Thread(target=apriltag_loop, args=(apriltag_fps,), daemon=True)
    apriltag_thread.start()


def _release_camera() -> None:
  shutdown_event.set()

  global camera_thread, apriltag_thread
  if camera_thread is not None:
    camera_thread.join(timeout=1)
  if apriltag_thread is not None:
    apriltag_thread.join(timeout=1)

  with camera_lock:
    if camera is not None and camera.isOpened():
      camera.release()


atexit.register(_release_camera)


def generate_frames():
  global stream_clients

  last_seq = -1
  with stream_clients_lock:
    stream_clients += 1

  try:
    while not shutdown_event.is_set():
      with frame_lock:
        frame_bytes = latest_jpeg
        seq = latest_frame_seq

      if not frame_bytes:
        time.sleep(0.01)
        continue

      if seq == last_seq:
        time.sleep(0.005)
        continue

      last_seq = seq

      yield (
        b"--frame\r\n"
        b"Content-Type: image/jpeg\r\n\r\n" + frame_bytes + b"\r\n"
      )
  finally:
    with stream_clients_lock:
      stream_clients = max(0, stream_clients - 1)


@app.route("/")
def index():
  return send_from_directory(str(ROOT_DIR), "index.html")


@app.route("/video_feed")
def video_feed():
  return Response(
    generate_frames(),
    mimetype="multipart/x-mixed-replace; boundary=frame",
    headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
  )


@app.route("/api/apriltags")
def api_apriltags():
  with apriltag_lock:
    detections = list(latest_apriltags)
    updated_at = float(latest_apriltag_updated_at or 0.0)
    error = apriltag_error

  with frame_lock:
    width = int(latest_frame_width or 0)
    height = int(latest_frame_height or 0)
    frame_seq = int(latest_frame_seq or 0)
    frame_updated_at = float(latest_frame_updated_at or 0.0)
  with stream_clients_lock:
    active_stream_clients = int(stream_clients)

  payload = {
    "ok": error is None,
    "error": error,
    "detections": detections,
    "frame": {
      "width": width,
      "height": height,
      "seq": frame_seq,
      "updatedAt": frame_updated_at,
    },
    "updatedAt": updated_at,
    "source": str(camera_source),
    "streamClients": active_stream_clients,
  }
  return jsonify(payload)


@app.route("/<path:path>")
def static_proxy(path: str):
  file_path = ROOT_DIR / path
  if file_path.is_file():
    return send_from_directory(str(ROOT_DIR), path)
  abort(404)


if __name__ == "__main__":
  parser = argparse.ArgumentParser(description="Flask camera stream server with backend AprilTag detection")
  parser.add_argument("--source", default="0", help="Camera index or stream URL")
  parser.add_argument("--host", default="0.0.0.0", help="Host to bind")
  parser.add_argument("--port", type=int, default=5000, help="Port to bind")
  parser.add_argument("--jpeg-quality", type=int, default=100, help="MJPEG quality (1-100)")
  parser.add_argument("--apriltag-fps", type=float, default=60.0, help="Backend AprilTag detection max FPS")
  parser.add_argument("--apriltag-family", default="tag36h11", help="AprilTag family")
  parser.add_argument("--apriltag-threads", type=int, default=4, help="AprilTag detector threads")
  parser.add_argument("--apriltag-quad-decimate", type=float, default=1.0, help="AprilTag quad decimate")
  parser.add_argument("--apriltag-quad-sigma", type=float, default=0.0, help="AprilTag quad sigma")
  parser.add_argument("--apriltag-refine-edges", action="store_true", help="Enable AprilTag edge refinement")
  args = parser.parse_args()

  source = parse_source(args.source)
  init_camera(source)

  if Detector is not None:
    try:
      apriltag_detector = Detector(
        families=args.apriltag_family,
        nthreads=max(1, int(args.apriltag_threads)),
        quad_decimate=float(args.apriltag_quad_decimate),
        quad_sigma=float(args.apriltag_quad_sigma),
        refine_edges=bool(args.apriltag_refine_edges),
      )
    except Exception as exc:
      with apriltag_lock:
        apriltag_error = str(exc)

  start_workers(jpeg_quality=max(1, min(100, int(args.jpeg_quality))), apriltag_fps=max(1.0, float(args.apriltag_fps)))

  app.run(host=args.host, port=args.port, debug=False, threaded=True)
