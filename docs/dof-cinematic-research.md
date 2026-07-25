# 시네마틱 DoF 선례 리서치 — 층 분리 복원 스펙

상태: **리서치** (구현 계약 아님). 작성 2026-07-25. `look-restoration-plan.md` 1-3의 스펙 입력.

이 문서는 자립형이다. 코드를 읽지 않고도 ① 사용자 수용 기준이 광학적으로 무엇을 요구하는지 ② 알려진 선례가 각각 무엇을
어떻게 하는지 ③ 현행 `stable-bokeh-pass` 계열이 정확히 어디서 층 분리를 누르는지 ④ 권고 접근과 초기 파라미터가 무엇인지
판단할 수 있게 쓴다. 인용한 코드 줄번호는 2026-07-25 `main`(8f7dea6) 기준이다.

---

## 1. 수용 기준의 광학 번역

사용자 문장: **"집을 선택했을 때 딱 그 집만 선명하고 전후로는 흐려졌으면"**

이것을 광학으로 옮기면 여섯 개의 검사 가능한 명제가 된다.

| # | 사용자 기준 | 광학적 요구 |
| --- | --- | --- |
| ① | 그 집만 선명 | 초점은 **평면**(카메라 축 깊이 `d`)이고, 피사체의 자체 깊이 폭(집 한 채 ≈ 9 m) 전체에서 착란원(CoC) 반경이 지각 한계(≈2 px) 아래여야 한다 |
| ② | 전후로 거리 비례 흐림 | CoC가 `z`(픽셀 깊이)의 **단조 함수**여야 하고, 이웃 필지 → 뒷집 → 능선 숲이 서로 **구분되는** 반경을 가져야 한다 |
| ③ | 점광원은 원형 보케 | HDR 소스는 gather 평균이 아니라 에너지 보존 **채워진 원반**으로 퍼져야 한다 |
| ④ | 전환 중 단조·펄스 없음 | CoC는 `d`·`fov`·`z`의 연속 함수여야 하고, 품질 다이얼이 **효과 자체를 0으로 끊으면 안 된다**(정착 순간 팝) |
| ⑤ | 부감 복귀 시 0 비용 | `amount == 0`이면 패스가 아무 렌더 타깃도 쓰지 않아야 한다 |
| ⑥ | 모바일 감당 | 최대 반경이 커져도 비용이 반경에 비례해서는 안 된다 → 반경은 **해상도**로, 샘플 수는 **고정**으로 산다 |

### 1.1 얇은 렌즈 CoC와 near/far 비대칭

거리 `z`에 있는 점이 초점 거리 `d`, 초점 길이 `f`, 조리개 직경 `A`인 렌즈에서 센서에 만드는 착란원 직경은

```
C = A · f · |z − d| / ( z · (d − f) )
```

`d ≫ f`(마을 규모에서 항상 성립)이면 `(d − f) ≈ d`이고, `|z − d| / (z·d) = |1/d − 1/z|`이므로

```
C ≈ A · f · | 1/d − 1/z |
```

센서 높이는 `h_s = 2·f·tan(fov/2)`, 화면 높이 `H` px이므로 **픽셀 단위 CoC 반경**은

```
r_px = ( A · H / ( 4 · tan(fov/2) ) ) · | 1/d − 1/z |      ……  (★)
```

(★)에서 곧바로 세 가지 성질이 나온다. 이 세 가지가 수용 기준 ①②④를 공짜로 만족시킨다.

- **원근 감쇠**: `|1/d − 1/z|`는 `1/z`에 선형이다. 즉 배경이 멀어질수록 흐림이 **증가하다 포화**한다.
- **유한한 far 점근선**: `z → ∞`에서 `r_px → A·H / (4·tan(fov/2)·d)`. 배경 흐림은 **인위적 clamp 없이** 스스로 평평해진다.
- **near가 far보다 강함**: 초점에서 같은 거리 `±Δ`를 비교하면 `1/(d−Δ) − 1/d > 1/d − 1/(d+Δ)`. 전경이 배경보다
  세게 풀린다. 계획 458줄이 지적한 "골든 t1의 아웃포커스 정자 처마"가 바로 이 비대칭의 산물이다. 전경을
  따로 튜닝할 필요가 없다.

한 가지 더: (★)는 `fov`를 **분모에 담고 있다**. cheoma는 렌즈 프로파일마다 fov가 다르다(부감 46°, 필지 근접 16°,
히어로 7° — `src/camera/optics.js` `VILLAGE_LENS`). (★)를 쓰면 망원 히어로 렌즈에서 심도가 **자동으로 얕아진다**.
계획 129줄의 "거리가 줄어 깊이 스프레드는 오히려 커졌다(보케 유리)"가 별도 다이얼 없이 성립한다.

### 1.2 정직한 경고 — 실제 f-stop으로는 이 룩이 불가능하다

수용 기준을 만족하는 조리개를 (★)로 역산하면 60 m 초점·16° 렌즈에서 `A ≈ 0.68 m`가 필요하다. 16°(풀프레임 85 mm
환산)에서 이것은 **f/0.13**이다 — 존재하지 않는 렌즈다. 즉 **실물 스케일 사실주의로는 이 룩을 정당화할 수 없다.**

정당화되는 해석은 하나 있다. 같은 (★)에서 세계를 `k`배 축소하고 화각을 유지하면 `d' = d/k`이므로 `r_px`가 `k`에
비례한다. 실재하는 **85 mm f/2.8**(`A = 30.4 mm`)로 목표 반경을 얻으려면 `k ≈ 22`다.

> **권고하는 룩의 정체: 1:22 건축 모형을 85 mm f/2.8로 2.7 m에서 찍은 사진.**
> 9 m 집이 41 cm 모형이 되고, 60 m 마을 깊이가 2.7 m가 된다. 실재하는 촬영이며, "절차적으로 생성한 마을 모형"이라는
> cheoma의 정체와 정확히 같은 문법이다.

실무적 함의: 파라미터를 `f-stop`으로 노출하면 거짓말이 된다. **`modelScale`(모형 축척) 또는 조리개 미터값 하나**로
노출하고, 이 문서를 근거로 인용한다. 축척 1:12(절제)~1:28(강함) 범위, 기본 1:22를 제안한다.

---

## 2. 선례 비교

네 선례 모두 **실제 소스를 열어 확인**했다. "확인" 열은 무엇을 읽었는지다.

| 선례 | CoC 공식 | 패스 구조 | 샘플 수 · 비용 | 아티팩트 대책 | cheoma 이식성 | 확인 |
| --- | --- | --- | --- | --- | --- | --- |
| **three.js `BokehShader`** (dof 예제, 현행 cheoma의 조상) | `blur = clamp((focus + viewZ) · aperture, −maxblur, maxblur)` — **거리 차에 선형**, 원근 감쇠 없음, near/far 대칭 | 1패스. 씬을 `MeshDepthMaterial`로 한 번 더 제출(packed depth) → full-res gather 1회 | **41 tap full-res**. 반경이 커지면 링 간격도 커져 비용은 일정하나 품질이 붕괴 | 없음. 큰 반경에서 링잉·전경 누출을 그대로 노출 | 이미 이식됨(`BokehPass` 상속). (★)의 `1/z` 항과 near/far 비대칭이 **없다는 것이 근본 한계** | `app/node_modules/three/examples/jsm/shaders/BokehShader.js:83-145`, `postprocessing/BokehPass.js:135-176`, 예제 기본값 `focus 1.0 / aperture 0.025 / maxblur 0.01` (`examples/webgl_postprocessing_dof.html`) |
| **three.js `BokehShader2`** (dof2 예제, Upitis v2.4) | **물리 렌즈**: `a=(o·f)/(o−f)`, `b=(d·f)/(d−f)`, `c=(d−f)/(d·fstop·CoC_mm)`, `blur=clamp(abs(a−b)·c, 0, 1)`. `CoC = 0.03 mm`(35 mm 필름) 상수. 즉 (★)와 동등한 곡선 | 1패스 + **전용 depth 셰이더**(`BokehDepthShader`, HalfFloat RT). 링 수·샘플 수는 `#define RINGS/SAMPLES`로 **컴파일 타임 고정** | `rings × samples`. 예제 기본 3링·4샘플 = **최대 12 tap/링셋**, GUI로 상향. full-res | `bias`(링 외곽 가중), `fringe`(색수차), `noise`/`dithering`(샘플 디더로 링잉을 노이즈로 교환), `depthblur`(깊이 프리블러로 실루엣 에일리어싱 완화), `pentagon`(조리개 날 형상) | **CoC 공식은 그대로 쓸 가치가 있다.** `fstop`·`focalLength`·`CoC_mm` 3개 uniform이 늘지만 1.2절 때문에 fstop을 그대로 노출하면 안 된다. 디더는 cheoma의 결정론·"crawl 금지" 방침과 충돌 | `shaders/BokehShader2.js:107-171`(linearize·CoC·gather), 예제 기본값 `fstop 2.2 / focalLength 35 / focalDepth 2.8 / maxblur 1.0 / bias 0.5 / fringe 0.7 / threshold 0.5 / gain 2.0 / dithering 0.0001 / noise true / pentagon false`, `RINGS`·`SAMPLES`는 `defines` (`examples/webgl_postprocessing_dof2.html`) |
| **pmndrs `postprocessing` `DepthOfFieldEffect`** | `signedDistance = distance − focusDistance`; `magnitude = smoothstep(0, focusRange, abs(signedDistance))` — **물리식이 아니라 작가 곡선**. near/far를 `gl_FragColor.rg = magnitude · vec2(step(signedDistance,0), step(0,signedDistance))`로 **한 타깃 2채널**에 분리 | **CoC 전용 패스 → CoC Kawase 블러(near용) → Mask 패스 → 배경 base+fill → 전경 base+fill → 합성.** 색 버퍼는 `resolutionScale = 0.5`(half-res), CoC와 mask는 full-res("prevent color bleeding") | 색 gather는 **half-res에서 `kernel64`(64 tap) + `kernel16`(16 tap fill)**, 이것을 near/far 각각 → 유효 full-res 등가 ≈ `(64+16)/4 × 2 = 40 tap`. `coc == 0`이면 조기 이탈 | ① **near CoC를 블러**해서 전경이 자기 실루엣 **밖으로** 번지게 한다(gather만으로는 불가능한 전경 확산). ② `MaskMaterial`로 선명한 피사체 위로 배경색이 새는 것을 차단. ③ fill 패스는 평균이 아니라 `max()` → base의 링 간격을 메운다 | **설계가 정답이다.** 의존성은 추가하지 않고 구조만 이식한다. 단 cheoma는 프로그램 개수가 추적 예산이므로(전환 히치 = 셰이더 링크 스톨) **5패스 구조를 그대로 옮기면 안 된다** | `src/effects/DepthOfFieldEffect.js`(render 순서·타깃·`bokehScale` 전파), `src/materials/glsl/circle-of-confusion.frag`, `src/materials/glsl/convolution.bokeh.frag`(`kernel64[32]`/`kernel16[8]`, `#ifdef FOREGROUND`, `vec2 step = texelSize * coc`, PASS2 `max()`) |
| **현행 cheoma `StableBokehPass` + `circular-bokeh-shader` + `bokeh-source-scatter`** | `BokehShader`와 동일(선형·대칭). §3 참조 | packed depth 프리패스(선택적 제외/치환) → half-res 하이라이트 prefilter → full-res 선택적 gather → **소스 스캐터**(HDR 소스를 실제 기하로 원반 산포) | prefilter **53 tap half-res**(=13.25 등가) + gather **13 tap full-res** + 스캐터 1 draw | 소스 스캐터가 ③을 **선례 중 가장 잘** 해결한다(에너지 보존 채워진 원반, `profilePower 12`). gather 쪽은 `withoutTransferredSource`로 이중 계산을 뺀다. 이동 중 `bokehQuality = 0`으로 sparse-kernel crawl 회피 | — | `src/env/stable-bokeh-pass.js`, `src/env/circular-bokeh-shader.js`, `src/env/bokeh-source-scatter.js`, `src/env/bokeh-source-contract.js` |

### 2.1 골든과 현행의 또 하나의 차이 — 패스 순서

골든 5ca668e는 **Bloom 다음에 Bokeh**였다(`git show 5ca668e:src/env/post.js:8`
= `RenderPass → GradePass → UnrealBloomPass → BokehPass`, 파라미터는 `focus 40 / aperture 0.00012 / maxblur 0.01`, 스톡 41 tap).
현행은 **Bokeh 다음에 Bloom**이다(`src/env/post.js:550-562`, 주석: "Optical blur precedes sensor bloom").

골든에서 배경 숲이 강하게 풀려 보인 데에는 두 요인이 겹쳐 있었다: (a) 41 tap이 **반경 상한 없이** full-res로 돌았고,
(b) 이미 bloom된 HDR 이미지를 블러해서 밝은 영역이 넓게 번졌다. (b)는 물리적으로 틀렸다 — 조리개 상은 센서 bloom
**앞**에 생긴다. 현행 순서가 옳다.

**권고: 패스 순서는 바꾸지 않는다.** 층 분리는 (a)를 제대로 되살려 얻는다. (b)를 되살리면 DoF가 bloom 강도에
결합되어 시간대·날씨마다 심도가 달라지는 새 회귀가 생긴다.

---

## 3. 현행이 층 분리를 누르는 정확한 지점

CoC 자체는 계산된다. `src/env/circular-bokeh-shader.js:147-152`:

```glsl
float viewZ = getViewZ(getDepth(vUv));
float signedBlur = clamp((focus + viewZ) * aperture, -maxblur, maxblur);
float coc = abs(signedBlur) / max(maxblur, 0.000001);
float blurRadiusPx =
  abs(signedBlur) * bokehRadiusScale * viewportWidth * 0.8660254;
```

그리고 바로 다음 줄에서 **버려진다** (`:165`):

```glsl
float cappedRadiusPx = min(blurRadiusPx, surfaceRadiusPx);
```

`surfaceRadiusPx`의 기본값은 `3.25`다 (`:20`, 주석: *"Non-emissive surfaces never spend the huge source radius"*).

### 3.1 이 상한이 몇 미터에서 물리는가

`aperture = 0.0002`(`src/camera/optics.js` `VILLAGE_FOCUS_DOF_APERTURE`), `bokehRadiusScale = 4.4`(`:18`)에서
탈초점 1 m당 반경 증가는 `0.0002 × 4.4 × W × 0.866 = 0.000762·W` px다.

| 뷰포트 폭 | 1 m당 | `surfaceRadiusPx=3.25` 도달 | `maxblur=0.01` 포화 |
| --- | --- | --- | --- |
| 960 px (`tools/shoot-dof.mjs`) | 0.73 px | **4.4 m** | 50 m (36.6 px) |
| 1600 px | 1.22 px | **2.7 m** | 50 m (61 px) |
| 1920 px | 1.46 px | **2.2 m** | 50 m (73 px) |

즉 **초점 평면에서 2~4 m만 벗어나면 일반 표면의 흐림이 최대치에 도달하고 그 뒤로는 완전히 평평하다.** 60 m 초점에서
75 m 이웃집, 120 m 뒷산, 300 m 능선이 **전부 동일한 3.25 px**를 받는다. 화면 폭의 0.2 %다. 이것이 "층 분리 없음"의
정체이며, 계획 336줄("배경 보케가 없다")·458줄("전경 보케 미발현")의 단일 원인이다.

`maxblur = 0.01`은 두 번째, 훨씬 느슨한 억제자다(50 m에서 포화). 구속 제약이 아니다 — `surfaceRadiusPx`가 그보다
11배 먼저 물린다.

### 3.2 두 번째 억제자 — 대비 게이트

`:187-195`:

```glsl
float contrastGate =
  smoothstep(surfaceContrastLow, surfaceContrastHigh, lumaSpan)
  * smoothstep(0.15, 0.55, relativeSpan);
…
float surfaceMix = contrastGate * radiusGate * cocGate * clamp(bokehQuality, 0.0, 1.0);
```

`surfaceContrastLow/High = 0.06 / 0.24`(`:21-22`). 13 tap 샘플 안의 휘도 폭이 0.06 미만이면 `surfaceMix = 0` —
**픽셀이 완전히 선명하게 남는다.** 회벽, 지붕면, 지형, 논 수면처럼 균일한 면은 얼마나 탈초점이든 흐려지지 않는다.
마을 배경의 대부분이 이 범주다. 반경 상한을 풀어도 이 게이트가 남으면 층 분리는 **여전히** 안 나온다.

### 3.3 세 번째 — 이동 중 완전 정지

`:166`:

```glsl
if (bokehQuality <= 0.0 || cappedRadiusPx < 0.65) {
  gl_FragColor = vec4(centerBase, 1.0);
  return;
}
```

`bokehQuality`는 카메라 이동 시 `createPostQualityState`가 0으로 떨어뜨린다(`src/env/post-quality-state.js`,
`enterSpeed 18 px/s`). 돌리인 **내내** 표면 DoF가 없고, 정착 후 0.22 s에 걸쳐 켜진다. 반경이 3.25 px일 때는 이 팝이
안 보였지만, 반경을 물리값으로 올리면 **정착 팝이 곧바로 수용 기준 ④ 위반이 된다.**

### 3.4 정리

> **한 줄: 층 분리를 누르는 것은 `circular-bokeh-shader.js:165`의 `min(blurRadiusPx, surfaceRadiusPx)`이고
> (`surfaceRadiusPx = 3.25 px`, 탈초점 2~4 m에서 포화), 그것을 풀어도 `:190`의 `contrastGate`가 균일면을 선명하게 붙잡는다.**

두 억제자 모두 **정당한 이유로** 들어갔다. 13 tap full-res로 60 px 원반을 채우면 링 간격이 30 px가 되어 링잉과 crawl이
생긴다. 상한과 게이트는 그 아티팩트를 가린 것이다. **따라서 상한을 그냥 올리는 것은 답이 아니다. 샘플링 전략을 바꿔야 한다.**

---

## 4. 권고 접근 — half-res CoC gather + 기존 소스 스캐터 유지

### 4.1 왜 이것인가

한 문장: **반경을 픽셀로 사지 말고 해상도로 산다.** 반경을 8~10배 키우면서 tap 수를 늘리지 않는 유일한 방법이며,
pmndrs가 `resolutionScale = 0.5`로 하는 일이다. cheoma는 이미 half-res prefilter 인프라(`bokeh-highlight-prefilter.js`)를
가지고 있어 새 개념이 아니다.

구조(신규 프로그램 **2개**, pmndrs의 5패스를 2패스로 압축):

```
[유지] packed depth 프리패스            — StableBokehPass 현행 그대로
[신규] CoC 패스 (half-res, 1 draw)      — R=near CoC, G=far CoC, B=하이라이트 차감 후 색, A=소스 소유권
[신규] gather 패스 (half-res, 1 draw)   — 고정 링 커널 + near CoC 3×3 max-dilate
[유지] full-res 합성                    — 기존 gather 셰이더 자리에서 half-res 결과를 CoC로 mix
[유지] 소스 스캐터                       — 기준 ③은 이미 선례 중 최고. 손대지 않는다
```

pmndrs를 그대로 따르지 **않는** 부분과 이유:

- **near/far 색 타깃 분리를 하지 않는다.** CoC 두 채널은 유지하되 색 gather는 한 번만 돌고, far 샘플은 "중심보다
  가깝지 않은 픽셀만" 받는 거부 판정으로 누출을 막는다. 이유: 프로그램 개수가 cheoma의 추적 예산이다(전환 히치의
  실체가 셰이더 링크 스톨). 5패스는 프로그램 +5, 타깃 +5다.
- **전경 확산은 near 채널 max-dilate로 대체한다.** pmndrs는 CoC를 Kawase 블러하는 별도 패스를 쓴다. gather 안의
  3×3 max(9 tap, half-res, 1채널)로 같은 효과를 얻는다 — 전경이 자기 실루엣 밖으로 번져 선명한 피사체 위에 얹힌다.
- **커널을 직접 만든다.** pmndrs `kernel64`/`kernel16` 테이블을 그대로 옮기면 Zlib 저작자 표기 의무가 생긴다.
  `circular-bokeh-shader.js`의 `makeSurfaceKernel()`이 이미 대칭쌍 링 생성기다 — 링 수만 올려 재사용하면 표기 불필요.
- **디더/노이즈를 쓰지 않는다.** dof2의 `noise`/`dithering`은 링잉을 시간적 노이즈로 교환한다. cheoma는 결정론 해시
  게이트가 있고 "crawl 금지"가 명시 방침이다. 링 간격은 fill 패스(`max()`)로 메운다.
- **CoC 공식은 dof2 쪽(물리)을 채택한다.** 단 §1.2 때문에 `fstop`이 아니라 조리개 미터값 하나로 노출한다.

### 4.2 채택할 CoC 공식

CPU에서 프레임마다 한 스칼라를 계산해 넘긴다(`fov`가 렌즈 프로파일마다 바뀌므로 상수화하면 안 된다):

```js
// r_px = cocScalePx * |1/focus - 1/z|        (★)
const cocScalePx = apertureMeters * viewportHeight
  / (4 * Math.tan(camera.fov * Math.PI / 360));
```

셰이더에서:

```glsl
float z = -getViewZ(getDepth(uv));                 // 양수 축 깊이 (m)
float signedCoc = cocScalePx * (1.0 / focus - 1.0 / max(z, nearClip));
float cocPx = clamp(abs(signedCoc), 0.0, maxCocPx);
// near = z < focus → signedCoc > 0 ;  far = z > focus → signedCoc < 0
```

`maxCocPx`는 화면 높이 비율로 둔다(`maxCocFraction * viewportHeight`). §4.4에서 보듯 이 clamp는 **전경에만** 물린다 —
배경 점근선이 clamp보다 낮으므로 far는 순수 물리 곡선을 끝까지 쓴다. 이것이 near/far 비대칭이 계약으로 보장되는 방식이다.

### 4.3 초기 파라미터 (초점 60 m · fov 16° 기준)

| 파라미터 | 제안값 | 근거 |
| --- | --- | --- |
| `apertureMeters` | **0.675 m** | z=150 m 배경에서 CoC 반경 = 화면 높이의 1.20 %가 되게 역산. 85 mm f/2.8 × **1:22 모형** 등가(§1.2) |
| `maxCocFraction` | **0.030** (높이의 3.0 %) | 전경 24 m에서 물린다. far 점근선(2.00 %)보다 크므로 배경은 clamp되지 않는다 |
| gather 해상도 | **0.5** | 최대 32 px(1080p) → half-res 16 px. pmndrs와 동일 |
| base 링 커널 | **48 tap** (4링 × 12, 대칭쌍) | half-res 반경 16 px 디스크 면적 804 px² ÷ 48 ≈ 4.1 px 간격 |
| fill 커널 | **12 tap, `max()` 합성** | base 링 간격 메움. pmndrs PASS2와 같은 역할 |
| 유효 비용 | **(48+12)/4 = 15 full-res tap 등가** | 현행 표면 분기(13 full-res tap + 53 half-res tap = 26.25 등가)보다 **싸다**. 반경은 8.6배 |
| `surfaceRadiusPx` | **삭제** | 상한의 존재 이유(sparse 커널)가 사라진다 |
| `surfaceContrastLow/High` | **삭제** | §3.2. 균일면도 흐려져야 한다 |
| `bokehQuality` 역할 | **fill 패스만 게이트** | base는 절대 0으로 내리지 않는다 → 정착 팝 제거(기준 ④) |
| 소스 스캐터 | 변경 없음, 단 **같은 (★) 곡선 공유** | 현재 스캐터는 z=150 m에서 36.6 px, 표면은 13 px가 될 예정. 곡선을 공유하지 않으면 등롱과 그 뒷벽의 흐림이 어긋난다 |

`apertureMeters`는 렌즈별로 다르게 둘 필요가 없다 — (★)가 `fov`를 이미 담고 있다. 하나의 상수가 부감(46°)에서
자연히 깊은 심도, 히어로(7°)에서 자연히 얕은 심도를 만든다.

### 4.4 결과 사다리 — 수용 기준 ①②의 직접 증거

초점 60 m, `apertureMeters = 0.675`, fov 16°, 1080p 기준 CoC 반경:

| 위치 | z (m) | 반경 (px) | 지각 |
| --- | --- | --- | --- |
| 전경 처마 | 20 | 32.4 *(clamp)* | 완전히 풀린 워시 |
| 전경 담장 | 40 | 10.8 | 뚜렷한 전경 보케 |
| 전경 나무 | 45 | 7.2 | 부드러움 |
| **피사체 앞면** | **55** | **2.0** | **선명** |
| **피사체 중심** | **60** | **0** | **선명** |
| **피사체 뒷면** | **64** | **1.3** | **선명** |
| 이웃 필지 | 75 | 4.3 | 눈에 보이게 물러남 |
| 뒷줄 집 | 90 | 7.2 | 분명히 분리됨 |
| 능선 앞 숲 | 120 | 10.8 | 풀림 |
| 배경 능선 | 150 | 13.0 | 녹아듦 |
| 원경 | 300 | 17.3 | 거의 점근선 |
| 무한 | ∞ | 21.6 | far 점근선(높이의 2.00 %) |

읽을 점 두 가지:

- **집 한 채의 깊이 폭(55~64 m) 전체가 2 px 이하** → "딱 그 집만 선명"(①)이 성립한다. 초점을 점이 아니라 평면으로
  잡아도 피사체는 통째로 선명하다.
- 75 → 90 → 120 → 150 m가 4.3 → 7.2 → 10.8 → 13.0 px로 **구분된다** → "전후로 거리 비례"(②). 현행은 이 네 칸이
  전부 3.25 px로 같다.
- ±20 m 비교: 전경 40 m = 10.8 px vs 배경 80 m = 3.9 px → **2.8배 비대칭**. 계획 458줄이 요구한 전경 보케가
  튜닝 없이 나온다.

### 4.5 아티팩트 대책 (선례에서 이식)

| 아티팩트 | 증상 | 대책 | 출처 |
| --- | --- | --- | --- |
| 배경 → 피사체 색 누출 | 선명한 처마선 주위에 배경색 헤일로 | far gather에서 **중심보다 가까운(=CoC near 채널이 큰) 샘플 거부** | pmndrs `MaskMaterial`의 경량 등가 |
| 전경이 실루엣 안에 갇힘 | 전경 물체가 흐려지지만 뒤 피사체 위로 번지지 않아 종이 오려붙인 느낌 | near 채널 **3×3 max-dilate** | pmndrs `renderTargetCoCBlurred` |
| 실루엣 CoC 에일리어싱 | 지붕 경계에서 흐림이 계단 | half-res CoC 다운샘플에서 near는 2×2 **최근접** 깊이, far는 **최원거리** 깊이 사용 | dof2 `depthblur`의 결정론적 등가 |
| 링잉 | 밝은 배경에 이산 링 | fill 패스 `max()` + 대칭쌍 커널 | pmndrs PASS2 |
| 소스 이중 계산 | HDR 등롱이 스캐터와 gather 양쪽에서 퍼짐 | 기존 `withoutTransferredSource`를 half-res 다운샘플 단계로 이동 | 현행 유지 |
| 하늘 가짜 깊이 | 시간대마다 배경 흐림이 변함 | `scene.background = null` + 흰색(far) 클리어 유지 | 현행 `stable-bokeh-pass.js:126-129` — **반드시 보존** |

### 4.6 기준 ⑤⑥ — 부감 0비용과 모바일

**⑤ 부감 0비용은 이미 계약으로 존재하고, 유지된다.** `src/env/dof.js:104-108`에서 `pass.enabled = amount > EPSILON`
이고 부감은 `amount = 0`이다(`docs/mobile-effects-audit.md` 측정: 부감 A/B 양쪽 `amount=0`). 단 신규 half-res 타깃은
**지연 할당**해야 한다 — 부감 전용 세션이 타깃을 만들지 않도록. `setSize`는 이미 있는 타깃만 리사이즈한다.

**⑥ 모바일**: half-res가 곧 모바일 형태다. 추가 축소가 필요하면 순서는 (a) fill 패스 생략 → 12 등가 tap,
(b) gather 해상도 0.35, (c) `maxCocFraction` 하향. **`setDof(false)`로 끄는 것은 방침 위반이다**
(`docs/mobile-effects-audit.md` 12줄: "통합자를 끄는 것 — 통합자는 이 앱의 본체다"). M3·M6·M7·M8 복원 작업과
같은 커밋에 들어가야 하며, 특히 M6(`setFocusPoint` 미호출로 초점이 40 m 고착, 오차 28.4 m)를 빼먹으면 새 반경이
**틀린 깊이에** 걸려 지금보다 나빠진다.

---

## 5. 전환 통합 (돌리인 램프 · lockFocus)

세 개의 기존 배선을 건드려야 한다. 어느 것도 시그니처는 바뀌지 않는다.

**5.1 `dofAmount` 램프 (`app/src/engine/engine.js:491,527,1367,1837`)**
현재 `dof0 → dof1`을 `aperture` 배율로 보간한다. (★)에서 `apertureMeters`에 그대로 곱하면 CoC가 선형 스케일되므로
의미가 보존된다. **변경 없음.** 단 `amount`가 0을 지나는 프레임에서 패스가 잠들고 깨는 것은 그대로 유지한다(⑤).

**5.2 `lockFocus` / `setFocusPoint` 추적 (`engine.js:796,903,3249`)**
초점 깊이는 매 프레임 `post.setFocusPoint(activeDofAnchor())`로 갱신된다. `focusDepthForPoint`는 카메라 축 깊이를
정확히 준다(`src/env/dof.js:49-61`, `tools/check-dof.mjs`가 축 깊이 vs 유클리드 거리를 이미 게이트). (★)는
`focus`를 분모에 두므로 트윈 중 `focus`가 115 → 174 m로 움직이면 CoC가 **연속적으로** 변한다. **변경 없음.**
계약 오차 <0.04 게이트(계획 412줄)도 그대로다.

**5.3 품질 다이얼 — 유일한 실질 변경**
현재: 이동 중 `bokehQuality = 0` → 표면 DoF **전멸**(§3.3). 정착 시 0.22 s 램프.
변경: `bokehQuality`를 **fill 패스 가중치로만** 라우팅한다. base 48 tap은 이동 중에도 항상 돈다.
근거: half-res 48 tap은 sparse하지 않다 — crawl의 원인이었던 "13 tap full-res로 큰 반경"이라는 조건 자체가 없어진다.
효과: 돌리인 내내 심도가 존재하고, 정착 시 링 품질만 미세하게 개선되므로 **정착 팝이 사라진다**(기준 ④).
`post-quality-state.js`는 수정 불필요 — 소비 지점만 바꾼다.

**5.4 잉크 모드**: `inkModeRuntime.setFocusPolicy({ dofAmount })`(`engine.js:863,996,3285`)는 별도 경로다.
CoC 텍스처는 잉크가 이미 쓰는 깊이와 같은 소스이므로 회귀 요건은 없다. 무수정 통과를 확인만 한다.

---

## 6. 검증 방법

### 6.1 판정 컷 — 초점 평면 앞/중/뒤 3매

기존 결정론 케이스 `capital / seed 7 / p31`(`check:cinematic:app`, `shoot:focus-level`)을 그대로 쓴다. 이미
`?hero=0&village=1&worker=0&shot=1&seed=42&vseed=20260716&time=sunset&season=autumn&weather=clear` 형태로
`tools/shoot-dof.mjs`가 세팅을 갖고 있다.

한 프레임에서 **초점 거리만 세 값으로 바꿔** 3매를 찍는다(카메라·씬 불변 → 다른 변수 없음):

| 컷 | 초점 | 통과 조건 |
| --- | --- | --- |
| **앞** | 피사체 깊이 − 25 m | 피사체가 흐려지고 전경 담장/처마가 선명해진다. 배경은 앞 컷보다 **더** 흐리다 |
| **중** | 피사체 깊이 (제품값) | 집 한 채가 앞면~뒷면 통째로 선명하고, 이웃 필지부터 눈에 보이게 물러난다 |
| **뒤** | 피사체 깊이 + 60 m | 피사체가 흐려지고 배경 능선이 선명해진다 |

3매가 서로 **다르지 않으면** 층 분리가 없다는 뜻이다. 현행 코드로 이 3매를 먼저 찍어 회귀 기준선으로 고정할 것을
권한다(현행에서는 세 컷이 거의 동일할 것으로 예상된다 — §3.1의 3.25 px 상한).

### 6.2 브라우저 없는 수치 게이트 (`tools/check-dof.mjs` 확장)

이 파일은 이미 `circular-bokeh-shader.js`의 커널·상수와 `createDofController`를 직접 import해서 렌더러 없이
검사한다. (★)를 JS 함수로 노출하면 다음을 무비용으로 게이트할 수 있다:

1. **단조성**: `z`가 `focus`에서 멀어질 때 CoC가 단조 증가(양방향).
2. **피사체 선명**: `focus ± 5 m`에서 CoC ≤ 화면 높이의 0.25 %.
3. **층 구분**: 75/90/120/150 m 반경이 서로 1.3배 이상 벌어짐.
4. **near/far 비대칭**: `focus − 20 m` 반경 / `focus + 20 m` 반경 ≥ 2.0.
5. **far 점근선 < clamp**: `cocScalePx/focus < maxCocPx` → 배경이 clamp에 닿지 않음.
6. **fov 종속**: 같은 초점에서 fov 7° CoC > 16° CoC > 46° CoC.
7. **⑤ 0비용**: `amount = 0`에서 `pass.enabled === false`.

### 6.3 나머지

- **골든 A/B**: 계획 458줄이 지목한 `hero-landing` 골든(5ca668e) 대비. 전경 정자 처마가 풀리는지가 판정점.
- **프로그램 개수 델타**: 헤드리스 절대 ms는 신뢰하지 않는다. `+2`(CoC, gather)를 초과하면 실패로 본다.
- **부감 픽셀 불변**: `amount=0`이므로 부감 캡처는 **바이트 동일**해야 한다.
- **라우팅 게이트**: `npm run check:pr`, 그리고 `check:dof`·`check:dof:app`·`shoot:dof`·`shoot:bokeh-fixture`·
  `shoot:bokeh-scatter-proof`(스캐터 무회귀)·`check:cinematic:app`·`shoot:focus-level`.

---

## 7. 출처 (전부 실확인)

| 출처 | 확인 방식 | 라이선스 · 표기 |
| --- | --- | --- |
| three.js `BokehShader.js`, `BokehPass.js` (r0.185.1) | 로컬 `app/node_modules/three/examples/jsm/` 직독 | MIT. 이미 의존성. 추가 표기 불필요 |
| three.js `BokehShader2.js` (Martins Upitis GLSL DoF v2.4 이식) | 로컬 직독 (`:107-171`) | MIT. **CoC 공식만 참조**(수식은 표준 얇은 렌즈식) → 표기 불필요 |
| three.js 예제 `webgl_postprocessing_dof.html`, `webgl_postprocessing_dof2.html` | `raw.githubusercontent.com/mrdoob/three.js/dev/examples/` 웹 확인 | MIT. 기본값 참조만 |
| pmndrs `postprocessing` — `DepthOfFieldEffect.js`, `circle-of-confusion.frag`, `convolution.bokeh.frag` | `raw.githubusercontent.com/pmndrs/postprocessing/main/src/` 웹 확인 | **Zlib.** 설계·구조만 이식(의존성 추가 없음). `kernel64`/`kernel16` 테이블을 **복사하면 저작자 표기 의무 발생** → §4.1대로 자체 생성기 사용 권고 |

**`docs/credits.md` 등재 대상 아님.** 그 파일은 사용자에게 보이는 역사·시각 자료(기관·소장품·도판)를 위한 것이고,
위 네 항목은 코드 기법 출처다. 다만 pmndrs 커널을 그대로 복사하기로 결정한다면 그때는 Zlib 표기를 어디에 둘지
별도로 정해야 한다.

## 8. 이 문서가 결정하지 않은 것

- 커널의 정확한 링 반경 분포(48 tap을 4×12로 둘지 3×16으로 둘지) — 구현 중 링잉 관찰로 정한다.
- `apertureMeters = 0.675`는 §4.4 사다리를 만드는 값이지 사용자 승인값이 아니다. 3매 판정 컷으로 확정한다.
- 소스 스캐터를 (★) 곡선으로 옮길 때 현재 `radiusScale 4.4`가 만드는 36.6 px 원반이 줄어든다. 등롱 보케가
  **작아지는** 변화이므로 사용자 확인이 필요하다. 대안은 소스에만 별도 배율을 남기는 것이다(광학적으로는 틀리지만
  "밝은 점광원은 크게 핌"이라는 기준 ③의 관습적 기대에 맞을 수 있다).
