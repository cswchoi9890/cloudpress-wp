-- migrate-v21.sql — CloudPress v21.0
-- 자체 CMS 제거, 진짜 WordPress 설치 지원
-- wp_origin_url: PHP 오리진 서버 URL (Cloudflare IP 기반 호스팅)
-- 자동 업데이트 설정 컬럼 추가

-- sites 테이블에 wp_origin_url 컬럼 추가
-- WordPress PHP 파일을 실행하는 오리진 서버 URL
-- Worker가 이 URL로 PHP 요청을 프록시
-- 예: https://cf-hosting-ip.cloudflare.com 또는 PHP 서버 URL
ALTER TABLE sites ADD COLUMN wp_origin_url TEXT;

-- 자동 업데이트 마지막 실행 시각
ALTER TABLE sites ADD COLUMN wp_auto_update_at TEXT;

-- 설정: WordPress 자동 업데이트 활성화 여부
INSERT OR IGNORE INTO settings (key, value) VALUES ('wp_auto_update_enabled', 'true');
-- 설정: 자동 업데이트 대상 버전 (major, minor, all)
INSERT OR IGNORE INTO settings (key, value) VALUES ('wp_auto_update_channel', 'minor');
-- 설정: 자동 업데이트 최대 동시 사이트 수
INSERT OR IGNORE INTO settings (key, value) VALUES ('wp_auto_update_batch',   '10');
