import { CORS, ok, err, getUser, requireAdmin } from '../_shared.js';

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

function b64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

export async function onRequestPost({ request, env }) {
  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);

  let body;
  try { body = await request.json(); } catch { return err('요청 형식 오류'); }
  const orderId = String(body?.orderId || '').trim();
  const reason = String(body?.reason || '요청 취소 환불').trim();
  if (!orderId) return err('orderId가 필요합니다.');

  const tx = await env.DB.prepare(
    `SELECT id, user_id, payment_key, approved_at, amount, status
     FROM payment_transactions WHERE order_id=? LIMIT 1`
  ).bind(orderId).first();
  if (!tx) return err('결제 정보를 찾을 수 없습니다.', 404);
  if (tx.status !== 'DONE') return err('승인 완료 결제만 환불 가능합니다.', 400);
  if (!tx.payment_key) return err('paymentKey가 없어 환불할 수 없습니다.', 400);

  const isAdmin = !!(await requireAdmin(env, request));
  if (!isAdmin && tx.user_id !== user.id) return err('권한이 없습니다.', 403);

  // 일반 사용자는 7일 이내 자동환불 정책 적용
  if (!isAdmin) {
    const approvedAt = Date.parse(tx.approved_at || '');
    if (!approvedAt || Date.now() - approvedAt > 7 * 24 * 60 * 60 * 1000) {
      return err('자동 환불 가능 기간(7일)이 지났습니다.', 400);
    }
  }

  const skRow = await env.DB.prepare(
    `SELECT value FROM settings WHERE key='toss_secret_key'`
  ).first();
  const secretKey = skRow?.value || '';
  if (!secretKey) return err('결제 서버 설정이 누락되었습니다.', 503);

  const tossRes = await fetch(`https://api.tosspayments.com/v1/payments/${encodeURIComponent(tx.payment_key)}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${b64(secretKey + ':')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ cancelReason: reason }),
  });
  const tossData = await tossRes.json().catch(() => ({}));
  if (!tossRes.ok) return err(tossData?.message || '환불 실패', 400);

  await env.DB.prepare(
    `UPDATE payment_transactions
     SET status='CANCELED', failed_at=datetime('now'), fail_reason=?, raw_response=?
     WHERE id=?`
  ).bind(reason, JSON.stringify(tossData).slice(0, 10000), tx.id).run();

  return ok({ message: '환불이 완료되었습니다.' });
}
