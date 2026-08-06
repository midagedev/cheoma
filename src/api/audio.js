// 브라우저 Web Audio 기반 환경음·음악 오케스트레이터의 공개 API.
export { setupAudio } from '../audio/index.js';
// 1인칭 도보 발소리·착지음(합성). 케이던스 상수는 배선부(도보 런타임)가 보폭 기준으로 쓴다.
export { createFootsteps, LAND_MIN_MPS, STRIDE_RUN, STRIDE_WALK } from '../audio/footsteps.js';
// Pure positional-anchor helpers (village stream / 풍경 eave corners). No AudioContext.
export {
  chimeLocalCorners,
  chimeLayoutParams,
  chimeWorldCorners,
  nearestStreamAnchor,
  pickChimeParcel,
} from '../audio/anchors.js';
