import { CORS, ok, err, getUser, requireAdmin, genId } from '../_shared.js';

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequestGet({ env }) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, name, description, price, currency, active, created_at, updated_at
       FROM products
       WHERE active=1
       ORDER BY created_at DESC`
    ).all();
    return ok({ products: results || [] });
  } catch (e) {
    return err('상품 조회 실패: ' + e.message, 500);
  }
}

export async function onRequestPost({ request, env }) {
  const admin = await requireAdmin(env, request);
  if (!admin) return err('관리자 권한이 필요합니다.', 403);

  let body;
  try { body = await request.json(); } catch { return err('요청 형식 오류'); }
  const name = String(body?.name || '').trim();
  const description = String(body?.description || '').trim();
  const price = Number(body?.price || 0);
  const active = body?.active === false ? 0 : 1;

  if (!name) return err('상품명이 필요합니다.');
  if (!Number.isFinite(price) || price <= 0) return err('유효한 가격이 필요합니다.');

  try {
    const id = String(body?.id || '').trim() || ('prd_' + genId());
    const existing = await env.DB.prepare(`SELECT id FROM products WHERE id=?`).bind(id).first();
    if (existing) {
      await env.DB.prepare(
        `UPDATE products
         SET name=?, description=?, price=?, active=?, updated_at=datetime('now')
         WHERE id=?`
      ).bind(name, description, Math.floor(price), active, id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO products (id, name, description, price, currency, active, created_by)
         VALUES (?, ?, ?, ?, 'KRW', ?, ?)`
      ).bind(id, name, description, Math.floor(price), active, admin.id).run();
    }
    return ok({ message: '상품이 저장되었습니다.', id });
  } catch (e) {
    return err('상품 저장 실패: ' + e.message, 500);
  }
}
