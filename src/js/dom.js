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
  var startBtn = document.getElementById('startBtn');
  var nextBtn = document.getElementById('nextBtn');
  var stopBtn = document.getElementById('stopBtn');
  var apriltagToggleEl = document.getElementById('apriltagToggle');
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
    !startBtn ||
    !nextBtn ||
    !stopBtn ||
    !apriltagToggleEl ||
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
    startBtn: startBtn,
    nextBtn: nextBtn,
    stopBtn: stopBtn,
    apriltagToggleEl: apriltagToggleEl,
    errorEl: errorEl,
  };
}
