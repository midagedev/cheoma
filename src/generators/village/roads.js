import { smoothstep } from '../../core/math/scalar.js';
import * as THREE from 'three';
import * as G from '../../core/math/geom2.js';

const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
// ───────────────────────── 도로 ─────────────────────────
// 도로 폴리라인을 지면에 밟힌 흙 리본으로. 등급별 폭(경국대전). 지형에 살짝 띄워 z-fighting 방지.
// 로드 톤 뮤트(#78): 도로가 급사면(좌청룡·우백호 측면 능선 등)을 직선으로 오를 때 생기는
//   인위적 "베이지 띠"를 없앤다. vertexColors 로 평지=밟힌 흙(기존색 그대로), 급사면일수록 주변
//   지형색(초지→숲)에 근접시켜 산자락에 녹인다. 완사면(대부분 도로)은 무변 → 타 규모 룩 회귀 0.
const R_BEIGE = linCol(0x9a8b70);   // 평지 도로(밟힌 흙) — 기존값
const R_GRASS = linCol(0x676f45);   // 지형 초지(buildSiteTerrain 과 동일 톤)
const R_FOREST = linCol(0x435a2a);  // 지형 숲(능선)
export function buildRoads(site, roads) {
  const group = new THREE.Group(); group.name = 'village-roads';
  // color=white + vertexColors: 색은 정점에 실어 평지는 기존 베이지 그대로, 급사면만 지형에 뮤트.
  const roadMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 1, metalness: 0 });
  const tmp = new THREE.Color(), terr = new THREE.Color();
  const roadColAt = (x, z, out) => {
    const hill = site.hillAt(x, z);
    const mute = smoothstep(0.30, 0.60, hill) * 0.9;   // 완사면 0 → 급사면 0.9
    if (mute <= 0) return out.copy(R_BEIGE);
    terr.copy(R_GRASS).lerp(R_FOREST, smoothstep(0.06, 0.55, hill));
    return out.copy(R_BEIGE).lerp(terr, mute);
  };
  for (const road of roads) {
    const pts = road.pts;
    if (pts.length < 2) continue;
    const hw = road.width / 2;
    const pos = [], col = [], idx = [];
    const N = pts.length - 1;
    for (let i = 0; i <= N; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N, i + 1)];
      const tan = G.norm(G.sub(b, a));
      const nx = -tan.z, nz = tan.x;
      const xL = p.x + nx * hw, zL = p.z + nz * hw, xR = p.x - nx * hw, zR = p.z - nz * hw;
      const yL = site.heightAt(xL, zL) + 0.06;
      const yR = site.heightAt(xR, zR) + 0.06;
      pos.push(xL, yL, zL); pos.push(xR, yR, zR);
      roadColAt(xL, zL, tmp); col.push(tmp.r, tmp.g, tmp.b);
      roadColAt(xR, zR, tmp); col.push(tmp.r, tmp.g, tmp.b);
    }
    for (let i = 0; i < N; i++) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, b, c, d); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, roadMat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
