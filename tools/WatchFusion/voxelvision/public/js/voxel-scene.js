/**
 * VoxelVision 3D Scene & Shader Pipeline
 * High-performance instanced voxel rendering with GPU depth extrusion,
 * retro CRT TV cabinet model, and audio-reactive lighting.
 */

import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/OrbitControls.js';

function depthFrameScale(frame) {
  if (frame instanceof Float32Array || frame instanceof Float64Array) return 1;
  if (frame instanceof Uint8Array || frame instanceof Uint8ClampedArray) return 1 / 255;

  // Keep compatibility with any future typed-array/cache formats. Probe a
  // small prefix rather than scanning the whole frame every render update.
  let maxSample = 0;
  const sampleCount = Math.min(frame?.length || 0, 64);
  for (let i = 0; i < sampleCount; i++) {
    const value = Number(frame[i]);
    if (Number.isFinite(value) && value > maxSample) maxSample = value;
  }
  return maxSample > 1.5 ? 1 / 255 : 1;
}

export class VoxelScene {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.normalPixelRatio = Math.min(window.devicePixelRatio, 2);
    this.loadingPixelRatio = Math.min(window.devicePixelRatio, 1);
    this.performanceMode = 'loading';
    this.lastRenderAt = -Infinity;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      // Snapshot capture renders and reads synchronously, so retaining every
      // back buffer only wastes GPU bandwidth during normal playback.
      preserveDrawingBuffer: false
    });
    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(this.loadingPixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x06070c);
    this.scene.fog = new THREE.Fog(0x06070c, 60, 180);

    // Camera
    this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.1, 1000);
    this.camera.position.set(28, 30, 38);

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 4, 0);
    this.controls.maxPolarAngle = Math.PI * 0.95;
    this.controls.minDistance = 18;
    this.controls.maxDistance = 110;
    this.controls.zoomSpeed = 0.65;

    // Lighting
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
    this.scene.add(this.ambientLight);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
    this.keyLight.position.set(20, 40, 30);
    this.scene.add(this.keyLight);

    this.rimCoolLight = new THREE.PointLight(0x00f0ff, 2.0, 90);
    this.rimCoolLight.position.set(-25, 20, -20);
    this.scene.add(this.rimCoolLight);

    this.rimWarmLight = new THREE.PointLight(0xff0077, 2.0, 90);
    this.rimWarmLight.position.set(25, 15, -20);
    this.scene.add(this.rimWarmLight);

    // Reactive Floor Grid
    this.createFloorGrid();

    // Voxel Uniforms & Material
    this.uniforms = {
      uTvMode: { value: 0.0 },
      uDepthBlend: { value: 0.0 },
      uHeightScale: { value: 16.0 },
      uBaseHeight: { value: 0.5 },
      uBeatReact: { value: 0.0 }
    };

    this.voxelMaterial = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      reflectivity: 0.3
    });

    this.voxelMaterial.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        attribute float instanceDepthA;
        attribute float instanceDepthB;
        uniform float uTvMode;
        uniform float uDepthBlend;
        uniform float uHeightScale;
        uniform float uBaseHeight;
        uniform float uBeatReact;`
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `float rawDepth = mix(instanceDepthA, instanceDepthB, uDepthBlend);
        float instanceHeight = uBaseHeight + (rawDepth * uHeightScale) + (uBeatReact * rawDepth * 5.0);

        vec3 floorVoxel = vec3(position.x, (position.y + 0.5) * instanceHeight, position.z);
        vec3 tvVoxel    = vec3(position.x, position.y, (position.z + 0.5) * instanceHeight);
        vec3 transformed = mix(floorVoxel, tvVoxel, uTvMode);`
      );
    };
    this.voxelMaterial.customProgramCacheKey = () => 'voxelvision-gpu-displacement-v1';

    // InstancedMesh container
    this.instancedMesh = null;
    this.attrDepthA = null;
    this.attrDepthB = null;
    this.baseSpan = 36.0;

    // TV Cabinet
    this.tvGroup = this.buildTvCabinet();
    this.scene.add(this.tvGroup);
    this.tvGroup.visible = false;

    // State
    this.tvMode = false;
    this.autoOrbit = false;
    this.orbitSpeed = 0.4;
    this.colorMode = 'video';
    this.gap = 0.08;
    this.heightScale = 16.0;
    this.updateCameraBounds();

    // Resize Handler
    window.addEventListener('resize', () => this.onResize());
  }

  createFloorGrid() {
    const size = 120;
    const divisions = 60;
    this.floorGrid = new THREE.GridHelper(size, divisions, 0x00f0ff, 0x182035);
    this.floorGrid.position.y = -0.05;
    this.scene.add(this.floorGrid);
  }

  buildTvCabinet() {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x1e1915, // Retro dark woodgrain plastic
      roughness: 0.6,
      metalness: 0.1
    });
    const bezelMat = new THREE.MeshStandardMaterial({
      color: 0x121418,
      roughness: 0.4,
      metalness: 0.2
    });
    const chromeMat = new THREE.MeshStandardMaterial({
      color: 0xcccccc,
      roughness: 0.2,
      metalness: 0.8
    });
    this.tvLedMat = new THREE.MeshBasicMaterial({
      color: 0x00ff88
    });

    const w = 42, h = 32, d = 20;

    // Main Outer Chassis
    const cabinetGeo = new THREE.BoxGeometry(w, h, d);
    const cabinet = new THREE.Mesh(cabinetGeo, bodyMat);
    cabinet.position.set(0, h / 2, -d / 2 + 1);
    group.add(cabinet);

    // Screen Bezel Opening
    const bezelGeo = new THREE.BoxGeometry(37, 27, 2);
    const bezel = new THREE.Mesh(bezelGeo, bezelMat);
    bezel.position.set(0, h / 2, 0.5);
    group.add(bezel);

    // Power Indicator LED
    const ledGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.4, 16);
    this.tvLed = new THREE.Mesh(ledGeo, this.tvLedMat);
    this.tvLed.rotation.x = Math.PI / 2;
    this.tvLed.position.set(-17, 2.5, 1.8);
    group.add(this.tvLed);

    // Channel Knobs
    for (let i = 0; i < 2; i++) {
      const knobGeo = new THREE.CylinderGeometry(1.2, 1.2, 0.8, 24);
      const knob = new THREE.Mesh(knobGeo, chromeMat);
      knob.rotation.x = Math.PI / 2;
      knob.position.set(16.5, 8 + i * 4.5, 1.6);
      group.add(knob);
    }

    // Retro Antennas
    for (let side of [-1, 1]) {
      const antGeo = new THREE.CylinderGeometry(0.18, 0.25, 16, 8);
      const ant = new THREE.Mesh(antGeo, chromeMat);
      ant.position.set(side * 6, h + 7, -d / 2);
      ant.rotation.z = side * 0.45;
      ant.rotation.x = -0.2;
      group.add(ant);
    }

    return group;
  }

  setupVoxelMesh(cols, rows) {
    const totalCells = cols * rows;

    if (this.instancedMesh && this.instancedMesh.count >= totalCells) {
      this.instancedMesh.count = totalCells;
      this.cols = cols;
      this.rows = rows;
      this.updateVoxelTransforms();
      return;
    }

    if (this.instancedMesh) {
      this.scene.remove(this.instancedMesh);
      this.instancedMesh.geometry.dispose();
      this.instancedMesh = null;
    }

    this.cols = cols;
    this.rows = rows;

    // Base unit cube
    const unitGeo = new THREE.BoxGeometry(1, 1, 1);
    this.instancedMesh = new THREE.InstancedMesh(unitGeo, this.voxelMaterial, totalCells);
    this.instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // Instance Color buffer
    this.colorArray = new Uint8Array(totalCells * 3);
    this.instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(this.colorArray, 3, true);
    this.instancedMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    // Instance Depth buffers (normalized 0.0 - 1.0)
    this.depthArrayA = new Float32Array(totalCells);
    this.depthArrayB = new Float32Array(totalCells);

    this.attrDepthA = new THREE.InstancedBufferAttribute(this.depthArrayA, 1);
    this.attrDepthB = new THREE.InstancedBufferAttribute(this.depthArrayB, 1);
    this.attrDepthA.setUsage(THREE.DynamicDrawUsage);
    this.attrDepthB.setUsage(THREE.DynamicDrawUsage);

    unitGeo.setAttribute('instanceDepthA', this.attrDepthA);
    unitGeo.setAttribute('instanceDepthB', this.attrDepthB);

    this.instancedMesh.frustumCulled = false;
    this.scene.add(this.instancedMesh);

    this.updateVoxelTransforms();
  }

  updateVoxelTransforms() {
    if (!this.instancedMesh) return;

    const { cols, rows } = this;
    const total = cols * rows;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();

    // Scale footprint
    const step = this.baseSpan / cols;
    const voxelW = step * (1.0 - this.gap);
    const startX = -this.baseSpan / 2 + step / 2;
    const totalHeight = rows * step;
    const startY = this.tvMode ? 16 + totalHeight / 2 - step / 2 : -totalHeight / 2 + step / 2;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const posX = startX + c * step;

        if (this.tvMode) {
          position.set(posX, startY - r * step, 0);
          scale.set(voxelW, voxelW, 1.0);
        } else {
          position.set(posX, 0, startY + r * step);
          scale.set(voxelW, 1.0, voxelW);
        }

        matrix.compose(position, quaternion, scale);
        this.instancedMesh.setMatrixAt(idx, matrix);
      }
    }

    this.instancedMesh.instanceMatrix.addUpdateRange(0, total * 16);
    this.instancedMesh.instanceMatrix.needsUpdate = true;
  }

  updateCameraBounds() {
    const heightScale = Math.max(1, Number(this.uniforms?.uHeightScale?.value) || 16);
    const graphClearance = Math.max(14, heightScale * 0.65 + 8);
    const tvClearance = heightScale + 8;

    this.controls.maxDistance = 110;
    const safeMinimum = this.tvMode ? tvClearance : graphClearance;
    this.controls.minDistance = Math.min(this.controls.maxDistance - 5, safeMinimum);
  }

  setTvMode(enabled) {
    this.tvMode = enabled;
    this.uniforms.uTvMode.value = enabled ? 1.0 : 0.0;
    this.tvGroup.visible = enabled;
    this.floorGrid.visible = !enabled;
    this.updateCameraBounds();
    this.updateVoxelTransforms();

    if (enabled) this.setCameraPreset('tv');
    else this.setCameraPreset('isometric');
  }

  setCameraPreset(preset) {
    switch (preset) {
      case 'tv':
        this.camera.position.set(0, 16, 42);
        this.controls.target.set(0, 16, 0);
        break;
      case 'isometric':
        this.camera.position.set(28, 30, 38);
        this.controls.target.set(0, 4, 0);
        break;
      case 'side':
        this.camera.position.set(40, 12, 10);
        this.controls.target.set(0, 6, 0);
        break;
      case 'top':
        this.camera.position.set(0, 65, 0.1);
        this.controls.target.set(0, 0, 0);
        break;
    }
    this.updateCameraBounds();
    this.controls.update();
  }

  updateDepthBuffers(frameA, frameB, blend) {
    if (!this.attrDepthA || !this.attrDepthB || !frameA || !frameB) return;

    const len = this.cols * this.rows;
    const scaleA = depthFrameScale(frameA);
    const scaleB = depthFrameScale(frameB);
    for (let i = 0; i < len; i++) {
      this.depthArrayA[i] = THREE.MathUtils.clamp(Number(frameA[i] ?? 0) * scaleA, 0, 1);
      this.depthArrayB[i] = THREE.MathUtils.clamp(Number(frameB[i] ?? 0) * scaleB, 0, 1);
    }

    this.attrDepthA.addUpdateRange(0, len);
    this.attrDepthB.addUpdateRange(0, len);
    this.attrDepthA.needsUpdate = true;
    this.attrDepthB.needsUpdate = true;
    this.uniforms.uDepthBlend.value = blend;
  }

  updateColors(pixelData, brightness = 1.0, contrast = 1.0) {
    if (!this.instancedMesh) return;

    const total = this.cols * this.rows;
    const colors = this.colorArray;
    const mode = this.colorMode;

    for (let i = 0; i < total; i++) {
      const srcIdx = i * 4;
      const dstIdx = i * 3;

      let r = pixelData[srcIdx];
      let g = pixelData[srcIdx + 1];
      let b = pixelData[srcIdx + 2];

      if (contrast !== 1.0 || brightness !== 1.0) {
        r = Math.min(255, Math.max(0, ((r - 128) * contrast + 128) * brightness));
        g = Math.min(255, Math.max(0, ((g - 128) * contrast + 128) * brightness));
        b = Math.min(255, Math.max(0, ((b - 128) * contrast + 128) * brightness));
      }

      if (mode === 'cyberpunk') {
        const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
        colors[dstIdx] = Math.round(lum * 255);
        colors[dstIdx + 1] = Math.round((1 - lum) * 180 + 30);
        colors[dstIdx + 2] = 255;
      } else if (mode === 'phosphor') {
        const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
        colors[dstIdx] = Math.round(lum * 30);
        colors[dstIdx + 1] = Math.round(lum * 255);
        colors[dstIdx + 2] = Math.round(lum * 60);
      } else if (mode === 'sketch') {
        let lum = (r * 0.299 + g * 0.587 + b * 0.114);
        lum = lum > 140 ? 250 : lum < 70 ? 25 : 120;
        colors[dstIdx] = lum;
        colors[dstIdx + 1] = lum;
        colors[dstIdx + 2] = lum;
      } else {
        colors[dstIdx] = r;
        colors[dstIdx + 1] = g;
        colors[dstIdx + 2] = b;
      }
    }

    this.instancedMesh.instanceColor.addUpdateRange(0, total * 3);
    this.instancedMesh.instanceColor.needsUpdate = true;
  }

  updateAudioEffects(audioState, deltaTime) {
    if (this.tvLedMat) {
      const pulseIntensity = 0.4 + audioState.pulse * 1.6;
      this.tvLedMat.color.setRGB(0, pulseIntensity, 0.4 * pulseIntensity);
    }

    const coolIntensity = 1.0 + audioState.bass * 3.0;
    const warmIntensity = 1.0 + audioState.high * 2.5;
    this.rimCoolLight.intensity = THREE.MathUtils.lerp(this.rimCoolLight.intensity, coolIntensity, 0.2);
    this.rimWarmLight.intensity = THREE.MathUtils.lerp(this.rimWarmLight.intensity, warmIntensity, 0.2);
    this.uniforms.uBeatReact.value = audioState.pulse * 0.8;
  }

  setPerformanceMode(mode) {
    const next = mode === 'loading' ? 'loading' : 'normal';
    if (next === this.performanceMode) return;
    this.performanceMode = next;
    const ratio = next === 'loading' ? this.loadingPixelRatio : this.normalPixelRatio;
    this.renderer.setPixelRatio(ratio);
  }

  render(deltaTime = 0.016, { force = false } = {}) {
    const now = performance.now();
    if (!force && this.performanceMode === 'loading' && now - this.lastRenderAt < 1000 / 30) return false;
    this.lastRenderAt = now;
    if (this.autoOrbit) {
      const angle = deltaTime * this.orbitSpeed;
      this.camera.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    }

    this.updateCameraBounds();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    return true;
  }

  onResize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height);
  }

  captureSnapshot() {
    const previousRatio = this.renderer.getPixelRatio();
    if (previousRatio !== this.normalPixelRatio) this.renderer.setPixelRatio(this.normalPixelRatio);
    this.render(0, { force: true });
    const snapshot = this.canvas.toDataURL('image/png');
    if (previousRatio !== this.normalPixelRatio) this.renderer.setPixelRatio(previousRatio);
    return snapshot;
  }
}
