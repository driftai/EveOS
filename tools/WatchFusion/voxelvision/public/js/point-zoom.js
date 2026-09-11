import { Vector3 } from '../vendor/three.module.js';

function waitForApp(timeoutMs = 5000) {
  if (window.app) return Promise.resolve(window.app);
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const timer = setInterval(() => {
      if (window.app) {
        clearInterval(timer);
        resolve(window.app);
      } else if (performance.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error('VoxelVision app did not initialize in time.'));
      }
    }, 25);
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeWheelDelta(event, canvas) {
  let pixels = Number(event.deltaY) || 0;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) pixels *= 16;
  else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) pixels *= Math.max(1, canvas.clientHeight);
  return pixels;
}

async function installPointZoom() {
  const app = await waitForApp();
  const scene = app.scene;
  const controls = scene?.controls;
  const camera = scene?.camera;
  const canvas = scene?.renderer?.domElement || app.canvas;
  if (!scene || !controls || !camera || !canvas) throw new Error('3D controls are unavailable.');

  // Native OrbitControls perspective dolly is exponential. Even with a tiny
  // zoomSpeed it still produces an awkward wide-vs-close feel on this scene.
  // VoxelVision owns wheel and middle-drag distance from here onward.
  controls.enableZoom = false;
  controls.zoomToCursor = false;
  controls.mouseButtons.MIDDLE = -1;

  const state = {
    minDistance: 14,
    maxDistance: 125,
    desiredDistance: camera.position.distanceTo(controls.target),
    desiredTarget: controls.target.clone(),
    active: false,
    lastFrameAt: performance.now()
  };

  const forward = new Vector3();
  const pointerPoint = new Vector3();
  const pointerDirection = new Vector3();
  const targetOffset = new Vector3();
  const cameraOffset = new Vector3();
  const nextTarget = new Vector3();

  function applyBounds() {
    const heightScale = Math.max(1, Number(scene.uniforms?.uHeightScale?.value) || 16);
    const graphClearance = Math.max(12, heightScale * 0.34 + 6);
    const tvClearance = Math.max(18, heightScale * 0.72 + 7);

    state.minDistance = scene.tvMode ? tvClearance : graphClearance;
    state.maxDistance = scene.tvMode ? 115 : 125;

    // Keep OrbitControls bounds in agreement even though its own dolly is off.
    controls.minDistance = state.minDistance;
    controls.maxDistance = state.maxDistance;

    state.desiredDistance = clamp(state.desiredDistance, state.minDistance, state.maxDistance);
  }

  function syncFromCamera() {
    applyBounds();
    state.desiredDistance = clamp(
      camera.position.distanceTo(controls.target),
      state.minDistance,
      state.maxDistance
    );
    state.desiredTarget.copy(controls.target);
    state.active = false;
  }

  function pointerFocus(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return controls.target;

    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);

    pointerPoint.set(ndcX, ndcY, 0.15).unproject(camera);
    pointerDirection.copy(pointerPoint).sub(camera.position).normalize();
    camera.getWorldDirection(forward).normalize();

    const denominator = pointerDirection.dot(forward);
    if (Math.abs(denominator) < 0.08) return controls.target;

    targetOffset.copy(controls.target).sub(camera.position);
    const targetDepth = targetOffset.dot(forward);
    const rayDistance = targetDepth / denominator;
    if (!Number.isFinite(rayDistance) || rayDistance <= 0) return controls.target;

    return pointerPoint.copy(camera.position).addScaledVector(pointerDirection, rayDistance);
  }

  function queueDistanceChange(distanceDelta, clientX, clientY) {
    if (!Number.isFinite(distanceDelta) || Math.abs(distanceDelta) < 0.0001) return;

    const before = state.desiredDistance;
    state.desiredDistance = clamp(before + distanceDelta, state.minDistance, state.maxDistance);

    // Mild point guidance only while moving inward. The old zoom-to-cursor path
    // let the cursor ray move the orbit target aggressively, which contributed
    // to the close/far discontinuity. Here it nudges focus without hijacking it.
    if (distanceDelta < 0 && Number.isFinite(clientX) && Number.isFinite(clientY)) {
      const focus = pointerFocus(clientX, clientY);
      const fraction = clamp(Math.abs(distanceDelta) / Math.max(20, before), 0, 0.045);
      state.desiredTarget.lerp(focus, fraction);
    }

    state.active = true;
  }

  function onWheel(event) {
    const pixels = normalizeWheelDelta(event, canvas);
    if (!pixels) return;

    // About 2.4 world units per conventional 100px wheel notch. Trackpads emit
    // much smaller deltas and therefore get correspondingly finer movement.
    const distanceDelta = clamp(pixels / 100, -3, 3) * 2.4;
    queueDistanceChange(distanceDelta, event.clientX, event.clientY);

    event.preventDefault();
    event.stopImmediatePropagation();
  }

  // Capture phase prevents OrbitControls' own wheel listener from ever seeing
  // the event, guaranteeing there is only one zoom algorithm active.
  canvas.addEventListener('wheel', onWheel, { capture: true, passive: false });

  let dragging = false;
  let pointerId = null;
  let lastY = 0;

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 1) return;
    dragging = true;
    pointerId = event.pointerId;
    lastY = event.clientY;
    try { canvas.setPointerCapture(pointerId); } catch {}
    event.preventDefault();
    event.stopPropagation();
  }, true);

  canvas.addEventListener('pointermove', event => {
    if (!dragging || event.pointerId !== pointerId) return;
    const deltaY = event.clientY - lastY;
    lastY = event.clientY;

    // Linear middle-drag: 100 px is about 8 world units. This is intentionally
    // predictable and has no acceleration curve or synthetic wheel events.
    queueDistanceChange(deltaY * 0.08, event.clientX, event.clientY);
    event.preventDefault();
    event.stopPropagation();
  }, true);

  function finishDrag(event) {
    if (!dragging || (event.pointerId != null && event.pointerId !== pointerId)) return;
    dragging = false;
    try { canvas.releasePointerCapture(pointerId); } catch {}
    pointerId = null;
    event.preventDefault?.();
  }

  canvas.addEventListener('pointerup', finishDrag, true);
  canvas.addEventListener('pointercancel', finishDrag, true);
  canvas.addEventListener('auxclick', event => {
    if (event.button === 1) event.preventDefault();
  });

  // Orbit/pan gestures should take ownership immediately rather than being
  // pulled toward an old zoom target.
  controls.addEventListener('start', () => {
    if (!dragging) syncFromCamera();
  });

  const originalSetCameraPreset = scene.setCameraPreset.bind(scene);
  scene.setCameraPreset = preset => {
    originalSetCameraPreset(preset);
    syncFromCamera();
  };

  scene.updateCameraBounds = () => {
    applyBounds();
    if (!state.active) syncFromCamera();
  };

  document.getElementById('heightSlider')?.addEventListener('input', applyBounds);

  function animate(timestamp) {
    requestAnimationFrame(animate);
    const dt = clamp((timestamp - state.lastFrameAt) / 1000, 0, 0.05);
    state.lastFrameAt = timestamp;
    if (!state.active) return;

    const currentDistance = camera.position.distanceTo(controls.target);
    const distanceAlpha = 1 - Math.exp(-dt * 8.5);
    const targetAlpha = 1 - Math.exp(-dt * 6.0);
    const nextDistance = currentDistance + (state.desiredDistance - currentDistance) * distanceAlpha;

    nextTarget.copy(controls.target).lerp(state.desiredTarget, targetAlpha);
    cameraOffset.copy(camera.position).sub(controls.target);
    if (cameraOffset.lengthSq() < 1e-8) cameraOffset.set(0, 0, 1);
    cameraOffset.normalize().multiplyScalar(nextDistance);

    controls.target.copy(nextTarget);
    camera.position.copy(nextTarget).add(cameraOffset);
    camera.lookAt(controls.target);
    camera.updateMatrixWorld();

    const distanceDone = Math.abs(state.desiredDistance - nextDistance) < 0.015;
    const targetDone = controls.target.distanceToSquared(state.desiredTarget) < 0.0004;
    if (distanceDone && targetDone) {
      cameraOffset.copy(camera.position).sub(controls.target).normalize().multiplyScalar(state.desiredDistance);
      camera.position.copy(state.desiredTarget).add(cameraOffset);
      controls.target.copy(state.desiredTarget);
      camera.lookAt(controls.target);
      state.active = false;
    }
  }

  applyBounds();
  syncFromCamera();
  requestAnimationFrame(animate);

  console.info('VoxelVision linear camera zoom enabled: eased wheel + linear middle-drag + mild cursor focus.');
}

window.addEventListener('DOMContentLoaded', () => {
  installPointZoom().catch(error => {
    console.warn('VoxelVision point zoom unavailable:', error);
  });
});
