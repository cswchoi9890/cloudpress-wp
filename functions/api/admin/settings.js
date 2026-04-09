// functions/api/admin/settings.js
// CloudPress v6.0 — 관리자 설정 API
// ✅ iFastnet 서버 직접 접근 설정 추가 (SERVER_IP, FTP_HOST, PANEL_USER 등)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const admin = await requireAdmin(env, request);
  if (!admin) return err('관리자 권한이 필요합니다.', 403);

  // GET — 모든 설정 조회
  if (request.method === 'GET') {
    try {
      const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
      const settings = Object.fromEntries((results || []).map(r => [r.key, r.value]));

      // 민감한 값 마스킹
      const MASK_KEYS = [
        'cf_api_token', 'puppeteer_worker_secret',
        'ftp_pass', 'panel_pass', 'db_root_pass',
        'toss_secret_key',
      ];
      for (const k of MASK_KEYS) {
        if (settings[k]) settings[k] = '••••••••';
      }
      return ok({ settings });
    } catch (e) {
      return err('설정 조회 실패: ' + e.message);
    }
  }

  // POST — 설정 저장
  if (request.method === 'POST') {
    try {
      let body;
      try { body = await request.json(); } catch { return err('요청 형식 오류'); }

      const { settings } = body;
      if (!settings || typeof settings !== 'object') return err('settings 객체가 필요합니다.');

      // ✅ 허용된 설정 키 (iFastnet 서버 직접 접근 설정 추가)
      const ALLOWED_KEYS = [
        // 플랜 설정
        'plan_free_sites', 'plan_starter_sites', 'plan_pro_sites', 'plan_enterprise_sites',
        'plan_starter_price', 'plan_pro_price', 'plan_enterprise_price',

        // Puppeteer Worker
        'puppeteer_worker_url', 'puppeteer_worker_secret',

        // ✅ iFastnet 서버 직접 접근 설정 (외부 호스팅사 계정 없음 — 서버 IP만 사용)
        'server_ip',       // iFastnet 서버 IP 주소
        'ftp_host',        // FTP 호스트 (보통 server_ip와 동일)
        'ftp_user',        // FTP 사용자명
        'ftp_pass',        // FTP 비밀번호
        'ftp_port',        // FTP 포트 (기본 21)
        'server_panel',    // 서버 패널 URL (예: http://IP:2082)
        'panel_user',      // 패널 관리자 계정
        'panel_pass',      // 패널 관리자 비밀번호
        'db_host',         // MySQL 호스트 (기본 localhost)
        'db_root_user',    // MySQL root 계정
        'db_root_pass',    // MySQL root 비밀번호
        'web_root',        // 웹 루트 경로 (기본 /htdocs)
        'php_bin',         // PHP 바이너리 경로 (기본 php8.3)

        // Cloudflare
        'cf_api_token', 'cf_account_id', 'cloudflare_cdn_enabled',
        'auto_ssl', 'auto_breeze',
        'cname_target',

        // 사이트 일반
        'maintenance_mode', 'site_name', 'site_domain', 'admin_email',
        'contact_email',

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
