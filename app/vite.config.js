import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

// 코어(../src)는 프레임워크 무관 ES 모듈 그대로 import 한다.
// vite dev/preview 가 앱 루트 밖(상위 디렉토리)의 파일을 읽을 수 있도록 fs.allow 를 넓힌다.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// 코어(../src)는 bare 'three' 를 import 한다. 그 파일들이 앱 루트 밖에 있어 노드
// 해석이 app/node_modules 를 못 찾으므로, three 를 앱의 설치본으로 명시 고정한다(중복 방지).
const threeMain = fileURLToPath(new URL('./node_modules/three/build/three.module.js', import.meta.url));
const threeAddons = fileURLToPath(new URL('./node_modules/three/examples/jsm/', import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  base: './',
  resolve: {
    alias: [
      { find: /^three\/addons\//, replacement: threeAddons },
      { find: /^three$/, replacement: threeMain },
    ],
    dedupe: ['three'],
  },
  server: {
    fs: { allow: [repoRoot] },
  },
  build: {
    target: 'es2022',
    // 코어가 assets/audio 를 런타임 상대경로로 참조하므로 자산 인라인 임계값은 낮춘다.
    assetsInlineLimit: 0,
  },
});
