// functions/api/wp-json/wp/v2/pages.js — WordPress REST API /wp/v2/pages 호환
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,X-WP-Nonce'};
const j=(d,s=200,extra={})=>new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json',...CORS,...extra}});
function getToken(req){const a=req.headers.get('Authorization')||'';if(a.startsWith('Bearer '))return a.slice(7);const c=req.headers.get('Cookie')||'';const m=c.match(/cp_cms_session=([^;]+)/);return m?m[1]:null;}
async function getUser(env,req){try{const t=getToken(req);if(!t)return null;const uid=await env.CMS_KV.get(`session:${t}`);if(!uid)return null;return await env.CMS_DB.prepare('SELECT id,login,display_name,role FROM wp_users WHERE id=?').bind(uid).first();}catch{return null;}}
export const onRequestOptions=()=>new Response(null,{status:204,headers:CORS});
export async function onRequestGet({request,env,params}){
  try{
    const url=new URL(request.url);const id=params?.id;
    const perPage=Math.min(parseInt(url.searchParams.get('per_page')||'10'),100);
    const page=parseInt(url.searchParams.get('page')||'1');
    const offset=(page-1)*perPage;
    if(id){
      const p=await env.CMS_DB.prepare('SELECT * FROM wp_posts WHERE id=? AND post_type=?').bind(id,'page').first();
      if(!p)return j({code:'rest_post_invalid_id',message:'페이지를 찾을 수 없습니다.',data:{status:404}},404);
      return j(fmtPage(p,env));
    }
    const total=await env.CMS_DB.prepare("SELECT COUNT(*) as c FROM wp_posts WHERE post_type='page' AND post_status!='trash'").first().then(r=>r?.c||0).catch(()=>0);
    const {results}=await env.CMS_DB.prepare("SELECT * FROM wp_posts WHERE post_type='page' AND post_status!='trash' ORDER BY post_date DESC LIMIT ? OFFSET ?").bind(perPage,offset).all().catch(()=>({results:[]}));
    return new Response(JSON.stringify((results||[]).map(p=>fmtPage(p,env))),{status:200,headers:{...CORS,'Content-Type':'application/json','X-WP-Total':String(total),'X-WP-TotalPages':String(Math.ceil(total/perPage))}});
  }catch(e){return j({code:'rest_error',message:e.message,data:{status:500}},500);}
}
export async function onRequestPost({request,env}){
  try{
    const user=await getUser(env,request);if(!user)return j({code:'rest_forbidden',message:'권한 없음',data:{status:401}},401);
    const body=await request.json().catch(()=>({}));
    const id=Date.now();const now=new Date().toISOString().replace('T',' ').slice(0,19);
    const title=typeof body.title==='object'?body.title.raw:body.title||'새 페이지';
    const content=typeof body.content==='object'?body.content.raw:body.content||'';
    const slug=body.slug||title.toLowerCase().replace(/[^a-z0-9가-힣]/g,'-').replace(/-+/g,'-').slice(0,80);
    await env.CMS_DB.prepare('INSERT INTO wp_posts (id,post_author,post_date,post_date_gmt,post_content,post_title,post_status,post_name,post_type,post_modified,post_modified_gmt) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(id,user.id,now,now,content,title,body.status||'draft',slug,'page',now,now).run();
    const p=await env.CMS_DB.prepare('SELECT * FROM wp_posts WHERE id=?').bind(id).first();
    return j(fmtPage(p,env),201);
  }catch(e){return j({code:'rest_error',message:e.message,data:{status:500}},500);}
}
export async function onRequestPut({request,env,params}){
  try{
    const user=await getUser(env,request);if(!user)return j({code:'rest_forbidden',message:'권한 없음',data:{status:401}},401);
    const id=params?.id;const body=await request.json().catch(()=>({}));const now=new Date().toISOString().replace('T',' ').slice(0,19);
    const updates=[];const binds=[];
    if(body.title!==undefined){updates.push('post_title=?');binds.push(typeof body.title==='object'?body.title.raw:body.title);}
    if(body.content!==undefined){updates.push('post_content=?');binds.push(typeof body.content==='object'?body.content.raw:body.content);}
    if(body.status!==undefined){updates.push('post_status=?');binds.push(body.status);}
    if(body.slug!==undefined){updates.push('post_name=?');binds.push(body.slug);}
    updates.push('post_modified=?','post_modified_gmt=?');binds.push(now,now,id);
    if(updates.length>2) await env.CMS_DB.prepare(`UPDATE wp_posts SET ${updates.join(',')} WHERE id=? AND post_type='page'`).bind(...binds).run();
    const p=await env.CMS_DB.prepare('SELECT * FROM wp_posts WHERE id=?').bind(id).first();
    if(!p)return j({code:'rest_post_invalid_id',message:'페이지를 찾을 수 없습니다.',data:{status:404}},404);
    return j(fmtPage(p,env));
  }catch(e){return j({code:'rest_error',message:e.message,data:{status:500}},500);}
}
export async function onRequestDelete({request,env,params}){
  try{
    const user=await getUser(env,request);if(!user)return j({code:'rest_forbidden',message:'권한 없음',data:{status:401}},401);
    const id=params?.id;const p=await env.CMS_DB.prepare('SELECT * FROM wp_posts WHERE id=? AND post_type=?').bind(id,'page').first();
    if(!p)return j({code:'rest_post_invalid_id',message:'페이지를 찾을 수 없습니다.',data:{status:404}},404);
    const force=new URL(request.url).searchParams.get('force')==='true';
    if(force){await env.CMS_DB.prepare('DELETE FROM wp_posts WHERE id=?').bind(id).run();}
    else{await env.CMS_DB.prepare("UPDATE wp_posts SET post_status='trash' WHERE id=?").bind(id).run();}
    return j({...fmtPage(p,env),deleted:true});
  }catch(e){return j({code:'rest_error',message:e.message,data:{status:500}},500);}
}
function fmtPage(p,env){
  const base=env?.SITE_URL||'';
  return {id:p.id,date:p.post_date,date_gmt:p.post_date_gmt,guid:{rendered:`${base}/?page_id=${p.id}`},modified:p.post_modified,modified_gmt:p.post_modified_gmt,slug:p.post_name,status:p.post_status,type:'page',link:`${base}/${p.post_name}/`,title:{rendered:p.post_title,raw:p.post_title},content:{rendered:p.post_content,raw:p.post_content,protected:false},excerpt:{rendered:'',raw:'',protected:false},author:p.post_author,featured_media:0,comment_status:'closed',ping_status:'closed',template:'',meta:[],parent:0,menu_order:0,_links:{self:[{href:`${base}/wp-json/wp/v2/pages/${p.id}`}],collection:[{href:`${base}/wp-json/wp/v2/pages`}]}};
}
