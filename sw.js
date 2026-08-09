// self.location.search 會是註冊時帶的查詢字串（例如 "?v=2026.07.23-2"），
// 這樣快取名稱會自動跟著 index.html 裡的 APP_VERSION 換掉，
// 不用每次發新版都手動記得改這裡的雜湊值。
const SW_VERSION = new URLSearchParams(self.location.search).get('v') || 'dev';
const CACHE_NAME = `battle-tracker-${SW_VERSION}`;
const APP_SHELL = ['./', './index.html'];
// 「有的話就順便快取起來，沒有也不影響」的附加資源。Excel 匯入用的函式庫
// 放在這裡而不是 APP_SHELL，是刻意的：APP_SHELL 只要有任何一個抓不到，
// install 就會整個失敗、新版本無法安裝。函式庫檔名打錯、忘記上傳、或哪天
// 決定不放了，都不該讓整個 App 更新不了——那個代價遠大於「Excel 匯入這次
// 沒被預先快取」。所以這裡採 best-effort：抓得到就存，抓不到就安靜略過，
// 等使用者第一次線上使用時再由 fetch 事件的快取邏輯補上。
const OPTIONAL_ASSETS = ['./xlsx.full.min.js'];

async function precache(cache) {
  // Force each app-shell file to be fetched straight from the network,
  // bypassing the browser's own HTTP cache. Without this, a stale
  // browser-cached copy of index.html could silently get baked into the
  // Service Worker's cache on "update", making every future update check
  // report "already latest" while the visible app stays on the old version.
  await Promise.all(APP_SHELL.map(async url => {
    const response = await fetch(url, { cache: 'reload' });
    // 驗證回應是不是真的成功、內容類型看起來是HTML——部署設定錯誤、伺服器
    // 暫時性錯誤、或反向代理回傳的404頁/登入頁，都可能被誤當成app shell
    // 存進快取，之後離線時使用者拿到的就會是這個錯誤內容，而不是真正的App。
    // 驗證失敗就直接丟出錯誤，讓install事件失敗——這樣舊版本的Service Worker
    // 跟快取會繼續留著正常運作，不會被這個不完整、內容錯誤的新快取取代掉。
    if (!response.ok) {
      throw new Error(`precache failed: ${url} responded with status ${response.status}`);
    }
    const contentType = response.headers.get('content-type') || '';
    if (url.endsWith('.html') && contentType && !contentType.includes('html')) {
      throw new Error(`precache failed: ${url} unexpected content-type "${contentType}"`);
    }
    await cache.put(url, response);
  }));
}

async function precacheOptional(cache) {
  await Promise.all(OPTIONAL_ASSETS.map(async url => {
    try {
      const response = await fetch(url, { cache: 'reload' });
      if (response.ok) await cache.put(url, response);
    } catch {
      // 安靜略過：這些資源缺席不該讓安裝失敗。
    }
  }));
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async cache => {
        await precache(cache);
        await precacheOptional(cache);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      // Navigation Preload: let the browser start the network request for a
      // page navigation in parallel with the service worker booting up,
      // instead of waiting for the SW to spin up before any fetch begins.
      // This shortens the "blank tab" time on cold starts / right after an
      // SW update, without changing the cache-first behavior below.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      const keys = await caches.keys();
      // 只清掉這個 App 自己的舊快取（battle-tracker- 前綴）。原本是「只要名字
      // 不等於目前版本就刪」，如果同一個網域下還有別的頁面或工具放了自己的
      // Cache Storage，會被這裡一併誤刪。加上前綴判斷後，就只會動到自己的。
      const staleKeys = keys.filter(k => k.startsWith('battle-tracker-') && k !== CACHE_NAME);
      await Promise.all(staleKeys.map(k => caches.delete(k)));
      await self.clients.claim();
      // Only notify existing tabs if this activation actually replaced an older
      // version's cache (i.e. skip the notification on a brand-new install).
      if (staleKeys.length === 0) return;
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' }));
    })()
  );
});

// Absolute URLs of the app-shell entries, so we can tell "is this request the
// shell?" even though the request URL is absolute but APP_SHELL is relative.
const APP_SHELL_URLS = new Set(APP_SHELL.map(url => new URL(url, self.registration.scope).href));

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const isNavigation = event.request.mode === 'navigate';
  const isAppShell = isNavigation || APP_SHELL_URLS.has(event.request.url);

  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);

      // Any other (currently: non-existent, but future-proofed) static asset:
      // pure cache-first. If it's already cached, serve it immediately with no
      // network round-trip at all. Only hit the network on a genuine cache miss,
      // and cache the result for next time.
      const isVersionCheck = new URL(event.request.url).pathname.endsWith('/version.json');
      if (!isAppShell) {
        if (cached) return cached;
        try {
          const networkResponse = await fetch(event.request);
          // 除了正常的 status===200，也接受 opaque 回應（跨網域、沒有帶
          // CORS 標頭的請求會是這種類型，例如 Excel 匯入功能需要的函式庫
          // 從 cdnjs 這類外部 CDN 載入時就常常是這樣）。Service Worker 本來
          // 就能快取 opaque 回應，只是沒辦法檢視它實際的內容或狀態碼——
          // 但快取起來，離線時還是能正常拿出來用，不需要依賴對方伺服器
          // 有沒有穩定送出 CORS 標頭。
          if (!isVersionCheck && networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(() => {});
          }
          return networkResponse;
        } catch {
          return cached;
        }
      }

      // App-shell / navigation: keep the existing stale-while-revalidate
      // behaviour, since we deliberately want a background network hit every
      // time so version updates get detected promptly.
      // 導航請求如果帶有查詢參數（例如 index.html?_r=xyz 這種為了避開快取
      // 而加上去的參數），前面用「完整請求網址」去比對快取，會完全找不到
      // 東西——因為預先快取起來的只有沒有帶參數的 './' 和 './index.html'
      // 這兩個固定網址。離線時如果只依賴這個對不上的查詢結果，會導致
      // 完全沒有東西可以回應、直接開啟失敗。改成導航請求離線時，一律
      // 固定去比對 './index.html' 這個 app shell 的網址，不管原本的
      // 請求帶了什麼查詢參數，都能正確拿到離線可用的版本。
      const appShellFallback = isNavigation ? await caches.match('./index.html') : cached;
      const networkFetch = (async () => {
        try {
          // Reuse the preloaded navigation response when available so we don't
          // issue a second, duplicate network request for the same navigation.
          const preload = event.preloadResponse ? await event.preloadResponse : null;
          const networkResponse = preload || await fetch(event.request, { cache: 'no-store' });
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(() => {});
          }
          return networkResponse;
        } catch {
          // 極端情況：連app shell本身的快取都不存在（正常情況下不會發生，
          // 因為install事件成功時，precache()一定已經把index.html存進去了；
          // 唯一可能是外部把快取清空過）。這種情況下appShellFallback也會是
          // undefined，如果直接把undefined交給respondWith()，瀏覽器只會顯示
          // 一個很難懂的原生錯誤畫面。加上一個最基本的純文字離線提示當作
          // 最後防線，至少讓使用者知道發生了什麼事、該怎麼處理。
          return appShellFallback || new Response(
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>離線中</title></head><body style="font-family:sans-serif;padding:40px;text-align:center;color:#333"><h1>目前離線，且找不到可用的快取版本</h1><p>請確認網路連線後重新整理，或至少成功連線一次讓應用程式完成離線快取。</p></body></html>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        }
      })();
      return cached || appShellFallback || networkFetch;
    })()
  );
});
