export function stopCameraStream(stream) {
  if (!stream) return;
  var tracks = stream.getTracks();
  for (var i = 0; i < tracks.length; i++) {
    tracks[i].stop();
  }
}
