"""AprilTag detector with Flask API (pupil_apriltags) and confidence display."""
import argparse
import json
import logging
import re
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Union

import cv2
import numpy as np
from flask import Flask, jsonify, request
from flask_cors import CORS
from pupil_apriltags import Detector

position_lock = threading.Lock()
# relative position (0.0 to 1.0) inside the map formed by ids 1,2,3,4
current_position = {"tags": {}, "detected_ids": []}

frame_lock = threading.Lock()
latest_frame: Optional[np.ndarray] = None
latest_frame_seq: int = 0
latest_frame_updated_at: float = 0.0

calibration_lock = threading.Lock()
latest_boundary_src_pts: Optional[np.ndarray] = None  # float32 shape (4, 2) for ids [1,2,3,4]
latest_calibration_updated_at: float = 0.0

CAPTURE_DIR = Path(__file__).resolve().parent / "cache" / "captures"
CAPTURE_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)
CORS(app)


@app.route('/api/position', methods=['GET'])
def get_position():
    with position_lock:
        return jsonify(current_position)


def _safe_component(value: str) -> str:
    if not isinstance(value, str):
        return "unknown"
    value = value.strip()
    if not value:
        return "unknown"
    value = re.sub(r"[^a-zA-Z0-9._-]+", "_", value)
    return value[:80] if value else "unknown"


@app.route('/api/capture-circles', methods=['POST'])
def capture_circles():
    t0 = time.perf_counter()
    timings = {}
    payload = request.get_json(silent=True) or {}
    sticker_colors = payload.get('stickerColors') or payload.get('colors') or []
    try:
        delay_ms = int(payload.get('delayMs') or 0)
    except (TypeError, ValueError):
        delay_ms = 0
    delay_ms = max(0, min(2000, delay_ms))
    try:
        min_new_frames = int(payload.get('minNewFrames') or 3)
    except (TypeError, ValueError):
        min_new_frames = 3
    min_new_frames = max(0, min(60, min_new_frames))
    try:
        wait_timeout_ms = int(payload.get('waitTimeoutMs') or 3000)
    except (TypeError, ValueError):
        wait_timeout_ms = 3000
    wait_timeout_ms = max(0, min(10_000, wait_timeout_ms))
    try:
        warp_width = payload.get('warpWidth')
        warp_height = payload.get('warpHeight')
        warp_size = payload.get('warpSize')

        if warp_width is None and warp_height is None and warp_size is None:
            warp_width = 1920
            warp_height = 1080
        elif warp_size is not None and warp_width is None and warp_height is None:
            warp_width = int(warp_size)
            warp_height = int(warp_size)
        else:
            warp_width = int(warp_width or 1920)
            warp_height = int(warp_height or 1080)
    except (TypeError, ValueError):
        warp_width = 1920
        warp_height = 1080

    warp_width = max(128, min(4096, int(warp_width)))
    warp_height = max(128, min(4096, int(warp_height)))

    project_id = _safe_component(payload.get('projectId') or "")
    from_question_id = _safe_component(payload.get('fromQuestionId') or payload.get('questionId') or "")

    t_wait_start = time.perf_counter()
    with frame_lock:
        start_seq = latest_frame_seq

    with calibration_lock:
        src_pts = None if latest_boundary_src_pts is None else latest_boundary_src_pts.copy()
        calib_updated_at = float(latest_calibration_updated_at or 0.0)

    if src_pts is None or src_pts.shape != (4, 2):
        return jsonify({"ok": False, "error": "no_calibration"}), 503

    if delay_ms:
        time.sleep(delay_ms / 1000.0)

    deadline = time.time() + (wait_timeout_ms / 1000.0 if wait_timeout_ms else 0.0)
    target_seq = start_seq + min_new_frames
    frame = None
    frame_seq = None
    frame_updated_at = None

    while True:
        with frame_lock:
            seq = latest_frame_seq
            src = latest_frame
            updated_at = latest_frame_updated_at
            if src is not None and (seq >= target_seq or time.time() >= deadline):
                frame = src.copy()
                frame_seq = seq
                frame_updated_at = updated_at
                break

        if time.time() >= deadline:
            break
        time.sleep(0.01)

    if frame is None:
        return jsonify({"ok": False, "error": "no_frame"}), 503
    timings["wait_frame_ms"] = (time.perf_counter() - t_wait_start) * 1000.0

    dst_pts = np.array([[0, 0], [warp_width - 1, 0], [warp_width - 1, warp_height - 1], [0, warp_height - 1]], dtype="float32")
    H = cv2.getPerspectiveTransform(src_pts.astype("float32"), dst_pts)
    t_warp = time.perf_counter()
    warped = cv2.warpPerspective(frame, H, (warp_width, warp_height))
    timings["warp_ms"] = (time.perf_counter() - t_warp) * 1000.0

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ")
    base = f"{timestamp}__{project_id}__{from_question_id}".strip("_")
    from detect_colored_circles import detect_circles_in_bgr_image
    from preprocess_image import preprocess_image, preprocess_image_with_timings, get_default_preprocess_config

    raw_path = CAPTURE_DIR / f"{base}__raw.png"
    t_write_raw = time.perf_counter()
    try:
        cv2.imwrite(str(raw_path), warped)
    except Exception:
        pass
    timings["write_raw_ms"] = (time.perf_counter() - t_write_raw) * 1000.0

    processed = warped
    scale_x = 1.0
    scale_y = 1.0
    try:
        cfg = get_default_preprocess_config()
        # Force-disable NLM in capture pipeline (too slow for realtime use).
        cfg["nlm_h"] = 0.0
        cfg["nlm_h_color"] = 0.0
        processed, pre_timings = preprocess_image_with_timings(warped, cfg)
        timings["preprocess_ms"] = pre_timings.get("total_ms")
        timings["preprocess_detail_ms"] = pre_timings
        if isinstance(processed, np.ndarray) and processed.shape[:2] != warped.shape[:2]:
            scale_x = float(processed.shape[1]) / float(warp_width or 1)
            scale_y = float(processed.shape[0]) / float(warp_height or 1)
    except Exception:
        processed = warped
        scale_x = 1.0
        scale_y = 1.0

    t_detect = time.perf_counter()
    image_path = CAPTURE_DIR / f"{base}.png"
    t_write_capture = time.perf_counter()
    try:
        cv2.imwrite(str(image_path), processed)
    except Exception:
        pass
    timings["write_capture_ms"] = (time.perf_counter() - t_write_capture) * 1000.0

    # Debug convenience: keep a stable filename for quick manual inspection / scripts.
    input_path = CAPTURE_DIR / "input.png"
    try:
        cv2.imwrite(str(input_path), processed)
    except Exception:
        pass

    circles = detect_circles_in_bgr_image(processed, sticker_colors_hex=sticker_colors)
    timings["detect_circles_ms"] = (time.perf_counter() - t_detect) * 1000.0
    denom_x = float(max(1, warp_width - 1))
    denom_y = float(max(1, warp_height - 1))
    denom_r = float(max(1, max(warp_width, warp_height) - 1))
    normalized = []
    circle_pixels = []
    processed_circle_pixels = []
    for c in circles:
        x = float(c.get("x", 0))
        y = float(c.get("y", 0))
        radius = float(c.get("radius", 0))
        processed_circle_pixels.append((x, y, radius))
        if scale_x != 1.0 or scale_y != 1.0:
            if scale_x > 0:
                x = x / scale_x
            if scale_y > 0:
                y = y / scale_y
            scale_r = (scale_x + scale_y) / 2.0 if (scale_x > 0 and scale_y > 0) else 1.0
            if scale_r != 0:
                radius = radius / scale_r
        x = int(round(x))
        y = int(round(y))
        circle_pixels.append((x, y, radius))
        normalized.append({
            "nx": float(x) / denom_x,
            "ny": float(y) / denom_y,
            "radius": radius / denom_r,
            "stickerIndex": c.get("stickerIndex", None),
            "color": c.get("color", None),
            "distance": c.get("distance", None),
            "bgr": c.get("bgr", None)
        })

    # Store a cache image with detected circles masked to white (preprocessed image).
    t_mask = time.perf_counter()
    masked = processed.copy()
    for cx, cy, cr in processed_circle_pixels:
        if cr <= 0:
            continue
        cv2.circle(masked, (int(round(cx)), int(round(cy))), int(round(cr)), (255, 255, 255), -1, lineType=cv2.LINE_AA)
    masked_path = CAPTURE_DIR / f"{base}__no_circles.png"
    try:
        cv2.imwrite(str(masked_path), masked)
    except Exception:
        pass
    timings["mask_write_ms"] = (time.perf_counter() - t_mask) * 1000.0

    paths_payload = []
    paths_error = None
    try:
        from extract_paths import extract_line_paths
        t_paths = time.perf_counter()
        paths = extract_line_paths(str(masked_path))
        timings["extract_paths_ms"] = (time.perf_counter() - t_paths) * 1000.0
        for color_name, lines in (paths or {}).items():
            for line in lines or []:
                points = []
                for point in line or []:
                    if not isinstance(point, (list, tuple)) or len(point) < 2:
                        continue
                    px = float(point[0])
                    py = float(point[1])
                    if scale_x != 1.0 and scale_x > 0:
                        px = px / scale_x
                    if scale_y != 1.0 and scale_y > 0:
                        py = py / scale_y
                    points.append({
                        "nx": px / denom_x,
                        "ny": py / denom_y
                    })
                if len(points) < 2:
                    continue
                paths_payload.append({
                    "color": color_name,
                    "points": points
                })
    except Exception as exc:
        paths_payload = []
        paths_error = str(exc)
        logging.exception("Path extraction failed")

    json_path = CAPTURE_DIR / f"{base}.json"
    try:
        t_json = time.perf_counter()
        json_path.write_text(json.dumps({
            "capturedAt": timestamp,
            "projectId": payload.get("projectId", None),
            "fromQuestionId": payload.get("fromQuestionId", None),
            "fromQuestionIndex": payload.get("fromQuestionIndex", None),
            "toQuestionId": payload.get("toQuestionId", None),
            "toQuestionIndex": payload.get("toQuestionIndex", None),
            "delayMs": delay_ms,
            "minNewFrames": min_new_frames,
            "waitTimeoutMs": wait_timeout_ms,
            "startFrameSeq": start_seq,
            "capturedFrameSeq": frame_seq,
            "capturedFrameUpdatedAt": frame_updated_at,
            "warpWidth": warp_width,
            "warpHeight": warp_height,
            "calibrationUpdatedAt": calib_updated_at,
            "rawCaptureFile": raw_path.name,
            "circles": normalized,
            "paths": paths_payload,
            "pathsError": paths_error,
            "timingsMs": timings
        }, indent=2), encoding="utf-8")
        timings["write_json_ms"] = (time.perf_counter() - t_json) * 1000.0
    except Exception:
        pass

    timings["total_ms"] = (time.perf_counter() - t0) * 1000.0
    timing_path = CAPTURE_DIR / f"{base}__timing.txt"
    try:
        lines = [f"{key}: {value:.2f} ms" for key, value in timings.items()]
        timing_path.write_text("\n".join(lines), encoding="utf-8")
    except Exception:
        pass

    return jsonify({
        "ok": True,
        "capturedAt": timestamp,
        "warpWidth": warp_width,
        "warpHeight": warp_height,
        "calibrationUpdatedAt": calib_updated_at,
        "capturedFrameSeq": frame_seq,
        "capturedFrameUpdatedAt": frame_updated_at,
        "captureFile": image_path.name,
        "rawCaptureFile": raw_path.name,
        "maskedCaptureFile": f"{base}__no_circles.png",
        "circles": normalized,
        "paths": paths_payload,
        "pathsError": paths_error,
        "timingsMs": timings
    })


def run_flask_server():
    # Suppress Flask/Werkzeug request logs
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)

    print("Starting Flask API on http://localhost:5000/api/position (and /api/capture-circles)")
    app.run(host='127.0.0.1', port=5000, debug=False, use_reloader=False)


def parse_source(value: str) -> Union[int, str]:
    try:
        return int(value)
    except ValueError:
        return value


def build_detector(args) -> Detector:
    return Detector(
        families=args.family,
        nthreads=args.threads,
        quad_decimate=args.quad_decimate,
        quad_sigma=args.quad_sigma,
        refine_edges=args.refine_edges
    )


def draw_detection(frame, det, min_margin: float):
    corners = det.corners.astype(int)
    center = tuple(det.center.astype(int))
    margin = float(det.decision_margin)
    color = (0, 200, 0) if margin >= min_margin else (0, 0, 255)

    cv2.polylines(frame, [corners], isClosed=True, color=color, thickness=2)
    cv2.circle(frame, center, 3, color, -1)
    label = f"id:{det.tag_id} m:{margin:.1f}"
    label_pos = (corners[0][0], max(0, corners[0][1] - 10))
    cv2.putText(frame, label, label_pos, cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)


class LatestFrame:
    def __init__(self, cap: cv2.VideoCapture):
        self.cap = cap
        self.lock = threading.Lock()
        self.frame = None
        self.running = False
        self.thread = None

    def start(self):
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        return self

    def _run(self):
        while self.running:
            ok, frame = self.cap.read()
            if not ok:
                with self.lock:
                    self.frame = None
                time.sleep(0.01)
                continue
            with self.lock:
                self.frame = frame

    def read(self):
        with self.lock:
            if self.frame is None:
                return False, None
            return True, self.frame.copy()

    def stop(self):
        self.running = False
        if self.thread:
            self.thread.join(timeout=1)


def detect_and_display(cap: cv2.VideoCapture, detector: Detector, args):
    global latest_frame, latest_frame_seq, latest_frame_updated_at, latest_boundary_src_pts, latest_calibration_updated_at
    window_name = "AprilTag 36h11 Detector"
    cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(window_name, 1280, 720)

    boundary_ids = [1, 2, 3, 4]
    min_margin = max(0.0, args.min_margin)
    frame_source = LatestFrame(cap).start()

    boundary_centers_cache: dict[int, np.ndarray] = {}
    boundary_corners_cache: dict[int, np.ndarray] = {}
    boundary_best_corner_cache: dict[int, np.ndarray] = {}
    perspective_M: Optional[np.ndarray] = None

    while True:
        ok, frame = frame_source.read()
        if not ok:
            time.sleep(0.01)
            continue

        with frame_lock:
            latest_frame = frame.copy()
            latest_frame_seq += 1
            latest_frame_updated_at = time.time()

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        detections = detector.detect(gray, estimate_tag_pose=False)

        centers = {}
        all_corners_dict = {}
        margins = {}
        found_tags = {}
        detected_ids = []

        for det in detections:
            tag_id = int(det.tag_id)
            detected_ids.append(tag_id)
            all_corners_dict[tag_id] = det.corners
            centers[tag_id] = det.center
            margins[tag_id] = float(det.decision_margin)
            draw_detection(frame, det, min_margin)

        for cid in boundary_ids:
            margin = margins.get(cid)
            if margin is None:
                continue

            should_update = (
                (margin >= min_margin)
                or (cid not in boundary_centers_cache)
                or (cid not in boundary_corners_cache)
            )
            if should_update and cid in centers:
                boundary_centers_cache[cid] = centers[cid]
            if should_update and cid in all_corners_dict:
                boundary_corners_cache[cid] = all_corners_dict[cid]

        if len(boundary_centers_cache) >= 2 and boundary_corners_cache:
            group_center = np.mean(np.stack(list(boundary_centers_cache.values())), axis=0)
            for cid, c_corners in boundary_corners_cache.items():
                best_corner = None
                min_dist = float("inf")
                for pt in c_corners:
                    dist = float(np.linalg.norm(pt - group_center))
                    if dist < min_dist:
                        min_dist = dist
                        best_corner = pt
                if best_corner is not None:
                    boundary_best_corner_cache[cid] = best_corner

        if all(cid in boundary_best_corner_cache for cid in boundary_ids):
            src_pts = np.array([boundary_best_corner_cache[cid] for cid in boundary_ids], dtype="float32")
            dst_pts = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], dtype="float32")
            perspective_M = cv2.getPerspectiveTransform(src_pts, dst_pts)
            with calibration_lock:
                latest_boundary_src_pts = src_pts.copy()
                latest_calibration_updated_at = time.time()

        if perspective_M is not None:
            for det in detections:
                tag_id = int(det.tag_id)
                if tag_id in boundary_ids:
                    continue
                if args.filter and det.decision_margin < min_margin:
                    continue

                tracked_center = np.array([[det.center]], dtype="float32")
                pts_transformed = cv2.perspectiveTransform(tracked_center, perspective_M)
                px = float(pts_transformed[0][0][0])
                py = float(pts_transformed[0][0][1])
                found_tags[str(tag_id)] = {
                    "x": px,
                    "y": py,
                    "id": tag_id,
                    "margin": float(det.decision_margin),
                }

        with position_lock:
            current_position["tags"] = found_tags
            current_position["detected_ids"] = detected_ids

        overlay = (
            f"min margin: {min_margin:.1f}  "
            f"boundary: {len(boundary_best_corner_cache)}/4  "
            f"([ / ] to adjust, q to quit)"
        )
        cv2.putText(frame, overlay, (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        cv2.imshow(window_name, frame)

        key = cv2.waitKey(1) & 0xFF
        if key in (ord("q"), 27):
            break
        if key == ord("["):
            min_margin = max(0.0, min_margin - 1.0)
        if key == ord("]"):
            min_margin += 1.0

    frame_source.stop()
    cap.release()
    cv2.destroyAllWindows()


def main() -> int:
    parser = argparse.ArgumentParser(description="AprilTag detector with confidence display")
    parser.add_argument("--source", default="0", help="Camera index or stream URL")
    parser.add_argument("--family", default="tag36h11", help="Tag family")
    parser.add_argument("--min-margin", type=float, default=20.0, help="Decision margin threshold")
    parser.add_argument("--filter", action="store_true", help="Hide detections below threshold")
    parser.add_argument("--threads", type=int, default=2, help="Detector threads")
    parser.add_argument("--quad-decimate", type=float, default=1.0, help="Decimation factor")
    parser.add_argument("--quad-sigma", type=float, default=0.0, help="Gaussian blur sigma")
    parser.add_argument("--refine-edges", action="store_true", help="Refine edges")
    args = parser.parse_args()

    source = parse_source(args.source)
    detector = build_detector(args)

    server_thread = threading.Thread(target=run_flask_server, daemon=True)
    server_thread.start()

    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        print(f"Could not open video source: {source}")
        return 1
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

    try:
        detect_and_display(cap, detector, args)
    finally:
        cap.release()
        cv2.destroyAllWindows()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
