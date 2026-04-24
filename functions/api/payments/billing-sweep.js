import { CORS, ok, err, requireAdmin } from '../_shared.js';

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequestPost({ request, env }) {
  const admin = await requireAdmin(env, request);
  if (!admin) return err('관리자 권한이 필요합니다.', 403);

  try {
    const rows = await env.DB.prepare(
      `SELECT id, primary_domain, site_prefix, cf_zone_id, worker_route_id, worker_route_www_id,
              site_d1_id, site_kv_id
       FROM sites
       WHERE status='active'
         AND next_billing_at IS NOT NULL
         AND datetime(next_billing_at, '+7 day') < datetime('now')`
    ).all();
    const targets = rows.results || [];

    const setRows = await env.DB.prepare(
      `SELECT key,value FROM settings WHERE key IN ('cf_api_token','cf_account_id')`
    ).all();
    const settings = Object.fromEntries((setRows.results || []).map((r) => [r.key, r.value]));
    const cfToken = settings.cf_api_token || '';
    const cfAccount = settings.cf_account_id || '';

    for (const s of targets) {
      // 1) 라우트 정리
      if (cfToken && s.cf_zone_id) {
        for (const routeId of [s.worker_route_id, s.worker_route_www_id]) {
          if (!routeId) continue;
          fetch(`https://api.cloudflare.com/client/v4/zones/${s.cf_zone_id}/workers/routes/${routeId}`, {
            method: 'DELETE',
            headers: { Authorization: 'Bearer ' + cfToken },
          }).catch(() => {});
        }
      }
      // 2) D1/KV/Worker 정리 (실패해도 계속)
      if (cfToken && cfAccount) {
        if (s.site_d1_id) {
          fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/d1/database/${s.site_d1_id}`, {
            method: 'DELETE', headers: { Authorization: 'Bearer ' + cfToken },
          }).catch(() => {});
        }
        if (s.site_kv_id) {
          fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/storage/kv/namespaces/${s.site_kv_id}`, {
            method: 'DELETE', headers: { Authorization: 'Bearer ' + cfToken },
          }).catch(() => {});
        }
        if (s.site_prefix) {
          fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/workers/scripts/cloudpress-site-${s.site_prefix}`, {
            method: 'DELETE', headers: { Authorization: 'Bearer ' + cfToken },
          }).catch(() => {});
        }
      }

      // 3) 캐시 키 정리
      try {
        await env.CACHE.delete(`site_domain:${s.primary_domain}`);
        await env.CACHE.delete(`site_domain:www.${s.primary_domain}`);
        await env.CACHE.delete(`site_prefix:${s.site_prefix}`);
      } catch (_) {}

      // 4) 상태 삭제 처리
      await env.DB.prepare(
        `UPDATE sites
         SET status='deleted',
             deleted_at=datetime('now'),
             billing_status='delinquent',
             suspension_reason='청구일 + 7일 경과 미납 자동 제거'
         WHERE id=?`
      ).bind(s.id).run();
    }

    return ok({ message: '정기 청구 미납 정리 완료', removed: targets.length });
  } catch (e) {
    return err('정리 작업 실패: ' + e.message, 500);
  }
}
