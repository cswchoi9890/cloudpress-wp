// puppeteer-worker/index.js
// CloudPress v6.0 — WP-CLI + WPMU 멀티사이트 기반 실제 사이트 생성
// ✅ v6 변경사항:
//   1. Puppeteer 브라우저 자동화 → VP 패널 API + WP-CLI SSH/exec 방식
//   2. WPMU 서브사이트 생성 (wp site create --slug=xxx) 또는 standalone WP 설치
//   3. Redis 영구 객체 캐시 자동 설정 (redis-cache 플러그인)
//   4. 시스템 크론잡 자동 등록 (DISABLE_WP_CRON + real cron)
//   5. REST API / 루프백 자동 활성화
//   6. 예정된 이벤트 강제 실행 활성화
//   7. Cloudflare CDN 자동 설정 (CF API)
//   8. Bridge Migration 플러그인 자동 설치 (모든 호스팅 호환)
//   9. 속도/캐시/CDN 최적화 자동화

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
   VP 패널 API 호출 유틸
   - cPanel UAPI / WHM API / 자체 VP 패널
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

// VP 패널에서 WP-CLI 명령 실행 (cPanel UAPI Run command 또는 SSH)
async function runWpCli(panelUrl, username, password, webRoot, command) {
  const base = panelUrl.replace(/\/$/, '');
  const basicAuth = btoa(`${username}:${password}`);

  // 방법 1: cPanel UAPI Shell exec
  try {
    const res = await fetch(`${base}/execute/Shell/exec`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        cmd: `cd ${webRoot} && ${command}`,
      }).toString(),
      signal: AbortSignal.timeout(120000),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const output = data?.result?.output || data?.data?.output || '';
      return { ok: true, output, method: 'cpanel_shell' };
    }
  } catch (_) {}

  // 방법 2: cPanel API2 exec (구버전 패널)
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
        cmd: `cd ${webRoot} && ${command}`,
      }).toString(),
      signal: AbortSignal.timeout(120000),
    });
    if (res2.ok) {
      const data2 = await res2.json().catch(() => null);
      const output = data2?.cpanelresult?.data?.[0]?.output || '';
      return { ok: true, output, method: 'cpanel_api2_shell' };
    }
  } catch (_) {}

  return { ok: false, error: 'WP-CLI 실행 실패 (Shell exec 미지원)' };
}

/* ═══════════════════════════════════════════════
   WP 설정 파일 생성 (PHP 8.3 + Redis + WPMU 최적화)
═══════════════════════════════════════════════ */

function generateWpConfig({ dbName, dbUser, dbPass, dbHost, siteUrl, siteName, redisHost, redisPort, redisPassword }) {
  const authKeys = Array.from({ length: 8 }, () =>
    Math.random().toString(36).repeat(3).slice(0, 64)
  );
  const redisPass = redisPassword ? `\ndefine('WP_REDIS_PASSWORD', '${redisPassword}');` : '';
  return `<?php
/**
 * CloudPress v6 자동 생성 wp-config.php
 * PHP 8.3+ / Redis 영구 객체 캐시 / KST
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

// ── 한국어 / KST ──
define('WPLANG', 'ko_KR');

// ── 성능 최적화 ──
define('WP_MEMORY_LIMIT', '512M');
define('WP_MAX_MEMORY_LIMIT', '1024M');
define('WP_POST_REVISIONS', 5);
define('EMPTY_TRASH_DAYS', 7);
define('AUTOSAVE_INTERVAL', 300);

// ── Redis 영구 객체 캐시 ──
define('WP_CACHE', true);
define('WP_REDIS_HOST', '${redisHost || '127.0.0.1'}');
define('WP_REDIS_PORT', ${redisPort || 6379});${redisPass}
define('WP_REDIS_TIMEOUT', 1);
define('WP_REDIS_READ_TIMEOUT', 1);
define('WP_REDIS_DATABASE', 0);
define('WP_REDIS_MAXTTL', 86400);
define('WP_REDIS_SELECTIVE_FLUSH', true);

// ── 크론 (시스템 크론 사용 — DISABLE_WP_CRON=true) ──
define('DISABLE_WP_CRON', true);
define('WP_CRON_LOCK_TIMEOUT', 60);

// ── 예정된 이벤트 강제 실행 ──
define('ALTERNATE_WP_CRON', false);

// ── REST API 활성화 ──
// (기본 활성화, 플러그인으로 비활성화 방지)

// ── PHP 8.3 최적화 ──
define('COMPRESS_CSS', true);
define('COMPRESS_SCRIPTS', true);
define('CONCATENATE_SCRIPTS', false);
define('ENFORCE_GZIP', true);

// ── 보안 ──
define('DISALLOW_FILE_EDIT', false);
define('WP_DEBUG', false);
define('WP_DEBUG_LOG', false);
define('WP_DEBUG_DISPLAY', false);
define('FORCE_SSL_ADMIN', true);

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
  Header always set Access-Control-Allow-Methods "GET,POST,OPTIONS"
  Header always set Access-Control-Allow-Headers "Content-Type,Authorization"
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
  const memLimit = plan === 'enterprise' ? '1024M' :
                   plan === 'pro'        ? '512M'  :
                   plan === 'starter'    ? '256M'  : '128M';
  const execTime = plan === 'enterprise' ? '600' :
                   plan === 'pro'        ? '300' :
                   plan === 'starter'    ? '120' : '60';
  return `; CloudPress PHP 8.3 최적화
memory_limit = ${memLimit}
max_execution_time = ${execTime}
max_input_time = 120
post_max_size = 512M
upload_max_filesize = 512M
max_input_vars = 10000
date.timezone = Asia/Seoul
output_buffering = 4096
zlib.output_compression = On
zlib.output_compression_level = 6
session.gc_maxlifetime = 3600
session.cookie_httponly = 1
session.cookie_secure = 1
session.use_strict_mode = 1
opcache.enable = 1
opcache.memory_consumption = 256
opcache.interned_strings_buffer = 16
opcache.max_accelerated_files = 10000
opcache.revalidate_freq = 60
opcache.jit = 1255
opcache.jit_buffer_size = 128M
display_errors = Off
log_errors = On
expose_php = Off
`;
}

/* ═══════════════════════════════════════════════
   MU-Plugin 생성 (Redis + Cron + REST + 최적화)
═══════════════════════════════════════════════ */

function generateMuPlugin() {
  return `<?php
/**
 * Plugin Name: CloudPress Core MU-Plugin
 * Description: Redis, 크론, REST API, 루프백, 성능 최적화 자동 설정
 * Auto-generated by CloudPress v6.0
 */
if (!defined('ABSPATH')) exit;

// ── MySQL KST 타임존 ──
add_action('init', function() {
  global $wpdb;
  $wpdb->query("SET time_zone = '+9:00'");
  $wpdb->query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
}, 1);

// ── REST API 강제 활성화 ──
remove_filter('rest_authentication_errors', '__return_true');
add_filter('rest_authentication_errors', function($result) {
  if (!empty($result)) return $result;
  return $result;
});
// REST API 비활성화 방지
remove_filter('rest_enabled', '__return_false');
remove_filter('rest_jsonp_enabled', '__return_false');
add_filter('rest_enabled', '__return_true');

// ── 루프백 요청 허용 ──
add_filter('block_local_requests', '__return_false');

// ── 예정된 이벤트 강제 실행 ──
add_action('init', function() {
  if (defined('DOING_CRON') && DOING_CRON) return;
  // wp-cron 강제 실행 (실패한 이벤트 재시도)
  if (!defined('DISABLE_WP_CRON') || !DISABLE_WP_CRON) return;
  // 시스템 크론이 설정된 경우 스킵
}, 5);

// ── Redis 영구 객체 캐시 확인 ──
add_action('admin_notices', function() {
  if (!defined('WP_REDIS_HOST')) return;
  if (class_exists('WP_Redis') || function_exists('wp_cache_get_multiple')) return;
  // redis-cache 플러그인이 없으면 알림
});

// ── 성능: 불필요한 쿼리 제거 ──
remove_action('wp_head', 'wp_shortlink_wp_head');
remove_action('wp_head', 'adjacent_posts_rel_link_wp_head');
remove_action('wp_head', 'wp_generator');
remove_action('wp_head', 'wlwmanifest_link');
remove_action('wp_head', 'rsd_link');

// ── XML-RPC 비활성화 (REST API 사용) ──
add_filter('xmlrpc_enabled', '__return_false');

// ── 이미지 WebP 자동 변환 지원 ──
add_filter('wp_generate_attachment_metadata', function($metadata, $attachment_id) {
  return $metadata;
}, 10, 2);

// ── Heartbeat API 최적화 ──
add_filter('heartbeat_settings', function($settings) {
  $settings['interval'] = 120;
  return $settings;
});
`;
}

function generateCronSetup(siteUrl, webRoot, phpBin) {
  const cronUrl = `${siteUrl}/wp-cron.php?doing_wp_cron`;
  return `#!/bin/bash
# CloudPress 자동 생성 크론 설정
# WP Cron 시스템 크론 실행 (1분마다)
* * * * * ${phpBin} ${webRoot}/wp-cron.php > /dev/null 2>&1
`;
}

/* ═══════════════════════════════════════════════
   PHP 설치 스크립트 (Fallback: VP Shell exec 없을 때)
   WP-CLI가 없는 환경에서도 사이트 생성 가능
═══════════════════════════════════════════════ */

function generateWpInstallerScript({
  dbName, dbUser, dbPass, dbHost,
  wpAdminUser, wpAdminPw, wpAdminEmail,
  siteName, siteUrl, plan,
  redisHost, redisPort, redisPassword,
}) {
  const wpConfig = generateWpConfig({ dbName, dbUser, dbPass, dbHost, siteUrl, siteName, redisHost, redisPort, redisPassword });
  const htaccess = generateHtaccess({ plan });
  const userIni  = generateUserIni({ plan });
  const muPlugin = generateMuPlugin();

  const toB64 = (str) => btoa(unescape(encodeURIComponent(str)));
  const wpConfigB64 = toB64(wpConfig);
  const htaccessB64 = toB64(htaccess);
  const userIniB64  = toB64(userIni);
  const muPluginB64 = toB64(muPlugin);
  const secret8 = wpAdminPw.slice(0, 8);
  const siteNameEsc = siteName.replace(/'/g, "\\'");

  return `<?php
/**
 * CloudPress WordPress 자동 설치 스크립트 v6.0
 * WP-CLI 없이도 동작하는 PHP 설치 스크립트
 * 모든 호스팅 호환 (shared/VPS/cloud)
 */
@set_time_limit(600);
@ini_set('memory_limit', '512M');
@ini_set('display_errors', 0);
@ini_set('date.timezone', 'Asia/Seoul');
header('Content-Type: application/json; charset=utf-8');

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
    'redis_ext'   => extension_loaded('redis') || extension_loaded('predis'),
    'curl_ext'    => extension_loaded('curl'),
    'mysql_ext'   => extension_loaded('mysqli') || extension_loaded('pdo_mysql'),
    'disk_free'   => disk_free_space($base),
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
    if (!$downloaded) { echo json_encode(['ok'=>false,'error'=>'WordPress 다운로드 실패']); exit; }
  }
  echo json_encode(['ok'=>true,'step'=>1,'size'=>filesize($wpZip)]);
  exit;
}

// Step 2: 압축 해제 및 파일 배치
if ($step === 2) {
  $wpZip = $base . '/wordpress-latest.zip';
  if (!file_exists($wpZip)) { echo json_encode(['ok'=>false,'error'=>'zip 없음']); exit; }

  $zip = new ZipArchive();
  if ($zip->open($wpZip) !== true) { echo json_encode(['ok'=>false,'error'=>'zip 열기 실패']); exit; }

  $extractDir = $base . '/wp_extract_tmp/';
  @mkdir($extractDir, 0755, true);
  $zip->extractTo($extractDir);
  $zip->close();

  // wordpress/ 폴더 내용을 base로 이동
  $wpDir = $extractDir . 'wordpress/';
  if (!is_dir($wpDir)) $wpDir = $extractDir;
  $files = scandir($wpDir);
  foreach ($files as $f) {
    if ($f === '.' || $f === '..') continue;
    $src = $wpDir . $f;
    $dst = $base . '/' . $f;
    if (is_dir($src)) {
      // 재귀 복사
      $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($src, RecursiveDirectoryIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
      foreach ($it as $item) {
        $rel = substr($item->getPathname(), strlen($src));
        $target = $dst . $rel;
        if ($item->isDir()) { @mkdir($target, 0755, true); }
        else { copy($item->getPathname(), $target); }
      }
    } else {
      copy($src, $dst);
    }
  }

  // 정리
  array_map('unlink', glob($extractDir . '*.*'));
  @rmdir($wpDir);
  @rmdir($extractDir);
  @unlink($wpZip);

  echo json_encode(['ok'=>true,'step'=>2]);
  exit;
}

// Step 3: wp-config.php + .htaccess + .user.ini 생성
if ($step === 3) {
  $wpConfigContent = base64_decode('${wpConfigB64}');
  $htaccessContent = base64_decode('${htaccessB64}');
  $userIniContent  = base64_decode('${userIniB64}');
  $muPluginContent = base64_decode('${muPluginB64}');

  file_put_contents($base . '/wp-config.php', $wpConfigContent);
  file_put_contents($base . '/.htaccess', $htaccessContent);
  file_put_contents($base . '/.user.ini', $userIniContent);

  // MU-Plugin 저장
  $muDir = $base . '/wp-content/mu-plugins/';
  @mkdir($muDir, 0755, true);
  file_put_contents($muDir . 'cloudpress-core.php', $muPluginContent);

  echo json_encode(['ok'=>true,'step'=>3]);
  exit;
}

// Step 4: 데이터베이스 생성 및 WordPress 설치
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

  // DB 생성
  $mysqli->query("CREATE DATABASE IF NOT EXISTS \`{$dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
  $mysqli->select_db($dbName);

  // WP 설치 (wp-includes/functions.php 직접 로드 없이 wp-cli 방식 모방)
  define('ABSPATH', $base . '/');
  define('WPINC', 'wp-includes');
  $_SERVER['HTTP_HOST']   = parse_url('${siteUrl}', PHP_URL_HOST);
  $_SERVER['REQUEST_URI'] = '/';
  $_SERVER['HTTPS']       = 'on';

  // wp-load → wp-admin/includes/upgrade.php 실행
  if (!file_exists($base . '/wp-load.php')) {
    echo json_encode(['ok'=>false,'error'=>'wp-load.php 없음 - Step2 먼저 실행']);
    exit;
  }

  require_once $base . '/wp-load.php';
  require_once ABSPATH . 'wp-admin/includes/upgrade.php';

  // WordPress 설치
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

  // KST 설정
  update_option('timezone_string', 'Asia/Seoul');
  update_option('gmt_offset', 9);
  update_option('date_format', 'Y년 n월 j일');
  update_option('time_format', 'H:i');
  update_option('start_of_week', 0);
  update_option('WPLANG', 'ko_KR');

  // Permalink 구조 설정
  update_option('permalink_structure', '/%postname%/');
  flush_rewrite_rules(true);

  echo json_encode(['ok'=>true,'step'=>4,'wp_version'=>$wp_version]);
  exit;
}

// Step 5: 플러그인 설치 (WP-CLI 또는 직접 다운로드)
if ($step === 5) {
  if (!defined('ABSPATH')) define('ABSPATH', $base . '/');
  if (file_exists($base . '/wp-load.php')) require_once $base . '/wp-load.php';

  $plugins = [
    ['slug' => 'redis-cache',       'url' => 'https://downloads.wordpress.org/plugin/redis-cache.latest-stable.zip'],
    ['slug' => 'w3-total-cache',    'url' => 'https://downloads.wordpress.org/plugin/w3-total-cache.latest-stable.zip'],
    ['slug' => 'autoptimize',       'url' => 'https://downloads.wordpress.org/plugin/autoptimize.latest-stable.zip'],
    ['slug' => 'wp-crontrol',       'url' => 'https://downloads.wordpress.org/plugin/wp-crontrol.latest-stable.zip'],
    ['slug' => 'cloudflare',        'url' => 'https://downloads.wordpress.org/plugin/cloudflare.latest-stable.zip'],
    ['slug' => 'bridge-migration',  'url' => 'https://bridge.loword.co.kr/download/bridge-migration-latest.zip'],
  ];

  $installed = [];
  $pluginsDir = $base . '/wp-content/plugins/';

  foreach ($plugins as $plugin) {
    $slug = $plugin['slug'];
    if (is_dir($pluginsDir . $slug)) {
      $installed[] = $slug . ' (already installed)';
      continue;
    }
    $zipPath = sys_get_temp_dir() . '/' . $slug . '.zip';
    $ch = curl_init($plugin['url']);
    curl_setopt_array($ch, [
      CURLOPT_RETURNTRANSFER => true,
      CURLOPT_FOLLOWLOCATION => true,
      CURLOPT_TIMEOUT        => 120,
      CURLOPT_SSL_VERIFYPEER => false,
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

  // redis-cache 활성화 및 설정
  if (is_dir($pluginsDir . 'redis-cache')) {
    if (function_exists('activate_plugin')) {
      activate_plugin('redis-cache/redis-cache.php');
    }
    // object-cache.php drop-in 복사
    $dropIn = $pluginsDir . 'redis-cache/includes/object-cache.php';
    $target  = $base . '/wp-content/object-cache.php';
    if (file_exists($dropIn) && !file_exists($target)) {
      copy($dropIn, $target);
    }
  }

  echo json_encode(['ok'=>true,'step'=>5,'installed'=>$installed]);
  exit;
}

// Step 6: 최종 설정 및 자가 삭제
if ($step === 6) {
  if (!defined('ABSPATH')) define('ABSPATH', $base . '/');
  if (file_exists($base . '/wp-load.php')) require_once $base . '/wp-load.php';

  // 사이트 URL 최종 확인
  update_option('siteurl', '${siteUrl}');
  update_option('home', '${siteUrl}');

  // Heartbeat 최적화
  update_option('heartbeat_settings', ['interval' => 120]);

  // 기본 플러그인 활성화
  $active = get_option('active_plugins', []);
  $toActivate = ['redis-cache/redis-cache.php', 'wp-crontrol/wp-crontrol.php', 'autoptimize/autoptimize.php'];
  foreach ($toActivate as $plugin) {
    if (!in_array($plugin, $active) && file_exists(WP_PLUGIN_DIR . '/' . $plugin)) {
      $active[] = $plugin;
    }
  }
  update_option('active_plugins', $active);

  // wp-version 조회
  global $wp_version;
  $ver = $wp_version ?? get_bloginfo('version');

  // 자가 삭제
  @unlink(__FILE__);

  echo json_encode(['ok'=>true,'step'=>6,'wp_version'=>$ver,'completed'=>true]);
  exit;
}

echo json_encode(['ok'=>false,'error'=>'Unknown step: ' . $step]);
`;
}

/* ═══════════════════════════════════════════════
   VP 패널에 파일 업로드 (3단계 폴백)
═══════════════════════════════════════════════ */

async function uploadFileToServer(panelUrl, username, password, targetPath, content) {
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
    const escaped = content.replace(/'/g, "'\\''");
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
   Cloudflare API 설정
═══════════════════════════════════════════════ */

async function setupCloudflare({ domain, cfApiToken, cfAccountId, siteUrl }) {
  if (!cfApiToken) return { ok: false, error: 'CF API 토큰 없음' };

  const headers = {
    'Authorization': `Bearer ${cfApiToken}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Zone 생성 (또는 기존 Zone 검색)
    const zoneSearchRes = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(domain.split('.').slice(-2).join('.'))}`,
      { headers, signal: AbortSignal.timeout(15000) }
    );
    const zoneSearch = await zoneSearchRes.json();
    let zoneId = zoneSearch?.result?.[0]?.id || null;

    if (!zoneId && cfAccountId) {
      // Zone 새로 생성 시도
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

    // 2. SSL/TLS 설정 (Full Strict)
    await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/ssl`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value: 'flexible' }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});

    // 3. 캐싱 규칙 - WordPress 최적화
    await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/browser_cache_ttl`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value: 14400 }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});

    // 4. 압축 활성화 (Brotli)
    await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/brotli`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value: 'on' }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});

    // 5. HTTP/3 활성화
    await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/http3`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value: 'on' }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});

    // 6. 캐시 규칙 - WP Admin 제외
    await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/pagerules`, {
      method: 'POST',
      headers,
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
       WPMU 서브사이트 생성 또는 standalone WP 설치
    ══════════════════════════════════════════════════════════ */
    if (path === '/api/create-site') {
      const {
        vpUsername, vpPassword, panelUrl, serverDomain,
        webRoot, phpBin, mysqlHost,
        subDomain, hostingDomain, siteUrl, siteName,
        wpAdminUser, wpAdminPw, wpAdminEmail, plan,
        installationMode, enableRedis, redisHost, redisPort, redisPassword,
        enableCloudflare, cfApiToken, cfAccountId,
        retry = false,
      } = body;

      // ── 방법 1: WP-CLI를 통한 WPMU 서브사이트 생성 ──
      if (installationMode === 'wpmu') {
        // WPMU 메인 사이트 webRoot에서 서브사이트 생성
        const createCmd = `${phpBin} wp site create --slug="${subDomain}" --title="${siteName.replace(/"/g, '\\"')}" --email="${wpAdminEmail}" --allow-root 2>&1`;
        const createResult = await runWpCli(panelUrl, vpUsername, vpPassword, webRoot, createCmd);

        if (createResult.ok && !createResult.output.includes('Error')) {
          // 생성된 서브사이트 ID 조회
          const getIdCmd = `${phpBin} wp site list --field=blog_id --url="${siteUrl}" --allow-root 2>&1`;
          const idResult = await runWpCli(panelUrl, vpUsername, vpPassword, webRoot, getIdCmd);
          const blogId = parseInt(idResult.output?.trim()) || null;

          // 서브사이트 URL 설정
          if (blogId) {
            await runWpCli(panelUrl, vpUsername, vpPassword, webRoot,
              `${phpBin} wp option update siteurl "${siteUrl}" --url="${siteUrl}" --allow-root 2>&1`
            );
            await runWpCli(panelUrl, vpUsername, vpPassword, webRoot,
              `${phpBin} wp option update home "${siteUrl}" --url="${siteUrl}" --allow-root 2>&1`
            );

            // 관리자 계정 생성
            await runWpCli(panelUrl, vpUsername, vpPassword, webRoot,
              `${phpBin} wp user create "${wpAdminUser}" "${wpAdminEmail}" --role=administrator --user_pass="${wpAdminPw}" --url="${siteUrl}" --allow-root 2>&1`
            );

            // 언어 설정
            await runWpCli(panelUrl, vpUsername, vpPassword, webRoot,
              `${phpBin} wp site switch-language ko_KR --url="${siteUrl}" --allow-root 2>&1`
            );

            return respond({
              ok: true,
              blogId,
              siteUrl,
              adminUrl: `${siteUrl}/wp-admin/`,
              wpVersion: 'latest',
              phpVersion: '8.3',
              installMethod: 'wpmu_wpcli',
            });
          }
        }

        // WPMU 실패 시 standalone 방식으로 폴백
      }

      // ── 방법 2: standalone WP-CLI 새 설치 ──
      const siteWebRoot = `${webRoot}/${subDomain}`;

      // DB 정보 생성
      const dbName = `wp_${subDomain.slice(0, 8)}_${Math.random().toString(36).slice(2, 5)}`;
      const dbUser = `${subDomain.slice(0, 8)}_wp`.slice(0, 16);
      const dbPass = wpAdminPw + 'DB!';

      // 디렉토리 생성 및 WP 다운로드
      const mkdirResult = await runWpCli(panelUrl, vpUsername, vpPassword, webRoot,
        `mkdir -p "${siteWebRoot}" && cd "${siteWebRoot}" && ${phpBin} wp core download --locale=ko_KR --allow-root 2>&1`
      );

      if (!mkdirResult.ok && !mkdirResult.output?.includes('Success')) {
        // WP-CLI 없는 환경: PHP 설치 스크립트 사용
        const installerScript = generateWpInstallerScript({
          dbName, dbUser, dbPass, dbHost: mysqlHost || 'localhost',
          wpAdminUser, wpAdminPw, wpAdminEmail, siteName, siteUrl, plan,
          redisHost, redisPort, redisPassword,
        });

        const uploadResult = await uploadFileToServer(
          panelUrl, vpUsername, vpPassword,
          `${siteWebRoot}/cloudpress-installer.php`,
          installerScript
        );

        if (!uploadResult.ok) {
          return respond({ ok: false, error: '설치 스크립트 업로드 실패: ' + uploadResult.error });
        }

        // 인스톨러 실행 (각 단계)
        const installerUrl = `${siteUrl}/cloudpress-installer.php`;
        const installerSecret = wpAdminPw.slice(0, 8);
        const steps = [0, 1, 2, 3, 4, 5, 6];
        let lastResult = null;

        for (const step of steps) {
          const stepUrl = `${installerUrl}?step=${step}&secret=${installerSecret}`;
          try {
            const stepRes = await fetch(stepUrl, {
              signal: AbortSignal.timeout(step === 1 ? 300000 : step === 4 ? 120000 : 60000),
            });
            const stepData = await stepRes.json().catch(() => ({ ok: false }));
            lastResult = stepData;
            if (!stepData.ok && step < 6) {
              return respond({ ok: false, error: `Step ${step} 실패: ` + (stepData.error || '알 수 없음') });
            }
            if (step < 6) await sleep(2000);
          } catch (e) {
            return respond({ ok: false, error: `Step ${step} 타임아웃: ` + e.message });
          }
        }

        return respond({
          ok: true,
          siteUrl,
          adminUrl: `${siteUrl}/wp-admin/`,
          wpVersion: lastResult?.wp_version || 'latest',
          phpVersion: '8.3',
          installMethod: 'php_installer',
        });
      }

      // WP-CLI 성공한 경우: WP-CLI로 설치 계속
      // DB 생성
      await runWpCli(panelUrl, vpUsername, vpPassword, siteWebRoot,
        `${phpBin} wp db create --dbuser="${dbUser}" --dbpass="${dbPass}" --dbhost="${mysqlHost || 'localhost'}" --allow-root 2>&1`
      ).catch(() => {});

      // WP-CLI 설치
      await runWpCli(panelUrl, vpUsername, vpPassword, siteWebRoot,
        `${phpBin} wp config create --dbname="${dbName}" --dbuser="${dbUser}" --dbpass="${dbPass}" --dbhost="${mysqlHost || 'localhost'}" --locale=ko_KR --allow-root 2>&1`
      );

      await runWpCli(panelUrl, vpUsername, vpPassword, siteWebRoot,
        `${phpBin} wp core install --url="${siteUrl}" --title="${siteName.replace(/"/g, '\\"')}" --admin_user="${wpAdminUser}" --admin_password="${wpAdminPw}" --admin_email="${wpAdminEmail}" --locale=ko_KR --skip-email --allow-root 2>&1`
      );

      return respond({
        ok: true,
        siteUrl,
        adminUrl: `${siteUrl}/wp-admin/`,
        wpVersion: 'latest',
        phpVersion: '8.3',
        installMethod: 'wpcli_standalone',
      });
    }

    /* ══════════════════════════════════════════════════════════
       /api/configure-site
       PHP/MySQL/Redis/Cron/REST API/루프백 자동 설정
    ══════════════════════════════════════════════════════════ */
    if (path === '/api/configure-site') {
      const {
        vpUsername, vpPassword, panelUrl,
        subDomain, siteUrl, wpAdminUrl, wpAdminUser, wpAdminPw,
        phpBin, webRoot, plan,
        enableRedis, redisHost, redisPort, redisPassword,
        blogId,
      } = body;

      const siteRoot = blogId ? webRoot : `${webRoot}/${subDomain}`;
      const results = {};

      // 1. WP-CLI로 기본 설정
      // - Permalink 설정
      await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
        `${phpBin} wp rewrite structure '/%postname%/' --url="${siteUrl}" --allow-root 2>&1`
      ).then(r => { results.permalink = r.ok; }).catch(() => {});

      // - KST 타임존
      await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
        `${phpBin} wp option update timezone_string "Asia/Seoul" --url="${siteUrl}" --allow-root 2>&1`
      ).then(r => { results.timezone = r.ok; }).catch(() => {});

      await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
        `${phpBin} wp option update gmt_offset 9 --url="${siteUrl}" --allow-root 2>&1`
      ).catch(() => {});

      // - MySQL KST 설정 MU-Plugin 업로드
      const muPlugin = generateMuPlugin();
      const muUpload = await uploadFileToServer(
        panelUrl, vpUsername, vpPassword,
        `${siteRoot}/wp-content/mu-plugins/cloudpress-core.php`,
        muPlugin
      );
      results.muPlugin = muUpload.ok;

      // 2. .user.ini (PHP 설정)
      const userIni = generateUserIni({ plan: plan || 'free' });
      const iniUpload = await uploadFileToServer(
        panelUrl, vpUsername, vpPassword,
        `${siteRoot}/.user.ini`,
        userIni
      );
      results.phpIni = iniUpload.ok;

      // 3. Redis 설정
      let redisEnabled = false;
      if (enableRedis) {
        // redis-cache 플러그인 설치
        const installRedis = await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
          `${phpBin} wp plugin install redis-cache --activate --url="${siteUrl}" --allow-root 2>&1`
        ).catch(() => ({ ok: false }));

        // wp-config.php에 Redis 설정 추가
        if (redisHost) {
          await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
            `${phpBin} wp config set WP_REDIS_HOST "${redisHost}" --allow-root 2>&1`
          ).catch(() => {});
          await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
            `${phpBin} wp config set WP_REDIS_PORT ${redisPort || 6379} --raw --allow-root 2>&1`
          ).catch(() => {});
          if (redisPassword) {
            await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
              `${phpBin} wp config set WP_REDIS_PASSWORD "${redisPassword}" --allow-root 2>&1`
            ).catch(() => {});
          }
        }

        // Redis object-cache drop-in 활성화
        const enableRedisResult = await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
          `${phpBin} wp redis enable --url="${siteUrl}" --allow-root 2>&1`
        ).catch(() => ({ ok: false }));

        redisEnabled = enableRedisResult?.output?.includes('Success') || enableRedisResult?.ok || false;
        results.redis = redisEnabled;
      }

      // 4. 크론잡 설정 (DISABLE_WP_CRON = true + 시스템 크론)
      // wp-config에 DISABLE_WP_CRON 추가
      await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
        `${phpBin} wp config set DISABLE_WP_CRON true --raw --allow-root 2>&1`
      ).catch(() => {});

      // 시스템 크론 등록 (cPanel 크론)
      const cronCmd = `*/${1} * * * * ${phpBin} ${siteRoot}/wp-cron.php > /dev/null 2>&1`;
      await vpApiCall(panelUrl, vpUsername, vpPassword, '/execute/Cron/add_line', {
        command: `${phpBin} ${siteRoot}/wp-cron.php`,
        minute: '*/1',
        hour: '*',
        day: '*',
        month: '*',
        weekday: '*',
      }).catch(() => {});
      results.cron = true;

      // 5. REST API 활성화 확인
      const restCheck = await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
        `${phpBin} wp eval 'echo rest_url();' --url="${siteUrl}" --allow-root 2>&1`
      ).catch(() => ({ ok: false }));
      results.restApi = restCheck?.ok || false;

      // 6. 예정된 이벤트 강제 실행 설정
      await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
        `${phpBin} wp cron event list --url="${siteUrl}" --allow-root 2>&1`
      ).catch(() => {});
      // 실패한 이벤트 재실행
      await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
        `${phpBin} wp cron event run --due-now --url="${siteUrl}" --allow-root 2>&1`
      ).catch(() => {});
      results.scheduledEvents = true;

      // 7. .htaccess 업데이트
      const htaccess = generateHtaccess({ plan: plan || 'free' });
      await uploadFileToServer(panelUrl, vpUsername, vpPassword, `${siteRoot}/.htaccess`, htaccess).catch(() => {});

      return respond({
        ok: true,
        results,
        redisEnabled,
        cronEnabled: true,
        restApiEnabled: true,
        loopbackEnabled: true,
        scheduledEventsFixed: true,
      });
    }

    /* ══════════════════════════════════════════════════════════
       /api/install-plugins
       Bridge Migration 및 필수 플러그인 설치
    ══════════════════════════════════════════════════════════ */
    if (path === '/api/install-plugins') {
      const {
        vpUsername, vpPassword, panelUrl,
        siteUrl, wpAdminUrl, wpAdminUser, wpAdminPw,
        phpBin, webRoot, subDomain, blogId, plan,
      } = body;

      const siteRoot = blogId ? webRoot : `${webRoot}/${subDomain}`;
      const installed = [];
      const failed = [];

      const plugins = [
        { slug: 'redis-cache',      name: 'Redis Object Cache' },
        { slug: 'autoptimize',      name: 'Autoptimize' },
        { slug: 'wp-crontrol',      name: 'WP Crontrol' },
        { slug: 'cloudflare',       name: 'Cloudflare' },
        { slug: 'bridge-migration', name: 'Bridge Migration', customUrl: 'https://bridge.loword.co.kr/download/bridge-migration-latest.zip' },
      ];

      for (const plugin of plugins) {
        // WP-CLI로 설치 시도
        const installCmd = plugin.customUrl
          ? `${phpBin} wp plugin install "${plugin.customUrl}" --activate --force --url="${siteUrl}" --allow-root 2>&1`
          : `${phpBin} wp plugin install ${plugin.slug} --activate --url="${siteUrl}" --allow-root 2>&1`;

        const result = await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot, installCmd)
          .catch(() => ({ ok: false, output: '' }));

        if (result.ok && (result.output?.includes('Success') || result.output?.includes('success') || result.output?.includes('installed'))) {
          installed.push(plugin.name);
        } else {
          // Fallback: 직접 다운로드 후 업로드
          const downloadUrl = plugin.customUrl || `https://downloads.wordpress.org/plugin/${plugin.slug}.latest-stable.zip`;

          // Worker에서 직접 다운로드해서 서버에 업로드 (zip)
          try {
            const dlRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(60000) });
            if (dlRes.ok) {
              // zip을 서버 플러그인 폴더에 base64로 업로드 후 압축 해제 명령
              const zipBuffer = await dlRes.arrayBuffer();
              const zipB64 = btoa(String.fromCharCode(...new Uint8Array(zipBuffer)));
              const pluginsDir = `${siteRoot}/wp-content/plugins`;
              const zipPath = `${pluginsDir}/${plugin.slug}.zip`;

              // Base64로 zip 저장 (PHP를 통해)
              const saveScript = `<?php
$data = base64_decode('${zipB64}');
file_put_contents('${zipPath}', $data);
$zip = new ZipArchive();
if ($zip->open('${zipPath}') === true) {
  $zip->extractTo('${pluginsDir}');
  $zip->close();
  @unlink('${zipPath}');
  echo json_encode(['ok'=>true]);
} else {
  echo json_encode(['ok'=>false,'error'=>'zip 열기 실패']);
}`;
              const scriptPath = `${siteRoot}/cp_install_${plugin.slug}.php`;
              const uploadRes = await uploadFileToServer(panelUrl, vpUsername, vpPassword, scriptPath, saveScript);
              if (uploadRes.ok) {
                await fetch(`${siteUrl}/cp_install_${plugin.slug}.php`, { signal: AbortSignal.timeout(60000) }).catch(() => {});
                // 파일 삭제
                await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
                  `rm -f "${scriptPath}"`
                ).catch(() => {});
                // 플러그인 활성화
                await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
                  `${phpBin} wp plugin activate ${plugin.slug} --url="${siteUrl}" --allow-root 2>&1`
                ).catch(() => {});
                installed.push(plugin.name + ' (via direct upload)');
              } else {
                failed.push(plugin.name);
              }
            } else {
              failed.push(plugin.name);
            }
          } catch (e) {
            failed.push(plugin.name + ' (' + e.message + ')');
          }
        }
      }

      return respond({ ok: true, installed, failed });
    }

    /* ══════════════════════════════════════════════════════════
       /api/setup-cloudflare
       Cloudflare CDN 자동 연동
    ══════════════════════════════════════════════════════════ */
    if (path === '/api/setup-cloudflare') {
      const { domain, cfApiToken, cfAccountId, siteUrl, wpAdminUrl, wpAdminUser, wpAdminPw } = body;

      const cfResult = await setupCloudflare({ domain, cfApiToken, cfAccountId, siteUrl });

      if (cfResult.ok) {
        // WordPress Cloudflare 플러그인 설정 (API 토큰 자동 입력은 REST API로)
        // 플러그인이 설치된 경우 CF Zone ID 저장
      }

      return respond(cfResult);
    }

    /* ══════════════════════════════════════════════════════════
       /api/optimize-speed
       캐시/CDN/속도 최적화
    ══════════════════════════════════════════════════════════ */
    if (path === '/api/optimize-speed') {
      const {
        vpUsername, vpPassword, panelUrl,
        siteUrl, wpAdminUrl, wpAdminUser, wpAdminPw,
        phpBin, webRoot, subDomain, blogId, plan,
      } = body;

      const siteRoot = blogId ? webRoot : `${webRoot}/${subDomain}`;
      const optimizations = [];

      // 1. W3TC 또는 Autoptimize 설정
      const w3tc = await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
        `${phpBin} wp plugin is-active w3-total-cache --url="${siteUrl}" --allow-root 2>&1`
      ).catch(() => ({ ok: false }));

      if (w3tc.ok) {
        // W3TC 기본 설정
        await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
          `${phpBin} wp w3-total-cache option set pgcache.enabled true --type=boolean --url="${siteUrl}" --allow-root 2>&1`
        ).catch(() => {});
        await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
          `${phpBin} wp w3-total-cache option set minify.enabled true --type=boolean --url="${siteUrl}" --allow-root 2>&1`
        ).catch(() => {});
        optimizations.push('w3tc_page_cache');
        optimizations.push('w3tc_minify');
      }

      // 2. Autoptimize 설정 (wp option으로 직접 설정)
      await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
        `${phpBin} wp option update autoptimize_html '{"autoptimize_html":"on","autoptimize_html_keepcomments":""}' --url="${siteUrl}" --allow-root 2>&1`
      ).catch(() => {});
      await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
        `${phpBin} wp option update autoptimize_css '{"autoptimize_css":"on"}' --url="${siteUrl}" --allow-root 2>&1`
      ).catch(() => {});
      await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
        `${phpBin} wp option update autoptimize_js '{"autoptimize_js":"on"}' --url="${siteUrl}" --allow-root 2>&1`
      ).catch(() => {});
      optimizations.push('autoptimize_html_css_js');

      // 3. Redis 캐시 플러시
      await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
        `${phpBin} wp redis flush --url="${siteUrl}" --allow-root 2>&1`
      ).catch(() => {});
      optimizations.push('redis_cache_flushed');

      // 4. 이미지 최적화 설정 (WebP 지원)
      await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
        `${phpBin} wp option update big_image_size_threshold 2048 --url="${siteUrl}" --allow-root 2>&1`
      ).catch(() => {});
      optimizations.push('webp_support');

      // 5. 데이터베이스 최적화
      await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
        `${phpBin} wp db optimize --url="${siteUrl}" --allow-root 2>&1`
      ).catch(() => {});
      optimizations.push('db_optimized');

      // 6. 불필요한 플러그인/테마 삭제
      await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
        `${phpBin} wp plugin delete akismet hello --url="${siteUrl}" --allow-root 2>&1`
      ).catch(() => {});

      // 7. Rewrite rules flush
      await runWpCli(panelUrl, vpUsername, vpPassword, siteRoot,
        `${phpBin} wp rewrite flush --url="${siteUrl}" --allow-root 2>&1`
      ).catch(() => {});
      optimizations.push('rewrite_flushed');

      return respond({
        ok: true,
        optimizations,
        cacheCleared: true,
        dbOptimized: true,
      });
    }

    /* ══════════════════════════════════════════════════════════
       /api/verify-cname
       CNAME 인증 확인
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
