/* CloudPress CMS — 단일 포스트 JS */
'use strict';

const API = () => location.origin + '/wp-json/wp/v2';

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function formatDate(d) {
  try { return new Date(d).toLocaleDateString('ko-KR', {year:'numeric',month:'long',day:'numeric'}); }
  catch { return d; }
}

/* ── 사이트 설정 로드 ── */
async function loadSettings() {
  try {
    const r = await fetch(location.origin + '/wp-json/wp/v2/settings');
    return r.ok ? r.json() : {};
  } catch { return {}; }
}

/* ── 헤더 렌더링 ── */
function renderHeader(settings) {
  const name = settings?.blogname || settings?.title || 'CloudPress CMS';
  const desc = settings?.blogdescription || '';
  const siteUrl = settings?.url || '/';
  document.getElementById('pageTitle').textContent = name;
  const el = document.getElementById('siteHeader');
  if (!el) return;
  el.innerHTML = `
    <div class="site-header">
      <div class="header-inner">
        <div class="site-branding">
          <div class="site-title"><a href="${esc(siteUrl)}">${esc(name)}</a></div>
          ${desc ? `<div class="site-desc">${esc(desc)}</div>` : ''}
        </div>
        <div class="header-search">
          <input type="search" id="searchInput" placeholder="검색어 입력..." autocomplete="off">
          <button onclick="doSearch()">검색</button>
        </div>
      </div>
    </div>
    <nav class="primary">
      <div class="nav-inner">
        <a href="/">홈</a>
        <a href="/wp-admin/" style="background:rgba(0,0,0,.2)">관리자</a>
      </div>
    </nav>`;
}

function renderFooter(settings) {
  const name = settings?.blogname || settings?.title || 'CloudPress CMS';
  const el = document.getElementById('siteFooter');
  if (!el) return;
  el.innerHTML = `
    <div class="site-footer">
      <p>&copy; ${new Date().getFullYear()} ${esc(name)} — Powered by <a href="https://cloudpress.pages.dev">CloudPress</a></p>
    </div>`;
}

function doSearch() {
  const q = document.getElementById('searchInput')?.value?.trim();
  if (q) location.href = '/?search=' + encodeURIComponent(q);
}
document.addEventListener('keydown', e => {
  if (e.target?.id === 'searchInput' && e.key === 'Enter') doSearch();
});

/* ── 포스트 로드 ── */
async function loadPost(settings) {
  const slug = new URLSearchParams(location.search).get('slug') ||
    location.pathname.replace(/^\/|\/$/g, '');

  if (!slug) {
    renderError('슬러그가 없습니다.');
    return;
  }

  try {
    // 포스트 검색
    let post = null;
    const pr = await fetch(`${API()}/posts?slug=${encodeURIComponent(slug)}&_embed=1`);
    const posts = await pr.json();
    if (Array.isArray(posts) && posts.length) post = posts[0];

    // 페이지도 확인
    if (!post) {
      const pgr = await fetch(`${API()}/pages?slug=${encodeURIComponent(slug)}&_embed=1`);
      const pages = await pgr.json();
      if (Array.isArray(pages) && pages.length) post = pages[0];
    }

    if (!post) {
      renderError('요청하신 페이지를 찾을 수 없습니다.');
      return;
    }

    const siteName = settings?.blogname || settings?.title || 'CloudPress CMS';
    const title = post.title?.rendered || post.title || '제목 없음';
    const author = post._embedded?.author?.[0]?.name || '관리자';
    const catName = post._embedded?.['wp:term']?.[0]?.[0]?.name || '';

    document.getElementById('pageTitle').textContent = `${title} — ${siteName}`;
    document.getElementById('metaDesc').setAttribute('content',
      (post.excerpt?.rendered || '').replace(/<[^>]+>/g, '').slice(0, 160));

    document.getElementById('articleContent').innerHTML = `
      <div class="breadcrumb">
        <a href="/">홈</a> &rsaquo;
        ${catName ? `<a href="/?category_slug=${esc(post._embedded?.['wp:term']?.[0]?.[0]?.slug || '')}">${esc(catName)}</a> &rsaquo; ` : ''}
        <span>${esc(title.slice(0, 40))}</span>
      </div>
      <h1 class="entry-title">${title}</h1>
      <div class="entry-meta">
        <span>📅 ${formatDate(post.date)}</span>
        <span>✍️ ${esc(author)}</span>
        ${catName ? `<span>📁 ${esc(catName)}</span>` : ''}
      </div>
      <div class="entry-content">${post.content?.rendered || ''}</div>
      <nav class="post-nav" id="postNav" style="display:none"></nav>`;

    // 이전/다음 글
    const [prev, next] = await Promise.all([
      fetch(`${API()}/posts?before=${encodeURIComponent(post.date)}&per_page=1&order=desc`).then(r => r.json()).catch(() => []),
      fetch(`${API()}/posts?after=${encodeURIComponent(post.date)}&per_page=1&order=asc`).then(r => r.json()).catch(() => []),
    ]);
    const nav = document.getElementById('postNav');
    if (nav && (prev[0] || next[0])) {
      nav.style.display = 'grid';
      nav.innerHTML =
        (prev[0] ? `<a href="/${prev[0].slug}"><div class="label">← 이전 글</div>${esc(prev[0].title?.rendered || '')}</a>` : '<span></span>') +
        (next[0] ? `<a href="/${next[0].slug}" style="text-align:right"><div class="label">다음 글 →</div>${esc(next[0].title?.rendered || '')}</a>` : '<span></span>');
    }
  } catch (e) {
    renderError('포스트 로딩 실패: ' + esc(e.message));
  }
}

function renderError(msg) {
  const el = document.getElementById('articleContent');
  if (el) el.innerHTML = `
    <div style="text-align:center;padding:60px 24px">
      <h2 style="font-size:1.5rem;margin-bottom:12px">페이지를 찾을 수 없습니다</h2>
      <p style="color:#6b7280;margin-bottom:24px">${esc(msg)}</p>
      <a href="/" style="display:inline-block;padding:10px 24px;background:#2271b1;color:#fff;border-radius:4px">홈으로 돌아가기</a>
    </div>`;
}

/* ── 사이드바 ── */
async function loadSidebar() {
  try {
    const r = await fetch(`${API()}/posts?per_page=5`);
    const posts = await r.json();
    const el = document.getElementById('recentPosts');
    if (el && Array.isArray(posts)) {
      el.innerHTML = posts.map(p =>
        `<li><a href="/${p.slug}">${esc((p.title?.rendered || '').slice(0, 35))}</a></li>`
      ).join('') || '<li>게시글 없음</li>';
    }
  } catch {}

  try {
    const r = await fetch(`${API()}/categories?per_page=20`);
    const cats = await r.json();
    const el = document.getElementById('sidebarCategories');
    if (el && Array.isArray(cats) && cats.length) {
      el.innerHTML = cats.filter(c => c.count > 0)
        .map(c => `<li><a href="/?category=${c.slug}">${esc(c.name)}</a> (${c.count})</li>`)
        .join('') || '<li>카테고리 없음</li>';
    }
  } catch {}
}

/* ── 초기화 ── */
(async () => {
  const settings = await loadSettings();
  renderHeader(settings);
  renderFooter(settings);
  await Promise.all([loadPost(settings), loadSidebar()]);
})();
