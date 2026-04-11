/**
 * CloudPress Proxy Worker v12.0
 *
 * 아키텍처:
 *   - WP origin은 프록시 타겟일 뿐, origin에 별도 요청/신호 없음
 *   - 각 사이트는 독립된 D1(site_d1_id) + KV(site_kv_id) 보유
 *   - 도메인 → 사이트 조회는 CACHE KV 우선, fallback은 메인 DB
 *   - 페이지 캐시는 사이트 전용 KV(site_kv_id)에 저장 → 완전 격리
 *   - R2 사용 없음
 *
 * 환경 변수 (wrangler.toml):
 *   WP_ORIGIN_URL    — https://origin.cloudpress.site
 *   WP_ORIGIN_SECRET — mu-plugin 공유 시크릿
 *   DB               — D1 binding (메인 DB)
 *   CACHE            — KV binding (도메인 매핑 캐시)
 *
 * 사이트별 D1/KV는 Cloudflare API로 생성된 독립 리소스이며,
 * Worker 바인딩이 아닌 CF API(D1 HTTP API / KV REST API)로 접근합니다.
 * → wrangler.toml 재배포 없이 신규 사이트 D1/KV에 동적으로 접근 가능
 */

const CF_KV_API = 'https://api.cloudflare.com/client/v4';

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const host = url.hostname.replace(/^www\./, '');

    // ── 1. 관리 API / 내부 경로는 프록시 안 함 ──────────────────
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__cloudpress/')) {
      return fetch(request);
    }

    // ── 2. 사이트 조회 (CACHE KV 우선 → 메인 D1 fallback) ───────
    let site = null;
    const cacheKey = `site_domain:${host}`;

    try {
      const cached = await env.CACHE.get(cacheKey, { type: 'json' });
      if (cached) {
        site = cached;
      } else {
        const row = await env.DB.prepare(
          `SELECT id, name, site_prefix,
                  site_d1_id, site_kv_id,
                  wp_admin_url, status, suspended, suspension_reason
           FROM sites
           WHERE primary_domain=?
             AND status='active'
             AND deleted_at IS NULL
             AND suspended=0
           LIMIT 1`
        ).bind(host).first();

        if (row) {
          site = row;
          // 5분 캐시
          await env.CACHE.put(cacheKey, JSON.stringify(row), { expirationTtl: 300 });
        }
      }
    } catch (e) {
      return errorPage(500, '서버 오류', e.message);
    }

    if (!site) {
      return errorPage(404, '사이트를 찾을 수 없습니다', `${host}에 연결된 사이트가 없습니다.`);
    }
    if (site.suspended) {
      return suspendedPage(site.name, site.suspension_reason);
    }

    // ── 3. WP Admin 리다이렉트 ───────────────────────────────────
    if (url.pathname.startsWith('/wp-admin') || url.pathname === '/wp-login.php') {
      const adminBase = env.WP_ORIGIN_URL.replace(/\/$/, '');
      const target    = new URL(adminBase + url.pathname + url.search);
      target.searchParams.set('cp_site', site.site_prefix);
      return Response.redirect(target.toString(), 302);
    }

    // ── 4. 페이지 캐시 조회 (GET, 비로그인, 비WP 경로만) ─────────
    const isCacheable = request.method === 'GET'
      && !url.pathname.startsWith('/wp-')
      && !url.searchParams.has('preview')
      && !request.headers.get('cookie')?.includes('wordpress_logged_in');

    if (isCacheable && site.site_kv_id && env.CF_ACCOUNT_ID && env.CF_API_TOKEN) {
      const pageCacheKey = `page:${url.pathname}${url.search || ''}`;
      const cached = await kvGet(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, site.site_kv_id, pageCacheKey);
      if (cached) {
        return new Response(cached.body, {
          headers: {
            'Content-Type': cached.contentType || 'text/html; charset=utf-8',
            'X-Cache':       'HIT',
            'X-Site-Prefix': site.site_prefix,
          },
        });
      }
    }

    // ── 5. WP Origin으로 프록시 ──────────────────────────────────
    const originUrl = new URL(env.WP_ORIGIN_URL);
    originUrl.pathname = url.pathname;
    originUrl.search   = url.search;

    const proxyHeaders = new Headers(request.headers);
    proxyHeaders.set('X-CloudPress-Site',    site.site_prefix);
    proxyHeaders.set('X-CloudPress-Secret',  env.WP_ORIGIN_SECRET);
    proxyHeaders.set('X-CloudPress-Domain',  url.hostname);
    proxyHeaders.set('X-CloudPress-D1-ID',   site.site_d1_id  || '');
    proxyHeaders.set('X-CloudPress-KV-ID',   site.site_kv_id  || '');
    proxyHeaders.set('Host',                 originUrl.hostname);
    proxyHeaders.set('X-Forwarded-Host',     url.hostname);
    proxyHeaders.set('X-Forwarded-Proto',    'https');
    proxyHeaders.set('X-Real-IP',            request.headers.get('CF-Connecting-IP') || '');

    let originRes;
    try {
      originRes = await fetch(originUrl.toString(), {
        method:   request.method,
        headers:  proxyHeaders,
        body:     ['GET', 'HEAD'].includes(request.method) ? null : request.body,
        redirect: 'manual',
      });
    } catch (e) {
      return errorPage(502, 'Origin 연결 실패', e.message);
    }

    // ── 6. 리다이렉트 처리 — origin URL → 개인 도메인 교체 ───────
    if (originRes.status >= 300 && originRes.status < 400) {
      const loc = originRes.headers.get('Location') || '';
      const fixed = loc.startsWith(env.WP_ORIGIN_URL)
        ? url.origin + loc.slice(env.WP_ORIGIN_URL.length)
        : loc;
      return new Response(null, { status: originRes.status, headers: { 'Location': fixed } });
    }

    // ── 7. 응답 헤더 구성 ────────────────────────────────────────
    const resHeaders = new Headers();
    const skip = new Set(['transfer-encoding','content-encoding','content-length','connection','keep-alive']);
    for (const [k, v] of originRes.headers) {
      if (!skip.has(k.toLowerCase())) resHeaders.set(k, v);
    }
    resHeaders.set('X-Cache',        'MISS');
    resHeaders.set('X-Site-Prefix',  site.site_prefix);
    resHeaders.set('X-Frame-Options', 'SAMEORIGIN');
    resHeaders.set('X-Content-Type-Options', 'nosniff');

    const contentType = originRes.headers.get('content-type') || '';

    // ── 8. HTML — origin URL 치환 + 페이지 캐시 저장 ────────────
    if (contentType.includes('text/html')) {
      const html      = await originRes.text();
      const rewritten = rewriteOrigin(html, env.WP_ORIGIN_URL, url.origin, originUrl.hostname, url.hostname);

      // 사이트 전용 KV에 페이지 캐시 저장 (10분)
      if (isCacheable && originRes.status === 200 && site.site_kv_id && env.CF_ACCOUNT_ID && env.CF_API_TOKEN) {
        const pageCacheKey = `page:${url.pathname}${url.search || ''}`;
        kvPut(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, site.site_kv_id, pageCacheKey, {
          body: rewritten, contentType,
        }, 600).catch(() => {});
      }

      return new Response(rewritten, { status: originRes.status, headers: resHeaders });
    }

    // ── 9. CSS/JS — origin URL 치환 ─────────────────────────────
    if (contentType.includes('text/css') || contentType.includes('javascript')) {
      const text      = await originRes.text();
      const rewritten = rewriteOrigin(text, env.WP_ORIGIN_URL, url.origin, originUrl.hostname, url.hostname);
      return new Response(rewritten, { status: originRes.status, headers: resHeaders });
    }

    // ── 10. 바이너리 (이미지, 폰트 등) — 그대로 통과 ────────────
    return new Response(originRes.body, { status: originRes.status, headers: resHeaders });
  },
};

// ══════════════════════════════════════════════════════════════════════
// 사이트 전용 KV REST API 헬퍼
// (wrangler 바인딩 없이 CF REST API로 사이트 전용 KV에 동적 접근)
// ══════════════════════════════════════════════════════════════════════

async function kvGet(apiToken, accountId, namespaceId, key) {
  try {
    const res = await fetch(
      `${CF_KV_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
      { headers: { 'Authorization': 'Bearer ' + apiToken } }
    );
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch { return null; }
}

async function kvPut(apiToken, accountId, namespaceId, key, value, ttl = 600) {
  const encoded = JSON.stringify(value);
  await fetch(
    `${CF_KV_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}?expiration_ttl=${ttl}`,
    {
      method:  'PUT',
      headers: { 'Authorization': 'Bearer ' + apiToken, 'Content-Type': 'application/json' },
      body:    encoded,
    }
  );
}

// ══════════════════════════════════════════════════════════════════════
// 헬퍼
// ══════════════════════════════════════════════════════════════════════

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteOrigin(text, originBase, personalBase, originHost, personalHost) {
  return text
    .replace(new RegExp(escapeRegex(originBase), 'g'), personalBase)
    .replace(new RegExp(escapeRegex(originHost),  'g'), personalHost);
}

function errorPage(status, title, detail) {
  return new Response(
    `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8f9fa}
    .box{text-align:center;padding:40px;max-width:420px}h1{color:#333;font-size:1.4rem}p{color:#666;font-size:.88rem}</style>
    </head><body><div class="box"><h1>${title}</h1><p>${detail}</p></div></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

function suspendedPage(siteName, reason) {
  return new Response(
    `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>사이트 일시정지</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fff8f0}
    .box{text-align:center;padding:40px;max-width:420px}h1{color:#e67e22;font-size:1.4rem}p{color:#666;font-size:.88rem}</style>
    </head><body><div class="box"><h1>⚠️ 사이트 일시정지</h1>
    <p>${siteName || '이 사이트'}는 현재 일시정지 상태입니다.</p>
    ${reason ? `<p style="color:#999;font-size:.8rem">${reason}</p>` : ''}
    </div></body></html>`,
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
