/**
 * Shared utility functions
 */

// Clamp a value between min and max
export function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Safely call a function, ignoring any errors
export function safe(fn) {
  try { fn(); } catch (e) { /* ignore */ }
}

// Load a number from localStorage with fallback
export function loadNumberSetting(key, fallback, min, max) {
  var raw = localStorage.getItem(key);
  if (!raw) return fallback;
  var v = parseFloat(raw);
  if (!isFinite(v)) return fallback;
  if (typeof min === 'number') v = Math.max(min, v);
  if (typeof max === 'number') v = Math.min(max, v);
  return v;
}

// Save a number to localStorage
export function saveNumberSetting(key, value) {
  if (isFinite(value)) {
    localStorage.setItem(key, String(value));
  }
}

// Load custom camera sources from localStorage
export function loadCustomCameraSources() {
  var raw = localStorage.getItem('customCameraSources');
  if (!raw) return [];
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(function(v) { return v && v.trim(); }).map(function(v) { return v.trim(); });
}

// Save custom camera sources to localStorage
export function saveCustomCameraSources(sources) {
  localStorage.setItem('customCameraSources', JSON.stringify(sources || []));
}

// Create a canvas with 2D context
export function createCanvas(width, height) {
  var canvas = document.createElement('canvas');
  canvas.width = width || 1;
  canvas.height = height || 1;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  return { canvas: canvas, ctx: ctx };
}

// Wait for an image to load
export function waitForImageLoad(imgEl, url) {
  return new Promise(function(resolve, reject) {
    function onLoad() {
      imgEl.removeEventListener('load', onLoad);
      imgEl.removeEventListener('error', onError);
      resolve();
    }
    function onError() {
      imgEl.removeEventListener('load', onLoad);
      imgEl.removeEventListener('error', onError);
      reject(new Error('Image load failed'));
    }
    imgEl.addEventListener('load', onLoad);
    imgEl.addEventListener('error', onError);

    // Bust cache for snapshot endpoints
    var cacheBustedUrl = url + (url.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now();
    imgEl.src = cacheBustedUrl;
  });
}
