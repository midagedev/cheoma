import * as THREE from 'three';
import {
  PRESETS,
  buildBuilding,
  disposeBuilding,
} from '../../src/api/building.js';

const DEFAULT_BUILDING = Object.freeze({ ...PRESETS.giwa });
const BACKGROUND = 0xd9d6c9;

function positiveSize(container, axis, fallback) {
  const value = axis === 'width' ? container.clientWidth : container.clientHeight;
  return Math.max(1, value || fallback);
}

function setBuildingShadows(building) {
  building.traverse((object) => {
    if (!object.isMesh && !object.isInstancedMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });
}

function finiteBounds(building) {
  const bounds = new THREE.Box3().setFromObject(building);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  if (![size.x, size.y, size.z, center.x, center.y, center.z].every(Number.isFinite)) {
    throw new Error('buildBuilding returned non-finite bounds');
  }
  return { bounds, size, center };
}

/**
 * Mount the smallest useful browser integration of the public building API.
 *
 * The returned building is the original buildBuilding root. This owner removes it
 * from the scene before disposeBuilding and separately releases the renderer and
 * ground resources that it created.
 */
export function mountBuildingExample(container, {
  buildingParams = DEFAULT_BUILDING,
  maxPixelRatio = 2,
} = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('mountBuildingExample requires an HTMLElement container');
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  container.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 300);
  const hemisphere = new THREE.HemisphereLight(0xe8edf0, 0x665744, 1.25);
  const sun = new THREE.DirectionalLight(0xffd2a0, 3.1);
  sun.position.set(26, 38, 32);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, {
    left: -18,
    right: 18,
    top: 18,
    bottom: -18,
    near: 1,
    far: 120,
  });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.035;
  scene.add(hemisphere, sun);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(38, 96),
    new THREE.MeshStandardMaterial({
      color: 0xa9aa8b,
      roughness: 1,
      metalness: 0,
    }),
  );
  ground.name = 'api-building-example-ground';
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.045;
  ground.receiveShadow = true;
  scene.add(ground);

  let building = null;
  let disposed = false;
  let resizeCalls = 0;

  function render() {
    if (!disposed) renderer.render(scene, camera);
  }

  function resize() {
    resizeCalls++;
    if (disposed) return;
    const width = positiveSize(container, 'width', window.innerWidth);
    const height = positiveSize(container, 'height', window.innerHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    render();
  }

  function frame(nextBuilding) {
    const { size, center } = finiteBounds(nextBuilding);
    const span = Math.max(size.x, size.z, size.y * 1.5, 1);
    const target = center.clone();
    target.y = Math.max(center.y * 0.82, 1.4);
    camera.position.set(
      center.x + span * 0.68,
      target.y + span * 0.62,
      center.z + span * 1.78,
    );
    camera.near = Math.max(0.05, span * 0.008);
    camera.far = Math.max(160, span * 12);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  }

  function create(params) {
    const next = buildBuilding({ ...params });
    setBuildingShadows(next);
    scene.add(next);
    return next;
  }

  function release(current) {
    if (!current) return false;
    scene.remove(current);
    return disposeBuilding(current);
  }

  function rebuild(params = buildingParams) {
    if (disposed) throw new Error('cannot rebuild a disposed building example');
    const previous = building;
    building = create(params);
    frame(building);
    release(previous);
    render();
    return building;
  }

  function diagnostics() {
    const currentBounds = building ? finiteBounds(building) : null;
    const renderables = [];
    building?.traverse((object) => {
      if (object.isMesh || object.isInstancedMesh) renderables.push(object);
    });
    const materials = renderables.flatMap((object) => (
      Array.isArray(object.material) ? object.material : [object.material]
    )).filter(Boolean);
    const textures = materials.flatMap((material) => (
      Object.values(material).filter((value) => value?.isTexture)
    ));
    return {
      disposed,
      resizeCalls,
      canvasConnected: renderer.domElement.isConnected,
      revision: THREE.REVISION,
      identity: {
        root: building instanceof THREE.Object3D,
        mesh: renderables.length > 0
          && renderables.every((object) => object instanceof THREE.Mesh),
        geometry: renderables.every(
          (object) => object.geometry instanceof THREE.BufferGeometry,
        ),
        material: materials.length > 0
          && materials.every((material) => material instanceof THREE.Material),
        texture: textures.length > 0
          && textures.every((texture) => texture instanceof THREE.Texture),
      },
      bounds: currentBounds ? {
        min: currentBounds.bounds.min.toArray(),
        max: currentBounds.bounds.max.toArray(),
        size: currentBounds.size.toArray(),
      } : null,
      render: {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        programs: renderer.info.programs?.length ?? 0,
      },
    };
  }

  building = create(buildingParams);
  frame(building);
  window.addEventListener('resize', resize);
  resize();

  const api = {
    scene,
    renderer,
    camera,
    get building() {
      return building;
    },
    rebuild,
    diagnostics,
    dispose() {
      if (disposed) return false;
      disposed = true;
      window.removeEventListener('resize', resize);
      release(building);
      building = null;
      scene.remove(ground, hemisphere, sun);
      ground.geometry.dispose();
      ground.material.dispose();
      hemisphere.dispose();
      sun.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      return true;
    },
  };
  return Object.freeze(api);
}

const container = document.getElementById('app');
const example = mountBuildingExample(container);
document.documentElement.dataset.apiBuildingReady = 'true';

if (new URLSearchParams(window.location.search).get('smoke') === '1') {
  const hook = {
    example,
    diagnostics: () => example.diagnostics(),
    dispose() {
      const result = example.dispose();
      if (result) {
        delete document.documentElement.dataset.apiBuildingReady;
        delete window.__CHEOMA_API_BUILDING__;
      }
      return result;
    },
  };
  window.__CHEOMA_API_BUILDING__ = Object.freeze(hook);
}
