import { CORS, ok, err, getUser, genId } from '../_shared.js';

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequestGet({ request, env }) {
  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);
  const { results } = await env.DB.prepare(
    `SELECT id, provider, method_type, card_company, card_number_masked,
            virtual_account_no, is_default, created_at
     FROM payment_methods WHERE user_id=? ORDER BY is_default DESC, created_at DESC`
  ).bind(user.id).all().catch(() => ({ results: [] }));
  return ok({ methods: results || [] });
}

export async function onRequestPost({ request, env }) {
  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);
  let body;
  try { body = await request.json(); } catch { return err('요청 형식 오류'); }

  const methodType = String(body?.method_type || '').trim();
  if (!['card', 'easyPay', 'virtualAccount'].includes(methodType)) return err('지원하지 않는 결제수단');

  const id = 'pm_' + genId();
  await env.DB.prepare(
    `INSERT INTO payment_methods (
      id, user_id, provider, method_type, card_company, card_number_masked,
      virtual_account_no, is_default
    ) VALUES (?,?,?,?,?,?,?,?)`
  ).bind(
    id, user.id, 'toss', methodType,
    String(body?.card_company || ''),
    String(body?.card_number_masked || ''),
    String(body?.virtual_account_no || ''),
    body?.is_default ? 1 : 0
  ).run();
  if (body?.is_default) {
    await env.DB.prepare(
      `UPDATE payment_methods SET is_default=0 WHERE user_id=? AND id<>?`
    ).bind(user.id, id).run();
  }
  return ok({ id, message: '결제수단이 저장되었습니다.' });
}

export async function onRequestDelete({ request, env }) {
  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);
  let body;
  try { body = await request.json(); } catch { return err('요청 형식 오류'); }
  const id = String(body?.id || '');
  if (!id) return err('id가 필요합니다.');
  await env.DB.prepare(`DELETE FROM payment_methods WHERE id=? AND user_id=?`).bind(id, user.id).run();
  return ok({ message: '결제수단이 삭제되었습니다.' });
}
