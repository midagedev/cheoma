import * as THREE from 'three';
import { buildBuilding } from '../../builder/index.js';
import { applyThatchAge } from '../../builder/palette.js';
import { PRESETS } from '../../params.js';
import { parcelMatrix, decomposeByMaterial, mirrorDecomp, shareMaterials } from '../../village/instancing.js';
import { parcelRotY } from '../shared/parcel-transform.js';
import { buildVillageWall } from '../../village/walls.js';
import { CHOGA_VARIANTS, GIWA_VARIANTS } from '../../village/variants.js';
import { chunkLodDistance } from '../../village/chunks.js';

// ───────────────────────── 집 프로토타입 ─────────────────────────
// buildBuilding(초가/기와) 로 프로토타입을 만들어 clone. 종가·궁·절은 풀디테일 별도.
export function makeHouseProtos() {
  return {
    choga: buildBuilding(PRESETS.choga),
    giwa: buildBuilding(PRESETS.giwa),
  };
}

// 평면 변주 풀 → 변주 인덱스별 decompose 결과 배열(미러 포함). 재질셋은 kind당 1벌로 통일(shareMaterials)
//   → 텍스처·재질 수 고정, 드로우콜은 변주×재질 규모. matset(=canon 프로토 재질)은 야간 창호광용.
export function buildKindDecomps(kind) {
  const VAR = kind === 'giwa' ? GIWA_VARIANTS : CHOGA_VARIANTS;
  const base = PRESETS[kind];
  const isChoga = kind !== 'giwa';
  const decomps = new Array(VAR.length);
  let canon = null, matset = null;
  for (let i = 0; i < VAR.length; i++) {
    if (VAR[i].mirrorOf != null) continue;                 // 미러 항목은 2패스에서
    const proto = buildBuilding({ ...base, ...(VAR[i].ov || {}) });
    const M = proto.userData.materials;
    // 재질 공유 제외(변주별 고유 유지): (1) choga 이엉 상태 채(thatch/yongmaru/jipjul, 민가=낡음↔부농=신선),
    //   (2) giwa 창호 살 패턴(#55, 변주별 doorPattern 텍스처 — 공유 시 g-base 띠살이 g-wide 를 덮어씀).
    //   choga 창호는 패턴 단일이라 공유 유지(텍스처 절약).
    let ownSet = null;
    if (isChoga) {
      applyThatchAge(M, VAR[i].thatchAge != null ? VAR[i].thatchAge : 0.5);
      ownSet = new Set([M.thatch, M.yongmaru, M.jipjul]);
    }
    const keepOwn = (m) => (ownSet && ownSet.has(m))
      || (!isChoga && m && m.userData && m.userData.role === 'opening');
    if (!matset) matset = M;                                // canon 재질셋(창호광)
    let d = decomposeByMaterial(proto);                     // 프로토로컬 병합(지오 clone)
    d = canon ? shareMaterials(canon, d, keepOwn) : d;      // 재질 refs 를 canon 으로 통일(이엉 제외)
    if (!canon) canon = d;
    decomps[i] = d;
  }
  for (let i = 0; i < VAR.length; i++) {
    if (VAR[i].mirrorOf != null) decomps[i] = mirrorDecomp(decomps[VAR[i].mirrorOf]);
  }
  return { decomps, matset };
}

// 필지 → 컴파운드(집 + 마당 담). rot 은 로컬 +z 를 도로쪽(frontDir+yaw)으로. 비최적화(디버그) 경로.
export function placeParcel(parcel, protos, wallMats, char01 = 0.5) {
  const g = new THREE.Group();
  g.name = `parcel-${parcel.kind}`;
  const kind = parcel.kind;
  // 집 본체(디버그 경로는 기본 프로토만 — 변주 스케일은 반영, 평면 변주는 최적화 경로 전용)
  const house = (kind === 'giwa' ? protos.giwa : protos.choga).clone(true);
  const back = -parcel.plotD / 2 + (kind === 'giwa' ? 5.2 : 3.4);
  house.position.set(0, 0, back);
  house.scale.set(parcel.sx || 1, parcel.sy || 1, parcel.sz || 1);
  g.add(house);
  // 마당 담 — 유형(tile/stone/brush)·부속채 어휘. 필지 부정형 shape 를 따라 변별 담.
  g.add(buildVillageWall(parcel.shape, wallMats, {
    style: parcel.wallType || 'stone', kind: parcel.kind, seed: parcel.seed, char01,
    aux: parcel.aux, plotW: parcel.plotW, plotD: parcel.plotD,
    wallHeightK: parcel.wallHeightK, jangdok: parcel.jangdok,
    yardStack: parcel.yardStack, clothesline: parcel.clothesline, vegBed: parcel.vegBed,
  }));
  g.rotation.y = parcelRotY(parcel);
  g.position.set(parcel.center.x, parcel.baseY || 0, parcel.center.z);
  g.userData.parcel = parcel;
  return g;
}

// 원경 청크 런타임 LOD 스왑 — 카메라가 다가오면 저폴리 임포스터 → 풀디테일 전환.
//   #92 자유 줌 이후 한양 스케일에서 줌인해도 원경 박스 매스가 그대로 보이던 문제 해소.
//   카메라-청크 소유 필지의 최소 수평거리를 매 프레임 판정해 visible 토글.
//   히스테리시스(진입/복귀 분리)로
//   경계 왕복 플리커 방지. far 청크만 대상(near 청크는 항상 풀디테일).
export function attachChunkLodSwap(chunkGroup, impostor, fullDetail, chunk, bowlR) {
  // 카메라가 청크의 어느 필지든 bowlR의 절반 안으로 들어오면 원본을 복원한다. 공간상
  // far 분류와 카메라 LOD 임계는 별개이며, 히스테리시스로 경계 왕복 시 깜빡임을 막는다.
  const swapIn = bowlR * 0.45;
  const swapOut = bowlR * 0.53;
  let showFull = false;

  // 반환: 이 프레임에 스왑(임포스터↔풀디테일 토글)이 일어나면 true — 렌더 루프(#140-E)가 그림자 캐시
  //   모드에서 캐스터 구성 변경(임포스터 castShadow=false ↔ 풀디테일 캐스팅)을 1프레임 반영하는 데 쓴다.
  chunkGroup.userData.lodUpdate = (camera) => {
    const d = chunkLodDistance(chunk, camera.position.x, camera.position.z);
    if (!showFull && d < swapIn) {
      impostor.visible = false;
      fullDetail.visible = true;
      showFull = true;
      return true;
    } else if (showFull && d > swapOut) {
      impostor.visible = true;
      fullDetail.visible = false;
      showFull = false;
      return true;
    }
    return false;
  };
}

// 필지 담·마당(어휘 격상: tile/stone/brush + 부속채) 을 필지 배치 변환까지 얹어 반환 — mergeStatic 이 구워 붙인다.
export function buildCourtyard(parcel, wallMats, char01) {
  const g = buildVillageWall(parcel.shape, wallMats, {
    style: parcel.wallType || 'stone', kind: parcel.kind, seed: parcel.seed, char01,
    aux: parcel.aux, plotW: parcel.plotW, plotD: parcel.plotD,
    // #55: 담 높이 연속 변주 + 마당 부속 소품(신분 상관). 전부 공유 재질 → 병합 후 드로우콜 불변.
    wallHeightK: parcel.wallHeightK, jangdok: parcel.jangdok,
    yardStack: parcel.yardStack, clothesline: parcel.clothesline, vegBed: parcel.vegBed,
  });
  g.applyMatrix4(parcelMatrix(parcel));
  return g;
}
