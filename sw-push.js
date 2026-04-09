// sw-push.js — CloudPress Service Worker (크롬 Push 알림)
// ✅ 수정5: 사이트 생성 완료 시 크롬 알림

const CACHE_NAME = 'cloudpress-v4';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

/* ── Push 알림 수신 ── */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { message: event.data ? event.data.text() : '알림이 도착했습니다.' };
  }

  const title = data.title || '✅ CloudPress 알림';
  const body  = data.message || data.body || 'WordPress 사이트 작업이 완료되었습니다.';
  const url   = data.wpAdminUrl || data.siteUrl || '/dashboard.html';
  const icon  = '/favicon-32.png';
  const badge = '/favicon-32.png';

  const options = {
    body,
    icon,
    badge,
    tag: data.type || 'cloudpress-notification',
    requireInteraction: true,
    vibrate: [200, 100, 200],
    data: { url, siteId: data.siteId },
    actions: [
      { action: 'open-admin', title: 'WP 관리자 열기' },
      { action: 'open-dashboard', title: '대시보드' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

/* ── 알림 클릭 처리 ── */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  let targetUrl = '/dashboard.html';

  if (event.action === 'open-admin') {
    targetUrl = event.notification.data?.url || '/dashboard.html';
  } else if (event.action === 'open-dashboard') {
    targetUrl = '/dashboard.html';
  } else {
    targetUrl = event.notification.data?.url || '/dashboard.html';
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // 이미 열린 탭이 있으면 포커스
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          client.navigate(targetUrl);
          return;
        }
      }
      // 없으면 새 탭 열기
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

/* ── 백그라운드 동기화 (선택적) ── */
self.addEventListener('sync', (event) => {
  if (event.tag === 'check-site-status') {
    event.waitUntil(checkSiteStatus());
  }
});

async function checkSiteStatus() {
  // 백그라운드에서 사이트 상태 확인 (향후 확장)
}
