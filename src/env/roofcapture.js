import * as THREE from 'three';

// 지붕 "표면"(하늘에 노출된 상향 곡면 그리드)을 순회 수집해 월드 좌표로 구운 데이터를 돌려준다.
// 눈 볼륨 쉘(snowvol.js)과 빗물 리벌릿 오버레이(rainflow.js)가 이 캡처를 공유한다.
// 건물 재생성 시마다 다시 부른다(부재 위치가 최종 정착한 뒤 — onBuildingChanged 시점).
//
//   captureRoofSurfaces(buildingRoot) → [{ pos, nor, uv, index, count }, ...]
//     pos   : Float32Array(count*3)  월드 좌표 정점(기와면 위 살짝 띄우기 전 원위치)
//     nor   : Float32Array(count*3)  월드 노멀(상향 정렬 — 양면 셸 뒤집힘 winding 흡수)
//     uv    : Float32Array(count*2)  기왓골 UV(원본 유지: u=수평 골 위치, v=경사)
//     index : Uint32Array            삼각 인덱스
//
// 판별 방침(수정 금지인 roof.js/roof-skeleton.js 구조에 의존하지 않는 기하 휴리스틱):
//  - roof 그룹(있으면) 안의 큰 Mesh 그리드만. InstancedMesh(서까래·수키와 열)·Line·작은 트림 제외.
//  - "평탄성"= |평균 단위노멀|. 지붕면은 노멀이 한 반구로 모여 ≈0.8+, 튜브(집줄·마루)는 원주로
//    상쇄돼 ≈0.1 → 튜브/원통 배제. + 상향 평균 ny>0.3 으로 수직 벽 그리드도 배제(안전).
export function captureRoofSurfaces(root) {
  const out = [];
  if (!root) return out;
  root.updateMatrixWorld(true);

  const roofGroups = [];
  root.traverse((o) => { if (o.name === 'roof') roofGroups.push(o); });
  const scan = roofGroups.length ? roofGroups : [root];

  const nmat = new THREE.Matrix3();
  const vp = new THREE.Vector3(), vn = new THREE.Vector3(), mean = new THREE.Vector3();

  for (const grp of scan) {
    grp.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh) return;
      const geo = o.geometry;
      if (!geo || !geo.attributes.position || !geo.attributes.uv || !geo.index) return;
      const posAttr = geo.attributes.position;
      if (posAttr.count < 100) return;               // 그리드면만(giwa 스켈레톤 지붕면=135정점).
                                                       // 작은 마구리·마루 트림은 uv 부재/평탄성 게이트로 별도 배제.
      if (!geo.attributes.normal) geo.computeVertexNormals();
      const norAttr = geo.attributes.normal;

      o.updateWorldMatrix(true, false);
      const mw = o.matrixWorld;
      nmat.getNormalMatrix(mw);

      const n = posAttr.count;
      const pos = new Float32Array(n * 3);
      const nor = new Float32Array(n * 3);
      mean.set(0, 0, 0);
      let upNySum = 0;
      for (let i = 0; i < n; i++) {
        vp.fromBufferAttribute(posAttr, i).applyMatrix4(mw);
        pos[i * 3] = vp.x; pos[i * 3 + 1] = vp.y; pos[i * 3 + 2] = vp.z;
        vn.fromBufferAttribute(norAttr, i).applyMatrix3(nmat).normalize();
        mean.add(vn);                                 // 평탄성 판별은 원본(상향 정렬 전)으로
        if (vn.y < 0) vn.multiplyScalar(-1);          // 상향 정렬: 눈 쌓임은 부호 무관 위 향함 기준
        nor[i * 3] = vn.x; nor[i * 3 + 1] = vn.y; nor[i * 3 + 2] = vn.z;
        upNySum += vn.y;
      }
      const planarity = mean.length() / n;            // 1=완전 평탄/코히런트, 0=원통
      const upNy = upNySum / n;                        // 상향 정렬 평균 ny(수평 벽≈0)
      if (planarity < 0.6 || upNy < 0.3) return;

      out.push({
        pos, nor,
        uv: new Float32Array(geo.attributes.uv.array),
        index: geo.index.array.slice ? Uint32Array.from(geo.index.array) : new Uint32Array(geo.index.array),
        count: n,
      });
    });
  }
  return out;
}

// 표면 인덱스에서 경계 에지(정확히 한 삼각형에만 속한 에지) 목록을 뽑는다.
// 눈 쉘의 처마 눈처마(눈띠) 림 벽을 세우는 데 쓴다. 반환: [[a,b], ...] (정점 인덱스 쌍).
export function boundaryEdges(index) {
  const seen = new Map(); // key "min_max" → { a, b, count }
  const key = (a, b) => (a < b ? a + '_' + b : b + '_' + a);
  for (let t = 0; t < index.length; t += 3) {
    const tri = [index[t], index[t + 1], index[t + 2]];
    for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e + 1) % 3];
      const k = key(a, b);
      const rec = seen.get(k);
      if (rec) rec.count++;
      else seen.set(k, { a, b, count: 1 });
    }
  }
  const edges = [];
  for (const rec of seen.values()) if (rec.count === 1) edges.push([rec.a, rec.b]);
  return edges;
}
