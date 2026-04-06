// functions/api/wp-json/wp/v2/users.js — WordPress Users API 완전 호환
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,X-WP-Nonce'};
const j=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json',...CORS}});
export const onRequestOptions=()=>new Response(null,{status:204,headers:CORS});

function getToken(req){const a=req.headers.get('Authorization')||'';if(a.startsWith('Bearer '))return a.slice(7);const c=req.headers.get('Cookie')||'';const m=c.match(/cp_cms_session=([^;]+)/);return m?m[1]:null;}
async function getUser(env,req){try{const t=getToken(req);if(!t)return null;const uid=await env.CMS_KV.get(`session:${t}`);if(!uid)return null;return await env.CMS_DB.prepare('SELECT id,login,user_pass,display_name,email,role,url,user_registered FROM wp_users WHERE id=?').bind(uid).first();}catch{return null;}}

function formatUser(u,env,includeEmail=false){
  const base=env?.SITE_URL||'';
  const obj={
    id:u.id,name:u.display_name||u.login,url:u.url||'',
    description:'',link:`${base}/author/${u.login}/`,
    slug:u.login,avatar_urls:{'24':'','48':'','96':''},
    meta:[],
    _links:{self:[{href:`${base}/wp-json/wp/v2/users/${u.id}`}],collection:[{href:`${base}/wp-json/wp/v2/users`}]}
  };
  if(includeEmail){obj.email=u.email;obj.registered_date=u.user_registered;obj.roles=[u.role];obj.capabilities={[u.role]:true};obj.extra_capabilities={administrator:u.role==='administrator'};}
  return obj;
}

export async function onRequest({request,env,params}){
  const url=new URL(request.url);
  const path=url.pathname;
  try{
    if(path.endsWith('/me')||path.endsWith('/me/')){
      if(request.method==='GET'){
        const user=await getUser(env,request);
        if(!user)return j({code:'rest_not_logged_in',message:'로그인이 필요합니다.',data:{status:401}},401);
        return j(formatUser(user,env,true));
      }
      if(request.method==='POST'||request.method==='PUT'){
        const user=await getUser(env,request);
        if(!user)return j({code:'rest_not_logged_in',message:'로그인이 필요합니다.',data:{status:401}},401);
        const body=await request.json().catch(()=>({}));
        const updates=[];const binds=[];
        if(body.name!==undefined){updates.push('display_name=?');binds.push(body.name);}
        if(body.email!==undefined){updates.push('email=?');binds.push(body.email);}
        if(body.url!==undefined){updates.push('url=?');binds.push(body.url);}
        if(body.password!==undefined&&body.password.length>=8){updates.push('user_pass=?');binds.push(body.password);}
        if(updates.length){binds.push(user.id);await env.CMS_DB.prepare(`UPDATE wp_users SET ${updates.join(',')} WHERE id=?`).bind(...binds).run();}
        const updated=await env.CMS_DB.prepare('SELECT id,login,user_pass,display_name,email,role,url,user_registered FROM wp_users WHERE id=?').bind(user.id).first();
        return j(formatUser(updated,env,true));
      }
    }
    const id=params?.id||url.pathname.split('/').filter(Boolean).pop();
    if(request.method==='GET'){
      if(!id||id==='users'){
        const page=parseInt(url.searchParams.get('page')||'1');
        const perPage=Math.min(parseInt(url.searchParams.get('per_page')||'10'),100);
        const{results}=await env.CMS_DB.prepare('SELECT * FROM wp_users LIMIT ? OFFSET ?').bind(perPage,(page-1)*perPage).all().catch(()=>({results:[]}));
        return j((results||[]).map(u=>formatUser(u,env,false)));
      }
      const u=await env.CMS_DB.prepare('SELECT * FROM wp_users WHERE id=?').bind(id).first();
      if(!u)return j({code:'rest_user_invalid_id',message:'잘못된 사용자 ID입니다.',data:{status:404}},404);
      const reqUser=await getUser(env,request);
      return j(formatUser(u,env,reqUser&&reqUser.id===u.id));
    }
    return j({code:'rest_no_route',message:'지원하지 않는 메서드',data:{status:405}},405);
  }catch(e){return j({code:'rest_error',message:e.message,data:{status:500}},500);}
}
export const onRequestGet=onRequest;
export const onRequestPost=onRequest;
export const onRequestPut=onRequest;
