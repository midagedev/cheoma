// 개천 호안 형상의 공개 진입점(#20 R4 Phase B). 재질은 props 공유물을 차용하므로 소유권은
//   지오메트리에만 있다 — disposeCreekBanks 는 그 지오메트리만 해제한다.
export {
  CREEK_BANK_MATERIAL_ROLES,
  buildCreekBanks,
  disposeCreekBanks,
} from '../village/creek-bank-geometry.js';
