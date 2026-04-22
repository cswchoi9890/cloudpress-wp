// functions/api/chat/[id]/reply.js — 어드민 답변
import { CORS, ok, err, requireAdmin } from '../../_shared.js';

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequestPost({ request, env, params }) {
  const admin = await requireAdmin(env, request);
  if (!admin) return err('관리자 권한이 필요합니다.', 403);

  const ticketId = params?.id;
  if (!ticketId) return err('티켓 ID가 없습니다.', 400);

  let body;
  try { body = await request.json(); } catch { return err('잘못된 요청', 400); }

  const { reply } = body;
  if (!reply || reply.trim().length < 1) return err('답변 내용을 입력해주세요.', 400);

  try {
    const ticket = await env.DB.prepare(
      `SELECT id, user_id FROM chat_tickets WHERE id=? LIMIT 1`
    ).bind(ticketId).first();
    if (!ticket) return err('티켓을 찾을 수 없습니다.', 404);

    await env.DB.prepare(`
      UPDATE chat_tickets
      SET reply=?, status='replied', replied_at=datetime('now')
      WHERE id=?
    `).bind(reply.trim(), ticketId).run();

    return ok({ message: '답변이 등록되었습니다.', ticketId });
  } catch (e) {
    return err('답변 저장 실패: ' + e.message, 500);
  }
}
