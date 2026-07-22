import * as THREE from 'three';

// 재질 프레넬 골든아워 림 (태스크 #76 도입 · #101 전 오브젝트 확장) — RimPass(스크린스페이스) 대체.
//
//   createFresnelRim(scene) → { apply, setColor, setStrength, setPower, setWrap,
//                               setScale, setNearFar, setSunViewDir, patchedCount, coverage, dispose }
//
// 왜 재질로 옮기나(#76):
//  - RimPass 는 매 프레임 씬을 노멀 오버라이드로 한 번 더 렌더(지오 2배 제출)라 마을·hanyang
//    부감에서 OFF 게이팅해야 했다. 재질 프레넬은 상시 ON — 추가 지오 제출 0.
//  - 스크린스페이스 엣지 검출은 깊이 불연속을 무차별 선화해 "가려진 뒷건물 실루엣"이 앞 표면
//    위로 새는 X-ray 누출을 낳는다. 프레넬은 각 프래그먼트가 자기 노멀·뷰벡터만으로 림을 산출 →
//    가려진 건물은 애초에 래스터되지 않아 앞 표면 픽셀에 기여 불가. X-ray 구조적 해소.
//
// 대상(#101 — 사용자: "집뿐 아니라 모든 오브젝트"): 실루엣이 있는 조명(lit) 재질 전반.
//   나무(마을/외곽 스캐터·마당 과실수·보호수)·풀(focus grass)·담장·소품(장독대·해태·정원석 등)·
//   동물·정자·다리 + 기존 건물(role). 구 RimPass 의 "나무 실루엣 금빛 림"이 재질 전환(#76)에서
//   상실됐던 것을 포함해 복원한다. 대상/제외는 allowlist(role) 대신 명시 제외 규칙으로 판정.
//
// 제외(그리고 그 근거):
//  - 비-lit 재질(MeshBasic/ShaderMaterial 등): vViewPosition·nonPerturbedNormal 이 없어 주입 시
//    컴파일 실패. 타입 게이트(Standard/Physical 만)로 하늘·능선·구름·낙엽/벚꽃 파티클·원경 창불(
//    nightlights)·먹 스프라이트가 자동 제외된다.
//  - 반투명: 오버레이·유리·입자성(빗물 리벌릿·웅덩이 등). 실루엣 대상이 아님.
//  - 개구부(role 'opening')·야간 발광(userData.hanjiGlow: 창호·문·석등 화창)·자체발광 지배
//    재질(#66/#70): 림이 발광과 충돌.
//  - customProgramCacheKey 를 재정의한 재질(#52 snowvol shell/ground): 델리킷한 프로그램 캐시키
//    분리에 온비포컴파일 변형을 얹으면 캐시키 충돌·AO 오재사용 회귀 위험 → 건드리지 않는다.
//  - 지형·물면(넓은 완사면·수면): 프레넬은 이웃 샘플이 없어 "평면의 실루엣 에지"와 "평면 내부의
//    그레이징"을 구분할 수 없다(그게 프레넬의 본질). 넓은 지면이 그레이징에서 전면 금빛으로 물드는
//    오탐(구 RimPass 가 깊이-이차미분 엣지 게이트로 힘겹게 막던 것)을 재질 프레넬로는 막을 방법이
//    없다. → 이름으로 명시 제외(terrain/stream/paddyField). 나무·풀·소품은 곡률/소형 지오라 프레넬이
//    실루엣에 자연 집중하므로 오탐이 없다.
//
// 강도 정책(#101): 재질군별 계수. 건물은 온전(처마 킥 주인공), 소품·담장·동물은 절제, 나무·풀 등
//   유기물은 실루엣만 은은한 금빛(전면 금빛 도배 방지 — 구 RimPass 인상 계승). 계수는 상수 노출.
//
// onBeforeCompile 함정 회피:
//  - 노멀: 구현 초기엔 vNormal 을 직접 참조했으나, flatShading 재질(나무·granite prop·동물)은
//    three 가 vNormal varying 을 선언하지 않아(#ifndef FLAT_SHADED) 컴파일 실패한다. 대신
//    normal_fragment_begin 이 산출하는 `nonPerturbedNormal`(bump/normalMap 교란 전 지오메트리 노멀,
//    flat=파생·smooth=vNormal·double-side=faceDirection 보정)을 쓴다. smooth 단면 재질(건물)에선
//    normalize(vNormal)과 동일 → #76 건물 룩 완전 무회귀. 양면 풀은 faceDirection 보정으로 뒤집힘 방지.
//  - 색 uniform 은 THREE.Color 값(three setValueV3f 가 .r/.g/.b 지원) → Vector3.copy(Color)=NaN 무관.
//  - 배열 uniform 동적 인덱싱 없음(전부 스칼라 vec3/float).
//  - 인젝션 토큰은 <opaque_fragment>(outgoingLight 선언 직후). seasons 는 나무=vertex 만, terrain=
//    <color_fragment>(제외 대상)에 주입하므로 토큰이 겹치지 않는다. grass 는 <emissivemap_fragment>
//    까지만 → 역시 겹침 없음. 프래그먼트 <common> 은 여러 패치가 앞에 append 하되 uniform 이름이
//    uRim* 로 유일해 충돌 없음(체이닝 시 prev 먼저 실행 → 마지막에 내 uRim 블록이 append).

const RIM_ROLES = new Set(['roof', 'wall', 'wood', 'stone']);

// 재질군별 강도 계수(상수 노출). 건물=온전, 소품/담장/동물=절제, 유기물(나무/풀/마당초목)=은은.
export const RIM_GROUP_MUL = { building: 1.5, misc: 1.0, organic: 0.7 };

// 유기물 그룹 판정용 조상 그룹 이름(나무 스캐터·마당 초목·focus 풀).
const ORGANIC_NAMES = new Set(['trees', 'village-flora', 'focusGrass']);

// 그레이징 오탐(넓은 완사면·도로 광역 금빛)·수면은 프레넬로 실루엣 분리가 불가 → 이름으로 명시 제외.
//   (하늘·능선·구름·낙엽·원경 창불 등은 MeshBasic/Points/Sprite 라 타입 게이트로 이미 제외.)
const SKIP_NAMES = new Set(['terrain', 'stream', 'paddyField', 'village-roads-m0']);

export function createFresnelRim(scene) {
  // 모든 패치 재질이 참조 공유하는 uniform(seasons 패턴). 한 번 갱신하면 패치된 전 재질에 반영.
  const u = {
    // r185 Color(hex)는 sRGB 입력을 working-linear로 자동 변환한다. 추가 변환하면 이중 디코드된다.
    uRimColor: { value: new THREE.Color(0xffc070) },
    uSunViewDir: { value: new THREE.Vector3(0, 0, 1) }, // 뷰공간 태양 방향(post 가 매 프레임 세팅)
    uRimStrength: { value: 0.0 },   // cur.rim × altGate(저고도) × backlit(역광) — post 가 세팅
    uRimPower: { value: 1.92 },     // 프레넬 지수(담백하고 예리한 에지 실선 복원)
    uRimWrap: { value: 0.18 },      // 태양 반대편 실루엣 잔여 림(과도한 그늘 림 억제)
    uRimScale: { value: 1.0 },      // 부감/enable 마스터(focus=1, aerial=0)
    uRimNear: { value: 24.0 },      // 근경 거리 게이트 시작(뷰공간 깊이) — 근경 focus 림 불변
    uRimFar: { value: 175.0 },      // 원경 능선·far 건물 제외(#119: 부감/전환 원경 림 과다 하향, 210→175)
  };

  // 그룹 계수는 셰이더 리터럴이 아니라 재질별 uniform으로 전달한다. onBeforeCompile 클로저의
  // toString()은 캡처값을 구분하지 않으므로 리터럴을 구우면 서로 다른 셰이더가 같은 프로그램
  // 캐시키를 갖는다. 소스는 하나로 유지하고 uniform만 나누면 프로그램 변형 없이 의도가 보존된다.
  const groupUniforms = {
    building: { value: RIM_GROUP_MUL.building },
    misc: { value: RIM_GROUP_MUL.misc },
    organic: { value: RIM_GROUP_MUL.organic },
  };

  // 커버리지 카운트(검증 로그): 재질군별 패치 수 — 나무·풀·소품 포함 증명·제외 준수 확인.
  const counts = { total: 0, building: 0, misc: 0, organic: 0 };

  // 자체발광 지배 판정: 선형 emissive 휘도 × emissiveIntensity. 임계 낮게(0.2) 잡되 지붕 볏짚·
  //   진흙·정자 마루의 미량 anti-crush emissive(휘도 <0.02)는 통과시킨다.
  function emissiveDominant(mat) {
    const e = mat.emissive;
    if (!e) return false;
    const lum = (0.2126 * e.r + 0.7152 * e.g + 0.0722 * e.b) * (mat.emissiveIntensity ?? 1);
    return lum > 0.2;
  }

  // customProgramCacheKey 를 비어있지 않게 재정의한 재질(#52 snowvol)은 건드리지 않는다.
  function hasCustomCacheKey(mat) {
    try {
      if (!mat.customProgramCacheKey) return false;
      if (mat.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey) return false;
      const k = mat.customProgramCacheKey();
      return typeof k === 'string' && k.length > 0 && (k.startsWith('snowvol_') || mat.hasOwnProperty('customProgramCacheKey'));
    } catch { return false; }
  }

  function includable(mat) {
    if (!mat || !mat.isMaterial || mat.userData.__rimPatched) return false;
    if (!(mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial)) return false;
    if (mat.transparent) return false;
    if (mat.userData.role === 'opening') return false;
    if (mat.userData.hanjiGlow) return false;
    if (emissiveDominant(mat)) return false;
    if (hasCustomCacheKey(mat)) return false;
    return true;
  }

  // 재질군 판정: 조상 그룹이 유기물이면 organic, role 이 건물 부위면 building, 그 외 lit=misc.
  function groupOf(o, mat) {
    let n = o, hops = 0;
    while (n && hops < 4) { if (ORGANIC_NAMES.has(n.name)) return 'organic'; n = n.parent; hops++; }
    const role = mat.userData.role;
    return (role && RIM_ROLES.has(role)) ? 'building' : 'misc';
  }

  function patchMaterial(mat, group) {
    if (!includable(mat)) return;
    mat.userData.__rimPatched = true;
    counts.total++; counts[group]++;
    const groupUniform = groupUniforms[group] || groupUniforms.misc;
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
      shader.uniforms.uRimGroupMul = groupUniform;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform vec3 uRimColor;
          uniform vec3 uSunViewDir;
          uniform float uRimStrength;
          uniform float uRimPower;
          uniform float uRimWrap;
          uniform float uRimScale;
          uniform float uRimNear;
          uniform float uRimFar;
          uniform float uRimGroupMul;`)
        .replace('#include <opaque_fragment>', `
          {
            // 프레넬(그레이징): 자기 실루엣 에지에서 최대. 이웃/타표면 샘플 전무 → X-ray 불가.
            // nonPerturbedNormal = normal_fragment_begin 이 산출한 지오메트리 노멀(bump/normalMap
            //   교란 전). flatShading 나무·prop 은 파생 노멀, smooth 건물은 normalize(vNormal),
            //   양면 풀은 faceDirection 보정 → 재질군 전반에서 안전하고 #76 건물 룩과 동일.
            vec3 _rn = nonPerturbedNormal;
            vec3 _rv = normalize(vViewPosition);              // 표면→카메라(뷰공간)
            float _fres = pow(1.0 - clamp(dot(_rn, _rv), 0.0, 1.0), uRimPower);
            // 태양쪽 실루엣만(역광 정합). 반대편은 uRimWrap 잔여.
            float _side = clamp(dot(_rn, uSunViewDir), 0.0, 1.0);
            // 근경 거리 게이트(원경·far 건물 제외). vViewPosition 길이 = 뷰공간 깊이.
            float _df = 1.0 - smoothstep(uRimNear, uRimFar, length(vViewPosition));
            float _rim = _fres * mix(uRimWrap, 1.0, _side) * _df * uRimStrength * uRimScale;
            // 톤매핑 전(선형 HDR)에 outgoingLight 로 가산 → bloom 이 밝은 처마 킥을 흡수,
            // OutputPass ACES 가 한 번만 롤오프. 재질군 uniform으로 유기물/소품 강도를 절제.
            outgoingLight += uRimColor * max(_rim, 0.0) * uRimGroupMul;
          }
          #include <opaque_fragment>`);
    };
    mat.needsUpdate = true;
  }

  // 씬(또는 하위 그룹)을 훑어 대상 재질을 패치. 이미 패치된 재질은 즉시 스킵(멱등·저비용).
  //   마을 리롤·focus-in 오버레이(풀·소동물) 등 새 재질이 붙어도 재호출로 self-heal(post 가 throttle 로 호출).
  //   입자(Points)·스프라이트·물면/지형(이름)은 오브젝트 단위로 스킵한다.
  function apply(root = scene) {
    if (!root) return;
    root.traverse((o) => {
      if (o.isPoints || o.isSprite) return;
      if (o.name && SKIP_NAMES.has(o.name)) return;
      const m = o.material;
      if (!m) return;
      const g = groupOf(o, Array.isArray(m) ? (m[0] || {}) : m);
      if (Array.isArray(m)) { for (const mm of m) patchMaterial(mm, g); }
      else patchMaterial(m, g);
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
    get patchedCount() { return counts.total; },
    get coverage() { return { ...counts }; },
    get groupMultipliers() {
      return {
        building: groupUniforms.building.value,
        misc: groupUniforms.misc.value,
        organic: groupUniforms.organic.value,
      };
    },
    // 패치 자체는 되돌리지 않되(셰이더는 무해히 잔존), 강도·마스터를 0 으로 눌러 잔여 림 소거.
    dispose() { u.uRimStrength.value = 0; u.uRimScale.value = 0; },
  };
}
