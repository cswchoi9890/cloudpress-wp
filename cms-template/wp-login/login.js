/* CloudPress CMS — 로그인 페이지 JS */
'use strict';

let pwVisible = false;

function togglePw() {
  pwVisible = !pwVisible;
  const inp = document.getElementById('user_pass');
  const svg = document.getElementById('eyeIcon');
  inp.type = pwVisible ? 'text' : 'password';
  svg.innerHTML = pwVisible
    ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
    : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/>';
}

/* 사이트 이름 로드 */
fetch(location.origin + '/wp-json/wp/v2/settings')
  .then(r => r.ok ? r.json() : null)
  .then(s => {
    if (!s) return;
    const name = s.blogname || s.title;
    if (name) document.getElementById('siteTitle').textContent = name;
  })
  .catch(() => {});

/* 이미 로그인된 경우 리다이렉트 */
fetch(location.origin + '/wp-json/wp/v2/users/me', {
  credentials: 'include',
  headers: { 'X-WP-Nonce': 'cloudpress-nonce' }
}).then(r => { if (r.ok) location.href = '/wp-admin/'; }).catch(() => {});

async function doLogin() {
  const login = document.getElementById('user_login').value.trim();
  const password = document.getElementById('user_pass').value;
  const errEl = document.getElementById('loginErr');
  const okEl = document.getElementById('loginOk');
  const btn = document.getElementById('submitBtn');

  errEl.style.display = 'none';
  okEl.style.display = 'none';

  if (!login || !password) {
    errEl.textContent = '사용자명과 비밀번호를 입력해주세요.';
    errEl.style.display = '';
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>로그인 중...';

  try {
    const r = await fetch(location.origin + '/wp-login/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: login,
        password,
        remember: document.getElementById('rememberme').checked
      })
    });
    const d = await r.json();
    if (r.ok && d.token) {
      okEl.textContent = '로그인 성공! 대시보드로 이동합니다...';
      okEl.style.display = '';
      const maxAge = document.getElementById('rememberme').checked ? 60 * 60 * 24 * 30 : 60 * 60 * 24;
      document.cookie = `cp_cms_session=${d.token}; path=/; max-age=${maxAge}; SameSite=Lax`;
      const redirect = new URLSearchParams(location.search).get('redirect_to') || '/wp-admin/';
      setTimeout(() => location.href = redirect, 800);
    } else {
      errEl.textContent = d.message || '사용자명 또는 비밀번호가 올바르지 않습니다.';
      errEl.style.display = '';
      btn.disabled = false;
      btn.textContent = '로그인';
    }
  } catch (e) {
    errEl.textContent = '연결 오류: ' + e.message;
    errEl.style.display = '';
    btn.disabled = false;
    btn.textContent = '로그인';
  }
}

/* Enter 키로 로그인 */
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.target.id === 'user_login' || e.target.id === 'user_pass')) {
    doLogin();
  }
});
