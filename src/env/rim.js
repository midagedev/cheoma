import * as THREE from 'three';

// 재질 프레넬 골든아워 림 (태스크 #76) — RimPass(스크린스페이스 노멀·깊이 재렌더) 대체.
//
//   createFresnelRim(scene) → { apply, setColor, setStrength, setPower, setWrap,
//                               setScale, setNearFar, setSunViewDir, patchedCount, dispose }
//
// 왜 재질로 옮기나:
//  - RimPass 는 매 프레임 씬을 노멀 오버라이드로 한 번 더 렌더(지오 2배 제출)라 마을·hanyang
//    부감에서 OFF 게이팅해야 했다. 재질 프레넬은 상시 ON — 추가 지오 제출 0.
//  - 스크린스페이스 엣지 검출은 깊이 불연속을 무차별 선화해 "가려진 뒷건물 실루엣"이 앞 표면
//    위로 새는 X-ray 누출을 낳는다(반해상도 샘플이 가림 경계를 앞면 안쪽으로 번지게 함).
//    프레넬은 각 프래그먼트가 자기 노멀·뷰벡터만으로 림을 산출 → 이웃/타표면 샘플 없음 →
//    가려진 건물은 애초에 래스터되지 않아 앞 표면 픽셀에 기여 불가. X-ray 구조적 해소.
//
// 대상 재질:
//  - palette.tagRoles 가 붙인 `userData.role ∈ {roof, wall, wood, stone}` 재질만 패치.
//    지형·나무·물·하늘·구름은 role 태그가 없어 자동 제외 → (a) 평평한 지면이 그레이징에서
//    금빛으로 물드는 오탐 방지(구 RimPass 가 깊이-이차미분 엣지 게이트로 힘겹게 막던 것),
//    (b) seasons.js 가 트리/지형 재질에 거는 color_fragment 패치와 체이닝 충돌 회피.
//  - 'opening'(창호: 문·한지·살창)은 야간 발광(#66)과 충돌 방지 위해 제외.
//
// onBeforeCompile 함정 회피:
//  - 색 uniform 은 vec3 로 선언하고 THREE.Color 값을 넣는다(three setValueV3f 가 .r/.g/.b 지원).
//    Vector3.copy(Color)=NaR 검정 렌더 함정과 무관(값 자체를 Color 로 둠).
//  - 배열 uniform 동적 인덱싱 없음(전부 스칼라 vec3/float).
//  - 인젝션 토큰은 <opaque_fragment>(outgoingLight → gl_FragColor 직전). seasons 는 <color_fragment>
//    에 주입하므로 토큰이 겹치지 않아 치환 순서 역전 문제 없음(애초에 건물 재질은 seasons 미대상).

const RIM_ROLES = new Set(['roof', 'wall', 'wood', 'stone']);

export function createFresnelRim(scene) {
  // 모든 패치 재질이 참조 공유하는 uniform(seasons 패턴). 한 번 갱신하면 패치된 전 재질에 반영.
  const u = {
    uRimColor: { value: new THREE.Color(0xffc070).convertSRGBToLinear() },
    uSunViewDir: { value: new THREE.Vector3(0, 0, 1) }, // 뷰공간 태양 방향(post 가 매 프레임 세팅)
    uRimStrength: { value: 0.0 },   // cur.rim × altGate(저고도) × backlit(역광) — post 가 세팅
    uRimPower: { value: 2.0 },      // 프레넬 지수(높을수록 실루엣 에지에 집중)
    uRimWrap: { value: 0.13 },      // 태양 반대편 실루엣 잔여 림(0=완전 소거)
    uRimScale: { value: 1.0 },      // 부감/enable 마스터(focus=1, aerial=0)
    uRimNear: { value: 24.0 },      // 근경 거리 게이트 시작(뷰공간 깊이)
    uRimFar: { value: 210.0 },      // 원경 능선·far 건물 제외(부감 골든 아웃라인 과다 완화)
  };

  let patchedCount = 0;

  function patchMaterial(mat) {
    if (!mat || !mat.isMaterial || mat.userData.__rimPatched) return;
    const role = mat.userData && mat.userData.role;
    if (!RIM_ROLES.has(role)) return;
    mat.userData.__rimPatched = true;
    patchedCount++;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, r) => {
      if (prev) prev(shader, r);
      shader.uniforms.uRimColor = u.uRimColor;
      shader.uniforms.uSunViewDir = u.uSunViewDir;
      shader.uniforms.uRimStrength = u.uRimStrength;
      shader.uniforms.uRimPower = u.uRimPower;
      shader.uniforms.uRimWrap = u.uRimWrap;
      shader.uniforms.uRimScale = u.uRimScale;
      shader.uniforms.uRimNear = u.uRimNear;
      shader.uniforms.uRimFar = u.uRimFar;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform vec3 uRimColor;
          uniform vec3 uSunViewDir;
          uniform float uRimStrength;
          uniform float uRimPower;
          uniform float uRimWrap;
          uniform float uRimScale;
          uniform float uRimNear;
          uniform float uRimFar;`)
        .replace('#include <opaque_fragment>', `
          {
            // 프레넬(그레이징): 자기 실루엣 에지에서 최대. 이웃/타표면 샘플 전무 → X-ray 불가.
            // bump/normalMap 교란 전 지오메트리 노멀(vNormal)로 계산 → 기와 bumpMap 이 만드는
            //   자잘한 프레넬 반짝임 억제(구 RimPass 의 MeshNormalMaterial 지오 노멀과 결이 맞음).
            vec3 _rn = normalize(vNormal);
            vec3 _rv = normalize(vViewPosition);              // 표면→카메라(뷰공간)
            float _fres = pow(1.0 - clamp(dot(_rn, _rv), 0.0, 1.0), uRimPower);
            // 태양쪽 실루엣만(역광 정합). 반대편은 uRimWrap 잔여.
            float _side = clamp(dot(_rn, uSunViewDir), 0.0, 1.0);
            // 근경 거리 게이트(원경·far 건물 제외). vViewPosition 길이 = 뷰공간 깊이.
            float _df = 1.0 - smoothstep(uRimNear, uRimFar, length(vViewPosition));
            float _rim = _fres * mix(uRimWrap, 1.0, _side) * _df * uRimStrength * uRimScale;
            // 톤매핑 전(선형 HDR)에 outgoingLight 로 가산 → bloom 이 밝은 처마 킥을 흡수,
            // OutputPass ACES 가 한 번만 롤오프(구 RimPass 의 HDR 가산과 동일 처리).
            outgoingLight += uRimColor * max(_rim, 0.0);
          }
          #include <opaque_fragment>`);
    };
    mat.needsUpdate = true;
  }

  // 씬(또는 하위 그룹)을 훑어 role 태그 재질을 패치. 이미 패치된 재질은 즉시 스킵(멱등·저비용).
  //   마을 리롤·focus-in 오버레이 등 새 재질이 붙어도 재호출로 self-heal(post 가 throttle 로 호출).
  function apply(root = scene) {
    if (!root) return;
    root.traverse((o) => {
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) { for (const mm of m) patchMaterial(mm); }
      else patchMaterial(m);
    });
  }

  return {
    uniforms: u,
    apply,
    setColor(c) { u.uRimColor.value.copy(c); },
    setStrength(s) { u.uRimStrength.value = s; },
    setPower(p) { u.uRimPower.value = p; },
    setWrap(w) { u.uRimWrap.value = w; },
    setScale(s) { u.uRimScale.value = s; },
    setNearFar(n, f) { u.uRimNear.value = n; u.uRimFar.value = f; },
    setSunViewDir(v) { u.uSunViewDir.value.copy(v); },
    get patchedCount() { return patchedCount; },
    // 패치 자체는 되돌리지 않되(셰이더는 무해히 잔존), 강도·마스터를 0 으로 눌러 잔여 림 소거.
    dispose() { u.uRimStrength.value = 0; u.uRimScale.value = 0; },
  };
}
