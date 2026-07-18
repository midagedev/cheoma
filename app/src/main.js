// SPA 엔트리. 웹폰트는 로컬 번들(@fontsource, 외부 CDN 무의존).
import '@fontsource/nanum-myeongjo/latin-400.css';
import '@fontsource/nanum-myeongjo/latin-700.css';
import '@fontsource/nanum-myeongjo/korean-400.css';
import '@fontsource/nanum-myeongjo/korean-700.css';
import '@fontsource/nanum-brush-script/latin-400.css';
import '@fontsource/nanum-brush-script/korean-400.css';
import './styles/global.css';

import { mount } from 'svelte';
import App from './App.svelte';

const app = mount(App, { target: document.getElementById('app') });

// 서비스워커(#46): 프로덕션 빌드에서만 등록 — 자산 캐시로 재방문 즉시 로드·오프라인.
// dev(import.meta.env.PROD=false)에는 등록 안 함 → HMR·사용자 dev 서버(5174) 불간섭.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}

export default app;
