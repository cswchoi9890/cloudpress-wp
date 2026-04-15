// functions/api/sites/[id]/provision.js — CloudPress v16.0
//
// [v16.0 완전 재설계 — VP/Origin 방식 전면 폐지]
// ────────────────────────────────────────────────
//  ✅ VP 패널 (HestiaCP/VestaCP/VistaPanel/등) 완전 제거
//  ✅ WP Origin URL 프록시 방식 완전 제거
//  ✅ PHP/WordPress 완전 제거
//
// 새 아키텍처 (GitHub HTTP fetch 방식):
//  1. 사용자 CF 계정에 사이트 전용 D1 생성 (cloudpress-site-{prefix})
//  2. 사용자 CF 계정에 사이트 전용 KV 생성 (cloudpress-site-{prefix}-kv)
//  3. GitHub raw URL로 cloudflare-cms 전체 소스 HTTP fetch
//  4. 가져온 코드를 Workers Script Upload API (multipart)로 업로드
//     - D1/KV 바인딩을 코드 내부에 주입 (metadata bindings)
//     - 직접 파일 업로드 X — 코드 자체를 번들로 업로드
//  5. CF DNS + Worker Route 등록
//  6. 사이트 D1에 CloudPress 스키마 초기화
//  7. CACHE KV에 도메인 매핑 등록
//
// 환경변수 (settings DB):
//   cf_api_token      — 어드민 CF API 토큰
//   cf_account_id     — 어드민 CF Account ID
//   cms_github_repo   — cloudflare-cms 소스 레포 (owner/repo)
//   cms_github_branch — 브랜치 (기본: main)
//   cms_github_token  — GitHub PAT (비공개 레포용, 선택)
//   main_db_id        — 메인 D1 UUID
//   cache_kv_id       — CACHE KV UUID
//   sessions_kv_id    — SESSIONS KV UUID

'use strict';

// ── CORS ────────────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

const _j  = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s, headers: { 'Content-Type': 'application/json', ...CORS },
});
const ok  = (d)      => _j({ ok: true,  ...(d || {}) });
const err = (msg, s) => _j({ ok: false, error: msg }, s || 400);

// ── Cloudflare API ──────────────────────────────────────────────────────────
const CF_API = 'https://api.cloudflare.com/client/v4';

function cfHeaders(apiToken) {
  return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiToken };
}

async function cfReq(token, path, method = 'GET', body) {
  const opts = { method, headers: cfHeaders(token) };
  if (body !== undefined && body !== null) opts.body = JSON.stringify(body);
  try {
    const res  = await fetch(CF_API + path, opts);
    const json = await res.json();
    if (!json.success) {
      console.error(`[cfReq] ${method} ${path} failed:`, JSON.stringify(json.errors || []));
    }
    return json;
  } catch (e) {
    return { success: false, errors: [{ message: e.message }] };
  }
}

function cfErrMsg(json) {
  return (json?.errors || []).map(e => (e.code ? `[${e.code}] ` : '') + (e.message || '')).join('; ') || 'unknown';
}

// ── Auth ────────────────────────────────────────────────────────────────────
function getToken(req) {
  const a = req.headers.get('Authorization') || '';
  if (a.startsWith('Bearer ')) return a.slice(7);
  const c = req.headers.get('Cookie') || '';
  const m = c.match(/cp_session=([^;]+)/);
  return m ? m[1] : null;
}

async function getUser(env, req) {
  try {
    if (!env?.SESSIONS || !env?.DB) return null;
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
    return (r?.value != null && r.value !== '') ? r.value : fallback;
  } catch { return fallback; }
}

async function updateSite(DB, siteId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map(k => k + '=?');
  const vals = [...keys.map(k => fields[k]), siteId];
  try {
    await DB.prepare(
      `UPDATE sites SET ${sets.join(', ')}, updated_at=datetime('now') WHERE id=?`
    ).bind(...vals).run();
  } catch (e) { console.error('updateSite err:', e.message); }
}

async function failSite(DB, siteId, step, message) {
  console.error(`[FAIL] ${step}: ${message}`);
  try {
    await DB.prepare(
      "UPDATE sites SET status='failed', provision_step=?, error_message=?, updated_at=datetime('now') WHERE id=?"
    ).bind(step, String(message).slice(0, 500), siteId).run();
  } catch (e) { console.error('failSite err:', e.message); }
}

function randSuffix(len = 6) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function deobfuscate(str, salt) {
  if (!str) return '';
  try {
    const key = salt || 'cp_enc_v1';
    const dec = atob(str);
    let out = '';
    for (let i = 0; i < dec.length; i++) {
      out += String.fromCharCode(dec.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return out;
  } catch { return ''; }
}

// ── CF 리소스 생성 ──────────────────────────────────────────────────────────

async function createD1(token, accountId, prefix) {
  const name = `cloudpress-site-${prefix}-${Date.now().toString(36)}`;
  const res  = await cfReq(token, `/accounts/${accountId}/d1/database`, 'POST', { name });
  if (res.success && res.result) {
    const id = res.result.uuid || res.result.id || res.result.database_id;
    if (id) return { ok: true, id, name };
  }
  return { ok: false, error: 'D1 생성 실패: ' + cfErrMsg(res) };
}

async function createKV(token, accountId, prefix) {
  const title = `cloudpress-site-${prefix}-kv`;
  const res   = await cfReq(token, `/accounts/${accountId}/storage/kv/namespaces`, 'POST', { title });
  if (res.success && res.result?.id) {
    return { ok: true, id: res.result.id, title };
  }
  return { ok: false, error: 'KV 생성 실패: ' + cfErrMsg(res) };
}

// ── 사이트 D1 스키마 초기화 (Workers D1 API) ────────────────────────────────
// cloudflare-cms의 schema.sql을 HTTP로 fetch 후 D1 API로 실행

async function initSiteD1Schema(token, accountId, d1Id, githubRepo, githubBranch, githubToken) {
  // GitHub에서 schema.sql fetch
  const branch = githubBranch || 'main';
  const rawUrl = `https://raw.githubusercontent.com/${githubRepo}/${branch}/schema.sql`;

  let schemaSql = '';
  try {
    const headers = { 'User-Agent': 'CloudPress/16.0' };
    if (githubToken) headers['Authorization'] = `Bearer ${githubToken}`;
    const res = await fetch(rawUrl, { headers });
    if (res.ok) {
      schemaSql = await res.text();
    } else {
      console.warn('[provision] schema.sql fetch 실패 — 내장 최소 스키마 사용');
    }
  } catch (e) {
    console.warn('[provision] schema.sql fetch 오류:', e.message);
  }

  // fetch 실패 시 최소 내장 스키마 사용
  if (!schemaSql.trim()) {
    schemaSql = getMinimalSchema();
  }

  // D1 SQL 실행 API — 세미콜론으로 분리해 각 구문 개별 실행
  // (D1은 단일 세미콜론 분리 구문 지원)
  const res = await cfReq(token, `/accounts/${accountId}/d1/database/${d1Id}/query`, 'POST', {
    sql: schemaSql,
  });

  if (!res.success) {
    // 일부 CREATE INDEX IF NOT EXISTS 실패는 무시
    const errors = (res.errors || []).filter(e => !String(e.message).includes('already exists'));
    if (errors.length > 0) {
      console.warn('[provision] D1 스키마 일부 오류(무시):', JSON.stringify(errors));
    }
  }

  return { ok: true };
}

// KV 초기값 설정
async function initKVData(token, accountId, kvId, entries) {
  for (const [key, value] of Object.entries(entries)) {
    await cfReq(
      token,
      `/accounts/${accountId}/storage/kv/namespaces/${kvId}/values/${encodeURIComponent(key)}`,
      'PUT',
      null
    ).catch(() => {});

    // KV PUT은 form/text body
    try {
      await fetch(
        `${CF_API}/accounts/${accountId}/storage/kv/namespaces/${kvId}/values/${encodeURIComponent(key)}`,
        {
          method:  'PUT',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'text/plain' },
          body:    value,
        }
      );
    } catch (e) { console.warn('[provision] KV put 오류:', key, e.message); }
  }
}

// ── GitHub에서 cloudflare-cms 소스 파일 목록 조회 ──────────────────────────

const CMS_FILES = [
  'index.js',
  'cp-router.js',
  'cp-blog-header.js',
  'cp-load.js',
  'cp-settings.js',
  'cp-config.js',
  'cp-activate.js',
  'cp-comments-post.js',
  'cp-cron.js',
  'cp-links-opml.js',
  'cp-mail.js',
  'cp-signup.js',
  'cp-trackback.js',
  'cp-admin/index.js',
  'cp-admin/admin-shell.js',
  'cp-admin/ajax.js',
  'cp-admin/auth-check.js',
  'cp-admin/github-sync.js',
  'cp-admin/installer.js',
  'cp-admin/pages/index.js',
  'cp-admin/pages/dashboard.js',
  'cp-admin/pages/posts.js',
  'cp-admin/pages/post-edit.js',
  'cp-admin/pages/pages.js',
  'cp-admin/pages/comments.js',
  'cp-admin/pages/media.js',
  'cp-admin/pages/themes.js',
  'cp-admin/pages/plugins.js',
  'cp-admin/pages/users.js',
  'cp-admin/pages/user-edit.js',
  'cp-admin/pages/profile.js',
  'cp-admin/pages/options.js',
  'cp-admin/pages/options-general.js',
  'cp-admin/pages/options-writing.js',
  'cp-admin/pages/options-reading.js',
  'cp-admin/pages/options-discussion.js',
  'cp-admin/pages/options-media.js',
  'cp-admin/pages/options-permalink.js',
  'cp-admin/pages/tools.js',
  'cp-admin/pages/import.js',
  'cp-admin/pages/export.js',
  'cp-admin/pages/upgrade.js',
  'cp-includes/auth.js',
  'cp-includes/bookmark.js',
  'cp-includes/category.js',
  'cp-includes/comment.js',
  'cp-includes/crypto.js',
  'cp-includes/feed.js',
  'cp-includes/formatting.js',
  'cp-includes/functions.js',
  'cp-includes/hooks.js',
  'cp-includes/jwt.js',
  'cp-includes/link-template.js',
  'cp-includes/mail.js',
  'cp-includes/media-handler.js',
  'cp-includes/ms-functions.js',
  'cp-includes/option.js',
  'cp-includes/plugin-loader.js',
  'cp-includes/post.js',
  'cp-includes/query.js',
  'cp-includes/sanitize.js',
  'cp-includes/session.js',
  'cp-includes/sitemap.js',
  'cp-includes/template-loader.js',
  'cp-includes/theme-loader.js',
  'cp-includes/transient.js',
  'cp-includes/user.js',
];

/**
 * GitHub raw URL에서 모든 CMS 소스 파일을 병렬 fetch.
 * 반환: { path → content } Map
 */
async function fetchCMSSource(githubRepo, githubBranch, githubToken) {
  const branch  = githubBranch || 'main';
  const baseUrl = `https://raw.githubusercontent.com/${githubRepo}/${branch}`;
  const headers = { 'User-Agent': 'CloudPress/16.0' };
  if (githubToken) headers['Authorization'] = `Bearer ${githubToken}`;

  const results = await Promise.all(
    CMS_FILES.map(async (filePath) => {
      try {
        const res = await fetch(`${baseUrl}/${filePath}`, { headers });
        if (!res.ok) {
          console.warn(`[provision] GitHub fetch 실패: ${filePath} (${res.status})`);
          return [filePath, null];
        }
        const text = await res.text();
        return [filePath, text];
      } catch (e) {
        console.warn(`[provision] GitHub fetch 오류: ${filePath}`, e.message);
        return [filePath, null];
      }
    })
  );

  const map = new Map();
  for (const [path, content] of results) {
    if (content !== null) map.set(path, content);
  }
  return map;
}

// ── Workers Script Upload API (multipart/form-data) ─────────────────────────
//
// 업로드 방식: Workers Script Upload API (PUT /accounts/{id}/workers/scripts/{name})
//   - Content-Type: multipart/form-data
//   - Part 1: "metadata"  → JSON (bindings, compatibility_date, main_module)
//   - Part 2+: 각 JS 파일 (name = 파일 경로, filename = 파일 경로)
//
// 직접 파일 업로드가 아닌, GitHub에서 가져온 코드를 번들로 Workers API에 업로드.

async function uploadWorkerWithCMSSource(token, accountId, workerName, opts, cmsSourceMap) {
  const {
    mainDbId,
    cacheKvId,
    sessionsKvId,
    siteD1Id,
    siteKvId,
    cfAccountId,
    cfApiToken,
    sitePrefix,
    siteName,
    siteDomain,
  } = opts;

  // ── 바인딩 정의 ───────────────────────────────────────────────────────────
  const bindings = [];

  // 메인 D1 (cloudpress 메인 DB — 사용자/사이트 목록)
  if (mainDbId)     bindings.push({ type: 'd1',          name: 'CP_MAIN_DB',  id: mainDbId });
  // 캐시 KV
  if (cacheKvId)    bindings.push({ type: 'kv_namespace', name: 'CACHE',      namespace_id: cacheKvId });
  // 세션 KV
  if (sessionsKvId) bindings.push({ type: 'kv_namespace', name: 'SESSIONS',   namespace_id: sessionsKvId });
  // 사이트 전용 D1
  if (siteD1Id)     bindings.push({ type: 'd1',          name: 'CP_DB',       id: siteD1Id });
  // 사이트 전용 KV
  if (siteKvId)     bindings.push({ type: 'kv_namespace', name: 'CP_KV',      namespace_id: siteKvId });

  // 환경 변수 (plain_text)
  bindings.push({ type: 'plain_text', name: 'CP_SITE_NAME',    text: siteName    || '' });
  bindings.push({ type: 'plain_text', name: 'CP_SITE_URL',     text: 'https://' + (siteDomain || '') });
  bindings.push({ type: 'plain_text', name: 'CF_ACCOUNT_ID',   text: cfAccountId || '' });
  bindings.push({ type: 'plain_text', name: 'SITE_PREFIX',     text: sitePrefix  || '' });

  // CF API 토큰은 secret으로 처리 (secret_text binding)
  if (cfApiToken) {
    bindings.push({ type: 'secret_text', name: 'CF_API_TOKEN', text: cfApiToken });
  }

  // ── 메타데이터 ────────────────────────────────────────────────────────────
  const metadata = {
    main_module:        'index.js',
    compatibility_date: '2024-09-23',
    compatibility_flags: ['nodejs_compat'],
    bindings,
  };

  // ── Multipart 본문 조립 ───────────────────────────────────────────────────
  const boundary = '----CPUpload' + Date.now().toString(36) + randSuffix(4);
  const enc      = new TextEncoder();
  const CRLF     = '\r\n';
  const parts    = [];

  // Part 1: metadata JSON
  parts.push(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="metadata"${CRLF}` +
    `Content-Type: application/json${CRLF}${CRLF}` +
    JSON.stringify(metadata) + CRLF
  );

  // Part 2+: 각 JS 소스 파일
  for (const [filePath, content] of cmsSourceMap) {
    parts.push(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="${filePath}"; filename="${filePath}"${CRLF}` +
      `Content-Type: application/javascript+module${CRLF}${CRLF}` +
      content + CRLF
    );
  }

  parts.push(`--${boundary}--${CRLF}`);

  // Uint8Array로 직렬화
  const chunks = parts.map(p => enc.encode(p));
  const total  = chunks.reduce((s, c) => s + c.length, 0);
  const body   = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { body.set(c, off); off += c.length; }

  // ── Workers Script Upload API 호출 ────────────────────────────────────────
  try {
    const res  = await fetch(
      `${CF_API}/accounts/${accountId}/workers/scripts/${workerName}`,
      {
        method:  'PUT',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type':  `multipart/form-data; boundary=${boundary}`,
        },
        body: body.buffer,
      }
    );
    const json = await res.json();
    if (!json.success) {
      return { ok: false, error: 'Worker 업로드 실패: ' + cfErrMsg(json) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Worker 업로드 오류: ' + e.message };
  }
}

// ── CF DNS / Route 유틸리티 ─────────────────────────────────────────────────

async function cfGetZone(token, domain) {
  // 루트 도메인으로 존 조회
  const root = domain.split('.').slice(-2).join('.');
  const res  = await cfReq(token, `/zones?name=${encodeURIComponent(root)}&status=active`);
  if (res.success && res.result?.length > 0) {
    return { ok: true, zoneId: res.result[0].id };
  }
  return { ok: false, error: '존 없음: ' + root };
}

async function cfUpsertDns(token, zoneId, type, name, content, proxied = true) {
  // 기존 레코드 조회
  const list = await cfReq(token, `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}`);
  const existing = list.result?.[0];

  if (existing) {
    const res = await cfReq(token, `/zones/${zoneId}/dns_records/${existing.id}`, 'PATCH', { content, proxied });
    return { ok: res.success, recordId: existing.id };
  }
  const res = await cfReq(token, `/zones/${zoneId}/dns_records`, 'POST', { type, name, content, proxied, ttl: 1 });
  if (res.success) return { ok: true, recordId: res.result?.id };
  return { ok: false, error: cfErrMsg(res) };
}

async function cfUpsertRoute(token, zoneId, pattern, workerName) {
  const list = await cfReq(token, `/zones/${zoneId}/workers/routes`);
  const existing = (list.result || []).find(r => r.pattern === pattern);
  if (existing) {
    const res = await cfReq(token, `/zones/${zoneId}/workers/routes/${existing.id}`, 'PUT', { pattern, script: workerName });
    return { ok: res.success, routeId: existing.id };
  }
  const res = await cfReq(token, `/zones/${zoneId}/workers/routes`, 'POST', { pattern, script: workerName });
  if (res.success) return { ok: true, routeId: res.result?.id };
  return { ok: false, error: cfErrMsg(res) };
}

async function getWorkerSubdomain(token, accountId, workerName) {
  // workers.dev 서브도메인 확인
  const res = await cfReq(token, `/accounts/${accountId}/workers/subdomain`);
  if (res.success && res.result?.subdomain) {
    return `${workerName}.${res.result.subdomain}.workers.dev`;
  }
  return `${workerName}.workers.dev`;
}

// workers.dev route 활성화
async function enableWorkersDev(token, accountId, workerName) {
  const res = await cfReq(
    token,
    `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
    'POST',
    { enabled: true }
  );
  return res.success;
}

// ── 메인 핸들러 ─────────────────────────────────────────────────────────────
export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequestPost({ request, env, params }) {
  const user = await getUser(env, request);
  if (!user) return err('로그인이 필요합니다.', 401);

  const siteId = params?.id;
  if (!siteId) return err('사이트 ID가 없습니다.', 400);

  // ── 사이트 조회 ────────────────────────────────────────────────────────────
  let site;
  try {
    site = await env.DB.prepare(
      'SELECT s.id, s.user_id, s.name, s.primary_domain, s.site_prefix,'
      + ' s.status, s.provision_step, s.plan,'
      + ' s.site_d1_id, s.site_kv_id,'
      + ' u.cf_global_api_key, u.cf_account_email, u.cf_account_id'
      + ' FROM sites s JOIN users u ON u.id = s.user_id'
      + ' WHERE s.id=? AND s.user_id=?'
    ).bind(siteId, user.id).first();
  } catch (e) { return err('사이트 조회 오류: ' + e.message, 500); }

  if (!site) return err('사이트를 찾을 수 없습니다.', 404);
  if (site.status === 'active') return ok({ message: '이미 완료된 사이트입니다.' });

  await updateSite(env.DB, siteId, {
    status: 'provisioning', provision_step: 'starting', error_message: null,
  });

  const encKey = env?.ENCRYPTION_KEY || 'cp_enc_default';

  // ── CF 인증 키 결정 ────────────────────────────────────────────────────────
  // 우선순위: 사용자 CF 키 > 어드민 CF 키
  const adminCfToken   = await getSetting(env, 'cf_api_token');
  const adminCfAccount = await getSetting(env, 'cf_account_id');

  let cfToken   = null;
  let cfAccount = null;

  if (site.cf_global_api_key && site.cf_account_id) {
    const raw = deobfuscate(site.cf_global_api_key, encKey);
    cfToken   = (raw && raw.length > 5) ? raw : site.cf_global_api_key;
    cfAccount = site.cf_account_id;
  }

  // 사용자 키 없으면 어드민 키 사용
  if (!cfToken || !cfAccount) {
    cfToken   = adminCfToken;
    cfAccount = adminCfAccount;
  }

  if (!cfToken || !cfAccount) {
    const e = 'Cloudflare API 키가 설정되지 않았습니다. 계정 설정에서 CF Global API Key와 Account ID를 입력해주세요.';
    await failSite(env.DB, siteId, 'config_missing', e);
    return err(e, 400);
  }

  // ── GitHub CMS 소스 설정 ──────────────────────────────────────────────────
  const githubRepo   = await getSetting(env, 'cms_github_repo',   '');
  const githubBranch = await getSetting(env, 'cms_github_branch', 'main');
  const githubToken  = await getSetting(env, 'cms_github_token',  '');

  if (!githubRepo) {
    const e = 'CMS GitHub 레포가 설정되지 않았습니다. 어드민 설정에서 cms_github_repo를 입력해주세요.';
    await failSite(env.DB, siteId, 'config_missing', e);
    return err(e, 400);
  }

  const domain    = site.primary_domain;
  const wwwDomain = 'www.' + domain;
  const prefix    = site.site_prefix;
  const workerName = 'cloudpress-site-' + prefix;

  // ── Step 1: GitHub에서 CMS 소스 fetch ────────────────────────────────────
  await updateSite(env.DB, siteId, { provision_step: 'github_fetch' });
  console.log(`[provision] GitHub fetch 시작: ${githubRepo}@${githubBranch}`);

  const cmsSourceMap = await fetchCMSSource(githubRepo, githubBranch, githubToken);

  if (cmsSourceMap.size === 0) {
    const e = `GitHub 레포(${githubRepo})에서 CMS 소스를 가져오지 못했습니다. 레포 주소와 토큰을 확인해주세요.`;
    await failSite(env.DB, siteId, 'github_fetch', e);
    return err(e, 500);
  }

  // 필수 파일 확인
  if (!cmsSourceMap.has('index.js')) {
    const e = 'GitHub 레포에서 index.js를 찾을 수 없습니다. cms_github_repo 설정을 확인해주세요.';
    await failSite(env.DB, siteId, 'github_fetch', e);
    return err(e, 500);
  }

  console.log(`[provision] GitHub fetch 완료: ${cmsSourceMap.size}개 파일`);

  // ── Step 2: 사이트 전용 D1 생성 ──────────────────────────────────────────
  await updateSite(env.DB, siteId, { provision_step: 'd1_create' });

  let d1Id = site.site_d1_id || null;
  if (!d1Id) {
    const r = await createD1(cfToken, cfAccount, prefix);
    if (!r.ok) {
      await failSite(env.DB, siteId, 'd1_create', r.error);
      return err(r.error, 500);
    }
    d1Id = r.id;
    await updateSite(env.DB, siteId, { site_d1_id: d1Id, site_d1_name: r.name });
    console.log(`[provision] D1 생성 완료: ${r.name} (${d1Id})`);
  } else {
    console.log(`[provision] D1 재사용: ${d1Id}`);
  }

  // ── Step 3: 사이트 전용 KV 생성 ──────────────────────────────────────────
  await updateSite(env.DB, siteId, { provision_step: 'kv_create' });

  let kvId = site.site_kv_id || null;
  if (!kvId) {
    const r = await createKV(cfToken, cfAccount, prefix);
    if (!r.ok) {
      await failSite(env.DB, siteId, 'kv_create', r.error);
      return err(r.error, 500);
    }
    kvId = r.id;
    await updateSite(env.DB, siteId, { site_kv_id: kvId, site_kv_title: r.title });
    console.log(`[provision] KV 생성 완료: ${r.title} (${kvId})`);
  } else {
    console.log(`[provision] KV 재사용: ${kvId}`);
  }

  // ── Step 4: 사이트 D1 스키마 초기화 ──────────────────────────────────────
  await updateSite(env.DB, siteId, { provision_step: 'd1_schema' });
  console.log('[provision] D1 스키마 초기화 중...');

  const schemaRes = await initSiteD1Schema(
    cfToken, cfAccount, d1Id, githubRepo, githubBranch, githubToken
  );
  if (!schemaRes.ok) {
    // 스키마 실패는 치명적이지 않음 — 계속 진행 (인스톨러에서 재실행 가능)
    console.warn('[provision] D1 스키마 초기화 부분 실패 (계속 진행)');
  } else {
    console.log('[provision] D1 스키마 초기화 완료');
  }

  // ── Step 5: 메인 바인딩 ID 확보 ──────────────────────────────────────────
  let mainDbId     = await getSetting(env, 'main_db_id',     '');
  let cacheKvId    = await getSetting(env, 'cache_kv_id',    '');
  let sessionsKvId = await getSetting(env, 'sessions_kv_id', '');

  // 설정에 없으면 Pages 프로젝트에서 자동 탐색
  if (!mainDbId || !cacheKvId || !sessionsKvId) {
    const ids = await resolveMainBindingIds(cfToken, cfAccount, env.DB);
    if (!mainDbId)     mainDbId     = ids.mainDbId     || '';
    if (!cacheKvId)    cacheKvId    = ids.cacheKvId    || '';
    if (!sessionsKvId) sessionsKvId = ids.sessionsKvId || '';
  }

  // ── Step 6: Workers Script Upload API — CMS 코드 업로드 ──────────────────
  await updateSite(env.DB, siteId, { provision_step: 'worker_upload' });
  console.log(`[provision] Worker 업로드 중: ${workerName}`);

  const upRes = await uploadWorkerWithCMSSource(
    cfToken,
    cfAccount,
    workerName,
    {
      mainDbId,
      cacheKvId,
      sessionsKvId,
      siteD1Id:    d1Id,
      siteKvId:    kvId,
      cfAccountId: cfAccount,
      cfApiToken:  cfToken,
      sitePrefix:  prefix,
      siteName:    site.name,
      siteDomain:  domain,
    },
    cmsSourceMap
  );

  if (!upRes.ok) {
    await failSite(env.DB, siteId, 'worker_upload', upRes.error);
    return err('Worker 업로드 실패: ' + upRes.error, 500);
  }
  console.log(`[provision] Worker 업로드 완료: ${workerName}`);
  await updateSite(env.DB, siteId, { worker_name: workerName });

  // workers.dev 활성화
  await enableWorkersDev(cfToken, cfAccount, workerName);

  // ── Step 7: CACHE KV 도메인 매핑 등록 ────────────────────────────────────
  await updateSite(env.DB, siteId, { provision_step: 'kv_mapping' });

  const siteMapping = JSON.stringify({
    id:          siteId,
    name:        site.name,
    site_prefix: prefix,
    site_d1_id:  d1Id,
    site_kv_id:  kvId,
    status:      'active',
    suspended:   0,
  });

  if (cacheKvId && cfToken && cfAccount) {
    for (const key of [`site_domain:${domain}`, `site_domain:${wwwDomain}`, `site_prefix:${prefix}`]) {
      try {
        await fetch(
          `${CF_API}/accounts/${cfAccount}/storage/kv/namespaces/${cacheKvId}/values/${encodeURIComponent(key)}`,
          {
            method:  'PUT',
            headers: { 'Authorization': 'Bearer ' + cfToken, 'Content-Type': 'text/plain' },
            body:    siteMapping,
          }
        );
      } catch (e) { console.warn('[provision] CACHE KV put 실패:', key, e.message); }
    }
  }

  // ── Step 8: DNS + Worker Route 등록 ──────────────────────────────────────
  await updateSite(env.DB, siteId, { provision_step: 'dns_setup' });

  const cnameTarget = await getWorkerSubdomain(cfToken, cfAccount, workerName);
  let domainStatus   = 'manual_required';
  let cfZoneId       = null;
  let dnsRecordId    = null, dnsRecordWwwId = null;

  const zone = await cfGetZone(cfToken, domain);
  if (zone.ok) {
    cfZoneId = zone.zoneId;
    const dr  = await cfUpsertDns(cfToken, cfZoneId, 'CNAME', domain,    cnameTarget, true);
    const drw = await cfUpsertDns(cfToken, cfZoneId, 'CNAME', wwwDomain, cnameTarget, true);
    if (dr.ok)  dnsRecordId    = dr.recordId;
    if (drw.ok) dnsRecordWwwId = drw.recordId;

    await updateSite(env.DB, siteId, { provision_step: 'worker_route' });
    const rr = await cfUpsertRoute(cfToken, cfZoneId, domain + '/*',    workerName);
    const rw = await cfUpsertRoute(cfToken, cfZoneId, wwwDomain + '/*', workerName);
    if (rr.ok || rw.ok) domainStatus = 'dns_propagating';

    await updateSite(env.DB, siteId, {
      worker_route:        domain + '/*',
      worker_route_www:    wwwDomain + '/*',
      worker_route_id:     rr.routeId || null,
      worker_route_www_id: rw.routeId || null,
      cf_zone_id:          cfZoneId,
      dns_record_id:       dnsRecordId,
      dns_record_www_id:   dnsRecordWwwId,
    });
  }

  // ── Step 9: 완료 ──────────────────────────────────────────────────────────
  const adminUrl = `https://${domain}/cp-admin/setup-config`;

  await updateSite(env.DB, siteId, {
    status:         'active',
    provision_step: 'completed',
    domain_status:  domainStatus,
    wp_admin_url:   adminUrl,
    error_message:  domainStatus === 'manual_required'
      ? `외부 DNS 설정 필요 — CNAME: ${cnameTarget}`
      : null,
  });

  const finalSite = await env.DB.prepare(
    'SELECT status, provision_step, error_message, wp_admin_url, primary_domain,'
    + ' site_d1_id, site_kv_id, domain_status, worker_name, name FROM sites WHERE id=?'
  ).bind(siteId).first();

  return ok({
    message:      '프로비저닝 완료',
    siteId,
    site:         finalSite,
    worker_name:  workerName,
    cname_target: cnameTarget,
    cms_files:    cmsSourceMap.size,
    setup_url:    adminUrl,
    cname_instructions: domainStatus === 'manual_required' ? {
      type: 'CNAME',
      root: { host: '@',   value: cnameTarget },
      www:  { host: 'www', value: cnameTarget },
      note: `DNS 전파 후 ${adminUrl} 에서 CMS 설정을 완료하세요.`,
    } : null,
  });
}

// ── 메인 바인딩 ID 자동 탐색 ────────────────────────────────────────────────
// settings DB에 없을 경우 Workers 환경에서 바인딩 UUID를 직접 추출 시도

async function resolveMainBindingIds(token, accountId, DB) {
  const result = { mainDbId: '', cacheKvId: '', sessionsKvId: '' };

  try {
    // Pages 프로젝트 목록에서 cloudpress 관련 프로젝트 탐색
    const pagesRes = await cfReq(token, `/accounts/${accountId}/pages/projects`);
    if (!pagesRes.success) return result;

    const project = (pagesRes.result || []).find(p =>
      p.name?.toLowerCase().includes('cloudpress') ||
      p.name?.toLowerCase().includes('cp-')
    );
    if (!project) return result;

    const projRes = await cfReq(token, `/accounts/${accountId}/pages/projects/${project.name}`);
    if (!projRes.success) return result;

    const bindings = projRes.result?.deployment_configs?.production?.d1_databases || {};
    const kvBindings = projRes.result?.deployment_configs?.production?.kv_namespaces || {};

    // D1: DB 바인딩 탐색
    for (const [name, val] of Object.entries(bindings)) {
      const id = val?.id || val?.database_id || '';
      if (!id) continue;
      if (name === 'DB' || name === 'MAIN_DB') result.mainDbId = id;
    }

    // KV: CACHE / SESSIONS 바인딩 탐색
    for (const [name, val] of Object.entries(kvBindings)) {
      const id = val?.namespace_id || val?.id || '';
      if (!id) continue;
      if (name === 'CACHE') result.cacheKvId    = id;
      if (name === 'SESSIONS') result.sessionsKvId = id;
    }

    // DB에도 저장
    if (result.mainDbId)     await DB.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('main_db_id',?,datetime('now'))").bind(result.mainDbId).run().catch(()=>{});
    if (result.cacheKvId)    await DB.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('cache_kv_id',?,datetime('now'))").bind(result.cacheKvId).run().catch(()=>{});
    if (result.sessionsKvId) await DB.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('sessions_kv_id',?,datetime('now'))").bind(result.sessionsKvId).run().catch(()=>{});

  } catch (e) {
    console.warn('[provision] 바인딩 ID 자동 탐색 실패:', e.message);
  }

  return result;
}

// ── 최소 내장 스키마 (GitHub fetch 실패 시 fallback) ────────────────────────

function getMinimalSchema() {
  return `
CREATE TABLE IF NOT EXISTS cp_posts (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  post_author INTEGER NOT NULL DEFAULT 0,
  post_date TEXT NOT NULL DEFAULT '',
  post_date_gmt TEXT NOT NULL DEFAULT '',
  post_content TEXT NOT NULL DEFAULT '',
  post_title TEXT NOT NULL DEFAULT '',
  post_excerpt TEXT NOT NULL DEFAULT '',
  post_status TEXT NOT NULL DEFAULT 'publish',
  comment_status TEXT NOT NULL DEFAULT 'open',
  ping_status TEXT NOT NULL DEFAULT 'open',
  post_password TEXT NOT NULL DEFAULT '',
  post_name TEXT NOT NULL DEFAULT '',
  to_ping TEXT NOT NULL DEFAULT '',
  pinged TEXT NOT NULL DEFAULT '',
  post_modified TEXT NOT NULL DEFAULT '',
  post_modified_gmt TEXT NOT NULL DEFAULT '',
  post_content_filtered TEXT NOT NULL DEFAULT '',
  post_parent INTEGER NOT NULL DEFAULT 0,
  guid TEXT NOT NULL DEFAULT '',
  menu_order INTEGER NOT NULL DEFAULT 0,
  post_type TEXT NOT NULL DEFAULT 'post',
  post_mime_type TEXT NOT NULL DEFAULT '',
  comment_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cp_postmeta (
  meta_id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL DEFAULT 0,
  meta_key TEXT DEFAULT NULL,
  meta_value TEXT
);
CREATE TABLE IF NOT EXISTS cp_users (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  user_login TEXT NOT NULL DEFAULT '',
  user_pass TEXT NOT NULL DEFAULT '',
  user_nicename TEXT NOT NULL DEFAULT '',
  user_email TEXT NOT NULL DEFAULT '',
  user_url TEXT NOT NULL DEFAULT '',
  user_registered TEXT NOT NULL DEFAULT '',
  user_activation_key TEXT NOT NULL DEFAULT '',
  user_status INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS cp_usermeta (
  umeta_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,
  meta_key TEXT DEFAULT NULL,
  meta_value TEXT
);
CREATE TABLE IF NOT EXISTS cp_options (
  option_id INTEGER PRIMARY KEY AUTOINCREMENT,
  option_name TEXT NOT NULL DEFAULT '',
  option_value TEXT NOT NULL DEFAULT '',
  autoload TEXT NOT NULL DEFAULT 'yes',
  UNIQUE(option_name)
);
CREATE TABLE IF NOT EXISTS cp_terms (
  term_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL DEFAULT '',
  term_group INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cp_term_taxonomy (
  term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id INTEGER NOT NULL DEFAULT 0,
  taxonomy TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  parent INTEGER NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cp_term_relationships (
  object_id INTEGER NOT NULL DEFAULT 0,
  term_taxonomy_id INTEGER NOT NULL DEFAULT 0,
  term_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (object_id, term_taxonomy_id)
);
CREATE TABLE IF NOT EXISTS cp_comments (
  comment_ID INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_post_ID INTEGER NOT NULL DEFAULT 0,
  comment_author TEXT NOT NULL DEFAULT '',
  comment_author_email TEXT NOT NULL DEFAULT '',
  comment_author_url TEXT NOT NULL DEFAULT '',
  comment_author_IP TEXT NOT NULL DEFAULT '',
  comment_date TEXT NOT NULL DEFAULT '',
  comment_date_gmt TEXT NOT NULL DEFAULT '',
  comment_content TEXT NOT NULL DEFAULT '',
  comment_karma INTEGER NOT NULL DEFAULT 0,
  comment_approved TEXT NOT NULL DEFAULT '1',
  comment_agent TEXT NOT NULL DEFAULT '',
  comment_type TEXT NOT NULL DEFAULT 'comment',
  comment_parent INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cp_commentmeta (
  meta_id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL DEFAULT 0,
  meta_key TEXT DEFAULT NULL,
  meta_value TEXT
);
CREATE TABLE IF NOT EXISTS cp_media (
  media_id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_size INTEGER NOT NULL DEFAULT 0,
  upload_date TEXT NOT NULL DEFAULT '',
  storage TEXT NOT NULL DEFAULT 'kv',
  alt_text TEXT DEFAULT '',
  caption TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS cp_cron_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  schedule TEXT,
  hook TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS cp_posts_post_name ON cp_posts(post_name);
CREATE INDEX IF NOT EXISTS cp_posts_type_status ON cp_posts(post_type, post_status);
CREATE INDEX IF NOT EXISTS cp_postmeta_post_id ON cp_postmeta(post_id);
CREATE INDEX IF NOT EXISTS cp_users_login ON cp_users(user_login);
CREATE INDEX IF NOT EXISTS cp_usermeta_user_id ON cp_usermeta(user_id);
CREATE INDEX IF NOT EXISTS cp_comments_post_id ON cp_comments(comment_post_ID);
CREATE INDEX IF NOT EXISTS cp_cron_ts ON cp_cron_events(timestamp);
`.trim();
}
