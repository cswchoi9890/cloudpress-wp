// functions/api/admin/settings.js
// CloudPress v6.0 — 관리자 설정 API
// ✅ v6 변경사항:
//   - VP 계정(vpanel 로그인) 풀 관리 추가 (CRUD)
//   - 설치 모드 설정 (wpmu / standalone)
//   - Redis 설정 추가

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

      // 비밀번호가 마스킹이면 기존 값 유지
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

      updates.push('updated_at=datetime(\'now\')');

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

  // VP 계정 연결 테스트
  if (request.method === 'POST' && action === 'vp-accounts-test') {
    try {
      let body;
      try { body = await request.json(); } catch { return err('요청 형식 오류'); }
      const { panel_url, vp_username, vp_password } = body;
      if (!panel_url || !vp_username || !vp_password) return err('panel_url, vp_username, vp_password 모두 필요합니다.');

      // VP 패널에 로그인 테스트 (기본 cPanel 로그인 시도)
      const basicAuth = btoa(`${vp_username}:${vp_password}`);
      const testUrl = `${panel_url.replace(/\/$/, '')}/execute/DiskUsage/list`;
      const res = await fetch(testUrl, {
        method: 'GET',
        headers: { 'Authorization': `Basic ${basicAuth}` },
        signal: AbortSignal.timeout(10000),
      }).catch(e => ({ ok: false, status: 0, statusText: e.message }));

      if (res.ok || (res.status >= 200 && res.status < 400)) {
        return ok({ connected: true, message: '연결 성공!' });
      }
      return ok({ connected: false, message: `연결 실패 (HTTP ${res.status})` });
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
