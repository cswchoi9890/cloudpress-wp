import { CORS, ok, err, getUser } from '../_shared.js';

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

function b64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

export async function onRequestPost({ request, env }) {
  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);

  let body;
  try { body = await request.json(); } catch { return err('요청 형식 오류'); }

  const paymentKey = String(body?.paymentKey || '');
  const orderId = String(body?.orderId || '');
  const amount = Number(body?.amount || 0);
  if (!paymentKey || !orderId || !Number.isFinite(amount) || amount <= 0) {
    return err('필수 파라미터가 누락되었습니다.');
  }

  try {
    const tx = await env.DB.prepare(
      `SELECT id, amount, status FROM payment_transactions WHERE order_id=? AND user_id=?`
    ).bind(orderId, user.id).first();
    if (!tx) return err('결제 주문을 찾을 수 없습니다.', 404);
    if (tx.status === 'DONE') return ok({ message: '이미 승인된 결제입니다.' });
    if (Number(tx.amount) !== amount) return err('결제 금액 위변조 감지', 400);

    const { results } = await env.DB.prepare(
      `SELECT key, value FROM settings WHERE key='toss_secret_key'`
    ).all();
    const settings = Object.fromEntries((results || []).map((r) => [r.key, r.value]));
    const secretKey = settings.toss_secret_key || '';
    if (!secretKey) return err('결제 서버 설정이 누락되었습니다.', 503);

    const tossRes = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${b64(secretKey + ':')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount }),
    });
    const tossData = await tossRes.json().catch(() => ({}));

    if (!tossRes.ok) {
      await env.DB.prepare(
        `UPDATE payment_transactions
         SET status='FAILED', failed_at=datetime('now'), fail_reason=?, raw_response=?
         WHERE id=?`
      ).bind(
        tossData?.message || '결제 승인 실패',
        JSON.stringify(tossData).slice(0, 10000),
        tx.id
      ).run();
      return err(tossData?.message || '결제 승인에 실패했습니다.', 400);
    }

    await env.DB.prepare(
      `UPDATE payment_transactions
       SET status='DONE',
           payment_key=?,
           method=?,
           approved_at=datetime('now'),
           receipt_url=?,
           raw_response=?
       WHERE id=?`
    ).bind(
      paymentKey,
      tossData?.method || '',
      tossData?.receipt?.url || '',
      JSON.stringify(tossData).slice(0, 10000),
      tx.id
    ).run();

    return ok({
      message: '결제가 승인되었습니다.',
      payment: {
        orderId,
        amount,
        method: tossData?.method || '',
        approvedAt: tossData?.approvedAt || '',
        receiptUrl: tossData?.receipt?.url || '',
      },
    });
  } catch (e) {
    return err('결제 승인 처리 실패: ' + e.message, 500);
  }
}
