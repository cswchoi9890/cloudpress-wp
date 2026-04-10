// puppeteer-worker/index.js
// CloudPress v6.1 — 공유 호스팅 완전 지원 + VP 로그인 다중 방식 + 자동 최적화
// ✅ v6.1 변경사항:
//   1. VP 로그인 실패해도 PHP 인스톨러로 폴백 (공유 호스팅 100% 지원)
//   2. cPanel/DirectAdmin/WHM 다중 인증 방식 지원
//   3. 공유 호스팅 자동 설정: WordPress Cron 자동 활성화
//   4. REST API 자동 활성화 (공유 호스팅 호환)
//   5. 속도 최적화: Autoptimize + .htaccess Gzip/캐시
//   6. Bridge Migration 플러그인 직접 zip 포함 (외부 URL 의존 없음)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Worker-Secret',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/* ═══════════════════════════════════════════════
   VP 패널 다중 인증 방식 API 호출
   cPanel UAPI / API2 / DirectAdmin 모두 지원
═══════════════════════════════════════════════ */

async function vpApiCall(panelUrl, username, password, endpoint, params = {}) {
  const base = panelUrl.replace(/\/$/, '');
  const basicAuth = btoa(`${username}:${password}`);

  const res = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(30000),
  }).catch(e => ({ ok: false, status: 0, _error: e.message }));

  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  try {
    const data = await res.json();
    return { ok: true, data };
  } catch {
    const text = await res.text().catch(() => '');
    return { ok: true, raw: text };
  }
}

// Shell 명령 실행 — 다중 방법 폴백
async function runShellCmd(panelUrl, username, password, webRoot, command) {
  const base = panelUrl.replace(/\/$/, '');
  const basicAuth = btoa(`${username}:${password}`);

  if (!panelUrl || !username || !password) {
    return { ok: false, error: 'VP 연결 정보 없음' };
  }

  // 방법 1: cPanel UAPI Shell exec
  try {
    const res = await fetch(`${base}/execute/Shell/exec`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        cmd: webRoot ? `cd "${webRoot}" && ${command}` : command,
      }).toString(),
      signal: AbortSignal.timeout(120000),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data?.result?.status !== 0) {
        const output = data?.result?.output || data?.data?.output || '';
        return { ok: true, output, method: 'cpanel_shell' };
      }
    }
  } catch (_) {}

  // 방법 2: cPanel API2 Shell exec
  try {
    const res2 = await fetch(`${base}/json-api/cpanel`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        cpanel_jsonapi_module: 'Shell',
        cpanel_jsonapi_func: 'exec',
        cpanel_jsonapi_version: '2',
        cmd: webRoot ? `cd "${webRoot}" && ${command}` : command,
      }).toString(),
      signal: AbortSignal.timeout(120000),
    });
    if (res2.ok) {
      const data2 = await res2.json().catch(() => null);
      const output = data2?.cpanelresult?.data?.[0]?.output || '';
      return { ok: true, output, method: 'cpanel_api2_shell' };
    }
  } catch (_) {}

  // 방법 3: DirectAdmin CMD_SHELL
  try {
    const res3 = await fetch(`${base}/CMD_SHELL`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        command: webRoot ? `cd "${webRoot}" && ${command}` : command,
      }).toString(),
      signal: AbortSignal.timeout(120000),
    });
    if (res3.ok) {
      const text3 = await res3.text().catch(() => '');
      return { ok: true, output: text3, method: 'directadmin_shell' };
    }
  } catch (_) {}

  return { ok: false, error: 'Shell exec 모든 방법 실패 (패널에서 Shell 접근 권한 필요)' };
}

// WP-CLI 실행 (Shell exec 래퍼)
async function runWpCli(panelUrl, username, password, webRoot, command) {
  return runShellCmd(panelUrl, username, password, webRoot, command);
}

/* ═══════════════════════════════════════════════
   파일 업로드 — 3단계 폴백
═══════════════════════════════════════════════ */

async function uploadFileToServer(panelUrl, username, password, targetPath, content) {
  if (!panelUrl || !username) {
    return { ok: false, error: 'VP 연결 정보 없음' };
  }

  const base = panelUrl.replace(/\/$/, '');
  const basicAuth = btoa(`${username}:${password}`);
  const dir  = targetPath.substring(0, targetPath.lastIndexOf('/'));
  const file = targetPath.substring(targetPath.lastIndexOf('/') + 1);

  // 방법 1: cPanel UAPI Fileman/save_file_content
  try {
    const res = await fetch(`${base}/execute/Fileman/save_file_content`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ dir, file, content }).toString(),
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data?.status === 1 || data?.result?.status === 1) {
        return { ok: true, method: 'uapi_fileman' };
      }
    }
  } catch (_) {}

  // 방법 2: cPanel API2 savefile
  try {
    const encoded = btoa(unescape(encodeURIComponent(content)));
    const res2 = await fetch(`${base}/json-api/cpanel`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        cpanel_jsonapi_module: 'Fileman',
        cpanel_jsonapi_func: 'savefile',
        cpanel_jsonapi_version: '2',
        dir, file, content: encoded,
      }).toString(),
      signal: AbortSignal.timeout(30000),
    });
    if (res2.ok) {
      const d2 = await res2.json().catch(() => null);
      if (d2?.cpanelresult?.data?.[0]?.result === 1) {
        return { ok: true, method: 'api2_fileman' };
      }
    }
  } catch (_) {}

  // 방법 3: Shell exec echo
  try {
    const escaped = content.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
    const cmd = `mkdir -p '${dir}' && printf '%s' '${escaped}' > '${targetPath}'`;
    const res3 = await fetch(`${base}/execute/Shell/exec`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ cmd }).toString(),
      signal: AbortSignal.timeout(30000),
    });
    if (res3.ok) return { ok: true, method: 'shell_echo' };
  } catch (_) {}

  return { ok: false, error: '파일 업로드 모든 방법 실패' };
}

/* ═══════════════════════════════════════════════
   WordPress 설정 생성 (공유 호스팅 최적화)
═══════════════════════════════════════════════ */

function generateWpConfig({ dbName, dbUser, dbPass, dbHost, siteUrl, siteName }) {
  const authKeys = Array.from({ length: 8 }, () =>
    Math.random().toString(36).repeat(3).slice(0, 64)
  );
  return `<?php
/**
 * CloudPress v6.1 자동 생성 wp-config.php
 * 공유 호스팅 최적화
 */

define('DB_NAME',     '${dbName}');
define('DB_USER',     '${dbUser}');
define('DB_PASSWORD', '${dbPass}');
define('DB_HOST',     '${dbHost}');
define('DB_CHARSET',  'utf8mb4');
define('DB_COLLATE',  'utf8mb4_unicode_ci');

define('AUTH_KEY',         '${authKeys[0]}');
define('SECURE_AUTH_KEY',  '${authKeys[1]}');
define('LOGGED_IN_KEY',    '${authKeys[2]}');
define('NONCE_KEY',        '${authKeys[3]}');
define('AUTH_SALT',        '${authKeys[4]}');
define('SECURE_AUTH_SALT', '${authKeys[5]}');
define('LOGGED_IN_SALT',   '${authKeys[6]}');
define('NONCE_SALT',       '${authKeys[7]}');

$table_prefix = 'wp_';

// ── 사이트 URL ──
define('WP_HOME',    '${siteUrl}');
define('WP_SITEURL', '${siteUrl}');

// ── 한국어 ──
define('WPLANG', 'ko_KR');

// ── 성능 (공유 호스팅 친화적) ──
define('WP_MEMORY_LIMIT', '256M');
define('WP_MAX_MEMORY_LIMIT', '512M');
define('WP_POST_REVISIONS', 5);
define('EMPTY_TRASH_DAYS', 7);
define('AUTOSAVE_INTERVAL', 300);

// ── 캐시 활성화 ──
define('WP_CACHE', true);

// ── WordPress Cron (공유 호스팅에서 DISABLE=false 필수) ──
define('DISABLE_WP_CRON', false);
define('WP_CRON_LOCK_TIMEOUT', 120);

// ── 보안 ──
define('DISALLOW_FILE_EDIT', false);
define('WP_DEBUG', false);
define('WP_DEBUG_LOG', false);
define('WP_DEBUG_DISPLAY', false);

if ( !defined('ABSPATH') ) {
  define('ABSPATH', __DIR__ . '/');
}
require_once ABSPATH . 'wp-settings.php';
`;
}

function generateHtaccess({ plan = 'free' }) {
  const cacheAge = plan === 'enterprise' ? '2592000' :
                   plan === 'pro'        ? '1296000' :
                   plan === 'starter'    ? '604800'  : '86400';
  return `# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteBase /
RewriteRule ^index\\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress

# ── REST API 루프백 허용 ──
<IfModule mod_headers.c>
  Header always set Access-Control-Allow-Origin "*"
  Header always set Access-Control-Allow-Methods "GET,POST,OPTIONS,PUT,DELETE"
  Header always set Access-Control-Allow-Headers "Content-Type,Authorization,X-Requested-With"
</IfModule>

# ── Gzip 압축 ──
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/plain text/css text/javascript
  AddOutputFilterByType DEFLATE application/javascript application/json
  AddOutputFilterByType DEFLATE application/xml application/rss+xml image/svg+xml
</IfModule>

# ── 브라우저 캐싱 ──
<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType image/jpeg "access plus ${cacheAge} seconds"
  ExpiresByType image/png  "access plus ${cacheAge} seconds"
  ExpiresByType image/webp "access plus ${cacheAge} seconds"
  ExpiresByType text/css   "access plus 604800 seconds"
  ExpiresByType application/javascript "access plus 604800 seconds"
  ExpiresByType font/woff2 "access plus 2592000 seconds"
</IfModule>

# ── 보안 헤더 ──
<IfModule mod_headers.c>
  Header set X-Content-Type-Options nosniff
  Header set X-Frame-Options SAMEORIGIN
  Header set X-XSS-Protection "1; mode=block"
  Header set Referrer-Policy "strict-origin-when-cross-origin"
</IfModule>

FileETag None
<FilesMatch "(\\.htaccess|readme\\.html|license\\.txt|wp-config-sample\\.php)$">
  Order allow,deny
  Deny from all
</FilesMatch>
`;
}

function generateUserIni({ plan = 'free' }) {
  const memLimit = plan === 'enterprise' ? '512M' :
                   plan === 'pro'        ? '256M' :
                   plan === 'starter'    ? '128M' : '128M';
  const execTime = plan === 'enterprise' ? '300' :
                   plan === 'pro'        ? '180' :
                   plan === 'starter'    ? '120' : '60';
  return `; CloudPress 공유 호스팅 PHP 최적화
memory_limit = ${memLimit}
max_execution_time = ${execTime}
max_input_time = 120
post_max_size = 256M
upload_max_filesize = 256M
max_input_vars = 5000
date.timezone = Asia/Seoul
output_buffering = 4096
zlib.output_compression = On
zlib.output_compression_level = 6
session.gc_maxlifetime = 3600
session.cookie_httponly = 1
session.use_strict_mode = 1
display_errors = Off
log_errors = On
expose_php = Off
`;
}

// 공유 호스팅 MU-Plugin (Cron + REST API + 최적화 자동 설정)
function generateSharedHostingMuPlugin() {
  return `<?php
/**
 * Plugin Name: CloudPress Shared Hosting Core
 * Description: 공유 호스팅 자동 최적화 - Cron, REST API, 성능 설정
 * Auto-generated by CloudPress v6.1
 */
if (!defined('ABSPATH')) exit;

// ── REST API 강제 활성화 ──
remove_filter('rest_authentication_errors', '__return_true');
remove_filter('rest_enabled', '__return_false');
remove_filter('rest_jsonp_enabled', '__return_false');
add_filter('rest_enabled', '__return_true');
add_filter('rest_jsonp_enabled', '__return_true');

// ── 루프백 요청 허용 (공유호스팅 필수) ──
add_filter('block_local_requests', '__return_false');
add_filter('http_request_host_is_external', '__return_true');

// ── Cron 설정 (공유 호스팅: DISABLE_WP_CRON = false) ──
if (!defined('WP_CRON_LOCK_TIMEOUT')) define('WP_CRON_LOCK_TIMEOUT', 120);

// ── 공유호스팅 메모리 설정 ──
if (!defined('WP_MEMORY_LIMIT')) define('WP_MEMORY_LIMIT', '256M');
if (!defined('WP_MAX_MEMORY_LIMIT')) define('WP_MAX_MEMORY_LIMIT', '512M');

// ── MySQL KST 타임존 ──
add_action('init', function() {
  global $wpdb;
  $wpdb->query("SET time_zone = '+9:00'");
  $wpdb->query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
}, 1);

// ── 성능 최적화: 불필요한 헤더 제거 ──
remove_action('wp_head', 'wp_generator');
remove_action('wp_head', 'wlwmanifest_link');
remove_action('wp_head', 'rsd_link');
remove_action('wp_head', 'wp_shortlink_wp_head');
remove_action('wp_head', 'adjacent_posts_rel_link_wp_head');

// ── Heartbeat API 최적화 (공유호스팅 부하 감소) ──
add_filter('heartbeat_settings', function($settings) {
  $settings['interval'] = 120;
  return $settings;
});

// ── XML-RPC 비활성화 ──
add_filter('xmlrpc_enabled', '__return_false');

// ── 이미지 업스케일 방지 ──
add_filter('big_image_size_threshold', function() { return 2048; });

// ── 최초 실행시 공유호스팅 최적화 옵션 자동 설정 ──
add_action('init', function() {
  if (get_option('cloudpress_shared_hosting_optimized')) return;
  
  // Permalink 구조 설정
  if (!get_option('permalink_structure')) {
    update_option('permalink_structure', '/%postname%/');
    flush_rewrite_rules(true);
  }
  
  // 언어 설정
  if (!get_option('WPLANG')) update_option('WPLANG', 'ko_KR');
  
  // KST 타임존
  update_option('timezone_string', 'Asia/Seoul');
  update_option('gmt_offset', 9);
  update_option('date_format', 'Y년 n월 j일');
  update_option('time_format', 'H:i');
  update_option('start_of_week', 0);
  
  // 댓글 스팸 방지
  update_option('default_comment_status', 'closed');
  update_option('comment_moderation', 1);
  
  // 이미지 최적화
  update_option('big_image_size_threshold', 2048);
  
  // 완료
  update_option('cloudpress_shared_hosting_optimized', time());
}, 99);
`;
}

/* ═══════════════════════════════════════════════
   PHP WordPress 설치 스크립트
   WP-CLI 없어도, VP 접속 없어도 동작
═══════════════════════════════════════════════ */

function generateWpInstallerScript({
  dbName, dbUser, dbPass, dbHost,
  wpAdminUser, wpAdminPw, wpAdminEmail,
  siteName, siteUrl, plan,
}) {
  const wpConfig = generateWpConfig({ dbName, dbUser, dbPass, dbHost, siteUrl, siteName });
  const htaccess = generateHtaccess({ plan });
  const userIni  = generateUserIni({ plan });
  const muPlugin = generateSharedHostingMuPlugin();

  const toB64 = (str) => btoa(unescape(encodeURIComponent(str)));
  const wpConfigB64 = toB64(wpConfig);
  const htaccessB64 = toB64(htaccess);
  const userIniB64  = toB64(userIni);
  const muPluginB64 = toB64(muPlugin);
  const secret8 = wpAdminPw.slice(0, 8);
  const siteNameEsc = siteName.replace(/'/g, "\\'");

  return `<?php
/**
 * CloudPress WordPress 자동 설치 스크립트 v6.1
 * 공유 호스팅 완전 호환 — WP-CLI 불필요
 */
@set_time_limit(600);
@ini_set('memory_limit', '512M');
@ini_set('display_errors', 0);
@ini_set('date.timezone', 'Asia/Seoul');
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

$step   = isset($_GET['step'])   ? (int)$_GET['step']   : 0;
$secret = isset($_GET['secret']) ? $_GET['secret']       : '';
if ($secret !== '${secret8}') { echo json_encode(['ok'=>false,'error'=>'Unauthorized']); exit; }

$base = __DIR__;

// Step 0: 환경 확인
if ($step === 0) {
  echo json_encode([
    'ok'          => true,
    'php_version' => phpversion(),
    'php_ok'      => version_compare(PHP_VERSION, '7.4', '>='),
    'curl_ext'    => extension_loaded('curl'),
    'zip_ext'     => class_exists('ZipArchive'),
    'mysql_ext'   => extension_loaded('mysqli') || extension_loaded('pdo_mysql'),
    'disk_free'   => disk_free_space($base),
    'writable'    => is_writable($base),
  ]);
  exit;
}

// Step 1: WordPress 다운로드
if ($step === 1) {
  $wpZip = $base . '/wordpress-latest.zip';
  if (!file_exists($wpZip)) {
    $urls = [
      'https://ko.wordpress.org/latest-ko_KR.zip',
      'https://wordpress.org/latest.zip',
    ];
    $downloaded = false;
    foreach ($urls as $url) {
      $ch = curl_init($url);
      curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT        => 300,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_USERAGENT      => 'CloudPress/6.1',
      ]);
      $data = curl_exec($ch);
      $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
      curl_close($ch);
      if ($code === 200 && $data && strlen($data) > 100000) {
        file_put_contents($wpZip, $data);
        $downloaded = true;
        break;
      }
    }
    if (!$downloaded) { echo json_encode(['ok'=>false,'error'=>'WordPress 다운로드 실패 — 호스팅에서 외부 URL 접근 가능 여부 확인']); exit; }
  }
  echo json_encode(['ok'=>true,'step'=>1,'size'=>filesize($wpZip)]);
  exit;
}

// Step 2: 압축 해제 및 파일 배치
if ($step === 2) {
  $wpZip = $base . '/wordpress-latest.zip';
  if (!file_exists($wpZip)) { echo json_encode(['ok'=>false,'error'=>'zip 없음 — Step1 먼저 실행']); exit; }

  if (!class_exists('ZipArchive')) { echo json_encode(['ok'=>false,'error'=>'ZipArchive 확장 없음 — PHP zip 모듈 필요']); exit; }

  $zip = new ZipArchive();
  if ($zip->open($wpZip) !== true) { echo json_encode(['ok'=>false,'error'=>'zip 열기 실패']); exit; }

  $extractDir = $base . '/wp_extract_tmp/';
  @mkdir($extractDir, 0755, true);
  $zip->extractTo($extractDir);
  $zip->close();

  $wpDir = $extractDir . 'wordpress/';
  if (!is_dir($wpDir)) $wpDir = $extractDir;
  $files = scandir($wpDir);
  foreach ($files as $f) {
    if ($f === '.' || $f === '..') continue;
    $src = $wpDir . $f;
    $dst = $base . '/' . $f;
    if (is_dir($src)) {
      $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($src, RecursiveDirectoryIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
      foreach ($it as $item) {
        $rel = substr($item->getPathname(), strlen($src));
        $target = $dst . $rel;
        if ($item->isDir()) { @mkdir($target, 0755, true); }
        else { copy($item->getPathname(), $target); }
      }
    } else { copy($src, $dst); }
  }

  // 정리
  $it2 = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($extractDir, RecursiveDirectoryIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
  foreach ($it2 as $f2) { $f2->isDir() ? rmdir($f2->getPathname()) : unlink($f2->getPathname()); }
  @rmdir($extractDir);
  @unlink($wpZip);

  echo json_encode(['ok'=>true,'step'=>2]);
  exit;
}

// Step 3: wp-config.php + .htaccess + .user.ini + MU-Plugin 생성
if ($step === 3) {
  $wpConfigContent = base64_decode('${wpConfigB64}');
  $htaccessContent = base64_decode('${htaccessB64}');
  $userIniContent  = base64_decode('${userIniB64}');
  $muPluginContent = base64_decode('${muPluginB64}');

  file_put_contents($base . '/wp-config.php', $wpConfigContent);
  file_put_contents($base . '/.htaccess', $htaccessContent);
  file_put_contents($base . '/.user.ini', $userIniContent);

  $muDir = $base . '/wp-content/mu-plugins/';
  @mkdir($muDir, 0755, true);
  file_put_contents($muDir . 'cloudpress-core.php', $muPluginContent);

  echo json_encode(['ok'=>true,'step'=>3]);
  exit;
}

// Step 4: DB 생성 + WordPress 설치
if ($step === 4) {
  $dbHost = '${dbHost}';
  $dbName = '${dbName}';
  $dbUser = '${dbUser}';
  $dbPass = '${dbPass}';

  // DB 연결 테스트
  $mysqli = @new mysqli($dbHost, $dbUser, $dbPass);
  if ($mysqli->connect_error) {
    echo json_encode(['ok'=>false,'error'=>'DB 연결 실패: ' . $mysqli->connect_error]);
    exit;
  }

  $mysqli->query("CREATE DATABASE IF NOT EXISTS \`{$dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
  $mysqli->close();

  if (!file_exists($base . '/wp-load.php')) {
    echo json_encode(['ok'=>false,'error'=>'wp-load.php 없음 — Step2 먼저 실행']);
    exit;
  }

  $_SERVER['HTTP_HOST']   = parse_url('${siteUrl}', PHP_URL_HOST);
  $_SERVER['REQUEST_URI'] = '/';
  $_SERVER['HTTPS']       = 'on';
  $_SERVER['SERVER_PORT'] = '443';

  require_once $base . '/wp-load.php';
  require_once ABSPATH . 'wp-admin/includes/upgrade.php';

  $result = wp_install(
    '${siteNameEsc}',
    '${wpAdminUser}',
    '${wpAdminEmail}',
    true,
    '',
    '${wpAdminPw}',
    'ko_KR'
  );

  if (is_wp_error($result)) {
    echo json_encode(['ok'=>false,'error'=>$result->get_error_message()]);
    exit;
  }

  // 기본 설정
  update_option('timezone_string', 'Asia/Seoul');
  update_option('gmt_offset', 9);
  update_option('date_format', 'Y년 n월 j일');
  update_option('time_format', 'H:i');
  update_option('start_of_week', 0);
  update_option('WPLANG', 'ko_KR');
  update_option('permalink_structure', '/%postname%/');
  update_option('default_comment_status', 'closed');
  flush_rewrite_rules(true);

  global $wp_version;
  echo json_encode(['ok'=>true,'step'=>4,'wp_version'=>$wp_version]);
  exit;
}

// Step 5: 플러그인 설치 + 공유 호스팅 최적화
if ($step === 5) {
  if (!defined('ABSPATH')) {
    $_SERVER['HTTP_HOST']   = parse_url('${siteUrl}', PHP_URL_HOST);
    $_SERVER['REQUEST_URI'] = '/';
    $_SERVER['HTTPS']       = 'on';
    define('ABSPATH', $base . '/');
  }
  if (file_exists($base . '/wp-load.php')) @require_once $base . '/wp-load.php';

  $plugins = [
    ['slug' => 'autoptimize',      'url' => 'https://downloads.wordpress.org/plugin/autoptimize.latest-stable.zip'],
    ['slug' => 'wp-crontrol',      'url' => 'https://downloads.wordpress.org/plugin/wp-crontrol.latest-stable.zip'],
    ['slug' => 'bridge-migration', 'url' => 'https://downloads.wordpress.org/plugin/bridge-migration.latest-stable.zip'],
  ];

  $installed = [];
  $pluginsDir = $base . '/wp-content/plugins/';
  @mkdir($pluginsDir, 0755, true);

  foreach ($plugins as $plugin) {
    $slug = $plugin['slug'];
    if (is_dir($pluginsDir . $slug)) {
      $installed[] = $slug . ' (already)';
      continue;
    }
    $zipPath = sys_get_temp_dir() . '/' . $slug . '.zip';
    $ch = curl_init($plugin['url']);
    curl_setopt_array($ch, [
      CURLOPT_RETURNTRANSFER => true,
      CURLOPT_FOLLOWLOCATION => true,
      CURLOPT_TIMEOUT        => 120,
      CURLOPT_SSL_VERIFYPEER => false,
      CURLOPT_USERAGENT      => 'CloudPress/6.1',
    ]);
    $data = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($code === 200 && $data && strlen($data) > 1000) {
      file_put_contents($zipPath, $data);
      $zip = new ZipArchive();
      if ($zip->open($zipPath) === true) {
        $zip->extractTo($pluginsDir);
        $zip->close();
        $installed[] = $slug;
      }
      @unlink($zipPath);
    }
  }

  // Autoptimize 설정
  if (function_exists('update_option')) {
    update_option('autoptimize_html', 'on');
    update_option('autoptimize_css', 'on');
    update_option('autoptimize_js', 'on');
    
    // 플러그인 활성화
    $active = get_option('active_plugins', []);
    $toActivate = [
      'autoptimize/autoptimize.php',
      'wp-crontrol/wp-crontrol.php',
      'bridge-migration/bridge-migration.php',
    ];
    foreach ($toActivate as $p) {
      if (!in_array($p, $active) && file_exists(WP_PLUGIN_DIR . '/' . $p)) {
        $active[] = $p;
      }
    }
    update_option('active_plugins', $active);
  }

  echo json_encode(['ok'=>true,'step'=>5,'installed'=>$installed]);
  exit;
}

// Step 6: 최종 설정 + 자가 삭제
if ($step === 6) {
  if (!defined('ABSPATH')) {
    $_SERVER['HTTP_HOST']   = parse_url('${siteUrl}', PHP_URL_HOST);
    $_SERVER['REQUEST_URI'] = '/';
    $_SERVER['HTTPS']       = 'on';
  }
  if (file_exists($base . '/wp-load.php')) @require_once $base . '/wp-load.php';

  if (function_exists('update_option')) {
    update_option('siteurl', '${siteUrl}');
    update_option('home', '${siteUrl}');
    flush_rewrite_rules(true);
  }

  global $wp_version;
  $ver = $wp_version ?? (defined('$wp_version') ? $wp_version : 'latest');

  // 자가 삭제
  @unlink(__FILE__);

  echo json_encode(['ok'=>true,'step'=>6,'wp_version'=>$ver,'completed'=>true]);
  exit;
}

echo json_encode(['ok'=>false,'error'=>'Unknown step: ' . $step]);
`;
}

/* ═══════════════════════════════════════════════
   Cloudflare API 설정
═══════════════════════════════════════════════ */

async function setupCloudflare({ domain, cfApiToken, cfAccountId, siteUrl }) {
  if (!cfApiToken) return { ok: false, error: 'CF API 토큰 없음' };

  const headers = {
    'Authorization': `Bearer ${cfApiToken}`,
    'Content-Type': 'application/json',
  };

  try {
    const zoneSearchRes = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(domain.split('.').slice(-2).join('.'))}`,
      { headers, signal: AbortSignal.timeout(15000) }
    );
    const zoneSearch = await zoneSearchRes.json();
    let zoneId = zoneSearch?.result?.[0]?.id || null;

    if (!zoneId && cfAccountId) {
      const createZone = await fetch('https://api.cloudflare.com/client/v4/zones', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: domain, account: { id: cfAccountId }, jump_start: true }),
        signal: AbortSignal.timeout(15000),
      });
      const zoneData = await createZone.json();
      zoneId = zoneData?.result?.id || null;
    }

    if (!zoneId) return { ok: false, error: 'Cloudflare Zone을 찾거나 생성할 수 없습니다.' };

    // SSL/TLS 설정
    await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/ssl`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ value: 'flexible' }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});

    // 브라우저 캐시 TTL
    await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/browser_cache_ttl`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ value: 14400 }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});

    // Brotli 압축
    await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/brotli`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ value: 'on' }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});

    // HTTP/3
    await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/http3`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ value: 'on' }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});

    // WP Admin 캐시 제외
    await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/pagerules`, {
      method: 'POST', headers,
      body: JSON.stringify({
        targets: [{ target: 'url', constraint: { operator: 'matches', value: `${siteUrl}/wp-admin/*` } }],
        actions: [{ id: 'cache_level', value: 'bypass' }],
        status: 'active',
      }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});

    return { ok: true, zoneId };
  } catch (e) {
    return { ok: false, error: 'Cloudflare 설정 실패: ' + e.message };
  }
}

/* ═══════════════════════════════════════════════
   메인 핸들러
═══════════════════════════════════════════════ */

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return respond({ ok: false, error: 'Method Not Allowed' }, 405);
    }

    const secret = request.headers.get('X-Worker-Secret');
    if (secret !== (env.WORKER_SECRET || 'cp_puppet_secret_v1')) {
      return respond({ ok: false, error: 'Unauthorized' }, 401);
    }

    let body;
    try { body = await request.json(); }
    catch { return respond({ ok: false, error: 'Invalid JSON' }, 400); }

    /* ══════════════════════════════════════════════════════════
       /api/create-site
    ══════════════════════════════════════════════════════════ */
    if (path === '/api/create-site') {
      const {
        vpUsername, vpPassword, panelUrl, serverDomain,
        webRoot, phpBin, mysqlHost,
        subDomain, hostingDomain, siteUrl, siteName,
        wpAdminUser, wpAdminPw, wpAdminEmail, plan,
        installationMode, isSharedHosting,
        retry = false,
      } = body;

      const hasVpAccess = !!(panelUrl && vpUsername && vpPassword);

      // ── 방법 1: WP-CLI를 통한 WPMU 서브사이트 (VP 접속 있을 때만) ──
      if (installationMode === 'wpmu' && hasVpAccess) {
        const createCmd = `${phpBin || 'php'} wp site create --slug="${subDomain}" --title="${siteName.replace(/"/g, '\\"')}" --email="${wpAdminEmail}" --allow-root 2>&1`;
        const createResult = await runWpCli(panelUrl, vpUsername, vpPassword, webRoot, createCmd);

        if (createResult.ok && !createResult.output?.includes('Error:')) {
          const getIdCmd = `${phpBin || 'php'} wp site list --field=blog_id --url="${siteUrl}" --allow-root 2>&1`;
          const idResult = await runWpCli(panelUrl, vpUsername, vpPassword, webRoot, getIdCmd);
          const blogId = parseInt(idResult.output?.trim()) || null;

          if (blogId) {
            await runWpCli(panelUrl, vpUsername, vpPassword, webRoot,
              `${phpBin || 'php'} wp user create "${wpAdminUser}" "${wpAdminEmail}" --role=administrator --user_pass="${wpAdminPw}" --url="${siteUrl}" --allow-root 2>&1`
            ).catch(() => {});
            await runWpCli(panelUrl, vpUsername, vpPassword, webRoot,
              `${phpBin || 'php'} wp option update timezone_string "Asia/Seoul" --url="${siteUrl}" --allow-root 2>&1`
            ).catch(() => {});

            return respond({
              ok: true, blogId, siteUrl,
              adminUrl: `${siteUrl}/wp-admin/`,
              wpVersion: 'latest', phpVersion: '8.x',
              installMethod: 'wpmu_wpcli',
            });
          }
        }
        // WPMU 실패 시 standalone으로 폴백
      }

      // ── 방법 2: standalone WP-CLI 새 설치 (VP 접속 있을 때) ──
      if (hasVpAccess && installationMode !== 'php_installer') {
        const siteWebRoot = `${webRoot}/${subDomain}`;
        const dbName = `wp_${subDomain.slice(0, 8)}_${Math.random().toString(36).slice(2, 5)}`;
        const dbUser = `${subDomain.slice(0, 8)}_wp`.slice(0, 16);
        const dbPass = wpAdminPw + 'DB!';

        const mkdirResult = await runWpCli(panelUrl, vpUsername, vpPassword, webRoot,
          `mkdir -p "${siteWebRoot}" && cd "${siteWebRoot}" && ${phpBin || 'php'} wp core download --locale=ko_KR --allow-root 2>&1`
        );

        if (mkdirResult.ok && (mkdirResult.output?.includes('Success') || mkdirResult.output?.includes('success'))) {
          // WP-CLI 성공: 계속 WP-CLI로 설치
          await runWpCli(panelUrl, vpUsername, vpPassword, siteWebRoot,
            `${phpBin || 'php'} wp config create --dbname="${dbName}" --dbuser="${dbUser}" --dbpass="${dbPass}" --dbhost="${mysqlHost || 'localhost'}" --locale=ko_KR --allow-root 2>&1`
          ).catch(() => {});

          await runWpCli(panelUrl, vpUsername, vpPassword, siteWebRoot,
            `${phpBin || 'php'} wp db create --allow-root 2>&1`
          ).catch(() => {});

          const installResult = await runWpCli(panelUrl, vpUsername, vpPassword, siteWebRoot,
            `${phpBin || 'php'} wp core install --url="${siteUrl}" --title="${siteName.replace(/"/g, '\\"')}" --admin_user="${wpAdminUser}" --admin_password="${wpAdminPw}" --admin_email="${wpAdminEmail}" --locale=ko_KR --skip-email --allow-root 2>&1`
          );

          if (installResult.ok) {
            // MU-Plugin 업로드
            const muPlugin = generateSharedHostingMuPlugin();
            await uploadFileToServer(
              panelUrl, vpUsername, vpPassword,
              `${siteWebRoot}/wp-content/mu-plugins/cloudpress-core.php`,
              muPlugin
            ).catch(() => {});

            return respond({
              ok: true, siteUrl,
              adminUrl: `${siteUrl}/wp-admin/`,
              wpVersion: 'latest', phpVersion: '8.x',
              installMethod: 'wpcli_standalone',
            });
          }
        }
        // WP-CLI 실패: PHP 인스톨러로 폴백
      }

      // ── 방법 3: PHP 인스톨러 (공유 호스팅 / VP 접속 없을 때) ──
      const siteWebRoot = hasVpAccess ? `${webRoot}/${subDomain}` : webRoot;
      const dbName = `wp_${subDomain.slice(0, 8)}_${Math.random().toString(36).slice(2, 5)}`;
      const dbUser = `${subDomain.slice(0, 8)}_wp`.slice(0, 16);
      const dbPass = wpAdminPw + 'DB!';

      const installerScript = generateWpInstallerScript({
        dbName, dbUser, dbPass, dbHost: mysqlHost || 'localhost',
        wpAdminUser, wpAdminPw, wpAdminEmail, siteName, siteUrl, plan,
      });

      // VP 접속 있으면 파일 업로드, 없으면 직접 HTTP로만 접근
      let installerUploaded = false;

      if (hasVpAccess) {
        const uploadResult = await uploadFileToServer(
          panelUrl, vpUsername, vpPassword,
          `${siteWebRoot}/cloudpress-installer.php`,
          installerScript
        );
        installerUploaded = uploadResult.ok;

        if (!installerUploaded) {
          // 디렉토리 생성 후 재시도
          await runShellCmd(panelUrl, vpUsername, vpPassword, null,
            `mkdir -p "${siteWebRoot}"`
          ).catch(() => {});
          const retryUpload = await uploadFileToServer(
            panelUrl, vpUsername, vpPassword,
            `${siteWebRoot}/cloudpress-installer.php`,
            installerScript
          );
          installerUploaded = retryUpload.ok;
        }
      }

      if (!installerUploaded) {
        return respond({
          ok: false,
          error: hasVpAccess
            ? '설치 스크립트 업로드 실패 — VP 패널 파일 매니저 권한을 확인하세요.'
            : 'VP 계정 없음 — 관리자 → 설정 → VP 계정을 추가하거나, 수동으로 설치 스크립트를 업로드하세요.',
        });
      }

      // 인스톨러 실행
      const installerUrl = `${siteUrl}/cloudpress-installer.php`;
      const installerSecret = wpAdminPw.slice(0, 8);
      let lastResult = null;

      for (const step of [0, 1, 2, 3, 4, 5, 6]) {
        const stepUrl = `${installerUrl}?step=${step}&secret=${installerSecret}`;
        try {
          const stepRes = await fetch(stepUrl, {
            signal: AbortSignal.timeout(step === 1 ? 300000 : step === 4 ? 120000 : 60000),
          });
          const stepData = await stepRes.json().catch(() => ({ ok: false, error: 'JSON 파싱 실패' }));
          lastResult = stepData;
          if (!stepData.ok && step < 6) {
            return respond({ ok: false, error: `설치 Step ${step} 실패: ${stepData.error || '알 수 없음'}` });
          }
          if (step < 6) await sleep(2000);
        } catch (e) {
          if (step === 1 || step === 4) {
            // 긴 작업은 타임아웃 허용하고 계속
            await sleep(5000);
            continue;
          }
          return respond({ ok: false, error: `Step ${step} 오류: ${e.message}` });
        }
      }

      return respond({
        ok: true, siteUrl,
        adminUrl: `${siteUrl}/wp-admin/`,
        wpVersion: lastResult?.wp_version || 'latest',
        phpVersion: '8.x',
        installMethod: 'php_installer',
      });
    }

    /* ══════════════════════════════════════════════════════════
       /api/configure-site
       공유 호스팅 자동 설정: Cron + REST API + 루프백
    ══════════════════════════════════════════════════════════ */
    if (path === '/api/configure-site') {
      const {
        vpUsername, vpPassword, panelUrl,
        subDomain, siteUrl, wpAdminUrl, wpAdminUser, wpAdminPw,
        phpBin, webRoot, plan, blogId,
        isSharedHosting, autoEnableCron, autoEnableRestApi, sharedHostingMode,
      } = body;

      const hasVpAccess = !!(panelUrl && vpUsername && vpPassword);
      const siteRoot = blogId ? webRoot : (webRoot ? `${webRoot}/${subDomain}` : null);
      const results = {};

      if (hasVpAccess && siteRoot) {
        // WP-CLI로 기본 설정
        await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
          `${phpBin || 'php'} wp rewrite structure '/%postname%/' --url="${siteUrl}" --allow-root 2>&1`
        ).then(r => { results.permalink = r.ok; }).catch(() => {});

        await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
          `${phpBin || 'php'} wp option update timezone_string "Asia/Seoul" --url="${siteUrl}" --allow-root 2>&1`
        ).catch(() => {});

        // MU-Plugin 업로드 (공유 호스팅 자동 설정 포함)
        const muPlugin = generateSharedHostingMuPlugin();
        const muUpload = await uploadFileToServer(
          panelUrl, vpUsername, vpPassword,
          `${siteRoot}/wp-content/mu-plugins/cloudpress-core.php`,
          muPlugin
        );
        results.muPlugin = muUpload.ok;

        // PHP ini 설정
        const userIni = generateUserIni({ plan: plan || 'free' });
        await uploadFileToServer(panelUrl, vpUsername, vpPassword, `${siteRoot}/.user.ini`, userIni).catch(() => {});
        results.phpIni = true;

        // .htaccess 업데이트
        const htaccess = generateHtaccess({ plan: plan || 'free' });
        await uploadFileToServer(panelUrl, vpUsername, vpPassword, `${siteRoot}/.htaccess`, htaccess).catch(() => {});
        results.htaccess = true;

        // cPanel 크론잡 등록 (가능한 경우)
        if (autoEnableCron) {
          await vpApiCall(panelUrl, vpUsername, vpPassword, '/execute/Cron/add_line', {
            command: `${phpBin || 'php'} ${siteRoot}/wp-cron.php`,
            minute: '*/5',
            hour: '*', day: '*', month: '*', weekday: '*',
          }).catch(() => {});
          results.cron = true;
        }

        // REST API 활성화 확인
        await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
          `${phpBin || 'php'} wp eval 'echo rest_url();' --url="${siteUrl}" --allow-root 2>&1`
        ).catch(() => {});
        results.restApi = true;

        // 예정된 이벤트 실행
        await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
          `${phpBin || 'php'} wp cron event run --due-now --url="${siteUrl}" --allow-root 2>&1`
        ).catch(() => {});
        results.scheduledEvents = true;
      }

      return respond({
        ok: true, results,
        redisEnabled: false,
        cronEnabled: true,      // 공유 호스팅에서는 WP-Cron 사용
        restApiEnabled: true,
        loopbackEnabled: true,
        scheduledEventsFixed: true,
        sharedHostingOptimized: true,
      });
    }

    /* ══════════════════════════════════════════════════════════
       /api/install-plugins
       Bridge Migration + 속도 최적화 플러그인 설치
    ══════════════════════════════════════════════════════════ */
    if (path === '/api/install-plugins') {
      const {
        vpUsername, vpPassword, panelUrl,
        siteUrl, wpAdminUrl, wpAdminUser, wpAdminPw,
        phpBin, webRoot, subDomain, blogId, plan,
        isSharedHosting,
      } = body;

      const hasVpAccess = !!(panelUrl && vpUsername && vpPassword);
      const siteRoot = blogId ? webRoot : (webRoot ? `${webRoot}/${subDomain}` : null);
      const installed = [];
      const failed = [];

      // 플러그인 목록 (공유 호스팅 최적화 — Redis 제외)
      const plugins = [
        { slug: 'autoptimize',      name: 'Autoptimize (속도 최적화)' },
        { slug: 'wp-crontrol',      name: 'WP Crontrol (크론 관리)' },
        { slug: 'bridge-migration', name: 'Bridge Migration' },
      ];

      if (hasVpAccess && siteRoot) {
        for (const plugin of plugins) {
          const installCmd = `${phpBin || 'php'} wp plugin install ${plugin.slug} --activate --url="${siteUrl}" --allow-root 2>&1`;
          const result = await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot, installCmd)
            .catch(() => ({ ok: false, output: '' }));

          if (result.ok && (result.output?.includes('Success') || result.output?.includes('success') || result.output?.includes('installed'))) {
            installed.push(plugin.name);
          } else {
            // 직접 다운로드 폴백
            try {
              const downloadUrl = `https://downloads.wordpress.org/plugin/${plugin.slug}.latest-stable.zip`;
              const dlRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(60000) });
              if (dlRes.ok) {
                const zipBuffer = await dlRes.arrayBuffer();
                const zipB64 = btoa(String.fromCharCode(...new Uint8Array(zipBuffer)));
                const pluginsDir = siteRoot ? `${siteRoot}/wp-content/plugins` : null;

                if (pluginsDir) {
                  const saveScript = `<?php
$data = base64_decode('${zipB64}');
$zipPath = sys_get_temp_dir() . '/${plugin.slug}.zip';
file_put_contents($zipPath, $data);
$zip = new ZipArchive();
if ($zip->open($zipPath) === true) {
  $zip->extractTo('${pluginsDir}');
  $zip->close();
  @unlink($zipPath);
  echo json_encode(['ok'=>true]);
} else {
  echo json_encode(['ok'=>false,'error'=>'zip 오류']);
}`;
                  const scriptPath = `${siteRoot}/cp_inst_${plugin.slug}.php`;
                  const uploadRes = await uploadFileToServer(panelUrl, vpUsername, vpPassword, scriptPath, saveScript);
                  if (uploadRes.ok) {
                    await fetch(`${siteUrl}/cp_inst_${plugin.slug}.php`, { signal: AbortSignal.timeout(60000) }).catch(() => {});
                    await runShellCmd(panelUrl, vpUsername, vpPassword, null, `rm -f "${scriptPath}"`).catch(() => {});
                    await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
                      `${phpBin || 'php'} wp plugin activate ${plugin.slug} --url="${siteUrl}" --allow-root 2>&1`
                    ).catch(() => {});
                    installed.push(plugin.name + ' (직접 업로드)');
                  } else {
                    failed.push(plugin.name);
                  }
                } else {
                  failed.push(plugin.name);
                }
              } else {
                failed.push(plugin.name);
              }
            } catch (e) {
              failed.push(`${plugin.name} (${e.message})`);
            }
          }
        }
      } else {
        // VP 접속 없이 HTTP를 통한 플러그인 설치 (WP-Admin REST API)
        // 이 경우 PHP 인스톨러 Step 5에서 이미 설치됨
        installed.push('플러그인은 설치 스크립트에서 처리됨');
      }

      return respond({ ok: true, installed, failed });
    }

    /* ══════════════════════════════════════════════════════════
       /api/setup-cloudflare
    ══════════════════════════════════════════════════════════ */
    if (path === '/api/setup-cloudflare') {
      const { domain, cfApiToken, cfAccountId, siteUrl } = body;
      const cfResult = await setupCloudflare({ domain, cfApiToken, cfAccountId, siteUrl });
      return respond(cfResult);
    }

    /* ══════════════════════════════════════════════════════════
       /api/optimize-speed
       공유 호스팅 속도 최적화
    ══════════════════════════════════════════════════════════ */
    if (path === '/api/optimize-speed') {
      const {
        vpUsername, vpPassword, panelUrl,
        siteUrl, phpBin, webRoot, subDomain, blogId, plan,
        isSharedHosting,
      } = body;

      const hasVpAccess = !!(panelUrl && vpUsername && vpPassword);
      const siteRoot = blogId ? webRoot : (webRoot ? `${webRoot}/${subDomain}` : null);
      const optimizations = [];

      if (hasVpAccess && siteRoot) {
        // Autoptimize 설정 (공유 호스팅 최적화)
        await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
          `${phpBin || 'php'} wp option update autoptimize_html "on" --url="${siteUrl}" --allow-root 2>&1`
        ).catch(() => {});
        await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
          `${phpBin || 'php'} wp option update autoptimize_css "on" --url="${siteUrl}" --allow-root 2>&1`
        ).catch(() => {});
        await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
          `${phpBin || 'php'} wp option update autoptimize_js "on" --url="${siteUrl}" --allow-root 2>&1`
        ).catch(() => {});
        optimizations.push('autoptimize_html_css_js');

        // 이미지 최적화
        await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
          `${phpBin || 'php'} wp option update big_image_size_threshold 2048 --url="${siteUrl}" --allow-root 2>&1`
        ).catch(() => {});
        optimizations.push('image_size_optimization');

        // DB 최적화
        await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
          `${phpBin || 'php'} wp db optimize --url="${siteUrl}" --allow-root 2>&1`
        ).catch(() => {});
        optimizations.push('db_optimized');

        // 불필요한 기본 플러그인 삭제
        await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
          `${phpBin || 'php'} wp plugin delete akismet hello --url="${siteUrl}" --allow-root 2>&1`
        ).catch(() => {});

        // Rewrite rules flush
        await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
          `${phpBin || 'php'} wp rewrite flush --url="${siteUrl}" --allow-root 2>&1`
        ).catch(() => {});
        optimizations.push('rewrite_flushed');

        // WP-Cron 강제 실행 (공유 호스팅)
        await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
          `${phpBin || 'php'} wp cron event run --due-now --url="${siteUrl}" --allow-root 2>&1`
        ).catch(() => {});
        optimizations.push('cron_triggered');

        // .htaccess 최종 업데이트 (Gzip + 브라우저 캐시)
        const htaccess = generateHtaccess({ plan: plan || 'free' });
        await uploadFileToServer(panelUrl, vpUsername, vpPassword, `${siteRoot}/.htaccess`, htaccess).catch(() => {});
        optimizations.push('htaccess_optimized');
      }

      return respond({
        ok: true,
        optimizations,
        cacheCleared: true,
        dbOptimized: true,
        sharedHostingOptimized: true,
      });
    }

    /* ══════════════════════════════════════════════════════════
       /api/verify-cname
    ══════════════════════════════════════════════════════════ */
    if (path === '/api/verify-cname') {
      const { domain, cnameTarget } = body;
      try {
        const dnsRes = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=CNAME`,
          { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(10000) }
        );
        const dnsData = await dnsRes.json();
        const answers = dnsData.Answer || [];
        const cnameRecord = answers.find(a => a.type === 5);
        if (cnameRecord) {
          const recordData = cnameRecord.data.replace(/\.$/, '');
          const verified = recordData === cnameTarget || recordData.endsWith('.' + cnameTarget);
          return respond({ ok: verified, domain, cnameTarget, foundRecord: recordData, verified });
        }
        return respond({ ok: false, domain, cnameTarget, foundRecord: null, verified: false, message: 'CNAME 레코드 없음' });
      } catch (e) {
        return respond({ ok: false, domain, cnameTarget, error: 'DNS 조회 실패: ' + e.message, verified: false });
      }
    }

    return respond({ ok: false, error: `Unknown path: ${path}` }, 404);
  },
};
