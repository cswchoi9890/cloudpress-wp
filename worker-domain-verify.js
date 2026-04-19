/**
 * CloudPress — Domain Verification Worker (cloudpress-verify)
 * wrangler.verify.toml: main = "worker-domain-verify.js"
 *
 * 역할:
 *   도메인 소유 확인(HTTP 인증) 전용 Worker.
 *   사용자가 커스텀 도메인을 추가할 때 CNAME + HTTP 인증을 모두 지원.
 *
 * 지원 인증 경로:
 *   /.well-known/cloudpress-verify/<token>   → HTTP 토큰 인증
 *   /.well-known/acme-challenge/<token>      → ACME/Let's Encrypt 호환
 *   /naver<code>.html                        → 네이버 웹마스터 인증
 *   /google<code>.html                       → 구글 서치 콘솔 인증
 *
 * 환경 바인딩:
 *   DB      — D1 (cloudpress-db)
 *   CACHE   — KV (도메인 인증 토큰 캐시)
 *
 * 배포:
 *   wrangler deploy --config wrangler.verify.toml
 *
 * @package CloudPress
 */

export default {
  async fetch(request, env) {
    try {
      return await handleVerifyRequest(request, env);
    } catch (e) {
      console.error('[verify-worker] error:', e?.message);
      return new Response('Internal Error', { status: 500 });
    }
  },
};

async function handleVerifyRequest(request, env) {
  const url      = new URL(request.url);
  const pathname = url.pathname;
  const hostname = url.hostname.toLowerCase();

  /* ── CloudPress HTTP 도메인 인증 ─────────────────────────────────────────── */
  if (pathname.startsWith('/.well-known/cloudpress-verify/')) {
    return handleCPVerify(request, env, pathname, hostname);
  }

  /* ── ACME challenge (Let's Encrypt 호환) ──────────────────────────────────── */
  if (pathname.startsWith('/.well-known/acme-challenge/')) {
    return handleAcmeChallenge(request, env, pathname, hostname);
  }

  /* ── 네이버 웹마스터 도구 인증 ───────────────────────────────────────────── */
  if (/^\/naver[a-f0-9]+\.html$/i.test(pathname)) {
    return handleNaverVerify(request, env, pathname, hostname);
  }

  /* ── 구글 서치 콘솔 인증 ─────────────────────────────────────────────────── */
  if (/^\/google[a-z0-9\-_]+\.html$/i.test(pathname)) {
    return handleGoogleVerify(request, env, pathname, hostname);
  }

  /* ── 상태 확인 ───────────────────────────────────────────────────────────── */
  if (pathname === '/health' || pathname === '/ping') {
    return new Response(JSON.stringify({ ok: true, service: 'cloudpress-verify', hostname }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Not Found', { status: 404 });
}

/* ── CloudPress 토큰 인증 ────────────────────────────────────────────────── */

async function handleCPVerify(request, env, pathname, hostname) {
  const token = pathname.split('/').filter(Boolean).pop();
  if (!token || token.length < 8) {
    return new Response('Invalid token', { status: 400 });
  }

  // 1) KV 캐시에서 토큰 조회
  let verifyRecord = null;
  if (env.CACHE) {
    try {
      verifyRecord = await env.CACHE.get(`domain_verify_token:${token}`, { type: 'json' });
    } catch (_) {}
  }

  // 2) KV 미스 → D1에서 조회
  if (!verifyRecord && env.DB) {
    try {
      const row = await env.DB.prepare(
        `SELECT dv.id, dv.site_id, dv.domain, dv.method, dv.verified,
                s.name AS site_name
           FROM domain_verifications dv
           LEFT JOIN sites s ON s.id = dv.site_id
          WHERE dv.id = ?
             OR dv.domain = ?
          LIMIT 1`
      ).bind(token, hostname).first();

      if (row) {
        verifyRecord = {
          token:    row.id,
          siteId:   row.site_id,
          domain:   row.domain,
          siteName: row.site_name,
          verified: !!row.verified,
        };
        // KV에 15분 캐시
        if (env.CACHE) {
          env.CACHE.put(
            `domain_verify_token:${token}`,
            JSON.stringify(verifyRecord),
            { expirationTtl: 900 }
          ).catch(() => {});
        }
      }
    } catch (e) {
      console.warn('[verify] D1 lookup error:', e?.message);
    }
  }

  // 토큰 값 (DB에 없어도 토큰 자체를 응답 — 도메인 전파 전 사전 등록 허용)
  const verifyValue = verifyRecord
    ? `cloudpress-verify=${verifyRecord.token || token}`
    : `cloudpress-verify=${token}`;

  const domainValue = verifyRecord?.domain || hostname;

  const accept = request.headers.get('Accept') || '';
  if (accept.includes('text/html')) {
    return new Response(
      `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CloudPress 도메인 인증</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; background: #f6f7f7; }
    .box { background: #fff; border-radius: 8px; padding: 2rem; max-width: 480px;
           width: 90%; box-shadow: 0 2px 8px rgba(0,0,0,.1); text-align: center; }
    h1 { color: #1d2327; font-size: 1.4rem; margin-bottom: 1rem; }
    code { background: #f0f0f1; padding: .2em .5em; border-radius: 4px;
           font-size: .9rem; word-break: break-all; display: block; margin: 1rem 0;
           text-align: left; line-height: 1.8; }
    .badge { display: inline-block; background: #00a32a; color: #fff;
             border-radius: 4px; padding: .2em .7em; font-size: .85rem; margin-top: .5rem; }
  </style>
</head>
<body>
  <div class="box">
    <h1>✅ CloudPress 도메인 인증 파일</h1>
    <p>도메인: <strong>${escHtml(domainValue)}</strong></p>
    <code>${escHtml(verifyValue)}</code>
    <span class="badge">인증 파일 정상</span>
  </div>
</body>
</html>`,
      {
        status:  200,
        headers: {
          'Content-Type':  'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-CP-Verify':   token,
        },
      }
    );
  }

  return new Response(verifyValue, {
    status:  200,
    headers: {
      'Content-Type':  'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-CP-Verify':   token,
    },
  });
}

/* ── ACME Challenge ──────────────────────────────────────────────────────── */

async function handleAcmeChallenge(request, env, pathname, hostname) {
  const token = pathname.split('/').filter(Boolean).pop();
  if (!token) return new Response('Not Found', { status: 404 });

  // KV에서 ACME 챌린지 값 조회 (외부 ACME 클라이언트가 저장)
  let keyAuth = null;
  if (env.CACHE) {
    try {
      keyAuth = await env.CACHE.get(`acme:${hostname}:${token}`);
      if (!keyAuth) {
        // fallback: 도메인 없이도 조회
        keyAuth = await env.CACHE.get(`acme:${token}`);
      }
    } catch (_) {}
  }

  if (!keyAuth) {
    return new Response('Not Found', { status: 404 });
  }

  return new Response(keyAuth, {
    status:  200,
    headers: {
      'Content-Type':  'application/octet-stream',
      'Cache-Control': 'no-store',
    },
  });
}

/* ── 네이버 웹마스터 인증 ────────────────────────────────────────────────── */

async function handleNaverVerify(request, env, pathname, hostname) {
  const filename = pathname.slice(1); // 앞 '/' 제거

  // 1) KV에서 직접 저장된 내용 조회
  if (env.CACHE) {
    try {
      const stored = await env.CACHE.get(`naver_verify:${hostname}:${filename}`);
      if (!stored) {
        const stored2 = await env.CACHE.get(`naver_verify:${filename}`);
        if (stored2) {
          return new Response(stored2, {
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
          });
        }
      } else {
        return new Response(stored, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
    } catch (_) {}
  }

  // 2) DB에서 조회 (settings 테이블에 저장된 경우)
  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        `SELECT value FROM settings WHERE key=? LIMIT 1`
      ).bind(`naver_verify_${filename.replace('.html', '')}`).first();

      if (row?.value) {
        return new Response(row.value, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
    } catch (_) {}
  }

  // 3) 파일명에서 코드 추출하여 최소 응답 생성
  const code = filename.replace('naver', '').replace('.html', '');
  const html = `<html><head><meta name="naver-site-verification" content="${escHtml(code)}" /></head><body></body></html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/* ── 구글 서치 콘솔 인증 ─────────────────────────────────────────────────── */

async function handleGoogleVerify(request, env, pathname, hostname) {
  const filename = pathname.slice(1);

  if (env.CACHE) {
    try {
      const stored = await env.CACHE.get(`google_verify:${hostname}:${filename}`);
      if (stored) {
        return new Response(stored, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      const stored2 = await env.CACHE.get(`google_verify:${filename}`);
      if (stored2) {
        return new Response(stored2, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
    } catch (_) {}
  }

  const code = filename.replace('google', '').replace('.html', '');
  const html = `google-site-verification: ${escHtml(filename)}`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
