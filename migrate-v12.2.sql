-- CloudPress v12.2 마이그레이션
-- 기존 배포 환경에서 아래 명령어로 실행하세요:
--   wrangler d1 execute <DB_NAME> --file=migrate-v12.2.sql
--
-- 변경 사항:
--   users 테이블에 Cloudflare Global API Key 컬럼 추가
--   (사이트 생성 시 관리자 키 대신 사용자 개인 CF API 사용)

-- 이미 컬럼이 있으면 에러가 나므로, D1은 IF NOT EXISTS를 지원하지 않음
-- → 실행 전 컬럼 존재 여부를 확인하거나, 에러 무시 후 진행
ALTER TABLE users ADD COLUMN cf_global_api_key TEXT;
ALTER TABLE users ADD COLUMN cf_account_email  TEXT;
ALTER TABLE users ADD COLUMN cf_account_id     TEXT;

-- v12.4 추가: Worker Script Upload 바인딩용 settings 키
INSERT OR IGNORE INTO settings (key, value) VALUES ('main_db_id',     '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('cache_kv_id',    '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('sessions_kv_id', '');
