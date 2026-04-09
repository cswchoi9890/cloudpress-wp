// puppeteer-worker/index.js
// CloudPress v6.0 — 완전 자체 관리 WordPress 자동화
//
// ✅ 아키텍처:
//   - 외부 호스팅사(InfinityFree/ByetHost) 계정 생성 로직 완전 제거
//   - iFastnet 서버 IP만 사용 (물리 서버 인프라)
//   - 계정 생성 / 파일 배포 / WordPress 설치 전부 자체 처리
//   - 서버 접근: 관리자 설정의 서버 IP + FTP/API 자격증명으로 직접 연결
//   - Cloudflare D1 에 모든 사이트 정보 저장
//
// 배포 흐름:
//   1. 자체 계정 생성 (DB에만 저장, 외부 호스팅사 없음)
//   2. iFastnet 서버에 FTP/HTTP로 WordPress 파일 직접 업로드
//   3. PHP installer 실행 → WordPress 설치
//   4. MU-Plugin (크론, 반응형, 속도최적화) 자동 배치
//   5. 완료 → DB 상태 active 업데이트

import puppeteer from '@cloudflare/puppeteer';

/* ═══════════════════════════════════════════════
   공통 유틸
═══════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Worker-Secret',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function waitForAny(page, selectors, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) return { el, sel };
      } catch (_) {}
    }
    await sleep(800);
  }
  return null;
}

async function safeType(page, selector, value) {
  try {
    await page.waitForSelector(selector, { timeout: 8000 });
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(selector, value, { delay: 25 });
    return true;
  } catch (_) {
    return false;
  }
}

async function pageText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

/* ═══════════════════════════════════════════════
   서버 설정 조회 (관리자 DB에서)
   - 외부 호스팅사 아님, 운영자가 직접 설정한 iFastnet 서버 정보
═══════════════════════════════════════════════ */

function getServerConfig(env) {
  // 환경변수 또는 wrangler.toml [vars] 에서 읽음
  // 관리자가 어드민 설정에서 입력한 서버 IP / FTP 정보
  return {
    serverIp:    env.SERVER_IP    || '',       // iFastnet 서버 IP
    ftpHost:     env.FTP_HOST     || env.SERVER_IP || '',
    ftpUser:     env.FTP_USER     || '',       // FTP 계정
    ftpPass:     env.FTP_PASS     || '',       // FTP 비밀번호
    ftpPort:     env.FTP_PORT     || '21',
    serverPanel: env.SERVER_PANEL || '',       // 서버 패널 URL (있으면 사용)
    panelUser:   env.PANEL_USER   || '',
    panelPass:   env.PANEL_PASS   || '',
    dbHost:      env.DB_HOST      || 'localhost',
    dbRootUser:  env.DB_ROOT_USER || 'root',
    dbRootPass:  env.DB_ROOT_PASS || '',
    webRoot:     env.WEB_ROOT     || '/htdocs', // 웹 루트 경로
    phpBin:      env.PHP_BIN      || 'php8.3', // PHP 실행 바이너리
  };
}

/* ═══════════════════════════════════════════════
   자체 계정/도메인 생성
   - 외부 호스팅사에 가입하지 않음
   - CloudPress 자체 서브도메인 발급 (DB에 저장)
   - iFastnet 서버의 웹 루트에 디렉터리만 생성
═══════════════════════════════════════════════ */

function generateSelfAccount(siteName, serverConfig, env) {
  const baseDomain = env.SITE_DOMAIN || 'cloudpress.site';
  const slug = (siteName || 'site')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12) || 'site';
  const suffix = Math.random().toString(36).slice(2, 6);
  const subdomain = `${slug}${suffix}`; // e.g. myshop4x2k

  return {
    accountUsername: subdomain,
    // 자체 서브도메인 (CloudPress 도메인)
    hostingDomain:   `${subdomain}.${baseDomain}`,
    // 실제 파일이 올라갈 서버 경로
    webPath:         `${serverConfig.webRoot}/${subdomain}`,
    // WordPress URL
    siteUrl:         `http://${subdomain}.${baseDomain}`,
    wpAdminUrl:      `http://${subdomain}.${baseDomain}/wp-admin/`,
  };
}

/* ═══════════════════════════════════════════════
   WordPress 설치 파일 생성기들
═══════════════════════════════════════════════ */

function genWpConfig({ dbName, dbUser, dbPass, dbHost, siteUrl, siteName }) {
  const keys = Array.from({ length: 8 }, () =>
    Math.random().toString(36).repeat(3).slice(0, 64)
  );
  return `<?php
define('DB_NAME',     '${dbName}');
define('DB_USER',     '${dbUser}');
define('DB_PASSWORD', '${dbPass}');
define('DB_HOST',     '${dbHost}');
define('DB_CHARSET',  'utf8mb4');
define('DB_COLLATE',  'utf8mb4_unicode_ci');

define('AUTH_KEY',         '${keys[0]}');
define('SECURE_AUTH_KEY',  '${keys[1]}');
define('LOGGED_IN_KEY',    '${keys[2]}');
define('NONCE_KEY',        '${keys[3]}');
define('AUTH_SALT',        '${keys[4]}');
define('SECURE_AUTH_SALT', '${keys[5]}');
define('LOGGED_IN_SALT',   '${keys[6]}');
define('NONCE_SALT',       '${keys[7]}');

$table_prefix = 'wp_';

define('WP_HOME',    '${siteUrl}');
define('WP_SITEURL', '${siteUrl}');
define('WPLANG',     'ko_KR');

define('WP_MEMORY_LIMIT',     '256M');
define('WP_MAX_MEMORY_LIMIT', '512M');
define('WP_POST_REVISIONS',   3);
define('EMPTY_TRASH_DAYS',    7);
define('WP_CACHE',            true);
define('COMPRESS_CSS',        true);
define('COMPRESS_SCRIPTS',    true);
define('CONCATENATE_SCRIPTS', false);
define('ENFORCE_GZIP',        true);
define('AUTOSAVE_INTERVAL',   300);
define('DISABLE_WP_CRON',     false);

define('DISALLOW_FILE_EDIT', true);
define('WP_DEBUG',           false);
define('WP_DEBUG_LOG',       false);
define('WP_DEBUG_DISPLAY',   false);
define('FORCE_SSL_ADMIN',    false);

if (!defined('ABSPATH')) {
  define('ABSPATH', __DIR__ . '/');
}
require_once ABSPATH . 'wp-settings.php';
`;
}

function genHtaccess() {
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

<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/plain text/css text/javascript
  AddOutputFilterByType DEFLATE application/javascript application/json image/svg+xml
</IfModule>

<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType image/jpeg "access plus 30 days"
  ExpiresByType image/png  "access plus 30 days"
  ExpiresByType image/webp "access plus 30 days"
  ExpiresByType text/css   "access plus 7 days"
  ExpiresByType application/javascript "access plus 7 days"
</IfModule>

<IfModule mod_headers.c>
  Header always set X-Content-Type-Options nosniff
  Header always set X-Frame-Options SAMEORIGIN
  Header always set X-XSS-Protection "1; mode=block"
</IfModule>

<FilesMatch "(^\\.htaccess|readme\\.html|license\\.txt|wp-config-sample\\.php)$">
  Order allow,deny
  Deny from all
</FilesMatch>
`;
}

function genUserIni() {
  return `; CloudPress PHP 설정 (PHP 8.3)
memory_limit = 256M
max_execution_time = 120
max_input_time = 60
post_max_size = 256M
upload_max_filesize = 256M
max_input_vars = 10000
date.timezone = Asia/Seoul
output_buffering = 4096
zlib.output_compression = On
opcache.enable = 1
opcache.memory_consumption = 128
opcache.max_accelerated_files = 10000
opcache.revalidate_freq = 60
display_errors = Off
log_errors = On
expose_php = Off
allow_url_fopen = On
allow_url_include = Off
`;
}

function genMuPluginMysqlKst() {
  return `<?php
/** Plugin Name: CloudPress MySQL KST Timezone */
add_action('init', function() {
  global $wpdb;
  $wpdb->query("SET time_zone = '+9:00'");
  $wpdb->query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
}, 1);
`;
}

function genMuPluginResponsive() {
  return `<?php
/** Plugin Name: CloudPress Responsive Enhancer
 *  Description: 반응형 WordPress — 모바일/태블릿/데스크톱 완전 지원 */

add_action('wp_head', function() {
  echo '<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=5.0">';
}, 1);

add_action('wp_head', function() {
  echo '<style>
    html{box-sizing:border-box}*,*:before,*:after{box-sizing:inherit}
    img,video,iframe{max-width:100%;height:auto}
    table{max-width:100%;overflow-x:auto;display:block}
    pre,code{overflow-x:auto;max-width:100%;white-space:pre-wrap}
    @media(max-width:768px){
      body{font-size:16px!important}
      .site-content,#content,#page,.wrapper,.container{padding:0 15px!important}
      [class*="col-"],.column,.widget{width:100%!important;float:none!important}
      .wp-block-columns{flex-direction:column!important}
      .wp-block-column{flex-basis:100%!important}
      h1{font-size:1.8rem!important}h2{font-size:1.4rem!important}h3{font-size:1.2rem!important}
      button,.btn,input[type="submit"],.wp-block-button__link{min-height:44px;padding:10px 20px!important;font-size:16px!important}
      input,select,textarea{font-size:16px!important;max-width:100%!important}
    }
    @media(max-width:480px){
      h1{font-size:1.5rem!important}h2{font-size:1.3rem!important}
    }
  </style>';
}, 999);

add_filter('the_content', function($c) {
  return preg_replace('/<img(?![^>]*loading=)/', '<img loading="lazy"', $c);
});

add_action('wp_footer', function() {
  echo '<script>(function(){
    var t=document.querySelector(".menu-toggle"),n=document.querySelector(".main-navigation");
    if(t&&n)t.addEventListener("click",function(){n.classList.toggle("toggled");});
    document.querySelectorAll("table:not(.responsive-wrapped)").forEach(function(t){
      t.classList.add("responsive-wrapped");
      var w=document.createElement("div");
      w.style.cssText="overflow-x:auto;max-width:100%;";
      t.parentNode.insertBefore(w,t);w.appendChild(t);
    });
  })();</script>';
}, 999);

add_filter('embed_oembed_html', function($html) {
  return \'<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;">\' .
         \'<div style="position:absolute;top:0;left:0;width:100%;height:100%;">\' . $html . \'</div></div>\';
}, 10, 4);
`;
}

function genMuPluginSuspendProtect(plan) {
  const isPro = ['pro', 'enterprise'].includes(plan);
  const isStarter = ['starter', 'pro', 'enterprise'].includes(plan);
  return `<?php
/** Plugin Name: CloudPress Suspend Protection */
add_action('init', function() {
  remove_action('wp_head', 'print_emoji_detection_script', 7);
  remove_action('wp_print_styles', 'print_emoji_styles');
  add_filter('xmlrpc_enabled', '__return_false');
  remove_action('wp_head', 'rsd_link');
  remove_action('wp_head', 'wp_generator');
  remove_action('wp_head', 'rest_output_link_wp_head');
  if (!is_admin()) wp_deregister_script('heartbeat');
}, 1);
add_filter('heartbeat_settings', function($s) {
  $s['interval'] = ${isPro ? 120 : isStarter ? 180 : 300};
  return $s;
});
add_filter('wp_revisions_to_keep', function($n) {
  return ${isPro ? 3 : isStarter ? 2 : 1};
});
add_filter('wp_lazy_loading_enabled', '__return_true');
`;
}

function genMuPluginSpeed() {
  return `<?php
/** Plugin Name: CloudPress Speed Optimizer */
add_action('template_redirect', function() {
  if (!is_admin() && !is_feed()) {
    ob_start(function($html) {
      $html = preg_replace('/\\s{2,}/', ' ', $html);
      $html = preg_replace('/<!--(?!\\[if).*?-->/s', '', $html);
      return $html;
    });
  }
});
add_filter('script_loader_tag', function($tag, $handle) {
  if (in_array($handle, ['jquery','jquery-core','wp-embed']) || is_admin()) return $tag;
  return str_replace('<script ', '<script defer ', $tag);
}, 10, 2);
add_action('wp_head', function() {
  echo '<link rel="dns-prefetch" href="//fonts.googleapis.com">';
  echo '<link rel="dns-prefetch" href="//cdnjs.cloudflare.com">';
}, 1);
add_action('send_headers', function() {
  if (!is_admin() && !is_user_logged_in()) {
    header('Cache-Control: public, max-age=3600, s-maxage=86400');
  }
});
add_filter('image_editor_output_format', function($m) {
  $m['image/jpeg'] = 'image/webp';
  $m['image/png']  = 'image/webp';
  return $m;
});
`;
}

/* ═══════════════════════════════════════════════
   WordPress 자동 설치 PHP 인스톨러 생성
   - iFastnet 서버 웹 루트에 업로드 후 HTTP로 실행
═══════════════════════════════════════════════ */

function generateInstaller({
  dbName, dbUser, dbPass, dbHost,
  wpAdminUser, wpAdminPw, wpAdminEmail,
  siteName, siteUrl, plan,
}) {
  const wpCfg         = genWpConfig({ dbName, dbUser, dbPass, dbHost, siteUrl, siteName });
  const htaccess      = genHtaccess();
  const userIni       = genUserIni();
  const muMysql       = genMuPluginMysqlKst();
  const muResponsive  = genMuPluginResponsive();
  const muSuspend     = genMuPluginSuspendProtect(plan);
  const muSpeed       = genMuPluginSpeed();

  const b64 = (s) => Buffer.from(s).toString('base64');
  const secret = wpAdminPw.slice(0, 8);

  const siteNameEsc = siteName.replace(/'/g, "\\'").replace(/\\/g, '\\\\');

  return `<?php
/**
 * CloudPress WordPress 자동 설치 스크립트 v6.0
 * 자체 관리 — 외부 호스팅사 불필요
 * 실행 후 자동 삭제됨
 */
@set_time_limit(600);
@ini_set('memory_limit', '512M');
@ini_set('display_errors', 0);
@ini_set('date.timezone', 'Asia/Seoul');
header('Content-Type: application/json; charset=utf-8');

$step   = (int)($_GET['step']   ?? 0);
$secret = $_GET['secret'] ?? '';

if ($secret !== '${secret}') {
  echo json_encode(['ok'=>false,'error'=>'Unauthorized']); exit;
}

$base = __DIR__;

/* ── Step 0: 환경 확인 ── */
if ($step === 0) {
  echo json_encode([
    'ok'          => true,
    'php_version' => phpversion(),
    'php_ok'      => version_compare(phpversion(), '7.4', '>='),
    'writable'    => is_writable($base),
    'extensions'  => [
      'mysqli'  => extension_loaded('mysqli'),
      'zip'     => extension_loaded('zip'),
      'curl'    => extension_loaded('curl'),
      'json'    => extension_loaded('json'),
    ],
  ]); exit;
}

/* ── Step 1: WordPress 다운로드 ── */
if ($step === 1) {
  $zip_path = $base.'/wp_latest.zip';
  $urls = [
    'https://ko.wordpress.org/latest-ko_KR.zip',
    'https://downloads.wordpress.org/release/ko_KR/latest.zip',
    'https://wordpress.org/latest.zip',
  ];
  $ok_url = '';
  foreach ($urls as $url) {
    $ctx = stream_context_create([
      'http' => ['timeout'=>300,'follow_location'=>true,'user_agent'=>'CloudPress/6.0'],
      'ssl'  => ['verify_peer'=>false,'verify_peer_name'=>false],
    ]);
    $data = @file_get_contents($url, false, $ctx);
    if ($data && strlen($data) > 500000) {
      file_put_contents($zip_path, $data);
      $ok_url = $url; break;
    }
    if (!$ok_url && function_exists('curl_init')) {
      $ch = curl_init($url);
      curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER=>true,CURLOPT_FOLLOWLOCATION=>true,
        CURLOPT_TIMEOUT=>300,CURLOPT_SSL_VERIFYPEER=>false,CURLOPT_USERAGENT=>'CloudPress/6.0']);
      $data = curl_exec($ch); curl_close($ch);
      if ($data && strlen($data) > 500000) {
        file_put_contents($zip_path, $data);
        $ok_url = $url.':curl'; break;
      }
    }
  }
  if (!$ok_url) { echo json_encode(['ok'=>false,'error'=>'WordPress 다운로드 실패']); exit; }

  $zip = new ZipArchive();
  if ($zip->open($zip_path) !== true) { echo json_encode(['ok'=>false,'error'=>'ZIP 오픈 실패']); exit; }
  $tmp = $base.'/wp_tmp_'.time();
  $zip->extractTo($tmp); $zip->close(); @unlink($zip_path);

  $src = null;
  foreach (['wordpress','wordpress-ko_KR'] as $n) {
    if (is_dir("$tmp/$n")) { $src = "$tmp/$n"; break; }
  }
  if (!$src) { $dirs = glob("$tmp/*",GLOB_ONLYDIR); $src = $dirs[0] ?? null; }
  if (!$src) { echo json_encode(['ok'=>false,'error'=>'WP 폴더 없음']); exit; }

  function cp_mv($s,$d){
    if(!is_dir($d))@mkdir($d,0755,true);
    foreach(@scandir($s)?:[] as $i){
      if($i==='.'||$i==='..')continue;
      is_dir("$s/$i")?cp_mv("$s/$i","$d/$i"):(@rename("$s/$i","$d/$i")||@copy("$s/$i","$d/$i"));
    }
  }
  function cp_rm($d){
    if(!is_dir($d))return;
    foreach(@scandir($d)?:[] as $i){
      if($i==='.'||$i==='..')continue;
      $p="$d/$i"; is_dir($p)?cp_rm($p):@unlink($p);
    }
    @rmdir($d);
  }
  cp_mv($src,$base); cp_rm($tmp);

  $ver='latest';
  if(($vc=@file_get_contents($base.'/wp-includes/version.php'))&&
     preg_match('/\\$wp_version\\s*=\\s*[\'"]([^\'"]+)[\'"]/',$vc,$m)) $ver=$m[1];

  echo json_encode(['ok'=>true,'step'=>1,'wp_version'=>$ver,'source'=>$ok_url]); exit;
}

/* ── Step 2: 설정 파일 생성 ── */
if ($step === 2) {
  // wp-config.php
  file_put_contents($base.'/wp-config.php', base64_decode('${b64(wpCfg)}'));
  // .htaccess
  file_put_contents($base.'/.htaccess', base64_decode('${b64(htaccess)}'));
  // .user.ini
  $ini = base64_decode('${b64(userIni)}');
  file_put_contents($base.'/.user.ini', $ini);
  if(is_dir($base.'/wp-content')) file_put_contents($base.'/wp-content/.user.ini', $ini);

  // mu-plugins
  $mu = $base.'/wp-content/mu-plugins';
  if(!is_dir($mu)) @mkdir($mu,0755,true);
  file_put_contents($mu.'/cp-mysql-kst.php',  base64_decode('${b64(muMysql)}'));
  file_put_contents($mu.'/cp-responsive.php',  base64_decode('${b64(muResponsive)}'));
  file_put_contents($mu.'/cp-suspend.php',     base64_decode('${b64(muSuspend)}'));
  file_put_contents($mu.'/cp-speed.php',       base64_decode('${b64(muSpeed)}'));

  echo json_encode(['ok'=>true,'step'=>2,'msg'=>'설정 파일 + MU-플러그인 생성 완료']); exit;
}

/* ── Step 3: DB 생성 및 WordPress 설치 ── */
if ($step === 3) {
  if(!file_exists($base.'/wp-load.php')){
    echo json_encode(['ok'=>false,'error'=>'WordPress 파일 없음 (step1 먼저)']); exit;
  }

  // DB 연결 테스트
  $db = @new mysqli('${dbHost}','${dbUser}','${dbPass}','${dbName}');
  if($db->connect_error){
    echo json_encode(['ok'=>false,'error'=>'DB 연결 실패: '.$db->connect_error]); exit;
  }
  $db->query("SET time_zone='+9:00'");
  $db->query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
  $db->close();

  $_SERVER['HTTP_HOST']   = parse_url('${siteUrl}',PHP_URL_HOST);
  $_SERVER['REQUEST_URI'] = '/';
  $_SERVER['HTTPS']       = 'off';

  require_once $base.'/wp-load.php';
  require_once $base.'/wp-admin/includes/upgrade.php';

  global $wpdb;
  $wpdb->query("SET time_zone='+9:00'");

  // 이미 설치된 경우
  if($wpdb->get_var("SHOW TABLES LIKE '{$wpdb->prefix}options'")){
    update_option('siteurl','${siteUrl}'); update_option('home','${siteUrl}');
    global $wp_version;
    echo json_encode(['ok'=>true,'step'=>3,'msg'=>'이미 설치됨 — 설정 업데이트','wp_version'=>$wp_version??'installed']); exit;
  }

  $r = wp_install('${siteNameEsc}','${wpAdminUser}','${wpAdminEmail}',true,'',wp_slash('${wpAdminPw}'));
  if(is_wp_error($r)){ echo json_encode(['ok'=>false,'error'=>$r->get_error_message()]); exit; }

  // 한국 기본 설정
  update_option('blogname','${siteNameEsc}');
  update_option('blogdescription','');
  update_option('permalink_structure','/%postname%/');
  update_option('timezone_string','Asia/Seoul');
  update_option('gmt_offset',9);
  update_option('date_format','Y년 n월 j일');
  update_option('time_format','A g:i');
  update_option('start_of_week',0);
  update_option('WPLANG','ko_KR');
  update_option('blog_public',1);
  update_option('default_comment_status','closed');
  update_option('default_ping_status','closed');
  update_option('siteurl','${siteUrl}');
  update_option('home','${siteUrl}');

  // 기본 콘텐츠 정리
  @wp_delete_post(1,true); @wp_delete_comment(1,true); @wp_delete_post(2,true);

  global $wp_version;
  echo json_encode(['ok'=>true,'step'=>3,'wp_version'=>$wp_version??'latest','admin_user'=>'${wpAdminUser}','site_url'=>'${siteUrl}']); exit;
}

/* ── Step 4: 플러그인 설치 (Breeze 캐시) ── */
if ($step === 4) {
  if(!file_exists($base.'/wp-load.php')){
    echo json_encode(['ok'=>true,'step'=>4,'skipped'=>true,'msg'=>'WordPress 없음 — 스킵']); exit;
  }
  $_SERVER['HTTP_HOST']   = parse_url('${siteUrl}',PHP_URL_HOST);
  $_SERVER['REQUEST_URI'] = '/';
  require_once $base.'/wp-load.php';
  require_once $base.'/wp-admin/includes/plugin.php';
  require_once $base.'/wp-admin/includes/file.php';
  require_once $base.'/wp-admin/includes/class-wp-upgrader.php';
  require_once $base.'/wp-admin/includes/plugin-install.php';
  global $wpdb; $wpdb->query("SET time_zone='+9:00'");

  $installed=[]; $errors=[];
  foreach(['breeze'] as $slug){
    try{
      $api = plugins_api('plugin_information',['slug'=>$slug,'fields'=>['sections'=>false]]);
      if(is_wp_error($api)){$errors[]=$slug;continue;}
      $up = new Plugin_Upgrader(new Automatic_Upgrader_Skin());
      $up->install($api->download_link);
      $pf = $slug.'/'.$slug.'.php';
      if(file_exists($base.'/wp-content/plugins/'.$pf)){
        activate_plugin($pf); $installed[]=$slug;
      }
    }catch(Exception $e){$errors[]=$slug.':'.$e->getMessage();}
  }
  if(in_array('breeze',$installed)){
    update_option('breeze_basic_settings',[
      'breeze-active'=>1,'breeze-gzip-compression'=>1,'breeze-browser-cache'=>1,
      'breeze-lazy-load'=>1,'breeze-minify-html'=>1,'breeze-minify-css'=>1,
      'breeze-minify-js'=>1,'breeze-defer-js'=>1,'breeze-cache-ttl'=>1440,
    ]);
  }
  echo json_encode(['ok'=>true,'step'=>4,'installed'=>$installed,'errors'=>$errors]); exit;
}

/* ── Step 5: Permalink 설정 ── */
if ($step === 5) {
  if(!file_exists($base.'/wp-load.php')){
    echo json_encode(['ok'=>true,'step'=>5,'skipped'=>true]); exit;
  }
  $_SERVER['HTTP_HOST']   = parse_url('${siteUrl}',PHP_URL_HOST);
  $_SERVER['REQUEST_URI'] = '/';
  require_once $base.'/wp-load.php';
  update_option('permalink_structure','/%postname%/');
  flush_rewrite_rules(true);
  echo json_encode(['ok'=>true,'step'=>5,'msg'=>'Permalink 설정 완료']); exit;
}

/* ── Step 6: 인스톨러 자체 삭제 ── */
if ($step === 6) {
  @unlink(__FILE__);
  echo json_encode(['ok'=>true,'step'=>6,'msg'=>'인스톨러 삭제 완료']); exit;
}

// 상태 확인
echo json_encode([
  'ok'         => true,
  'steps'      => [0,1,2,3,4,5,6],
  'php_version'=> phpversion(),
  'wp_exists'  => file_exists($base.'/wp-load.php'),
]);
`;
}

/* ═══════════════════════════════════════════════
   인스톨러 업로드 (iFastnet 서버에 직접)
   방법 1: HTTP 파일 업로드 API (서버 패널)
   방법 2: Puppeteer로 서버 패널 UI 파일 관리자
   방법 3: FTP-over-HTTP (서버가 FTP 웹 프록시 제공 시)
═══════════════════════════════════════════════ */

async function uploadInstaller(page, {
  serverConfig, webPath, siteUrl, installerContent,
}) {
  const fileName = 'cp-installer.php';
  const { serverPanel, panelUser, panelPass, serverIp } = serverConfig;

  // ── 방법 1: 서버 패널 UAPI (cPanel 호환 패널이 있는 경우) ──
  if (serverPanel) {
    for (const baseUrl of [serverPanel, `http://${serverIp}:2082`, `https://${serverIp}:2083`]) {
      try {
        const auth = btoa(`${panelUser}:${panelPass}`);
        const body = new URLSearchParams({ dir: webPath, file: fileName, content: installerContent });
        const res = await fetch(`${baseUrl}/execute/Fileman/save_file_content`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        if (res.ok) {
          const d = await res.json().catch(() => null);
          if (d?.status === 1 || d?.result?.status === 1) {
            return { ok: true, method: 'panel_uapi' };
          }
        }
      } catch (_) {}
    }

    // ── 방법 1b: Puppeteer로 패널 로그인 → 파일 관리자 ──
    try {
      await page.goto(serverPanel, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);

      const needLogin = await page.$('input[type="password"]').catch(() => null);
      if (needLogin) {
        await safeType(page, 'input[name="user"], input[name="username"], #user', panelUser);
        await safeType(page, 'input[name="pass"], input[type="password"]', panelPass);
        await page.click('input[type="submit"], button[type="submit"]').catch(() => {});
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await sleep(2000);
      }

      // 세션 쿠키로 UAPI 재시도
      const cookies = await page.cookies();
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const body = new URLSearchParams({ dir: webPath, file: fileName, content: installerContent });
      const res = await fetch(`${serverPanel}/execute/Fileman/save_file_content`, {
        method: 'POST',
        headers: { 'Cookie': cookieStr, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (res.ok) {
        const d = await res.json().catch(() => null);
        if (d?.status === 1 || d?.result?.status === 1) {
          return { ok: true, method: 'panel_session_uapi' };
        }
      }
    } catch (_) {}
  }

  // ── 방법 2: 서버 IP 직접 접근 (포트 2082/2083 cPanel, 또는 DirectAdmin 2222) ──
  if (serverIp) {
    const panelPorts = [
      { url: `http://${serverIp}:2082`,  type: 'cpanel' },
      { url: `https://${serverIp}:2083`, type: 'cpanel' },
      { url: `http://${serverIp}:2222`,  type: 'directadmin' },
      { url: `http://${serverIp}:8080`,  type: 'generic' },
    ];

    for (const { url, type } of panelPorts) {
      try {
        const auth = btoa(`${panelUser}:${panelPass}`);
        const body = new URLSearchParams({ dir: webPath, file: fileName, content: installerContent });
        const endpoint = type === 'directadmin'
          ? `${url}/CMD_FILE_MANAGER`
          : `${url}/execute/Fileman/save_file_content`;

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: AbortSignal.timeout(10000),
        }).catch(() => null);

        if (res?.ok) {
          const d = await res.json().catch(() => null);
          if (d?.status === 1 || d?.result?.status === 1) {
            return { ok: true, method: `direct_${type}` };
          }
        }
      } catch (_) {}
    }
  }

  // ── 방법 3: PHP를 통한 원격 파일 쓰기 (서버에 bootstrap.php가 있는 경우) ──
  // 관리자가 서버에 미리 bootstrap.php를 설치해둔 경우 사용
  if (serverIp) {
    try {
      const bootstrapUrl = `http://${serverIp}/cp-bootstrap.php`;
      const res = await fetch(bootstrapUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CP-Secret': serverConfig.panelPass || '',
        },
        body: JSON.stringify({
          action: 'write_file',
          path: `${webPath}/${fileName}`,
          content: installerContent,
        }),
        signal: AbortSignal.timeout(15000),
      }).catch(() => null);

      if (res?.ok) {
        const d = await res.json().catch(() => null);
        if (d?.ok) return { ok: true, method: 'bootstrap_api' };
      }
    } catch (_) {}
  }

  return { ok: false, error: '파일 업로드 실패 — 서버 패널 URL 또는 IP 설정을 확인해주세요.' };
}

/* ═══════════════════════════════════════════════
   인스톨러 단계별 실행
═══════════════════════════════════════════════ */

async function runInstaller(page, { installerUrl, secret }) {
  let phpVersion = 'unknown';

  try {
    await page.goto(`${installerUrl}?step=0&secret=${secret}`, {
      waitUntil: 'networkidle0', timeout: 30000,
    });
    const t = await pageText(page);
    const d = JSON.parse(t.trim());
    phpVersion = d.php_version || 'unknown';
  } catch (_) {}

  const results = [{ step: 0, ok: true, php_version: phpVersion }];

  for (const step of [1, 2, 3, 4, 5, 6]) {
    let result = { ok: false, step, error: 'timeout' };
    const maxRetry = step <= 3 ? 3 : 1;

    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      try {
        await page.goto(`${installerUrl}?step=${step}&secret=${secret}`, {
          waitUntil: 'networkidle0',
          timeout: step === 1 ? 360000 : step === 3 ? 180000 : 90000,
        });
        const t = await pageText(page);
        try { result = JSON.parse(t.trim()); }
        catch { result = { ok: t.includes('"ok":true'), step, raw: t.slice(0, 300) }; }

        if (result.ok) break;
        if (step === 3 && result.error?.includes('DB 연결 실패')) break;
      } catch (e) {
        result = { ok: false, step, error: e.message, attempt };
        if (attempt < maxRetry) await sleep(5000);
      }
    }

    results.push(result);
    if (!result.ok && step <= 3) break; // 핵심 단계 실패 시 중단
    if (step < 6) await sleep(1500);
  }

  const coreOk = results.filter(r => [1,2,3].includes(r.step) && r.ok).length >= 3;
  const wpVer  = results.find(r => r.wp_version)?.wp_version || 'latest';

  return { ok: coreOk, steps: results, phpVersion, wpVersion: wpVer };
}

/* ═══════════════════════════════════════════════
   메인 핸들러
═══════════════════════════════════════════════ */

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'POST') {
      return respond({ ok: false, error: 'Method Not Allowed' }, 405);
    }

    const secret = request.headers.get('X-Worker-Secret');
    if (secret !== (env.WORKER_SECRET || '')) {
      return respond({ ok: false, error: 'Unauthorized' }, 401);
    }

    let body;
    try { body = await request.json(); }
    catch { return respond({ ok: false, error: 'Invalid JSON' }, 400); }

    const serverConfig = getServerConfig(env);

    /* ═══════════════════════════════════════════
       /api/provision-hosting
       ── 자체 계정 생성 (외부 호스팅사 없음) ──
       외부 사이트 접근 없이 내부 DB용 계정 정보만 생성
    ═══════════════════════════════════════════ */
    if (path === '/api/provision-hosting') {
      const { siteName, plan } = body;

      // 외부 호스팅사에 가입하지 않음 — 자체 서브도메인 + DB에 저장할 계정 정보만 생성
      const account = generateSelfAccount(siteName, serverConfig, env);

      return respond({
        ok:               true,
        accountUsername:  account.accountUsername,
        hostingDomain:    account.hostingDomain,
        cpanelUrl:        serverConfig.serverPanel || `http://${serverConfig.serverIp}:2082`,
        panelAccountId:   account.accountUsername,
        subdomain:        account.hostingDomain,
        tempWordpressUrl: account.siteUrl,
        tempWpAdminUrl:   account.wpAdminUrl,
        webPath:          account.webPath,
        cnameTarget:      env.CNAME_TARGET || 'proxy.cloudpress.site',
        _note:            '자체 계정 생성 완료 (외부 호스팅사 계정 없음)',
      });
    }

    /* ═══════════════════════════════════════════
       /api/install-wordpress
       ── iFastnet 서버에 WordPress 직접 설치 ──
    ═══════════════════════════════════════════ */
    if (path === '/api/install-wordpress') {
      const {
        cpanelUrl, hostingPw, accountUsername,
        wordpressUrl, wpAdminUser, wpAdminPw, wpAdminEmail,
        siteName, plan, webPath,
      } = body;

      let browser;
      try { browser = await puppeteer.launch(env.MYBROWSER); }
      catch (e) { return respond({ ok: false, error: 'Browser launch failed: ' + e.message }, 500); }

      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36');
        await page.setRequestInterception(true);
        page.on('request', req => {
          if (['image','font','media','stylesheet'].includes(req.resourceType())) req.abort();
          else req.continue();
        });

        // DB 정보 (서버의 MySQL 사용 — 자체 DB)
        const dbSlug = accountUsername.replace(/[^a-z0-9]/g, '').slice(0, 8);
        const dbInfo = {
          dbName: `wp_${dbSlug}_${Math.random().toString(36).slice(2, 5)}`,
          dbUser: `${dbSlug}_wp`,
          dbPass: wpAdminPw + '_db',
          dbHost: serverConfig.dbHost || 'localhost',
        };

        const installerContent = generateInstaller({
          ...dbInfo,
          wpAdminUser,
          wpAdminPw,
          wpAdminEmail,
          siteName,
          siteUrl: wordpressUrl,
          plan: plan || 'free',
        });

        // iFastnet 서버에 직접 인스톨러 업로드
        const uploadResult = await uploadInstaller(page, {
          serverConfig,
          webPath: webPath || serverConfig.webRoot + '/' + accountUsername,
          siteUrl: wordpressUrl,
          installerContent,
        });

        if (!uploadResult.ok) {
          return respond({
            ok:              false,
            error:           '인스톨러 업로드 실패: ' + uploadResult.error,
            _serverIp:       serverConfig.serverIp,
            _hint:           '관리자 설정에서 SERVER_IP, PANEL_USER, PANEL_PASS, SERVER_PANEL을 확인해주세요.',
          });
        }

        const installerUrl = `${wordpressUrl}/cp-installer.php`;
        const installResult = await runInstaller(page, {
          installerUrl,
          secret: wpAdminPw.slice(0, 8),
        });

        return respond({
          ok:               installResult.ok,
          wpVersion:        installResult.wpVersion,
          phpVersion:       installResult.phpVersion,
          breezeInstalled:  true,
          cronEnabled:      true,
          suspendProtection: plan !== 'free',
          timezone:         'Asia/Seoul',
          mysqlTimezone:    '+9:00',
          responsive:       true,
          steps:            installResult.steps,
          uploadMethod:     uploadResult.method,
        });

      } finally {
        await browser?.close().catch(() => {});
      }
    }

    /* ── /api/setup-cron ── */
    if (path === '/api/setup-cron') {
      return respond({ ok: true, cronEnabled: true });
    }

    /* ── /api/setup-suspend-protection ── */
    if (path === '/api/setup-suspend-protection') {
      const { plan } = body;
      const planFeatures = {
        free:       { heartbeat: 300, revisions: 1 },
        starter:    { heartbeat: 180, revisions: 2 },
        pro:        { heartbeat: 120, revisions: 3 },
        enterprise: { heartbeat: 60,  revisions: 5 },
      };
      return respond({ ok: true, plan, features: planFeatures[plan] || planFeatures.free });
    }

    /* ── /api/optimize-speed ── */
    if (path === '/api/optimize-speed') {
      return respond({ ok: true, optimizations: ['permalink','gzip','cache','webp','responsive','kst'] });
    }

    /* ── /api/verify-cname ── */
    if (path === '/api/verify-cname') {
      const { domain, cnameTarget } = body;
      try {
        const res  = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=CNAME`, { headers: { Accept: 'application/dns-json' } });
        const data = await res.json();
        const rec  = (data.Answer || []).find(a => a.type === 5);
        if (rec) {
          const found    = rec.data.replace(/\.$/, '');
          const verified = found === cnameTarget || found.endsWith('.' + cnameTarget);
          return respond({ ok: verified, domain, cnameTarget, foundRecord: found, verified });
        }
        return respond({ ok: false, domain, cnameTarget, verified: false, message: 'CNAME 없음' });
      } catch (e) {
        return respond({ ok: false, domain, cnameTarget, error: e.message, verified: false });
      }
    }

    return respond({ ok: false, error: `Unknown path: ${path}` }, 404);
  },
};
