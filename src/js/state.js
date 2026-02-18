/**
 * Shared application state
 * All modules can import and modify this state object
 */

import { loadNumberSetting } from './utils.js';


// Create the shared state object
export var state = {
  // DOM reference (set during init)
  dom: null,

  // Core app state
  stage: 1,
  viewMode: 'camera',
  isProcessing: false,
  animationId: null,

  // Camera state
  currentStream: null,
  cameraReady: false,
  cameraStarting: false,
  usingIpCamera: false,
  ipCameraImg: null,

  // Canvas state
  overlayCtx: null,
  captureCanvas: null,
  captureCtx: null,

  // Surface calibration (single camera)
  surfaceCorners: [null, null, null, null],
  armedCornerIndex: null,
  armedCornerTimeoutId: null,
  armedCornerCaptureRequested: false,
  surfaceHomography: null,

  // Gesture controls (stage 3)
  holdStillThresholdPx: loadNumberSetting('holdStillThresholdPx', 14, 2, 80),
  dwellClickMs: loadNumberSetting('dwellClickMs', 3000, 250, 8000),
  pinchHoldMs: loadNumberSetting('pinchHoldMs', 3000, 250, 8000),
  apriltagSuddenMoveWindowMs: loadNumberSetting('apriltagSuddenMoveWindowMs', 200, 50, 1000),
  apriltagSuddenMoveThresholdPx: loadNumberSetting('apriltagSuddenMoveThresholdPx', 60, 10, 300),
  strokeStopDelayMs: loadNumberSetting('strokeStopDelayMs', 50, 0, 500),
  pointerLostTimeoutMs: loadNumberSetting('pointerLostTimeoutMs', 300, 0, 1000),
  drawingDeselectTimeoutMs: loadNumberSetting('drawingDeselectTimeoutMs', 3000, 500, 10000),
  dwellAnchor: null,
  dwellStartMs: 0,
  dwellFired: false,
  pinchStartMs: 0,
  pinchAnchor: null,
  dragActive: false,
  dragTarget: null,
  dragPointerId: 1,
  lastPointerViewport: null,
  crossOriginClickWarned: false,
  mapFingerCursorProgressCircleEl: null,

  // Stage 4 drawing
  stage4DrawMode: false,
  stage4DrawColor: '#2bb8ff',
  stage4IsDrawing: false,
  stage4LastDrawContainerPt: null,
  stage4ActiveStroke: null,
  drawGroup: null,
  routeGroup: null,
  isovistGroup: null,
  buildingsGroup: null,

  // Stage 3 participant setup (AprilTags)
  stage3ParticipantCount: 0,
  stage3ParticipantTagIds: [],
  stage3ParticipantTriggerTagIds: [],
  stage3SecondaryVisibleByPrimaryTag: {},

  // AprilTag tracking offsets (for participant tags 10-30)
  apriltagTrackingOffsetX: loadNumberSetting('apriltagTrackingOffsetX', 0, -500, 500),
  apriltagTrackingOffsetY: loadNumberSetting('apriltagTrackingOffsetY', 0, -500, 500),
  apriltagTriggerTrackingOffsetX: loadNumberSetting('apriltagTriggerTrackingOffsetX', 0, -500, 500),
  apriltagTriggerTrackingOffsetY: loadNumberSetting('apriltagTriggerTrackingOffsetY', 0, -500, 500),
  apriltagOffsetBottomCompressionPct: loadNumberSetting('apriltagOffsetBottomCompressionPct', 0, 0, 60),
  apriltagPrimaryOffsetGrid: null,
  apriltagPrimaryOffsetCalibActive: false,
  apriltagPrimaryOffsetCalibIndex: 0,
  apriltagTouchCalibTagId: loadNumberSetting('apriltagTouchCalibTagId', 11, 0, 9999),
  apriltagTouchCalibCornerAreaPx: [null, null, null, null],
  apriltagTouchCalibCornerSampleCornersPx: [null, null, null, null],
  apriltagTouchCalibCornerUvSideLen: [null, null, null, null],
  apriltagTouchHoverAreaRatio: loadNumberSetting('apriltagTouchHoverAreaRatio', 1.06, 1.01, 5),
  apriltagTouchTouchAreaRatio: loadNumberSetting('apriltagTouchTouchAreaRatio', 1.05, 1.0, 5),
  apriltagTouchHoverUvSideRatio: loadNumberSetting('apriltagTouchHoverUvSideRatio', 1.06, 1.01, 5),
  apriltagTouchTouchUvSideRatio: loadNumberSetting('apriltagTouchTouchUvSideRatio', 1.05, 1.0, 5),
  apriltagTouchDebounceMs: loadNumberSetting('apriltagTouchDebounceMs', 0, 0, 2000),
  apriltagTouchMaxUvSquareError: loadNumberSetting('apriltagTouchMaxUvSquareError', 0.35, 0, 2),

  // AprilTag detections (latest frame)
  lastApriltagDetections: null,
  apriltagTouchById: null,
  remoteControllerToolByTriggerTagId: {},
  remoteControllerNoteStateByTriggerTagId: {},
  remoteControllerDrawTriggerTagIds: [],

  // MapLibre / Maptastic
  map: null,
  mapReady: false,
  maptasticInitialized: false,

  // Map session state
  currentMapSessionId: null,

  // UI state
  hamburgerOpen: false,
  viewToggleDockParent: null,
  viewToggleDockNextSibling: null
};
