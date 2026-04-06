// functions/api/wp-json/wp/v2/posts.js
// WordPress REST API /wp/v2/posts 완전 호환

const CORS={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type,Authorization,X-WP-Nonce',
  'X-WP-Nonce':'cloudpress-nonce'
};
const j=(d,s=200,extra={})=>new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json',...CORS,...extra}});
const notFound=()=>j({code:'rest_post_invalid_id',message:'잘못된 포스트 ID입니다.',data:{status:404}},404);

function getToken(req){const a=req.headers.get('Authorization')||'';if(a.startsWith('Bearer '))return a.slice(7);const c=req.headers.get('Cookie')||'';const m=c.match(/cp_cms_session=([^;]+)/);return m?m[1]:null;}
async function getUser(env,req){try{const t=getToken(req);if(!t)return null;const uid=await env.CMS_KV.get(`session:${t}`);if(!uid)return null;const u=await env.CMS_DB.prepare('SELECT id,login,display_name,email,role FROM wp_users WHERE id=?').bind(uid).first();return u;}catch{return null;}}

export const onRequestOptions=()=>new Response(null,{status:204,headers:CORS});

export async function onRequestGet({request,env,params}){
  try{
    const url=new URL(request.url);
    const id=params?.id;
    const page=parseInt(url.searchParams.get('page')||'1');
    const perPage=Math.min(parseInt(url.searchParams.get('per_page')||'10'),100);
    const search=url.searchParams.get('search')||'';
    const status=url.searchParams.get('status')||'publish';
    const category=url.searchParams.get('categories')||'';
    const tag=url.searchParams.get('tags')||'';
    const offset=(page-1)*perPage;

    if(id){
      const post=await env.CMS_DB.prepare(
        `SELECT p.*,u.display_name as author_name,u.login as author_login
         FROM wp_posts p LEFT JOIN wp_users u ON p.post_author=u.id
         WHERE p.id=? AND p.post_type IN ('post','page')`
      ).bind(id).first();
      if(!post) return notFound();
      return j(formatPost(post,env));
    }

    // 목록
    let where='p.post_type=? AND p.post_status=?';
    let binds=['post',status==='any'?'publish':status];
    if(search){where+=' AND (p.post_title LIKE ? OR p.post_content LIKE ?)';binds.push(`%${search}%`,`%${search}%`);}

    const total=await env.CMS_DB.prepare(`SELECT COUNT(*) as c FROM wp_posts p WHERE ${where}`)
      .bind(...binds).first().then(r=>r?.c||0).catch(()=>0);

    const {results}=await env.CMS_DB.prepare(
      `SELECT p.*,u.display_name as author_name FROM wp_posts p
       LEFT JOIN wp_users u ON p.post_author=u.id
       WHERE ${where} ORDER BY p.post_date DESC LIMIT ? OFFSET ?`
    ).bind(...binds,perPage,offset).all().catch(()=>({results:[]}));

    const totalPages=Math.ceil(total/perPage);
    const headers={
      ...CORS,
      'X-WP-Total':String(total),
      'X-WP-TotalPages':String(totalPages),
      'Content-Type':'application/json',
      'Link':buildLinkHeader(url,page,totalPages)
    };
    return new Response(JSON.stringify((results||[]).map(p=>formatPost(p,env))),{status:200,headers});
  }catch(e){return j({code:'rest_error',message:e.message,data:{status:500}},500);}
}

export async function onRequestPost({request,env}){
  try{
    const user=await getUser(env,request);
    if(!user) return j({code:'rest_forbidden',message:'로그인이 필요합니다.',data:{status:401}},401);
    const body=await request.json().catch(()=>({}));
    const {title,content,status='draft',slug,excerpt,categories,tags,featured_media}=body;
    if(!title) return j({code:'rest_missing_callback_param',message:'제목이 필요합니다.',data:{status:400}},400);

    const id=Date.now();
    const now=new Date().toISOString().replace('T',' ').slice(0,19);
    const postSlug=slug||(typeof title==='object'?title.raw:title).toLowerCase().replace(/[^a-z0-9가-힣]/g,'-').replace(/-+/g,'-').slice(0,80);
    const postTitle=typeof title==='object'?title.raw:title;
    const postContent=typeof content==='object'?content.raw:content||'';
    const postExcerpt=typeof excerpt==='object'?excerpt.raw:excerpt||'';

    await env.CMS_DB.prepare(
      `INSERT INTO wp_posts (id,post_author,post_date,post_date_gmt,post_content,post_title,post_excerpt,
       post_status,post_name,post_type,post_modified,post_modified_gmt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id,user.id,now,now,postContent,postTitle,postExcerpt,status,postSlug,'post',now,now).run();

    const post=await env.CMS_DB.prepare('SELECT * FROM wp_posts WHERE id=?').bind(id).first();
    return j(formatPost(post,env),201);
  }catch(e){return j({code:'rest_error',message:e.message,data:{status:500}},500);}
}

export async function onRequestPut({request,env,params}){
  try{
    const user=await getUser(env,request);
    if(!user) return j({code:'rest_forbidden',message:'로그인이 필요합니다.',data:{status:401}},401);
    const id=params?.id;if(!id)return notFound();
    const body=await request.json().catch(()=>({}));
    const {title,content,status,slug,excerpt}=body;
    const now=new Date().toISOString().replace('T',' ').slice(0,19);
    const updates=[];const binds=[];
    if(title!==undefined){updates.push('post_title=?');binds.push(typeof title==='object'?title.raw:title);}
    if(content!==undefined){updates.push('post_content=?');binds.push(typeof content==='object'?content.raw:content);}
    if(status!==undefined){updates.push('post_status=?');binds.push(status);}
    if(slug!==undefined){updates.push('post_name=?');binds.push(slug);}
    if(excerpt!==undefined){updates.push('post_excerpt=?');binds.push(typeof excerpt==='object'?excerpt.raw:excerpt);}
    updates.push('post_modified=?','post_modified_gmt=?');binds.push(now,now,id);
    if(updates.length>2) await env.CMS_DB.prepare(`UPDATE wp_posts SET ${updates.join(',')} WHERE id=?`).bind(...binds).run();
    const post=await env.CMS_DB.prepare('SELECT * FROM wp_posts WHERE id=?').bind(id).first();
    if(!post)return notFound();
    return j(formatPost(post,env));
  }catch(e){return j({code:'rest_error',message:e.message,data:{status:500}},500);}
}

export async function onRequestDelete({request,env,params}){
  try{
    const user=await getUser(env,request);
    if(!user) return j({code:'rest_forbidden',message:'로그인이 필요합니다.',data:{status:401}},401);
    const id=params?.id;if(!id)return notFound();
    const post=await env.CMS_DB.prepare('SELECT * FROM wp_posts WHERE id=?').bind(id).first();
    if(!post)return notFound();
    const url=new URL(request.url);
    const force=url.searchParams.get('force')==='true';
    if(force){
      await env.CMS_DB.prepare('DELETE FROM wp_posts WHERE id=?').bind(id).run();
    }else{
      await env.CMS_DB.prepare("UPDATE wp_posts SET post_status='trash' WHERE id=?").bind(id).run();
    }
    return j({...formatPost(post,env),deleted:true});
  }catch(e){return j({code:'rest_error',message:e.message,data:{status:500}},500);}
}

function formatPost(p,env){
  const base=env?.SITE_URL||'';
  return {
    id:p.id,date:p.post_date,date_gmt:p.post_date_gmt,
    guid:{rendered:`${base}/?p=${p.id}`},
    modified:p.post_modified,modified_gmt:p.post_modified_gmt,
    slug:p.post_name,status:p.post_status,type:p.post_type,
    link:`${base}/${p.post_name}/`,
    title:{rendered:p.post_title,raw:p.post_title},
    content:{rendered:wpautop(p.post_content),raw:p.post_content,protected:false},
    excerpt:{rendered:p.post_excerpt?wpautop(p.post_excerpt):'',raw:p.post_excerpt||'',protected:false},
    author:p.post_author,featured_media:p.featured_media||0,
    comment_status:p.comment_status||'open',
    ping_status:p.ping_status||'open',
    sticky:false,template:'',format:'standard',
    meta:[],categories:[1],tags:[],
    _links:{
      self:[{href:`${base}/wp-json/wp/v2/posts/${p.id}`}],
      collection:[{href:`${base}/wp-json/wp/v2/posts`}],
      about:[{href:`${base}/wp-json/wp/v2/types/post`}],
      author:[{embeddable:true,href:`${base}/wp-json/wp/v2/users/${p.post_author}`}],
    }
  };
}
function wpautop(text){
  if(!text)return '';
  const t=text.trim();
  if(!t)return '';
  if(t.includes('<p>')||t.includes('<div>')||t.includes('<h'))return t;
  return t.split(/\n\n+/).map(p=>`<p>${p.replace(/\n/g,'<br />')}</p>`).join('\n');
}
function buildLinkHeader(url,page,totalPages){
  const links=[];
  if(page>1){url.searchParams.set('page',String(page-1));links.push(`<${url.toString()}>; rel="prev"`);}
  if(page<totalPages){url.searchParams.set('page',String(page+1));links.push(`<${url.toString()}>; rel="next"`);}
  return links.join(', ');
}
