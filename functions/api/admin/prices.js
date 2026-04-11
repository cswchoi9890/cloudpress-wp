// functions/api/sites/prices.js — 공개 플랜 가격 조회 API
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
const _j=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json',...CORS}});
export const onRequestOptions=()=>new Response(null,{status:204,headers:CORS});
export async function onRequestGet({env}){
  try{
    const keys=['plan_starter_price','plan_pro_price','plan_enterprise_price','plan_starter_sites','plan_pro_sites','plan_enterprise_sites'];
    const{results}=await env.DB.prepare(`SELECT key,value FROM settings WHERE key IN (${keys.map(()=>'?').join(',')})`).bind(...keys).all();
    const data={ok:true};
    for(const r of(results||[]))data[r.key]=r.value;
    return _j(data);
  }catch(e){return _j({ok:false,error:e.message},500);}
}
