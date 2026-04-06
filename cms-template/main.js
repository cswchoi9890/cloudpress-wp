/* CloudPress CMS — 프론트엔드 공통 JS */
'use strict';

/* ── 설정 & 유틸 ── */
const BASE = () => location.origin;

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch { return d; }
}

function getParam(key) {
  return new URLSearchParams(location.search).get(key) || '';
}

/* ── API ── */
async function apiGet(path) {
  const r = await fetch(BASE() + path);
  return r.json();
}

/* ── 사이트 설정 로드 ── */
let _siteSettings = null;
async function loadSiteSettings() {
  if (_siteSettings) return _siteSettings;
  try {
    _siteSettings = await apiGet('/wp-json/wp/v2/settings');
    return _siteSettings;
  } catch { return {}; }
}

/* ── 헤더 & 푸터 렌더링 ── */
async function renderSiteHeader(settings) {
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
        <a href="/" class="${location.pathname === '/' ? 'current' : ''}">홈</a>
        <a href="/wp-admin/" style="background:rgba(0,0,0,.2)">관리자</a>
      </div>
    </nav>`;
}

function renderSiteFooter(settings) {
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

/* ── 포스트 목록 렌더링 ── */
function renderPostCard(post) {
  const img = post.featured_media_url
    ? `<img class="post-thumbnail" src="${esc(post.featured_media_url)}" alt="${esc(post.title?.rendered || '')}" loading="lazy">`
    : '';
  const excerpt = (post.excerpt?.rendered || '').replace(/<[^>]+>/g, '').slice(0, 120);
  const slug = post.slug || post.id;
  return `
    <article class="post-card">
      ${img}
      <div class="post-cat">${esc(post._embedded?.['wp:term']?.[0]?.[0]?.name || '미분류')}</div>
      <h2 class="post-title"><a href="/${slug}">${esc(post.title?.rendered || post.title || '제목 없음')}</a></h2>
      <div class="post-meta">
        <span>📅 ${formatDate(post.date)}</span>
        <span>✍️ ${esc(post._embedded?.author?.[0]?.name || '관리자')}</span>
      </div>
      ${excerpt ? `<p class="post-excerpt">${esc(excerpt)}...</p>` : ''}
      <a class="read-more" href="/${slug}">더 읽기 →</a>
    </article>`;
}

function renderSidebar(settings, categories) {
  const recentEl = document.getElementById('recentPosts');
  const catEl = document.getElementById('sidebarCategories');

  if (catEl && categories?.length) {
    catEl.innerHTML = categories
      .filter(c => c.count > 0)
      .map(c => `<li><a href="/?category=${c.slug}">${esc(c.name)}</a> (${c.count})</li>`)
      .join('') || '<li>카테고리 없음</li>';
  }

  // 최근 글은 메인 로드 후 채워짐
}

/* ── 메인 포스트 목록 로드 ── */
async function loadPosts() {
  const postsEl = document.getElementById('postsArea');
  if (!postsEl) return;

  const search = getParam('search');
  const category = getParam('category');
  const page = parseInt(getParam('paged') || '1');

  let url = `/wp-json/wp/v2/posts?per_page=10&page=${page}&_embed=1&status=publish`;
  if (search) url += '&search=' + encodeURIComponent(search);
  if (category) url += '&category_slug=' + encodeURIComponent(category);

  try {
    const data = await apiGet(url);
    if (!Array.isArray(data) || data.length === 0) {
      postsEl.innerHTML = '<div class="post-card" style="text-align:center;padding:40px;color:#6b7280">게시글이 없습니다.</div>';
      return;
    }
    postsEl.innerHTML = data.map(renderPostCard).join('');

    // 최근 글 사이드바
    const recentEl = document.getElementById('recentPosts');
    if (recentEl) {
      recentEl.innerHTML = data.slice(0, 5)
        .map(p => `<li><a href="/${p.slug || p.id}">${esc(p.title?.rendered || p.title || '제목 없음')}</a></li>`)
        .join('');
    }
  } catch (e) {
    postsEl.innerHTML = '<div class="post-card" style="text-align:center;padding:40px;color:#d63638">글 목록 로딩 실패</div>';
  }
}

/* ── 카테고리 로드 ── */
async function loadCategories() {
  try {
    const cats = await apiGet('/wp-json/wp/v2/categories?per_page=20');
    return Array.isArray(cats) ? cats : [];
  } catch { return []; }
}

/* ── 초기화 ── */
(async () => {
  const settings = await loadSiteSettings();
  renderSiteHeader(settings);
  renderSiteFooter(settings);
  const cats = await loadCategories();
  renderSidebar(settings, cats);
  await loadPosts();
})();
