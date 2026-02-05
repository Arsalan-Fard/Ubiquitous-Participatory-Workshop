/**
 * Hand tracking has been removed from this project.
 *
 * This module remains only for backward compatibility with older imports.
 * All callers should use AprilTag detections instead.
 */

export async function initHandDetector() {
  return null;
}

export function getHandDetector() {
  return null;
}

export function destroyAllHandDetectors() {
  // no-op
}
