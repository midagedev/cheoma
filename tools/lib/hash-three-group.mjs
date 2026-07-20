// THREE scene graph의 생성 결과 계약을 비교하는 런타임 독립 해시.
// UUID처럼 생성 순서에 따라 달라지는 값은 제외하고, 렌더 결과를 결정하는 구조·geometry·instance
// buffer·기본 material 값만 접는다. NaN payload 차이는 0으로 정규화한다.
export function hashThreeGroup(group) {
  let a = 2166136261 >>> 0;
  let b = 2654435761 >>> 0;
  let c = 40503 >>> 0;
  let d = 5381 >>> 0;
  let objects = 0;
  let triangles = 0;

  const bits = new Uint32Array(1);
  const float = new Float32Array(bits.buffer);
  const foldBits = (value) => {
    const word = value >>> 0;
    a = Math.imul(a ^ word, 16777619) >>> 0;
    b = Math.imul(b + word, 2246822519) >>> 0;
    c = Math.imul(c ^ (word >>> 13), 3266489917) >>> 0;
    d = (Math.imul(d, 33) + word ^ (word << 7)) >>> 0;
  };
  const foldFloat = (value) => {
    float[0] = Number.isNaN(value) ? 0 : value;
    foldBits(bits[0]);
  };
  const foldString = (value = '') => {
    foldBits(value.length);
    for (let i = 0; i < value.length; i++) foldBits(value.charCodeAt(i));
  };
  const foldArray = (array) => {
    foldBits(array.length);
    for (let i = 0; i < array.length; i++) foldFloat(array[i]);
  };
  const foldAttribute = (name, attribute) => {
    foldString(name);
    foldBits(attribute.itemSize);
    foldBits(attribute.normalized ? 1 : 0);
    foldArray(attribute.array);
  };
  const foldMaterial = (material) => {
    if (!material) return foldString('none');
    foldString(material.type);
    foldString(material.name);
    foldString(material.userData?.role || '');
    if (material.color) foldBits(material.color.getHex());
    if (material.emissive) foldBits(material.emissive.getHex());
    for (const key of ['roughness', 'metalness', 'opacity', 'alphaTest']) {
      if (typeof material[key] === 'number') foldFloat(material[key]);
    }
    foldBits(material.transparent ? 1 : 0);
    foldBits(material.depthWrite ? 1 : 0);
    foldBits(material.side ?? 0);
  };

  group.traverse((object) => {
    objects++;
    foldString(object.type);
    foldString(object.name);
    foldBits(object.visible ? 1 : 0);
    foldBits(object.renderOrder || 0);
    if (object.matrix) foldArray(object.matrix.elements);

    const geometry = object.geometry;
    if (geometry) {
      const names = Object.keys(geometry.attributes).sort();
      foldBits(names.length);
      for (const name of names) foldAttribute(name, geometry.attributes[name]);
      if (geometry.index) foldAttribute('index', geometry.index);
      const primitiveCount = geometry.index?.count ?? geometry.attributes.position?.count ?? 0;
      triangles += primitiveCount / 3 * (object.isInstancedMesh ? object.count : 1);
    }

    if (object.isInstancedMesh) {
      foldBits(object.count);
      foldArray(object.instanceMatrix.array);
      if (object.instanceColor) foldArray(object.instanceColor.array);
    }

    const materials = Array.isArray(object.material) ? object.material : [object.material];
    foldBits(materials.length);
    for (const material of materials) foldMaterial(material);
  });

  return {
    hash: [a, b, c, d].map((value) => value.toString(16).padStart(8, '0')).join(':'),
    objects,
    triangles: Math.round(triangles),
  };
}

function stableValue(value) {
  if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : Object.is(value, -0) ? '-0' : String(value);
  if (value == null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`;
}

/** Hash the non-rendered VillageHandle picking and framing contract. */
export function hashVillagePickProxies(handle) {
  const values = handle.getPickProxies().map((proxy) => ({
    parcelId: proxy.parcelId,
    bbox: [proxy.bbox.min.toArray(), proxy.bbox.max.toArray()],
    worldCenter: proxy.worldCenter.toArray(),
    dims: proxy.dims.toArray(),
    rotY: proxy.rotY,
    buildingSpec: proxy.buildingSpec,
    cameraFraming: {
      position: proxy.cameraFraming.position.toArray(),
      target: proxy.cameraFraming.target.toArray(),
      fov: proxy.cameraFraming.fov,
    },
  }));
  const text = stableValue(values);
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return { hash: hash.toString(16).padStart(8, '0'), count: values.length };
}
