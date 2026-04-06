// functions/api/wp-json/wp/v2/settings.js — WordPress 설정 API 완전 호환
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,X-WP-Nonce'};
const j=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json',...CORS}});
export const onRequestOptions=()=>new Response(null,{status:204,headers:CORS});

function getToken(req){const a=req.headers.get('Authorization')||'';if(a.startsWith('Bearer '))return a.slice(7);const c=req.headers.get('Cookie')||'';const m=c.match(/cp_cms_session=([^;]+)/);return m?m[1]:null;}
async function getUser(env,req){try{const t=getToken(req);if(!t)return null;const uid=await env.CMS_KV.get(`session:${t}`);if(!uid)return null;return await env.CMS_DB.prepare('SELECT id,login,display_name,email,role FROM wp_users WHERE id=?').bind(uid).first();}catch{return null;}}

async function getOption(env,name,def=''){
  try{const r=await env.CMS_DB.prepare('SELECT option_value FROM wp_options WHERE option_name=?').bind(name).first();return r?.option_value??def;}catch{return def;}
}
async function setOption(env,name,value){
  try{await env.CMS_DB.prepare('INSERT INTO wp_options (option_name,option_value) VALUES (?,?) ON CONFLICT(option_name) DO UPDATE SET option_value=excluded.option_value').bind(name,String(value)).run();}catch(_){}
}

export async function onRequestGet({request,env}){
  try{
    const siteurl=await getOption(env,'siteurl',env.SITE_URL||'');
    const blogname=await getOption(env,'blogname','내 사이트');
    const blogdescription=await getOption(env,'blogdescription','');
    const postsPerPage=await getOption(env,'posts_per_page','10');
    const defaultCategory=await getOption(env,'default_category','1');
    const timezone=await getOption(env,'timezone_string','Asia/Seoul');
    const dateFormat=await getOption(env,'date_format','Y년 n월 j일');
    const timeFormat=await getOption(env,'time_format','H:i');
    const defaultCommentStatus=await getOption(env,'default_comment_status','open');
    const permalinkStructure=await getOption(env,'permalink_structure','/%year%/%monthnum%/%postname%/');
    const showOnFront=await getOption(env,'show_on_front','posts');
    const blogPublic=await getOption(env,'blog_public','1');
    const adminEmail=await getOption(env,'admin_email','');

    return j({
      title:blogname,
      blogname,
      description:blogdescription,
      url:siteurl,
      email:adminEmail,
      timezone,
      date_format:dateFormat,
      time_format:timeFormat,
      start_of_week:1,
      language:'ko_KR',
      use_smilies:false,
      default_category:parseInt(defaultCategory),
      default_post_format:'',
      posts_per_page:parseInt(postsPerPage),
      default_ping_status:'closed',
      default_comment_status:defaultCommentStatus,
      show_on_front:showOnFront,
      page_on_front:0,
      page_for_posts:0,
      blog_public:blogPublic==='1',
      permalink_structure:permalinkStructure,
      site_logo:0,
      site_icon:0,
    });
  }catch(e){return j({code:'rest_error',message:e.message,data:{status:500}},500);}
}

export async function onRequestPost({request,env}){
  try{
    const user=await getUser(env,request);
    if(!user||user.role!=='administrator')return j({code:'rest_forbidden',message:'관리자 권한이 필요합니다.',data:{status:403}},403);
    const body=await request.json().catch(()=>({}));
    const allowed=['title','blogname','description','blogdescription','email','admin_email','timezone','date_format','time_format','posts_per_page','default_category','default_comment_status','show_on_front','permalink_structure','blog_public'];
    for(const[k,v]of Object.entries(body)){
      if(!allowed.includes(k))continue;
      const dbKey=k==='title'?'blogname':k==='description'?'blogdescription':k==='email'?'admin_email':k;
      await setOption(env,dbKey,v);
    }
    return onRequestGet({request,env});
  }catch(e){return j({code:'rest_error',message:e.message,data:{status:500}},500);}
}
export const onRequestPut=onRequestPost;
