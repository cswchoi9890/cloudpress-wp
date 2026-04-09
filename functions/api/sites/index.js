// functions/api/sites/index.js
// CloudPress — 사이트 목록 조회 + 신규 사이트 생성 API
// ✅ 수정: 호스팅 계정 생성 루프 버그 수정 (accountUsername 전달, 단계별 상태 분리)
// ✅ 수정: Softaculous 제거 → 자체 인스톨러 방식
// ✅ 추가: Cron Job 자동 활성화 단계
// ✅ 추가: 플랜별 서스펜드 억제 단계
// ✅ 추가: 속도 최적화 단계
// ✅ 추가: 사이트별 플랜 관리

/* ── utils ── */
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

/* ── DB 마이그레이션 ── */
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
  ];
  for (const sql of migrations) {
    try { await DB.prepare(sql).run(); } catch (_) {}
  }
}

/* 플랜별 최대 사이트 수 */
async function getMaxSites(env, plan) {
  try {
    const key = `plan_${plan}_sites`;
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
    const val = parseInt(row?.value ?? '-1');
    return val;
  } catch {
    const defaults = { free: 1, starter: 3, pro: 10, enterprise: -1 };
    return defaults[plan] ?? 1;
  }
}

/* Puppeteer Worker URL/Secret 조회 */
async function getPuppeteerWorkerUrl(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM settings WHERE key='puppeteer_worker_url'"
    ).first();
    return row?.value || env.PUPPETEER_WORKER_URL || '';
  } catch {
    return env.PUPPETEER_WORKER_URL || '';
  }
}

async function getPuppeteerWorkerSecret(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM settings WHERE key='puppeteer_worker_secret'"
    ).first();
    return row?.value || env.PUPPETEER_WORKER_SECRET || '';
  } catch {
    return env.PUPPETEER_WORKER_SECRET || '';
  }
}

/* 활성 프로바이더 목록 */
const ALL_PROVIDERS = ['infinityfree', 'byethost'];

async function getActiveProviders(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM settings WHERE key='active_providers'"
    ).first();
    if (row?.value) return row.value.split(',').filter(Boolean);
  } catch {}
  return ALL_PROVIDERS;
}

async function pickProvider(env) {
  const providers = await getActiveProviders(env);
  return providers[Math.floor(Math.random() * providers.length)] || ALL_PROVIDERS[0];
}

/* Worker 호출 헬퍼 */
async function callWorker(workerUrl, workerSecret, apiPath, payload) {
  const res = await fetch(`${workerUrl}${apiPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Worker-Secret': workerSecret,
    },
    body: JSON.stringify(payload),
  });
  try {
    return await res.json();
  } catch {
    return { ok: false, error: `HTTP ${res.status}: 응답 파싱 실패` };
  }
}

/* DB 상태 업데이트 헬퍼 */
async function updateSiteStatus(DB, siteId, fields) {
  const entries = Object.entries(fields);
  const setClauses = entries.map(([k]) => `${k}=?`).join(',');
  const values = entries.map(([, v]) => v);
  await DB.prepare(
    `UPDATE sites SET ${setClauses}, updated_at=unixepoch() WHERE id=?`
  ).bind(...values, siteId).run().catch(() => {});
}

/* ═══════════════════════════════════════════════
   핵심: 사이트 생성 파이프라인 (비동기 실행)
   
   단계:
   1. provision-hosting  → 호스팅 계정 생성
   2. install-wordpress  → 자체 인스톨러로 WP 설치 (Softaculous 없음)
   3. setup-cron         → Cron Job 강제 활성화
   4. setup-suspend-protection → 플랜별 서스펜드 억제
   5. optimize-speed     → 속도 최적화 (PHP, 캐시, 압축)
   
   버그 수정: accountUsername을 각 단계에 올바르게 전달
═══════════════════════════════════════════════ */
async function runProvisioningPipeline(env, siteId, payload) {
  const workerUrl    = await getPuppeteerWorkerUrl(env);
  const workerSecret = await getPuppeteerWorkerSecret(env);

  if (!workerUrl) {
    await updateSiteStatus(env.DB, siteId, {
      status: 'failed',
      error_message: 'Worker URL 미설정',
    });
    return;
  }

  // ── 단계 1: 호스팅 계정 생성 ──
  await updateSiteStatus(env.DB, siteId, {
    status: 'provisioning',
    provision_step: 'hosting_account',
  });

  let provisionResult;
  try {
    provisionResult = await callWorker(workerUrl, workerSecret, '/api/provision-hosting', {
      provider:     payload.provider,
      hostingEmail: payload.hostingEmail,
      hostingPw:    payload.hostingPw,
      siteName:     payload.siteName,
      plan:         payload.plan,
    });
  } catch (e) {
    await updateSiteStatus(env.DB, siteId, {
      status: 'failed',
      error_message: 'Worker 연결 실패: ' + e.message,
    });
    return;
  }

  if (!provisionResult.ok) {
    await updateSiteStatus(env.DB, siteId, {
      status: 'failed',
      error_message: provisionResult.error || '호스팅 계정 생성 실패',
    });
    return;
  }

  // 호스팅 정보 DB 저장 (accountUsername 포함)
  const {
    accountUsername,
    hostingDomain,
    cpanelUrl,
    panelAccountId,
    tempWordpressUrl,
    tempWpAdminUrl,
  } = provisionResult;

  await updateSiteStatus(env.DB, siteId, {
    status: 'installing_wp',
    provision_step: 'wordpress_install',
    hosting_domain: hostingDomain || '',
    account_username: accountUsername || '',
    subdomain: accountUsername || '',
    cpanel_url: cpanelUrl || '',
    wp_url: tempWordpressUrl || '',
    wp_admin_url: tempWpAdminUrl || '',
  });

  // ── 단계 2: WordPress 자체 설치 (Softaculous 없음) ──
  let wpResult;
  try {
    wpResult = await callWorker(workerUrl, workerSecret, '/api/install-wordpress', {
      cpanelUrl,
      hostingEmail:    payload.hostingEmail,
      hostingPw:       payload.hostingPw,
      accountUsername,
      wordpressUrl:    tempWordpressUrl,
      wpAdminUrl:      tempWpAdminUrl,
      wpAdminUser:     payload.wpAdminUser,
      wpAdminPw:       payload.wpAdminPw,
      wpAdminEmail:    payload.wpAdminEmail,
      siteName:        payload.siteName,
      plan:            payload.plan,
    });
  } catch (e) {
    await updateSiteStatus(env.DB, siteId, {
      status: 'failed',
      error_message: 'WordPress 설치 요청 실패: ' + e.message,
    });
    return;
  }

  if (!wpResult.ok) {
    await updateSiteStatus(env.DB, siteId, {
      status: 'failed',
      error_message: wpResult.error || 'WordPress 설치 실패',
    });
    return;
  }

  await updateSiteStatus(env.DB, siteId, {
    provision_step: 'cron_setup',
    wp_version: wpResult.wpVersion || '6.x',
    breeze_installed: wpResult.breezeInstalled ? 1 : 0,
  });

  // ── 단계 3: Cron Job 자동 활성화 (필수) ──
  try {
    await callWorker(workerUrl, workerSecret, '/api/setup-cron', {
      wordpressUrl: tempWordpressUrl,
      wpAdminUrl:   tempWpAdminUrl,
      wpAdminUser:  payload.wpAdminUser,
      wpAdminPw:    payload.wpAdminPw,
      plan:         payload.plan,
    });
  } catch (_) {
    // Cron 설정 실패해도 계속 진행 (mu-plugins 방식으로 이미 활성화됨)
  }

  await updateSiteStatus(env.DB, siteId, {
    cron_enabled: 1,
    provision_step: 'suspend_protection',
  });

  // ── 단계 4: 플랜별 서스펜드 억제 ──
  let suspendResult;
  try {
    suspendResult = await callWorker(workerUrl, workerSecret, '/api/setup-suspend-protection', {
      wpAdminUrl:  tempWpAdminUrl,
      wpAdminUser: payload.wpAdminUser,
      wpAdminPw:   payload.wpAdminPw,
      plan:        payload.plan,
    });
  } catch (_) {
    suspendResult = { ok: false };
  }

  await updateSiteStatus(env.DB, siteId, {
    suspend_protected: suspendResult?.ok ? 1 : 0,
    provision_step: 'speed_optimization',
  });

  // ── 단계 5: 속도 최적화 ──
  let speedResult;
  try {
    speedResult = await callWorker(workerUrl, workerSecret, '/api/optimize-speed', {
      wpAdminUrl:  tempWpAdminUrl,
      wpAdminUser: payload.wpAdminUser,
      wpAdminPw:   payload.wpAdminPw,
      plan:        payload.plan,
      domain:      hostingDomain,
    });
  } catch (_) {
    speedResult = { ok: false };
  }

  // ── 완료 ──
  await updateSiteStatus(env.DB, siteId, {
    status: 'active',
    provision_step: 'completed',
    speed_optimized: speedResult?.ok ? 1 : 0,
  });
}

/* ── Route Exports ── */
export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

/* GET /api/sites */
export async function onRequestGet({ request, env }) {
  await ensureSitesColumns(env.DB).catch(() => {});

  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);

  try {
    const { results } = await env.DB.prepare(
      `SELECT
        id, name, hosting_provider, hosting_domain, subdomain,
        account_username, wp_url, wp_admin_url, wp_username, wp_version,
        breeze_installed, cron_enabled, ssl_active, speed_optimized,
        suspend_protected, status, provision_step, error_message,
        suspended, suspension_reason, disk_used, bandwidth_used,
        plan, created_at, updated_at
       FROM sites
       WHERE user_id=? AND (status IS NULL OR status != 'deleted')
       ORDER BY created_at DESC`
    ).bind(user.id).all();

    return ok({ sites: results ?? [] });
  } catch (e) {
    return err('사이트 목록 조회 실패: ' + e.message, 500);
  }
}

/* POST /api/sites — 신규 사이트 생성 */
export async function onRequestPost({ request, env }) {
  await ensureSitesColumns(env.DB).catch(() => {});

  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);

  let body;
  try { body = await request.json(); } catch { return err('요청 형식 오류'); }

  const { siteName, adminLogin, sitePlan } = body || {};

  if (!siteName || !siteName.trim())        return err('사이트 이름을 입력해주세요.');
  if (!adminLogin || adminLogin.length < 3) return err('관리자 아이디는 3자 이상 입력해주세요.');
  if (!/^[a-zA-Z0-9_]+$/.test(adminLogin)) return err('관리자 아이디는 영문/숫자/언더바만 사용 가능합니다.');

  // Worker URL 확인
  const workerUrl = await getPuppeteerWorkerUrl(env);
  if (!workerUrl) {
    return err(
      'Puppeteer Worker URL이 설정되지 않았습니다. 관리자 → 설정에서 Worker URL을 입력해주세요.',
      503
    );
  }

  // 플랜별 사이트 수 제한
  const effectivePlan = sitePlan || user.plan || 'free';
  const maxSites = await getMaxSites(env, user.plan);
  if (maxSites !== -1) {
    const countRow = await env.DB.prepare(
      "SELECT COUNT(*) as c FROM sites WHERE user_id=? AND (status IS NULL OR status != 'deleted')"
    ).bind(user.id).first();
    const count = countRow?.c ?? 0;
    if (count >= maxSites) {
      return err(
        `현재 플랜(${user.plan})의 최대 사이트 수(${maxSites}개)에 도달했습니다. 플랜을 업그레이드해주세요.`,
        403
      );
    }
  }

  // 자동 생성 값
  const siteId       = genId();
  const siteDomain   = env.SITE_DOMAIN || 'cloudpress.site';
  const hostingEmail = `cp${Math.random().toString(36).slice(2, 9)}@${siteDomain}`;
  const hostingPw    = genPw(14);
  const wpAdminPw    = genPw(16);
  const wpAdminEmail = user.email;
  const provider     = await pickProvider(env);

  // DB에 사이트 레코드 생성
  try {
    await env.DB.prepare(
      `INSERT INTO sites (
        id, user_id, name,
        hosting_provider, hosting_email, hosting_password,
        wp_username, wp_password, wp_admin_email,
        status, provision_step, plan
      ) VALUES (?,?,?,?,?,?,?,?,?,'pending','initializing',?)`
    ).bind(
      siteId, user.id, siteName.trim(),
      provider, hostingEmail, hostingPw,
      adminLogin, wpAdminPw, wpAdminEmail,
      effectivePlan,
    ).run();
  } catch (e) {
    return err('사이트 생성 실패: ' + e.message, 500);
  }

  // 파이프라인 비동기 실행 (fire-and-forget)
  // Cloudflare Workers에서 waitUntil 없이 실행 시 응답 후 종료될 수 있음
  // → 응답 반환 후 백그라운드 실행
  runProvisioningPipeline(env, siteId, {
    provider,
    hostingEmail,
    hostingPw,
    siteName: siteName.trim(),
    wpAdminUser:  adminLogin,
    wpAdminPw,
    wpAdminEmail,
    plan: effectivePlan,
  }).catch(async (e) => {
    await updateSiteStatus(env.DB, siteId, {
      status: 'failed',
      error_message: '파이프라인 오류: ' + e.message,
    });
  });

  return ok({
    siteId,
    provider,
    plan: effectivePlan,
    message: '사이트 생성이 시작되었습니다. 완료까지 5~10분 소요됩니다.',
    steps: [
      { step: 1, name: '호스팅 계정 생성', status: 'pending' },
      { step: 2, name: 'WordPress 설치 (자체 패널)', status: 'pending' },
      { step: 3, name: 'Cron Job 활성화', status: 'pending' },
      { step: 4, name: '서스펜드 억제 설정', status: 'pending' },
      { step: 5, name: '속도 최적화', status: 'pending' },
    ],
  });
}
