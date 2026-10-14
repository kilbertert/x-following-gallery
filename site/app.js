/**
 * X-Following-Gallery — static client
 * Data contract: data/archive.json → [{id, screen_name, name, avatar_url, cover_url,
 *   followers_count, description, verified, backed_up_at, archived_at, is_suspended,
 *   last_synced_at, url, links, tags}]
 * All rendering is client-side; the JSON ships as a static asset (never D1), and
 * images resolve to the R2 public domain so no Worker request is spent per image.
 */
(() => {
  'use strict';

  const ENV = window.__ENV__ || {};
  const CACHE_KEY = 'xfg_cache_v1';
  const HISTORY_CACHE = 'xfg_history_v1';
  const CONFIG_KEY = 'xfg_config_v1';
  const THEME_KEY = 'xfg_theme';
  const CACHE_TTL = 6 * 60 * 60 * 1000;   // serve cached JSON for 6h, then revalidate
  const PAGE_SIZE = 60;
  const HOT_RANK = 425;                   // size of the "热度排行" leaderboard

  const state = {
    all: [], visible: [], filter: 'all', sort: 'followers_desc',
    query: '', page: 1, view: 'grid', rendered: 0, dead: 0,
    spot: null, rouletteBusy: false,
  };

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /**
   * esc() neutralises markup but not the URL scheme, so a `url` field of
   * `javascript:…` would survive into an href (or into `.href =`, which the
   * modal uses). Only http(s) is ever emitted as a link target.
   */
  const safeUrl = (u, fallback = '') => {
    const s = String(u == null ? '' : u).trim();
    return /^https?:\/\//i.test(s) ? s : fallback;
  };
  const xProfile = (a) => safeUrl(a.url, `https://x.com/${encodeURIComponent(a.screen_name || '')}`);

  // ---------------------------------------------------------------- formatting
  const fmtCount = (n) => {
    n = Number(n) || 0;
    if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  };
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const relTime = (iso) => {
    if (!iso) return '—';
    const diff = Date.now() - new Date(iso).getTime();
    if (isNaN(diff)) return '—';
    const day = 864e5;
    if (diff < 36e5) return Math.max(1, Math.round(diff / 6e4)) + ' 分钟前';
    if (diff < day) return Math.round(diff / 36e5) + ' 小时前';
    if (diff < 30 * day) return Math.round(diff / day) + ' 天前';
    return fmtDate(iso);
  };
  const tier = (n) => (n >= 5e5 ? 'top' : n >= 1e5 ? 'known' : '');
  const tierLabel = (n) => (n >= 5e5 ? 'Top' : n >= 1e5 ? '创作者' : '');
  // Graveyard membership is driven by archived_at — set whenever an account
  // drops out of the following list, regardless of whether --classify later
  // confirmed the cause. is_suspended/is_blocked only refine *why*.
  const isDead = (a) => !!(a.archived_at || a.is_suspended || a.is_blocked);
  const deadLabel = (a) => (a.is_suspended ? '已封禁' : a.is_blocked ? '已注销' : '已取关');

  const R2 = () => (ENV.R2_PUBLIC_DOMAIN || '').replace(/\/$/, '');
  /**
   * Resolve a record's media field to a loadable URL. Anything already absolute
   * (https:, data:, blob:, protocol-relative //) is passed through untouched —
   * `data:` in particular must not be treated as a path, or the offline demo
   * dataset 404s every avatar.
   */
  const media = (u) => {
    if (!u) return '';
    // scheme allowlist — a `javascript:`/`vbscript:` value here is inert inside
    // <img>, but rejecting it keeps the field from ever reaching a src attribute.
    if (/^https?:/i.test(u) || /^data:image\//i.test(u) || /^blob:/i.test(u) || u.startsWith('//')) return u;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return '';          // any other absolute scheme
    const base = R2();
    if (!base) return u.startsWith('/') ? u : '/' + u;
    return base + (u.startsWith('/') ? u : '/' + u);
  };
  const AVATAR_FALLBACK = 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="#1a1a1f"/><circle cx="40" cy="31" r="15" fill="#3a3a44"/><path d="M12 80c3-17 15-25 28-25s25 8 28 25z" fill="#3a3a44"/></svg>`);
  // Delegated <img> error fallback. Kept as a listener rather than an inline
  // onerror= attribute because the strict CSP in site/_headers forbids inline
  // handlers (that inline-handler hole is exactly how the reference site leaked
  // a session in the 2026-09-20 XSS incident).
  function applyImgFallback(img) {
    if (!img || img.dataset.fb) return;
    img.dataset.fb = '1';
    if (img.dataset.fallback === 'blank') { img.style.visibility = 'hidden'; return; }
    img.src = AVATAR_FALLBACK;
  }
  const xlinksIn = (text) => {
    const out = [];
    const re = /(https?:\/\/[^\s<>"）)】\]]+|(?:t\.co|linktr\.ee|lit\.link)\/[^\s<>"）)】\]]+)/g;
    let m; while ((m = re.exec(text || '')) && out.length < 6) {
      let u = m[1].replace(/[.,;:]+$/, '');
      out.push(/^https?:/.test(u) ? u : 'https://' + u);
    }
    return out;
  };

  // ---------------------------------------------------------------- data layer
  const readCache = (key) => {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  };
  const writeCache = (key, val) => {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* quota — ignore */ }
  };
  async function loadJson(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.json();
  }
  async function loadConfig() {
    try {
      const cfg = await loadJson('runtime-config.json');
      if (cfg && cfg.r2_public_domain) ENV.R2_PUBLIC_DOMAIN = cfg.r2_public_domain;
      writeCache(CONFIG_KEY, { ...cfg, _at: Date.now() });
    } catch {
      const cached = readCache(CONFIG_KEY);
      if (cached && cached.r2_public_domain) ENV.R2_PUBLIC_DOMAIN = cached.r2_public_domain;
    }
  }
  async function loadData() {
    const cached = readCache(CACHE_KEY);
    const fresh = cached && Date.now() - cached._at < CACHE_TTL;
    if (cached && Array.isArray(cached.records) && cached.records.length) {
      render(cached.records);
      if (fresh) return;                        // serve cache, skip network entirely
      refreshInBackground();
      return;
    }
    await refreshInBackground(true);
  }
  async function refreshInBackground(firstPaint) {
    try {
      const list = await loadJson('data/archive.json');
      const records = Array.isArray(list) ? list : (list.records || list.data || []);
      if (firstPaint) render(records);
      else if (records.length) render(records, { soft: true });
      writeCache(CACHE_KEY, { _at: Date.now(), records });
    } catch (err) {
      console.error('[xfg] data load failed', err);
      if (firstPaint) renderError(err);
    }
  }

  /**
   * The change timeline (data/history.json) is only needed when a detail drawer
   * opens, so it is fetched lazily and cached — a visitor who never opens one
   * never downloads it. Keyed by account id.
   */
  let historyPromise = null;
  function loadHistory() {
    if (historyPromise) return historyPromise;
    historyPromise = (async () => {
      let events = readCache(HISTORY_CACHE)?.events;
      if (!Array.isArray(events)) {
        try {
          const h = await loadJson('data/history.json');
          events = Array.isArray(h) ? h : (h.events || []);
        } catch { events = []; }
      }
      const byId = new Map();
      for (const e of events) {
        if (!e || !e.id) continue;
        if (!byId.has(e.id)) byId.set(e.id, []);
        byId.get(e.id).push(e);
      }
      for (const list of byId.values()) list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      writeCache(HISTORY_CACHE, { events });
      return byId;
    })();
    return historyPromise;
  }
  const eventLabel = (e) => ({
    added: '首次归档', archived: '进入赛博坟场', restored: '取消归档', updated: '资料变更',
  }[e.event] || e.event);
  const eventDetail = (e) => {
    if (e.event === 'archived') return { suspended: '账号被封禁', deleted: '账号已注销', unfollowed: '已取消关注' }[e.detail?.reason] || '退出关注列表';
    if (e.event !== 'updated') return '';
    return Object.entries(e.detail || {}).map(([f, v]) => {
      if (f === 'tier') return `影响力层级 ${v.from} → ${v.to}`;
      if (f === 'verified') return `认证 ${v.from ? '有' : '无'} → ${v.to ? '有' : '无'}`;
      if (f === 'name') return '昵称已更改';
      if (f === 'screen_name') return '用户名已更改';
      if (f === 'description') return '简介已更改';
      if (f === 'avatar_url' || f === 'cover_url') return '图片已更新';
      return f + ' 已更新';
    }).join('；');
  };

  // ---------------------------------------------------------------- filtering
  const matches = (a) => {
    if (state.filter === 'dead' && !isDead(a)) return false;
    if (state.filter !== 'dead' && state.filter !== 'all' && isDead(a)) return false;
    if (state.filter === 'verified' && !a.verified) return false;
    if (state.filter === 'top' && !(a.followers_count >= 5e5)) return false;
    if (state.filter === 'known' && !(a.followers_count >= 1e5)) return false;
    if (state.filter === 'recent') {
      const w = Date.now() - 30 * 864e5;
      if (!a.backed_up_at || new Date(a.backed_up_at).getTime() < w) return false;
    }
    if (state.query) {
      const q = state.query.toLowerCase();
      const hay = [a.name, a.screen_name, a.description, (a.tags || []).join(' ')]
        .join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };
  const SORTS = {
    followers_desc: (a, b) => (b.followers_count || 0) - (a.followers_count || 0),
    followers_asc: (a, b) => (a.followers_count || 0) - (b.followers_count || 0),
    name_asc: (a, b) => String(a.name || a.screen_name || '').localeCompare(String(b.name || b.screen_name || ''), 'zh-Hans-CN'),
    archived_desc: (a, b) => new Date(b.backed_up_at || 0) - new Date(a.backed_up_at || 0),
  };
  function refilter() {
    const list = state.all.filter(matches);
    // "热度排行" is a rank, not a per-record property, so it cannot live in
    // matches() — it is the top N by followers. Strip dead accounts first so the
    // rank and the visible count agree.
    state.visible = state.filter === 'hot'
      ? list.filter((a) => !isDead(a)).sort(SORTS.followers_desc).slice(0, HOT_RANK)
      : list.sort(SORTS[state.sort] || SORTS.followers_desc);
    state.page = 1;
    renderWall(true);
    updateCounts();
  }

  // ---------------------------------------------------------------- counts / metrics
  function updateCounts() {
    const a = state.all;
    const cnt = {
      all: a.filter((x) => !isDead(x)).length,
      hot: Math.min(HOT_RANK, a.filter((x) => !isDead(x)).length),
      verified: a.filter((x) => x.verified && !isDead(x)).length,
      top: a.filter((x) => x.followers_count >= 5e5 && !isDead(x)).length,
      known: a.filter((x) => x.followers_count >= 1e5 && !isDead(x)).length,
      recent: a.filter((x) => (Date.now() - new Date(x.backed_up_at || 0).getTime()) < 30 * 864e5 && !isDead(x)).length,
      dead: a.filter(isDead).length,
    };
    const PILLS = [
      ['all', '全部', cnt.all], ['hot', '热度排行', cnt.hot], ['verified', '蓝标认证', cnt.verified],
      ['top', 'Top 头部 (50万+)', cnt.top], ['known', '知名创作者 (10万+)', cnt.known],
      ['recent', '最新归档', cnt.recent], ['dead', '赛博坟场', cnt.dead],
    ];
    const pills = $('pills');
    pills.innerHTML = '';
    for (const [key, label, n] of PILLS) {
      const b = el('button', 'f-pill' + (state.filter === key ? ' active' : ''), `${esc(label)}<span class="pill-badge">${n}</span>`);
      b.dataset.key = key;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(state.filter === key));
      b.onclick = () => { state.filter = key; updateCounts(); refilter(); };
      pills.appendChild(b);
    }
    const live = a.filter((x) => !isDead(x));
    const max = live.reduce((m, x) => Math.max(m, x.followers_count || 0), 0);
    $('mTotal').textContent = cnt.all;
    $('mVerified').textContent = cnt.verified;
    $('mTop').textContent = cnt.top;
    $('mKnown').textContent = cnt.known;
    $('mMax').textContent = fmtCount(max);
    $('mDead').textContent = cnt.dead;
    $('resultCount').textContent = `${state.visible.length} / ${a.length} 位博主`;
  }

  // ---------------------------------------------------------------- card
  function buildCard(a) {
    const dead = isDead(a);
    const c = el('article', 'card');
    c.dataset.dead = dead ? '1' : '0';
    c.tabIndex = 0;
    c.setAttribute('role', 'button');
    c.setAttribute('aria-label', `${a.name || a.screen_name} 详情`);

    const t = tier(a.followers_count || 0);
    const links = (a.links && a.links.length ? a.links : xlinksIn(a.description)).slice(0, 2);
    c.innerHTML = `
      ${dead ? `<span class="dead-tag">${deadLabel(a)}</span>` : ''}
      <div class="card-banner">
        <img src="${esc(media(a.cover_url))}" alt="" loading="lazy" decoding="async"
             data-fallback="blank">
      </div>
      <div class="card-avatar-wrap">
        <img class="card-avatar" src="${esc(media(a.avatar_url) || AVATAR_FALLBACK)}" alt="${esc(a.name)}" loading="lazy" decoding="async">
        ${a.verified ? `<span class="verified-badge" title="官方认证"><svg viewBox="0 0 24 24" fill="currentColor"><path d="m9.5 17-5-5 1.4-1.4L9.5 14.2l8.6-8.6L19.5 7z"/></svg></span>` : ''}
      </div>
      <div class="card-body">
        <div class="card-head">
          <h3 class="card-name" title="${esc(a.name)}">${esc(a.name || a.screen_name)}</h3>
          <span class="card-handle">@${esc(a.screen_name)}</span>
        </div>
        <div class="card-meta">
          ${t ? `<span class="card-influence-pill" data-tier="${t}">${tierLabel(a.followers_count)}</span>` : ''}
          <span class="followers">${fmtCount(a.followers_count)} 粉丝</span>
        </div>
        <p class="card-bio">${esc(a.description || '') || '<span style="opacity:.5">（无简介）</span>'}</p>
        ${links.length ? `<div class="card-tags">${links.map((u) => `<span class="card-tag">${esc(u.replace(/^https?:\/\//, '').slice(0, 34))}</span>`).join('')}</div>` : ''}
        <div class="card-foot">
          <span>归档 ${relTime(a.backed_up_at)}</span>
          <span class="card-cta">查看 ↗</span>
        </div>
      </div>`;
    const open = (e) => { e.preventDefault(); openDetail(a); };
    c.addEventListener('click', (e) => {
      const tag = e.target.closest('.card-tag');
      if (tag) { return; }        // let link chips bubble nowhere; detail opens anyway
      open(e);
    });
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(e); });
    return c;
  }

  // ---------------------------------------------------------------- masonry wall
  const COLS = () => (state.view === 'compact' ? 4 : 3);
  function renderWall(reset) {
    const wall = $('wall');
    wall.dataset.view = state.view;
    if (reset) { wall.innerHTML = ''; state.rendered = 0; }
    const slice = state.visible.slice(state.rendered, state.rendered + PAGE_SIZE);
    if (!slice.length) { finalizeWall(); return; }

    let cols = [...wall.querySelectorAll('.masonry-column')];
    const want = state.view === 'list' ? 1 : COLS();
    if (cols.length !== want) {
      wall.innerHTML = '';
      cols = Array.from({ length: want }, () => el('div', 'masonry-column'));
      cols.forEach((c) => wall.appendChild(c));
    }
    // Place each card into the currently shortest column → discrete masonry.
    // Strict `<` (not `<=`) is deliberate: on a tie the *earlier* column wins, so
    // the highest-ranked card lands top-left. With `<=` the first card would be
    // pushed to the last column and the #1 account would render bottom-right.
    for (const a of slice) {
      const target = state.view === 'list'
        ? cols[0]
        : cols.reduce((shortest, c) => (c.offsetHeight < shortest.offsetHeight ? c : shortest), cols[0]);
      target.appendChild(buildCard(a));
      state.rendered++;
    }
    finalizeWall();
  }
  function finalizeWall() {
    // A stale trailing column from the previous (shorter) filter would otherwise
    // survive as an empty box, inflating the column count and the layout width.
    document.querySelectorAll('.masonry-column[data-tail]').forEach((c) => c.remove());
    // Hide the sentinel only once everything is rendered. Hiding it while more
    // pages remain would display:none the IntersectionObserver target and
    // silently cap a 3,000-account archive at the first PAGE_SIZE cards.
    $('sentinel').hidden = state.rendered >= state.visible.length;
    const none = state.visible.length === 0;
    $('empty').hidden = !none;
    if (none) {
      $('emptyHint').textContent = state.all.length
        ? '试试换个关键词，或点「随机探索」。'
        : '尚未同步数据。运行 scripts/sync.mjs 拉取你的关注列表后再部署。';
    }
  }

  // ---------------------------------------------------------------- spotlight
  function pickSpotlight() {
    const pool = state.all.filter((a) => !isDead(a) && a.verified && a.name);
    const list = pool.length ? pool : state.all.filter((a) => !isDead(a));
    if (!list.length) return;
    state.spot = list[Math.floor(Math.random() * list.length)];
    renderSpotlight();
  }
  function renderSpotlight() {
    const a = state.spot;
    if (!a) return;
    $('spotlight').hidden = false;
    $('spAvatar').src = media(a.avatar_url) || AVATAR_FALLBACK;
    $('spAvatar').alt = a.name || a.screen_name;
    $('spName').textContent = `${a.name || a.screen_name}  @${a.screen_name}`;
    $('spBio').textContent = a.description || '（无简介）';
    $('spLink').href = xProfile(a);
    $('spDetail').onclick = () => openDetail(a);
    const b = $('spBanner');
    if (a.cover_url) { b.src = media(a.cover_url); b.hidden = false; }
    else b.hidden = true;
  }

  // ---------------------------------------------------------------- detail modal
  function openDetail(a) {
    const dead = isDead(a);
    const links = (a.links && a.links.length ? a.links : xlinksIn(a.description));
    $('modalBody').innerHTML = `
      <div class="modal-hero">${a.cover_url ? `<img src="${esc(media(a.cover_url))}" alt="" data-fallback="blank">` : ''}</div>
      <div class="modal-pad">
        <img class="modal-avatar" src="${esc(media(a.avatar_url) || AVATAR_FALLBACK)}" alt="" data-fallback="blank">
        <h3 class="modal-name" id="modalTitle">${esc(a.name || a.screen_name)}
          ${a.verified ? `<span class="verified-badge" style="position:static;display:inline-grid;vertical-align:middle;margin-left:6px;border-width:0;width:20px;height:20px"><svg viewBox="0 0 24 24" fill="#fff" style="width:11px;height:11px"><path d="m9.5 17-5-5 1.4-1.4L9.5 14.2l8.6-8.6L19.5 7z"/></svg></span>` : ''}
        </h3>
        <p class="modal-handle">@${esc(a.screen_name)}</p>
        <p class="modal-bio">${esc(a.description || '（无简介）')}</p>

        <div class="modal-grid">
          <div class="modal-cell"><span>粉丝数</span><b>${fmtCount(a.followers_count)}</b></div>
          <div class="modal-cell"><span>账号状态</span><b style="color:${dead ? 'var(--accent-danger)' : 'var(--accent-primary)'}">${dead ? deadLabel(a) : '正常'}</b></div>
          <div class="modal-cell"><span>首次归档</span><b>${fmtDate(a.backed_up_at)}</b></div>
          <div class="modal-cell"><span>最近同步</span><b>${fmtDate(a.last_synced_at || a.backed_up_at)}</b></div>
        </div>

        ${links.length ? `<div class="modal-links">${links.map((u) => { const safe = safeUrl(u); return safe ? `<a class="btn-outline" href="${esc(safe)}" target="_blank" rel="noopener noreferrer nofollow">${esc(safe.replace(/^https?:\/\//, '').slice(0, 44))} ↗</a>` : ''; }).join('')}</div>` : ''}

        <div class="timeline" id="timeline" hidden>
          <h4 class="timeline-title">时光档案 <span class="timeline-count" id="timelineCount"></span></h4>
          <ol class="timeline-list" id="timelineList"></ol>
        </div>

        <div class="modal-actions">
          <a class="btn-primary" href="${esc(xProfile(a))}" target="_blank" rel="noopener noreferrer">访问 X ↗</a>
          <button class="btn-ghost" data-close>关闭</button>
        </div>
      </div>`;
    showModal();
    renderTimeline(a.id);
  }

  /** Fill the drawer's timeline once history.json resolves; no-op if empty. */
  async function renderTimeline(id) {
    const events = (await loadHistory()).get(String(id)) || [];
    const box = $('timeline');
    if (!box || box.hidden === undefined) return;            // drawer was closed/replaced
    if (!events.length) return;
    const list = $('timelineList');
    if (!list) return;
    $('timelineCount').textContent = `${events.length} 条`;
    list.innerHTML = events.slice().reverse().map((e) => `
      <li class="timeline-item" data-event="${esc(e.event)}">
        <time class="timeline-time">${fmtDate(e.ts)}</time>
        <span class="timeline-dot"></span>
        <div class="timeline-body">
          <b class="timeline-label">${esc(eventLabel(e))}</b>
          ${eventDetail(e) ? `<span class="timeline-detail">${esc(eventDetail(e))}</span>` : ''}
        </div>
      </li>`).join('');
    box.hidden = false;
  }

  // ---------------------------------------------------------------- roulette
  function roulette() {
    if (state.rouletteBusy || !state.all.length) return;
    const pool = state.all.filter((a) => !isDead(a));
    if (!pool.length) return;
    state.rouletteBusy = true;
    const winner = pool[Math.floor(Math.random() * pool.length)];
    $('modalBody').innerHTML = `
      <div class="roulette">
        <p class="spark" style="text-align:center;padding-top:22px">正在为你抽取…</p>
        <img class="roulette-img" id="rollImg" alt="">
        <p class="roulette-name" id="rollName">—</p>
      </div>`;
    showModal();
    let step = 0;
    const total = 16;
    const tick = () => {
      const a = pool[Math.floor(Math.random() * pool.length)];
      $('rollImg').src = media(a.avatar_url) || AVATAR_FALLBACK;
      $('rollName').textContent = `@${a.screen_name}`;
      step++;
      if (step < total) {
        const delay = 60 + Math.pow(step / total, 2.4) * 420;   // decelerate
        setTimeout(tick, delay);
      } else {
        state.rouletteBusy = false;
        setTimeout(() => openDetail(winner), 240);
      }
    };
    tick();
  }

  function showModal() { $('modal').hidden = false; document.documentElement.style.overflow = 'hidden'; }
  function closeModal() { $('modal').hidden = true; document.documentElement.style.overflow = ''; }

  // ---------------------------------------------------------------- theme
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode — ignore */ }
  }
  function initTheme() {
    let t = null;
    try { t = localStorage.getItem(THEME_KEY); } catch {}
    if (t !== 'light' && t !== 'oled') {
      t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'oled';
    }
    document.documentElement.dataset.theme = t;
  }

  // ---------------------------------------------------------------- starfield
  function starfield() {
    const cv = $('stars');
    const ctx = cv.getContext('2d');
    let w, h, stars = [], raf;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const resize = () => {
      w = cv.width = innerWidth; h = cv.height = innerHeight;
      const n = Math.min(160, Math.round(w * h / 14000));
      stars = Array.from({ length: n }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        r: Math.random() * 1.3 + .2, a: Math.random() * .5 + .15,
        v: Math.random() * .12 + .03,
      }));
    };
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        s.y -= s.v; if (s.y < -2) { s.y = h + 2; s.x = Math.random() * w; }
        ctx.globalAlpha = s.a;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fillStyle = '#cfe8ff'; ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    resize(); draw();
    addEventListener('resize', () => { resize(); if (reduce) draw(); }, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else if (!reduce) raf = requestAnimationFrame(draw);
    });
  }

  // ---------------------------------------------------------------- infinite scroll
  function initScroll() {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting && state.rendered < state.visible.length) {
        renderWall(false);
      }
    }, { rootMargin: '600px' });
    io.observe($('sentinel'));

    const top = $('toTop');
    addEventListener('scroll', () => { top.hidden = scrollY < 700; }, { passive: true });
    top.onclick = () => scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------------------------------------------------------------- shortcuts
  function initKeys() {
    addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (e.key === 'Escape') { closeModal(); if (typing) document.activeElement.blur(); return; }
      if (typing) return;
      if (e.key === '/') { e.preventDefault(); $('search').focus(); }
      else if (e.key === 'r' || e.key === 'R') roulette();
      else if (e.key === 't' || e.key === 'T') setTheme(document.documentElement.dataset.theme === 'oled' ? 'light' : 'oled');
      else if (e.key === '1') setView('grid');
      else if (e.key === '2') setView('compact');
      else if (e.key === '3') setView('list');
    });
  }
  function setView(v) {
    state.view = v;
    [...$('viewSwitch').children].forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    renderWall(true);
    finalizeWall();
  }

  // ---------------------------------------------------------------- render / boot
  function render(records, opts = {}) {
    state.all = records.filter((r) => r && (r.screen_name || r.id));
    if (opts.soft) { const y = scrollY; refilter(); scrollTo(0, y); return; }
    refilter();
    pickSpotlight();
  }
  function renderError(err) {
    $('empty').hidden = false;
    $('emptyHint').textContent = '数据加载失败：' + err.message;
    $('sentinel').hidden = true;
    console.error(err);
  }

  async function boot() {
    initTheme();
    starfield();
    initKeys();
    initScroll();

    // one capture-phase listener covers every <img>, including re-rendered cards
    document.addEventListener('error', (e) => {
      if (e.target && e.target.tagName === 'IMG') applyImgFallback(e.target);
    }, true);

    $('search').addEventListener('input', debounce((e) => {
      state.query = e.target.value.trim(); state.page = 1; refilter();
    }, 180));
    $('sort').addEventListener('change', (e) => { state.sort = e.target.value; refilter(); });
    $('luckBtn').addEventListener('click', roulette);
    $('shuffleBtn').addEventListener('click', pickSpotlight);
    $('themeBtn').addEventListener('click', () =>
      setTheme(document.documentElement.dataset.theme === 'oled' ? 'light' : 'oled'));
    [...$('viewSwitch').children].forEach((b) => { b.onclick = () => setView(b.dataset.view); });
    $('modal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
    $('curator').textContent = ENV.OWNER_HANDLE ? `策展人 · @${ENV.OWNER_HANDLE}` : '';
    $('footerMeta').textContent = `数据生成于 ${fmtDate(ENV.GENERATED_AT)} · 静态托管 · 边缘缓存`;

    await loadConfig();
    await loadData();                      // render() is called from inside
    updateCounts();
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
  else boot();
})();
