import { CORS, ok, err, getUser, requireAdmin, genId } from '../_shared.js';

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

function parseFeeRate(settings) {
  const r = Number(settings.platform_fee_rate || 0.2);
  if (!Number.isFinite(r) || r < 0 || r >= 1) return 0.2;
  return r;
}

async function getSettings(env) {
  const { results } = await env.DB.prepare(
    `SELECT key,value FROM settings WHERE key IN (
      'toss_virtual_account_number',
      'settlement_bank_name',
      'settlement_account_holder',
      'platform_fee_rate'
    )`
  ).all();
  return Object.fromEntries((results || []).map((r) => [r.key, r.value]));
}

export async function onRequestGet({ request, env }) {
  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const isAdmin = !!(await requireAdmin(env, request));

  let sql = `
    SELECT o.*, p.name AS product_name
    FROM orders o
    JOIN products p ON p.id = o.product_id
  `;
  const binds = [];
  const where = [];
  if (!isAdmin) { where.push('o.user_id=?'); binds.push(user.id); }
  if (status) { where.push('o.status=?'); binds.push(status); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY o.created_at DESC LIMIT 100';

  try {
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return ok({ orders: results || [] });
  } catch (e) {
    return err('주문 조회 실패: ' + e.message, 500);
  }
}

export async function onRequestPost({ request, env }) {
  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);

  let body;
  try { body = await request.json(); } catch { return err('요청 형식 오류'); }
  const productId = String(body?.product_id || '').trim();
  const quantity = Math.max(1, Math.floor(Number(body?.quantity || 1)));
  if (!productId) return err('product_id가 필요합니다.');

  try {
    const product = await env.DB.prepare(
      `SELECT id, name, price, active FROM products WHERE id=?`
    ).bind(productId).first();
    if (!product || product.active !== 1) return err('구매 가능한 상품이 아닙니다.', 404);

    const settings = await getSettings(env);
    const feeRate = parseFeeRate(settings);
    const unitPrice = Number(product.price);
    const grossAmount = unitPrice * quantity;
    const feeAmount = Math.floor(grossAmount * feeRate);
    const netAmount = grossAmount - feeAmount;
    const totalAmount = grossAmount;

    const id = 'ord_' + genId();
    await env.DB.prepare(
      `INSERT INTO orders (
        id, user_id, product_id, quantity, unit_price,
        gross_amount, fee_rate, fee_amount, net_amount, total_amount,
        status, virtual_account_no
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).bind(
      id, user.id, product.id, quantity, unitPrice,
      grossAmount, feeRate, feeAmount, netAmount, totalAmount,
      settings.toss_virtual_account_number || ''
    ).run();

    return ok({
      order: {
        id,
        product_id: product.id,
        product_name: product.name,
        quantity,
        total_amount: totalAmount,
        fee_rate: feeRate,
        fee_amount: feeAmount,
        net_amount: netAmount,
        status: 'pending',
      },
      payment_guide: {
        bank_name: settings.settlement_bank_name || '',
        account_holder: settings.settlement_account_holder || '',
        virtual_account_no: settings.toss_virtual_account_number || '',
        memo: id,
      },
    });
  } catch (e) {
    return err('주문 생성 실패: ' + e.message, 500);
  }
}
