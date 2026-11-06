'use strict';
// ページを cross-origin isolated にするためのService Worker。
// GitHub Pagesは応答ヘッダーを設定できないので、同じサイトの応答にここでCOOP/COEPを付ける。
// これで SharedArrayBuffer が使えるようになり、端末内の翻訳(PLaMo)をマルチスレッドで速く動かせる。
// 応答はそのまま通すだけで、キャッシュはしない(アプリの更新はふつうに反映される)。

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (new URL(req.url).origin !== self.location.origin) return; // 外部への通信は触らない
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  e.respondWith((async () => {
    const res = await fetch(req);
    if (!res || res.status === 0 || res.type === 'opaqueredirect') return res;
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  })());
});
