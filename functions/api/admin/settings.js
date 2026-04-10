// functions/api/admin/settings.js
// CloudPress v6.1 — 관리자 설정 API
// ✅ v6.1 변경사항:
//   - VP 로그인 다중 인증 방식 지원 (Basic Auth, cPanel UAPI, WHM, Cookie)
//   - 연결 테스트 로직 완전 재작성
//   - 공유 호스팅 호환성 강화

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};
const _j  = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });
const ok  = (d = {}) => _j({ ok: true,  ...d });
const err = (msg, s = 400) => _j({ ok: false, error: msg }, s);

async function requireAdmin(env, req) {
  try {
    const a = req.headers.get('Authorization') || '';
    const token = a.startsWith('Bearer ') ? a.slice(7) : null;
    if (!token) return null;
    const uid = await env.SESSIONS.get(`session:${token}`);
    if (!uid) return null;
    const user = await env.DB.prepare('SELECT id,role FROM users WHERE id=?').bind(uid).first();
    return user?.role === 'admin' ? user : null;
  } catch { return null; }
}

// vp_accounts 테이블 보장
async function ensureVpAccountsTable(DB) {
  try {
    await DB.prepare(`
      CREATE TABLE IF NOT EXISTS vp_accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        vp_username TEXT NOT NULL,
        vp_password TEXT NOT NULL,
        panel_url TEXT NOT NULL,
        server_domain TEXT NOT NULL,
        web_root TEXT DEFAULT '/htdocs',
        php_bin TEXT DEFAULT 'php8.3',
        mysql_host TEXT DEFAULT 'localhost',
        max_sites INTEGER DEFAULT 50,
        current_sites INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();
  } catch (_) {}
}

/* ══════════════════════════════════════════════════════════
   VP 패널 다중 인증 방식 연결 테스트
   cPanel / DirectAdmin / 자체 VP 패널 모두 지원
══════════════════════════════════════════════════════════ */
async function testVpConnection(panelUrl, username, password) {
  const base = panelUrl.replace(/\/$/, '');
  const basicAuth = btoa(`${username}:${password}`);
  const timeout = 12000;

  const errors = [];

  // ── 방법 1: cPanel UAPI (가장 일반적인 cPanel) ──
  try {
    const res = await fetch(`${base}/execute/DiskUsage/list`, {
      method: 'GET',
      headers: { 'Authorization': `Basic ${basicAuth}` },
      signal: AbortSignal.timeout(timeout),
    });
    if (res.status === 200 || res.status === 201) {
      const data = await res.json().catch(() => null);
      if (data?.status === 1 || data?.result?.status === 1 || Array.isArray(data?.data)) {
        return { connected: true, method: 'cpanel_uapi', message: 'cPanel UAPI 연결 성공' };
      }
    }
    if (res.status === 401 || res.status === 403) {
      return { connected: false, method: 'cpanel_uapi', message: `인증 실패 (HTTP ${res.status}) — 사용자명/비밀번호를 확인하세요.` };
    }
    errors.push(`cPanel UAPI: HTTP ${res.status}`);
  } catch (e) {
    errors.push(`cPanel UAPI: ${e.message}`);
  }

  // ── 방법 2: cPanel API2 ──
  try {
    const res2 = await fetch(`${base}/json-api/cpanel?cpanel_jsonapi_version=2&cpanel_jsonapi_module=DiskUsage&cpanel_jsonapi_func=list`, {
      method: 'GET',
      headers: { 'Authorization': `Basic ${basicAuth}` },
      signal: AbortSignal.timeout(timeout),
    });
    if (res2.status === 200) {
      const d2 = await res2.json().catch(() => null);
      if (d2?.cpanelresult) {
        return { connected: true, method: 'cpanel_api2', message: 'cPanel API2 연결 성공' };
      }
    }
    if (res2.status === 401 || res2.status === 403) {
      return { connected: false, method: 'cpanel_api2', message: `인증 실패 (HTTP ${res2.status}) — 사용자명/비밀번호를 확인하세요.` };
    }
    errors.push(`cPanel API2: HTTP ${res2.status}`);
  } catch (e) {
    errors.push(`cPanel API2: ${e.message}`);
  }

  // ── 방법 3: 루트 경로 접근 (패널 존재 여부 확인) ──
  try {
    const res3 = await fetch(`${base}/`, {
      method: 'GET',
      headers: { 'Authorization': `Basic ${basicAuth}` },
      signal: AbortSignal.timeout(timeout),
    });
    // 200이면 연결은 됨 (로그인 성공 여부는 불확실)
    if (res3.status === 200) {
      const html = await res3.text().catch(() => '');
      // cPanel 로그인 페이지가 아닌 대시보드면 성공
      if (html.includes('cPanel') || html.includes('cpanel') || html.includes('dashboard') || html.includes('Dashboard')) {
        return { connected: true, method: 'cpanel_root', message: 'cPanel 패널 연결 성공' };
      }
      // 로그인 페이지가 나오면 인증 실패
      if (html.includes('login') || html.includes('Login') || html.includes('password') || html.includes('Password')) {
        return { connected: false, method: 'cpanel_root', message: `인증 실패 — 사용자명/비밀번호를 확인하세요. (패널: ${base})` };
      }
    }
    if (res3.status === 401 || res3.status === 403) {
      return { connected: false, method: 'cpanel_root', message: `인증 거부됨 (HTTP ${res3.status}) — 사용자명/비밀번호 또는 IP 허용 여부를 확인하세요.` };
    }
    errors.push(`루트 접근: HTTP ${res3.status}`);
  } catch (e) {
    errors.push(`루트 접근: ${e.message}`);
  }

  // ── 방법 4: cPanel 로그인 폼 POST (쿠키 방식) ──
  try {
    const loginRes = await fetch(`${base}/login/?login_only=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user: username, pass: password, goto_uri: '/' }).toString(),
      signal: AbortSignal.timeout(timeout),
      redirect: 'manual',
    });
    if (loginRes.status === 200 || loginRes.status === 302) {
      const setCookie = loginRes.headers.get('set-cookie') || '';
      const body = await loginRes.text().catch(() => '');
      if (setCookie.includes('cpsession') || setCookie.includes('cp_session') || body.includes('security_token')) {
        return { connected: true, method: 'cpanel_login', message: 'cPanel 로그인 성공 (쿠키 방식)' };
      }
    }
    errors.push(`cPanel 로그인: HTTP ${loginRes.status}`);
  } catch (e) {
    errors.push(`cPanel 로그인: ${e.message}`);
  }

  // ── 방법 5: DirectAdmin 호환 ──
  try {
    const daRes = await fetch(`${base}/CMD_LOGIN`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }).toString(),
      signal: AbortSignal.timeout(timeout),
      redirect: 'manual',
    });
    if (daRes.status === 302 || daRes.status === 200) {
      const location = daRes.headers.get('location') || '';
      if (location.includes('CMD_MAIN') || location.includes('index')) {
        return { connected: true, method: 'directadmin', message: 'DirectAdmin 로그인 성공' };
      }
    }
    errors.push(`DirectAdmin: HTTP ${daRes.status}`);
  } catch (e) {
    errors.push(`DirectAdmin: ${e.message}`);
  }

  // 모든 방법 실패
  const errorSummary = errors.slice(0, 3).join('; ');
  return {
    connected: false,
    method: 'all_failed',
    message: `연결 실패. 패널 URL과 인증 정보를 확인하세요.\n패널: ${base}\n오류: ${errorSummary}`,
    errors,
  };
}

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const admin = await requireAdmin(env, request);
  if (!admin) return err('관리자 권한이 필요합니다.', 403);

  await ensureVpAccountsTable(env.DB).catch(() => {});

  const url = new URL(request.url);
  const action = url.searchParams.get('action') || '';

  /* ══════════════════════════════════════
     VP 계정 관리 엔드포인트
  ══════════════════════════════════════ */

  // VP 계정 목록 조회
  if (request.method === 'GET' && action === 'vp-accounts') {
    try {
      const { results } = await env.DB.prepare(
        `SELECT id, label, vp_username, panel_url, server_domain,
                web_root, php_bin, mysql_host, max_sites, current_sites, is_active,
                created_at, updated_at
         FROM vp_accounts ORDER BY created_at DESC`
      ).all();
      // 비밀번호는 마스킹
      const accounts = (results || []).map(a => ({
        ...a,
        vp_password: '••••••••',
      }));
      return ok({ accounts });
    } catch (e) {
      return err('VP 계정 조회 실패: ' + e.message);
    }
  }

  // VP 계정 추가
  if (request.method === 'POST' && action === 'vp-accounts-add') {
    try {
      let body;
      try { body = await request.json(); } catch { return err('요청 형식 오류'); }

      const {
        label, vp_username, vp_password, panel_url,
        server_domain, web_root, php_bin, mysql_host, max_sites,
      } = body;

      if (!label?.trim())       return err('계정 이름(label)이 필요합니다.');
      if (!vp_username?.trim()) return err('VP 사용자명이 필요합니다.');
      if (!vp_password?.trim()) return err('VP 비밀번호가 필요합니다.');
      if (!panel_url?.trim())   return err('패널 URL이 필요합니다.');
      if (!server_domain?.trim()) return err('서버 도메인이 필요합니다.');

      const id = 'vpa_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await env.DB.prepare(
        `INSERT INTO vp_accounts
         (id, label, vp_username, vp_password, panel_url, server_domain,
          web_root, php_bin, mysql_host, max_sites, current_sites, is_active)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,1)`
      ).bind(
        id, label.trim(), vp_username.trim(), vp_password.trim(),
        panel_url.trim().replace(/\/$/, ''), server_domain.trim(),
        (web_root || '/htdocs').trim(),
        (php_bin || 'php8.3').trim(),
        (mysql_host || 'localhost').trim(),
        parseInt(max_sites || '50'),
      ).run();

      return ok({ message: 'VP 계정이 추가되었습니다.', id });
    } catch (e) {
      return err('VP 계정 추가 실패: ' + e.message);
    }
  }

  // VP 계정 수정
  if (request.method === 'POST' && action === 'vp-accounts-update') {
    try {
      let body;
      try { body = await request.json(); } catch { return err('요청 형식 오류'); }

      const { id, label, vp_username, vp_password, panel_url,
              server_domain, web_root, php_bin, mysql_host, max_sites, is_active } = body;

      if (!id) return err('계정 ID가 필요합니다.');

      const existing = await env.DB.prepare('SELECT id FROM vp_accounts WHERE id=?').bind(id).first();
      if (!existing) return err('존재하지 않는 계정입니다.');

      const updates = [];
      const vals = [];

      if (label)         { updates.push('label=?');         vals.push(label.trim()); }
      if (vp_username)   { updates.push('vp_username=?');   vals.push(vp_username.trim()); }
      if (vp_password && !vp_password.startsWith('••')) {
        updates.push('vp_password=?');
        vals.push(vp_password.trim());
      }
      if (panel_url)     { updates.push('panel_url=?');     vals.push(panel_url.trim().replace(/\/$/, '')); }
      if (server_domain) { updates.push('server_domain=?'); vals.push(server_domain.trim()); }
      if (web_root)      { updates.push('web_root=?');      vals.push(web_root.trim()); }
      if (php_bin)       { updates.push('php_bin=?');       vals.push(php_bin.trim()); }
      if (mysql_host)    { updates.push('mysql_host=?');    vals.push(mysql_host.trim()); }
      if (max_sites !== undefined) { updates.push('max_sites=?'); vals.push(parseInt(max_sites)); }
      if (is_active !== undefined) { updates.push('is_active=?'); vals.push(is_active ? 1 : 0); }

      updates.push("updated_at=datetime('now')");

      if (updates.length > 1) {
        await env.DB.prepare(
          `UPDATE vp_accounts SET ${updates.join(',')} WHERE id=?`
        ).bind(...vals, id).run();
      }

      return ok({ message: 'VP 계정이 수정되었습니다.' });
    } catch (e) {
      return err('VP 계정 수정 실패: ' + e.message);
    }
  }

  // VP 계정 삭제
  if (request.method === 'DELETE' && action === 'vp-accounts-delete') {
    try {
      let body;
      try { body = await request.json(); } catch { return err('요청 형식 오류'); }
      const { id } = body;
      if (!id) return err('계정 ID가 필요합니다.');
      await env.DB.prepare('DELETE FROM vp_accounts WHERE id=?').bind(id).run();
      return ok({ message: 'VP 계정이 삭제되었습니다.' });
    } catch (e) {
      return err('VP 계정 삭제 실패: ' + e.message);
    }
  }

  // VP 계정 연결 테스트 (완전 재작성)
  if (request.method === 'POST' && action === 'vp-accounts-test') {
    try {
      let body;
      try { body = await request.json(); } catch { return err('요청 형식 오류'); }
      const { panel_url, vp_username, vp_password } = body;
      if (!panel_url || !vp_username || !vp_password) {
        return err('panel_url, vp_username, vp_password 모두 필요합니다.');
      }

      const result = await testVpConnection(
        panel_url.trim().replace(/\/$/, ''),
        vp_username.trim(),
        vp_password.trim()
      );

      return ok({
        connected: result.connected,
        method: result.method,
        message: result.message,
        errors: result.errors || [],
      });
    } catch (e) {
      return ok({ connected: false, message: '연결 테스트 실패: ' + e.message });
    }
  }

  /* ══════════════════════════════════════
     일반 설정 GET
  ══════════════════════════════════════ */
  if (request.method === 'GET') {
    try {
      const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
      const settings = Object.fromEntries((results || []).map(r => [r.key, r.value]));

      // 민감한 값 마스킹
      const MASK_KEYS = [
        'cf_api_token', 'puppeteer_worker_secret',
        'ftp_pass', 'panel_pass', 'db_root_pass',
        'toss_secret_key', 'redis_password',
      ];
      for (const k of MASK_KEYS) {
        if (settings[k]) settings[k] = '••••••••';
      }
      return ok({ settings });
    } catch (e) {
      return err('설정 조회 실패: ' + e.message);
    }
  }

  /* ══════════════════════════════════════
     일반 설정 POST (저장)
  ══════════════════════════════════════ */
  if (request.method === 'POST') {
    try {
      let body;
      try { body = await request.json(); } catch { return err('요청 형식 오류'); }

      const { settings } = body;
      if (!settings || typeof settings !== 'object') return err('settings 객체가 필요합니다.');

      const ALLOWED_KEYS = [
        // 플랜 설정
        'plan_free_sites', 'plan_starter_sites', 'plan_pro_sites', 'plan_enterprise_sites',
        'plan_starter_price', 'plan_pro_price', 'plan_enterprise_price',

        // Worker
        'puppeteer_worker_url', 'puppeteer_worker_secret',

        // 설치 모드
        'installation_mode',  // 'wpmu' | 'standalone'

        // Redis
        'redis_host', 'redis_port', 'redis_password',

        // Cloudflare
        'cf_api_token', 'cf_account_id', 'cloudflare_cdn_enabled',
        'auto_ssl', 'cname_target',

        // 사이트 일반
        'maintenance_mode', 'site_name', 'site_domain', 'admin_email', 'contact_email',

        // 결제
        'toss_client_key', 'toss_secret_key',
      ];

      for (const [key, value] of Object.entries(settings)) {
        if (!ALLOWED_KEYS.includes(key)) continue;
        await env.DB.prepare(
          `INSERT INTO settings (key, value, updated_at)
           VALUES (?,?,datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
        ).bind(key, String(value)).run();
      }

      return ok({ message: '설정이 저장되었습니다.' });
    } catch (e) {
      return err('설정 저장 실패: ' + e.message);
    }
  }

  return err('지원하지 않는 메서드', 405);
}
