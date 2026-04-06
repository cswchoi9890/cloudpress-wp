-- CloudPress CMS Schema — WordPress 완전 호환 (D1/SQLite)
PRAGMA journal_mode=WAL;

-- 사용자 테이블
CREATE TABLE IF NOT EXISTS wp_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL UNIQUE,
  user_pass TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL UNIQUE,
  url TEXT DEFAULT '',
  user_registered TEXT NOT NULL DEFAULT (datetime('now')),
  role TEXT NOT NULL DEFAULT 'subscriber',
  user_status INTEGER DEFAULT 0
);

-- 포스트 테이블 (글/페이지/첨부파일 통합)
CREATE TABLE IF NOT EXISTS wp_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_author INTEGER NOT NULL DEFAULT 1,
  post_date TEXT NOT NULL DEFAULT (datetime('now')),
  post_date_gmt TEXT NOT NULL DEFAULT (datetime('now')),
  post_content TEXT NOT NULL DEFAULT '',
  post_title TEXT NOT NULL DEFAULT '',
  post_excerpt TEXT NOT NULL DEFAULT '',
  post_status TEXT NOT NULL DEFAULT 'draft',
  comment_status TEXT NOT NULL DEFAULT 'open',
  ping_status TEXT NOT NULL DEFAULT 'open',
  post_name TEXT NOT NULL DEFAULT '',
  post_modified TEXT NOT NULL DEFAULT (datetime('now')),
  post_modified_gmt TEXT NOT NULL DEFAULT (datetime('now')),
  post_parent INTEGER NOT NULL DEFAULT 0,
  guid TEXT NOT NULL DEFAULT '',
  menu_order INTEGER NOT NULL DEFAULT 0,
  post_type TEXT NOT NULL DEFAULT 'post',
  featured_media INTEGER DEFAULT 0,
  FOREIGN KEY (post_author) REFERENCES wp_users(id) ON DELETE SET DEFAULT
);

-- 카테고리/태그 (분류)
CREATE TABLE IF NOT EXISTS wp_terms (
  term_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL UNIQUE DEFAULT '',
  term_group INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wp_term_taxonomy (
  term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id INTEGER NOT NULL,
  taxonomy TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  parent INTEGER DEFAULT 0,
  count INTEGER DEFAULT 0,
  FOREIGN KEY (term_id) REFERENCES wp_terms(term_id)
);
CREATE TABLE IF NOT EXISTS wp_term_relationships (
  object_id INTEGER NOT NULL,
  term_taxonomy_id INTEGER NOT NULL,
  PRIMARY KEY (object_id, term_taxonomy_id)
);

-- 포스트 메타
CREATE TABLE IF NOT EXISTS wp_postmeta (
  meta_id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  meta_key TEXT NOT NULL DEFAULT '',
  meta_value TEXT DEFAULT NULL,
  FOREIGN KEY (post_id) REFERENCES wp_posts(id) ON DELETE CASCADE
);

-- 옵션 (워드프레스 wp_options 완전 호환)
CREATE TABLE IF NOT EXISTS wp_options (
  option_id INTEGER PRIMARY KEY AUTOINCREMENT,
  option_name TEXT NOT NULL UNIQUE,
  option_value TEXT NOT NULL DEFAULT '',
  autoload TEXT NOT NULL DEFAULT 'yes'
);

-- 댓글
CREATE TABLE IF NOT EXISTS wp_comments (
  comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_post_id INTEGER NOT NULL DEFAULT 0,
  comment_author TEXT NOT NULL DEFAULT '',
  comment_author_email TEXT NOT NULL DEFAULT '',
  comment_author_url TEXT NOT NULL DEFAULT '',
  comment_content TEXT NOT NULL DEFAULT '',
  comment_date TEXT NOT NULL DEFAULT (datetime('now')),
  comment_approved TEXT NOT NULL DEFAULT '1',
  user_id INTEGER DEFAULT 0,
  comment_parent INTEGER DEFAULT 0
);

-- 미디어
CREATE TABLE IF NOT EXISTS wp_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
  file_size INTEGER DEFAULT 0,
  width INTEGER DEFAULT 0,
  height INTEGER DEFAULT 0,
  alt_text TEXT DEFAULT '',
  title TEXT DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  uploaded_by INTEGER DEFAULT 1,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_posts_status ON wp_posts(post_status,post_type);
CREATE INDEX IF NOT EXISTS idx_posts_author ON wp_posts(post_author);
CREATE INDEX IF NOT EXISTS idx_posts_name ON wp_posts(post_name);
CREATE INDEX IF NOT EXISTS idx_posts_date ON wp_posts(post_date DESC);
CREATE INDEX IF NOT EXISTS idx_postmeta_post ON wp_postmeta(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_post ON wp_comments(comment_post_id);

-- 기본 옵션 데이터 (WP 완전 호환)
INSERT OR IGNORE INTO wp_options (option_name,option_value,autoload) VALUES
  ('siteurl',      'https://SITE_URL_PLACEHOLDER', 'yes'),
  ('blogname',     'SITE_NAME_PLACEHOLDER',         'yes'),
  ('blogdescription','CloudPress CMS로 만든 사이트',  'yes'),
  ('admin_email',  'admin@SITE_URL_PLACEHOLDER',    'yes'),
  ('posts_per_page','10',                           'yes'),
  ('active_theme', 'default',                      'yes'),
  ('template',     'default',                      'yes'),
  ('stylesheet',   'default',                      'yes'),
  ('permalink_structure','/%year%/%monthnum%/%postname%/','yes'),
  ('timezone_string','Asia/Seoul',                 'yes'),
  ('date_format',  'Y년 n월 j일',                   'yes'),
  ('time_format',  'H:i',                          'yes'),
  ('default_comment_status','open',               'yes'),
  ('show_on_front','posts',                        'yes'),
  ('page_on_front','0',                            'yes'),
  ('page_for_posts','0',                           'yes'),
  ('wp_user_roles','a:0:{}',                      'yes'),
  ('initial_db_version','60621',                  'yes'),
  ('db_version',   '60621',                       'yes'),
  ('blogcharset',  'UTF-8',                       'yes'),
  ('blog_public',  '1',                           'yes'),
  ('default_category','1',                        'yes'),
  ('comment_moderation','0',                      'yes'),
  ('cloudpress_version','1.0.0',                  'yes');

-- 기본 카테고리
INSERT OR IGNORE INTO wp_terms (term_id,name,slug) VALUES (1,'미분류','uncategorized');
INSERT OR IGNORE INTO wp_term_taxonomy (term_taxonomy_id,term_id,taxonomy,description,parent,count) VALUES (1,1,'category','',0,1);

-- 기본 샘플 글
INSERT OR IGNORE INTO wp_posts (id,post_author,post_date,post_date_gmt,post_content,post_title,post_excerpt,post_status,post_name,post_type,post_modified,post_modified_gmt)
VALUES (1,1,datetime('now'),datetime('now'),
  '<p>CloudPress CMS에 오신 것을 환영합니다! 이 글은 샘플 글입니다.</p><p>워드프레스와 완전히 동일한 방식으로 글을 작성하고, 카테고리와 태그를 지정하며, 미디어를 업로드할 수 있습니다.</p><p>지금 바로 글 편집을 시작해보세요.</p>',
  'CloudPress CMS에 오신 것을 환영합니다',
  'CloudPress CMS에 오신 것을 환영합니다. 워드프레스와 동일한 블로그 경험을 즐기세요.',
  'publish','hello-cloudpress','post',datetime('now'),datetime('now'));

INSERT OR IGNORE INTO wp_term_relationships (object_id,term_taxonomy_id) VALUES (1,1);

-- 기본 About 페이지
INSERT OR IGNORE INTO wp_posts (id,post_author,post_date,post_date_gmt,post_content,post_title,post_status,post_name,post_type,post_modified,post_modified_gmt)
VALUES (2,1,datetime('now'),datetime('now'),
  '<p>이 페이지는 CloudPress CMS로 생성된 사이트입니다. 워드프레스와 100% 동일한 UX를 제공합니다.</p>',
  'About','publish','about','page',datetime('now'),datetime('now'));
