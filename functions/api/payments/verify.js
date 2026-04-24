import { CORS, ok, err, genId } from '../_shared.js';

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

async function hmacSha256(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return err('요청 형식 오류'); }

  const orderId = String(body?.order_id || '').trim();
  const txId = String(body?.tx_id || '').trim();
  const amount = Number(body?.amount || 0);
  const depositorName = String(body?.depositor_name || '').trim();
  if (!orderId || !txId || !Number.isFinite(amount) || amount <= 0) return err('필수 값 누락');

  // 서버 검증: 웹훅 서명 필수
  const signature = request.headers.get('x-cp-signature') || '';
  const ts = request.headers.get('x-cp-ts') || '';
  if (!signature || !ts) return err('검증 헤더가 필요합니다.', 401);

  const secRow = await env.DB.prepare(`SELECT value FROM settings WHERE key='payment_webhook_secret'`).first();
  const secret = secRow?.value || '';
  if (!secret) return err('payment_webhook_secret이 설정되지 않았습니다.', 503);

  const payload = `${ts}.${orderId}.${txId}.${amount}`;
  const expected = await hmacSha256(secret, payload);
  if (expected !== signature) return err('서명 검증 실패', 401);

  try {
    const ord = await env.DB.prepare(
      `SELECT id, user_id, total_amount, status, gross_amount, fee_rate, fee_amount, net_amount
       FROM orders WHERE id=? LIMIT 1`
    ).bind(orderId).first();
    if (!ord) return err('주문을 찾을 수 없습니다.', 404);
    if (ord.status === 'paid') return ok({ message: '이미 처리된 주문입니다.' });
    if (Number(ord.total_amount) !== amount) return err('금액 위변조 감지', 400);

    await env.DB.prepare(
      `UPDATE orders
       SET status='paid',
           paid_at=datetime('now'),
           verify_tx_id=?,
           depositor_name=?,
           updated_at=datetime('now')
       WHERE id=?`
    ).bind(txId, depositorName, orderId).run();

    const settlementId = 'set_' + genId();
    await env.DB.prepare(
      `INSERT INTO settlements (
        id, order_id, user_id, gross_amount, fee_rate, fee_amount, settlement_amount, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready')`
    ).bind(
      settlementId,
      orderId,
      ord.user_id,
      Number(ord.gross_amount),
      Number(ord.fee_rate),
      Number(ord.fee_amount),
      Number(ord.net_amount)
    ).run();

    return ok({ message: '결제 검증 및 정산 생성 완료', order_id: orderId, settlement_id: settlementId });
  } catch (e) {
    return err('결제 검증 처리 실패: ' + e.message, 500);
  }
}
