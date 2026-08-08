// Export-only material texture strip for Node GLB paths.
// GLTFExporter.processImage requires a DOM `document` for canvas/image embeds;
// Node has no document, so textures must be omitted before parse.
// Callers must pass an export-only tree (or accept mesh.material pointer replacement
// with clones). Original material objects are never mutated.

/** Known three.js material texture slots (MeshStandard/Physical + legacy). */
const TEXTURE_SLOTS = Object.freeze([
  'map',
  'lightMap',
  'aoMap',
  'emissiveMap',
  'bumpMap',
  'normalMap',
  'displacementMap',
  'roughnessMap',
  'metalnessMap',
  'alphaMap',
  'envMap',
  'specularMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'transmissionMap',
  'thicknessMap',
  'anisotropyMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
]);

function isTextureLike(value) {
  return !!(value && typeof value === 'object' && value.isTexture === true);
}

/**
 * Shallow-clone each mesh material and null every texture slot.
 * Replaces `mesh.material` references on the given tree only.
 * Shared materials map to one clone (export dedup).
 *
 * @param {import('three').Object3D} root
 * @returns {import('three').Object3D} the same root (mutated material pointers)
 */
export function stripMaterialTextures(root) {
  if (!root || typeof root.traverse !== 'function') {
    throw new TypeError('stripMaterialTextures: root must be a three Object3D');
  }
  const cache = new Map();
  const stripOne = (material) => {
    if (!material) return material;
    if (cache.has(material)) return cache.get(material);
    const clone = material.clone();
    for (const slot of TEXTURE_SLOTS) {
      if (clone[slot] != null) clone[slot] = null;
    }
    // Catch any other Texture-typed properties not listed above.
    for (const key of Object.keys(clone)) {
      if (isTextureLike(clone[key])) clone[key] = null;
    }
    cache.set(material, clone);
    return clone;
  };

  root.traverse((node) => {
    if (!node.isMesh && !node.isInstancedMesh) return;
    if (Array.isArray(node.material)) {
      node.material = node.material.map(stripOne);
    } else {
      node.material = stripOne(node.material);
    }
  });
  return root;
}

export { TEXTURE_SLOTS };
