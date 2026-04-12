// functions/api/admin/vp-accounts.js — CloudPress v15.0
//
// [v15.0] PHPSESSID 쿠키 기반 VP 자동화
//   - phpsessid 필드 추가: VP 패널 쿠키 세션값 저장
//   - 고정 WP Origin URL 완전 제거
//   - provision.js가 쿠키로 VP 패널 자동 로그인 → 서브도메인 생성 → WP 설치

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

const _j  = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s,
  headers: { 'Content-Type': 'application/json', ...CORS }
});
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

function genId() {
  return 'vp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// DB 컬럼 마이그레이션
async function ensureColumns(DB) {
  const cols = [
    'ALTER TABLE vp_accounts ADD COLUMN wp_download_url TEXT',
    'ALTER TABLE vp_accounts ADD COLUMN phpsessid TEXT',
    'ALTER TABLE vp_accounts ADD COLUMN phpsessid_updated_at TEXT',
    'ALTER TABLE vp_accounts ADD COLUMN panel_type TEXT',
  ];
  for (const sql of cols) {
    try { await DB.prepare(sql).run(); } catch (_) {}
  }
}

// vp_accounts 테이블 자동 생성 (schema.sql에 없을 경우 대비)
async function ensureTable(DB) {
  try {
    await DB.prepare(`
      CREATE TABLE IF NOT EXISTS vp_accounts (
        id                  TEXT PRIMARY KEY,
        label               TEXT NOT NULL,
        vp_username         TEXT NOT NULL,
        vp_password         TEXT NOT NULL,
        panel_url           TEXT NOT NULL,
        server_domain       TEXT NOT NULL,
        web_root            TEXT DEFAULT '/htdocs',
        php_bin             TEXT DEFAULT 'php8.3',
        mysql_host          TEXT DEFAULT 'localhost',
        wp_download_url     TEXT,
        phpsessid           TEXT,
        phpsessid_updated_at TEXT,
        panel_type          TEXT,
        max_sites           INTEGER DEFAULT 50,
        current_sites       INTEGER DEFAULT 0,
        is_active           INTEGER DEFAULT 1,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();
  } catch (_) {}
  await ensureColumns(DB);
}

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

// GET — VP 계정 목록
export async function onRequestGet({ request, env }) {
  const admin = await requireAdmin(env, request);
  if (!admin) return err('관리자 권한이 필요합니다.', 403);

  await ensureTable(env.DB);

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, label, vp_username, panel_url, server_domain, web_root,
              php_bin, mysql_host, wp_download_url,
              phpsessid_updated_at, panel_type,
              CASE WHEN phpsessid IS NOT NULL AND phpsessid != '' THEN 1 ELSE 0 END as has_phpsessid,
              max_sites, current_sites, is_active, created_at, updated_at
       FROM vp_accounts
       ORDER BY created_at DESC`
    ).all();
    return ok({ accounts: results || [] });
  } catch (e) {
    return err('VP 계정 조회 실패: ' + e.message, 500);
  }
}

// POST — VP 계정 생성
export async function onRequestPost({ request, env }) {
  const admin = await requireAdmin(env, request);
  if (!admin) return err('관리자 권한이 필요합니다.', 403);

  await ensureTable(env.DB);

  let body;
  try { body = await request.json(); } catch { return err('요청 형식 오류'); }

  const { label, vp_username, vp_password, panel_url, server_domain,
          web_root, php_bin, mysql_host, wp_download_url,
          phpsessid, panel_type, max_sites } = body;

  if (!label?.trim())         return err('계정 레이블을 입력해주세요.');
  if (!vp_username?.trim())   return err('VP 사용자명을 입력해주세요.');
  if (!vp_password?.trim())   return err('VP 비밀번호를 입력해주세요.');
  if (!panel_url?.trim())     return err('패널 URL을 입력해주세요.');
  if (!server_domain?.trim()) return err('서버 도메인을 입력해주세요.');

  const vpId = genId();
  const now = new Date().toISOString();

  try {
    await env.DB.prepare(
      `INSERT INTO vp_accounts (
        id, label, vp_username, vp_password, panel_url, server_domain,
        web_root, php_bin, mysql_host, wp_download_url,
        phpsessid, phpsessid_updated_at, panel_type,
        max_sites, current_sites, is_active,
        created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1,datetime('now'),datetime('now'))`
    ).bind(
      vpId,
      label.trim(),
      vp_username.trim(),
      vp_password.trim(),
      panel_url.trim().replace(/\/$/, ''),
      server_domain.trim(),
      web_root?.trim() || '/htdocs',
      php_bin?.trim() || 'php8.3',
      mysql_host?.trim() || 'localhost',
      wp_download_url?.trim() || null,
      phpsessid?.trim() || null,
      phpsessid?.trim() ? now : null,
      panel_type?.trim() || null,
      parseInt(max_sites, 10) || 50
    ).run();

    return ok({ message: 'VP 계정이 생성되었습니다.', accountId: vpId });
  } catch (e) {
    return err('VP 계정 생성 실패: ' + e.message, 500);
  }
}

// PUT — VP 계정 수정
export async function onRequestPut({ request, env }) {
  const admin = await requireAdmin(env, request);
  if (!admin) return err('관리자 권한이 필요합니다.', 403);

  await ensureTable(env.DB);

  let body;
  try { body = await request.json(); } catch { return err('요청 형식 오류'); }

  const { id, label, vp_username, vp_password, panel_url, server_domain,
          web_root, php_bin, mysql_host, wp_download_url,
          phpsessid, panel_type, max_sites, is_active } = body;

  if (!id) return err('계정 ID가 필요합니다.');

  const existing = await env.DB.prepare('SELECT id FROM vp_accounts WHERE id=?').bind(id).first();
  if (!existing) return err('존재하지 않는 VP 계정입니다.', 404);

  try {
    const updates = [];
    const values = [];

    if (label !== undefined)         { updates.push('label=?');           values.push(label.trim()); }
    if (vp_username !== undefined)   { updates.push('vp_username=?');     values.push(vp_username.trim()); }
    if (vp_password?.trim())         { updates.push('vp_password=?');     values.push(vp_password.trim()); }
    if (panel_url !== undefined)     { updates.push('panel_url=?');       values.push(panel_url.trim().replace(/\/$/, '')); }
    if (server_domain !== undefined) { updates.push('server_domain=?');   values.push(server_domain.trim()); }
    if (web_root !== undefined)      { updates.push('web_root=?');        values.push(web_root?.trim() || '/htdocs'); }
    if (php_bin !== undefined)       { updates.push('php_bin=?');         values.push(php_bin?.trim() || 'php8.3'); }
    if (mysql_host !== undefined)    { updates.push('mysql_host=?');      values.push(mysql_host?.trim() || 'localhost'); }
    if (wp_download_url !== undefined){ updates.push('wp_download_url=?'); values.push(wp_download_url?.trim() || null); }
    if (panel_type !== undefined)    { updates.push('panel_type=?');      values.push(panel_type?.trim() || null); }
    if (phpsessid !== undefined) {
      updates.push('phpsessid=?');
      updates.push('phpsessid_updated_at=?');
      values.push(phpsessid?.trim() || null);
      values.push(phpsessid?.trim() ? new Date().toISOString() : null);
    }
    if (max_sites !== undefined)     { updates.push('max_sites=?');       values.push(parseInt(max_sites, 10) || 50); }
    if (is_active !== undefined)     { updates.push('is_active=?');       values.push(is_active ? 1 : 0); }

    if (updates.length === 0) return ok({ message: '변경사항 없음' });

    updates.push("updated_at=datetime('now')");
    values.push(id);

    await env.DB.prepare(
      `UPDATE vp_accounts SET ${updates.join(', ')} WHERE id=?`
    ).bind(...values).run();

    return ok({ message: 'VP 계정이 수정되었습니다.' });
  } catch (e) {
    return err('VP 계정 수정 실패: ' + e.message, 500);
  }
}

// DELETE — VP 계정 삭제
export async function onRequestDelete({ request, env }) {
  const admin = await requireAdmin(env, request);
  if (!admin) return err('관리자 권한이 필요합니다.', 403);

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return err('계정 ID가 필요합니다.');

  try {
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM sites WHERE vp_account_id=? AND (status IS NULL OR status != 'deleted')"
    ).bind(id).all();

    const siteCount = results?.[0]?.count || 0;
    if (siteCount > 0) {
      return err(`이 VP 계정을 사용 중인 사이트가 ${siteCount}개 있습니다. 먼저 사이트를 삭제해주세요.`, 400);
    }

    await env.DB.prepare('DELETE FROM vp_accounts WHERE id=?').bind(id).run();
    return ok({ message: 'VP 계정이 삭제되었습니다.' });
  } catch (e) {
    return err('VP 계정 삭제 실패: ' + e.message, 500);
  }
}
