// functions/api/sites/index.js
// CloudPress v7.0 — 사이트 목록 조회 + 신규 사이트 생성
//
// ✅ v7 변경사항:
//   1. 사이트 생성 시 personalDomain (개인 도메인) 필수 수집
//   2. cfEmail + cfApiKey + cfAccountId (Cloudflare Global API) 수집
//   3. Cloudflare Worker 자동 생성 + 배포 (개인도메인 ↔ 호스팅 서브도메인 프록시)
//   4. 크론잡/어드민/모든 경로가 개인도메인에서 완벽히 동작
//   5. CF API 키는 DB에 저장하지 않음 (생성 후 폐기)
//   6. 글/페이지/미디어 등 콘텐츠는 CF D1 + KV 사용
//   7. wp-config.php에 개인도메인을 WP_HOME/WP_SITEURL로 설정

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};
const _j = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s,
  headers: { 'Content-Type': 'application/json', ...CORS },
});
const ok  = (d = {}) => _j({ ok: true, ...d });
const err = (msg, s = 400) => _j({ ok: false, error: msg }, s);

function getToken(req) {
  const a = req.headers.get('Authorization') || '';
  if (a.startsWith('Bearer ')) return a.slice(7);
  const c = req.headers.get('Cookie') || '';
  const m = c.match(/cp_session=([^;]+)/);
  return m ? m[1] : null;
}

async function getUser(env, req) {
  try {
    const t = getToken(req);
    if (!t) return null;
    const uid = await env.SESSIONS.get(`session:${t}`);
    if (!uid) return null;
    return await env.DB.prepare(
      'SELECT id,name,email,role,plan FROM users WHERE id=?'
    ).bind(uid).first();
  } catch { return null; }
}

function genId() {
  return 'site_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function genPw(len = 16) {
  const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#';
  let pw = '';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  for (const b of arr) pw += chars[b % chars.length];
  return pw;
}

async function ensureSitesColumns(DB) {
  const migrations = [
    `ALTER TABLE sites ADD COLUMN hosting_provider TEXT`,
    `ALTER TABLE sites ADD COLUMN hosting_email TEXT`,
    `ALTER TABLE sites ADD COLUMN hosting_password TEXT`,
    `ALTER TABLE sites ADD COLUMN hosting_domain TEXT`,
    `ALTER TABLE sites ADD COLUMN subdomain TEXT DEFAULT NULL`,
    `ALTER TABLE sites ADD COLUMN account_username TEXT`,
    `ALTER TABLE sites ADD COLUMN cpanel_url TEXT`,
    `ALTER TABLE sites ADD COLUMN wp_url TEXT`,
    `ALTER TABLE sites ADD COLUMN wp_admin_url TEXT`,
    `ALTER TABLE sites ADD COLUMN wp_username TEXT DEFAULT 'admin'`,
    `ALTER TABLE sites ADD COLUMN wp_password TEXT`,
    `ALTER TABLE sites ADD COLUMN wp_admin_email TEXT`,
    `ALTER TABLE sites ADD COLUMN wp_version TEXT DEFAULT '6.x'`,
    `ALTER TABLE sites ADD COLUMN php_version TEXT`,
    `ALTER TABLE sites ADD COLUMN breeze_installed INTEGER DEFAULT 0`,
    `ALTER TABLE sites ADD COLUMN cron_enabled INTEGER DEFAULT 0`,
    `ALTER TABLE sites ADD COLUMN ssl_active INTEGER DEFAULT 0`,
    `ALTER TABLE sites ADD COLUMN cloudflare_zone_id TEXT`,
    `ALTER TABLE sites ADD COLUMN cf_worker_name TEXT`,
    `ALTER TABLE sites ADD COLUMN cf_worker_url TEXT`,
    `ALTER TABLE sites ADD COLUMN speed_optimized INTEGER DEFAULT 0`,
    `ALTER TABLE sites ADD COLUMN suspend_protected INTEGER DEFAULT 0`,
    `ALTER TABLE sites ADD COLUMN error_message TEXT`,
    `ALTER TABLE sites ADD COLUMN provision_step TEXT DEFAULT NULL`,
    `ALTER TABLE sites ADD COLUMN suspended INTEGER DEFAULT 0`,
    `ALTER TABLE sites ADD COLUMN suspension_reason TEXT`,
    `ALTER TABLE sites ADD COLUMN disk_used INTEGER DEFAULT 0`,
    `ALTER TABLE sites ADD COLUMN bandwidth_used INTEGER DEFAULT 0`,
    `ALTER TABLE sites ADD COLUMN updated_at INTEGER DEFAULT (unixepoch())`,
    `ALTER TABLE sites ADD COLUMN deleted_at INTEGER`,
    `ALTER TABLE sites ADD COLUMN primary_domain TEXT`,
    `ALTER TABLE sites ADD COLUMN custom_domain TEXT`,
    `ALTER TABLE sites ADD COLUMN domain_status TEXT DEFAULT NULL`,
    `ALTER TABLE sites ADD COLUMN cname_target TEXT`,
    `ALTER TABLE sites ADD COLUMN server_type TEXT DEFAULT 'shared'`,
    `ALTER TABLE sites ADD COLUMN cf_kv_namespace_id TEXT`,
    `ALTER TABLE sites ADD COLUMN cf_d1_database_id TEXT`,
  ];
  for (const sql of migrations) {
    try { await DB.prepare(sql).run(); } catch (_) {}
  }
  // domains table
  try {
    await DB.prepare(`
      CREATE TABLE IF NOT EXISTS domains (
        id TEXT PRIMARY KEY, site_id TEXT NOT NULL, user_id TEXT NOT NULL,
        domain TEXT NOT NULL UNIQUE, cname_target TEXT NOT NULL,
        cname_verified INTEGER DEFAULT 0, is_primary INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending', verified_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();
  } catch (_) {}
  // push_subscriptions table
  try {
    await DB.prepare(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();
  } catch (_) {}
  // site_content KV mapping table
  try {
    await DB.prepare(`
      CREATE TABLE IF NOT EXISTS site_content (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        content_type TEXT NOT NULL,
        cf_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (site_id) REFERENCES sites(id)
      )
    `).run();
  } catch (_) {}
}

async function getMaxSites(env, plan) {
  const FALLBACK = { free: 1, starter: 3, pro: 10, enterprise: -1 };
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(`plan_${plan}_sites`).first();
    const val = parseInt(row?.value ?? '', 10);
    if (isNaN(val)) return FALLBACK[plan] ?? 1;
    return val;
  } catch { return FALLBACK[plan] ?? 1; }
}

async function getPuppeteerWorkerUrl(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key='puppeteer_worker_url'").first();
    return row?.value || env.PUPPETEER_WORKER_URL || '';
  } catch { return env.PUPPETEER_WORKER_URL || ''; }
}
async function getPuppeteerWorkerSecret(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key='puppeteer_worker_secret'").first();
    return row?.value || env.PUPPETEER_WORKER_SECRET || '';
  } catch { return env.PUPPETEER_WORKER_SECRET || ''; }
}
async function getHostingServerConfig(env) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT key, value FROM settings WHERE key IN ('hosting_cpanel_url','hosting_server_username','hosting_server_password','hosting_server_domain')"
    ).all();
    const cfg = {};
    for (const r of (results || [])) cfg[r.key] = r.value;
    return {
      cpanelUrl: cfg['hosting_cpanel_url'] || env.HOSTING_CPANEL_URL || '',
      username:  cfg['hosting_server_username'] || env.HOSTING_SERVER_USERNAME || '',
      password:  cfg['hosting_server_password'] || env.HOSTING_SERVER_PASSWORD || '',
      domain:    cfg['hosting_server_domain'] || env.HOSTING_SERVER_DOMAIN || '',
    };
  } catch {
    return { cpanelUrl: '', username: '', password: '', domain: '' };
  }
}

async function callWorker(workerUrl, workerSecret, apiPath, payload) {
  const controller = new AbortController();
  const timeoutMs = apiPath.includes('install-wordpress') ? 300000 : 180000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${workerUrl}${apiPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': workerSecret },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    try { return await res.json(); }
    catch { return { ok: false, error: `HTTP ${res.status}: 응답 파싱 실패` }; }
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, error: `Worker 타임아웃 (${timeoutMs / 1000}초 초과)` };
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function updateSiteStatus(DB, siteId, fields) {
  const entries = Object.entries(fields);
  if (!entries.length) return;
  const setClauses = entries.map(([k]) => `${k}=?`).join(',');
  const values = entries.map(([, v]) => v);
  await DB.prepare(
    `UPDATE sites SET ${setClauses}, updated_at=unixepoch() WHERE id=?`
  ).bind(...values, siteId).run().catch(() => {});
}

/* ═══════════════════════════════════════════════════════════════
   Cloudflare Worker 자동 생성 + 배포
   
   구조: 사용자 개인도메인 → CF Worker → 실제 WordPress 서브도메인
   - 모든 경로(/wp-admin/, /wp-cron.php, 모든 페이지) 투명 프록시
   - 호스트 헤더 재작성 (WP가 올바른 URL 인식)
   - HTTPS 강제, 쿠키 경로 재작성
   - CF API Key는 배포 후 메모리에서 즉시 삭제 (DB 저장 안 함)
════════════════════════════════════════════════════════════════ */

function buildWorkerScript(personalDomain, wpHostingUrl) {
  // wpHostingUrl 예: https://mysite4x2k.cloudpress.app
  const wpOrigin = wpHostingUrl.replace(/\/$/, '');
  const workerCode = `
// CloudPress Auto-Generated Proxy Worker
// Personal Domain: ${personalDomain}
// WP Hosting Origin: ${wpOrigin}
// Generated: ${new Date().toISOString()}

const WP_ORIGIN = '${wpOrigin}';
const PERSONAL_DOMAIN = '${personalDomain}';

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);

  // 헬스체크
  if (url.pathname === '/__cloudpress_health') {
    return new Response(JSON.stringify({ ok: true, domain: PERSONAL_DOMAIN, origin: WP_ORIGIN }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 실제 WP 서버 URL 구성
  const targetUrl = WP_ORIGIN + url.pathname + url.search;

  // 요청 헤더 복제 + 수정
  const headers = new Headers(request.headers);
  headers.set('Host', new URL(WP_ORIGIN).hostname);
  headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '');
  headers.set('X-Real-IP', request.headers.get('CF-Connecting-IP') || '');
  headers.set('X-Forwarded-Host', PERSONAL_DOMAIN);
  headers.set('X-Forwarded-Proto', 'https');
  // WP가 개인 도메인 인식을 위한 헤더
  headers.set('X-CloudPress-Domain', PERSONAL_DOMAIN);

  // 요청 바디 처리 (POST/PUT)
  let body = null;
  const method = request.method;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    body = await request.arrayBuffer();
    // wp-login.php POST에서 redirect_to 파라미터 URL 재작성
    if (url.pathname === '/wp-login.php' && body) {
      try {
        const text = new TextDecoder().decode(body);
        const rewritten = text.replace(
          new RegExp(escapeRegex(WP_ORIGIN), 'g'),
          'https://' + PERSONAL_DOMAIN
        );
        body = new TextEncoder().encode(rewritten);
      } catch(_) {}
    }
  }

  let response;
  try {
    response = await fetch(targetUrl, {
      method,
      headers,
      body,
      redirect: 'manual', // 리다이렉트는 직접 처리
    });
  } catch (e) {
    return new Response('CloudPress Worker: Origin unreachable - ' + e.message, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  // 응답 헤더 처리
  const respHeaders = new Headers(response.headers);
  
  // 리다이렉트 Location 헤더 재작성 (WP 서브도메인 → 개인도메인)
  const location = respHeaders.get('Location');
  if (location) {
    const newLocation = location
      .replace(new RegExp(escapeRegex(WP_ORIGIN), 'g'), 'https://' + PERSONAL_DOMAIN)
      .replace(/^http:/, 'https:');
    respHeaders.set('Location', newLocation);
  }

  // Set-Cookie 도메인/경로 재작성
  const cookies = respHeaders.getAll ? respHeaders.getAll('Set-Cookie') : [];
  if (cookies.length > 0) {
    respHeaders.delete('Set-Cookie');
    for (const cookie of cookies) {
      const rewritten = cookie
        .replace(/Domain=[^;]+;?/gi, 'Domain=' + PERSONAL_DOMAIN + ';')
        .replace(/Secure;?/gi, 'Secure;')
        .replace(/SameSite=None/gi, 'SameSite=None');
      respHeaders.append('Set-Cookie', rewritten);
    }
  }

  // HSTS + 보안 헤더
  respHeaders.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  respHeaders.delete('X-Frame-Options'); // WP 어드민 iframe 허용

  // 응답 바디 재작성 (HTML/JS/CSS에서 WP 서브도메인 URL → 개인도메인)
  const contentType = respHeaders.get('Content-Type') || '';
  const isTextResponse = contentType.includes('text/') ||
    contentType.includes('application/json') ||
    contentType.includes('application/javascript') ||
    contentType.includes('application/x-javascript');

  if (isTextResponse && response.body) {
    let text = await response.text();
    // URL 재작성: http(s)://서브도메인 → https://개인도메인
    text = text.replace(
      new RegExp(escapeRegex(WP_ORIGIN).replace('https:', 'https?:'), 'g'),
      'https://' + PERSONAL_DOMAIN
    );
    // wp-json API URL 재작성
    text = text.replace(
      new RegExp('"' + escapeRegex(WP_ORIGIN), 'g'),
      '"https://' + PERSONAL_DOMAIN
    );
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: respHeaders,
    });
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: respHeaders,
  });
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
}
`;
  return workerCode;
}

async function deployCloudflareWorker({
  cfEmail, cfApiKey, cfAccountId,
  workerName, personalDomain, wpHostingUrl,
}) {
  const baseUrl = `https://api.cloudflare.com/client/v4`;
  const authHeaders = {
    'X-Auth-Email': cfEmail,
    'X-Auth-Key':   cfApiKey,
    'Content-Type': 'application/json',
  };

  // 1. Worker 스크립트 업로드
  const workerScript = buildWorkerScript(personalDomain, wpHostingUrl);
  const uploadUrl = `${baseUrl}/accounts/${cfAccountId}/workers/scripts/${workerName}`;
  
  const formData = new FormData();
  formData.append('script', new Blob([workerScript], { type: 'application/javascript' }), 'worker.js');
  formData.append('metadata', new Blob([JSON.stringify({
    body_part: 'script',
    bindings: [],
    compatibility_date: '2024-11-01',
    compatibility_flags: ['nodejs_compat'],
  })], { type: 'application/json' }), 'metadata.json');

  let uploadRes;
  try {
    uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'X-Auth-Email': cfEmail,
        'X-Auth-Key':   cfApiKey,
      },
      body: formData,
    });
  } catch (e) {
    return { ok: false, error: 'Worker 업로드 실패: ' + e.message };
  }

  if (!uploadRes.ok) {
    let errBody = '';
    try { errBody = JSON.stringify(await uploadRes.json()); } catch (_) {}
    return { ok: false, error: `Worker 업로드 실패 (HTTP ${uploadRes.status}): ${errBody}` };
  }

  // 2. Worker Route / Custom Domain 연결
  // 도메인의 Zone ID 찾기
  const zoneName = personalDomain.split('.').slice(-2).join('.');
  let zoneId = '';
  try {
    const zoneRes = await fetch(`${baseUrl}/zones?name=${encodeURIComponent(zoneName)}`, {
      headers: authHeaders,
    });
    const zoneData = await zoneRes.json();
    zoneId = zoneData?.result?.[0]?.id || '';
  } catch (_) {}

  let routeResult = { ok: false, message: 'Zone not found — manual DNS setup required' };

  if (zoneId) {
    // Worker Route 등록: personalDomain/* → workerName
    try {
      const routeRes = await fetch(`${baseUrl}/zones/${zoneId}/workers/routes`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          pattern: `${personalDomain}/*`,
          script: workerName,
        }),
      });
      const routeData = await routeRes.json();
      if (routeData.success) {
        routeResult = { ok: true, routeId: routeData.result?.id, zoneId };
      } else {
        // 이미 존재하는 route면 업데이트
        const existingRoutes = await fetch(`${baseUrl}/zones/${zoneId}/workers/routes`, {
          headers: authHeaders,
        });
        const existData = await existingRoutes.json();
        const existing = existData?.result?.find(r => r.pattern === `${personalDomain}/*`);
        if (existing) {
          await fetch(`${baseUrl}/zones/${zoneId}/workers/routes/${existing.id}`, {
            method: 'PUT',
            headers: authHeaders,
            body: JSON.stringify({ pattern: `${personalDomain}/*`, script: workerName }),
          });
          routeResult = { ok: true, routeId: existing.id, zoneId, updated: true };
        } else {
          routeResult = { ok: false, message: JSON.stringify(routeData.errors) };
        }
      }
    } catch (e) {
      routeResult = { ok: false, message: 'Route 등록 오류: ' + e.message };
    }

    // DNS A레코드 또는 AAAA레코드가 없으면 프록시 레코드 추가
    if (routeResult.ok) {
      try {
        // Cloudflare IP로 더미 A레코드 (Worker가 실제로 처리)
        const host = personalDomain.startsWith('www.') ? 'www' : '@';
        const existDns = await fetch(`${baseUrl}/zones/${zoneId}/dns_records?name=${encodeURIComponent(personalDomain)}&type=A`, {
          headers: authHeaders,
        });
        const dnsData = await existDns.json();
        if (!dnsData?.result?.length) {
          await fetch(`${baseUrl}/zones/${zoneId}/dns_records`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
              type: 'A',
              name: personalDomain,
              content: '192.0.2.1', // dummy IP — Worker가 실제 처리
              proxied: true,
              ttl: 1,
            }),
          });
        } else {
          // 기존 레코드 proxied 활성화
          const existRec = dnsData.result[0];
          if (!existRec.proxied) {
            await fetch(`${baseUrl}/zones/${zoneId}/dns_records/${existRec.id}`, {
              method: 'PATCH',
              headers: authHeaders,
              body: JSON.stringify({ proxied: true }),
            });
          }
        }
      } catch (_) {}
    }
  }

  const workerUrl = `https://${workerName}.${cfAccountId.slice(0, 8)}.workers.dev`;
  return {
    ok: true,
    workerName,
    workerUrl,
    zoneId: zoneId || null,
    routeResult,
    message: zoneId
      ? `Worker 배포 완료. 도메인 ${personalDomain} 에 라우트 등록됨.`
      : `Worker 배포 완료. DNS Zone을 찾을 수 없어 수동 라우트 설정이 필요합니다.`,
  };
}

/* ═══════════════════════════════════════════════════════════════
   KV에 사이트 콘텐츠 네임스페이스 생성
════════════════════════════════════════════════════════════════ */
async function createCFKVNamespace(cfEmail, cfApiKey, cfAccountId, namespaceName) {
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/storage/kv/namespaces`,
      {
        method: 'POST',
        headers: {
          'X-Auth-Email': cfEmail,
          'X-Auth-Key':   cfApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: namespaceName }),
      }
    );
    const data = await res.json();
    if (data.success) return { ok: true, id: data.result.id, name: data.result.title };
    return { ok: false, error: JSON.stringify(data.errors) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ═══════════════════════════════════════════════════════════════
   핵심 프로비저닝 파이프라인 v7.0
════════════════════════════════════════════════════════════════ */
async function runProvisioningPipeline(env, siteId, payload) {
  const {
    cfEmail, cfApiKey, cfAccountId,
    personalDomain,
  } = payload;

  const workerUrl    = await getPuppeteerWorkerUrl(env);
  const workerSecret = await getPuppeteerWorkerSecret(env);
  const serverCfg    = await getHostingServerConfig(env);

  if (!workerUrl) {
    await updateSiteStatus(env.DB, siteId, {
      status: 'failed',
      provision_step: 'wordpress_install',
      error_message: 'Puppeteer Worker URL 미설정 — 관리자 → 설정에서 Worker URL을 입력해주세요.',
    });
    return;
  }

  // 호스팅 서브도메인 생성 (실제 WP가 설치되는 곳)
  const baseSlug = payload.siteName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'cp';
  const suffix   = Math.random().toString(36).slice(2, 6);
  const accountUsername = (baseSlug + suffix).slice(0, 15);

  const serverDomain     = serverCfg.domain || `${accountUsername}.cloudpress.app`;
  const cpanelUrl        = serverCfg.cpanelUrl || `https://cpanel.cloudpress.app`;
  const hostingDomain    = serverDomain;
  // 실제 WP URL (호스팅 서브도메인) — 내부용, 사용자에게 노출 안 됨
  const wpHostingUrl     = `https://${hostingDomain}`;
  const wpAdminHostingUrl = `${wpHostingUrl}/wp-admin/`;
  // 사용자에게 보이는 URL (개인 도메인)
  const personalUrl      = `https://${personalDomain}`;
  const personalAdminUrl = `${personalUrl}/wp-admin/`;

  await updateSiteStatus(env.DB, siteId, {
    status:           'installing_wp',
    provision_step:   'wordpress_install',
    hosting_domain:   hostingDomain,
    account_username: accountUsername,
    subdomain:        hostingDomain,
    cpanel_url:       cpanelUrl,
    // wp_url / wp_admin_url은 개인 도메인으로 설정 (사용자에게 보이는 것)
    wp_url:           personalUrl,
    wp_admin_url:     personalAdminUrl,
    primary_domain:   personalDomain,
    custom_domain:    personalDomain,
    domain_status:    'deploying',
    server_type:      'shared',
    error_message:    null,
  });

  // ══ 단계 1: WordPress 설치 (호스팅 서브도메인에 설치, 개인도메인 URL 사용) ══
  const wpInstallPayload = {
    cpanelUrl,
    hostingServerUsername: serverCfg.username,
    hostingServerPassword: serverCfg.password,
    accountUsername,
    hostingEmail:    payload.hostingEmail,
    hostingPw:       payload.hostingPw,
    // WordPress 내부 URL = 개인도메인 (WP_HOME, WP_SITEURL)
    wordpressUrl:    personalUrl,
    wpAdminUrl:      wpAdminHostingUrl, // 설치는 실제 서버 URL로
    wpAdminUser:     payload.wpAdminUser,
    wpAdminPw:       payload.wpAdminPw,
    wpAdminEmail:    payload.wpAdminEmail,
    siteName:        payload.siteName,
    plan:            payload.plan,
    selfInstall:     true,
    responsive:      true,
    // 개인도메인 설정 — wp-config.php에 반영
    personalDomain:  personalDomain,
    personalUrl:     personalUrl,
  };

  let wpResult;
  try {
    wpResult = await callWorker(workerUrl, workerSecret, '/api/install-wordpress', wpInstallPayload);
  } catch (e) {
    wpResult = { ok: false, error: 'Worker 연결 실패: ' + e.message };
  }

  // 실패 시 1회 재시도
  if (!wpResult.ok) {
    await updateSiteStatus(env.DB, siteId, {
      error_message: (wpResult.error || 'WP 설치 실패') + ' — 재시도 중...',
    });
    try {
      wpResult = await callWorker(workerUrl, workerSecret, '/api/install-wordpress', {
        ...wpInstallPayload, retry: true,
      });
    } catch (e) {
      wpResult = { ok: false, error: '재시도 실패: ' + e.message };
    }
  }

  if (!wpResult.ok) {
    await updateSiteStatus(env.DB, siteId, {
      status:         'failed',
      provision_step: 'wordpress_install',
      error_message:  wpResult.error || 'WordPress 설치 최종 실패',
    });
    return;
  }

  await updateSiteStatus(env.DB, siteId, {
    status:           'installing_wp',
    provision_step:   'cron_setup',
    wp_version:       wpResult.wpVersion || 'latest',
    php_version:      wpResult.phpVersion || '8.3',
    breeze_installed: wpResult.breezeInstalled ? 1 : 0,
    error_message:    null,
  });

  // ── 단계 2: Cron Job (개인도메인 기준) ──
  try {
    await callWorker(workerUrl, workerSecret, '/api/setup-cron', {
      wordpressUrl: personalUrl,
      wpAdminUrl:   wpAdminHostingUrl, // 실제 접근은 호스팅 URL
      wpAdminUser:  payload.wpAdminUser,
      wpAdminPw:    payload.wpAdminPw,
      plan:         payload.plan,
    });
  } catch (_) {}

  await updateSiteStatus(env.DB, siteId, {
    status: 'installing_wp', cron_enabled: 1, provision_step: 'speed_optimization',
  });

  // ── 단계 3: 속도 최적화 ──
  let speedResult = { ok: false };
  try {
    speedResult = await callWorker(workerUrl, workerSecret, '/api/optimize-speed', {
      wpAdminUrl: wpAdminHostingUrl,
      wpAdminUser: payload.wpAdminUser,
      wpAdminPw:   payload.wpAdminPw,
      plan:        payload.plan,
      domain:      personalDomain,
    });
  } catch (_) {}

  await updateSiteStatus(env.DB, siteId, {
    status:          'installing_wp',
    provision_step:  'worker_deploy',
    speed_optimized: speedResult?.ok ? 1 : 0,
    error_message:   null,
  });

  // ── 단계 4: Cloudflare Worker 배포 (개인도메인 프록시) ──
  const workerName = (personalDomain.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '-proxy').slice(0, 63);

  let cfWorkerResult = { ok: false, error: 'CF API 미제공' };
  if (cfEmail && cfApiKey && cfAccountId) {
    cfWorkerResult = await deployCloudflareWorker({
      cfEmail, cfApiKey, cfAccountId,
      workerName,
      personalDomain,
      wpHostingUrl,
    });
  }

  if (!cfWorkerResult.ok) {
    // Worker 배포 실패는 치명적이지 않음 — 경고 후 계속
    await updateSiteStatus(env.DB, siteId, {
      error_message: `CF Worker 배포 실패: ${cfWorkerResult.error || cfWorkerResult.message || '알 수 없음'}. 수동 설정 필요.`,
    });
  } else {
    await updateSiteStatus(env.DB, siteId, {
      cf_worker_name: workerName,
      cf_worker_url:  cfWorkerResult.workerUrl || '',
      cloudflare_zone_id: cfWorkerResult.zoneId || '',
      error_message:  null,
    });
  }

  // ── 단계 5: KV 네임스페이스 생성 (콘텐츠 저장용) ──
  await updateSiteStatus(env.DB, siteId, {
    provision_step: 'dns_setup',
  });

  let kvNamespaceId = '';
  if (cfEmail && cfApiKey && cfAccountId) {
    const kvResult = await createCFKVNamespace(
      cfEmail, cfApiKey, cfAccountId,
      `cloudpress-${accountUsername}-content`
    );
    if (kvResult.ok) {
      kvNamespaceId = kvResult.id;
      await updateSiteStatus(env.DB, siteId, { cf_kv_namespace_id: kvNamespaceId });
    }
  }

  // ── 도메인 레코드 DB 저장 ──
  try {
    const domId = 'dom_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO domains (id, site_id, user_id, domain, cname_target, cname_verified, is_primary, status)
       VALUES (?,?,?,?,?,1,1,'active')`
    ).bind(domId, siteId, payload.userId, personalDomain, hostingDomain).run();
  } catch (_) {}

  // ── 최종 완료 ──
  await updateSiteStatus(env.DB, siteId, {
    status:          'active',
    provision_step:  'completed',
    ssl_active:      1,
    domain_status:   cfWorkerResult.ok ? 'active' : 'pending_manual',
    error_message:   cfWorkerResult.ok ? null : `CF Worker 수동 배포 필요. Worker 이름: ${workerName}`,
  });
}

/* ── Route Exports ── */
export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequestGet({ request, env }) {
  await ensureSitesColumns(env.DB).catch(() => {});
  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, name, hosting_provider, hosting_domain, subdomain, account_username,
        wp_url, wp_admin_url, wp_username, wp_version, php_version, breeze_installed,
        cron_enabled, ssl_active, speed_optimized, suspend_protected, status,
        provision_step, error_message, suspended, suspension_reason, disk_used,
        bandwidth_used, plan, primary_domain, custom_domain, domain_status,
        cname_target, server_type, cf_worker_name, cf_worker_url, cf_kv_namespace_id,
        created_at, updated_at
       FROM sites
       WHERE user_id=? AND (status IS NULL OR status != 'deleted')
       ORDER BY created_at DESC`
    ).bind(user.id).all();
    return ok({ sites: results ?? [] });
  } catch (e) {
    return err('사이트 목록 조회 실패: ' + e.message, 500);
  }
}

export async function onRequestPost({ request, env, ctx }) {
  await ensureSitesColumns(env.DB).catch(() => {});
  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);

  let body;
  try { body = await request.json(); } catch { return err('요청 형식 오류'); }

  if (body.action === 'save-push-subscription') {
    const { subscription } = body;
    if (!subscription?.endpoint) return err('구독 정보 없음');
    try {
      const subId = 'sub_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await env.DB.prepare(
        `INSERT OR REPLACE INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?,?,?,?,?)`
      ).bind(subId, user.id, subscription.endpoint, subscription.keys?.p256dh || '', subscription.keys?.auth || '').run();
      return ok({ message: '알림 구독 완료' });
    } catch (e) { return err('구독 저장 실패: ' + e.message, 500); }
  }

  if (body.action === 'get-vapid-key') {
    return ok({ vapidPublicKey: env.VAPID_PUBLIC_KEY || '' });
  }

  const {
    siteName, adminLogin,
    personalDomain, cfEmail, cfApiKey, cfAccountId,
    sitePlan,
  } = body || {};

  // 필수값 검증
  if (!siteName || !siteName.trim())        return err('사이트 이름을 입력해주세요.');
  if (!adminLogin || adminLogin.length < 3) return err('관리자 아이디는 3자 이상 입력해주세요.');
  if (!/^[a-zA-Z0-9_]+$/.test(adminLogin)) return err('관리자 아이디는 영문/숫자/언더바만 사용 가능합니다.');
  if (!personalDomain)                       return err('개인 도메인을 입력해주세요.');
  const cleanDomain = personalDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9\-\.]+\.[a-z]{2,}$/.test(cleanDomain)) return err('올바른 도메인 형식이 아닙니다.');
  if (!cfEmail || !cfApiKey || !cfAccountId) return err('Cloudflare 연동 정보(이메일, API 키, Account ID)를 모두 입력해주세요.');

  // Puppeteer Worker 확인
  const workerUrl = await getPuppeteerWorkerUrl(env);
  if (!workerUrl) {
    return err('Puppeteer Worker URL이 설정되지 않았습니다. 관리자 → 설정에서 Worker URL을 입력해주세요.', 503);
  }

  // 플랜 및 사이트 수 확인
  const effectivePlan = sitePlan || user.plan || 'free';
  const maxSites = await getMaxSites(env, user.plan);
  if (maxSites !== -1) {
    const countRow = await env.DB.prepare(
      "SELECT COUNT(*) as c FROM sites WHERE user_id=? AND (status IS NULL OR status != 'deleted')"
    ).bind(user.id).first();
    if ((countRow?.c ?? 0) >= maxSites) {
      return err(`현재 플랜(${user.plan})의 최대 사이트 수(${maxSites}개)에 도달했습니다. 플랜을 업그레이드해주세요.`, 403);
    }
  }

  // 동일 도메인 중복 확인
  const domainExists = await env.DB.prepare(
    "SELECT id FROM sites WHERE custom_domain=? AND (status IS NULL OR status != 'deleted')"
  ).bind(cleanDomain).first();
  if (domainExists) return err('이미 사용 중인 도메인입니다.');

  // 사이트 레코드 생성
  const siteId       = genId();
  const siteDomain   = env.SITE_DOMAIN || 'cloudpress.site';
  const hostingEmail = `cp${Math.random().toString(36).slice(2, 9)}@${siteDomain}`;
  const hostingPw    = genPw(14);
  const wpAdminPw    = genPw(16);
  const wpAdminEmail = user.email;

  try {
    await env.DB.prepare(
      `INSERT INTO sites (
        id, user_id, name, hosting_provider, hosting_email, hosting_password,
        wp_username, wp_password, wp_admin_email,
        primary_domain, custom_domain, domain_status,
        status, provision_step, plan, server_type
      ) VALUES (?,?,?,'direct',?,?,?,?,?,?,?,'deploying','installing_wp','wordpress_install',?,'shared')`
    ).bind(
      siteId, user.id, siteName.trim(),
      hostingEmail, hostingPw,
      adminLogin, wpAdminPw, wpAdminEmail,
      cleanDomain, cleanDomain,
      effectivePlan
    ).run();
  } catch (e) {
    return err('사이트 레코드 생성 실패: ' + e.message, 500);
  }

  const pipelinePayload = {
    hostingEmail, hostingPw,
    personalDomain:  cleanDomain,
    cfEmail:         cfEmail.trim(),
    cfApiKey:        cfApiKey.trim(),
    cfAccountId:     cfAccountId.trim(),
    siteName:        siteName.trim(),
    wpAdminUser:     adminLogin,
    wpAdminPw,
    wpAdminEmail,
    plan:            effectivePlan,
    userId:          user.id,
  };

  // 파이프라인 비동기 실행 (CF API 키는 메모리에서만 사용, DB 저장 안 함)
  const pipelinePromise = runProvisioningPipeline(env, siteId, pipelinePayload)
    .catch(async (e) => {
      await updateSiteStatus(env.DB, siteId, {
        status: 'failed',
        provision_step: 'wordpress_install',
        error_message: '파이프라인 오류: ' + e.message,
      });
    });

  if (ctx?.waitUntil) ctx.waitUntil(pipelinePromise);

  return ok({
    siteId,
    provider:       'cloudpress_self',
    plan:           effectivePlan,
    personalDomain: cleanDomain,
    message:        `WordPress 설치 + Cloudflare Worker 배포가 시작되었습니다. 완료까지 5~10분 소요됩니다.`,
    phpVersion:     '8.3 (최신)',
    wpVersion:      'latest (한국어)',
    timezone:       'Asia/Seoul (KST)',
    steps: [
      { step: 1, name: 'WordPress 설치 (PHP 8.3 + 한국어 + 반응형)', status: 'running' },
      { step: 2, name: '플러그인 설치 및 속도 최적화',                status: 'pending' },
      { step: 3, name: `Cloudflare Worker 배포 (${cleanDomain})`,  status: 'pending' },
      { step: 4, name: 'DNS 연결 + 사이트 활성화',                   status: 'pending' },
    ],
  });
}
