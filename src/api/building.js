// 재사용 가능한 건물·필지 생성 API. buildBuilding 원본은 disposeBuilding으로 해제한다.
// P.mats를 주입하면 그 공유 팔레트는 호출측 소유로 남고 건물 파생 리소스만 해제된다.
export { PRESETS, computeLayout, giwaFootprint, giwaFootprintPolygon, bayPositions } from '../params.js';
export { buildBuilding, disposeBuilding } from '../builder/index.js';
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
