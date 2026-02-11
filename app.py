import argparse
import atexit
import json
import os
from pathlib import Path
import re
import socket
import threading
import time

import cv2
from flask import Flask, Response, abort, jsonify, request, send_from_directory, stream_with_context

try:
  from pupil_apriltags import Detector
except Exception:
  Detector = None


ROOT_DIR = Path(__file__).resolve().parent
WORKSHOPS_DIR = ROOT_DIR / "workshops"
WORKSHOP_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
CONTROLLER_CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CONTROLLER_HEARTBEAT_TTL_SEC = 0.8
CONTROLLER_SUPPORTED_TOOLS = {"draw", "dot", "note", "eraser", "selection"}
CONTROLLER_NOTE_TEXT_MAX_LEN = 500

app = Flask(__name__, static_folder=str(ROOT_DIR), static_url_path="")

camera_lock = threading.Lock()
frame_lock = threading.Lock()
apriltag_lock = threading.Lock()
stream_clients_lock = threading.Lock()
controller_lock = threading.Lock()
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
latest_apriltag_seq = 0
apriltag_error = None
stream_clients = 0
controller_clients = {}
controller_state_seq = 0


def parse_source(value: str):
  try:
    return int(value)
  except (TypeError, ValueError):
    return value


def sanitize_workshop_id(raw):
  if not isinstance(raw, str):
    return None
  candidate = raw.strip()
  if not candidate:
    return None
  if not WORKSHOP_ID_RE.fullmatch(candidate):
    return None
  return candidate


def next_workshop_session_index(workshop_dir: Path) -> int:
  max_index = 0
  for p in workshop_dir.glob("session-*.geojson"):
    m = re.match(r"^session-(\d+)\.geojson$", p.name)
    if not m:
      continue
    idx = int(m.group(1))
    if idx > max_index:
      max_index = idx
  return max_index + 1


def list_workshop_session_files(workshop_dir: Path):
  pairs = []
  for p in workshop_dir.glob("session-*.geojson"):
    m = re.match(r"^session-(\d+)\.geojson$", p.name)
    if not m:
      continue
    idx = int(m.group(1))
    pairs.append((idx, p))
  pairs.sort(key=lambda it: it[0])
  return pairs


def normalize_map_view_id(raw):
  if raw is None:
    return None
  text = str(raw).strip()
  if text == "":
    return None
  return text


def sanitize_controller_client_id(raw):
  if not isinstance(raw, str):
    return None
  candidate = raw.strip()
  if not candidate:
    return None
  if not CONTROLLER_CLIENT_ID_RE.fullmatch(candidate):
    return None
  return candidate


def sanitize_controller_trigger_tag_id(raw):
  try:
    trigger_tag_id = int(raw)
  except (TypeError, ValueError):
    return None
  if trigger_tag_id < 1 or trigger_tag_id > 9999:
    return None
  return trigger_tag_id


def sanitize_controller_note_text(raw):
  if raw is None:
    return ""
  text = str(raw)
  if len(text) > CONTROLLER_NOTE_TEXT_MAX_LEN:
    text = text[:CONTROLLER_NOTE_TEXT_MAX_LEN]
  return text


def sanitize_controller_note_finalize_tick(raw):
  try:
    tick = int(raw)
  except (TypeError, ValueError):
    return 0
  if tick < 0:
    return 0
  if tick > 1000000000:
    return 1000000000
  return tick


def get_controller_state_snapshot(now_ts=None):
  global controller_state_seq
  now = float(now_ts if now_ts is not None else time.time())

  with controller_lock:
    expired_ids = []
    active_draw_triggers = set()
    active_tool_by_trigger = {}
    remote_note_state_by_trigger = {}
    active_clients = 0
    last_updated_at = 0.0

    for client_id, client_state in list(controller_clients.items()):
      updated_at = float(client_state.get("updatedAt", 0.0) or 0.0)
      if (now - updated_at) > CONTROLLER_HEARTBEAT_TTL_SEC:
        expired_ids.append(client_id)
        continue

      active_clients += 1
      if updated_at > last_updated_at:
        last_updated_at = updated_at

      trigger_tag_id = sanitize_controller_trigger_tag_id(client_state.get("triggerTagId"))
      if trigger_tag_id is None:
        continue

      note_text = sanitize_controller_note_text(client_state.get("noteText"))
      note_session_active = bool(client_state.get("noteSessionActive"))
      note_finalize_tick = sanitize_controller_note_finalize_tick(client_state.get("noteFinalizeTick"))
      if note_session_active or note_text or note_finalize_tick > 0:
        prev_note = remote_note_state_by_trigger.get(trigger_tag_id)
        if prev_note is None or updated_at >= float(prev_note.get("updatedAt", 0.0) or 0.0):
          remote_note_state_by_trigger[trigger_tag_id] = {
            "text": note_text,
            "sessionActive": bool(note_session_active),
            "finalizeTick": int(note_finalize_tick),
            "updatedAt": float(updated_at),
          }

      if not client_state.get("active"):
        continue

      tool = str(client_state.get("tool") or "draw").strip().lower()
      if tool not in CONTROLLER_SUPPORTED_TOOLS:
        continue

      previous = active_tool_by_trigger.get(trigger_tag_id)
      if previous is None or updated_at >= float(previous.get("updatedAt", 0.0) or 0.0):
        active_tool_by_trigger[trigger_tag_id] = {
          "tool": tool,
          "updatedAt": float(updated_at),
        }

    if expired_ids:
      for client_id in expired_ids:
        controller_clients.pop(client_id, None)
      controller_state_seq += 1

    active_tool_by_trigger_tag_id = {}
    for trigger_tag_id in sorted(active_tool_by_trigger.keys()):
      trigger_key = str(int(trigger_tag_id))
      tool = str(active_tool_by_trigger[trigger_tag_id].get("tool") or "").strip().lower()
      if tool not in CONTROLLER_SUPPORTED_TOOLS:
        continue
      active_tool_by_trigger_tag_id[trigger_key] = tool
      if tool == "draw":
        active_draw_triggers.add(int(trigger_tag_id))

    remote_note_state_by_trigger_tag_id = {}
    for trigger_tag_id in sorted(remote_note_state_by_trigger.keys()):
      trigger_key = str(int(trigger_tag_id))
      note_state = remote_note_state_by_trigger[trigger_tag_id]
      remote_note_state_by_trigger_tag_id[trigger_key] = {
        "text": str(note_state.get("text") or ""),
        "sessionActive": bool(note_state.get("sessionActive")),
        "finalizeTick": int(note_state.get("finalizeTick") or 0),
      }

    return {
      "seq": int(controller_state_seq),
      "updatedAt": float(last_updated_at),
      "activeClients": int(active_clients),
      "activeToolByTriggerTagId": active_tool_by_trigger_tag_id,
      "remoteNoteStateByTriggerTagId": remote_note_state_by_trigger_tag_id,
      "activeDrawTriggerTagIds": sorted(active_draw_triggers),
    }


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
  global latest_apriltags, latest_apriltag_updated_at, latest_apriltag_seq, apriltag_error

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
        latest_apriltag_seq += 1
        apriltag_error = None
    except Exception as exc:
      with apriltag_lock:
        message = str(exc)
        if apriltag_error != message:
          latest_apriltag_seq += 1
        apriltag_error = message

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
  return jsonify(build_apriltag_payload())


@app.route("/api/controller/heartbeat", methods=["POST"])
def api_controller_heartbeat():
  global controller_state_seq
  payload = request.get_json(silent=True)
  if not isinstance(payload, dict):
    return jsonify({"ok": False, "error": "invalid_json"}), 400

  client_id = sanitize_controller_client_id(payload.get("clientId"))
  if not client_id:
    return jsonify({"ok": False, "error": "invalid_client_id"}), 400

  tool = str(payload.get("tool") or "draw").strip().lower()
  if tool not in CONTROLLER_SUPPORTED_TOOLS:
    return jsonify({"ok": False, "error": "invalid_tool"}), 400

  active = bool(payload.get("active"))
  trigger_tag_id = sanitize_controller_trigger_tag_id(payload.get("triggerTagId"))
  if active and trigger_tag_id is None:
    return jsonify({"ok": False, "error": "invalid_trigger_tag_id"}), 400
  note_text = sanitize_controller_note_text(payload.get("noteText"))
  note_session_active = bool(payload.get("noteSessionActive"))
  note_finalize_tick = sanitize_controller_note_finalize_tick(payload.get("noteFinalizeTick"))

  now = time.time()
  changed = False

  with controller_lock:
    previous = controller_clients.get(client_id) or {}
    next_state = {
      "active": bool(active),
      "tool": tool,
      "triggerTagId": int(trigger_tag_id) if trigger_tag_id is not None else None,
      "noteText": note_text,
      "noteSessionActive": bool(note_session_active),
      "noteFinalizeTick": int(note_finalize_tick),
      "updatedAt": float(now),
    }
    if (
      bool(previous.get("active")) != next_state["active"]
      or str(previous.get("tool") or "") != next_state["tool"]
      or sanitize_controller_trigger_tag_id(previous.get("triggerTagId")) != next_state["triggerTagId"]
      or sanitize_controller_note_text(previous.get("noteText")) != next_state["noteText"]
      or bool(previous.get("noteSessionActive")) != next_state["noteSessionActive"]
      or sanitize_controller_note_finalize_tick(previous.get("noteFinalizeTick")) != next_state["noteFinalizeTick"]
    ):
      changed = True
    controller_clients[client_id] = next_state
    if changed:
      controller_state_seq += 1

  return jsonify({
    "ok": True,
    "controller": get_controller_state_snapshot(now),
  })


def _server_info_port_from_request():
  try:
    port = int(request.environ.get("SERVER_PORT") or 0)
  except Exception:
    port = 0
  if port > 0:
    return port

  host = str(request.host or "")
  if host.startswith("[") and "]" in host:
    host = host.split("]", 1)[1]
  if ":" in host:
    parts = host.rsplit(":", 1)
    if len(parts) == 2:
      try:
        return int(parts[1])
      except Exception:
        return 0
  return 0


def _is_valid_ipv4_candidate(ip):
  if not ip:
    return False
  if ip == "0.0.0.0":
    return False
  if ip.startswith("127."):
    return False
  if ip.startswith("169.254."):
    return False
  return True


def _get_ipv4_candidates():
  interface_ip = ""
  candidates = set()

  try:
    from werkzeug.serving import get_interface_ip  # type: ignore
    interface_ip = str(get_interface_ip(socket.AF_INET) or "")
    candidates.add(interface_ip)
  except Exception:
    pass

  try:
    hostname = socket.gethostname()
    for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
      candidates.add(str(info[4][0]))
    for ip in socket.gethostbyname_ex(hostname)[2]:
      candidates.add(str(ip))
  except Exception:
    pass

  out = []
  seen = set()
  if _is_valid_ipv4_candidate(interface_ip):
    out.append(interface_ip)
    seen.add(interface_ip)
  for ip in sorted(candidates):
    if not _is_valid_ipv4_candidate(ip):
      continue
    if ip in seen:
      continue
    out.append(ip)
    seen.add(ip)
  return out


@app.route("/api/server_info")
def api_server_info():
  scheme = str(request.scheme or "http")
  port = _server_info_port_from_request()
  if not port:
    port = 443 if scheme == "https" else 80

  candidates = _get_ipv4_candidates()
  preferred_ip = candidates[0] if candidates else ""

  base_urls = []
  for ip in candidates:
    base_urls.append(f"{scheme}://{ip}:{port}")

  suggested_base_url = f"{scheme}://{preferred_ip}:{port}" if preferred_ip else str(request.host_url or "").rstrip("/")
  suggested_controller_url = suggested_base_url + "/?mode=controller"

  return jsonify({
    "ok": True,
    "scheme": scheme,
    "port": int(port),
    "ipv4Candidates": candidates,
    "baseUrls": base_urls,
    "suggestedBaseUrl": suggested_base_url,
    "suggestedControllerUrl": suggested_controller_url,
  })


@app.route("/api/apriltags/stream")
def api_apriltags_stream():
  def event_stream():
    last_sent_seq = -1
    last_sent_controller_seq = -1
    last_keepalive_at = time.time()
    yield "retry: 1000\n\n"

    while not shutdown_event.is_set():
      payload = build_apriltag_payload()
      seq = int(payload.get("seq", 0))
      controller = payload.get("controller") or {}
      controller_seq = int(controller.get("seq", 0))

      if seq != last_sent_seq or controller_seq != last_sent_controller_seq:
        last_sent_seq = seq
        last_sent_controller_seq = controller_seq
        yield "data: " + json.dumps(payload, separators=(",", ":")) + "\n\n"
        last_keepalive_at = time.time()
      else:
        now = time.time()
        if (now - last_keepalive_at) >= 15.0:
          yield ": keepalive\n\n"
          last_keepalive_at = now
        time.sleep(0.01)

  return Response(
    stream_with_context(event_stream()),
    mimetype="text/event-stream",
    headers={
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "X-Accel-Buffering": "no",
    },
  )


def build_apriltag_payload():
  with apriltag_lock:
    detections = list(latest_apriltags)
    updated_at = float(latest_apriltag_updated_at or 0.0)
    seq = int(latest_apriltag_seq or 0)
    error = apriltag_error

  with frame_lock:
    width = int(latest_frame_width or 0)
    height = int(latest_frame_height or 0)
    frame_seq = int(latest_frame_seq or 0)
    frame_updated_at = float(latest_frame_updated_at or 0.0)
  with stream_clients_lock:
    active_stream_clients = int(stream_clients)
  controller = get_controller_state_snapshot()

  payload = {
    "ok": error is None,
    "error": error,
    "detections": detections,
    "seq": seq,
    "frame": {
      "width": width,
      "height": height,
      "seq": frame_seq,
      "updatedAt": frame_updated_at,
    },
    "updatedAt": updated_at,
    "source": str(camera_source),
    "streamClients": active_stream_clients,
    "controller": controller,
  }
  return payload


@app.route("/api/workshop_session", methods=["POST"])
def api_workshop_session():
  payload = request.get_json(silent=True)
  if not isinstance(payload, dict):
    return jsonify({"ok": False, "error": "invalid_json"}), 400

  workshop_id = sanitize_workshop_id(payload.get("workshopId"))
  if not workshop_id:
    return jsonify({"ok": False, "error": "invalid_workshop_id"}), 400

  geojson_payload = payload.get("geojson")
  if not isinstance(geojson_payload, dict):
    return jsonify({"ok": False, "error": "invalid_geojson"}), 400

  setup_definition = payload.get("setupDefinition")
  if setup_definition is not None and not isinstance(setup_definition, dict):
    setup_definition = None

  try:
    workshop_dir = WORKSHOPS_DIR / workshop_id
    workshop_dir.mkdir(parents=True, exist_ok=True)

    session_index = next_workshop_session_index(workshop_dir)
    session_filename = f"session-{session_index:04d}.geojson"
    session_path = workshop_dir / session_filename

    props = geojson_payload.get("properties")
    if not isinstance(props, dict):
      props = {}
      geojson_payload["properties"] = props

    props["workshopId"] = workshop_id
    props["sessionIndex"] = int(session_index)
    props["savedAtEpochMs"] = int(time.time() * 1000)

    session_path.write_text(
      json.dumps(geojson_payload, ensure_ascii=False, indent=2),
      encoding="utf-8"
    )

    workshop_meta_path = workshop_dir / "workshop.json"
    if not workshop_meta_path.exists():
      workshop_meta = {
        "workshopId": workshop_id,
        "createdAtEpochMs": int(time.time() * 1000),
        "setupDefinition": setup_definition,
      }
      workshop_meta_path.write_text(
        json.dumps(workshop_meta, ensure_ascii=False, indent=2),
        encoding="utf-8"
      )
  except Exception as exc:
    return jsonify({"ok": False, "error": str(exc)}), 500

  return jsonify({
    "ok": True,
    "workshopId": workshop_id,
    "sessionIndex": session_index,
    "sessionFile": str(Path("workshops") / workshop_id / session_filename),
  })


@app.route("/api/workshops")
def api_workshops():
  try:
    WORKSHOPS_DIR.mkdir(parents=True, exist_ok=True)
    workshops = []
    for p in WORKSHOPS_DIR.iterdir():
      if not p.is_dir():
        continue
      workshop_id = p.name
      if sanitize_workshop_id(workshop_id) is None:
        continue

      session_pairs = list_workshop_session_files(p)
      latest_session_idx = session_pairs[-1][0] if session_pairs else 0
      workshops.append({
        "workshopId": workshop_id,
        "directory": str(Path("workshops") / workshop_id),
        "sessionCount": len(session_pairs),
        "latestSessionIndex": latest_session_idx,
      })

    workshops.sort(key=lambda w: w["workshopId"])
    return jsonify({"ok": True, "workshops": workshops})
  except Exception as exc:
    return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/api/workshops/<workshop_id>/results")
def api_workshop_results(workshop_id: str):
  workshop_id = sanitize_workshop_id(workshop_id)
  if not workshop_id:
    return jsonify({"ok": False, "error": "invalid_workshop_id"}), 400

  workshop_dir = WORKSHOPS_DIR / workshop_id
  if not workshop_dir.exists() or not workshop_dir.is_dir():
    return jsonify({"ok": False, "error": "workshop_not_found"}), 404

  try:
    session_pairs = list_workshop_session_files(workshop_dir)
    sessions = []
    map_view_groups = {}

    for session_idx, session_path in session_pairs:
      try:
        payload = json.loads(session_path.read_text(encoding="utf-8"))
      except Exception:
        continue

      features = payload.get("features")
      if not isinstance(features, list):
        features = []

      sessions.append({
        "sessionIndex": int(session_idx),
        "sessionFile": session_path.name,
        "featureCount": len(features),
      })

      for feature in features:
        if not isinstance(feature, dict):
          continue
        props = feature.get("properties")
        if not isinstance(props, dict):
          props = {}
          feature["properties"] = props

        map_view_id = normalize_map_view_id(props.get("mapViewId"))
        map_view_name = props.get("mapViewName")
        if not isinstance(map_view_name, str) or not map_view_name.strip():
          map_view_name = f"View {map_view_id}" if map_view_id else "Unassigned"

        key = map_view_id if map_view_id is not None else "unassigned"
        if key not in map_view_groups:
          map_view_groups[key] = {
            "mapViewId": map_view_id,
            "mapViewName": map_view_name,
            "features": [],
            "sessionCount": 0,
            "_session_seen": set(),
          }

        copied_feature = json.loads(json.dumps(feature))
        copied_props = copied_feature.get("properties")
        if not isinstance(copied_props, dict):
          copied_props = {}
          copied_feature["properties"] = copied_props
        copied_props["sessionIndex"] = int(session_idx)
        copied_props["sessionFile"] = session_path.name
        copied_props["workshopId"] = workshop_id
        copied_props["mapViewId"] = map_view_id
        copied_props["mapViewName"] = map_view_name

        map_view_groups[key]["features"].append(copied_feature)
        map_view_groups[key]["_session_seen"].add(session_idx)

    map_views = []
    for key in sorted(map_view_groups.keys(), key=lambda x: (x == "unassigned", str(x))):
      group = map_view_groups[key]
      expected_map_view_id = normalize_map_view_id(group.get("mapViewId"))
      filtered_features = []
      filtered_sessions = set()
      for copied_feature in group.get("features", []):
        if not isinstance(copied_feature, dict):
          continue
        copied_props = copied_feature.get("properties")
        if not isinstance(copied_props, dict):
          copied_props = {}
          copied_feature["properties"] = copied_props
        feature_map_view_id = normalize_map_view_id(copied_props.get("mapViewId"))
        if feature_map_view_id != expected_map_view_id:
          continue
        filtered_features.append(copied_feature)
        session_index = copied_props.get("sessionIndex")
        try:
          filtered_sessions.add(int(session_index))
        except Exception:
          pass

      group["features"] = filtered_features
      group["sessionCount"] = len(filtered_sessions) if filtered_sessions else len(group["_session_seen"])
      del group["_session_seen"]
      if len(group["features"]) < 1:
        continue
      map_views.append(group)

    return jsonify({
      "ok": True,
      "workshopId": workshop_id,
      "directory": str(Path("workshops") / workshop_id),
      "sessions": sessions,
      "mapViews": map_views,
    })
  except Exception as exc:
    return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/<path:path>")
def static_proxy(path: str):
  file_path = ROOT_DIR / path
  if file_path.is_file():
    return send_from_directory(str(ROOT_DIR), path)
  abort(404)


if __name__ == "__main__":
  detected_cores = os.cpu_count() or 4
  default_apriltag_threads = max(1, int(round(detected_cores / 2.0)))

  parser = argparse.ArgumentParser(description="Flask camera stream server with backend AprilTag detection")
  parser.add_argument("--source", default="0", help="Camera index or stream URL")
  parser.add_argument("--host", default="0.0.0.0", help="Host to bind")
  parser.add_argument("--port", type=int, default=5000, help="Port to bind")
  parser.add_argument("--jpeg-quality", type=int, default=100, help="MJPEG quality (1-100)")
  parser.add_argument("--apriltag-fps", type=float, default=45.0, help="Backend AprilTag detection max FPS")
  parser.add_argument("--apriltag-family", default="tag36h11", help="AprilTag family")
  parser.add_argument("--apriltag-threads", type=int, default=default_apriltag_threads, help="AprilTag detector threads")
  parser.add_argument("--apriltag-quad-decimate", type=float, default=1.0, help="AprilTag quad decimate")
  parser.add_argument("--apriltag-quad-sigma", type=float, default=0.0, help="AprilTag quad sigma")
  parser.add_argument("--apriltag-refine-edges", dest="apriltag_refine_edges", action="store_true", help="Enable AprilTag edge refinement")
  parser.add_argument("--no-apriltag-refine-edges", dest="apriltag_refine_edges", action="store_false", help="Disable AprilTag edge refinement")
  parser.set_defaults(apriltag_refine_edges=True)
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
