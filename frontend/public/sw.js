// 서비스 워커: 문서 변환기 파일(/converter/…, 약 240MB)만 브라우저 저장소(Cache Storage)에 보관해
// 두 번째부터는 내려받지 않게 한다. 브라우저의 일반 HTTP 캐시는 이렇게 큰 파일을 보관하지 않아 매번 다시 받았다.
// - 다른 요청(페이지·API·암호문)은 손대지 않고 그대로 네트워크로 보낸다. 사용자 데이터는 저장하지 않는다.
// - 변환기 파일은 경로에 버전이 있어 내용이 바뀌지 않으므로 '저장본 우선'이 안전하다.
const CACHE = 'printcode-converter';
const PREFIX = '/converter/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(PREFIX)) {
    return; // 변환기 파일이 아니면 관여하지 않음
  }
  event.respondWith(fromCacheOrNetwork(event.request, url));
});

async function fromCacheOrNetwork(request, url) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    // 헤더(CSP·CORP 등)까지 함께 저장된다. 저장 실패(용량 부족 등)는 무시하고 네트워크 응답을 쓴다.
    cache
      .put(request, response.clone())
      .then(() => removeOtherVersions(cache, url))
      .catch(() => {});
  }
  return response;
}

// 새 버전 파일을 저장하면, 다른 버전(/converter/<다른 버전>/…) 파일은 지운다.
async function removeOtherVersions(cache, url) {
  const current = url.pathname.split('/')[2];
  for (const req of await cache.keys()) {
    if (new URL(req.url).pathname.split('/')[2] !== current) await cache.delete(req);
  }
}
