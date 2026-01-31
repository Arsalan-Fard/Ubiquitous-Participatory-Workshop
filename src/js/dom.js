// List of all required DOM element IDs
var DOM_IDS = [
  'video', 'overlay', 'loading', 'pageTitle', 'gestureControls',
  'pinchThresholdSlider', 'pinchThresholdValue',
  'holdStillThresholdSlider', 'holdStillThresholdValue',
  'dwellTimeSlider', 'dwellTimeValue',
  'pinchHoldTimeSlider', 'pinchHoldTimeValue',
  'fingerSmoothingSlider', 'fingerSmoothingValue',
  'apriltagMoveWindowSlider', 'apriltagMoveWindowValue',
  'apriltagMoveDistanceSlider', 'apriltagMoveDistanceValue',
  'strokeStopDelaySlider', 'strokeStopDelayValue',
  'pointerLostTimeoutSlider', 'pointerLostTimeoutValue',
  'drawingDeselectTimeoutSlider', 'drawingDeselectTimeoutValue',
  'surfaceButtons', 'surfaceBtn1', 'surfaceBtn2', 'surfaceBtn3', 'surfaceBtn4',
  'backBtn', 'startBtn', 'nextBtn', 'stopBtn',
  'cameraSelectRow', 'cameraCountSelect', 'cameraAddBtn', 'cameraDeviceSelects',
  'cameraSourceModal', 'cameraSourceInput', 'cameraSourceSaveBtn', 'cameraSourceCancelBtn',
  'apriltagToggleContainer', 'apriltagToggle',
  'viewToggleContainer', 'viewToggle',
  'apriltagHud', 'apriltagHud2',
  'mapView', 'mapWarp', 'leafletMap', 'mapFingerDots',
  'mapApriltagDots',
  'hamburgerMenu', 'hamburgerBtn', 'hamburgerPanel', 'hamburgerContent',
  'uiSetupOverlay', 'uiSetupPanel', 'mapFingerCursor', 'edgeGuides', 'error'
];

// Mapping from camelCase property names to element IDs
var ID_TO_PROP = {
  'video': 'video',
  'overlay': 'overlay',
  'loading': 'loadingEl',
  'pageTitle': 'pageTitleEl',
  'gestureControls': 'gestureControlsEl',
  'pinchThresholdSlider': 'pinchThresholdSliderEl',
  'pinchThresholdValue': 'pinchThresholdValueEl',
  'holdStillThresholdSlider': 'holdStillThresholdSliderEl',
  'holdStillThresholdValue': 'holdStillThresholdValueEl',
  'dwellTimeSlider': 'dwellTimeSliderEl',
  'dwellTimeValue': 'dwellTimeValueEl',
  'pinchHoldTimeSlider': 'pinchHoldTimeSliderEl',
  'pinchHoldTimeValue': 'pinchHoldTimeValueEl',
  'fingerSmoothingSlider': 'fingerSmoothingSliderEl',
  'fingerSmoothingValue': 'fingerSmoothingValueEl',
  'apriltagMoveWindowSlider': 'apriltagMoveWindowSliderEl',
  'apriltagMoveWindowValue': 'apriltagMoveWindowValueEl',
  'apriltagMoveDistanceSlider': 'apriltagMoveDistanceSliderEl',
  'apriltagMoveDistanceValue': 'apriltagMoveDistanceValueEl',
  'strokeStopDelaySlider': 'strokeStopDelaySliderEl',
  'strokeStopDelayValue': 'strokeStopDelayValueEl',
  'pointerLostTimeoutSlider': 'pointerLostTimeoutSliderEl',
  'pointerLostTimeoutValue': 'pointerLostTimeoutValueEl',
  'drawingDeselectTimeoutSlider': 'drawingDeselectTimeoutSliderEl',
  'drawingDeselectTimeoutValue': 'drawingDeselectTimeoutValueEl',
  'surfaceButtons': 'surfaceButtonsEl',
  'surfaceBtn1': 'surfaceBtn1',
  'surfaceBtn2': 'surfaceBtn2',
  'surfaceBtn3': 'surfaceBtn3',
  'surfaceBtn4': 'surfaceBtn4',
  'backBtn': 'backBtn',
  'startBtn': 'startBtn',
  'nextBtn': 'nextBtn',
  'stopBtn': 'stopBtn',
  'cameraSelectRow': 'cameraSelectRowEl',
  'cameraCountSelect': 'cameraCountSelectEl',
  'cameraAddBtn': 'cameraAddBtnEl',
  'cameraDeviceSelects': 'cameraDeviceSelectsEl',
  'cameraSourceModal': 'cameraSourceModalEl',
  'cameraSourceInput': 'cameraSourceInputEl',
  'cameraSourceSaveBtn': 'cameraSourceSaveBtnEl',
  'cameraSourceCancelBtn': 'cameraSourceCancelBtnEl',
  'apriltagToggleContainer': 'apriltagToggleContainerEl',
  'apriltagToggle': 'apriltagToggleEl',
  'viewToggleContainer': 'viewToggleContainerEl',
  'viewToggle': 'viewToggleEl',
  'apriltagHud': 'apriltagHudEl',
  'apriltagHud2': 'apriltagHud2El',
  'mapView': 'mapViewEl',
  'mapWarp': 'mapWarpEl',
  'leafletMap': 'leafletMapEl',
  'mapFingerDots': 'mapFingerDotsEl',
  'mapApriltagDots': 'mapApriltagDotsEl',
  'hamburgerMenu': 'hamburgerMenuEl',
  'hamburgerBtn': 'hamburgerBtnEl',
  'hamburgerPanel': 'hamburgerPanelEl',
  'hamburgerContent': 'hamburgerContentEl',
  'uiSetupOverlay': 'uiSetupOverlayEl',
  'uiSetupPanel': 'uiSetupPanelEl',
  'mapFingerCursor': 'mapFingerCursorEl',
  'edgeGuides': 'edgeGuidesEl',
  'error': 'errorEl'
};

export function getDom() {
  var dom = {};
  for (var i = 0; i < DOM_IDS.length; i++) {
    var id = DOM_IDS[i];
    var el = document.getElementById(id);
    if (!el) {
      throw new Error('Missing DOM element: ' + id);
    }
    var propName = ID_TO_PROP[id] || id;
    dom[propName] = el;
  }
  return dom;
}
