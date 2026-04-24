// functions/api/chat/notifications/index.js — 사용자 채팅 답변 알림 조회
import { CORS, ok, err, getUser } from '../../_shared.js';

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequestGet({ request, env }) {
  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);

  try {
    const key = `chat_reply:${user.id}`;
    const raw = await env.SESSIONS.get(key);
    if (!raw) return ok({ notification: null });

    // 읽은 후 삭제
    await env.SESSIONS.delete(key).catch(() => {});
    const notification = JSON.parse(raw);
    return ok({ notification });
  } catch (e) {
    return err('알림 조회 실패: ' + e.message, 500);
  }
}
