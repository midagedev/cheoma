// URL 쿼리 ↔ 상태 양방향 동기화. seed 는 항상, 나머지(preset/time/sunset/season/weather/mode/exp)는
// 사용자가 명시적으로 바꿨을 때만 URL 에 실어 공유 시 정확히 재현되게 한다.
import { newSeed } from './seed.js';

import { normalizeSunsetLook } from '../../../src/api/environment.js';
import { normalizeRenderStyle } from '../../../src/api/render-style.js';
import {
  RESIDENTIAL_EDIT_QUERY_KEY,
  decodeResidentialEditState,
  encodeResidentialEditState,
} from './residential-edit-url.js';
import {
  SCENE_SNAPSHOT_QUERY_KEY,
  buildSceneSnapshotUrl,
  decodeSceneSnapshot,
} from './scene-snapshot.js';
import {
  VILLAGE_SCALE_IDS,
  buildSceneShareUrl,
} from './share-scene.js';

const KEYS = ['seed', 'preset', 'time', 'sunset', 'season', 'weather', 'exp'];

const CHARS = ['minchon', 'yeoyeom', 'banchon'];

function urlStateFromSnapshot(snapshot) {
  const village = snapshot.village;
  return {
    seed: snapshot.seed,
    hasSeed: true,
    preset: snapshot.preset,
    time: snapshot.time,
    sunsetLook: snapshot.sunsetLook,
    season: snapshot.season,
    weather: snapshot.weather,
    renderStyle: snapshot.renderStyle,
    exp: snapshot.expansion > 1 ? snapshot.expansion : null,
    hero: false,
    shot: false,
    flow: snapshot.flow,
    flowsec: null,
    village: !!village,
    vseed: village?.seed ?? null,
    vscale: village?.scale ?? null,
    vchar: village?.character ?? null,
    vpalace: village?.includePalace ?? false,
    vtemple: village?.includeTemple ?? false,
    villageOptions: village,
    residentialEdits: snapshot.residentialEdits,
    focusedParcelId: snapshot.focusedParcelId,
    sceneView: snapshot.view,
    standaloneParams: snapshot.standaloneParams,
    sceneSnapshot: true,
  };
}

export function readUrl() {
  const q = new URLSearchParams(location.search);
  const snapshot = decodeSceneSnapshot(q.get(SCENE_SNAPSHOT_QUERY_KEY));
  if (snapshot) return urlStateFromSnapshot(snapshot);
  const out = {};
  for (const k of KEYS) { if (q.has(k)) out[k] = q.get(k); }
  const seed = out.seed != null ? (parseInt(out.seed, 10) >>> 0) : newSeed();
  const vseedRaw = q.get('vseed');
  const residentialEdits = decodeResidentialEditState(q.get(RESIDENTIAL_EDIT_QUERY_KEY));
  return {
    seed,
    hasSeed: out.seed != null,
    preset: out.preset || null,
    time: out.time || null,
    sunsetLook: out.sunset != null ? normalizeSunsetLook(out.sunset) : null,
    season: out.season || null,
    weather: out.weather || null,
    renderStyle: normalizeRenderStyle(q.get('mode')),
    exp: out.exp != null ? Math.max(1, parseInt(out.exp, 10) || 1) : null,
    hero: q.get('hero') !== '0',
    shot: q.get('shot') === '1',
    // 오토로테이션("시간 흐르기" #64): flow=1 활성 복원, flowsec=N 은 스텝 간격(초) 검증용 오버라이드.
    flow: q.get('flow') === '1',
    flowsec: (() => { const v = parseFloat(q.get('flowsec')); return Number.isFinite(v) && v > 0 ? v : null; })(),
    // 마을 모드
    village: q.get('village') === '1',
    vseed: vseedRaw != null ? (parseInt(vseedRaw, 10) >>> 0) : null,
    vscale: VILLAGE_SCALE_IDS.includes(q.get('vscale')) ? q.get('vscale') : null,
    vchar: CHARS.includes(q.get('vchar')) ? q.get('vchar') : null,
    vpalace: q.get('vpalace') === '1',
    vtemple: q.get('vtemple') === '1',
    residentialEdits: residentialEdits?.records || [],
    focusedParcelId: residentialEdits?.focusedParcelId || null,
    villageOptions: null,
    sceneView: null,
    standaloneParams: {},
    sceneSnapshot: false,
  };
}

// 현재 상태를 URL 에 반영(pushState 없이 replaceState — 히스토리 오염 방지).
//   village: 마을 모드일 때 { seed, scale, character, includePalace, includeTemple } — 없으면 마을 파라미터 제거.
export function writeUrl(state, {
  overrides = {}, village = null, flow = false, residentialEdits = [], focusedParcelId = null,
  view = null, standaloneParams = {}, canonical = false,
} = {}) {
  if (canonical) {
    const portable = buildSceneSnapshotUrl({
      baseUrl: location.href,
      state,
      overrides,
      village,
      flow,
      residentialEdits,
      focusedParcelId,
      view,
      standaloneParams,
    });
    if (!portable) return false;
    const next = new URL(portable);
    history.replaceState(null, '', `${next.pathname}${next.search}`);
    return true;
  }
  const q = new URLSearchParams(location.search);
  // A non-canonical/legacy write must remove any stale scene payload first;
  // otherwise the snapshot decoder would win over the mutable legacy keys on
  // the next reload. Canonical sessions stay in the branch above.
  q.delete(SCENE_SNAPSHOT_QUERY_KEY);
  q.set('seed', String(state.seed >>> 0));
  const put = (k, v, cond) => { if (cond) q.set(k, String(v)); else q.delete(k); };
  put('preset', state.preset, overrides.preset);
  put('time', state.time, overrides.time);
  put('sunset', state.sunsetLook, overrides.sunsetLook);
  put('season', state.season, overrides.season);
  put('weather', state.weather, overrides.weather);
  put('mode', state.renderStyle, state.renderStyle === 'ink');
  put('exp', state.expansion, state.expansion > 1);
  put('flow', 1, !!flow); // 오토로테이션 활성 상태 공유(#64)
  // 마을 모드 파라미터
  put('village', 1, !!village);
  put('vseed', village && (village.seed >>> 0), !!village);
  put('vscale', village && village.scale, !!village && village.scale !== 'village');
  put('vchar', village && village.character, !!village && village.character !== 'yeoyeom');
  put('vpalace', 1, !!village && village.includePalace);
  put('vtemple', 1, !!village && village.includeTemple);
  const editPayload = encodeResidentialEditState({ records: residentialEdits, focusedParcelId });
  put(RESIDENTIAL_EDIT_QUERY_KEY, editPayload, !!village && !!editPayload);
  const url = `${location.pathname}?${q.toString()}`;
  history.replaceState(null, '', url);
  return true;
}

export function shareUrl(state, overrides, {
  village = null, flow = false, residentialEdits = [], focusedParcelId = null, view = null,
  standaloneParams = {},
} = {}) {
  return buildSceneShareUrl({
    baseUrl: location.href,
    state,
    overrides,
    village,
    flow,
    residentialEdits,
    focusedParcelId,
    view,
    standaloneParams,
  });
}
