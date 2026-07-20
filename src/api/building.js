// 재사용 가능한 건물·필지 생성 API. 반환값은 THREE.Object3D 계열이다.
export { PRESETS, computeLayout, giwaFootprint, bayPositions } from '../params.js';
export { buildBuilding } from '../builder/index.js';
export { buildParcel } from '../layout/parcel.js';
export { buildHanok } from '../layout/hanok.js';
export { buildPalaceCompound } from '../village/palace.js';
export {
  getTofuBounce,
  playAssembly,
  setTofuBounce,
  tofuBob,
  tofuScale,
} from '../anim/assembly.js';
