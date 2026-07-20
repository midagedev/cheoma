// DOM과 THREE에 의존하지 않는 마을 계획 API.
// 외부 프로젝트, Web Worker, 빠른 Node 계약 검사는 이 진입점만 사용한다.
export { planVillage } from '../village/plan.js';
export {
  SCALE_ANCHORS,
  siteConfigFor,
  resolveSiteR,
  scale01ToR,
  rToScale01,
  tierForR,
  makeSite,
} from '../village/site.js';
export { ROAD_WIDTH } from '../village/roads.js';
