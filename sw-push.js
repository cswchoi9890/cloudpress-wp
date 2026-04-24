// sw-push.js — CloudPress Service Worker (Push 알림 + 사이트 생성 완료 알림)
// v21.0: 브라우저 알림 + Supabase 자동 이메일 발송 연동

const CACHE_NAME = 'cloudpress-v21';
const PLATFORM_URLS = [
  'https://cloud-press.co.kr',
  'https://hosting-console.cloud-press.co.kr',
  'https://status.cloud-press.co.kr',
];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));

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
  const url   = data.wpAdminUrl || data.siteUrl || 'https://hosting-console.cloud-press.co.kr/dashboard.html';

  const options = {
    body,
    icon:              '/favicon-32.png',
    badge:             '/favicon-32.png',
    tag:               data.type || 'cloudpress-notification',
    requireInteraction: true,
    vibrate:           [200, 100, 200],
    data:              { url, siteId: data.siteId, siteName: data.siteName },
    actions: [
      { action: 'open-admin',     title: '🔑 WP 관리자 열기' },
      { action: 'open-dashboard', title: '📊 대시보드' },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/* ── 알림 클릭 처리 ── */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  let targetUrl = 'https://hosting-console.cloud-press.co.kr/dashboard.html';
  if (event.action === 'open-admin') {
    targetUrl = event.notification.data?.url || targetUrl;
  } else if (event.action === 'open-dashboard') {
    targetUrl = 'https://hosting-console.cloud-press.co.kr/dashboard.html';
  } else {
    targetUrl = event.notification.data?.url || targetUrl;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          client.navigate(targetUrl);
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

/* ── 메시지 처리 (메인 스레드 → SW 통신) ── */
self.addEventListener('message', (event) => {
  const { type, payload } = event.data || {};

  if (type === 'SITE_CREATED') {
    // 사이트 생성 완료 → 브라우저 알림 표시
    const { site, adminUrl } = payload || {};
    const siteName = site?.name || '새 사이트';
    const domain   = site?.primary_domain || '';

    self.registration.showNotification('🎉 WordPress 사이트 구축 완료!', {
      body:               `"${siteName}" (${domain}) 사이트가 준비되었습니다. 지금 바로 접속하세요!`,
      icon:               '/favicon-32.png',
      badge:              '/favicon-32.png',
      tag:                'site-created-' + (site?.id || Date.now()),
      requireInteraction: true,
      vibrate:            [200, 100, 200, 100, 200],
      data:               { url: adminUrl || 'https://hosting-console.cloud-press.co.kr/dashboard.html', siteId: site?.id },
      actions: [
        { action: 'open-admin',     title: '🔑 WP 관리자 열기' },
        { action: 'open-dashboard', title: '📊 대시보드' },
      ],
    }).catch(() => {});

    // Supabase 이메일 알림 발송 (배경에서 처리)
    if (payload?.supabaseUrl && payload?.supabaseKey && payload?.email) {
      sendSupabaseEmailNotification(payload).catch(e => console.warn('[SW] 이메일 알림 실패:', e));
    }
  }
});

/* ── Supabase 이메일 알림 발송 ── */
async function sendSupabaseEmailNotification({ supabaseUrl, supabaseKey, email, site, adminUrl }) {
  if (!supabaseUrl || !supabaseKey || !email) return;
  const siteName = site?.name || '사이트';
  const domain   = site?.primary_domain || '';
  const proxyIp  = '104.21.0.1';

  // Supabase Edge Functions 또는 RPC 호출로 이메일 발송
  // (실제 이메일 템플릿은 Supabase 프로젝트의 Edge Function에서 처리)
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/send-notification`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        type:     'site_created',
        to:       email,
        subject:  `[CloudPress] "${siteName}" WordPress 사이트 구축 완료!`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0D0F1A;color:#E8EAFF;border-radius:16px;overflow:hidden">
            <div style="background:linear-gradient(135deg,#4F6EF7,#6C47FF);padding:28px 28px 20px;text-align:center">
              <h1 style="margin:0;font-size:1.5rem;color:#fff">🎉 사이트 구축 완료!</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,.8);font-size:.9rem">CloudPress WordPress 호스팅</p>
            </div>
            <div style="padding:24px 28px">
              <p style="color:#E8EAFF;font-size:.95rem"><strong>"${siteName}"</strong> WordPress 사이트가 성공적으로 구축되었습니다.</p>
              <div style="background:#13162B;border:1px solid rgba(79,110,247,.2);border-radius:10px;padding:16px;margin:16px 0">
                <div style="margin-bottom:8px;font-size:.85rem;color:#8892B0">사이트 정보</div>
                <div style="font-size:.88rem;margin-bottom:6px">🌐 도메인: <strong style="color:#4F6EF7">${domain ? 'https://' + domain : '—'}</strong></div>
                <div style="font-size:.88rem;margin-bottom:6px">🔑 WP 관리자: <strong><a href="${adminUrl || '#'}" style="color:#4F6EF7">${adminUrl || '—'}</a></strong></div>
                <div style="font-size:.85rem;color:#8892B0;margin-top:10px;padding-top:10px;border-top:1px solid rgba(79,110,247,.1)">
                  📡 연결 IP: <code style="background:rgba(79,110,247,.1);padding:2px 6px;border-radius:4px;font-family:monospace">${proxyIp}</code> (Cloudflare Anycast Proxied)
                </div>
              </div>
              <a href="${adminUrl || 'https://hosting-console.cloud-press.co.kr/dashboard.html'}" 
                 style="display:block;text-align:center;background:linear-gradient(135deg,#4F6EF7,#6C47FF);color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0">
                🚀 WordPress 관리자 접속하기
              </a>
              <p style="font-size:.78rem;color:#8892B0;text-align:center;margin-top:16px">
                보안을 위해 관리자 비밀번호를 즉시 변경해주세요.<br>
                cloud-press.co.kr | hosting-console.cloud-press.co.kr
              </p>
            </div>
          </div>
        `,
        siteId:   site?.id,
        siteName,
        domain,
        adminUrl,
        proxyIp,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.warn('[SW] Supabase 이메일 발송 오류:', res.status, txt);
    }
  } catch (e) {
    console.warn('[SW] Supabase 이메일 발송 실패:', e.message);
  }
}

/* ── 백그라운드 동기화 ── */
self.addEventListener('sync', (event) => {
  if (event.tag === 'check-site-status') {
    event.waitUntil(checkSiteStatus());
  }
});

async function checkSiteStatus() {
  // 백그라운드 상태 확인 (향후 확장)
}
