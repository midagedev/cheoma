// 포스트카드 캡처 — 현재 뷰 위에 낙관(도장)을 찍어 공유용 한 장을 만든다.
//   capturePostcard(renderer, render, { title, filename, download }) → dataURL(PNG)
//
// render() 는 현재 모드(pbr/dof/ink) 그대로 한 프레임을 렌더하는 콜백.
// preserveDrawingBuffer 없이도, render 직후 같은 태스크 안에서 캔버스를 읽으면
// 드로잉 버퍼가 유효하므로 그대로 2D 캔버스에 복사해 낙관을 합성한다.
// pixelRatio 2 로의 승격은 컴포저 크기와 함께 호출부(main.js)에서 처리한다.

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 결정적 마모 노이즈용 소형 RNG.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 낙관(전각 인장): 우하단에 작은 빨간 전각 사각 + 백문 '처마' 2자 + 옆 초소형 서명.
// 스탬프 높이는 화면의 ~6%. 마모 노이즈로 손으로 찍은 자국의 절제된 질감.
//
// 이 낙관은 **종이가 아니라 렌더된 씬 위에** 합성된다. 원래 서명은 종이 잉크색
// (rgba(40,34,28,.72))이라 어두운 화강암 돔이나 역광 능선 위에서 완전히 사라졌고,
// 전각도 밝은 논/어두운 돔 경계에 걸쳐 판독이 프레임 운에 좌우됐다. 그래서:
//   1) 낙관+워드마크 클러스터 밑에 코너 비네트를 깔아 지역 배경을 항상 어둡게 만든다
//      (사진 관례 — UI 박스가 아니라 대기 요소라 look 문법과 충돌하지 않는다),
//   2) 워드마크를 종이색 밝은 글자 + 어두운 헤일로로 뒤집어 밝은 하늘에서도 읽히게,
//   3) 클러스터 전체를 측정해 세이프 에어리어 안에 넣고, 폭이 부족하면 워드마크를
//      전각 아래로 접는다.
function drawSeal(ctx, W, H, title) {
  const sealH = Math.round(H * 0.062);
  const sealW = Math.round(sealH * 0.76);
  // 세이프 에어리어는 짧은 변 기준 — 가로/세로 어느 비율에서도 같은 여백으로 읽힌다.
  const margin = Math.round(Math.min(W, H) * 0.038);
  const x = W - margin - sealW;
  const y = H - margin - sealH;

  // ── 워드마크 측정(백킹 크기를 정하려면 먼저 재야 한다) ──
  const wordText = title || 'cheoma';
  const fs2 = Math.max(7, Math.round(H * 0.0105));
  const wordFont = `${fs2}px Georgia,"Times New Roman",serif`;
  ctx.save();
  ctx.font = wordFont;
  const wordW = Math.ceil(ctx.measureText(wordText).width);
  ctx.restore();
  const gap = Math.round(sealW * 0.35);
  // 워드마크가 왼쪽 세이프 라인을 넘으면 전각 아래로 접는다(작은 캔버스·긴 제목).
  const stacked = x - gap - wordW < margin;
  const clusterLeft = stacked ? Math.max(margin, x - Math.round(sealW * 0.2)) : x - gap - wordW;
  const clusterTop = stacked ? y - fs2 * 1.6 : y;

  // ── 코너 비네트: 워드마크·전각이 어떤 프레임에서도 어두운 바탕을 갖도록 ──
  const pad = Math.round(sealH * 0.7);
  const reach = Math.round(
    Math.hypot(W - clusterLeft + pad, H - clusterTop + pad) * 1.05,
  );
  const scrim = ctx.createRadialGradient(W, H, 0, W, H, reach);
  scrim.addColorStop(0, 'rgba(10, 9, 8, 0.46)');
  scrim.addColorStop(0.55, 'rgba(10, 9, 8, 0.26)');
  scrim.addColorStop(1, 'rgba(10, 9, 8, 0)');
  ctx.save();
  ctx.fillStyle = scrim;
  ctx.fillRect(W - reach, H - reach, reach, reach);
  ctx.restore();

  // 낙관은 별도 캔버스에 그린 뒤 마모(destination-out)를 파내고 합성 → 눌린 자국.
  const s = document.createElement('canvas');
  s.width = sealW; s.height = sealH;
  const c = s.getContext('2d');

  const r = Math.max(2, Math.round(sealW * 0.1));
  roundRect(c, 0, 0, sealW, sealH, r);
  c.fillStyle = '#b1362b';                 // 인주(주묵) 빨강
  c.fill();
  // 안쪽 눌림 테
  const lw = Math.max(1, sealW * 0.03);
  c.lineWidth = lw;
  roundRect(c, lw, lw, sealW - 2 * lw, sealH - 2 * lw, r * 0.7);
  c.strokeStyle = 'rgba(90,25,18,0.35)';
  c.stroke();

  // 백문(글자는 종이색으로 뚫림) — 한글 전각 '처마' 2자 세로 스택. 한국어 명조 폴백 체인.
  c.fillStyle = '#f4efe4';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const fs = Math.round(sealW * 0.56);
  c.font = `700 ${fs}px "AppleMyungjo","Nanum Myeongjo","Noto Serif CJK KR","Apple SD Gothic Neo",serif`;
  c.fillText('처', sealW / 2, sealH * 0.30);
  c.fillText('마', sealW / 2, sealH * 0.71);

  // 마모: 가장자리에 더 잦게 인주가 덜 묻은 자국을 파낸다.
  c.globalCompositeOperation = 'destination-out';
  const rnd = mulberry32(0x9e3779b9);
  const specks = Math.round(sealW * sealH * 0.02);
  for (let i = 0; i < specks; i++) {
    const px = rnd() * sealW, py = rnd() * sealH;
    const edge = Math.min(px, py, sealW - px, sealH - py) / (sealW * 0.5);
    if (rnd() < 0.5 + (1 - edge) * 0.5) {
      c.globalAlpha = 0.15 + rnd() * 0.5;
      c.beginPath();
      c.arc(px, py, 0.4 + rnd() * 1.6, 0, Math.PI * 2);
      c.fill();
    }
  }
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';

  // 합성 — 종이에 눌린 옅은 그림자.
  ctx.save();
  // 종이 위 눌림 그림자보다 조금 진하게 — 밝은 논/하늘 경계에 걸쳐도 전각 윤곽이 붙지 않는다.
  ctx.shadowColor = 'rgba(24,14,10,0.42)';
  ctx.shadowBlur = Math.max(2, sealW * 0.12);
  ctx.shadowOffsetY = Math.max(1, sealW * 0.03);
  ctx.drawImage(s, x, y);
  ctx.restore();

  // 워드마크 — 종이색 글자 + 어두운 헤일로. 비네트가 바탕을 눌러 주므로 어두운 돔에서도,
  //   헤일로가 있어 밝은 하늘·논에서도 읽힌다(밝기 어느 쪽으로도 무너지지 않는 조합).
  //   수묵처럼 여백이 흰 프레임에서는 비네트만으로 대비가 얕아진다. 코너를 더 어둡게 칠하는 대신
  //   글자 주변만 두 번 겹쳐 번지게 해서(먹 번짐과 같은 성질) 대비를 올린다 — 흰 종이 위에서도
  //   국소 배경이 확실히 눌리고, 코너 전체는 깨끗하게 남는다.
  ctx.save();
  ctx.font = wordFont;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'right';
  const wx = stacked ? x + sealW : x - gap;
  const wy = stacked ? y - Math.round(fs2 * 0.55) : y + sealH - fs2 * 0.3;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.58)';
  ctx.shadowBlur = Math.max(2, fs2 * 1.1);
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = 'rgba(246, 241, 232, 0.96)';
  ctx.fillText(wordText, wx, wy);
  ctx.fillText(wordText, wx, wy);   // 2패스 — 헤일로 밀도만 배가, 글자 두께는 그대로
  ctx.restore();
}

export function capturePostcard(renderer, render, { title = 'cheoma', filename, download = true } = {}) {
  render(); // 현재 모드로 한 프레임을 지금 렌더 → 드로잉 버퍼 유효

  const src = renderer.domElement;
  const out = document.createElement('canvas');
  out.width = src.width;   // 디바이스 픽셀(=CSS폭 × pixelRatio)
  out.height = src.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0);

  drawSeal(ctx, out.width, out.height, title);

  const url = out.toDataURL('image/png');
  if (download) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'cheoma.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  return url;
}
