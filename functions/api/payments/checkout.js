import { CORS, ok, err, getUser, genId } from '../_shared.js';

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

const ALLOWED_PLANS = new Set(['starter', 'pro', 'enterprise']);

function parsePrice(settings, plan) {
  const key = `plan_${plan}_price`;
  const raw = Number(settings[key] || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export async function onRequestPost({ request, env }) {
  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);

  let body;
  try { body = await request.json(); } catch { return err('요청 형식 오류'); }

  const plan = String(body?.plan || '').trim().toLowerCase();
  if (!ALLOWED_PLANS.has(plan)) return err('지원하지 않는 플랜입니다.');

  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS payment_transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        order_id TEXT NOT NULL UNIQUE,
        payment_key TEXT,
        plan_code TEXT NOT NULL,
        amount INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'READY',
        method TEXT,
        requested_at TEXT NOT NULL DEFAULT (datetime('now')),
        approved_at TEXT,
        failed_at TEXT,
        fail_reason TEXT,
        receipt_url TEXT,
        raw_response TEXT,
        consumed_at TEXT,
        site_id TEXT
      )`
    ).run();

    const { results } = await env.DB.prepare(
      `SELECT key, value FROM settings WHERE key IN (
        'toss_client_key', 'plan_starter_price', 'plan_pro_price', 'plan_enterprise_price'
      )`
    ).all();
    const settings = Object.fromEntries((results || []).map((r) => [r.key, r.value]));
    const clientKey = settings.toss_client_key || '';
    if (!clientKey) return err('결제 설정이 준비되지 않았습니다. 관리자에게 문의하세요.', 503);

    const amount = parsePrice(settings, plan);
    if (!amount) return err('해당 플랜 가격이 설정되지 않았습니다.', 400);

    const txId = 'tx_' + genId();
    const orderId = `cp_${plan}_${Date.now().toString(36)}_${genId().slice(-6)}`;
    const orderName = `CloudPress ${plan} 호스팅 선결제`;

    await env.DB.prepare(
      `INSERT INTO payment_transactions (id, user_id, order_id, plan_code, amount, status)
       VALUES (?, ?, ?, ?, ?, 'READY')`
    ).bind(txId, user.id, orderId, plan, amount).run();

    return ok({
      clientKey,
      orderId,
      orderName,
      amount,
      customerEmail: user.email,
      customerName: user.name,
      successUrl: `${new URL(request.url).origin}/payment-success.html`,
      failUrl: `${new URL(request.url).origin}/payment-fail.html`,
    });
  } catch (e) {
    return err('결제 준비 실패: ' + e.message, 500);
  }
}
