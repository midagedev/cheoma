// 재질 생성과 저비용 프록시가 함께 쓰는 sRGB 색 토큰. THREE에 의존하지 않아 순수 계획/형상
// 검사에서도 실제 팔레트와 같은 선형 색을 계산할 수 있다.
export const KOREA_COLORS = {
  seokganju: 0x8e4a35,
  noerok: 0x4c6559,
  juhong: 0x9c4632,
  samcheong: 0x3e5f9e,
  hwang: 0xc8a34a,
  baek: 0xe8e4d8,
  meok: 0x2e2a28,
  tile: 0x4a4d53,
  tileDark: 0x4b4e55,
  plaster: 0xd9d2c4,
  stone: 0xb8b2a6,
  stoneDark: 0x99938a,
  hanji: 0xefe6d2,
  ground: 0xb5a893,
};

export const VILLAGE_MATERIAL_COLORS = {
  giwaRoofAverage: 0x56585f, // tile texture의 홈·등 하이라이트를 합친 원경 평균
  giwaWall: 0xe0dccb,
  giwaWood: 0x9a8a6f,
  chogaWall: 0xc9ad84,
  chogaWood: 0x4e3b28,
  chogaRidge: 0x766748,
};

export function srgbChannelToLinear(channel) {
  const value = Math.min(1, Math.max(0, channel));
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

export function srgbHexToLinear3(hex) {
  return [
    srgbChannelToLinear(((hex >> 16) & 0xff) / 255),
    srgbChannelToLinear(((hex >> 8) & 0xff) / 255),
    srgbChannelToLinear((hex & 0xff) / 255),
  ];
}
