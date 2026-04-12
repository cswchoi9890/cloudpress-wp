// functions/api/sites/[id]/provision.js — CloudPress v13.0
//
// [v13.0 핵심 변경사항]
// 1. 사이트마다 전용 Worker 생성 (cloudpress-site-{prefix})
//    → 기존 단일 공유 워커 완전 폐기
// 2. 워커에 4가지 바인딩 완전 주입:
//    - DB        (메인 CloudPress D1 — 도메인→사이트 조회)
//    - CACHE     (메인 CloudPress KV — 도메인 캐시)
//    - SITE_DB   (사이트 전용 D1)
//    - SITE_KV   (사이트 전용 KV)
// 3. null 가드 완전 적용 → "Cannot read properties of undefined (reading 'get')" 차단
// 4. 메인 D1/KV UUID는 Pages API 역추출로 자동 확보
'use strict';

var CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function jsonRes(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
  });
}
function ok(data)    { return jsonRes(Object.assign({ ok: true  }, data || {})); }
function err(msg, s) { return jsonRes({ ok: false, error: msg }, s || 400); }

function getToken(req) {
  var a = req.headers.get('Authorization') || '';
  if (a.startsWith('Bearer ')) return a.slice(7);
  var c = req.headers.get('Cookie') || '';
  var m = c.match(/cp_session=([^;]+)/);
  return m ? m[1] : null;
}

async function getUser(env, req) {
  try {
    if (!env || !env.SESSIONS || !env.DB) return null;
    var t = getToken(req);
    if (!t) return null;
    var uid = await env.SESSIONS.get('session:' + t);
    if (!uid) return null;
    return await env.DB.prepare('SELECT id,name,email,role,plan FROM users WHERE id=?').bind(uid).first();
  } catch (e) { return null; }
}

async function getSetting(env, key, fallback) {
  try {
    var row = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
    return (row && row.value != null && row.value !== '') ? row.value : (fallback || '');
  } catch (e) { return fallback || ''; }
}

async function updateSite(DB, siteId, fields) {
  var keys = Object.keys(fields);
  if (!keys.length) return;
  var setParts = [];
  var vals = [];
  for (var i = 0; i < keys.length; i++) {
    setParts.push(keys[i] + '=?');
    vals.push(fields[keys[i]]);
  }
  vals.push(siteId);
  var sql = 'UPDATE sites SET ' + setParts.join(', ') + ", updated_at=datetime('now') WHERE id=?";
  try {
    await DB.prepare(sql).bind(...vals).run();
  } catch (e) { console.error('updateSite err:', e.message); }
}

async function failSite(DB, siteId, step, message) {
  console.error('[FAIL] ' + step + ': ' + message);
  try {
    await DB.prepare(
      "UPDATE sites SET status='failed', provision_step=?, error_message=?, updated_at=datetime('now') WHERE id=?"
    ).bind(step, String(message).substring(0, 500), siteId).run();
  } catch (e) { console.error('failSite err:', e.message); }
}

function deobfuscate(str, salt) {
  if (!str) return '';
  try {
    var key = salt || 'cp_enc_v1';
    var dec = atob(str);
    var out = '';
    for (var i = 0; i < dec.length; i++) {
      out += String.fromCharCode(dec.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return out;
  } catch (e) { return ''; }
}

function randSuffix(len) {
  var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var out = '';
  for (var i = 0; i < (len || 6); i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

var CF_API = 'https://api.cloudflare.com/client/v4';

function makeAuth(key, email) {
  if (email && email.includes('@')) {
    return { type: 'global', key: key, email: email };
  }
  return { type: 'bearer', value: key };
}

function getAuthHeaders(auth) {
  if (auth.type === 'global') {
    return {
      'Content-Type': 'application/json',
      'X-Auth-Email': auth.email,
      'X-Auth-Key':   auth.key,
    };
  }
  return {
    'Content-Type':  'application/json',
    'Authorization': 'Bearer ' + (auth.value || auth.key),
  };
}

async function cfReq(auth, path, method, body) {
  var opts = { method: method || 'GET', headers: getAuthHeaders(auth) };
  if (body !== undefined && body !== null) opts.body = JSON.stringify(body);
  try {
    var res  = await fetch(CF_API + path, opts);
    var json = await res.json();
    if (!json.success) {
      console.error('[cfReq] ' + (method || 'GET') + ' ' + path + ' failed:', JSON.stringify(json.errors || []));
    }
    return json;
  } catch (e) {
    return { success: false, errors: [{ message: e.message }] };
  }
}

function cfErrMsg(json) {
  if (json && json.errors && json.errors.length > 0) {
    return json.errors.map(function(e) {
      return (e.code ? '[' + e.code + '] ' : '') + (e.message || '');
    }).join('; ');
  }
  return 'unknown error';
}

// ── D1 생성 ────────────────────────────────────────────────────────
async function createD1(auth, accountId, prefix) {
  var suffix = Date.now().toString(36) + randSuffix();
  var name = 'cp-' + prefix + '-' + suffix;

  var res = await cfReq(auth, '/accounts/' + accountId + '/d1/database', 'POST', { name: name });
  if (res.success && res.result) {
    var id = res.result.uuid || res.result.id || res.result.database_id;
    if (id) return { ok: true, id: id, name: name };
  }

  var errMsg = cfErrMsg(res);
  if (
    errMsg.toLowerCase().includes('already exist') ||
    errMsg.includes('10033') ||
    (res.errors && res.errors.some(function(e) { return e.code === 10033; }))
  ) {
    var page = 1;
    while (true) {
      var listRes = await cfReq(auth, '/accounts/' + accountId + '/d1/database?per_page=100&page=' + page);
      if (!listRes.success || !Array.isArray(listRes.result) || listRes.result.length === 0) break;
      for (var i = 0; i < listRes.result.length; i++) {
        var db = listRes.result[i];
        if (db.name === name) {
          var existId = db.uuid || db.id || db.database_id;
          if (existId) return { ok: true, id: existId, name: name };
        }
      }
      if (listRes.result.length < 100) break;
      page++;
    }
    return { ok: false, error: 'D1 이름 충돌 — 기존 DB에서 찾지 못함: ' + name };
  }

  return { ok: false, error: 'D1 생성 실패: ' + errMsg };
}

// ── KV 생성 ────────────────────────────────────────────────────────
async function createKV(auth, accountId, prefix) {
  var suffix = Date.now().toString(36).toUpperCase() + randSuffix().toUpperCase();
  var title = 'CP_' + prefix.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_' + suffix;

  var res = await cfReq(auth, '/accounts/' + accountId + '/storage/kv/namespaces', 'POST', { title: title });
  if (res.success && res.result && res.result.id) {
    return { ok: true, id: res.result.id, title: title };
  }

  var errMsg = cfErrMsg(res);
  if (
    errMsg.toLowerCase().includes('already exist') ||
    errMsg.includes('10016') ||
    (res.errors && res.errors.some(function(e) { return e.code === 10016; }))
  ) {
    var page = 1;
    while (true) {
      var listRes = await cfReq(auth, '/accounts/' + accountId + '/storage/kv/namespaces?per_page=100&page=' + page);
      if (!listRes.success || !Array.isArray(listRes.result) || listRes.result.length === 0) break;
      for (var i = 0; i < listRes.result.length; i++) {
        var ns = listRes.result[i];
        if (ns.title === title) {
          return { ok: true, id: ns.id, title: title };
        }
      }
      if (listRes.result.length < 100) break;
      page++;
    }
    return { ok: false, error: 'KV 이름 충돌 — 기존 목록에서 찾지 못함: ' + title };
  }

  return { ok: false, error: 'KV 생성 실패: ' + errMsg };
}

// ── D1 스키마 초기화 ───────────────────────────────────────────────
async function initD1Schema(auth, accountId, d1Id) {
  var sqls = [
    "CREATE TABLE IF NOT EXISTS wp_options (option_id INTEGER PRIMARY KEY AUTOINCREMENT, option_name TEXT NOT NULL UNIQUE, option_value TEXT NOT NULL DEFAULT '', autoload TEXT NOT NULL DEFAULT 'yes')",
    "CREATE TABLE IF NOT EXISTS wp_posts (ID INTEGER PRIMARY KEY AUTOINCREMENT, post_author INTEGER NOT NULL DEFAULT 0, post_date TEXT NOT NULL DEFAULT (datetime('now')), post_content TEXT NOT NULL DEFAULT '', post_title TEXT NOT NULL DEFAULT '', post_status TEXT NOT NULL DEFAULT 'publish', post_type TEXT NOT NULL DEFAULT 'post', post_name TEXT NOT NULL DEFAULT '', modified_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE TABLE IF NOT EXISTS wp_users (ID INTEGER PRIMARY KEY AUTOINCREMENT, user_login TEXT NOT NULL UNIQUE, user_pass TEXT NOT NULL, user_email TEXT NOT NULL DEFAULT '', user_registered TEXT NOT NULL DEFAULT (datetime('now')), display_name TEXT NOT NULL DEFAULT '')",
    "CREATE TABLE IF NOT EXISTS wp_usermeta (umeta_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, meta_key TEXT NOT NULL, meta_value TEXT)",
    "CREATE TABLE IF NOT EXISTS wp_postmeta (meta_id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL DEFAULT 0, meta_key TEXT, meta_value TEXT)",
    "CREATE TABLE IF NOT EXISTS wp_comments (comment_ID INTEGER PRIMARY KEY AUTOINCREMENT, comment_post_ID INTEGER NOT NULL DEFAULT 0, comment_content TEXT NOT NULL DEFAULT '', comment_date TEXT NOT NULL DEFAULT (datetime('now')), comment_approved TEXT NOT NULL DEFAULT '1')",
    "CREATE TABLE IF NOT EXISTS cp_site_meta (id INTEGER PRIMARY KEY AUTOINCREMENT, meta_key TEXT NOT NULL UNIQUE, meta_value TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE INDEX IF NOT EXISTS idx_wp_posts_status ON wp_posts(post_status)",
    "CREATE INDEX IF NOT EXISTS idx_wp_postmeta_post_id ON wp_postmeta(post_id)",
    "CREATE INDEX IF NOT EXISTS idx_wp_usermeta_user_id ON wp_usermeta(user_id)",
  ];

  for (var i = 0; i < sqls.length; i++) {
    try {
      var res = await cfReq(auth,
        '/accounts/' + accountId + '/d1/database/' + d1Id + '/query',
        'POST',
        { sql: sqls[i] }
      );
      if (!res.success) {
        console.warn('[provision] D1 schema stmt ' + i + ' 실패:', cfErrMsg(res));
      }
    } catch (e) {
      console.warn('[provision] D1 schema stmt ' + i + ' error:', e.message);
    }
  }
  console.log('[provision] D1 schema 초기화 완료');
}

// ── KV 초기 데이터 저장 ────────────────────────────────────────────
async function initKVData(auth, accountId, kvId, siteData) {
  var entries = [
    { key: 'site:config',  value: JSON.stringify(siteData) },
    { key: 'site:status',  value: 'active' },
    { key: 'site:created', value: new Date().toISOString() },
  ];

  for (var i = 0; i < entries.length; i++) {
    try {
      var hdrs = getAuthHeaders(auth);
      delete hdrs['Content-Type'];
      await fetch(
        CF_API + '/accounts/' + accountId + '/storage/kv/namespaces/' + kvId + '/values/' + encodeURIComponent(entries[i].key),
        { method: 'PUT', headers: hdrs, body: entries[i].value }
      );
    } catch (e) {
      console.warn('[provision] KV put ' + entries[i].key + ' 실패:', e.message);
    }
  }
  console.log('[provision] KV 초기 데이터 저장 완료');
}

// ── Pages 프로젝트명 자동 탐색 ────────────────────────────────────
async function findPagesProjectName(auth, accountId) {
  try {
    var listRes = await cfReq(auth, '/accounts/' + accountId + '/pages/projects?per_page=50');
    if (listRes.success && Array.isArray(listRes.result)) {
      for (var i = 0; i < listRes.result.length; i++) {
        var p = listRes.result[i];
        if (p.name && p.name.toLowerCase().includes('cloudpress')) return p.name;
      }
      if (listRes.result.length > 0) return listRes.result[0].name;
    }
  } catch (e) {
    console.warn('[provision] Pages 프로젝트 목록 조회 실패:', e.message);
  }
  return null;
}

// ── Pages에서 메인 CloudPress D1/KV UUID 역추출 ───────────────────
async function resolveMainBindingIds(auth, accountId, projectName, DB) {
  var result = { mainDbId: '', cacheKvId: '', sessionsKvId: '' };
  try {
    var projRes = await cfReq(auth, '/accounts/' + accountId + '/pages/projects/' + projectName);
    if (!projRes.success || !projRes.result) {
      console.warn('[provision] Pages 프로젝트 조회 실패 — binding ID 자동 감지 불가');
      return result;
    }
    var prodCfg = (projRes.result.deployment_configs && projRes.result.deployment_configs.production) || {};
    var d1Cfg   = prodCfg.d1_databases  || {};
    var kvCfg   = prodCfg.kv_namespaces || {};

    if (d1Cfg['DB']       && d1Cfg['DB'].id)       result.mainDbId     = d1Cfg['DB'].id;
    if (kvCfg['SESSIONS'] && kvCfg['SESSIONS'].id) result.sessionsKvId = kvCfg['SESSIONS'].id;
    if (kvCfg['CACHE']    && kvCfg['CACHE'].id)    result.cacheKvId    = kvCfg['CACHE'].id;

    console.log('[provision] 메인 binding ID 감지:', JSON.stringify(result));

    var upsertSql = "INSERT INTO settings (key,value,updated_at) VALUES (?,?,datetime('now'))" +
      " ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at";
    if (result.mainDbId)     { try { await DB.prepare(upsertSql).bind('main_db_id',     result.mainDbId).run();     } catch(_) {} }
    if (result.sessionsKvId) { try { await DB.prepare(upsertSql).bind('sessions_kv_id', result.sessionsKvId).run(); } catch(_) {} }
    if (result.cacheKvId)    { try { await DB.prepare(upsertSql).bind('cache_kv_id',    result.cacheKvId).run();    } catch(_) {} }

  } catch (e) {
    console.warn('[provision] binding ID 감지 오류:', e.message);
  }
  return result;
}

// ── DNS 관련 ──────────────────────────────────────────────────────
async function cfGetZone(auth, domain) {
  var parts = domain.split('.');
  var root2 = parts.slice(-2).join('.');
  var root3 = parts.length >= 3 ? parts.slice(-3).join('.') : root2;

  var res = await cfReq(auth, '/zones?name=' + encodeURIComponent(root2) + '&status=active');
  if (res.success && res.result && res.result.length > 0) {
    return { ok: true, zoneId: res.result[0].id };
  }
  if (root3 !== root2) {
    res = await cfReq(auth, '/zones?name=' + encodeURIComponent(root3) + '&status=active');
    if (res.success && res.result && res.result.length > 0) {
      return { ok: true, zoneId: res.result[0].id };
    }
  }
  return { ok: false };
}

async function cfUpsertDns(auth, zoneId, type, name, content, proxied) {
  var list     = await cfReq(auth, '/zones/' + zoneId + '/dns_records?type=' + type + '&name=' + encodeURIComponent(name));
  var existing = list && list.result && list.result[0] ? list.result[0] : null;
  var payload  = { type: type, name: name, content: content, proxied: proxied, ttl: 1 };
  if (existing) {
    var upd = await cfReq(auth, '/zones/' + zoneId + '/dns_records/' + existing.id, 'PUT', payload);
    return upd.success ? { ok: true, recordId: existing.id } : { ok: false, error: cfErrMsg(upd) };
  }
  var cre = await cfReq(auth, '/zones/' + zoneId + '/dns_records', 'POST', payload);
  return cre.success ? { ok: true, recordId: cre.result && cre.result.id } : { ok: false, error: cfErrMsg(cre) };
}

async function cfUpsertRoute(auth, zoneId, pattern, script) {
  var list  = await cfReq(auth, '/zones/' + zoneId + '/workers/routes');
  var exist = null;
  if (list && list.result) {
    for (var i = 0; i < list.result.length; i++) {
      if (list.result[i].pattern === pattern) { exist = list.result[i]; break; }
    }
  }
  var payload = { pattern: pattern, script: script };
  if (exist) {
    var upd = await cfReq(auth, '/zones/' + zoneId + '/workers/routes/' + exist.id, 'PUT', payload);
    return upd.success ? { ok: true, routeId: exist.id } : { ok: false, error: cfErrMsg(upd) };
  }
  var cre = await cfReq(auth, '/zones/' + zoneId + '/workers/routes', 'POST', payload);
  return cre.success ? { ok: true, routeId: cre.result && cre.result.id } : { ok: false, error: cfErrMsg(cre) };
}

// ── Worker subdomain 조회 ─────────────────────────────────────────
async function getWorkerSubdomain(auth, accountId, workerName) {
  try {
    var subRes = await cfReq(auth, '/accounts/' + accountId + '/workers/scripts/' + workerName + '/subdomain');
    if (subRes.success && subRes.result && subRes.result.subdomain) {
      return workerName + '.' + subRes.result.subdomain + '.workers.dev';
    }
    var accSubRes = await cfReq(auth, '/accounts/' + accountId + '/workers/subdomain');
    if (accSubRes.success && accSubRes.result && accSubRes.result.subdomain) {
      return workerName + '.' + accSubRes.result.subdomain + '.workers.dev';
    }
  } catch (e) {
    console.warn('[provision] Worker subdomain 조회 실패:', e.message);
  }
  return workerName + '.workers.dev';
}

// ── WP 사이트 초기화 ──────────────────────────────────────────────
async function initWpSite(wpOrigin, wpSecret, params) {
  if (!wpOrigin || !wpOrigin.startsWith('http')) {
    return { ok: true, skipped: true, message: 'WP Origin 미설정 — 건너뜀' };
  }
  var url = wpOrigin.replace(/\/$/, '') + '/wp-json/cloudpress/v1/init-site';
  try {
    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type':        'application/json',
        'X-CloudPress-Secret': wpSecret || '',
        'X-CloudPress-Site':   params.site_prefix,
      },
      body: JSON.stringify({
        site_prefix: params.site_prefix,
        site_name:   params.site_name || params.site_prefix,
        admin_user:  params.admin_user,
        admin_pass:  params.admin_pass,
        admin_email: params.admin_email,
        site_url:    params.site_url,
      }),
    });
    if (res.status === 200 || res.status === 201) {
      var json;
      try { json = await res.json(); } catch (e) { json = {}; }
      return { ok: true, message: json.message || '초기화 완료' };
    }
    var errJson;
    try { errJson = await res.json(); } catch (e) { errJson = {}; }
    var errMsg = errJson.message || errJson.error || ('HTTP ' + res.status);
    console.warn('[provision] WP init 실패 (계속):', errMsg);
    return { ok: true, skipped: true, message: 'WP 초기화 실패 (무시): ' + errMsg };
  } catch (e) {
    console.warn('[provision] WP Origin 연결 실패 (계속):', e.message);
    return { ok: true, skipped: true, message: 'WP Origin 연결 실패 (무시): ' + e.message };
  }
}

// ══════════════════════════════════════════════════════════════════════
// buildWorkerSource — 사이트 전용 Worker 소스코드 생성 (v14.0)
//
// [v14.0] WP Origin을 사용자 개인 도메인으로 완전 덮어쓰기
//   - wp-admin / wp-login 포함 모든 경로 단일 프록시 처리
//   - 리다이렉트 Location 완전 치환
//   - Set-Cookie domain 치환
//   - HTML/CSS/JS 본문 내 origin URL/host 전부 치환
// ══════════════════════════════════════════════════════════════════════
function buildWorkerSource() {
  var L = [];

  L.push("'use strict';");
  L.push("export default {");
  L.push("  async fetch(request, env) {");

  L.push("    // ── 0. null 가드 ──────────────────────────────────");
  L.push("    if (!env || !env.DB)    return errPage(503, '서버 설정 오류', 'DB 바인딩 없음');");
  L.push("    if (!env.CACHE)         return errPage(503, '서버 설정 오류', 'CACHE 바인딩 없음');");
  L.push("    var wpOriginUrl = (env.WP_ORIGIN_URL || '').trim().replace(/\\/+$/, '');");
  L.push("    if (!wpOriginUrl)        return errPage(503, '서버 설정 오류', 'WP_ORIGIN_URL 미설정');");

  L.push("    // ── 1. URL / host ─────────────────────────────────");
  L.push("    var url            = new URL(request.url);");
  L.push("    var rawHost        = url.hostname;");
  L.push("    var host           = rawHost.indexOf('www.') === 0 ? rawHost.slice(4) : rawHost;");
  L.push("    var personalOrigin = 'https://' + rawHost;");
  L.push("    var wpOriginHost   = new URL(wpOriginUrl).hostname;");

  L.push("    // ── 2. 내부 경로 통과 ─────────────────────────────");
  L.push("    if (url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/__cloudpress/') === 0) {");
  L.push("      return fetch(request);");
  L.push("    }");

  L.push("    // ── 3. 사이트 조회 ────────────────────────────────");
  L.push("    var site = null;");
  L.push("    var cacheKey = 'site_domain:' + host;");
  L.push("    try {");
  L.push("      var cached = await env.CACHE.get(cacheKey, { type: 'json' });");
  L.push("      if (cached) {");
  L.push("        site = cached;");
  L.push("      } else {");
  L.push("        var row = await env.DB.prepare(");
  L.push("          'SELECT id,name,site_prefix,site_d1_id,site_kv_id,wp_admin_url,status,suspended,suspension_reason'");
  L.push("          + ' FROM sites WHERE primary_domain=? AND status=\\'active\\' AND deleted_at IS NULL AND suspended=0 LIMIT 1'");
  L.push("        ).bind(host).first();");
  L.push("        if (row) { site = row; await env.CACHE.put(cacheKey, JSON.stringify(row), { expirationTtl: 300 }); }");
  L.push("      }");
  L.push("    } catch (e) { return errPage(500, '서버 오류', e.message || String(e)); }");
  L.push("    if (!site) return errPage(404, '사이트 없음', host + ' 에 연결된 사이트가 없습니다.');");
  L.push("    if (site.suspended) return suspendedPage(site.name, site.suspension_reason);");

  L.push("    // ── 4. 페이지 캐시 (wp-admin/wp-login 제외) ──────");
  L.push("    var isAdmin = url.pathname.indexOf('/wp-admin') === 0 || url.pathname === '/wp-login.php';");
  L.push("    var isCacheable = !isAdmin && request.method === 'GET'");
  L.push("      && url.pathname.indexOf('/wp-') !== 0");
  L.push("      && !url.searchParams.has('preview')");
  L.push("      && ((request.headers.get('cookie') || '').indexOf('wordpress_logged_in') === -1);");
  L.push("    if (isCacheable && env.SITE_KV) {");
  L.push("      try {");
  L.push("        var pageCacheKey = 'page:' + url.pathname + (url.search || '');");
  L.push("        var pageCache = await env.SITE_KV.get(pageCacheKey, { type: 'json' });");
  L.push("        if (pageCache && pageCache.body) {");
  L.push("          return new Response(pageCache.body, { headers: { 'Content-Type': pageCache.contentType || 'text/html; charset=utf-8', 'X-Cache': 'HIT', 'X-Site-Prefix': site.site_prefix || '' } });");
  L.push("        }");
  L.push("      } catch (e) { /* 캐시 미스 무시 */ }");
  L.push("    }");

  L.push("    // ── 5. Origin 프록시 (wp-admin 포함 전 경로 동일) ─");
  L.push("    var targetUrl = new URL(wpOriginUrl + url.pathname + url.search);");
  L.push("    var ph = new Headers(request.headers);");
  L.push("    ph.set('X-CloudPress-Site',       site.site_prefix || '');");
  L.push("    ph.set('X-CloudPress-Secret',     env.WP_ORIGIN_SECRET || '');");
  L.push("    ph.set('X-CloudPress-Domain',     rawHost);");
  L.push("    ph.set('X-CloudPress-D1-ID',      site.site_d1_id || '');");
  L.push("    ph.set('X-CloudPress-KV-ID',      site.site_kv_id || '');");
  L.push("    ph.set('X-CloudPress-Public-URL', personalOrigin);");
  L.push("    ph.set('Host',                    wpOriginHost);");
  L.push("    ph.set('X-Forwarded-Host',        rawHost);");
  L.push("    ph.set('X-Forwarded-Proto',       'https');");
  L.push("    ph.set('X-Real-IP',               request.headers.get('CF-Connecting-IP') || '');");
  L.push("    var oRes;");
  L.push("    try {");
  L.push("      oRes = await fetch(targetUrl.toString(), {");
  L.push("        method: request.method,");
  L.push("        headers: ph,");
  L.push("        body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,");
  L.push("        redirect: 'manual',");
  L.push("      });");
  L.push("    } catch (e) { return errPage(502, 'Origin 오류', e.message || String(e)); }");

  L.push("    // ── 6. 리다이렉트 — Location 완전 치환 ──────────");
  L.push("    if (oRes.status >= 300 && oRes.status < 400) {");
  L.push("      var rLoc = oRes.headers.get('Location') || '';");
  L.push("      rLoc = rewriteStr(rLoc, wpOriginUrl, personalOrigin, wpOriginHost, rawHost);");
  L.push("      var redirHdrs = new Headers();");
  L.push("      redirHdrs.set('Location', rLoc);");
  L.push("      for (var _p of oRes.headers) {");
  L.push("        if (_p[0].toLowerCase() === 'set-cookie') redirHdrs.append('Set-Cookie', rewriteCookie(_p[1], wpOriginHost, rawHost));");
  L.push("      }");
  L.push("      return new Response(null, { status: oRes.status, headers: redirHdrs });");
  L.push("    }");

  L.push("    // ── 7. 응답 헤더 ─────────────────────────────────");
  L.push("    var rh   = new Headers();");
  L.push("    var skip = ['transfer-encoding','content-encoding','content-length','connection','keep-alive'];");
  L.push("    for (var pair of oRes.headers) {");
  L.push("      if (skip.indexOf(pair[0].toLowerCase()) !== -1) continue;");
  L.push("      if (pair[0].toLowerCase() === 'set-cookie') { rh.append('Set-Cookie', rewriteCookie(pair[1], wpOriginHost, rawHost)); continue; }");
  L.push("      rh.set(pair[0], pair[1]);");
  L.push("    }");
  L.push("    rh.set('X-Cache', 'MISS');");
  L.push("    rh.set('X-Site-Prefix', site.site_prefix || '');");
  L.push("    rh.set('X-Frame-Options', 'SAMEORIGIN');");
  L.push("    rh.set('X-Content-Type-Options', 'nosniff');");
  L.push("    var ct = oRes.headers.get('content-type') || '';");

  L.push("    // ── 8. HTML — origin 완전 치환 + 캐시 저장 ───────");
  L.push("    if (ct.indexOf('text/html') >= 0) {");
  L.push("      var html = await oRes.text();");
  L.push("      html = rewriteStr(html, wpOriginUrl, personalOrigin, wpOriginHost, rawHost);");
  L.push("      if (isCacheable && oRes.status === 200 && env.SITE_KV) {");
  L.push("        env.SITE_KV.put('page:' + url.pathname + (url.search || ''), JSON.stringify({ body: html, contentType: ct }), { expirationTtl: 600 }).catch(function(){});");
  L.push("      }");
  L.push("      return new Response(html, { status: oRes.status, headers: rh });");
  L.push("    }");

  L.push("    // ── 9. CSS/JS — origin 치환 ──────────────────────");
  L.push("    if (ct.indexOf('text/css') >= 0 || ct.indexOf('javascript') >= 0) {");
  L.push("      var txt = await oRes.text();");
  L.push("      txt = rewriteStr(txt, wpOriginUrl, personalOrigin, wpOriginHost, rawHost);");
  L.push("      return new Response(txt, { status: oRes.status, headers: rh });");
  L.push("    }");

  L.push("    // ── 10. 바이너리 ─────────────────────────────────");
  L.push("    return new Response(oRes.body, { status: oRes.status, headers: rh });");
  L.push("  },");
  L.push("};");

  // ── 헬퍼 함수들 ────────────────────────────────────────────────
  L.push("function escRe(s) { return s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'); }");
  L.push("function rewriteStr(text, originBase, personalBase, originHost, personalHost) {");
  L.push("  text = text.split(originBase.replace(/^https?:/, 'https:')).join(personalBase);");
  L.push("  text = text.split(originBase.replace(/^https?:/, 'http:')).join(personalBase);");
  L.push("  text = text.split(originBase).join(personalBase);");
  L.push("  if (originHost !== personalHost) text = text.split(originHost).join(personalHost);");
  L.push("  return text;");
  L.push("}");
  L.push("function rewriteCookie(c, originHost, personalHost) {");
  L.push("  return c.replace(new RegExp('(domain=)' + escRe(originHost), 'gi'), '$1' + personalHost);");
  L.push("}");

  L.push("function errPage(status, title, detail) {");
  L.push("  var s = String(detail).replace(/</g,'&lt;').replace(/>/g,'&gt;');");
  L.push("  return new Response('<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"utf-8\"><title>'+title+'</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8f9fa}.b{text-align:center;padding:40px;max-width:480px}h1{color:#333;font-size:1.4rem}p{color:#666;font-size:.88rem;line-height:1.6}</style></head><body><div class=\"b\"><h1>'+title+'</h1><p>'+s+'</p></div></body></html>', { status: status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });");
  L.push("}");

  L.push("function suspendedPage(name, reason) {");
  L.push("  return new Response('<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"utf-8\"><title>일시정지</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fff8f0}.b{text-align:center;padding:40px}h1{color:#e67e22;font-size:1.4rem}</style></head><body><div class=\"b\"><h1>사이트 일시정지</h1><p>'+(name||'이 사이트')+'는 정지 상태입니다.</p>'+(reason?'<p>'+reason+'</p>':'')+'</div></body></html>', { status: 503, headers: { 'Content-Type': 'text/html;charset=utf-8' } });");
  L.push("}");

  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════════════
// uploadWorker — 사이트 전용 Worker 업로드
//
// opts:
//   mainDbId     — CloudPress 메인 D1 UUID (도메인→사이트 조회)
//   cacheKvId    — CloudPress 메인 KV UUID (도메인 캐시)
//   sessionsKvId — CloudPress Sessions KV UUID
//   siteD1Id     — ★ 이 사이트 전용 D1 UUID
//   siteKvId     — ★ 이 사이트 전용 KV UUID
//   wpOriginUrl, wpOriginSecret, cfAccountId, cfApiKey, sitePrefix
// ══════════════════════════════════════════════════════════════════════
async function uploadWorker(auth, accountId, workerName, opts) {
  var boundary = '----CPBoundary' + Date.now().toString(36);

  var bindings = [];

  // 메인 CloudPress D1 → env.DB
  if (opts.mainDbId) {
    bindings.push({ type: 'd1', name: 'DB', id: opts.mainDbId });
  }
  // 메인 CloudPress 도메인 캐시 KV → env.CACHE
  if (opts.cacheKvId) {
    bindings.push({ type: 'kv_namespace', name: 'CACHE', namespace_id: opts.cacheKvId });
  }
  // 메인 CloudPress Sessions KV → env.SESSIONS
  if (opts.sessionsKvId) {
    bindings.push({ type: 'kv_namespace', name: 'SESSIONS', namespace_id: opts.sessionsKvId });
  }
  // ★ 사이트 전용 D1 → env.SITE_DB
  if (opts.siteD1Id) {
    bindings.push({ type: 'd1', name: 'SITE_DB', id: opts.siteD1Id });
  }
  // ★ 사이트 전용 KV → env.SITE_KV
  if (opts.siteKvId) {
    bindings.push({ type: 'kv_namespace', name: 'SITE_KV', namespace_id: opts.siteKvId });
  }

  // 환경 변수
  bindings.push({ type: 'plain_text', name: 'WP_ORIGIN_URL',    text: opts.wpOriginUrl    || '' });
  bindings.push({ type: 'plain_text', name: 'WP_ORIGIN_SECRET', text: opts.wpOriginSecret || '' });
  bindings.push({ type: 'plain_text', name: 'CF_ACCOUNT_ID',    text: opts.cfAccountId    || '' });
  bindings.push({ type: 'plain_text', name: 'CF_API_TOKEN',     text: opts.cfApiKey       || '' });
  bindings.push({ type: 'plain_text', name: 'SITE_PREFIX',      text: opts.sitePrefix     || '' });

  var metadata  = JSON.stringify({
    main_module: 'worker.js',
    compatibility_date: '2024-09-23',
    bindings: bindings,
  });
  var workerSrc = buildWorkerSource();
  var enc  = new TextEncoder();
  var CRLF = '\r\n';
  var p1h  = '--' + boundary + CRLF + 'Content-Disposition: form-data; name="metadata"' + CRLF + 'Content-Type: application/json' + CRLF + CRLF;
  var p2h  = '--' + boundary + CRLF + 'Content-Disposition: form-data; name="worker.js"; filename="worker.js"' + CRLF + 'Content-Type: application/javascript+module' + CRLF + CRLF;
  var end  = CRLF + '--' + boundary + '--' + CRLF;
  var chunks  = [enc.encode(p1h), enc.encode(metadata), enc.encode(CRLF), enc.encode(p2h), enc.encode(workerSrc), enc.encode(end)];
  var total   = chunks.reduce(function(s, c) { return s + c.length; }, 0);
  var bodyBuf = new Uint8Array(total);
  var off = 0;
  for (var i = 0; i < chunks.length; i++) { bodyBuf.set(chunks[i], off); off += chunks[i].length; }

  var uploadHdrs;
  if (auth.type === 'global') {
    uploadHdrs = {
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'X-Auth-Email': auth.email,
      'X-Auth-Key':   auth.key,
    };
  } else {
    uploadHdrs = {
      'Content-Type':  'multipart/form-data; boundary=' + boundary,
      'Authorization': 'Bearer ' + (auth.value || auth.key),
    };
  }
  try {
    var res  = await fetch(CF_API + '/accounts/' + accountId + '/workers/scripts/' + workerName, {
      method: 'PUT',
      headers: uploadHdrs,
      body: bodyBuf.buffer,
    });
    var json = await res.json();
    if (!json.success) return { ok: false, error: 'Worker 업로드 실패: ' + cfErrMsg(json) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Worker 업로드 오류: ' + e.message };
  }
}

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequestPost({ request, env, params }) {
  var user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);

  var siteId = params && params.id;
  if (!siteId) return err('사이트 ID가 없습니다.', 400);

  var site;
  try {
    site = await env.DB.prepare(
      'SELECT s.id, s.user_id, s.name, s.primary_domain, s.site_prefix,'
      + ' s.wp_username, s.wp_password, s.wp_admin_email,'
      + ' s.status, s.provision_step, s.plan,'
      + ' s.site_d1_id, s.site_kv_id,'
      + ' u.cf_global_api_key, u.cf_account_email, u.cf_account_id'
      + ' FROM sites s JOIN users u ON u.id = s.user_id'
      + ' WHERE s.id=? AND s.user_id=?'
    ).bind(siteId, user.id).first();
  } catch (e) { return err('사이트 조회 오류: ' + e.message, 500); }

  if (!site) return err('사이트를 찾을 수 없습니다.', 404);
  if (site.status === 'active') return ok({ message: '이미 완료된 사이트입니다.' });

  await updateSite(env.DB, siteId, { status: 'provisioning', provision_step: 'starting', error_message: null });

  var encKey = (env && env.ENCRYPTION_KEY) || 'cp_enc_default';

  // ── 어드민 CF 키 (메인 KV/D1 UUID 역추출 전용) ─────────────────
  var adminCfKey     = await getSetting(env, 'cf_api_token');
  var adminCfAccount = await getSetting(env, 'cf_account_id');
  var adminAuth      = (adminCfKey && adminCfAccount) ? makeAuth(adminCfKey, '') : null;

  // ── 사용자 CF 키 (사이트 D1/KV/Worker 생성용) ──────────────────
  var userCfKey     = null;
  var userCfEmail   = '';
  var userCfAccount = null;

  if (site.cf_global_api_key && site.cf_account_id) {
    var raw = deobfuscate(site.cf_global_api_key, encKey);
    userCfKey     = (raw && raw.length > 5) ? raw : site.cf_global_api_key;
    userCfEmail   = site.cf_account_email || '';
    userCfAccount = site.cf_account_id;
    console.log('[provision] 사용자 개인 CF 키 사용 (account=' + userCfAccount + ')');
  }

  // 사용자 CF 키 없으면 어드민 키로 fallback (어드민 계정에 리소스 생성)
  if (!userCfKey || !userCfAccount) {
    userCfKey     = adminCfKey;
    userCfAccount = adminCfAccount;
    userCfEmail   = '';
    if (userCfKey && userCfAccount) console.log('[provision] 사용자 CF 키 없음 — 어드민 계정에 리소스 생성');
  }

  if (!userCfKey || !userCfAccount) {
    var cfErrText = 'Cloudflare API 키 또는 Account ID가 설정되지 않았습니다. 관리자 설정에서 CF API Token과 Account ID를 등록하거나, 사용자가 개인 CF 키를 등록해야 합니다.';
    await failSite(env.DB, siteId, 'config_missing', cfErrText);
    return jsonRes({ ok: false, error: cfErrText }, 400);
  }

  var userAuth     = makeAuth(userCfKey, userCfEmail);
  var wpOrigin     = await getSetting(env, 'wp_origin_url', '');
  var wpSecret     = await getSetting(env, 'wp_origin_secret', '');
  var domain       = site.primary_domain;
  var wwwDomain    = 'www.' + domain;
  var prefix       = site.site_prefix;
  var wpAdminUrl   = 'https://' + domain + '/wp-admin/';

  // ── 메인 CloudPress D1/KV UUID 확보 ────────────────────────────
  // 반드시 어드민 CF 키로 조회 (Pages 프로젝트가 어드민 계정에 있음)
  var mainDbId     = await getSetting(env, 'main_db_id', '');
  var cacheKvId    = await getSetting(env, 'cache_kv_id', '');
  var sessionsKvId = await getSetting(env, 'sessions_kv_id', '');

  if ((!mainDbId || !cacheKvId || !sessionsKvId) && adminAuth && adminCfAccount) {
    var pagesProjectName = await findPagesProjectName(adminAuth, adminCfAccount);
    if (pagesProjectName) {
      var resolvedIds = await resolveMainBindingIds(adminAuth, adminCfAccount, pagesProjectName, env.DB);
      if (!mainDbId)     mainDbId     = resolvedIds.mainDbId     || '';
      if (!cacheKvId)    cacheKvId    = resolvedIds.cacheKvId    || '';
      if (!sessionsKvId) sessionsKvId = resolvedIds.sessionsKvId || '';
    }
  }

  if (!mainDbId || !cacheKvId) {
    console.warn('[provision] 경고: 메인 D1/KV UUID 미확보 — DB/CACHE 바인딩 없이 워커 배포됨.');
  }
  console.log('[provision] 메인 IDs — DB:' + mainDbId + ' CACHE:' + cacheKvId + ' SESSIONS:' + sessionsKvId);
  console.log('[provision] 사이트 리소스 생성 계정: ' + userCfAccount);

  // ── 사이트 전용 워커 이름 ──────────────────────────────────────
  var workerName = 'cloudpress-site-' + prefix;
  console.log('[provision] start siteId=' + siteId + ' domain=' + domain + ' worker=' + workerName);

  // ── Step 1: 사이트 전용 D1 생성 (사용자 계정) ──────────────────
  await updateSite(env.DB, siteId, { provision_step: 'd1_create' });
  var d1Id = site.site_d1_id || null;
  if (!d1Id) {
    var r1 = await createD1(userAuth, userCfAccount, prefix);
    if (!r1.ok) {
      await failSite(env.DB, siteId, 'd1_create', r1.error);
      return jsonRes({ ok: false, error: r1.error }, 500);
    }
    d1Id = r1.id;
    await updateSite(env.DB, siteId, { site_d1_id: d1Id, site_d1_name: r1.name });
    console.log('[provision] 사이트 전용 D1 생성 완료 uuid=' + d1Id + ' name=' + r1.name);

    await updateSite(env.DB, siteId, { provision_step: 'd1_schema' });
    await initD1Schema(userAuth, userCfAccount, d1Id);
  } else {
    console.log('[provision] 사이트 전용 D1 기존 재사용 uuid=' + d1Id);
  }

  // ── Step 2: 사이트 전용 KV 생성 (사용자 계정) ──────────────────
  await updateSite(env.DB, siteId, { provision_step: 'kv_create' });
  var kvId = site.site_kv_id || null;
  if (!kvId) {
    var r2 = await createKV(userAuth, userCfAccount, prefix);
    if (!r2.ok) {
      await failSite(env.DB, siteId, 'kv_create', r2.error);
      return jsonRes({ ok: false, error: r2.error }, 500);
    }
    kvId = r2.id;
    await updateSite(env.DB, siteId, { site_kv_id: kvId, site_kv_title: r2.title });
    console.log('[provision] 사이트 전용 KV 생성 완료 id=' + kvId + ' title=' + r2.title);

    await initKVData(userAuth, userCfAccount, kvId, {
      site_id: siteId, site_prefix: prefix, site_name: site.name,
      domain: domain, d1_id: d1Id, status: 'active',
    });
  } else {
    console.log('[provision] 사이트 전용 KV 기존 재사용 id=' + kvId);
  }

  // ── Step 3: 메인 CACHE에 도메인→사이트 매핑 등록 ───────────────
  await updateSite(env.DB, siteId, { provision_step: 'kv_mapping' });
  var mapping = JSON.stringify({
    id: siteId, name: site.name, site_prefix: prefix,
    site_d1_id: d1Id, site_kv_id: kvId,
    wp_admin_url: wpAdminUrl, status: 'active', suspended: 0,
  });
  try {
    await env.CACHE.put('site_domain:' + domain,    mapping);
    await env.CACHE.put('site_domain:' + wwwDomain, mapping);
    await env.CACHE.put('site_prefix:' + prefix,    mapping);
    console.log('[provision] 메인 CACHE 도메인 매핑 등록 완료');
  } catch (e) { console.warn('[provision] CACHE put 실패(무시):', e.message); }

  // ── Step 4: WP 사이트 초기화 ───────────────────────────────────
  await updateSite(env.DB, siteId, { provision_step: 'wp_init' });
  var wpRes = await initWpSite(wpOrigin, wpSecret, {
    site_prefix: prefix,
    site_name:   site.name,
    admin_user:  site.wp_username,
    admin_pass:  site.wp_password,
    admin_email: site.wp_admin_email || user.email,
    site_url:    'https://' + domain,
  });
  console.log('[provision] WP init:', wpRes.skipped ? ('건너뜀: ' + wpRes.message) : wpRes.message);

  // ── Step 5: DNS 설정 (사용자 계정 zone 기준) ───────────────────
  await updateSite(env.DB, siteId, { provision_step: 'dns_setup' });
  var cfZoneId = null, dnsRecordId = null, dnsRecordWwwId = null, domainStatus = 'manual_required';
  var cnameTarget = await getWorkerSubdomain(userAuth, userCfAccount, workerName);
  console.log('[provision] CNAME target:', cnameTarget);

  var zone = await cfGetZone(userAuth, domain);
  if (zone.ok) {
    cfZoneId = zone.zoneId;
    var dnsRoot = await cfUpsertDns(userAuth, cfZoneId, 'CNAME', domain,    cnameTarget, true);
    var dnsWww  = await cfUpsertDns(userAuth, cfZoneId, 'CNAME', wwwDomain, cnameTarget, true);
    if (dnsRoot.ok) dnsRecordId    = dnsRoot.recordId;
    if (dnsWww.ok)  dnsRecordWwwId = dnsWww.recordId;
  } else {
    console.log('[provision] CF Zone 없음 — DNS 수동 설정 필요');
  }

  // ── Step 6: 사이트 전용 Worker 업로드 (사용자 계정) ───────────
  await updateSite(env.DB, siteId, { provision_step: 'worker_upload' });
  console.log('[provision] 사이트 전용 Worker 업로드 시작: ' + workerName);
  console.log('[provision] 바인딩: mainDB=' + mainDbId + ' mainCache=' + cacheKvId + ' siteD1=' + d1Id + ' siteKV=' + kvId);

  var upRes = await uploadWorker(userAuth, userCfAccount, workerName, {
    mainDbId:       mainDbId,
    cacheKvId:      cacheKvId,
    sessionsKvId:   sessionsKvId,
    siteD1Id:       d1Id,
    siteKvId:       kvId,
    wpOriginUrl:    wpOrigin,
    wpOriginSecret: wpSecret,
    cfAccountId:    userCfAccount,
    cfApiKey:       userCfKey,
    sitePrefix:     prefix,
  });

  if (!upRes.ok) {
    await failSite(env.DB, siteId, 'worker_upload', upRes.error);
    return jsonRes({ ok: false, error: 'Worker 업로드 실패: ' + upRes.error }, 500);
  }
  console.log('[provision] 사이트 전용 Worker 업로드 완료:', workerName);
  await updateSite(env.DB, siteId, { worker_name: workerName });

  // ── Step 7: Worker Route 등록 ──────────────────────────────────
  if (zone.ok && cfZoneId) {
    await updateSite(env.DB, siteId, { provision_step: 'worker_route' });
    var rRoot = await cfUpsertRoute(userAuth, cfZoneId, domain + '/*',    workerName);
    var rWww  = await cfUpsertRoute(userAuth, cfZoneId, wwwDomain + '/*', workerName);
    if (rRoot.ok || rWww.ok) {
      domainStatus = 'dns_propagating';
      await updateSite(env.DB, siteId, {
        worker_route:         domain + '/*',
        worker_route_www:     wwwDomain + '/*',
        worker_route_id:      rRoot.routeId || null,
        worker_route_www_id:  rWww.routeId  || null,
        cf_zone_id:           cfZoneId,
        dns_record_id:        dnsRecordId,
        dns_record_www_id:    dnsRecordWwwId,
      });
    }
  }

  // ── Step 8: 완료 ───────────────────────────────────────────────
  var dnsNote = null;
  var cnameInstructions = null;
  if (domainStatus === 'manual_required') {
    dnsNote = '외부 DNS 설정 필요 — CNAME 값: ' + cnameTarget;
    cnameInstructions = {
      type: 'CNAME',
      root: { host: '@',   value: cnameTarget, ttl: 3600 },
      www:  { host: 'www', value: cnameTarget, ttl: 3600 },
      note: '외부 DNS(가비아, 후이즈 등)에서 위 값으로 CNAME 레코드를 추가해주세요.',
    };
  }

  await updateSite(env.DB, siteId, {
    status:         'active',
    provision_step: 'completed',
    domain_status:  domainStatus,
    worker_name:    workerName,
    wp_admin_url:   wpAdminUrl,
    error_message:  dnsNote,
  });

  console.log('[provision] 완료 siteId=' + siteId + ' worker=' + workerName + ' domainStatus=' + domainStatus);

  var finalSite = await env.DB.prepare(
    'SELECT status, provision_step, error_message, wp_admin_url, wp_username, wp_password,'
    + ' primary_domain, site_d1_id, site_kv_id, domain_status, worker_name, name FROM sites WHERE id=?'
  ).bind(siteId).first();

  return ok({
    message:     '프로비저닝 완료',
    siteId:      siteId,
    site:        finalSite,
    worker_name: workerName,
    binding_summary: {
      main_db:    mainDbId  ? '✓ ' + mainDbId  : '✗ 미확보 (수동 확인 필요)',
      main_cache: cacheKvId ? '✓ ' + cacheKvId : '✗ 미확보 (수동 확인 필요)',
      site_d1:    d1Id      ? '✓ ' + d1Id      : '✗ 생성 실패',
      site_kv:    kvId      ? '✓ ' + kvId      : '✗ 생성 실패',
    },
    wp_note:             wpRes.skipped ? wpRes.message : null,
    dns_note:            dnsNote,
    cname_instructions:  cnameInstructions,
  });
}
