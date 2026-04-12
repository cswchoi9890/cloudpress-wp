/**
 * CloudPress Proxy Worker v12.1
 *
 * [v12.1 수정사항]
 *   - env 바인딩 누락 시 Cannot read properties of undefined (reading 'get') 에러 방지
 *   - DB/CACHE/SESSIONS 바인딩 존재 여부 사전 확인 후 graceful fallback
 *   - CACHE.get / CACHE.put / DB.prepare 각각 try-catch 방어
 */

const CF_KV_API = 'https://api.cloudflare.com/client/v4';

export default {
  async fetch(request, env) {
    // ── env 안전 초기화 ──────────────────────────────────────────────
    const safeEnv = env || {};

    const url  = new URL(request.url);
    const host = url.hostname.replace(/^www\./, '');

    // ── 1. 관리 API / 내부 경로는 프록시 안 함 ──────────────────────
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__cloudpress/')) {
      return fetch(request);
    }

    // ── DB/CACHE 바인딩 없으면 설정 오류 안내 ────────────────────────
    if (!safeEnv.DB) {
      return errorPage(503, '서버 설정 오류',
        'DB 바인딩이 없습니다. Cloudflare Workers 설정에서 D1 바인딩(이름: DB)을 추가해주세요.');
    }
    if (!safeEnv.CACHE) {
      return errorPage(503, '서버 설정 오류',
        'CACHE 바인딩이 없습니다. Cloudflare Workers 설정에서 KV 바인딩(이름: CACHE)을 추가해주세요.');
    }

    // ── 2. 사이트 조회 (CACHE KV 우선 → 메인 D1 fallback) ───────────
    let site = null;
    const cacheKey = `site_domain:${host}`;

    try {
      // CACHE.get() 안전 호출
      let cached = null;
      try {
        cached = await safeEnv.CACHE.get(cacheKey, { type: 'json' });
      } catch (cacheErr) {
        console.warn('[worker] CACHE.get 실패 (무시):', cacheErr.message);
      }

      if (cached) {
        site = cached;
      } else {
        let row = null;
        try {
          row = await safeEnv.DB.prepare(
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
        } catch (dbErr) {
          return errorPage(500, 'DB 조회 오류', dbErr.message);
        }

        if (row) {
          site = row;
          // 5분 캐시 (실패해도 무시)
          try {
            await safeEnv.CACHE.put(cacheKey, JSON.stringify(row), { expirationTtl: 300 });
          } catch (e) {
            console.warn('[worker] CACHE.put 실패 (무시):', e.message);
          }
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

    // ── 3. WP_ORIGIN_URL 확인 ────────────────────────────────────────
    const wpOriginUrl = (safeEnv.WP_ORIGIN_URL || '').replace(/\/+$/, '');
    if (!wpOriginUrl) {
      return errorPage(503, '서버 설정 오류', 'WP_ORIGIN_URL 환경 변수가 설정되지 않았습니다.');
    }

    // ── 4. WP Admin 리다이렉트 ───────────────────────────────────────
    if (url.pathname.startsWith('/wp-admin') || url.pathname === '/wp-login.php') {
      const target = new URL(wpOriginUrl + url.pathname + url.search);
      target.searchParams.set('cp_site', site.site_prefix);
      return Response.redirect(target.toString(), 302);
    }

    // ── 5. 페이지 캐시 조회 (GET, 비로그인, 비WP 경로만) ─────────────
    const isCacheable = request.method === 'GET'
      && !url.pathname.startsWith('/wp-')
      && !url.searchParams.has('preview')
      && !(request.headers.get('cookie') || '').includes('wordpress_logged_in');

    if (isCacheable && site.site_kv_id && safeEnv.CF_ACCOUNT_ID && safeEnv.CF_API_TOKEN) {
      const pageCacheKey = `page:${url.pathname}${url.search || ''}`;
      const cached = await kvGet(safeEnv.CF_API_TOKEN, safeEnv.CF_ACCOUNT_ID, site.site_kv_id, pageCacheKey);
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

    // ── 6. WP Origin으로 프록시 ──────────────────────────────────────
    const originUrl = new URL(wpOriginUrl);
    originUrl.pathname = url.pathname;
    originUrl.search   = url.search;

    const proxyHeaders = new Headers(request.headers);
    proxyHeaders.set('X-CloudPress-Site',    site.site_prefix);
    proxyHeaders.set('X-CloudPress-Secret',  safeEnv.WP_ORIGIN_SECRET || '');
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

    // ── 7. 리다이렉트 처리 ───────────────────────────────────────────
    if (originRes.status >= 300 && originRes.status < 400) {
      const loc = originRes.headers.get('Location') || '';
      const fixed = loc.startsWith(wpOriginUrl)
        ? url.origin + loc.slice(wpOriginUrl.length)
        : loc;
      return new Response(null, { status: originRes.status, headers: { 'Location': fixed } });
    }

    // ── 8. 응답 헤더 구성 ────────────────────────────────────────────
    const resHeaders = new Headers();
    const skip = new Set(['transfer-encoding','content-encoding','content-length','connection','keep-alive']);
    for (const [k, v] of originRes.headers) {
      if (!skip.has(k.toLowerCase())) resHeaders.set(k, v);
    }
    resHeaders.set('X-Cache',                 'MISS');
    resHeaders.set('X-Site-Prefix',           site.site_prefix);
    resHeaders.set('X-Frame-Options',         'SAMEORIGIN');
    resHeaders.set('X-Content-Type-Options',  'nosniff');

    const contentType = originRes.headers.get('content-type') || '';

    // ── 9. HTML — origin URL 치환 + 페이지 캐시 저장 ─────────────────
    if (contentType.includes('text/html')) {
      const html      = await originRes.text();
      const rewritten = rewriteOrigin(html, wpOriginUrl, url.origin, originUrl.hostname, url.hostname);

      if (isCacheable && originRes.status === 200 && site.site_kv_id && safeEnv.CF_ACCOUNT_ID && safeEnv.CF_API_TOKEN) {
        const pageCacheKey = `page:${url.pathname}${url.search || ''}`;
        kvPut(safeEnv.CF_API_TOKEN, safeEnv.CF_ACCOUNT_ID, site.site_kv_id, pageCacheKey, {
          body: rewritten, contentType,
        }, 600).catch(() => {});
      }

      return new Response(rewritten, { status: originRes.status, headers: resHeaders });
    }

    // ── 10. CSS/JS — origin URL 치환 ─────────────────────────────────
    if (contentType.includes('text/css') || contentType.includes('javascript')) {
      const text      = await originRes.text();
      const rewritten = rewriteOrigin(text, wpOriginUrl, url.origin, originUrl.hostname, url.hostname);
      return new Response(rewritten, { status: originRes.status, headers: resHeaders });
    }

    // ── 11. 바이너리 (이미지, 폰트 등) ───────────────────────────────
    return new Response(originRes.body, { status: originRes.status, headers: resHeaders });
  },
};

// ══════════════════════════════════════════════════════════════════════
// 사이트 전용 KV REST API 헬퍼
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
  await fetch(
    `${CF_KV_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}?expiration_ttl=${ttl}`,
    {
      method:  'PUT',
      headers: { 'Authorization': 'Bearer ' + apiToken, 'Content-Type': 'application/json' },
      body:    JSON.stringify(value),
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
    .box{text-align:center;padding:40px;max-width:480px}h1{color:#333;font-size:1.4rem}p{color:#666;font-size:.88rem;word-break:break-all}</style>
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
