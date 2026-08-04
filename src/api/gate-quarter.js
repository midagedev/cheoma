// Reusable Three adapter for renderer-free city-wall gate-quarter plans.
export {
  GATE_QUARTER_KIND,
  GATE_QUARTER_PLAN_LIMITS,
  GATE_QUARTER_PLAN_SCHEMA_VERSION,
  planGateQuarters,
  validateGateQuarterPlan,
} from './gate-quarter-plan.js';
export {
  buildGateQuarter,
  disposeGateQuarter,
} from '../generators/village/gate-quarter.js';
