// SPA 엔트리. 웹폰트 미사용(#132) — 시스템 기본 폰트만 사용해 로딩 부담 제거.
import './styles/global.css';

import { mount, unmount } from 'svelte';
import App from './App.svelte';

const app = mount(App, { target: document.getElementById('app') });
let disposePromise = null;
let serviceWorkerLoad = null;

// Product teardown boundary. Repeated callers share one promise, so the Svelte
// component tree and its engine owner are unmounted exactly once.
export function disposeApp() {
  if (!disposePromise) {
    disposePromise = (async () => {
      if (serviceWorkerLoad) {
        removeEventListener('load', serviceWorkerLoad);
        serviceWorkerLoad = null;
      }
      await unmount(app);
    })();
  }
  return disposePromise;
}

// 서비스워커(#46): 프로덕션 빌드에서만 등록 — 자산 캐시로 재방문 즉시 로드·오프라인.
// dev(import.meta.env.PROD=false)에는 등록 안 함 → HMR·사용자 dev 서버(5174) 불간섭.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  serviceWorkerLoad = () => {
    serviceWorkerLoad = null;
    navigator.serviceWorker.register('sw.js').catch(() => {});
  };
  addEventListener('load', serviceWorkerLoad, { once: true });
}

export default app;
