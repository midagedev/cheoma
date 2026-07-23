// Reusable, borrowed-material sijeon renderer and explicit lifecycle API.
export {
  SIJEON_FACADE_BAYS,
  SIJEON_FACADE_SCHEMA_VERSION,
  SIJEON_PLACEMENT,
  planSijeon,
  planSijeonFacade,
} from './sijeon-plan.js';
export {
  buildSijeon,
  disposeSijeon,
} from '../generators/village/sijeon.js';
