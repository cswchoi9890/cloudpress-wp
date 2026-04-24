// functions/api/chat/[id]/reply.js — 어드민 답변 + 사용자 Push 알림
import { CORS, ok, err, requireAdmin } from '../../_shared.js';

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

// Web Push VAPID 서명 (간소화 — env.VAPID_PRIVATE_KEY 없으면 skip)
async function sendPushNotification(env, userId, payload) {
  try {
    // 해당 유저의 push_subscriptions 조회
    const { results: subs } = await env.DB.prepare(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=? LIMIT 10`
    ).bind(userId).all();
    if (!subs || subs.length === 0) return;

    const vapidPublic  = env.VAPID_PUBLIC_KEY  || '';
    const vapidPrivate = env.VAPID_PRIVATE_KEY || '';
    const vapidEmail   = env.VAPID_EMAIL || 'mailto:admin@cloud-press.co.kr';

    if (!vapidPublic || !vapidPrivate) return; // VAPID 키 없으면 skip

    const bodyStr = JSON.stringify(payload);

    for (const sub of subs) {
      try {
        // Web Push 표준 — Cloudflare Workers는 web-push 라이브러리 없이
        // fetch로 직접 endpoint에 POST (암호화 없는 간이 방식은 지원 안 됨)
        // 여기서는 서버사이드 알림 대신 KV flag로 폴링 방식 사용
        await env.SESSIONS.put(
          `user_notification:${userId}:${Date.now()}`,
          bodyStr,
          { expirationTtl: 86400 }
        );
      } catch (_) {}
    }
  } catch (_) {}
}

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
      `SELECT id, user_id, message FROM chat_tickets WHERE id=? LIMIT 1`
    ).bind(ticketId).first();
    if (!ticket) return err('티켓을 찾을 수 없습니다.', 404);

    await env.DB.prepare(`
      UPDATE chat_tickets
      SET reply=?, status='replied', replied_at=datetime('now')
      WHERE id=?
    `).bind(reply.trim(), ticketId).run();

    // ── 사용자에게 알림 저장 (KV 폴링 방식) ──────────────────────────
    if (env.SESSIONS) {
      const notifKey = `chat_reply:${ticket.user_id}`;
      const notifVal = JSON.stringify({
        type: 'chat_reply',
        title: '✅ 문의에 답변이 등록되었습니다',
        message: reply.trim().slice(0, 100) + (reply.trim().length > 100 ? '...' : ''),
        ticketId,
        at: new Date().toISOString(),
      });
      await env.SESSIONS.put(notifKey, notifVal, { expirationTtl: 86400 * 7 }).catch(() => {});
    }

    // ── Push Notification (VAPID 키 있을 경우) ─────────────────────────
    await sendPushNotification(env, ticket.user_id, {
      type: 'chat_reply',
      title: '✅ 문의 답변이 도착했습니다',
      message: reply.trim().slice(0, 120),
      ticketId,
      url: '/chat.html',
    });

    return ok({ message: '답변이 등록되었습니다.', ticketId });
  } catch (e) {
    return err('답변 저장 실패: ' + e.message, 500);
  }
}
