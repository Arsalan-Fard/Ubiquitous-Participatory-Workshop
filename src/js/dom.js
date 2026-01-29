export function getDom() {
  const video = document.getElementById('video');
  const overlay = document.getElementById('overlay');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const apriltagToggleEl = document.getElementById('apriltagToggle');
  const errorEl = document.getElementById('error');

  if (!video || !overlay || !startBtn || !stopBtn || !apriltagToggleEl || !errorEl) {
    throw new Error('Missing required DOM elements. Check index.html ids.');
  }

  return {
    video,
    overlay,
    startBtn,
    stopBtn,
    apriltagToggleEl,
    errorEl,
  };
}
