// SPA 엔트리. 웹폰트 미사용(#132) — 시스템 기본 폰트만 사용해 로딩 부담 제거.
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
