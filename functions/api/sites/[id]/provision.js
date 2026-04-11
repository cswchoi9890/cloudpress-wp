// functions/api/sites/[id]/provision.js — CloudPress v12.3
//
// 프로비저닝 파이프라인:
//   Step 1 — 사이트 전용 D1 데이터베이스 생성
//   Step 2 — 사이트 전용 KV 네임스페이스 생성
//   Step 3 — 전역 CACHE KV 도메인 매핑 저장
//   Step 4 — CF DNS Zone 조회 + CNAME 레코드 등록
//   Step 5 — Worker Route 등록 (루트 + www)
//   Step 6 — 완료
//
// CF 인증: 사용자 개인 Global API Key (X-Auth-Key) 우선,
//          없으면 관리자 Bearer Token 폴백
// WP 어드민 URL: 항상 사용자 개인 도메인 기준

'use strict';

// ── CORS / 응답 헬퍼 ─────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};
function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
const ok  = (data = {})     => jsonRes({ ok: true,  ...data });
const err = (msg,  s = 400) => jsonRes({ ok: false, error: msg }, s);

// ── 인증 헬퍼 ────────────────────────────────────────────────────
function getToken(req) {
  const auth   = req.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const cookie = req.headers.get('Cookie') || '';
  const m      = cookie.match(/cp_session=([^;]+)/);
  return m ? m[1] : null;
}

async function getUser(env, req) {
  try {
    const token = getToken(req);
    if (!token) return null;
    const uid = await env.SESSIONS.get('session:' + token);
    if (!uid) return null;
    return await env.DB
      .prepare('SELECT id, name, email, role, plan FROM users WHERE id=?')
      .bind(uid).first();
  } catch {
    return null;
  }
}

// ── DB 헬퍼 ──────────────────────────────────────────────────────
async function getSetting(env, key, fallback) {
  if (fallback === undefined) fallback = '';
  try {
    const row = await env.DB
      .prepare('SELECT value FROM settings WHERE key=?')
      .bind(key).first();
    return (row && row.value !== null && row.value !== undefined) ? row.value : fallback;
  } catch {
    return fallback;
  }
}

async function updateSite(DB, siteId, fields) {
  const entries = Object.entries(fields);
  if (!entries.length) return;
  const setClause = entries.map(function(e) { return e[0] + '=?'; }).join(', ');
  const values    = entries.map(function(e) { return e[1]; });
  values.push(siteId);
  try {
    var stmt = DB.prepare('UPDATE sites SET ' + setClause + ", updated_at=datetime('now') WHERE id=?");
    await stmt.bind(...values).run();
  } catch (e) {
    console.error('updateSite 오류:', e.message);
  }
}

async function failSite(DB, siteId, step, message) {
  if (step && message) {
    console.error('[provision FAIL] siteId=' + siteId + ' step=' + step + ' msg=' + message);
  }
  try {
    if (step && message) {
      await DB.prepare(
        "UPDATE sites SET status='failed', provision_step=?, error_message=?, updated_at=datetime('now') WHERE id=?"
      ).bind(step, message, siteId).run();
    } else {
      await DB.prepare(
        "UPDATE sites SET status='provisioning', provision_step='starting', error_message=NULL, updated_at=datetime('now') WHERE id=?"
      ).bind(siteId).run();
    }
  } catch (e) {
    console.error('failSite 오류:', e.message);
  }
}

// ── XOR 복호화 (user/index.js 와 동일) ───────────────────────────
function deobfuscate(str, salt) {
  if (!str) return '';
  try {
    var key     = salt || 'cp_enc_v1';
    var decoded = atob(str);
    var result  = '';
    for (var i = 0; i < decoded.length; i++) {
      result += String.fromCharCode(
        decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length)
      );
    }
    return result;
  } catch {
    return '';
  }
}

// ── Cloudflare API ───────────────────────────────────────────────
const CF_BASE = 'https://api.cloudflare.com/client/v4';

async function cfReq(auth, path, method, body) {
  if (!method) method = 'GET';
  var headers = { 'Content-Type': 'application/json' };

  if (auth.type === 'global') {
    headers['X-Auth-Email'] = auth.email;
    headers['X-Auth-Key']   = auth.key;
  } else {
    headers['Authorization'] = 'Bearer ' + auth.value;
  }

  var fetchOpts = { method: method, headers: headers };
  if (body !== null && body !== undefined) {
    fetchOpts.body = JSON.stringify(body);
  }

  var res;
  try {
    res = await fetch(CF_BASE + path, fetchOpts);
  } catch (e) {
    console.error('[cfReq] fetch 실패:', e.message);
    return { success: false, errors: [{ message: 'fetch 실패: ' + e.message }] };
  }

  var json;
  try {
    json = await res.json();
  } catch {
    json = { success: false, errors: [{ message: 'HTTP ' + res.status + ' JSON 파싱 실패' }] };
  }

  if (!json.success) {
    var errMsg = json.errors && json.errors[0] ? json.errors[0].message : 'unknown';
    console.error('[cfReq] ' + method + ' ' + path + ' 실패: ' + errMsg);
  }

  return json;
}

function makeAuth(cfKey, cfEmail) {
  if (cfEmail && cfEmail.indexOf('@') !== -1) {
    return { type: 'global', key: cfKey, email: cfEmail };
  }
  return { type: 'bearer', value: cfKey };
}

async function createD1(auth, accountId, prefix) {
  var name = 'cp-site-' + prefix;
  var res  = await cfReq(auth, '/accounts/' + accountId + '/d1/database', 'POST', { name: name });
  if (!res.success || !res.result || !res.result.uuid) {
    var msg = (res.errors && res.errors[0]) ? res.errors[0].message : 'unknown';
    return { ok: false, error: 'D1 생성 실패: ' + msg };
  }
  return { ok: true, id: res.result.uuid, name: name };
}

async function createKV(auth, accountId, prefix) {
  var title = 'CP_SITE_' + prefix.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  var res   = await cfReq(auth, '/accounts/' + accountId + '/storage/kv/namespaces', 'POST', { title: title });
  if (!res.success || !res.result || !res.result.id) {
    var msg = (res.errors && res.errors[0]) ? res.errors[0].message : 'unknown';
    return { ok: false, error: 'KV 생성 실패: ' + msg };
  }
  return { ok: true, id: res.result.id, title: title };
}

async function cfGetZone(auth, domain) {
  var root = domain.split('.').slice(-2).join('.');
  var res  = await cfReq(auth, '/zones?name=' + encodeURIComponent(root) + '&status=active');
  if (!res.success || !res.result || !res.result.length) return { ok: false };
  return { ok: true, zoneId: res.result[0].id };
}

async function cfGetWorkerSubdomain(auth, accountId, workerName) {
  try {
    var res = await cfReq(auth, '/accounts/' + accountId + '/workers/scripts/' + workerName + '/subdomain');
    if (res.success && res.result && res.result.subdomain) {
      return workerName + '.' + res.result.subdomain + '.workers.dev';
    }
  } catch (e) {
    console.error('Worker subdomain 조회 실패:', e.message);
  }
  return null;
}

async function cfUpsertDns(auth, zoneId, type, name, content, proxied) {
  var list     = await cfReq(auth, '/zones/' + zoneId + '/dns_records?type=' + type + '&name=' + encodeURIComponent(name));
  var existing = list && list.result && list.result[0] ? list.result[0] : null;

  if (existing) {
    var upd = await cfReq(auth, '/zones/' + zoneId + '/dns_records/' + existing.id, 'PUT',
      { type: type, name: name, content: content, proxied: proxied, ttl: 1 });
    if (upd.success) return { ok: true, recordId: existing.id };
    return { ok: false, error: (upd.errors && upd.errors[0]) ? upd.errors[0].message : 'unknown' };
  }

  var created = await cfReq(auth, '/zones/' + zoneId + '/dns_records', 'POST',
    { type: type, name: name, content: content, proxied: proxied, ttl: 1 });
  if (created.success) return { ok: true, recordId: created.result && created.result.id };
  return { ok: false, error: (created.errors && created.errors[0]) ? created.errors[0].message : 'unknown' };
}

async function cfUpsertRoute(auth, zoneId, pattern, script) {
  var list  = await cfReq(auth, '/zones/' + zoneId + '/workers/routes');
  var exist = null;
  if (list && list.result) {
    for (var i = 0; i < list.result.length; i++) {
      if (list.result[i].pattern === pattern) { exist = list.result[i]; break; }
    }
  }

  if (exist) {
    var upd = await cfReq(auth, '/zones/' + zoneId + '/workers/routes/' + exist.id, 'PUT',
      { pattern: pattern, script: script });
    if (upd.success) return { ok: true, routeId: exist.id };
    return { ok: false, error: (upd.errors && upd.errors[0]) ? upd.errors[0].message : 'unknown' };
  }

  var created = await cfReq(auth, '/zones/' + zoneId + '/workers/routes', 'POST',
    { pattern: pattern, script: script });
  if (created.success) return { ok: true, routeId: created.result && created.result.id };
  return { ok: false, error: (created.errors && created.errors[0]) ? created.errors[0].message : 'unknown' };
}

// ══════════════════════════════════════════════════════════════════
// 메인 핸들러
// ══════════════════════════════════════════════════════════════════

export const onRequestOptions = () =>
  new Response(null, { status: 204, headers: CORS });

export async function onRequestPost({ request, env, params }) {

  // ── 1. 인증 ────────────────────────────────────────────────────
  var user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);

  var siteId = params.id;

  // ── 2. 사이트 조회 (사용자 CF 자격증명 포함) ───────────────────
  var site;
  try {
    site = await env.DB.prepare(
      'SELECT s.id, s.user_id, s.name, s.primary_domain, s.site_prefix,' +
      '       s.wp_username, s.wp_password, s.wp_admin_email,' +
      '       s.status, s.provision_step, s.plan,' +
      '       s.site_d1_id, s.site_kv_id,' +
      '       u.cf_global_api_key, u.cf_account_email, u.cf_account_id' +
      ' FROM sites s' +
      ' JOIN users u ON u.id = s.user_id' +
      ' WHERE s.id=? AND s.user_id=?'
    ).bind(siteId, user.id).first();
  } catch (e) {
    return err('사이트 조회 오류: ' + e.message, 500);
  }

  if (!site) return err('사이트를 찾을 수 없습니다.', 404);
  if (site.status === 'active') return ok({ message: '이미 완료된 사이트입니다.' });

  // failed 상태도 재시도 허용 — 상태 초기화
  await updateSite(env.DB, siteId, { status: 'provisioning', provision_step: 'starting', error_message: null });

  // ── 3. CF 자격증명 결정 ────────────────────────────────────────
  var encKey   = env.ENCRYPTION_KEY || 'cp_enc_default';
  var cfKey    = null;
  var cfEmail  = '';
  var cfAccount = null;
  var authMode  = '';

  if (site.cf_global_api_key && site.cf_account_id) {
    cfKey     = deobfuscate(site.cf_global_api_key, encKey);
    cfEmail   = site.cf_account_email || '';
    cfAccount = site.cf_account_id;
    authMode  = 'user_global';
  }

  if (!cfKey || !cfAccount) {
    cfKey     = await getSetting(env, 'cf_api_token');
    cfAccount = await getSetting(env, 'cf_account_id');
    cfEmail   = '';
    authMode  = 'admin_bearer';
  }

  if (!cfKey || !cfAccount) {
    await failSite(env.DB, siteId, 'config_missing',
      'Cloudflare API 키가 없습니다. 내 계정 → Cloudflare API 키를 먼저 등록해주세요.');
    var s0 = await env.DB.prepare('SELECT status, provision_step, error_message FROM sites WHERE id=?').bind(siteId).first();
    return jsonRes({ ok: false, error: s0 ? s0.error_message : 'CF API 키 없음', site: s0 }, 400);
  }

  var auth        = makeAuth(cfKey, cfEmail);
  var workerName  = await getSetting(env, 'cf_worker_name', 'cloudpress-proxy');
  var domain      = site.primary_domain;
  var wwwDomain   = 'www.' + domain;
  var prefix      = site.site_prefix;
  var wpAdminUrl  = 'https://' + domain + '/wp-admin/';

  console.log('[provision] start siteId=' + siteId + ' domain=' + domain + ' authMode=' + authMode + ' account=' + cfAccount);

  // ── Step 1: D1 생성 ────────────────────────────────────────────
  await updateSite(env.DB, siteId, { provision_step: 'd1_create' });

  var d1Id = site.site_d1_id || null;

  if (!d1Id) {
    var r1 = await createD1(auth, cfAccount, prefix);
    if (!r1.ok) {
      await failSite(env.DB, siteId, 'd1_create', r1.error);
      return jsonRes({ ok: false, error: r1.error }, 500);
    }
    d1Id = r1.id;
    await updateSite(env.DB, siteId, { site_d1_id: d1Id, site_d1_name: r1.name });
    console.log('[provision] D1 완료: ' + d1Id);
  }

  // ── Step 2: KV 생성 ────────────────────────────────────────────
  await updateSite(env.DB, siteId, { provision_step: 'kv_create' });

  var kvId = site.site_kv_id || null;

  if (!kvId) {
    var r2 = await createKV(auth, cfAccount, prefix);
    if (!r2.ok) {
      await failSite(env.DB, siteId, 'kv_create', r2.error);
      return jsonRes({ ok: false, error: r2.error }, 500);
    }
    kvId = r2.id;
    await updateSite(env.DB, siteId, { site_kv_id: kvId, site_kv_title: r2.title });
    console.log('[provision] KV 완료: ' + kvId);
  }

  // ── Step 3: CACHE KV 도메인 매핑 ───────────────────────────────
  await updateSite(env.DB, siteId, { provision_step: 'kv_mapping' });

  var mapping = JSON.stringify({
    id:           siteId,
    name:         site.name,
    site_prefix:  prefix,
    site_d1_id:   d1Id,
    site_kv_id:   kvId,
    wp_admin_url: wpAdminUrl,
    status:       'active',
    suspended:    0,
  });

  try {
    await env.CACHE.put('site_domain:' + domain,    mapping);
    await env.CACHE.put('site_domain:' + wwwDomain, mapping);
    await env.CACHE.put('site_prefix:' + prefix,    mapping);
    console.log('[provision] CACHE KV 매핑 완료');
  } catch (e) {
    console.error('[provision] CACHE KV 매핑 실패 (무시):', e.message);
  }

  // ── Step 4: DNS ─────────────────────────────────────────────────
  await updateSite(env.DB, siteId, { provision_step: 'dns_setup' });

  var cfZoneId       = null;
  var dnsRecordId    = null;
  var dnsRecordWwwId = null;
  var domainStatus   = 'manual_required';

  var zone = await cfGetZone(auth, domain);

  if (zone.ok) {
    cfZoneId = zone.zoneId;
    console.log('[provision] Zone: ' + cfZoneId);

    var cnameTarget = (await cfGetWorkerSubdomain(auth, cfAccount, workerName)) || (workerName + '.workers.dev');
    console.log('[provision] CNAME target: ' + cnameTarget);

    var dnsRoot = await cfUpsertDns(auth, cfZoneId, 'CNAME', domain,    cnameTarget, true);
    var dnsWww  = await cfUpsertDns(auth, cfZoneId, 'CNAME', wwwDomain, cnameTarget, true);

    if (dnsRoot.ok) { dnsRecordId    = dnsRoot.recordId;   console.log('[provision] DNS root: ' + dnsRecordId); }
    else            { console.error('[provision] DNS root 실패:', dnsRoot.error); }
    if (dnsWww.ok)  { dnsRecordWwwId = dnsWww.recordId;    console.log('[provision] DNS www: ' + dnsRecordWwwId); }

    // ── Step 5: Worker Route ──────────────────────────────────
    await updateSite(env.DB, siteId, { provision_step: 'worker_route' });

    var routeRoot = await cfUpsertRoute(auth, cfZoneId, domain    + '/*', workerName);
    var routeWww  = await cfUpsertRoute(auth, cfZoneId, wwwDomain + '/*', workerName);

    if (routeRoot.ok || routeWww.ok) {
      domainStatus = 'dns_propagating';
      await updateSite(env.DB, siteId, {
        worker_route:        domain    + '/*',
        worker_route_www:    wwwDomain + '/*',
        worker_route_id:     routeRoot.routeId  || null,
        worker_route_www_id: routeWww.routeId   || null,
        cf_zone_id:          cfZoneId,
        dns_record_id:       dnsRecordId,
        dns_record_www_id:   dnsRecordWwwId,
      });
      console.log('[provision] Worker Route 완료');
    } else {
      console.error('[provision] Worker Route 실패 root=' + routeRoot.error + ' www=' + routeWww.error);
    }
  } else {
    console.log('[provision] Zone 없음 → DNS 수동 설정 필요');
  }

  // ── Step 6: 완료 ───────────────────────────────────────────────
  var cnameHint = await getSetting(env, 'worker_cname_target', workerName + '.workers.dev');

  await updateSite(env.DB, siteId, {
    status:         'active',
    provision_step: 'completed',
    domain_status:  domainStatus,
    worker_name:    workerName,
    wp_admin_url:   wpAdminUrl,
    error_message:  domainStatus === 'manual_required'
      ? 'DNS 수동 설정 필요 — CNAME: ' + domain + ' → ' + cnameHint + ' 로 등록 후 Cloudflare 프록시(주황불) 켜주세요.'
      : null,
  });

  console.log('[provision] 완료 siteId=' + siteId + ' domainStatus=' + domainStatus);

  var finalSite = await env.DB.prepare(
    'SELECT status, provision_step, error_message, wp_admin_url,' +
    '       wp_username, wp_password, primary_domain,' +
    '       site_d1_id, site_kv_id, domain_status, worker_name, name' +
    ' FROM sites WHERE id=?'
  ).bind(siteId).first();

  return ok({ message: '프로비저닝 완료', siteId: siteId, site: finalSite });
}
