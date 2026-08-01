// 개천 호안 계획의 공개 진입점(#20 R4 Phase B). Three·DOM 비의존·JSON-safe 계층만 노출한다.
//   내부 모듈은 이 파일을 import 하지 않는다(src/api 는 소비자용 façade다).
export {
  planCreekBanks,
  CREEK_BANK_LIMITS,
  CREEK_BANK_PLAN_SCHEMA_VERSION,
} from '../village/creek-bank-plan.js';
