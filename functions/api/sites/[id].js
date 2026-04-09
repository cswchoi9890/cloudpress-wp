// functions/api/sites/[id].js — 사이트 개별 관리 API v4.0
// ✅ 수정: domain 관련 필드 추가, php_version 추가

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
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

/* ── DB 마이그레이션 ── */
async function ensureSitesColumns(DB) {
  const migrations = [
    `ALTER TABLE sites ADD COLUMN hosting_provider TEXT`,
    `ALTER TABLE sites ADD COLUMN hosting_email TEXT`,
    `ALTER TABLE sites ADD COLUMN hosting_password TEXT`,
    `ALTER TABLE sites ADD COLUMN hosting_domain TEXT`,
    `ALTER TABLE sites ADD COLUMN subdomain TEXT`,
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
    `ALTER TABLE sites ADD COLUMN error_message TEXT`,
    `ALTER TABLE sites ADD COLUMN provision_step TEXT DEFAULT NULL`,
    `ALTER TABLE sites ADD COLUMN suspended INTEGER DEFAULT 0`,
    `ALTER TABLE sites ADD COLUMN suspension_reason TEXT`,
    `ALTER TABLE sites ADD COLUMN disk_used INTEGER DEFAULT 0`,
    `ALTER TABLE sites ADD COLUMN bandwidth_used INTEGER DEFAULT 0`,
    `ALTER TABLE sites ADD COLUMN speed_optimized INTEGER DEFAULT 0`,
    `ALTER TABLE sites ADD COLUMN suspend_protected INTEGER DEFAULT 0`,
    `ALTER TABLE sites ADD COLUMN updated_at INTEGER DEFAULT (unixepoch())`,
    `ALTER TABLE sites ADD COLUMN deleted_at INTEGER`,
    `ALTER TABLE sites ADD COLUMN primary_domain TEXT`,
    `ALTER TABLE sites ADD COLUMN custom_domain TEXT`,
    `ALTER TABLE sites ADD COLUMN domain_status TEXT`,
    `ALTER TABLE sites ADD COLUMN cname_target TEXT`,
  ];
  for (const sql of migrations) {
    try { await DB.prepare(sql).run(); } catch (_) {}
  }
}

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequest({ request, env, params }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  await ensureSitesColumns(env.DB).catch(() => {});

  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);

  const siteId = params.id;
  const site = await env.DB.prepare(
    `SELECT * FROM sites WHERE id=? AND user_id=?`
  ).bind(siteId, user.id).first();

  if (!site) return err('사이트를 찾을 수 없습니다.', 404);

  // GET — 사이트 상세 정보
  if (request.method === 'GET') {
    if (site.suspended) {
      return ok({
        site: { ...site, suspended: true, suspension_reason: site.suspension_reason || '호스팅 제한' },
        suspended: true,
      });
    }
    return ok({ site });
  }

  // DELETE — 사이트 삭제
  if (request.method === 'DELETE') {
    await env.DB.prepare(
      "UPDATE sites SET status='deleted',deleted_at=unixepoch() WHERE id=?"
    ).bind(siteId).run();
    return ok({ message: '사이트가 삭제되었습니다.' });
  }

  // PUT — 상태 업데이트 또는 재시도
  if (request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch { return err('요청 형식 오류'); }

    // 관리자: 사이트 일시정지
    if (body.action === 'suspend' && user.role === 'admin') {
      await env.DB.prepare(
        'UPDATE sites SET suspended=?,suspension_reason=? WHERE id=?'
      ).bind(body.suspended ? 1 : 0, body.reason || '', siteId).run();
      return ok({ message: body.suspended ? '사이트가 일시정지되었습니다.' : '일시정지 해제되었습니다.' });
    }

    // 실패한 사이트 재시도 — ✅ 수정1: resetWizard 후 새 사이트 생성 완전 지원
    if (body.action === 'retry' && site.status === 'failed') {
      await env.DB.prepare(
        `UPDATE sites SET status='pending', provision_step='initializing',
         error_message=NULL, updated_at=unixepoch() WHERE id=?`
      ).bind(siteId).run();
      return ok({ message: '재시도가 시작되었습니다.' });
    }

    return err('알 수 없는 요청');
  }

  // POST — 사이트 액션
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return err('요청 형식 오류'); }

    // 사이트 정보 업데이트 (이름, 설명)
    if (body.action === 'update-info') {
      if (body.name) {
        await env.DB.prepare(
          'UPDATE sites SET name=?, updated_at=unixepoch() WHERE id=?'
        ).bind(body.name.trim(), siteId).run();
      }
      return ok({ message: '사이트 정보가 업데이트되었습니다.' });
    }

    return err('알 수 없는 액션');
  }

  return err('지원하지 않는 메서드', 405);
}
