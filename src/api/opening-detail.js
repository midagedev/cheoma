// Public, renderer-free changho grammar for generators and focused interaction.
// Internal builders import the implementation directly; app/other projects use
// this façade so the src/api boundary remains one-way.
export {
  OPENING_DETAIL_KINDS,
  OPENING_DETAIL_STYLES,
  planOpeningDetail,
} from '../builder/opening-detail-plan.js';
