import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * Create the app-owned three.js scene primitives.
 *
 * This is deliberately limited to renderer, scene, lights, ground, camera, and
 * orbit controls. Domain systems (village, weather, post effects) are wired by
 * engine.js so the core remains framework-agnostic.
 */
export function createSceneRuntime({ container, pixelRatioCap = 2, shadowSize = 4096 }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, pixelRatioCap));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.debug.checkShaderErrors = true;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xcfd8e0);
  scene.fog = new THREE.Fog(0xcfd8e0, 60, 220);

  const sun = new THREE.DirectionalLight(0xfff0dd, 2.6);
  sun.position.set(30, 42, 26);
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.camera.left = -22;
  sun.shadow.camera.right = 22;
  sun.shadow.camera.top = 22;
  sun.shadow.camera.bottom = -22;
  sun.shadow.bias = -0.0001;
  sun.shadow.normalBias = 0.05;
  scene.add(sun);

  const hemi = new THREE.HemisphereLight(0xbdd0e4, 0x8a7a63, 0.9);
  scene.add(hemi);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(160, 48),
    new THREE.MeshStandardMaterial({ color: 0xb5a893, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const camera = new THREE.PerspectiveCamera(
    28,
    container.clientWidth / container.clientHeight,
    0.1,
    500,
  );
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minPolarAngle = 0.03;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0;

  // The shadow span has to follow how much world the frame shows: a 44m ortho box is right
  // for an eye-level house but leaves the aerial village almost shadowless (measured: the
  // box covered 15% of the frame width at the settled aerial pose, so only the few central
  // buildings cast anything and the frame read as flat). createDirectionalShadowRuntime
  // resolves the span from this camera. Both objects are owned here, which is why the
  // reference is handed over on the light rather than through engine.js.
  // `window.__noShadowSpan` is the A/B hook for the before/after measurement (same role as
  // __noGroundCushion / __noWarm): with it set the box stays at the authored ±22 rung.
  if (typeof window === 'undefined' || !window.__noShadowSpan) {
    sun.userData.shadowViewCamera = camera;
  }

  return { renderer, scene, sun, hemi, ground, camera, controls };
}
