import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CONFIG } from "../core/config.js";
import { createEarth } from "./earth.js";
import { createStarfield } from "./stars.js";
import { createFocusController } from "./focus-controller.js";
import { createCelestialSystem } from "./celestial-system.js";

function sphericalDirection(azimuthDegrees, elevationDegrees) {
  const azimuth = THREE.MathUtils.degToRad(azimuthDegrees);
  const elevation = THREE.MathUtils.degToRad(elevationDegrees);
  const cosElevation = Math.cos(elevation);

  return new THREE.Vector3(
    Math.cos(azimuth) * cosElevation,
    Math.sin(elevation),
    Math.sin(azimuth) * cosElevation
  ).normalize();
}

function loadTexture(source, onProgress) {
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    const objectUrl = source instanceof Blob ? URL.createObjectURL(source) : null;
    const url = objectUrl || source;

    loader.load(
      url,
      (texture) => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        onProgress?.(1);
        resolve(texture);
      },
      (event) => {
        if (event?.total) onProgress?.(event.loaded / event.total);
        else onProgress?.(0.65);
      },
      (error) => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        reject(error || new Error("World texture failed to load."));
      }
    );
  });
}

function configureWorldTexture(texture) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 16;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function createMapFrame(width, height) {
  const group = new THREE.Group();

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(width + 0.34, height + 0.34),
    new THREE.MeshBasicMaterial({
      color: 0x020611,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  shadow.position.z = -0.10;
  group.add(shadow);

  const backing = new THREE.Mesh(
    new THREE.PlaneGeometry(width + 0.20, height + 0.20),
    new THREE.MeshBasicMaterial({
      color: 0x09162f,
      transparent: true,
      opacity: 0.90,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  backing.position.z = -0.075;
  group.add(backing);

  const edgeGeometry = new THREE.EdgesGeometry(
    new THREE.PlaneGeometry(width + 0.20, height + 0.20)
  );
  const edge = new THREE.LineSegments(
    edgeGeometry,
    new THREE.LineBasicMaterial({
      color: 0x49b8ff,
      transparent: true,
      opacity: 0.42,
    })
  );
  edge.position.z = -0.045;
  group.add(edge);

  group.visible = false;
  return { group, shadow, backing, edge };
}

function configureControlsForProjection(controls, blend, planetScale = 1) {
  const normalizedBlend = THREE.MathUtils.clamp(blend, 0, 1);
  const isGlobe = normalizedBlend < 0.02;
  const isFlat = normalizedBlend > 0.98;
  const scale = THREE.MathUtils.clamp(planetScale, 0.45, 2.0);

  controls.enableRotate = !isFlat;
  controls.enablePan = !isGlobe;
  controls.screenSpacePanning = true;
  controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
  controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;

  if (isGlobe) {
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    controls.touches.ONE = THREE.TOUCH.ROTATE;
  } else if (isFlat) {
    controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    controls.touches.ONE = THREE.TOUCH.PAN;
  } else {
    // Keep full orbital pitch/yaw while the world still has curvature.
    // Panning remains available on right drag throughout the transition.
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    controls.touches.ONE = THREE.TOUCH.ROTATE;
  }

  controls.minDistance = THREE.MathUtils.lerp(
    CONFIG.globeMinDistance, CONFIG.flatMinDistance, normalizedBlend,
  ) * scale;
  controls.maxDistance = THREE.MathUtils.lerp(
    CONFIG.globeMaxDistance, CONFIG.flatMaxDistance, normalizedBlend,
  ) * scale;
}

function isWorldBookEmbedded() {
  return new URLSearchParams(window.location.search).get("embedded") === "world-book";
}

export async function createScene(
  container, state, onProgress, initialSurface = null, initialCelestialBodies = [],
) {
  const embeddedInWorldBook = isWorldBookEmbedded();
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(
    window.devicePixelRatio || 1,
    embeddedInWorldBook ? 1.35 : 2,
  ));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const normalBackground = new THREE.Color(0x020611);
  const pureFlatBackground = new THREE.Color(0x050b18);
  scene.background = normalBackground.clone();
  scene.fog = new THREE.FogExp2(0x020611, 0.0045);

  const camera = new THREE.PerspectiveCamera(
    46,
    window.innerWidth / window.innerHeight,
    0.1,
    300
  );
  camera.position.set(...CONFIG.initialCamera);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.055;
  controls.enablePan = false;
  controls.target.set(0, 0, 0);
  configureControlsForProjection(
    controls, state.projectionBlend ?? 0.0, state.planetScale ?? 1.0,
  );
  controls.update();

  const starfield = createStarfield();
  scene.add(starfield);

  const ambient = new THREE.AmbientLight(0xbfdcff, 0.38);
  scene.add(ambient);

  const hemisphere = new THREE.HemisphereLight(0x86cbff, 0x06101c, 0.42);
  scene.add(hemisphere);

  const sunLight = new THREE.DirectionalLight(0xffffff, 1.15);
  scene.add(sunLight);

  let texture = configureWorldTexture(await loadTexture(
    initialSurface?.textureSource || CONFIG.textureUrl,
    onProgress,
  ));

  const mapFrame = createMapFrame(CONFIG.flatWidth, CONFIG.flatHeight);
  scene.add(mapFrame.group);

  const earth = createEarth(
    texture,
    CONFIG.earthRadius,
    CONFIG.flatWidth,
    CONFIG.flatHeight,
    state
  );
  scene.add(earth.group);

  const celestialSystem = createCelestialSystem(scene, initialCelestialBodies);

  let spinPaused = false;
  const spinPauseReasons = new Set();
  let interactionRevision = 0;
  let globeSpinAngle = 0.0;
  const focusController = createFocusController({ camera, controls, earth, state });
  function onControlStart() {
    interactionRevision += 1;
    focusController.cancelFocus();
  }
  controls.addEventListener("start", onControlStart);

  let cloudOffset = 0.0;
  const clock = new THREE.Clock();

  function resetView() {
    focusController.cancelFocus();
    const blend = state.projectionBlend ?? 0.0;
    const cameraPreset = blend > 0.5 ? CONFIG.flatCamera : CONFIG.initialCamera;

    camera.position.set(...cameraPreset);
    controls.target.set(0, 0, 0);
    configureControlsForProjection(controls, blend, state.planetScale ?? 1.0);
    controls.update();
  }

  function setPaused(nextPaused) {
    spinPaused = !!nextPaused;
  }

  function setSpinPauseReason(reason, paused) {
    const key = String(reason || "external");
    if (paused) spinPauseReasons.add(key);
    else spinPauseReasons.delete(key);
    return spinPaused || spinPauseReasons.size > 0;
  }

  function getPlanetViewState() {
    const direction = camera.position.clone().sub(controls.target);
    if (direction.lengthSq() < 1e-12) direction.set(0, 0, 1);
    direction.normalize();
    const worldRotation = earth.group.getWorldQuaternion(new THREE.Quaternion());
    direction.applyQuaternion(worldRotation.invert()).normalize();
    return {
      centerDirection: direction.toArray(),
      normalizedDistance: camera.position.distanceTo(controls.target)
        / Math.max(0.001, CONFIG.earthRadius * earth.group.scale.x),
    };
  }

  function applyPlanetViewState(viewState) {
    const values = viewState?.centerDirection;
    if (!Array.isArray(values) || values.length !== 3
      || values.some((value) => !Number.isFinite(Number(value)))) return false;
    const localDirection = new THREE.Vector3(...values.map(Number));
    if (localDirection.lengthSq() < 1e-12) return false;
    focusController.cancelFocus();
    localDirection.normalize().applyQuaternion(
      earth.group.getWorldQuaternion(new THREE.Quaternion()),
    );
    const damping = controls.enableDamping;
    try {
      // Drain any unfinished user-orbit delta before setting the shared view;
      // otherwise the hidden Portal camera would keep drifting after handoff.
      controls.enableDamping = false;
      controls.update();
      const currentDistance = camera.position.distanceTo(controls.target);
      const requestedDistance = Number(viewState.normalizedDistance)
        * CONFIG.earthRadius * earth.group.scale.x;
      const distance = Number.isFinite(requestedDistance) && requestedDistance > 0
        ? THREE.MathUtils.clamp(requestedDistance, controls.minDistance, controls.maxDistance)
        : currentDistance;
      controls.target.set(0, 0, 0);
      camera.position.copy(localDirection.multiplyScalar(distance));
      controls.update();
    } finally {
      controls.enableDamping = damping;
    }
    return true;
  }

  async function setWorldSurface(surface, progress) {
    const source = surface?.textureSource || surface?.textureUrl;
    if (!source) throw new Error("The selected world has no map image.");
    const nextTexture = configureWorldTexture(await loadTexture(source, progress));
    const previousTexture = texture;
    texture = nextTexture;
    earth.setTexture(nextTexture);
    previousTexture?.dispose();
    return nextTexture;
  }

  function setProjectionBlend(value) {
    state.projectionBlend = THREE.MathUtils.clamp(value, 0, 1);
    applyState(state);
  }

  function applyState(nextState) {
    const blend = THREE.MathUtils.clamp(nextState.projectionBlend ?? 0.0, 0, 1);
    const lightDirection = sphericalDirection(
      nextState.lightAzimuthDegrees,
      nextState.lightElevationDegrees
    );

    sunLight.position.copy(lightDirection.clone().multiplyScalar(6));
    earth.updateFromState({ ...nextState, lightDirection });

    const planetScale = THREE.MathUtils.clamp(nextState.planetScale ?? 1.0, 0.45, 2.0);
    earth.group.scale.setScalar(planetScale);
    mapFrame.group.scale.setScalar(planetScale);
    celestialSystem.setScale(planetScale);
    earth.group.rotation.z = THREE.MathUtils.degToRad(
      THREE.MathUtils.lerp(CONFIG.axialTiltDegrees, 0, blend)
    );
    earth.group.rotation.y = globeSpinAngle * (1.0 - blend);

    const pureFlatActive = !!nextState.pureFlat && blend > 0.92;
    celestialSystem.setVisible(
      nextState.satellitesVisible !== false && blend < 0.97 && !pureFlatActive,
    );
    starfield.visible = !pureFlatActive;

    mapFrame.group.visible = blend > 0.46;
    const frameOpacity = THREE.MathUtils.smoothstep(blend, 0.46, 1.0);
    mapFrame.shadow.material.opacity = frameOpacity * (pureFlatActive ? 0.72 : 0.42);
    mapFrame.backing.material.opacity = frameOpacity * (pureFlatActive ? 0.96 : 0.78);
    mapFrame.edge.material.opacity = frameOpacity * (pureFlatActive ? 0.64 : 0.36);

    scene.background.copy(pureFlatActive ? pureFlatBackground : normalBackground);

    if (nextState.fullLight) {
      ambient.intensity = 1.18;
      hemisphere.intensity = 0.65;
      sunLight.intensity = 0.18;
    } else {
      ambient.intensity = 0.38;
      hemisphere.intensity = 0.42;
      sunLight.intensity = 1.15;
    }

    configureControlsForProjection(controls, blend, planetScale);
  }

  function resize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  window.addEventListener("resize", resize);

  const embeddedFrameInterval = 1000 / 45;
  let lastRenderedAt = -Infinity;
  renderer.setAnimationLoop((time) => {
    if (embeddedInWorldBook && time - lastRenderedAt < embeddedFrameInterval) return;
    lastRenderedAt = time;

    const delta = Math.min(clock.getDelta(), 0.05);
    const blend = THREE.MathUtils.clamp(state.projectionBlend ?? 0.0, 0, 1);

    if (!spinPaused && spinPauseReasons.size === 0) {
      const visibleSpin = 1.0 - blend;
      globeSpinAngle = (globeSpinAngle + (
        (state.spinSpeed ?? 0) * CONFIG.spinReferenceFps * delta * visibleSpin
      )) % (Math.PI * 2);
      earth.group.rotation.y = globeSpinAngle * visibleSpin;

      celestialSystem.update(delta);
    }

    cloudOffset = (
      cloudOffset + delta * (state.cloudDriftSpeed ?? 0.025)
    ) % 1.0;
    earth.updateCloudOffset(cloudOffset);

    controls.update();
    renderer.render(scene, camera);
  });

  applyState(state);

  return {
    renderer,
    scene,
    camera,
    controls,
    earth,
    celestialSystem,
    setCelestialBodies: celestialSystem.setBodies,
    mapFrame,
    resetView,
    setPaused,
    setSpinPauseReason,
    getPlanetViewState,
    applyPlanetViewState,
    getInteractionRevision: () => interactionRevision,
    setWorldSurface,
    applyState,
    setProjectionBlend,
    focusCoordinates: focusController.focusCoordinates,
    cancelFocus: focusController.cancelFocus,
    focusFlatMap() {
      state.projectionBlend = 1;
      applyState(state);
      resetView();
    },
    focusGlobe() {
      state.projectionBlend = 0;
      state.pureFlat = false;
      applyState(state);
      resetView();
    },
    dispose() {
      renderer.setAnimationLoop(null);
      window.removeEventListener("resize", resize);
      controls.removeEventListener("start", onControlStart);
      controls.dispose();
      celestialSystem.dispose();
      renderer.dispose();
    },
  };
}
