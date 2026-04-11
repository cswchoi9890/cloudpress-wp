// functions/api/admin/settings.js — CloudPress v11.0

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
    const t = a.startsWith('Bearer ') ? a.slice(7) : null;
    if (!t) return null;
    const uid = await env.SESSIONS.get(`session:${t}`);
    if (!uid) return null;
    const user = await env.DB.prepare('SELECT id,role FROM users WHERE id=?').bind(uid).first();
    return user?.role === 'admin' ? user : null;
  } catch { return null; }
}

const ALLOWED_KEYS = [
  // ★ 핵심: 단일 WP Origin
  'wp_origin_url',        // 예: https://origin.cloudpress.site
  'wp_origin_secret',     // WP mu-plugin 공유 시크릿
  'wp_admin_base_url',    // origin WP admin URL

  // Cloudflare
  'cf_api_token',
  'cf_account_id',
  'cf_worker_name',       // 배포된 Worker 이름 (단일 Worker)
  'worker_cname_target',  // CNAME 수동 설정 안내용

  // 플랜별 사이트 수
  'plan_free_sites', 'plan_starter_sites', 'plan_pro_sites', 'plan_enterprise_sites',
  'plan_starter_price', 'plan_pro_price', 'plan_enterprise_price',

  // 결제
  'toss_client_key', 'toss_secret_key',

  // 일반
  'maintenance_mode', 'site_name', 'site_domain', 'admin_email',
];

const MASK_KEYS = new Set(['wp_origin_secret', 'cf_api_token', 'toss_secret_key']);

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const admin = await requireAdmin(env, request);
  if (!admin) return err('관리자 권한이 필요합니다.', 403);

  if (request.method === 'GET') {
    try {
      const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
      const settings = Object.fromEntries((results || []).map(r => [r.key, r.value]));
      for (const k of MASK_KEYS) {
        if (settings[k]) settings[k] = '••••••••';
      }
      return ok({ settings });
    } catch (e) { return err('설정 조회 실패: ' + e.message); }
  }

  if (request.method === 'POST') {
    try {
      let body;
      try { body = await request.json(); } catch { return err('요청 형식 오류'); }
      const { settings } = body;
      if (!settings || typeof settings !== 'object') return err('settings 객체가 필요합니다.');

      for (const [key, value] of Object.entries(settings)) {
        if (!ALLOWED_KEYS.includes(key)) continue;
        // 마스킹된 값은 저장하지 않음
        if (value === '••••••••') continue;
        await env.DB.prepare(
          `INSERT INTO settings (key,value,updated_at) VALUES (?,?,datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
        ).bind(key, String(value)).run();
      }

      // ★ WP origin 설정 변경 시 Worker 환경변수 업데이트 안내
      const updatedKeys = Object.keys(settings).filter(k => ALLOWED_KEYS.includes(k));
      const needsWorkerUpdate = updatedKeys.some(k => ['wp_origin_url','wp_origin_secret','cf_worker_name'].includes(k));

      return ok({
        message: '설정이 저장되었습니다.',
        notice: needsWorkerUpdate ? 'Worker 환경변수(WP_ORIGIN_URL, WP_ORIGIN_SECRET)를 wrangler.toml에도 업데이트하고 Worker를 재배포해주세요.' : null,
      });
    } catch (e) { return err('설정 저장 실패: ' + e.message); }
  }

  return err('지원하지 않는 메서드', 405);
}
