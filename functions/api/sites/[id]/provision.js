// functions/api/sites/[id]/provision.js — CloudPress v12.1
//
// 프로비저닝 파이프라인 (심플, 오리진 부하 제로):
//
//   Step 1 — 사이트 전용 D1 데이터베이스 생성 (CF API)
//   Step 2 — 사이트 전용 KV 네임스페이스 생성 (CF API)
//   Step 3 — 전역 CACHE KV 도메인→사이트 매핑 저장
//   Step 4 — CF DNS Zone 조회 + CNAME 레코드 등록
//   Step 5 — Worker Route 등록 (루트 + www)
//   Step 6 — 완료
//
// WP origin 호출 없음 / R2 없음 / 직접 설치 없음

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};
const _j = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s, headers: { 'Content-Type': 'application/json', ...CORS },
});
const ok  = (d = {}) => _j({ ok: true,  ...d });
const err = (msg, s = 400) => _j({ ok: false, error: msg }, s);

function getToken(req) {
  const a = req.headers.get('Authorization') || '';
  if (a.startsWith('Bearer ')) return a.slice(7);
  const c = req.headers.get('Cookie') || '';
  const m = c.match(/cp_session=([^;]+)/);
  return m ? m[1] : null;
}

async function getUser(env, req) {
  try {
    const t = getToken(req);
    if (!t) return null;
    const uid = await env.SESSIONS.get(`session:${t}`);
    if (!uid) return null;
    return await env.DB.prepare('SELECT id,name,email,role,plan FROM users WHERE id=?').bind(uid).first();
  } catch { return null; }
}

async function getSetting(env, key, fallback = '') {
  try {
    const r = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
    return r?.value ?? fallback;
  } catch { return fallback; }
}

async function updateSite(DB, siteId, fields) {
  const entries = Object.entries(fields);
  if (!entries.length) return;
  const set  = entries.map(([k]) => `${k}=?`).join(',');
  const vals = entries.map(([, v]) => v);
  await DB.prepare(`UPDATE sites SET ${set}, updated_at=datetime('now') WHERE id=?`)
    .bind(...vals, siteId).run().catch(() => {});
}

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequestPost({ request, env, ctx, params }) {
  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);

  const siteId = params.id;
  const site = await env.DB.prepare(
    `SELECT id, user_id, name, primary_domain, site_prefix,
            wp_username, wp_password, wp_admin_email,
            status, provision_step, plan,
            site_d1_id, site_kv_id
     FROM sites WHERE id=? AND user_id=?`
  ).bind(siteId, user.id).first();

  if (!site) return err('사이트를 찾을 수 없습니다.', 404);
  if (site.status === 'active') return ok({ message: '이미 완료된 사이트입니다.' });
  if (site.status === 'provisioning') {
    return ok({ message: '프로비저닝 진행 중입니다.', provision_step: site.provision_step });
  }

  await updateSite(env.DB, siteId, { status: 'provisioning', provision_step: 'starting' });

  const pipeline = runPipeline(env, siteId, site);
  if (ctx?.waitUntil) ctx.waitUntil(pipeline.catch(() => {}));
  else pipeline.catch(() => {});

  return ok({ message: '프로비저닝을 시작합니다.', siteId });
}

// ══════════════════════════════════════════════════════════════════
// 파이프라인
// ══════════════════════════════════════════════════════════════════

async function runPipeline(env, siteId, site) {
  const domain    = site.primary_domain;
  const wwwDomain = 'www.' + domain;
  const prefix    = site.site_prefix;

  const cfToken    = await getSetting(env, 'cf_api_token');
  const cfAccount  = await getSetting(env, 'cf_account_id');
  const workerName = await getSetting(env, 'cf_worker_name', 'cloudpress-proxy');
  const wpOrigin   = await getSetting(env, 'wp_origin_url');

  if (!cfToken || !cfAccount) {
    return fail(env.DB, siteId, 'config_missing',
      'Cloudflare API Token 또는 Account ID가 설정되지 않았습니다. 관리자 → 설정을 확인해주세요.');
  }

  try {
    // ── Step 1: 사이트 전용 D1 생성 ────────────────────────────
    await updateSite(env.DB, siteId, { provision_step: 'd1_create' });

    let d1Id = site.site_d1_id;
    if (!d1Id) {
      const r = await createD1(cfToken, cfAccount, prefix);
      if (!r.ok) return fail(env.DB, siteId, 'd1_create', 'D1 생성 실패: ' + r.error);
      d1Id = r.id;
      await updateSite(env.DB, siteId, { site_d1_id: r.id, site_d1_name: r.name });
    }

    // ── Step 2: 사이트 전용 KV 생성 ────────────────────────────
    await updateSite(env.DB, siteId, { provision_step: 'kv_create' });

    let kvId = site.site_kv_id;
    if (!kvId) {
      const r = await createKV(cfToken, cfAccount, prefix);
      if (!r.ok) return fail(env.DB, siteId, 'kv_create', 'KV 생성 실패: ' + r.error);
      kvId = r.id;
      await updateSite(env.DB, siteId, { site_kv_id: r.id, site_kv_title: r.title });
    }

    // ── Step 3: 전역 CACHE KV 도메인 매핑 저장 ─────────────────
    await updateSite(env.DB, siteId, { provision_step: 'kv_mapping' });

    // 개인 도메인 기준 wp-admin URL
    const wpAdminUrl = `https://${domain}/wp-admin/`;

    const mapping = JSON.stringify({
      id:          siteId,
      name:        site.name,
      site_prefix: prefix,
      site_d1_id:  d1Id,
      site_kv_id:  kvId,
      wp_admin_url: wpAdminUrl,
      status:      'active',
      suspended:   0,
    });

    try {
      await env.CACHE.put(`site_domain:${domain}`,    mapping);
      await env.CACHE.put(`site_domain:${wwwDomain}`, mapping);
      await env.CACHE.put(`site_prefix:${prefix}`,    mapping);
    } catch (e) {
      // KV 실패는 치명적이지 않음 (Worker가 D1 fallback으로 조회)
      console.error('KV 매핑 저장 실패:', e.message);
    }

    // ── Step 4: CF DNS 레코드 등록 ──────────────────────────────
    await updateSite(env.DB, siteId, { provision_step: 'dns_setup' });

    let cfZoneId       = null;
    let dnsRecordId    = null;
    let dnsRecordWwwId = null;
    let domainStatus   = 'manual_required';

    const zone = await cfGetZone(cfToken, domain);
    if (zone.ok) {
      cfZoneId = zone.zoneId;
      const cnameTarget = await cfGetWorkerDevUrl(cfToken, cfAccount, workerName)
        || `${workerName}.workers.dev`;

      const dnsRoot = await cfUpsertDns(cfToken, cfZoneId,
        { type: 'CNAME', name: domain,    content: cnameTarget, proxied: true });
      const dnsWww  = await cfUpsertDns(cfToken, cfZoneId,
        { type: 'CNAME', name: wwwDomain, content: domain,      proxied: true });

      if (dnsRoot.ok) dnsRecordId    = dnsRoot.recordId;
      if (dnsWww.ok)  dnsRecordWwwId = dnsWww.recordId;

      // ── Step 5: Worker Route 등록 ────────────────────────────
      await updateSite(env.DB, siteId, { provision_step: 'worker_route' });

      const routeRoot = await cfUpsertRoute(cfToken, cfZoneId, `${domain}/*`,    workerName);
      const routeWww  = await cfUpsertRoute(cfToken, cfZoneId, `${wwwDomain}/*`, workerName);

      if (routeRoot.ok || routeWww.ok) {
        domainStatus = 'dns_propagating';
        await updateSite(env.DB, siteId, {
          worker_route:         `${domain}/*`,
          worker_route_www:     `${wwwDomain}/*`,
          worker_route_id:      routeRoot.routeId || null,
          worker_route_www_id:  routeWww.routeId  || null,
          cf_zone_id:           cfZoneId,
          dns_record_id:        dnsRecordId,
          dns_record_www_id:    dnsRecordWwwId,
        });
      }
    }

    // ── Step 6: 완료 ────────────────────────────────────────────
    const cnameHint = await getSetting(env, 'worker_cname_target', `${workerName}.workers.dev`);

    await updateSite(env.DB, siteId, {
      status:         'active',
      provision_step: 'completed',
      domain_status:  domainStatus,
      worker_name:    workerName,
      wp_admin_url:   wpAdminUrl,   // ← 개인 도메인 기준
      error_message:  domainStatus === 'manual_required'
        ? `DNS 자동 설정 불가. 도메인 DNS에서 CNAME ${domain} → ${cnameHint} 설정 후 Cloudflare 프록시(주황불) 활성화 필요.`
        : null,
    });

  } catch (e) {
    await fail(env.DB, siteId, 'pipeline_error', '파이프라인 오류: ' + e.message);
  }
}

async function fail(DB, siteId, step, msg) {
  await updateSite(DB, siteId, {
    status: 'failed', provision_step: step, error_message: msg,
  }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════════
// CF API 헬퍼
// ══════════════════════════════════════════════════════════════════

const CF = 'https://api.cloudflare.com/client/v4';

async function cfReq(token, path, method = 'GET', body = null) {
  const res = await fetch(CF + path, {
    method,
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : null,
  });
  return res.json().catch(() => ({ success: false, errors: [{ message: 'JSON 파싱 실패' }] }));
}

async function createD1(token, account, prefix) {
  const name = `cp-site-${prefix}`;
  const d = await cfReq(token, `/accounts/${account}/d1/database`, 'POST', { name });
  if (!d.result?.uuid) return { ok: false, error: d.errors?.[0]?.message || 'D1 생성 실패' };
  return { ok: true, id: d.result.uuid, name };
}

async function createKV(token, account, prefix) {
  const title = `CP_SITE_${prefix.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
  const d = await cfReq(token, `/accounts/${account}/storage/kv/namespaces`, 'POST', { title });
  if (!d.result?.id) return { ok: false, error: d.errors?.[0]?.message || 'KV 생성 실패' };
  return { ok: true, id: d.result.id, title };
}

async function cfGetZone(token, domain) {
  const root = domain.split('.').slice(-2).join('.');
  const d = await cfReq(token, `/zones?name=${root}&status=active`);
  if (!d.success || !d.result?.length) return { ok: false };
  return { ok: true, zoneId: d.result[0].id };
}

async function cfGetWorkerDevUrl(token, account, workerName) {
  try {
    const d = await cfReq(token, `/accounts/${account}/workers/scripts/${workerName}/subdomain`);
    if (d.success && d.result?.subdomain)
      return `${workerName}.${d.result.subdomain}.workers.dev`;
  } catch (_) {}
  return null;
}

async function cfUpsertDns(token, zoneId, { type, name, content, proxied }) {
  const ex = await cfReq(token, `/zones/${zoneId}/dns_records?type=${type}&name=${name}`);
  const rec = ex?.result?.[0];
  if (rec) {
    const u = await cfReq(token, `/zones/${zoneId}/dns_records/${rec.id}`, 'PUT',
      { type, name, content, proxied, ttl: 1 });
    return u.success ? { ok: true, recordId: rec.id } : { ok: false };
  }
  const c = await cfReq(token, `/zones/${zoneId}/dns_records`, 'POST',
    { type, name, content, proxied, ttl: 1 });
  return c.success ? { ok: true, recordId: c.result?.id } : { ok: false };
}

async function cfUpsertRoute(token, zoneId, pattern, script) {
  const ex = await cfReq(token, `/zones/${zoneId}/workers/routes`);
  const route = ex?.result?.find(r => r.pattern === pattern);
  if (route) {
    const u = await cfReq(token, `/zones/${zoneId}/workers/routes/${route.id}`, 'PUT', { pattern, script });
    return u.success ? { ok: true, routeId: route.id } : { ok: false };
  }
  const c = await cfReq(token, `/zones/${zoneId}/workers/routes`, 'POST', { pattern, script });
  return c.success ? { ok: true, routeId: c.result?.id } : { ok: false };
}
