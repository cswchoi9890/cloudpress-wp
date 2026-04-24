#!/usr/bin/env node
// build.js — worker.js 소스를 JS 상수로 변환
// Pages 빌드 커맨드: node build.js
// 출력: functions/api/_worker_source.js

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const workerSrc = readFileSync(join(__dirname, 'worker.js'), 'utf-8');

// JSON.stringify로 escape → 어떤 특수문자도 안전하게 처리
const out = `// 자동 생성 파일 — build.js가 생성함. 직접 수정 금지.
// worker.js 소스를 provision.js에서 import해서 사용
export const WORKER_SOURCE = ${JSON.stringify(workerSrc)};
`;

const outPath = join(__dirname, 'functions', 'api', '_worker_source.js');
writeFileSync(outPath, out, 'utf-8');
console.log(`[build] _worker_source.js 생성 완료 (${workerSrc.length} bytes)`);
