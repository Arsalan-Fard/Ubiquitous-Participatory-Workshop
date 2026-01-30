export function getDom() {
  var video = document.getElementById('video');
  var overlay = document.getElementById('overlay');
  var loadingEl = document.getElementById('loading');
  var pageTitleEl = document.getElementById('pageTitle');
  var surfaceButtonsEl = document.getElementById('surfaceButtons');
  var surfaceBtn1 = document.getElementById('surfaceBtn1');
  var surfaceBtn2 = document.getElementById('surfaceBtn2');
  var surfaceBtn3 = document.getElementById('surfaceBtn3');
  var surfaceBtn4 = document.getElementById('surfaceBtn4');
  var backBtn = document.getElementById('backBtn');
  var startBtn = document.getElementById('startBtn');
  var nextBtn = document.getElementById('nextBtn');
  var stopBtn = document.getElementById('stopBtn');
  var cameraSelectRowEl = document.getElementById('cameraSelectRow');
  var cameraCountSelectEl = document.getElementById('cameraCountSelect');
  var cameraAddBtnEl = document.getElementById('cameraAddBtn');
  var cameraDeviceSelectsEl = document.getElementById('cameraDeviceSelects');
  var apriltagToggleContainerEl = document.getElementById('apriltagToggleContainer');
  var apriltagToggleEl = document.getElementById('apriltagToggle');
  var viewToggleContainerEl = document.getElementById('viewToggleContainer');
  var viewToggleEl = document.getElementById('viewToggle');
  var mapViewEl = document.getElementById('mapView');
  var mapWarpEl = document.getElementById('mapWarp');
  var mapFingerDotsEl = document.getElementById('mapFingerDots');
  var mapHintEl = document.getElementById('mapHint');
  var uiSetupOverlayEl = document.getElementById('uiSetupOverlay');
  var uiSetupPanelEl = document.getElementById('uiSetupPanel');
  var errorEl = document.getElementById('error');

  if (
    !video ||
    !overlay ||
    !loadingEl ||
    !pageTitleEl ||
    !surfaceButtonsEl ||
    !surfaceBtn1 ||
    !surfaceBtn2 ||
    !surfaceBtn3 ||
    !surfaceBtn4 ||
    !backBtn ||
    !startBtn ||
    !nextBtn ||
    !stopBtn ||
    !cameraSelectRowEl ||
    !cameraCountSelectEl ||
    !cameraAddBtnEl ||
    !cameraDeviceSelectsEl ||
    !apriltagToggleContainerEl ||
    !apriltagToggleEl ||
    !viewToggleContainerEl ||
    !viewToggleEl ||
    !mapViewEl ||
    !mapWarpEl ||
    !mapFingerDotsEl ||
    !mapHintEl ||
    !uiSetupOverlayEl ||
    !uiSetupPanelEl ||
    !errorEl
  ) {
    throw new Error('Missing required DOM elements. Check index.html ids.');
  }

  return {
    video: video,
    overlay: overlay,
    loadingEl: loadingEl,
    pageTitleEl: pageTitleEl,
    surfaceButtonsEl: surfaceButtonsEl,
    surfaceBtn1: surfaceBtn1,
    surfaceBtn2: surfaceBtn2,
    surfaceBtn3: surfaceBtn3,
    surfaceBtn4: surfaceBtn4,
    backBtn: backBtn,
    startBtn: startBtn,
    nextBtn: nextBtn,
    stopBtn: stopBtn,
    cameraSelectRowEl: cameraSelectRowEl,
    cameraCountSelectEl: cameraCountSelectEl,
    cameraAddBtnEl: cameraAddBtnEl,
    cameraDeviceSelectsEl: cameraDeviceSelectsEl,
    apriltagToggleContainerEl: apriltagToggleContainerEl,
    apriltagToggleEl: apriltagToggleEl,
    viewToggleContainerEl: viewToggleContainerEl,
    viewToggleEl: viewToggleEl,
    mapViewEl: mapViewEl,
    mapWarpEl: mapWarpEl,
    mapFingerDotsEl: mapFingerDotsEl,
    mapHintEl: mapHintEl,
    uiSetupOverlayEl: uiSetupOverlayEl,
    uiSetupPanelEl: uiSetupPanelEl,
    errorEl: errorEl,
  };
}
