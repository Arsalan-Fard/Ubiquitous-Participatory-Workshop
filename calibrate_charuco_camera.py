"""
Interactive ChArUco camera calibration utility.

Usage examples:
  python calibrate_charuco_camera.py --source 0 --square-mm 24 --marker-mm 16
  python calibrate_charuco_camera.py --source http://IP:PORT/video --square-mm 24 --marker-mm 16 --output camera_calibration.json

Controls:
  c / space  Capture current frame (if enough ChArUco corners are detected)
  r          Remove last captured sample
  q / esc    Quit capture and run calibration (if enough samples exist)
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import time

import cv2
import numpy as np


APRILTAG_DICT_BY_NAME = {
    "tag16h5": cv2.aruco.DICT_APRILTAG_16h5,
    "tag25h9": cv2.aruco.DICT_APRILTAG_25h9,
    "tag36h10": cv2.aruco.DICT_APRILTAG_36h10,
    "tag36h11": cv2.aruco.DICT_APRILTAG_36h11,
}


def parse_source(value: str):
    try:
        return int(value)
    except (TypeError, ValueError):
        return value


def create_charuco_board(
    squares_x: int,
    squares_y: int,
    square_m: float,
    marker_m: float,
    dictionary,
):
    if hasattr(cv2.aruco, "CharucoBoard"):
        return cv2.aruco.CharucoBoard(
            (int(squares_x), int(squares_y)),
            float(square_m),
            float(marker_m),
            dictionary,
        )
    if hasattr(cv2.aruco, "CharucoBoard_create"):
        return cv2.aruco.CharucoBoard_create(
            int(squares_x),
            int(squares_y),
            float(square_m),
            float(marker_m),
            dictionary,
        )
    raise RuntimeError("OpenCV aruco CharucoBoard API not available in this environment.")


def get_dictionary(dict_name: str):
    dict_key = normalize_dict_name(dict_name)
    if dict_key not in APRILTAG_DICT_BY_NAME:
        valid = ", ".join(sorted(APRILTAG_DICT_BY_NAME.keys()))
        raise ValueError(f"Unsupported dictionary '{dict_name}'. Valid: {valid}")
    return cv2.aruco.getPredefinedDictionary(APRILTAG_DICT_BY_NAME[dict_key])


def normalize_dict_name(value: str) -> str:
    return str(value or "").strip().lower()


def detect_markers(gray, dictionary):
    corners, ids, _ = cv2.aruco.detectMarkers(gray, dictionary)
    if ids is None:
        ids = np.empty((0, 1), dtype=np.int32)
    return corners, ids


def interpolate_charuco(gray, marker_corners, marker_ids, board):
    if len(marker_corners) < 1:
        return None, None
    result = cv2.aruco.interpolateCornersCharuco(
        marker_corners,
        marker_ids,
        gray,
        board,
    )
    if len(result) == 2:
        charuco_corners, charuco_ids = result
        detected_count = 0 if charuco_ids is None else len(charuco_ids)
    else:
        detected_count, charuco_corners, charuco_ids = result
    if detected_count is None or int(detected_count) < 1 or charuco_ids is None:
        return None, None
    return charuco_corners, charuco_ids


def draw_status(
    frame,
    found_corners: int,
    sample_count: int,
    min_samples: int,
    min_charuco_corners: int,
    square_mm: float,
    marker_mm: float,
):
    lines = [
        f"Detected corners: {found_corners} (min {min_charuco_corners} to capture)",
        f"Captured samples: {sample_count}/{min_samples}",
        f"Board: square={square_mm:.2f}mm marker={marker_mm:.2f}mm",
        "Keys: [c/space]=capture  [r]=undo  [q/esc]=finish",
    ]
    y = 30
    for line in lines:
        cv2.putText(
            frame,
            line,
            (14, y),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            (50, 230, 50),
            2,
            cv2.LINE_AA,
        )
        y += 28


def fit_preview_frame(frame, max_width: int, max_height: int):
    if max_width <= 0 or max_height <= 0:
        return frame
    h, w = frame.shape[:2]
    if w <= 0 or h <= 0:
        return frame
    scale = min(max_width / float(w), max_height / float(h), 1.0)
    if scale >= 0.999:
        return frame
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    return cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_AREA)


def calibrate_charuco(
    all_charuco_corners,
    all_charuco_ids,
    board,
    image_size,
):
    if not all_charuco_corners or not all_charuco_ids:
        raise ValueError("No ChArUco samples collected.")
    if image_size[0] <= 0 or image_size[1] <= 0:
        raise ValueError("Invalid image size.")

    ret, camera_matrix, dist_coeffs, _rvecs, _tvecs = cv2.aruco.calibrateCameraCharuco(
        charucoCorners=all_charuco_corners,
        charucoIds=all_charuco_ids,
        board=board,
        imageSize=image_size,
        cameraMatrix=None,
        distCoeffs=None,
    )
    return ret, camera_matrix, dist_coeffs


def save_calibration_json(
    output_path: Path,
    camera_matrix: np.ndarray,
    dist_coeffs: np.ndarray,
    reprojection_error: float,
    square_mm: float,
    marker_mm: float,
    dictionary_name: str,
    samples: int,
    image_width: int,
    image_height: int,
):
    payload = {
        "camera_matrix": np.asarray(camera_matrix, dtype=np.float64).tolist(),
        "dist_coeffs": np.asarray(dist_coeffs, dtype=np.float64).reshape(1, -1).tolist(),
        "reprojection_error": float(reprojection_error),
        "board": {
            "dictionary": str(dictionary_name),
            "square_mm": float(square_mm),
            "marker_mm": float(marker_mm),
        },
        "samples": int(samples),
        "image_size": {
            "width": int(image_width),
            "height": int(image_height),
        },
        "calibrated_at_epoch_ms": int(time.time() * 1000),
    }
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def run_capture(args):
    if not hasattr(cv2, "aruco"):
        raise RuntimeError("OpenCV aruco module is unavailable. Install opencv-contrib-python.")

    dictionary = get_dictionary(args.dictionary)
    board = create_charuco_board(
        squares_x=args.squares_x,
        squares_y=args.squares_y,
        square_m=args.square_mm / 1000.0,
        marker_m=args.marker_mm / 1000.0,
        dictionary=dictionary,
    )
    if hasattr(board, "setLegacyPattern"):
        board.setLegacyPattern(False)

    source = parse_source(args.source)
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open camera source: {args.source}")

    cv2.namedWindow(args.window_name, cv2.WINDOW_NORMAL)
    if args.preview_max_width > 0 and args.preview_max_height > 0:
        cv2.resizeWindow(args.window_name, args.preview_max_width, args.preview_max_height)

    all_charuco_corners = []
    all_charuco_ids = []
    image_size = (0, 0)

    try:
        while True:
            ok, frame = cap.read()
            if not ok or frame is None:
                continue

            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            image_size = (gray.shape[1], gray.shape[0])

            marker_corners, marker_ids = detect_markers(gray, dictionary)
            vis = frame.copy()
            if len(marker_corners) > 0:
                cv2.aruco.drawDetectedMarkers(vis, marker_corners, marker_ids)

            charuco_corners, charuco_ids = interpolate_charuco(gray, marker_corners, marker_ids, board)
            found_corners = 0
            if charuco_ids is not None and charuco_corners is not None:
                found_corners = int(len(charuco_ids))
                cv2.aruco.drawDetectedCornersCharuco(vis, charuco_corners, charuco_ids, (255, 180, 0))

            draw_status(
                vis,
                found_corners=found_corners,
                sample_count=len(all_charuco_corners),
                min_samples=args.min_samples,
                min_charuco_corners=args.min_charuco_corners,
                square_mm=args.square_mm,
                marker_mm=args.marker_mm,
            )

            preview = fit_preview_frame(vis, args.preview_max_width, args.preview_max_height)
            cv2.imshow(args.window_name, preview)
            key = cv2.waitKey(1) & 0xFF

            if key in (ord("q"), 27):
                break
            if key in (ord("r"),):
                if all_charuco_corners:
                    all_charuco_corners.pop()
                    all_charuco_ids.pop()
                    print(f"[capture] removed last sample. total={len(all_charuco_corners)}")
                continue
            if key in (ord("c"), 32):
                if charuco_corners is None or charuco_ids is None:
                    print("[capture] skipped: no ChArUco corners.")
                    continue
                if len(charuco_ids) < args.min_charuco_corners:
                    print(
                        f"[capture] skipped: only {len(charuco_ids)} corners "
                        f"(need >= {args.min_charuco_corners})."
                    )
                    continue
                all_charuco_corners.append(charuco_corners)
                all_charuco_ids.append(charuco_ids)
                print(
                    f"[capture] saved sample {len(all_charuco_corners)} "
                    f"(corners={len(charuco_ids)})"
                )
    finally:
        cap.release()
        cv2.destroyAllWindows()

    if len(all_charuco_corners) < args.min_samples:
        raise RuntimeError(
            f"Not enough samples: got {len(all_charuco_corners)}, need at least {args.min_samples}."
        )

    reproj_err, camera_matrix, dist_coeffs = calibrate_charuco(
        all_charuco_corners=all_charuco_corners,
        all_charuco_ids=all_charuco_ids,
        board=board,
        image_size=image_size,
    )
    return reproj_err, camera_matrix, dist_coeffs, len(all_charuco_corners), image_size


def main():
    parser = argparse.ArgumentParser(description="Interactive ChArUco camera calibration")
    parser.add_argument("--source", default="0", help="Camera index or stream URL")
    parser.add_argument("--output", default="camera_calibration.json", help="Output JSON path")
    parser.add_argument("--dictionary", default="tag36h11", help="AprilTag dictionary name")
    parser.add_argument("--squares-x", type=int, default=5, help="Number of squares along X")
    parser.add_argument("--squares-y", type=int, default=7, help="Number of squares along Y")
    parser.add_argument("--square-mm", type=float, default=24.0, help="ChArUco square size in mm")
    parser.add_argument("--marker-mm", type=float, default=16.0, help="Tag marker size in mm")
    parser.add_argument("--min-samples", type=int, default=20, help="Minimum captured views required")
    parser.add_argument(
        "--min-charuco-corners",
        type=int,
        default=8,
        help="Minimum detected ChArUco corners for accepting a frame",
    )
    parser.add_argument("--window-name", default="ChArUco Calibration Capture", help="OpenCV preview window title")
    parser.add_argument(
        "--preview-max-width",
        type=int,
        default=1280,
        help="Max preview width in pixels (0 disables resizing)",
    )
    parser.add_argument(
        "--preview-max-height",
        type=int,
        default=720,
        help="Max preview height in pixels (0 disables resizing)",
    )
    args = parser.parse_args()

    if args.square_mm <= 0 or args.marker_mm <= 0:
        raise ValueError("square-mm and marker-mm must be > 0.")
    if args.marker_mm >= args.square_mm:
        raise ValueError("marker-mm must be smaller than square-mm.")
    if args.squares_x < 2 or args.squares_y < 2:
        raise ValueError("squares-x and squares-y must be >= 2.")
    if args.min_samples < 5:
        raise ValueError("min-samples should be at least 5.")
    if args.min_charuco_corners < 4:
        raise ValueError("min-charuco-corners should be at least 4.")
    if args.preview_max_width < 0 or args.preview_max_height < 0:
        raise ValueError("preview-max-width and preview-max-height must be >= 0.")

    reproj_err, camera_matrix, dist_coeffs, sample_count, image_size = run_capture(args)

    output_path = Path(args.output)
    save_calibration_json(
        output_path=output_path,
        camera_matrix=camera_matrix,
        dist_coeffs=dist_coeffs,
        reprojection_error=reproj_err,
        square_mm=args.square_mm,
        marker_mm=args.marker_mm,
        dictionary_name=args.dictionary,
        samples=sample_count,
        image_width=image_size[0],
        image_height=image_size[1],
    )

    print(f"[ok] saved calibration: {output_path}")
    print(f"[ok] reprojection error: {reproj_err:.4f}")
    print(
        "[next] run your app with the correct interaction-tag size, for example:\n"
        f"  py -3.13 app.py --source {args.source} --camera-calibration {output_path} --tag-size 0.016"
    )


if __name__ == "__main__":
    main()
