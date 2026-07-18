// cheoma 서비스워커 (#46) — 프로덕션 자산 캐시. 재방문 즉시 로드 + 오프라인.
// 전략: HTML(내비게이션)은 network-first(새 빌드 항상 반영), 해시된 자산(JS/CSS/폰트/오디오/이미지)은
//   cache-first(파일명 해시가 곧 버전이라 불변 — 네트워크 왕복 제거). 버전 올리면 구캐시 정리.
// dev(HMR) 에는 등록되지 않는다(main.js 가 import.meta.env.PROD 로 게이트) → 사용자 dev 서버 불간섭.
const CACHE = 'cheoma-v1';

self.addEventListener('install', (e) => {
  // 앱 셸 선캐시(오프라인 진입 보장). 해시 자산은 런타임 cache-first 로 첫 제어 fetch 때 캐시된다.
  e.waitUntil((async () => {
    try { const c = await caches.open(CACHE); await c.addAll(['./', './index.html']); } catch { /* 셸 선캐시 실패 무해 */ }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 동일 출처만(외부 무의존 앱이라 사실상 전부)

  const isDoc = req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');
  if (isDoc) {
    // network-first: 최신 빌드 우선, 오프라인이면 캐시 폴백.
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        const c = await caches.open(CACHE); c.put(req, net.clone());
        return net;
      } catch {
        return (await caches.match(req)) || (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // cache-first: 해시 자산은 불변 — 한 번 받으면 캐시에서 즉시 응답.
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const net = await fetch(req);
      if (net && net.ok) { const c = await caches.open(CACHE); c.put(req, net.clone()); }
      return net;
    } catch {
      return hit || Response.error();
    }
  })());
});
