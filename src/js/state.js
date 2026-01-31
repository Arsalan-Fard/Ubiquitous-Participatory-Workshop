/**
 * Shared application state
 * All modules can import and modify this state object
 */

import { loadNumberSetting, loadCustomCameraSources } from './utils.js';

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
  currentStream2: null,
  cameraReady: false,
  cameraStarting: false,
  usingIpCamera: false,
  ipCameraImg: null,
  pixelReadBlockedNotified: false,
  availableVideoDevices: [],
  customCameraSources: loadCustomCameraSources(),

  // Detection state
  detector: null,
  detectorLoading: false,
  apriltagEnabled: false,
  handDetector: null,
  handDetectorReady: false,
  handDetector2: null,
  handDetectorReady2: false,

  // Canvas state
  overlayCtx: null,
  captureCanvas: null,
  captureCtx: null,
  captureCanvas2: null,
  captureCtx2: null,

  // Surface calibration (single camera)
  surfaceCorners: [null, null, null, null],
  armedCornerIndex: null,
  armedCornerTimeoutId: null,
  armedCornerCaptureRequested: false,
  surfaceHomography: null,

  // Stereo calibration
  stereoMode: false,
  stereoCalibrationPoints: [],
  stereoProjectionMatrix1: null,
  stereoProjectionMatrix2: null,
  stereoCalibrationReady: false,
  stereoArmedPointIndex: null,
  stereoArmedTimeoutId: null,
  touchZThreshold: 0.05,
  ELEVATED_Z: 0.1,
  STEREO_WORLD_POSITIONS: null, // Set during init

  // Finger tracking
  lastIndexTipPoint: null,
  lastIndexTipPoints: null,
  lastIndexTipTimeMs: 0,

  // Finger smoothing (exponential moving average)
  // Higher value = more smoothing (0-1, where 1 = no smoothing, 0.1 = heavy smoothing)
  fingerSmoothingFactor: loadNumberSetting('fingerSmoothingFactor', 0.4, 0.1, 1.0),
  smoothedFingerPositions: {}, // keyed by handId: { x, y }

  // Gesture controls (stage 3)
  pinchDistanceThresholdPx: loadNumberSetting('pinchDistanceThresholdPx', 45, 10, 120),
  holdStillThresholdPx: loadNumberSetting('holdStillThresholdPx', 14, 2, 80),
  dwellClickMs: loadNumberSetting('dwellClickMs', 3000, 250, 8000),
  pinchHoldMs: loadNumberSetting('pinchHoldMs', 3000, 250, 8000),
  PINCH_RATIO_THRESHOLD: 0.35,
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
  stage4DrawLayer: null,

  // Leaflet/Maptastic
  leafletGlobal: null,
  leafletMap: null,
  leafletTileLayer: null,
  maptasticInitialized: false,

  // UI state
  hamburgerOpen: false,
  viewToggleDockParent: null,
  viewToggleDockNextSibling: null
};

// Initialize stereo world positions (depends on ELEVATED_Z)
state.STEREO_WORLD_POSITIONS = [
  // Surface level (Z=0): 8 points
  { x: 0, y: 0, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: 1, y: 1, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0.5, y: 0, z: 0 },
  { x: 1, y: 0.5, z: 0 },
  { x: 0.5, y: 1, z: 0 },
  { x: 0, y: 0.5, z: 0 },
  // Elevated level: 4 points
  { x: 0, y: 0, z: state.ELEVATED_Z },
  { x: 1, y: 0, z: state.ELEVATED_Z },
  { x: 1, y: 1, z: state.ELEVATED_Z },
  { x: 0, y: 1, z: state.ELEVATED_Z }
];
