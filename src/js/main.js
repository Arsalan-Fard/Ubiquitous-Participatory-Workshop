import { initApp } from './app.js';
import { initControllerMode } from './controllerMode.js';

var mode = '';
try {
  mode = String(new URLSearchParams(window.location.search).get('mode') || '').trim().toLowerCase();
} catch (e) {
  mode = '';
}

if (mode === 'controller') initControllerMode();
else initApp();
