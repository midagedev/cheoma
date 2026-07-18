import * as THREE from 'three';
import {
  CLOUD_SHADOW_FRAG_DECL, CLOUD_SHADOW_FRAG_BODY,
  CLOUD_SHADOW_VERT_DECL, CLOUD_SHADOW_VERT_BODY,
} from '../env/clouds.js';

// 캔버스 텍스처의 무작위 얼룩·짚결·막돌은 기본 Math.random 을 쓴다. 다만 마을 재현 렌더
// (같은 seed → 픽셀 동일)를 위해 외부에서 시드 가능한 난수원으로 교체할 수 있다.
// setTextureRandom(null) 또는 미교체 시 현행(Math.random) 동작 불변.
let _texRand = Math.random;
export function setTextureRandom(fn) { _texRand = (typeof fn === 'function') ? fn : Math.random; }

// 단청 계열 기본 색 (조선). 국가 스타일 모핑 시 이 팔레트를 교체/보간한다.
export const KOREA_COLORS = {
  seokganju: 0x8e4a35,   // 석간주 (기둥·창방·문틀)
  noerok: 0x4c6559,      // 뇌록 (공포·서까래 바탕) — 실물 회청록(잎초록 탈피)
  juhong: 0x9c4632,      // 주홍 (공포 소로·부재 교차 포인트)
  samcheong: 0x3e5f9e,   // 삼청 (머리초 포인트)
  hwang: 0xc8a34a,       // 황
  baek: 0xe8e4d8,        // 백 (긋기·서까래 마구리)
  meok: 0x2e2a28,        // 먹
  tile: 0x4a4d53,        // 온기 도는 진회색 기와
  tileDark: 0x4b4e55,    // 마루 (기와 적층 톤)
  plaster: 0xd9d2c4,     // 회벽
  stone: 0xb8b2a6,       // 화강암 기단
  stoneDark: 0x99938a,   // 기단 그림자면
  hanji: 0xefe6d2,       // 한지
  ground: 0xb5a893,      // 마당
};

// 기와 지붕 텍스처: 기왓등·기왓골 세로 줄 + 가로 겹침 라인 (온기 있는 진회색)
function makeTileTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0.0, '#41434a');
  grad.addColorStop(0.18, '#585a61');
  grad.addColorStop(0.5, '#6b6d74');   // 기왓등 하이라이트
  grad.addColorStop(0.82, '#585a61');
  grad.addColorStop(1.0, '#41434a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = 'rgba(30,31,36,0.5)';
  for (let y = 0; y < 256; y += 64) g.fillRect(0, y, 256, 6);
  g.fillStyle = 'rgba(255,255,255,0.07)';
  for (let y = 9; y < 256; y += 64) g.fillRect(0, y, 256, 3);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 창호 텍스처(궁): 붉은 문틀 + 초록 빗꽃살(대각 마름모 그물) + 밝은 한지, 하단 초록 청판.
// 근정전 실물 창호는 밝은 창호지 위 초록 살이 대각으로 교차한 마름모 문양이라, 살 사이로 빛이
// 투과하듯 밝게 읽혀야 한다(구 버전: 어두운 한지 + 촘촘한 직교 정자살 → 역광·그늘서 진흙빛으로 뭉갬).
function makeDoorTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#f2ecda';                       // 밝은 한지(살 사이 광명)
  g.fillRect(0, 0, 256, 512);
  const top = 416;                               // 하단 청판 시작
  // 빗꽃살: 45° 두 방향 살이 교차 → 마름모 그물. 밝은 한지 위라 마름모 안이 흰 빛으로 남는다.
  g.save();
  g.beginPath(); g.rect(0, 0, 256, top); g.clip();
  g.strokeStyle = '#50704e'; g.lineWidth = 5;
  const d = 26;
  for (let k = -512; k < 512; k += d) {          // ╲ 방향
    g.beginPath(); g.moveTo(k, 0); g.lineTo(k + 512, 512); g.stroke();
  }
  for (let k = 0; k < 1024; k += d) {            // ╱ 방향
    g.beginPath(); g.moveTo(k, 0); g.lineTo(k - 512, 512); g.stroke();
  }
  g.restore();
  // 하단 청판 (초록 널)
  g.fillStyle = '#4e6b52';
  g.fillRect(10, top + 4, 236, 512 - top - 12);
  g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 4;
  g.strokeRect(10, top + 4, 236, 512 - top - 12);
  // 붉은 문틀(주칠) — 얇게(살 문양이 죽지 않게)
  g.strokeStyle = '#7d4030'; g.lineWidth = 20;
  g.strokeRect(0, 0, 256, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 창방·평방 머리초 띠: 뇌록 바탕 + 부재 끝 색동(백·적·청·황) 반복.
// compact=true(절): 색동 폭을 줄이고 청록 위주로 더 소박하게.
function makeDancheongBandTexture(compact = false) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = compact ? '#4a6357' : '#4f6c60'; // 뇌록 바탕(실물 회청록)
  g.fillRect(0, 0, 512, 64);
  // 한 반복 = 한 칸: 양 끝에 머리초 색동
  const bands = compact
    ? ['#d8d2c2', '#4e6b52', '#3e5f9e', '#4e6b52', '#8e4a35'] // 청록 위주·소박
    : ['#e8e4d8', '#8e4a35', '#3e5f9e', '#c8a34a', '#8e4a35', '#e8e4d8'];
  const bw = compact ? 7 : 11;                   // 색동 폭
  for (const x0 of [0, 512 - bands.length * bw]) {
    bands.forEach((col, i) => {
      g.fillStyle = col;
      g.fillRect(x0 + i * bw, 0, bw, 64);
    });
  }
  // 백색 긋기 라인 (상하)
  g.fillStyle = 'rgba(232,228,216,0.9)';
  g.fillRect(0, 4, 512, 3);
  g.fillRect(0, 57, 512, 3);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 절 창방·평방: 세월에 바랜 퇴색 금단청. 고재 바탕 위에 뇌록 도막이 얼룩덜룩 남고,
// 부재 끝 머리초 색동은 채도가 죽어 은은히 비친다("단청이 있(었)다"가 읽히되 궁보다 낮은 채도).
function makeTempleDancheongBandTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#7c6a4b';                         // 바랜 고재 바탕
  g.fillRect(0, 0, 512, 64);
  g.fillStyle = 'rgba(74,99,88,0.70)';             // 퇴색 뇌록 도막(반투명 — 고재 비침)
  g.fillRect(0, 0, 512, 64);
  for (let i = 0; i < 64; i++) {                    // 도막 벗겨짐(고재 노출) 얼룩
    const x = _texRand() * 512, y = _texRand() * 64, r = 3 + _texRand() * 11;
    g.fillStyle = `rgba(126,106,74,${0.10 + _texRand() * 0.20})`;
    g.beginPath(); g.ellipse(x, y, r, r * 0.6, 0, 0, Math.PI * 2); g.fill();
  }
  // 부재 끝 머리초 색동(퇴색): 낮은 채도 회록·벽돌빛·바랜 청·황토
  const bands = ['#c4b99e', '#96604d', '#5f7986', '#ab9560', '#96604d'];
  const bw = 8;
  g.globalAlpha = 0.80;
  for (const x0 of [0, 512 - bands.length * bw]) {
    bands.forEach((col, i) => { g.fillStyle = col; g.fillRect(x0 + i * bw, 0, bw, 64); });
  }
  g.globalAlpha = 1;
  g.fillStyle = 'rgba(198,188,162,0.45)';          // 바랜 백색 긋기
  g.fillRect(0, 5, 512, 2); g.fillRect(0, 57, 512, 2);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 공포 부재 마구리(살미·첨차 끝) 연화 문양: 뇌록/회록 바탕에 백 연판 8엽 + 적 씨방.
// faded=true(절): 채도를 낮춰 퇴색.
function makeYeonhwaTexture(faded = false) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const cx = 32, cy = 32;
  const p = faded
    ? { bg: '#586a5e', petal: '#c3b79c', edge: '#7f8f96', center: '#96604d', dot: '#9a844f' }
    : { bg: '#3e5f4e', petal: '#ece7d6', edge: '#2f5f9e', center: '#b23a2a', dot: '#d9b24a' };
  g.fillStyle = p.bg; g.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 8; i++) {                     // 연판 8엽
    const a = (i / 8) * Math.PI * 2;
    g.save(); g.translate(cx, cy); g.rotate(a);
    g.fillStyle = p.petal;
    g.beginPath(); g.ellipse(0, -16, 5, 11, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = p.edge; g.lineWidth = 1.2; g.stroke();
    g.restore();
  }
  g.fillStyle = p.center; g.beginPath(); g.arc(cx, cy, 8, 0, Math.PI * 2); g.fill();  // 씨방
  g.fillStyle = p.dot; g.beginPath(); g.arc(cx, cy, 3.2, 0, Math.PI * 2); g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 연목초(椽木椒): 연목(둥근 서까래) 끝 목재용 컬러 마구리 문양. 청·황·적 동심원 + 백 중심.
// 회색 수막새(와당)와 구분되는 목부재 단청. faded=true(절): 퇴색 톤.
function makeYeonmokchoTexture(faded = false) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const cx = 32, cy = 32;
  const p = faded
    ? { rim: '#495047', blue: '#5f7986', yellow: '#ab9560', red: '#96604d', white: '#c4b99e', dot: '#463d31' }
    : { rim: '#2b3830', blue: '#2f5f9e', yellow: '#d9b24a', red: '#b23a2a', white: '#ece7d6', dot: '#2b2724' };
  const rings = [[30, p.rim], [26, p.blue], [19, p.yellow], [12, p.red], [6, p.white]];
  for (const [r, col] of rings) { g.fillStyle = col; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = p.dot; g.beginPath(); g.arc(cx, cy, 2.4, 0, Math.PI * 2); g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 부연초: 부연(사각 서까래) 끝 사각 마구리 문양. 청 테두리 + 적 안쪽 + 백 중심(동심 사각).
function makeBujeonchoTexture(faded = false) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const p = faded
    ? { edge: '#495047', blue: '#5f7986', red: '#96604d', white: '#c4b99e', dot: '#463d31' }
    : { edge: '#2b3830', blue: '#2f5f9e', red: '#b23a2a', white: '#ece7d6', dot: '#2b2724' };
  const sq = (inset, col) => { g.fillStyle = col; g.fillRect(inset, inset, 64 - 2 * inset, 64 - 2 * inset); };
  sq(0, p.edge); sq(8, p.blue); sq(18, p.red); sq(27, p.white);
  g.fillStyle = p.dot; g.fillRect(29, 29, 6, 6);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 합각/박공면. 'palace' = 붉은 세로 널, 'temple' = 노출 가구(가로 도리 + 황토 패널).
function makeGableTexture(style = 'palace') {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  if (style === 'temple') {
    // 수덕사 박공: 노출된 도리·인방(붉은 목재 가로선) + 황토 패널
    g.fillStyle = '#c29a5c';                      // 황토 패널 바탕
    g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#7d3f2c';                       // 붉은 목재 가로 부재
    for (let y = 8; y < 128; y += 24) g.fillRect(0, y, 256, 9);
    g.fillStyle = 'rgba(40,22,16,0.35)';
    for (let y = 8; y < 128; y += 24) g.fillRect(0, y + 9, 256, 2);
  } else {
    g.fillStyle = '#8a4634';
    g.fillRect(0, 0, 256, 128);
    g.strokeStyle = 'rgba(40,22,16,0.55)'; g.lineWidth = 3;
    for (let x = 14; x < 256; x += 18) {          // 세로 널 이음선
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke();
    }
    g.fillStyle = 'rgba(232,228,216,0.5)';        // 백색 긋기 힌트
    g.fillRect(0, 60, 256, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 황토벽: 미장 질감의 흙벽(절). 은은한 얼룩으로 흙손 자국을 흉내.
function makeHwangtoTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#c9a06a';
  g.fillRect(0, 0, 256, 256);
  // 얼룩(미장 흙손): 밝고 어두운 붓질을 무작위로 겹침
  for (let i = 0; i < 120; i++) {
    const x = _texRand() * 256, y = _texRand() * 256;
    const r = 10 + _texRand() * 40;
    const dark = _texRand() < 0.5;
    g.fillStyle = dark ? 'rgba(150,112,64,0.10)' : 'rgba(214,180,128,0.12)';
    g.beginPath(); g.ellipse(x, y, r, r * 0.6, _texRand() * Math.PI, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 띠살문(절): 목재색 살 + 한지. 세로살 위주에 가로살은 성기게.
function makeTtisalTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#e7ddc4';                        // 한지
  g.fillRect(0, 0, 256, 512);
  g.strokeStyle = '#6b4a2e';                       // 목재색 살
  g.lineWidth = 7;
  for (let x = 24; x <= 232; x += 33) {           // 세로살 (간격 1.5배로 과밀 해소)
    g.beginPath(); g.moveTo(x, 12); g.lineTo(x, 500); g.stroke();
  }
  g.lineWidth = 6;
  for (let y = 40; y <= 500; y += 40) {           // 가로살 (격자 밀도 상향)
    g.beginPath(); g.moveTo(6, y); g.lineTo(250, y); g.stroke();
  }
  g.strokeStyle = '#5a3d24'; g.lineWidth = 12;     // 굵은 띠(중간 3줄) 강조
  for (const y of [60, 256, 452]) {
    g.beginPath(); g.moveTo(6, y); g.lineTo(250, y); g.stroke();
  }
  g.lineWidth = 22;                                // 문틀
  g.strokeRect(0, 0, 256, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 세살문(반가 상급): 촘촘한 세로살 + 상부에만 성근 가로살 + 하단 넓은 청판. 정자살(격자)·띠살(굵은 띠)과
//   구별되는 "세로살 지배" 창호. 마을 반가 집집이 창호 살이 달라 보이게(#55).
function makeSesalTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#e9dfc8';                        // 한지
  g.fillRect(0, 0, 256, 512);
  g.strokeStyle = '#4e6b52'; g.lineWidth = 6;      // 초록 살(정자살과 같은 색 계열, 배치가 다름)
  for (let x = 16; x <= 240; x += 15) {           // 촘촘한 세로살(세살)
    g.beginPath(); g.moveTo(x, 6); g.lineTo(x, 404); g.stroke();
  }
  for (let y = 24; y <= 150; y += 34) {           // 상부에만 성근 가로살
    g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke();
  }
  g.fillStyle = '#4e6b52';                         // 하단 청판(넓게)
  g.fillRect(10, 408, 236, 98);
  g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 4; g.strokeRect(10, 408, 236, 98);
  g.strokeStyle = '#7d4030'; g.lineWidth = 26;     // 붉은 문틀
  g.strokeRect(0, 0, 256, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 초가 띠살문: 미색 한지 + 가늘고 성근 살 (감옥 격자 탈피, 세로 비례).
function makeChogaDoorTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#e0d5b8';                          // 미색 한지(톤 다운)
  g.fillRect(0, 0, 128, 256);
  g.strokeStyle = '#6b4a2e'; g.lineWidth = 3;       // 가는 살
  for (let x = 22; x <= 106; x += 28) {             // 세로살 (성글게)
    g.beginPath(); g.moveTo(x, 8); g.lineTo(x, 248); g.stroke();
  }
  for (const y of [64, 132, 200]) {                 // 가로살 3줄(띠)
    g.beginPath(); g.moveTo(6, y); g.lineTo(122, y); g.stroke();
  }
  g.strokeStyle = '#5a3d24'; g.lineWidth = 10;       // 가는 문틀
  g.strokeRect(0, 0, 128, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 살창(절): 세로 나무 창살 사이로 어두운 실내가 비치는 붙박이 창.
function makeSalchangTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#241d16';                         // 어두운 실내
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#6b4a2e';                         // 세로 창살 (간격 1.5배)
  for (let x = 10; x < 118; x += 21) g.fillRect(x, 6, 6, 116);
  g.strokeStyle = '#4a3320'; g.lineWidth = 12;     // 창틀
  g.strokeRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 풍판(절): 박공 아래 세로 널빤지 벽.
function makePungpanTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#997048';                         // 목재(밝은 갈색)
  g.fillRect(0, 0, 256, 128);
  g.strokeStyle = 'rgba(60,38,18,0.55)'; g.lineWidth = 3;
  for (let x = 12; x < 256; x += 20) {            // 세로 널 이음선
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke();
  }
  g.strokeStyle = 'rgba(255,240,220,0.12)'; g.lineWidth = 2;
  for (let x = 14; x < 256; x += 20) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 볏짚 지붕(초가): 내리방향 짚결이 지배적인 이엉 질감(회백~회갈, 묵은 은회색).
// 집줄(새끼 그물)은 roof.js가 3D 튜브로 얹으므로 여기선 짚결·색편차만 담당(3D 그물과 이중 방지).
// 수평 밴드는 배제 — 경사면에서 등고선 단으로 읽히던 결함 방지.
// 볏짚 이엉 텍스처. age ∈ [0,1]: 0=갓 이은 금빛 → 0.5=한두 해 바랜 황갈 → 1=오래된 회갈(이끼·얼룩).
//   마을 뷰에서 "잘 관리된 집 vs 낡은 집" 이 은근히 읽히도록 상태를 색·얼룩 밀도로 표현.
//   age 미지정 시 0.5(기존 룩 근사) — 하위호환.
export function makeThatchTexture(age = 0.5) {
  const a = Math.max(0, Math.min(1, age));
  const mix = (u, v) => Math.round(u + (v - u) * a);
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  // 바탕: 밝은 금빛(fresh) → 어두운 회갈(old). UV v=경사방향 → canvas y가 내리방향.
  g.fillStyle = `rgb(${mix(0xd6, 0x74)},${mix(0xb4, 0x70)},${mix(0x60, 0x64)})`;
  g.fillRect(0, 0, 256, 256);
  // 색 편차 패치(결 방향 길쭉). 노후일수록 어두운/이끼 얼룩↑, 신선일수록 밝은 금빛↑.
  const patches = 80 + Math.round(a * 60);
  for (let i = 0; i < patches; i++) {
    const x = _texRand() * 256, y = _texRand() * 256, r = 9 + _texRand() * 30;
    const t = _texRand();
    // 신선: 금빛 하이라이트 / 노후: 회갈·암갈
    const fresh = `rgba(${mix(206, 150)},${mix(182, 138)},${mix(118, 100)},0.12)`;
    const dark = `rgba(${mix(150, 96)},${mix(140, 90)},${mix(116, 74)},${0.11 + a * 0.08})`;
    g.fillStyle = t < 0.5 ? dark : fresh;
    g.beginPath(); g.ellipse(x, y, r * 0.55, r * 1.5, 0, 0, Math.PI * 2); g.fill();
  }
  // 노후 이끼·물얼룩(age>0.4): 초록끼 도는 어두운 반점 — 북사면 이끼·빗물 자국.
  if (a > 0.4) {
    const moss = Math.round((a - 0.4) * 180);
    for (let i = 0; i < moss; i++) {
      const x = _texRand() * 256, y = _texRand() * 256, r = 6 + _texRand() * 20;
      g.fillStyle = `rgba(${70 + _texRand() * 26},${84 + _texRand() * 30},${52 + _texRand() * 18},${0.12 + (a - 0.4) * 0.42})`;
      g.beginPath(); g.ellipse(x, y, r * 0.7, r * 1.25, 0, 0, Math.PI * 2); g.fill();
    }
  }
  // 내리방향(경사) 짚결 — 지배적, 길고 촘촘한 세로 스트로크.
  for (let i = 0; i < 900; i++) {
    const x = _texRand() * 256, y = _texRand() * 256, len = 22 + _texRand() * 56;
    const t = _texRand();
    const darkStroke = `rgba(${mix(84, 60)},${mix(74, 52)},${mix(52, 38)},${0.26 + a * 0.08})`;
    const litStroke = `rgba(${mix(210, 150)},${mix(196, 140)},${mix(150, 104)},0.28)`;
    g.strokeStyle = t < (0.42 + a * 0.18) ? darkStroke : litStroke;
    g.lineWidth = 0.8 + _texRand() * 1.3;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (_texRand() - 0.5) * 2.0, y + len); g.stroke();
  }
  // 처마 쪽(하단) 썰린 짚 끝 — 밝게 흩뿌려 겹겹이 쌓인 하단부 강조(신선일수록 밝음).
  for (let i = 0; i < 120; i++) {
    const x = _texRand() * 256, y = 176 + _texRand() * 80, len = 6 + _texRand() * 12;
    g.strokeStyle = `rgba(${mix(212, 156)},${mix(198, 148)},${mix(160, 112)},0.26)`; g.lineWidth = 1.0;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (_texRand() - 0.5) * 1.5, y + len); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 이미 만들어진 초가 재질셋(buildBuilding 산출)의 이엉 상태를 age 로 후처리한다(빌더 코어 불침해).
//   thatch 맵을 age 텍스처로 교체 + 용마름·집줄 색을 노후 정도로 어둡게. 프로토/편집 경로 공용.
export function applyThatchAge(M, age) {
  if (!M) return;
  const a = Math.max(0, Math.min(1, age));
  const lerp = (u, v) => u + (v - u) * a;
  if (M.thatch) {
    M.thatch.map?.dispose?.();
    M.thatch.map = makeThatchTexture(a);
    if (M.thatch.emissiveMap) M.thatch.emissiveMap = M.thatch.map;
    // 색틴트: 신선=따뜻한 금빛, 노후=차분한 회색끼 — 대비 증폭.
    M.thatch.color.setRGB(lerp(1.04, 0.9), lerp(1.0, 0.92), lerp(0.9, 0.94));
    // emissive: 신선일수록 따뜻·밝게(해 안 드는 사면 보정), 노후일수록 어둡고 차갑게.
    M.thatch.emissive.setRGB(lerp(0.15, 0.07), lerp(0.11, 0.08), lerp(0.05, 0.07));
    M.thatch.needsUpdate = true;
  }
  const darken = 1 - a * 0.24;                 // 용마름·집줄 새끼도 노후일수록 탈색·어둠
  M.yongmaru?.color.multiplyScalar(darken);
  M.jipjul?.color.multiplyScalar(darken);
}

// 창호 살 패턴 교체(#55): M.door 텍스처를 살 패턴으로 갈아끼운다(빌더 코어 불침해). buildBuilding 이
//   makeMaterials 직후·부재 조립 전에 호출 → 문짝 클론(map.clone())이 새 패턴을 물려받는다.
//   pattern: 'jeongja'(정자살) | 'ttisal'(띠살) | 'sesal'(세살) | 'choga'(초가 띠살).
export function applyDoorPattern(M, pattern) {
  if (!M || !M.door || !pattern) return;
  const tex = pattern === 'jeongja' ? makeDoorTexture()
    : pattern === 'sesal' ? makeSesalTexture()
    : pattern === 'ttisal' ? makeTtisalTexture()
    : pattern === 'choga' ? makeChogaDoorTexture()
    : null;
  if (!tex) return;
  M.door.map?.dispose?.();
  M.door.map = tex;
  M.door.needsUpdate = true;
}

// 막돌 기단·화방벽(초가): 불규칙한 자연석을 흙으로 물려 쌓은 거친 돌벽 질감.
function makeFieldstoneTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#8a7a60';                          // 흙 줄눈(모르타르) 바탕
  g.fillRect(0, 0, 256, 128);
  // 불규칙 막돌: 크기·색 제각각인 둥근 돌을 겹쳐 채움
  for (let i = 0; i < 90; i++) {
    const x = _texRand() * 256, y = _texRand() * 128;
    const rw = 10 + _texRand() * 22, rh = 8 + _texRand() * 16;
    const v = 150 + Math.round(_texRand() * 45);
    g.fillStyle = `rgb(${v + 8},${v - 4},${v - 28})`; // 온기 도는 자연석(황갈)
    g.beginPath(); g.ellipse(x, y, rw, rh, _texRand() * 0.6 - 0.3, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(60,50,36,0.35)'; g.lineWidth = 1.5; g.stroke();  // 돌 사이 그늘
    g.fillStyle = 'rgba(255,250,238,0.10)';          // 상단 하이라이트
    g.beginPath(); g.ellipse(x, y - rh * 0.4, rw * 0.7, rh * 0.3, 0, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 용마름 롤 텍스처: 볏짚 결 + 새끼줄(집줄) 감김을 어두운 갈색 띠로 그린다.
// 실린더 UV에서 u=둘레(canvas x), v=길이(canvas y). 둘레 전체를 감는 띠 = 가로 밴드(canvas x 전폭).
// repeat.y를 롤 길이에 맞춰 여러 개로 타일링(호출부). 3D 돌기 없이 표면 밀착.
function makeYongmaruTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#83765c';                          // 묵은 이엉 회갈(용마름은 지붕보다 살짝 짙게)
  g.fillRect(0, 0, 64, 64);
  // 엮은(헤링본) 볏짚 덮개: TubeGeometry UV u=둘레(canvas x)·v=길이(canvas y).
  // 능선 길이(canvas y)를 따라 ∧자 엮음을 층층이 쌓아 "길게 엮인 용마름"으로 읽히게 한다.
  const rows = 7;                                    // 길이 방향 엮음 층
  for (let r = 0; r < rows; r++) {
    const y0 = (r / rows) * 64;
    const yc = y0 + 64 / rows * 0.5;
    // 어두운 엮음 골(∧ 꼭짓점이 중앙, 양끝이 아래)
    g.strokeStyle = 'rgba(52,42,26,0.62)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(0, yc + 6); g.lineTo(32, y0 + 1); g.lineTo(64, yc + 6); g.stroke();
    // 밝은 짚 다발 하이라이트(엮음 위로 눌린 볏짚)
    g.strokeStyle = 'rgba(200,188,152,0.5)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, yc + 3); g.lineTo(32, y0 - 2); g.lineTo(64, yc + 3); g.stroke();
  }
  // 세로(둘레) 눌림 새끼줄 몇 가닥 — 용마름을 능선에 동여맨 자국
  g.strokeStyle = 'rgba(58,48,30,0.35)'; g.lineWidth = 1.4;
  for (let x = 8; x < 64; x += 20) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 64); g.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 수막새 와당: 처마 끝 수키와 원형 드림새. 진회 기와 바탕 + 연꽃 문양(주연부 구슬).
function makeWadangTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  const cx = 64, cy = 64;
  g.fillStyle = '#3f4249'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#565961'; g.beginPath(); g.arc(cx, cy, 60, 0, Math.PI * 2); g.fill(); // 와당 면
  // 주연부(테두리) 구슬
  g.fillStyle = '#3a3d43';
  for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; g.beginPath(); g.arc(cx + Math.cos(a) * 54, cy + Math.sin(a) * 54, 3, 0, Math.PI * 2); g.fill(); }
  // 연꽃 8판
  g.fillStyle = '#6b6e76';
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.save(); g.translate(cx, cy); g.rotate(a);
    g.beginPath(); g.ellipse(0, -30, 12, 22, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  g.fillStyle = '#787b83'; g.beginPath(); g.arc(cx, cy, 13, 0, Math.PI * 2); g.fill(); // 씨방
  g.fillStyle = '#4a4d53';
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; g.beginPath(); g.arc(cx + Math.cos(a) * 6, cy + Math.sin(a) * 6, 2, 0, Math.PI * 2); g.fill(); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 적새: 용마루/마루 옆면에 겹쳐 쌓은 암키와 켜(가로 줄). 마루가 "쌓아 올린 것"으로 읽히게.
function makeJeoksaeTexture() {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#43464c'; g.fillRect(0, 0, 32, 128);
  for (let y = 6; y < 128; y += 20) {           // 켜마다: 위 하이라이트 + 아래 그림자 홈
    g.fillStyle = 'rgba(120,124,132,0.5)'; g.fillRect(0, y, 32, 3);
    g.fillStyle = 'rgba(20,21,25,0.55)'; g.fillRect(0, y + 15, 32, 4);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 와구토: 막새 대신 기와골 끝 수키와에 회(灰)물림 한 흰 반달(반가 격식). 처마 끝에 한 골당 하나.
// 처마 스트립(u=처마방향, v=상하)에 매핑. 한 반복 = 한 기왓등 끝의 흰 반달.
function makeWagutoTexture() {
  const c = document.createElement('canvas');
  c.width = 48; c.height = 48;
  const g = c.getContext('2d');
  g.fillStyle = '#3a3d43';                          // 처마 끝 기와 그늘
  g.fillRect(0, 0, 48, 48);
  g.fillStyle = '#ece7db';                          // 흰 회물림 반달(아래로 볼록)
  g.beginPath(); g.arc(24, 4, 17, 0, Math.PI); g.fill();
  g.fillStyle = 'rgba(120,108,86,0.28)';            // 반달 하단 음영(입체감)
  g.beginPath(); g.arc(24, 4, 17, Math.PI * 0.12, Math.PI * 0.88); g.fill();
  g.fillStyle = 'rgba(255,252,244,0.6)';            // 반달 상단 하이라이트
  g.fillRect(8, 3, 32, 2);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 전돌 굴뚝: 회흑 전돌을 켜쌓기(엇쌓기) 한 벽돌 질감 + 회줄눈.
function makeJeondolTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#6a625a';                          // 회줄눈(모르타르) 바탕
  g.fillRect(0, 0, 128, 128);
  const bh = 16, bw = 32;                            // 전돌 한 장
  for (let row = 0, y = 0; y < 128; y += bh, row++) {
    const off = (row % 2) * (bw / 2);               // 엇쌓기 오프셋
    for (let x = -bw; x < 128 + bw; x += bw) {
      const bx = x + off + 1.5, by = y + 1.5, w = bw - 3, h = bh - 3;
      // 전돌 낱장: 회흑 바탕 + 미세 색편차
      const t = ((row * 7 + x) % 5) / 5;
      const cval = 62 + Math.round(t * 16);
      g.fillStyle = `rgb(${cval},${cval - 4},${cval - 8})`;
      g.fillRect(bx, by, w, h);
      g.fillStyle = 'rgba(255,255,255,0.05)';       // 윗면 하이라이트
      g.fillRect(bx, by, w, 2);
      g.fillStyle = 'rgba(0,0,0,0.22)';             // 아랫면 그늘
      g.fillRect(bx, by + h - 2, w, 2);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 우물마루: 손 탄 반질한 갈색 마루널 + 井자 장귀틀 격자.
function makeMaruTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#7a5a38'; g.fillRect(0, 0, 128, 128);
  // 마루널 결(세로) + 널 이음
  for (let i = 0; i < 100; i++) {
    const x = _texRand() * 128, y = _texRand() * 128, len = 8 + _texRand() * 20;
    g.strokeStyle = _texRand() < 0.5 ? 'rgba(60,42,24,0.25)' : 'rgba(150,120,80,0.22)';
    g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + len); g.stroke();
  }
  // 井자 장귀틀(굵은 격자)
  g.strokeStyle = 'rgba(44,30,16,0.55)'; g.lineWidth = 5;
  for (let p = 0; p <= 128; p += 64) { g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 128); g.stroke(); g.beginPath(); g.moveTo(0, p); g.lineTo(128, p); g.stroke(); }
  // 널 이음(가는 세로선)
  g.strokeStyle = 'rgba(44,30,16,0.3)'; g.lineWidth = 1.5;
  for (let x = 16; x < 128; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// style: 'palace'(궁·다포) | 'temple'(절·주심포) | 'choga'(민가·볏짚) | 'giwa'(반가·기와). 벽·창호·재료 계열을 바꾼다.
export function makeMaterials(style = 'palace') {
  const C = KOREA_COLORS;
  const temple = style === 'temple';
  const choga = style === 'choga';
  const giwa = style === 'giwa';
  const std = (color, rough = 0.85, extra = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.0, ...extra });

  // 벽: 회벽(궁) / 황토벽(절) / 심벽 회백(초가) / 흰 회벽(기와집 반가)
  const wallMat = temple
    ? std(0xffffff, 0.96, { map: makeHwangtoTexture() })
    : choga
      ? std(0xc9ad84, 0.98, { emissive: 0x322717 }) // 심벽 흙벽(밝은 황토빛 + emissive로 그늘진 측벽도 solid)
      : giwa
        ? std(0xe0dccb, 0.95, { emissive: 0x2e2a22 }) // 반가 흰 회벽(역광면도 밝게)
        : std(C.plaster, 0.95);
  // 정면 창호: 정자살문(궁) / 띠살문(절·기와집) / 가는 미색 띠살(초가)
  const doorMat = std(0xffffff, 0.9, {
    map: choga ? makeChogaDoorTexture() : (temple || giwa) ? makeTtisalTexture() : makeDoorTexture(),
  });
  // 한지 창(민무늬 광창) · 살창(절·기와 측벽)
  const hanjiMat = std(C.hanji, 0.95);
  const salchangMat = std(0xffffff, 0.85, { map: makeSalchangTexture() });
  // ── #66 야간 창호 발광 마스크: 한지 바른 창·문 재질에 "단위면적 발광 계수"를 태그. ──
  //   호롱불·등잔 시대감(저광량). 문(門)은 창호지 면적이 커 창보다 계수를 낮춰 총광량 균형.
  //   문짝은 walls.js/giwa.js 에서 per-mesh clone(M.door.clone) 되지만 Material.copy 가 userData 를
  //   깊은 복사하므로 태그가 클론에 전파 → night-glow.js·adapter.js 가 traverse 로 창·문을 일괄 식별.
  //   role 태그(instanceColor)와 독립된 필드라 마을 색 변주에 불침해.
  doorMat.userData.hanjiGlow = 0.18;
  hanjiMat.userData.hanjiGlow = 0.26;
  salchangMat.userData.hanjiGlow = 0.11;
  // 기단 석재: 절·초가·기와집은 자연석. 초가는 황갈 온기.
  const stoneCol = choga ? 0xaa9878 : (temple || giwa) ? 0xa79f8f : C.stone;
  const stoneDarkCol = choga ? 0x877559 : (temple || giwa) ? 0x847c6c : C.stoneDark;

  // 목재 톤: 궁 석간주 / 절 무단청 / 초가 어두운 고재 / 기와집 백골(회갈)
  const woodCol = choga ? 0x4e3b28 : giwa ? 0x9a8a6f : temple ? 0x87703f : C.seokganju;
  // 기와집 백골 기둥·창방이 역광에서 숯색으로 죽지 않게 미량 emissive(따뜻한 백골 유지).
  const woodExtra = giwa ? { emissive: 0x2a2015 } : {};

  const M = {
    colors: C,
    style,
    wood: std(woodCol, temple ? 0.85 : 0.8, woodExtra),         // 기둥
    woodDark: std(choga ? 0x37281a : temple ? 0x66512f : 0x6f3626, 0.85), // 인방·문틀
    woodBoard: std(temple ? 0x574531 : 0x4a3421, 0.85),         // 박공널 목재 보드
    // 창방·평방: 궁은 단청 색동, 절은 퇴색 금단청 밴드, 초가는 무단청 고재.
    beamDancheong: choga
      ? std(0x453320, 0.85)
      : temple
        ? std(0xffffff, 0.9, { map: makeTempleDancheongBandTexture() })
        : std(0xffffff, 0.85, { map: makeDancheongBandTexture(false) }),
    // 공포 바탕(뇌록). 절은 퇴색 뇌록. bracketAlt=소로 등 주홍 교차, bracketFace=마구리 연화.
    bracket: std(temple ? 0x566b60 : C.noerok, 0.85),
    bracketAlt: std(temple ? 0x8a5341 : C.juhong, 0.85),        // 공포 소로·부재 주홍 교차
    bracketFace: std(0xffffff, 0.85, { map: makeYeonhwaTexture(temple) }), // 살미·첨차 마구리 연화
    yeonmokcho: std(0xffffff, 0.85, { map: makeYeonmokchoTexture(temple) }), // 연목 마구리 연목초
    bujeoncho: std(0xffffff, 0.85, { map: makeBujeonchoTexture(temple) }),   // 부연 마구리 부연초
    rafter: std(choga ? 0x6b5138 : temple ? 0x556b60 : C.noerok, 0.85,
      choga ? { emissive: 0x1a150f } : {}),                      // 서까래 (뇌록; 절 퇴색 뇌록, 초가 고재)
    rafterEnd: std(temple ? 0xcabfa5 : C.baek, 0.8),            // 서까래 마구리(백단·헛첨차 팁)
    accentBlue: std(C.samcheong, 0.85),
    tileTex: makeTileTexture(),
    tileFlat: std(C.tile, 0.9),
    tileRidge: std(C.tileDark, 0.85),            // 마루: 기와 적층 톤
    ridgePlaster: std(0xe0d9c6, 0.94),           // 양성바름: 궁 마루(용마루·내림·추녀) 백색 회 도장
    tileConvex: std(0x6a6d73, 0.9),              // 수키와 볼록 열 (밝은 기와 마루톤)
    wadang: std(0xffffff, 0.85, { map: makeWadangTexture() }),  // 수막새 와당(처마 끝)
    waguto: std(0xffffff, 0.92, { map: makeWagutoTexture() }),  // 와구토(반가 처마 끝 흰 회물림 반달)
    jeoksae: std(0xffffff, 0.9, { map: makeJeoksaeTexture() }), // 적새(마루 옆면 켜)
    maru: std(0xffffff, 0.6, { map: makeMaruTexture() }),       // 우물마루(손 탄 반질 갈색)
    planwall: std(0x4a3a28, 0.85),                              // 판벽(대청 뒷벽, 어두운 널)
    eaveBand: std(0x2e2a28, 0.9),                // 처마 단면 띠
    thatch: std(0xffffff, 1.0, { map: makeThatchTexture(), emissive: 0x1a150e }), // 볏짚 (emissive로 해 안 드는 사면·소프릿이 검게 안 죽게)
    yongmaru: std(0xffffff, 1.0, { map: makeYongmaruTexture(), emissive: 0x0e0a05 }), // 용마름 롤(새끼줄 감김 텍스처)
    mud: std(0x9a7a54, 1.0, { emissive: 0x2a2013 }), // 진흙 굴뚝·부뚜막(초가) — 따뜻한 황토
    jipjul: std(0xb8ad90, 1.0),                  // 집줄(지붕 새끼 그물)·눌림대 새끼 — 바랜 볏짚 회금빛
    fieldstone: std(0xffffff, 0.98, { map: makeFieldstoneTexture() }), // 막돌 기단·화방벽(초가)
    jeondol: std(0xffffff, 0.95, { map: makeJeondolTexture() }), // 전돌 굴뚝(반가)
    plaster: wallMat,                            // 벽·포벽 공용
    gable: std(0xffffff, 0.9, { map: makeGableTexture(style) }),
    pungpan: std(0xffffff, 0.9, { map: makePungpanTexture() }),  // 풍판 세로널(절)
    salchang: salchangMat,                       // 살창(절) — #66 발광 태그
    stone: std(stoneCol, 0.95),
    stoneDark: std(stoneDarkCol, 0.95),
    door: doorMat,
    hanji: hanjiMat,
    ground: std(C.ground, 1.0),
  };
  tagRoles(M);
  return M;
}

// ── 재질 역할 태그(userData.role) — 마을 인스턴싱의 부위별 색 변주(instanceColor)용(태스크 #55). ──
//   지붕/벽/목부재/석재를 부위별 톤으로 독립 곱틴트하려면 어떤 InstancedMesh 가 어느 부위인지
//   식별해야 한다(각 재질=별도 InstancedMesh). 재질 clone 은 userData 를 복제하므로 태그가 전파되고,
//   tileSurfaceMaterial(지붕면 신규 재질)에도 별도로 태그한다. 태그 없는 재질(아궁이·개구부 등)은
//   중립(무틴트) — 개구부는 야간 창호광(emissive)과 충돌 방지, 아궁이는 불빛 액센트 보존.
const MATERIAL_ROLES = {
  roof: ['tileFlat', 'tileRidge', 'ridgePlaster', 'tileConvex', 'wadang', 'waguto', 'jeoksae', 'eaveBand', 'thatch', 'yongmaru', 'jipjul'],
  wall: ['plaster', 'gable', 'pungpan', 'planwall'],
  wood: ['wood', 'woodDark', 'woodBoard', 'beamDancheong', 'bracket', 'bracketAlt', 'bracketFace', 'yeonmokcho', 'bujeoncho', 'rafter', 'rafterEnd', 'accentBlue', 'maru'],
  stone: ['stone', 'stoneDark', 'fieldstone', 'jeondol'],
  opening: ['door', 'hanji', 'salchang'],   // 창호: 중립 틴트(야간 광 충돌 방지) + 변주별 살 패턴 유지 태그
};
function tagRoles(M) {
  for (const role in MATERIAL_ROLES) {
    for (const key of MATERIAL_ROLES[role]) {
      const m = M[key];
      if (m && m.isMaterial) m.userData.role = role;
    }
  }
}

// 지붕면 전용: 표면 크기에 맞춰 기와 골 반복수를 계산한 재질 생성.
// bumpScale은 호출부에서 지정(궁=0.6 유지, 절 맞배=0.9 강조).
export function tileSurfaceMaterial(mats, widthMeters, slopeMeters, bumpScale = 0.6) {
  const tex = mats.tileTex.clone();
  tex.needsUpdate = true;
  tex.anisotropy = 8;
  tex.repeat.set(Math.max(4, Math.round(widthMeters / 0.34)), Math.max(2, Math.round(slopeMeters / 0.9)));
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: tex, roughness: 0.92, metalness: 0.0,
    bumpMap: tex, bumpScale,
  });
  mat.userData.role = 'roof';   // 지붕면 신규 재질도 부위 태그(마을 기와 톤 변주, 태스크 #55)
  return mat;
}

// 수키와 롤 전용: 튜브 길이 방향(V)으로 기와 겹침 반복수를 계산한 재질 생성.
export function sugiwaMaterial(mats, lengthMeters, bumpScale = 0.45) {
  const tex = mats.tileTex.clone();
  tex.needsUpdate = true;
  tex.anisotropy = 8;
  // U 방향(둘레)은 1회 반복, V 방향(길이)은 기와 한 장 크기(0.34m) 당 1회 반복
  tex.repeat.set(1, Math.max(1, Math.round(lengthMeters / 0.34)));
  const mat = new THREE.MeshStandardMaterial({
    color: 0x6a6d73, map: tex, roughness: 0.9, metalness: 0.0,
    bumpMap: tex, bumpScale,
  });
  mat.userData.role = 'roof';
  return mat;
}

// ── 흐르는 구름 그림자 주입(#110) ─────────────────────────────────────────────
// 밀집 부감(한양급)은 화면 대부분이 지붕이라, 지형 재질에만 얹힌 구름 그늘(populate buildSiteTerrain·
//   env terrain.js)이 지붕에 가려 안 보인다. 지형과 "같은" GLSL(clouds.js export, 같은 uCloudBlobs
//   uniform 공유)을 지붕 재질에 재질별 onBeforeCompile 로 얹어 그늘이 지붕에도 흐르게 한다.
//   cloudUniforms(populate 가 만들어 clouds.js update 가 매 프레임 갱신)가 있을 때만 활성 →
//   env 단일건물(uniforms 미배선)은 미주입(무회귀). uniform 은 공유 참조로 넘겨 갱신이 끊기지 않게 한다.
// 함정 대응:
//   - 인스턴싱: 집 지붕은 InstancedMesh → CLOUD_SHADOW_VERT_BODY 가 USE_INSTANCING 시 instanceMatrix
//     를 합성(clouds.js). 지형·병합 지오는 modelMatrix 경로 그대로.
//   - 체인 순서: 기존 onBeforeCompile(있으면)을 먼저 호출(prev)해 보존. shade 는 곱연산이라 색 패치
//     순서와 무관(교환 가능)하고, color_fragment 앵커는 소비되지 않아(뒤에 append) 재치환 안전.
//   - 캐시키: three 는 onBeforeCompile 변형을 기본 프로그램 캐시키에 반영하지 않는다 → 미주입 동일
//     파라미터 재질과 프로그램을 공유하지 않도록 키를 분리(#52 실증). 기존 커스텀 키가 있으면 접미.
//   - 멱등: 공유 재질을 traverse 로 여러 번 만나도 1회만 패치(__cloudShadowPatched).
// 반환: 실제로 패치했으면 true(검증 카운트용).
export function injectCloudShadow(mat, cloudUniforms) {
  if (!mat || !mat.isMaterial || !cloudUniforms) return false;
  if (mat.userData.__cloudShadowPatched) return false;
  mat.userData.__cloudShadowPatched = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uCloudTime = cloudUniforms.uCloudTime;
    shader.uniforms.uCloudStr = cloudUniforms.uCloudStr;
    shader.uniforms.uCloudBlobs = cloudUniforms.uCloudBlobs;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CLOUD_SHADOW_VERT_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${CLOUD_SHADOW_VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CLOUD_SHADOW_FRAG_DECL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${CLOUD_SHADOW_FRAG_BODY}`);
  };
  const baseKey = (mat.customProgramCacheKey && mat.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey)
    ? mat.customProgramCacheKey() : '';
  mat.customProgramCacheKey = () => 'cloudshadow|' + baseKey;
  mat.needsUpdate = true;
  return true;
}

// 마을 root(populateVillage 산출)를 traverse 해 지붕(role='roof') 재질에 구름 그림자를 주입한다.
//   부감에서 실제로 보이는 표면은 지붕+지형이며 지형은 이미 그늘을 받으므로, 지붕만 얹어도 "구름이
//   마을 위를 흐르는" 그늘이 완결된다(벽·목부재까지 넓히면 프로그램 수만 늘어 이득 없음). 공유 재질이라
//   실 패치 수는 소수(giwa·choga·궁·절·히어로·시전 지붕 팔레트). 반환: 패치한 고유 재질 수.
export function injectVillageCloudShadow(root, cloudUniforms) {
  if (!root || !cloudUniforms) return 0;
  let n = 0;
  root.traverse((o) => {
    const m = o.material;
    if (!m) return;
    const list = Array.isArray(m) ? m : [m];
    for (const mm of list) {
      if (mm && mm.userData && mm.userData.role === 'roof' && injectCloudShadow(mm, cloudUniforms)) n++;
    }
  });
  return n;
}
