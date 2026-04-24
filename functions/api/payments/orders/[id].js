import { CORS, ok, err, getUser, requireAdmin } from '../../_shared.js';

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequestGet({ request, env, params }) {
  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);
  const isAdmin = !!(await requireAdmin(env, request));
  const id = String(params?.id || '').trim();
  if (!id) return err('주문 ID가 필요합니다.');

  try {
    const order = await env.DB.prepare(
      `SELECT o.*, p.name AS product_name
       FROM orders o
       JOIN products p ON p.id=o.product_id
       WHERE o.id=?`
    ).bind(id).first();
    if (!order) return err('주문을 찾을 수 없습니다.', 404);
    if (!isAdmin && order.user_id !== user.id) return err('권한이 없습니다.', 403);
    return ok({ order });
  } catch (e) {
    return err('주문 조회 실패: ' + e.message, 500);
  }
}
