// functions/api/admin/stats.js — CloudPress v17.1
// [수정사항]
// - traffic_logs.created_at 이 TEXT(datetime 문자열)이므로 datetime() 비교로 변경
// - requireAdminOrMgr: 매니저도 통계/트래픽 조회 허용
/* ── utils ── */
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'};
const _j=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json',...CORS}});
const ok=(d={})=>_j({ok:true,...d});
const err=(msg,s=400)=>_j({ok:false,error:msg},s);
const handleOptions=()=>new Response(null,{status:204,headers:CORS});
function getToken(req){const a=req.headers.get('Authorization')||'';if(a.startsWith('Bearer '))return a.slice(7);const c=req.headers.get('Cookie')||'';const m=c.match(/cp_session=([^;]+)/);return m?m[1]:null;}
async function getUser(env,req){try{const t=getToken(req);if(!t)return null;const uid=await env.SESSIONS.get(`session:${t}`);if(!uid)return null;return await env.DB.prepare('SELECT id,name,email,role,plan FROM users WHERE id=?').bind(uid).first();}catch{return null;}}
async function requireAdminOrMgr(env,req){const u=await getUser(env,req);return(u&&(u.role==='admin'||u.role==='manager'))?u:null;}
/* ── end utils ── */

export const onRequestOptions = () => handleOptions();

export async function onRequestGet({ request, env }) {
  try {
    const user = await requireAdminOrMgr(env, request);
    if (!user) return err('어드민/매니저 권한이 필요합니다.', 403);

    // traffic_logs.created_at 은 TEXT('YYYY-MM-DD HH:MM:SS') — datetime() 함수로 비교
    const [
      totalUsers, totalSites, activeSites,
      sitesToday, sitesWeek, sitesMonth, sitesYear,
      totalRevenue, revenueMonth,
      recentPaymentsResult,
      countryStatsResult, deviceStatsResult,
      trafficTodayResult, trafficWeekResult, trafficMonthResult,
    ] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) c FROM users').first(),
      env.DB.prepare('SELECT COUNT(*) c FROM sites').first(),
      env.DB.prepare("SELECT COUNT(*) c FROM sites WHERE status='active'").first(),
      env.DB.prepare("SELECT COUNT(*) c FROM sites WHERE created_at > datetime('now','-1 day')").first(),
      env.DB.prepare("SELECT COUNT(*) c FROM sites WHERE created_at > datetime('now','-7 days')").first(),
      env.DB.prepare("SELECT COUNT(*) c FROM sites WHERE created_at > datetime('now','-30 days')").first(),
      env.DB.prepare("SELECT COUNT(*) c FROM sites WHERE created_at > datetime('now','-365 days')").first(),
      env.DB.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='done'").first(),
      env.DB.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='done' AND created_at > datetime('now','-30 days')").first(),
      env.DB.prepare("SELECT p.order_id,p.amount,p.plan,p.method,p.created_at,u.name,u.email FROM payments p JOIN users u ON p.user_id=u.id WHERE p.status='done' ORDER BY p.created_at DESC LIMIT 10").all(),
      // traffic_logs: created_at TEXT 기준 집계
      env.DB.prepare("SELECT country, COUNT(*) cnt FROM traffic_logs GROUP BY country ORDER BY cnt DESC LIMIT 10").all(),
      env.DB.prepare("SELECT device, COUNT(*) cnt FROM traffic_logs GROUP BY device ORDER BY cnt DESC").all(),
      env.DB.prepare("SELECT COUNT(*) c FROM traffic_logs WHERE created_at > datetime('now','-1 day')").first(),
      env.DB.prepare("SELECT COUNT(*) c FROM traffic_logs WHERE created_at > datetime('now','-7 days')").first(),
      env.DB.prepare("SELECT COUNT(*) c FROM traffic_logs WHERE created_at > datetime('now','-30 days')").first(),
    ]);

    // 일별 사이트 생성 추이 (최근 30일)
    const { results: dailySites } = await env.DB.prepare(
      `SELECT date(created_at) d, COUNT(*) c FROM sites
       WHERE created_at > datetime('now','-30 days')
       GROUP BY d ORDER BY d`
    ).all();

    // 일별 트래픽 추이 (최근 30일)
    const { results: dailyTraffic } = await env.DB.prepare(
      `SELECT date(created_at) d, COUNT(*) c FROM traffic_logs
       WHERE created_at > datetime('now','-30 days')
       GROUP BY d ORDER BY d`
    ).all();

    return ok({
      users:          totalUsers?.c ?? 0,
      sites:          totalSites?.c ?? 0,
      activeSites:    activeSites?.c ?? 0,
      sitesToday:     sitesToday?.c ?? 0,
      sitesWeek:      sitesWeek?.c ?? 0,
      sitesMonth:     sitesMonth?.c ?? 0,
      sitesYear:      sitesYear?.c ?? 0,
      totalRevenue:   totalRevenue?.s ?? 0,
      revenueMonth:   revenueMonth?.s ?? 0,
      recentPayments: recentPaymentsResult?.results ?? [],
      countryStats:   countryStatsResult?.results ?? [],
      deviceStats:    deviceStatsResult?.results ?? [],
      trafficToday:   trafficTodayResult?.c ?? 0,
      trafficWeek:    trafficWeekResult?.c ?? 0,
      trafficMonth:   trafficMonthResult?.c ?? 0,
      dailySites:     dailySites ?? [],
      dailyTraffic:   dailyTraffic ?? [],
    });
  } catch (e) {
    console.error('stats error:', e);
    return err('통계 로딩 실패: ' + (e?.message ?? e), 500);
  }
}
