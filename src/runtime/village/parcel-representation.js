import { CHUNK_LOD_LEVEL } from '../../village/lod-policy.js';

// 정규 필지의 부감 표현은 FAR mass·MID/FULL 인스턴스·병합 담의 여러 경로에 걸쳐 있다.
// 오버레이가 소유권을 얻거나 돌려줄 때 반드시 한 함수로 함께 전환해 중복/잔상을 막는다.
export function setParcelBaseHidden(handle, parcel, hidden) {
  if (!handle || !parcel) return false;
  const houses = handle[parcel.kind === 'giwa' ? 'giwa' : 'choga'];
  const sources = [houses?.userData, handle.walls, handle.impostors];
  let changed = false;
  for (const source of sources) {
    if (!source?.setHidden) continue;
    if (source.isHidden?.(parcel.id) === hidden) continue;
    source.setHidden(parcel.id, hidden);
    changed = true;
  }
  return changed;
}

// A persistent edited overlay owns exported architecture as well as live
// presentation. Unlike setParcelBaseHidden, this updates only the immutable GLB
// source snapshots; transient focus must never call it.
export function setParcelBaseExportHidden(handle, parcel, hidden) {
  if (!handle || !parcel) return false;
  const houses = handle[parcel.kind === 'giwa' ? 'giwa' : 'choga'];
  const sources = [houses?.userData, handle.walls, handle.impostors];
  let changed = false;
  for (const source of sources) {
    if (!source?.setExportHidden) continue;
    if (source.isExportHidden?.(parcel.id) === hidden) continue;
    source.setExportHidden(parcel.id, hidden);
    changed = true;
  }
  return changed;
}

// 검증·디버그가 정책값만 보며 자기검증하지 않도록 실제 은닉 핸들과 청크 루트 가시성을 읽는다.
// 필지에는 어느 순간에도 far mass/mid envelope/full/overlay 중 정확히 한 표현만 활성이어야 한다.
export function parcelRepresentationState(handle, parcel, overlayVisible = false) {
  if (!handle || !parcel) return null;
  const houses = handle[parcel.kind === 'giwa' ? 'giwa' : 'choga']?.userData;
  const impostors = handle.impostors;
  const impostorOwner = impostors?.locate?.get(parcel.id) || null;
  const lod = impostorOwner?.lod || null;
  const level = lod?.level || CHUNK_LOD_LEVEL.FULL;
  const baseHidden = houses?.isHidden(parcel.id) === true;
  const wallHidden = handle.walls?.isHidden(parcel.id) === true;
  const impostorHidden = impostors?.isHidden(parcel.id) === true;
  const fullRootVisible = lod?.fullRoot ? lod.fullRoot.visible : true;
  const farRootVisible = lod?.farRoot ? lod.farRoot.visible
    : lod?.impostorRoot ? lod.impostorRoot.visible : false;
  const midRootVisible = lod?.midRoot ? lod.midRoot.visible : false;
  const fullDetail = fullRootVisible && !baseHidden;
  const midDetail = midRootVisible && !baseHidden;
  const farMass = farRootVisible && !impostorHidden;
  const impostor = farMass;   // 하위호환 디버그 이름
  const overlay = !!overlayVisible;
  const representations = Number(fullDetail) + Number(midDetail) + Number(farMass) + Number(overlay);

  return {
    parcelId: parcel.id,
    chunkId: lod?.chunkId || null,
    level,
    distance: Number.isFinite(lod?.distance) ? +lod.distance.toFixed(3) : null,
    swapIn: lod?.swapIn ?? null,
    swapOut: lod?.swapOut ?? null,
    far: !!impostorOwner,
    fullRootVisible, midRootVisible, farRootVisible,
    impostorRootVisible: farRootVisible,
    fullDetail,
    midDetail,
    farMass,
    impostor,
    overlay,
    baseHidden,
    wallHidden,
    impostorHidden,
    representations,
    valid: representations === 1
      && (!overlay || (baseHidden && wallHidden && (!impostorOwner || impostorHidden))),
  };
}
