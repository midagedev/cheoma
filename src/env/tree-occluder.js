import { smoothstep } from '../core/math/scalar.js';
import * as THREE from 'three';

// 전경 나무 오클루더 페이드 — 프레임워크 무관 ES 모듈.
//   setupTreeOccluder({ getSubject }) →
//     { register(group, opts), update(camera, dt), enableSelfDrive(), dispose() }
//
// 자동 궤도 회전 중 카메라와 피사체(건물·마을 중심) 사이를 가로막는 근경 나무가 화면을 통째로
// 덮으며 지나가 시야가 막히는 걸 막는다. 시선을 가리는 나무만 부드럽게 dithered 페이드(스크린도어
// 투명)해 반투명하게 비치게 하고, 벗어나면 원복한다. 급격한 팝 없이 ~0.4s 이즈.
//
// 대상: InstancedMesh + 공유 MeshStandardMaterial 구조(env/trees.js·village scatterTrees).
//  - 재질을 onBeforeCompile 로 체인 패치(seasons·snow 패치 뒤에 얹힘): 인스턴스별 instFade(0..1)
//    를 IGN(interleaved-gradient noise) 디더 임계로 써서 fade 미만 픽셀을 discard. 정적 stipple 이라
//    프레임 간 깜빡임 없고, fade 가 이즈되며 픽셀이 서서히 생겼다 사라져 부드러운 반투명으로 읽힌다.
//  - 성능: 오클루전 타깃 재계산은 스로틀(RECOMPUTE_DT)+반경 프리필터(피사체보다 먼 나무 조기 제외),
//    instFade 이징만 매 프레임. 나무 캐노피 월드좌표는 정적이라 register 시 1회 캐시.
//  - 마을(app 렌더 루프가 카메라를 안 넘김)은 enableSelfDrive() 로 mesh.onBeforeRender(카메라 제공)
//    에서 자가 구동. 단일 씬은 main.js 루프가 update(camera, dt) 로 직접 구동.

const MIN_FADE = 0.18;     // 완전 오클루전 시 잔여 불투명(≈18% 픽셀 유지 → 반투명하게 비침)
const EASE_TAU = 0.14;     // 페이드 이징 시상수(초) — 약 0.4s 수렴(팝 방지)
const RECOMPUTE_DT = 0.09; // 오클루전 타깃 재계산 주기(초) — 매 프레임 전체 투영 금지
const SCREEN_IN = 0.13;    // 화면중심 반경 이내 = 완전 페이드
const SCREEN_OUT = 0.62;   // 이 반경 밖 = 페이드 없음(가장자리 나무는 시야를 안 막음)


export function setupTreeOccluder({ getSubject } = {}) {
  // entries: { mesh, attr, pos(Float32 n*3 캐노피 월드), n, cur, tgt }
  const entries = [];
  const patched = new WeakSet();

  // 공유 재질에 디더 페이드 주입(체인). seasons(vertex)·snow(fragment) 패치를 보존한다.
  function patchMaterial(mat) {
    if (!mat || patched.has(mat)) return;
    patched.add(mat);
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, r) => {
      if (prev) prev(shader, r);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float instFade;\nvarying float vInstFade;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstFade = instFade;');
      // 안전 앵커: <clipping_planes_fragment> 는 seasons·snow 가 건드리지 않고 main() 앞머리에 항상 있음.
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vInstFade;')
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vInstFade < 0.999) {
          float _ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          if (vInstFade < _ign) discard;
        }`);
    };
    mat.needsUpdate = true;
  }

  const _m = new THREE.Matrix4();
  const _v = new THREE.Vector3();
  function register(group, { canopyY = 4.0 } = {}) {
    if (!group) return;
    group.updateMatrixWorld(true);
    group.traverse((o) => {
      if (!o.isInstancedMesh) return;
      const n = o.count;
      if (!o.geometry.getAttribute('instFade')) {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(n).fill(1), 1);
        a.setUsage(THREE.DynamicDrawUsage);
        o.geometry.setAttribute('instFade', a);
      }
      const attr = o.geometry.getAttribute('instFade');
      // 캐노피 중심(줄기 위 canopyY) 월드좌표 캐시 — 나무는 정적.
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        o.getMatrixAt(i, _m);
        _v.set(0, canopyY, 0).applyMatrix4(_m).applyMatrix4(o.matrixWorld);
        pos[i * 3] = _v.x; pos[i * 3 + 1] = _v.y; pos[i * 3 + 2] = _v.z;
      }
      entries.push({ mesh: o, attr, pos, n, cur: new Float32Array(n).fill(1), tgt: new Float32Array(n).fill(1) });
      patchMaterial(Array.isArray(o.material) ? o.material[0] : o.material);
    });
  }

  const _cam = new THREE.Vector3();
  const _subj = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _p = new THREE.Vector3();
  function recompute(camera) {
    _cam.setFromMatrixPosition(camera.matrixWorld);
    const s = getSubject && getSubject();
    _subj.copy(s || _subj.set(0, 0, 0));
    _dir.set(0, 0, -1).applyQuaternion(camera.quaternion); // 카메라 전방(월드)
    const camDotDir = _cam.dot(_dir); // 뒤편 판정용(할당 없이 (P-cam)·dir = P·dir - cam·dir)
    const subjDist = _cam.distanceTo(_subj);
    const cutoff2 = (subjDist * 0.92) ** 2; // 피사체보다 (거의) 먼 나무는 오클루더 아님
    for (const e of entries) {
      for (let i = 0; i < e.n; i++) {
        _p.set(e.pos[i * 3], e.pos[i * 3 + 1], e.pos[i * 3 + 2]);
        if (_p.distanceToSquared(_cam) > cutoff2) { e.tgt[i] = 1; continue; } // 프리필터
        if (_p.dot(_dir) - camDotDir <= 0) { e.tgt[i] = 1; continue; }        // 카메라 뒤편 제외
        _p.project(camera); // → NDC
        if (_p.z <= -1 || _p.z >= 1) { e.tgt[i] = 1; continue; }
        const r = Math.hypot(_p.x, _p.y);
        const occ = smoothstep(SCREEN_OUT, SCREEN_IN, r); // 화면중심=1, 가장자리=0
        e.tgt[i] = 1 - occ * (1 - MIN_FADE);
      }
    }
  }

  function ease(dt) {
    const k = Math.min(1, dt / EASE_TAU);
    for (const e of entries) {
      let dirty = false;
      for (let i = 0; i < e.n; i++) {
        const nx = e.cur[i] + (e.tgt[i] - e.cur[i]) * k;
        if (Math.abs(nx - e.cur[i]) > 1e-4) { e.cur[i] = nx; e.attr.array[i] = nx; dirty = true; }
      }
      if (dirty) e.attr.needsUpdate = true;
    }
  }

  let since = 1e9;
  let primed = false; // 첫 패스는 타깃으로 스냅(시작 페이드인 애니 없음). 정적 카메라(결정론 하네스)는
                      //   즉시 수렴→안정 → 픽셀 재현 유지. 이후 프레임은 카메라 이동 시에만 이징.
  function update(camera, dt) {
    if (!entries.length || !camera) return;
    since += dt;
    if (since >= RECOMPUTE_DT) { recompute(camera); since = 0; }
    if (!primed) { for (const e of entries) snap(e); primed = true; }
    else ease(dt);
  }
  function snap(e) {
    for (let i = 0; i < e.n; i++) { e.cur[i] = e.tgt[i]; e.attr.array[i] = e.tgt[i]; }
    e.attr.needsUpdate = true;
  }

  // 마을 자가 구동: mesh.onBeforeRender(renderer, scene, camera)에서 카메라를 얻어 프레임당 1회 구동.
  let lastFrame = -1, lastT = 0;
  function selfTick(renderer, camera) {
    const frame = renderer.info.render.frame;
    if (frame === lastFrame) return;      // 프레임당 한 번(여러 mesh 콜백 중 최초만)
    lastFrame = frame;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    const dt = lastT ? Math.min(0.05, now - lastT) : 0.016;
    lastT = now;
    update(camera, dt);
  }
  function enableSelfDrive() {
    for (const e of entries) e.mesh.onBeforeRender = (renderer, scene, camera) => selfTick(renderer, camera);
  }

  function dispose() {
    for (const e of entries) { e.mesh.onBeforeRender = () => {}; }
    entries.length = 0;
  }

  return { register, update, enableSelfDrive, dispose };
}
