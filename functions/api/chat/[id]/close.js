// functions/api/chat/[id]/close.js — 어드민 티켓 종료
import { CORS, ok, err, requireAdmin } from '../../_shared.js';

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequestPost({ request, env, params }) {
  const admin = await requireAdmin(env, request);
  if (!admin) return err('관리자 권한이 필요합니다.', 403);

  const ticketId = params?.id;
  if (!ticketId) return err('티켓 ID가 없습니다.', 400);

  try {
    const ticket = await env.DB.prepare(
      `SELECT id FROM chat_tickets WHERE id=? LIMIT 1`
    ).bind(ticketId).first();
    if (!ticket) return err('티켓을 찾을 수 없습니다.', 404);

    await env.DB.prepare(`
      UPDATE chat_tickets SET status='closed' WHERE id=?
    `).bind(ticketId).run();

    return ok({ message: '티켓이 종료되었습니다.', ticketId });
  } catch (e) {
    return err('종료 처리 실패: ' + e.message, 500);
  }
}
