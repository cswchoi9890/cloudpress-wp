// functions/api/admin/notices.js — CloudPress v17.1
// [수정사항]
// - schema.sql 기준으로 컬럼명 일치: is_active→active, created_by/updated_at 컬럼 제거
// - requireAdminOrMgr 유지 (매니저도 공지 관리 가능)
/* ── utils ── */
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'};
const _j=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json',...CORS}});
const ok=(d={})=>_j({ok:true,...d});
const err=(msg,s=400)=>_j({ok:false,error:msg},s);
const handleOptions=()=>new Response(null,{status:204,headers:CORS});
function getToken(req){const a=req.headers.get('Authorization')||'';if(a.startsWith('Bearer '))return a.slice(7);const c=req.headers.get('Cookie')||'';const m=c.match(/cp_session=([^;]+)/);return m?m[1]:null;}
async function getUser(env,req){try{const t=getToken(req);if(!t)return null;const uid=await env.SESSIONS.get(`session:${t}`);if(!uid)return null;return await env.DB.prepare('SELECT id,name,email,role,plan FROM users WHERE id=?').bind(uid).first();}catch{return null;}}
async function requireAdminOrMgr(env,req){const u=await getUser(env,req);return(u&&(u.role==='admin'||u.role==='manager'))?u:null;}
function genId(){return Date.now().toString(36)+Math.random().toString(36).slice(2,9);}
/* ── end utils ── */

export const onRequestOptions = () => handleOptions();

export async function onRequestGet({ request, env }) {
  try {
    // 공개 GET (active=1)은 인증 없이 허용 — 사용자 대시보드에서 공지 조회에 사용
    const url    = new URL(request.url);
    const active = url.searchParams.get('active');
    let query = 'SELECT id,title,content,type,target_role,active,created_at FROM notices';
    if (active === '1') query += ' WHERE active=1';
    query += ' ORDER BY created_at DESC';
    const { results } = await env.DB.prepare(query).all();
    return ok({ notices: results ?? [] });
  } catch (e) {
    console.error('notices GET error:', e);
    return err('공지 로딩 실패: ' + (e?.message ?? e), 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const user = await requireAdminOrMgr(env, request);
    if (!user) return err('권한 필요', 403);

    let body;
    try { body = await request.json(); } catch { return err('잘못된 요청'); }

    const { title, content, type = 'info', target_role = 'all' } = body || {};
    if (!title?.trim()) return err('제목을 입력해주세요.');
    if (!content?.trim()) return err('내용을 입력해주세요.');

    const validTypes = ['info', 'warning', 'success', 'error'];
    if (!validTypes.includes(type)) return err('올바르지 않은 type');

    const id = genId();
    // schema: id, title, content, type, target_role, active, created_at
    await env.DB.prepare(
      'INSERT INTO notices (id,title,content,type,target_role,active,created_at) VALUES (?,?,?,?,?,1,datetime(\'now\'))'
    ).bind(id, title.trim(), content.trim(), type, target_role).run();
    return ok({ id });
  } catch (e) {
    console.error('notices POST error:', e);
    return err('공지 작성 실패: ' + (e?.message ?? e), 500);
  }
}

export async function onRequestPut({ request, env }) {
  try {
    const user = await requireAdminOrMgr(env, request);
    if (!user) return err('권한 필요', 403);

    let body;
    try { body = await request.json(); } catch { return err('잘못된 요청'); }

    const { id, title, content, type, active, target_role } = body || {};
    if (!id) return err('id 필요');

    // 존재 확인
    const existing = await env.DB.prepare('SELECT id FROM notices WHERE id=?').bind(id).first();
    if (!existing) return err('존재하지 않는 공지입니다.', 404);

    const fields = [];
    const binds  = [];
    if (title       !== undefined) { fields.push('title=?');       binds.push(title.trim()); }
    if (content     !== undefined) { fields.push('content=?');     binds.push(content.trim()); }
    if (type        !== undefined) { fields.push('type=?');        binds.push(type); }
    if (target_role !== undefined) { fields.push('target_role=?'); binds.push(target_role); }
    if (active      !== undefined) { fields.push('active=?');      binds.push(active ? 1 : 0); }

    if (!fields.length) return err('변경할 필드 없음');

    binds.push(id);
    await env.DB.prepare(`UPDATE notices SET ${fields.join(',')} WHERE id=?`).bind(...binds).run();
    return ok({ message: '업데이트 완료' });
  } catch (e) {
    console.error('notices PUT error:', e);
    return err('공지 수정 실패: ' + (e?.message ?? e), 500);
  }
}

export async function onRequestDelete({ request, env }) {
  try {
    const user = await requireAdminOrMgr(env, request);
    if (!user) return err('권한 필요', 403);

    let body;
    try { body = await request.json(); } catch { return err('잘못된 요청'); }

    const { id } = body || {};
    if (!id) return err('id 필요');

    const existing = await env.DB.prepare('SELECT id FROM notices WHERE id=?').bind(id).first();
    if (!existing) return err('존재하지 않는 공지입니다.', 404);

    await env.DB.prepare('DELETE FROM notices WHERE id=?').bind(id).run();
    return ok({ message: '삭제 완료' });
  } catch (e) {
    console.error('notices DELETE error:', e);
    return err('공지 삭제 실패: ' + (e?.message ?? e), 500);
  }
}
