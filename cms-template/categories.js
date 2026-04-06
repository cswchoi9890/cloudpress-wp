const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,X-WP-Nonce'};
const j=(d,s=200,e={})=>new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json',...CORS,...e}});
export const onRequestOptions=()=>new Response(null,{status:204,headers:CORS});
export async function onRequestGet({request,env,params}){
  try{
    const id=params?.id;const url=new URL(request.url);const perPage=Math.min(parseInt(url.searchParams.get('per_page')||'100'),100);
    if(id){const row=await env.CMS_DB.prepare("SELECT t.*,tt.term_taxonomy_id,tt.description,tt.parent,tt.count FROM wp_terms t JOIN wp_term_taxonomy tt ON t.term_id=tt.term_id WHERE t.term_id=? AND tt.taxonomy='category'").bind(id).first();if(!row)return j({code:'rest_term_invalid',message:'카테고리를 찾을 수 없습니다.',data:{status:404}},404);return j(fmtCat(row,env));}
    const {results}=await env.CMS_DB.prepare("SELECT t.*,tt.term_taxonomy_id,tt.description,tt.parent,tt.count FROM wp_terms t JOIN wp_term_taxonomy tt ON t.term_id=tt.term_id WHERE tt.taxonomy='category' ORDER BY t.name ASC LIMIT ?").bind(perPage).all().catch(()=>({results:[]}));
    const total=(results||[]).length;
    return new Response(JSON.stringify((results||[]).map(r=>fmtCat(r,env))),{status:200,headers:{...CORS,'Content-Type':'application/json','X-WP-Total':String(total),'X-WP-TotalPages':'1'}});
  }catch(e){return j({code:'rest_error',message:e.message,data:{status:500}},500);}
}
export async function onRequestPost({request,env}){
  try{const body=await request.json().catch(()=>({}));const name=body.name;if(!name)return j({code:'rest_missing_callback_param',message:'이름이 필요합니다.',data:{status:400}},400);const slug=body.slug||name.toLowerCase().replace(/[^a-z0-9가-힣]/g,'-').replace(/-+/g,'-');const id=Date.now();await env.CMS_DB.prepare('INSERT INTO wp_terms (term_id,name,slug) VALUES (?,?,?)').bind(id,name,slug).run();await env.CMS_DB.prepare('INSERT INTO wp_term_taxonomy (term_id,taxonomy,description,parent,count) VALUES (?,?,?,?,?)').bind(id,'category',body.description||'',body.parent||0,0).run();const row=await env.CMS_DB.prepare("SELECT t.*,tt.term_taxonomy_id,tt.description,tt.parent,tt.count FROM wp_terms t JOIN wp_term_taxonomy tt ON t.term_id=tt.term_id WHERE t.term_id=?").bind(id).first();return j(fmtCat(row,env),201);}catch(e){return j({code:'rest_error',message:e.message,data:{status:500}},500);}
}
function fmtCat(r,env){const base=env?.SITE_URL||'';return {id:r.term_id,count:r.count||0,description:r.description||'',link:`${base}/category/${r.slug}/`,name:r.name,slug:r.slug,taxonomy:'category',parent:r.parent||0,meta:[]};}
