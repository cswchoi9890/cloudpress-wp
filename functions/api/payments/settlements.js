import { CORS, ok, err, getUser, requireAdmin } from '../_shared.js';

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequestGet({ request, env }) {
  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);
  const isAdmin = !!(await requireAdmin(env, request));

  const url = new URL(request.url);
  const status = url.searchParams.get('status');

  let sql = `
    SELECT s.*, o.product_id, o.total_amount
    FROM settlements s
    JOIN orders o ON o.id = s.order_id
  `;
  const binds = [];
  const where = [];
  if (!isAdmin) { where.push('s.user_id=?'); binds.push(user.id); }
  if (status) { where.push('s.status=?'); binds.push(status); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY s.created_at DESC LIMIT 100';

  try {
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return ok({ settlements: results || [] });
  } catch (e) {
    return err('정산 조회 실패: ' + e.message, 500);
  }
}

export async function onRequestPut({ request, env }) {
  const admin = await requireAdmin(env, request);
  if (!admin) return err('관리자 권한이 필요합니다.', 403);

  let body;
  try { body = await request.json(); } catch { return err('요청 형식 오류'); }
  const id = String(body?.id || '').trim();
  const status = String(body?.status || '').trim();
  if (!id || !['ready', 'processing', 'done', 'failed'].includes(status)) {
    return err('id/status 값이 올바르지 않습니다.');
  }

  await env.DB.prepare(
    `UPDATE settlements
     SET status=?, note=?, updated_at=datetime('now'),
         settled_at=CASE WHEN ?='done' THEN datetime('now') ELSE settled_at END
     WHERE id=?`
  ).bind(status, String(body?.note || ''), status, id).run();

  return ok({ message: '정산 상태가 업데이트되었습니다.' });
}
