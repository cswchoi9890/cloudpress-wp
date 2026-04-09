// functions/api/sites/index.js
// CloudPress v6.0 — 사이트 목록 조회 + 신규 사이트 생성
//
// ✅ 아키텍처 변경:
//   - 외부 호스팅사(InfinityFree/ByetHost) 계정 생성 완전 제거
//   - 모든 계정/사이트 정보는 Cloudflare D1(자체 DB)에만 저장
//   - iFastnet 서버 IP는 WordPress 실행 물리 서버로만 사용
//   - Puppeteer Worker가 서버에 직접 파일 배포 + WordPress 설치
//
// 사이트 생성 흐름:
//   1. D1에 사이트 레코드 생성 (pending)
//   2. Worker: 자체 서브도메인 계정 정보 생성 (외부 가입 없음)
//   3. Worker: iFastnet 서버에 WordPress 인스톨러 업로드
//   4. Worker: 인스톨러 실행 → WordPress 설치 완료
//   5. D1 상태 → active

/* ── utils ── */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};
const _j  = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });
const ok  = (d = {})     => _j({ ok: true,  ...d });
const err = (msg, s = 400) => _j({ ok: false, error: msg }, s);

function getToken(req) {
  const a = req.headers.get('Authorization') || '';
  if (a.startsWith('Bearer ')) return a.slice(7);
  const m = (req.headers.get('Cookie') || '').match(/cp_session=([^;]+)/);
  return m ? m[1] : null;
}

async function getUser(env, req) {
  try {
    const t = getToken(req);
    if (!t) return null;
    const uid = await env.SESSIONS.get(`session:${t}`);
    if (!uid) return null;
    return await env.DB.prepare('SELECT id,name,email,role,plan FROM users WHERE id=?').bind(uid).first();
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

/* ── DB 마이그레이션 ── */
async function ensureColumns(DB) {
  const cols = [
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
    `ALTER TABLE sites ADD COLUMN web_path TEXT`,
    `ALTER TABLE sites ADD COLUMN breeze_installed INTEGER DEFAULT 0`,
    `ALTER TABLE sites ADD COLUMN cron_enabled INTEGER DEFAULT 0`,
    `ALTER TABLE sites ADD COLUMN ssl_active INTEGER DEFAULT 0`,
    `ALTER TABLE sites ADD COLUMN cloudflare_zone_id TEXT`,
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
  ];
  for (const sql of cols) {
    try { await DB.prepare(sql).run(); } catch (_) {}
  }

  // domains 테이블
  try {
    await DB.prepare(`
      CREATE TABLE IF NOT EXISTS domains (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        domain TEXT NOT NULL UNIQUE,
        cname_target TEXT NOT NULL,
        cname_verified INTEGER DEFAULT 0,
        is_primary INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        verified_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();
  } catch (_) {}

  // push_subscriptions 테이블
  try {
    await DB.prepare(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();
  } catch (_) {}
}

/* ── 플랜별 최대 사이트 수 ── */
async function getMaxSites(env, plan) {
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(`plan_${plan}_sites`).first();
    const val = parseInt(row?.value ?? '-1');
    return isNaN(val) ? -1 : val;
  } catch {
    return { free: 1, starter: 3, pro: 10, enterprise: -1 }[plan] ?? 1;
  }
}

/* ── Worker URL/Secret 조회 ── */
async function getWorkerUrl(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key='puppeteer_worker_url'").first();
    return row?.value || env.PUPPETEER_WORKER_URL || '';
  } catch { return env.PUPPETEER_WORKER_URL || ''; }
}

async function getWorkerSecret(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key='puppeteer_worker_secret'").first();
    return row?.value || env.PUPPETEER_WORKER_SECRET || '';
  } catch { return env.PUPPETEER_WORKER_SECRET || ''; }
}

/* ── CNAME 타겟 조회 ── */
async function getCnameTarget(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key='cname_target'").first();
    return row?.value || env.CNAME_TARGET || 'proxy.cloudpress.site';
  } catch { return 'proxy.cloudpress.site'; }
}

/* ── Worker 호출 ── */
async function callWorker(workerUrl, workerSecret, apiPath, payload) {
  const res = await fetch(`${workerUrl}${apiPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': workerSecret },
    body: JSON.stringify(payload),
  });
  try { return await res.json(); }
  catch { return { ok: false, error: `HTTP ${res.status}: 응답 파싱 실패` }; }
}

/* ── DB 상태 업데이트 ── */
async function updateSite(DB, siteId, fields) {
  const entries = Object.entries(fields);
  const set = entries.map(([k]) => `${k}=?`).join(',');
  const vals = entries.map(([, v]) => v);
  await DB.prepare(`UPDATE sites SET ${set}, updated_at=unixepoch() WHERE id=?`)
    .bind(...vals, siteId).run().catch(() => {});
}

/* ── Push 알림 ── */
async function sendPush(env, userId, notification) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=?'
    ).bind(userId).all();
    if (!results?.length) return;
    for (const sub of results) {
      await fetch(sub.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'TTL': '86400' },
        body: JSON.stringify(notification),
      }).catch(() => {});
    }
  } catch (_) {}
}

/* ═══════════════════════════════════════════════
   핵심: 사이트 생성 파이프라인
   ✅ 외부 호스팅사 계정 생성 없음
   ✅ 자체 계정 + iFastnet 서버에 WordPress 직접 설치
═══════════════════════════════════════════════ */
async function runPipeline(env, siteId, payload) {
  const workerUrl    = await getWorkerUrl(env);
  const workerSecret = await getWorkerSecret(env);

  if (!workerUrl) {
    await updateSite(env.DB, siteId, {
      status: 'failed',
      provision_step: 'config_missing',
      error_message: 'Worker URL 미설정 — 관리자 → 설정에서 Puppeteer Worker URL을 입력해주세요.',
    });
    return;
  }

  // ── 단계 1: 자체 계정 생성 (외부 호스팅사 없음) ──
  // Worker가 자체 서브도메인 계정 정보만 생성 (DB 저장용)
  let provisionResult;
  try {
    provisionResult = await callWorker(workerUrl, workerSecret, '/api/provision-hosting', {
      siteName: payload.siteName,
      plan:     payload.plan,
    });
  } catch (e) {
    await updateSite(env.DB, siteId, {
      status: 'failed',
      error_message: 'Worker 연결 실패: ' + e.message,
    });
    return;
  }

  if (!provisionResult.ok) {
    await updateSite(env.DB, siteId, {
      status:        'failed',
      error_message: provisionResult.error || '자체 계정 생성 실패',
    });
    return;
  }

  const {
    accountUsername,
    hostingDomain,
    cpanelUrl,
    tempWordpressUrl,
    tempWpAdminUrl,
    cnameTarget,
    webPath,
  } = provisionResult;

  const finalCname = cnameTarget || await getCnameTarget(env);

  // D1에 계정 정보 저장 (자체 생성된 정보)
  await updateSite(env.DB, siteId, {
    status:          'installing_wp',
    provision_step:  'wordpress_install',
    hosting_domain:  hostingDomain || '',
    account_username: accountUsername || '',
    subdomain:       hostingDomain || '',
    cpanel_url:      cpanelUrl || '',
    wp_url:          tempWordpressUrl || '',
    wp_admin_url:    tempWpAdminUrl || '',
    web_path:        webPath || '',
    primary_domain:  hostingDomain || '',
    cname_target:    finalCname,
  });

  // ── 단계 2: iFastnet 서버에 WordPress 직접 설치 ──
  let wpResult;
  try {
    wpResult = await callWorker(workerUrl, workerSecret, '/api/install-wordpress', {
      cpanelUrl,
      hostingPw:    payload.hostingPw,
      accountUsername,
      wordpressUrl: tempWordpressUrl,
      wpAdminUrl:   tempWpAdminUrl,
      wpAdminUser:  payload.wpAdminUser,
      wpAdminPw:    payload.wpAdminPw,
      wpAdminEmail: payload.wpAdminEmail,
      siteName:     payload.siteName,
      plan:         payload.plan,
      webPath,
    });
  } catch (e) {
    await updateSite(env.DB, siteId, {
      status:        'failed',
      error_message: 'WordPress 설치 요청 실패: ' + e.message,
    });
    return;
  }

  if (!wpResult.ok) {
    await updateSite(env.DB, siteId, {
      status:        'failed',
      error_message: wpResult.error || 'WordPress 설치 실패',
      provision_step: 'wp_install_failed',
    });
    return;
  }

  await updateSite(env.DB, siteId, {
    status:           'installing_wp',
    provision_step:   'cron_setup',
    wp_version:       wpResult.wpVersion || 'latest',
    php_version:      wpResult.phpVersion || '8.x',
    breeze_installed: wpResult.breezeInstalled ? 1 : 0,
  });

  // ── 단계 3: Cron 설정 ──
  try {
    await callWorker(workerUrl, workerSecret, '/api/setup-cron', {
      wordpressUrl: tempWordpressUrl,
      wpAdminUrl:   tempWpAdminUrl,
      wpAdminUser:  payload.wpAdminUser,
      wpAdminPw:    payload.wpAdminPw,
      plan:         payload.plan,
    });
  } catch (_) {}

  await updateSite(env.DB, siteId, {
    status:         'installing_wp',
    cron_enabled:   1,
    provision_step: 'suspend_protection',
  });

  // ── 단계 4: 서스펜드 억제 ──
  let suspendResult = { ok: false };
  try {
    suspendResult = await callWorker(workerUrl, workerSecret, '/api/setup-suspend-protection', {
      wpAdminUrl:  tempWpAdminUrl,
      wpAdminUser: payload.wpAdminUser,
      wpAdminPw:   payload.wpAdminPw,
      plan:        payload.plan,
    });
  } catch (_) {}

  await updateSite(env.DB, siteId, {
    status:            'installing_wp',
    suspend_protected: suspendResult?.ok ? 1 : 0,
    provision_step:    'speed_optimization',
  });

  // ── 단계 5: 속도 최적화 ──
  let speedResult = { ok: false };
  try {
    speedResult = await callWorker(workerUrl, workerSecret, '/api/optimize-speed', {
      wpAdminUrl:  tempWpAdminUrl,
      wpAdminUser: payload.wpAdminUser,
      wpAdminPw:   payload.wpAdminPw,
      plan:        payload.plan,
      domain:      hostingDomain,
    });
  } catch (_) {}

  // ── 완료 ──
  await updateSite(env.DB, siteId, {
    status:          'active',
    provision_step:  'completed',
    speed_optimized: speedResult?.ok ? 1 : 0,
  });

  // Push 알림
  await sendPush(env, payload.userId, {
    type:        'site_created',
    siteId,
    siteName:    payload.siteName,
    siteUrl:     tempWordpressUrl,
    wpAdminUrl:  tempWpAdminUrl,
    wpVersion:   wpResult.wpVersion || 'latest',
    message:     `✅ "${payload.siteName}" WordPress 사이트 설치 완료!`,
    timestamp:   Date.now(),
  });
}

/* ── Route Exports ── */
export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

/* GET /api/sites */
export async function onRequestGet({ request, env }) {
  await ensureColumns(env.DB).catch(() => {});

  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);

  try {
    const { results } = await env.DB.prepare(`
      SELECT
        id, name, hosting_provider, hosting_domain, subdomain,
        account_username, wp_url, wp_admin_url, wp_username, wp_version,
        php_version, breeze_installed, cron_enabled, ssl_active, speed_optimized,
        suspend_protected, status, provision_step, error_message,
        suspended, suspension_reason, disk_used, bandwidth_used,
        plan, primary_domain, custom_domain, domain_status, cname_target,
        created_at, updated_at
      FROM sites
      WHERE user_id=? AND (status IS NULL OR status != 'deleted')
      ORDER BY created_at DESC
    `).bind(user.id).all();

    return ok({ sites: results ?? [] });
  } catch (e) {
    return err('사이트 목록 조회 실패: ' + e.message, 500);
  }
}

/* POST /api/sites — 신규 사이트 생성 */
export async function onRequestPost({ request, env, ctx }) {
  await ensureColumns(env.DB).catch(() => {});

  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);

  let body;
  try { body = await request.json(); } catch { return err('요청 형식 오류'); }

  // Push 구독 저장
  if (body.action === 'save-push-subscription') {
    const { subscription } = body;
    if (!subscription?.endpoint) return err('구독 정보 없음');
    try {
      const subId = 'sub_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await env.DB.prepare(
        'INSERT OR REPLACE INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?,?,?,?,?)'
      ).bind(subId, user.id, subscription.endpoint, subscription.keys?.p256dh || '', subscription.keys?.auth || '').run();
      return ok({ message: '알림 구독 완료' });
    } catch (e) {
      return err('구독 저장 실패: ' + e.message, 500);
    }
  }

  // VAPID 공개키 반환
  if (body.action === 'get-vapid-key') {
    return ok({ vapidPublicKey: env.VAPID_PUBLIC_KEY || '' });
  }

  // ── 사이트 생성 ──
  const { siteName, adminLogin, sitePlan } = body || {};

  if (!siteName?.trim())              return err('사이트 이름을 입력해주세요.');
  if (!adminLogin || adminLogin.length < 3) return err('관리자 아이디는 3자 이상 입력해주세요.');
  if (!/^[a-zA-Z0-9_]+$/.test(adminLogin)) return err('관리자 아이디는 영문/숫자/언더바만 사용 가능합니다.');

  // Worker URL 확인
  const workerUrl = await getWorkerUrl(env);
  if (!workerUrl) {
    return err('Puppeteer Worker URL이 설정되지 않았습니다. 관리자 → 설정에서 Worker URL을 입력해주세요.', 503);
  }

  // 플랜별 사이트 수 제한
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

  const siteId      = genId();
  const wpAdminPw   = genPw(16);
  const hostingPw   = genPw(14); // 서버 접근용 임시 비밀번호
  const wpAdminEmail = user.email;

  // D1에 사이트 레코드 생성
  try {
    await env.DB.prepare(`
      INSERT INTO sites (
        id, user_id, name,
        hosting_provider, hosting_email, hosting_password,
        wp_username, wp_password, wp_admin_email,
        status, provision_step, plan
      ) VALUES (?,?,?,'self_managed','',?,?,?,?,'pending','initializing',?)
    `).bind(
      siteId, user.id, siteName.trim(),
      hostingPw,
      adminLogin, wpAdminPw, wpAdminEmail,
      effectivePlan,
    ).run();
  } catch (e) {
    return err('사이트 생성 실패: ' + e.message, 500);
  }

  // pending → provisioning
  await updateSite(env.DB, siteId, {
    status:         'provisioning',
    provision_step: 'self_account',
  }).catch(() => {});

  const pipelinePayload = {
    hostingPw,
    siteName:     siteName.trim(),
    wpAdminUser:  adminLogin,
    wpAdminPw,
    wpAdminEmail,
    plan:         effectivePlan,
    userId:       user.id,
  };

  const pipelinePromise = runPipeline(env, siteId, pipelinePayload)
    .catch(async (e) => {
      await updateSite(env.DB, siteId, {
        status:        'failed',
        error_message: '파이프라인 오류: ' + e.message,
      });
    });

  if (ctx?.waitUntil) ctx.waitUntil(pipelinePromise);

  return ok({
    siteId,
    plan:       effectivePlan,
    message:    '사이트 생성이 시작되었습니다. 완료까지 5~10분 소요됩니다.',
    phpVersion: '8.3 (최신)',
    wpVersion:  'latest (한국어)',
    timezone:   'Asia/Seoul (KST)',
    steps: [
      { step: 1, name: '계정 생성 (외부 호스팅사 없음)',        status: 'pending' },
      { step: 2, name: 'WordPress 설치', status: 'pending' },
      { step: 3, name: 'Cron Job 활성화',                             status: 'pending' },
      { step: 4, name: '서스펜드 억제 설정',                          status: 'pending' },
      { step: 5, name: '속도 최적화',              status: 'pending' },
    ],
  });
}
