// ЯМА / SOULPIT: one page, hash routes, polling instead of sockets.
// The API may live elsewhere (the site on GitHub Pages, the API on another host): config.js sets window.SOULPIT.api.
// Two languages: every string is written L('русский', 'English') where it is used; the choice is kept in localStorage.
// Routes: #/ · #/lobbies · #/lobby · #/heroes · #/hero/<id> · #/items · #/modes · #/guide · #/top · #/matches   (the admin desk is a page of its own: /admin/)

const API = ((window.SOULPIT && window.SOULPIT.api) || '').replace(/\/$/, '');
const IMG_EXT = (window.SOULPIT && window.SOULPIT.img) || 'png';  // the published site has WebP images
const TOKEN_KEY = 'yama_token';
const LANG_KEY = 'yama_lang';
let LANG = (() => {
  try { const saved = localStorage.getItem(LANG_KEY); if (saved === 'ru' || saved === 'en') return saved; } catch { /* private mode */ }
  return (navigator.language || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
})();
const L = (ru, en) => (LANG === 'en' ? en : ru);
const LOCALE = () => L('ru-RU', 'en-GB');
const DATA_SUFFIX = () => L('', '.en');

let token = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
let config = null;
let me = null;             // {sid, name, avatar}
let lobby = null;          // the lobby I sit in, as the server shows it to me
let pulse = { online: 0, lobbies: [], matches: [] };
let heroes = [];           // static/data/heroes[.en].json (build_heroes.py); empty when not built
let items = null;          // static/data/items[.en].json, loaded on the items page
let heroById = {}, heroByName = {};
let featured = [];         // heroes shown on the front page, picked once per visit
let ranks = [];            // static/data/ranks[.en].json: names of rank 0 (calibration) .. 11
let pendingBan = null;     // hero clicked in the ban phase, not yet sent
let clock = null;          // {left, total, at}: the phase countdown, ticked locally between polls
let lastHtml = '', lastKey = '', lastState = null, lastLobby = null;
const ui = { heroType: '', heroQuery: '', heroView: 'cards', heroSort: 'name', heroSortDir: 1, itemSlot: 'weapon', item: null, mineOnly: false };
const chat = { channel: 'global', logs: {} };  // channel -> {since, msgs}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const route = () => (location.hash.replace(/^#/, '') || '/').split('?')[0];
const go = (r) => { if (route() !== r) location.hash = '#' + r; };
const modeOf = (id) => config.modes.find((m) => m.id === id) || { name: id };
const modeName = (m) => L(m.name, m.name_en || m.name);
const modeNameById = (id) => modeName(modeOf(id));
const img = (file) => file ? `/static/data/img/${encodeURIComponent(file)}` : '';
const TEAM_CLASS = ['amber', 'sapphire'];
const TEAM_SIDE = ['Amber', 'Sapphire'];
const TYPES = () => [['', L('Все', 'All')], ['Marksman', L('Стрелки', 'Marksmen')], ['Mystic', L('Мистики', 'Mystics')],
  ['Brawler', L('Дебоширы', 'Brawlers')], ['Assassin', L('Ассасины', 'Assassins')]];
const SLOT_NAMES = () => ({ weapon: L('Оружие', 'Weapon'), vitality: L('Живучесть', 'Vitality'), spirit: L('Дух', 'Spirit') });
const ROMAN = ['I', 'II', 'III', 'IV'];

// ---------- api ----------

async function api(path, body) {
  const res = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Token': token || '', 'X-Lang': LANG },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (res.status === 401 && token) { setToken(null); me = null; lobby = null; }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function setToken(t, persist) {
  token = t;
  if (t) {
    sessionStorage.setItem(TOKEN_KEY, t);
    if (persist) localStorage.setItem(TOKEN_KEY, t);
  } else {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
  }
}

let errorTimer = null;
function showError(message) {
  $('error').textContent = message;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { $('error').textContent = ''; }, 5000);
}

async function act(path, body) {
  let data;
  try {
    data = await api(path, body);
  } catch (e) {
    showError(e.message);
    return sync();
  }
  const m = path.match(/^\/api\/lobbies(?:\/[0-9a-f]+\/(\w+))?$/);
  if (m && me) {
    // the server answers lobby actions with the lobby as it is now; after leaving it is not mine any more
    applyState({ user: me, lobby: m[1] === 'leave' || !data?.id ? null : data });
  } else {
    await sync();
  }
  return data;
}

// ---------- language ----------

async function loadData() {
  const get = (name) => fetch(`/static/data/${name}${DATA_SUFFIX()}.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  let rankList;
  [heroes, rankList] = await Promise.all([get('heroes'), get('ranks')]);
  ranks = Object.fromEntries(rankList.map((r) => [r.tier, r]));
  heroById = Object.fromEntries(heroes.map((h) => [h.id, h]));
  heroByName = Object.fromEntries(heroes.map((h) => [h.name, h]));
  const keep = new Set(featured.map((h) => h.id));
  featured = keep.size ? heroes.filter((h) => keep.has(h.id)) : heroes.slice().sort(() => 0.5 - Math.random()).slice(0, 8);
  items = null;
  itemsLoading = false;
}

async function setLang(lang) {
  if (lang === LANG) return;
  LANG = lang;
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* private mode */ }
  await loadData();
  for (const k of Object.keys(remoteCache)) delete remoteCache[k];
  applyStatic();
  lastHtml = '';
  renderMsgs(true);
  renderTicker();
  render();
}

// the parts of index.html outside the rendered view
function applyStatic() {
  document.documentElement.lang = LANG;
  document.title = L('ЯМА — кастомные матчи Deadlock', 'SOULPIT — custom Deadlock matches');
  $('logoName').innerHTML = L('ЯМ<i>А</i>', 'SOUL<i>PIT</i>');
  $('logoSub').textContent = L('кастомные матчи Deadlock', 'custom Deadlock matches');
  $('chatTitle').textContent = L('Чат', 'Chat');
  $('chatFab').textContent = L('Чат', 'Chat');
  $('railClose').setAttribute('aria-label', L('Закрыть чат', 'Close chat'));
  $('sayButton').setAttribute('aria-label', L('Отправить', 'Send'));
  $('footNote').textContent = L('ЯМА — фанатский сайт кастомных матчей. Не связан с Valve.',
    'SOULPIT is a fan site for custom matches, not affiliated with Valve.');
}

// ---------- polling ----------

async function refresh() {
  if (!token) { me = null; lobby = null; return render(); }
  try {
    applyState(await api('/api/me'));
  } catch (e) {
    if (token) showError(e.message);
  }
}

function applyState(r) {
  me = r.user;
  lobby = r.lobby;
  clock = lobby?.phase ? { left: lobby.phase.seconds_left, total: lobby.phase.total, at: performance.now() } : null;
  if (lobby?.state !== 'bans') pendingBan = null;
  const id = lobby?.id || null;
  if (id !== lastLobby) {
    // joined: open the lobby and its chat; left or kicked: back to the list and the global chat
    switchChannel(id ? 'lobby:' + id : 'global');
    if (id) go('/lobby');
    else if (route() === '/lobby') go('/lobbies');
  } else if (lobby && lobby.state !== lastState && lobby.state !== 'waiting') {
    go('/lobby');  // the draft starts for everyone at once
  }
  lastLobby = id;
  lastState = lobby?.state || null;
  render();
}

async function refreshPulse() {
  try { pulse = await api('/api/pulse'); } catch { /* keep the old one */ }
  renderTicker();
  render();
}

// /api/sync: me and my lobby, new lines of the open chat and, every few seconds, the pulse, in one request
let syncing = null;
let pulseAt = 0;
function sync() {
  if (syncing) return syncing;
  syncing = (async () => {
    const channel = chat.channel;
    const log = chat.logs[channel];
    const wantPulse = Date.now() - pulseAt > 3000;
    try {
      const r = await api(`/api/sync?channel=${encodeURIComponent(channel)}&since=${log ? log.since : 0}${wantPulse ? '&pulse=1' : ''}`);
      if (r.pulse) { pulse = r.pulse; pulseAt = Date.now(); renderTicker(); }
      if (token && !r.signed_in) setToken(null);
      if (r.me) applyState(r.me);
      else { me = null; lobby = null; }
      if (r.chat && channel === chat.channel) addChat(channel, r.chat);
      render();
    } catch { /* offline for a moment: the next round tries again */ } finally {
      syncing = null;
    }
  })();
  return syncing;
}

function syncLoop() {
  // faster while a draft is running, slower in a background tab
  const busy = lobby && !['waiting', 'live'].includes(lobby.state);
  sync().finally(() => setTimeout(syncLoop, document.hidden ? 5000 : busy ? 700 : 1500));
}

// ---------- shell ----------

function render() {
  renderNav();
  renderMe();
  renderRail();
  renderNotice();
  const html = view();
  const key = route() + ':' + (lobby?.state || '');
  if (html !== lastHtml) {
    // don't redraw the same screen while the user types in it
    const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && $('view').contains(document.activeElement);
    if (!(typing && key === lastKey)) {
      $('view').innerHTML = html;
      lastHtml = html;
      lastKey = key;
    }
  }
  tickClock();
}


function renderNav() {
  const open = pulse.lobbies.filter((l) => l.state === 'waiting').length;
  const r = route();
  const items = [
    ['/', L('Главная', 'Home')],
    ['/lobbies', `${L('Лобби', 'Lobbies')}${open ? ` <sup>${open}</sup>` : ''}`],
    ...(lobby ? [['/lobby', L('Моё лобби', 'My lobby'), 'mine']] : []),
    ['/top', L('Рейтинг', 'Ranking')],
    ['/matches', L('Матчи', 'Matches')],
    ['/heroes', L('Герои', 'Heroes')],
    ['/items', L('Предметы', 'Items')],
    ['/guide', L('Как играть', 'How to play')],
  ];
  const on = (p) => r === p || (p === '/heroes' && r.startsWith('/hero/')) || (p === '/matches' && r.startsWith('/match/'));
  const html = items.map(([p, label, cls]) => `<a href="#${p}" class="${on(p) ? 'on' : ''} ${cls || ''}">${label}</a>`).join('')
    + (me?.admin ? `<a href="/admin/" class="admin-link">${L('Пульт', 'Admin')} ↗</a>` : '');
  if ($('nav').innerHTML !== html) $('nav').innerHTML = html;
}

function avatar(u, cls = '') {
  return u?.avatar
    ? `<img class="avatar ${cls}" src="${esc(u.avatar)}" alt="">`
    : `<span class="avatar ${cls}">${esc((u?.name || '?').slice(0, 1))}</span>`;
}

function renderMe() {
  const langs = `<span class="lang" role="group" aria-label="${L('Язык', 'Language')}">${['ru', 'en'].map((l) =>
    `<button class="${LANG === l ? 'on' : ''}" onclick="setLang('${l}')">${l.toUpperCase()}</button>`).join('')}</span>`;
  const html = langs + (me
    ? `<a class="who" href="#/player/${me.sid}"><b>${esc(me.name)}</b><span class="label">${me.rank?.tier ? `${me.mmr} MMR` : L('калибровка', 'calibration')}</span></a>
       ${rankBadge(me.rank)}<button class="logout" onclick="logout()" title="${L('Выйти', 'Sign out')}">${L('выйти', 'sign out')}</button>`
    : `<a class="btn small" href="${API}/auth/steam">${L('Войти через Steam', 'Sign in with Steam')}</a>`);
  if ($('me').innerHTML !== html) $('me').innerHTML = html;
}

function renderTicker() {
  const date = new Date().toLocaleDateString(LOCALE(), { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  const open = pulse.lobbies.filter((l) => l.state === 'waiting').length;
  const playing = pulse.lobbies.filter((l) => l.state !== 'waiting').length;
  const html = `
    <span>${esc(date)}</span>
    <span class="on-air">${L('В сети', 'Online')} <b>${pulse.online}</b></span>
    <span>${L('Открытых лобби', 'Open lobbies')} <b>${open}</b></span>
    <span>${L('Идёт матчей', 'Matches on')} <b>${playing}</b></span>
    ${heroes.length ? `<span>${L('Героев в пуле', 'Heroes in the pool')} <b>${heroes.length}</b></span>` : ''}
    ${config?.server_mode === 'fake' ? `<span>${L('Серверы: тестовый режим', 'Servers: test mode')}</span>` : ''}`;
  if ($('ticker').innerHTML !== html) $('ticker').innerHTML = html;
}

function stateLabel(s) {
  return ({ waiting: L('сбор', 'gathering'), bans: L('баны', 'bans'), picks: L('драфт', 'draft'), launching: L('запуск', 'starting'),
    live: L('в игре', 'in game'), error: L('сбой', 'failed') })[s] || s;
}

function view() {
  const r = route();
  if (r.startsWith('/hero/')) return heroPage(decodeURIComponent(r.slice(6)));
  if (r.startsWith('/match/')) return matchPage(r.slice(7));
  if (r.startsWith('/player/')) return playerPage(r.slice(8));
  switch (r) {
    case '/lobbies': return lobbiesPage();
    case '/lobby': return me && lobby ? lobbyView() : lobbiesPage();
    case '/play': return lobbiesPage();
    case '/heroes': return heroesPage();
    case '/items': return itemsPage();
    case '/top': return leaderboardPage();
    case '/matches': return matchesPage();
    case '/modes': return modesPage();
    case '/guide': return guidePage();
    default: return homeView();
  }
}

function sectionHead(num, title, aside = '') {
  return `<div class="section-head"><span class="num">${num}</span><h2 class="h2">${title}</h2>${aside ? `<span class="label">${aside}</span>` : ''}</div>`;
}

const teamsTitle = (teams) => `${esc(teams[0])}<i>vs</i>${esc(teams[1])}`;

// a code from the server (unranked reasons): uneven:<a>:<b>, min:<n>, dev; older matches keep their Russian text
function reasonText(code) {
  if (!code) return '';
  const [k, a, b] = String(code).split(':');
  if (k === 'uneven') return L(`составы неравные (${a} на ${b})`, `uneven teams (${a} vs ${b})`);
  if (k === 'min') return L(`нужно хотя бы ${a} на ${a}`, `needs at least ${a} vs ${a}`);
  if (k === 'dev') return L('в матче тестовые аккаунты', 'test accounts in the match');
  return code;
}

// ---------- home ----------

function homeView() {
  return `
    <section class="front">
      <div>
        <p class="kicker">Deadlock · ${L('кастомные матчи', 'custom matches')} · Overthrow</p>
        <h1 class="display">${L('Двенадцать<br>входят.<br><em>Яма</em> решает.', 'Twelve<br>go in.<br>The <em>pit</em> decides.')}</h1>
      </div>
      <div class="front-side">
        <p class="lede">${L('Собери лобби до шести на шесть, пройди слепой драфт и получи свой сервер за пару минут.',
          'Gather a lobby of up to six on six, go through a blind draft and get your own server in a couple of minutes.')}</p>
        ${me
          ? `<a class="btn big red" href="#${lobby ? '/lobby' : '/lobbies'}">${lobby ? L('Вернуться в лобби', 'Back to the lobby') : L('Открыть лобби', 'Open lobbies')} <span class="arrow">→</span></a>`
          : `<a class="btn big red" href="${API}/auth/steam">${L('Войти через Steam', 'Sign in with Steam')} <span class="arrow">→</span></a>${devLogin()}`}
      </div>
    </section>
    <section class="section">
      ${sectionHead('01', L('Открытые лобби', 'Open lobbies'), `<a href="#/lobbies">${L('все лобби и создание →', 'all lobbies and create →')}</a>`)}
      ${lobbyRows(pulse.lobbies.filter((l) => l.state === 'waiting').slice(0, 5), true)}
    </section>
    <section class="section">
      ${sectionHead('02', L('Режимы', 'Modes'), L('сейчас открыт один', 'one open for now'))}
      ${modesHtml()}
    </section>
    <section class="section">
      ${sectionHead('03', L('Как проходит матч', 'How a match goes'), L('от лобби до сервера ~3 минуты', 'lobby to server in ~3 minutes'))}
      ${stepsHtml()}
    </section>
    ${heroes.length ? `<section class="section">${sectionHead('04', L('Герои', 'Heroes'), `<a href="#/heroes">${L('все', 'all')} ${heroes.length} →</a>`)}
      <div class="hgrid">${featured.map(heroCard).join('')}</div></section>` : ''}
    ${pulse.matches.length ? `<section class="section">${sectionHead('05', L('Последние матчи', 'Recent matches'))}${matchesHtml()}</section>` : ''}`;
}

function devLogin() {
  if (!config?.dev_login) return '';
  return `<div class="dev-login">
    <p class="label muted">${L('Тестовый вход без Steam · у каждой вкладки свой игрок', 'Test sign-in without Steam · each tab is its own player')}</p>
    <form onsubmit="devLoginSubmit(event)"><input class="input" id="devName" placeholder="${L('Имя', 'Name')}" maxlength="32"><button class="btn small">${L('Войти', 'Sign in')}</button></form>
  </div>`;
}

function modesHtml() {
  return `<div class="modes">${config.modes.map((m) => m.available ? `
    <article class="mode on">
      <span class="label">${L('Открыт', 'Open')} · ${m.team_size} ${L('на', 'vs')} ${m.team_size} · ${esc(m.map)}</span>
      <h3 class="h2">${esc(modeName(m))}</h3>
      <p>${esc(L(m.tagline, m.tagline_en || m.tagline))}</p>
      ${m.rules ? `<ul>${L(m.rules, m.rules_en || m.rules).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      <a class="btn red" href="#/lobbies">${L('Играть', 'Play')} <span class="arrow">→</span></a>
    </article>` : `
    <article class="mode off">
      <span class="label">${m.team_size} ${L('на', 'vs')} ${m.team_size}</span>
      <h3 class="h2">${esc(modeName(m))}</h3>
      <p>${esc(L(m.tagline, m.tagline_en || m.tagline))}</p>
      <span class="stamp red">${L('Скоро', 'Soon')}</span>
    </article>`).join('')}</div>`;
}

function stepsHtml() {
  const steps = [
    [L('Сбор', 'Gather'), L('До шести на шесть. Начать можно и меньшим составом — когда все нажали «Готов».',
      'Up to six on six. You can start with fewer, once everyone has pressed Ready.'), L('без лимита', 'no limit')],
    [L('Баны', 'Bans'), L(`Каждый предлагает героя на бан. Из всех предложений случайно банятся ${config.bans}.`,
      `Everyone suggests a hero to ban. ${config.bans} of all suggestions are banned at random.`), L(`${config.ban_seconds} с`, `${config.ban_seconds} s`)],
    [L('Пики вслепую', 'Blind picks'), L('Три раунда, по два игрока от команды. Соперник видит выбор только после раунда. Совпали — герой в бан, перепик.',
      'Three rounds, two players per team. The other team sees your picks only after the round. Same hero on both sides: it is banned and they pick again.'), L(`3 × ${config.pick_seconds} с`, `3 × ${config.pick_seconds} s`)],
    [L('Сервер', 'Server'), L('Сайт поднимает сервер Overthrow и выдаёт команду connect. Драфт сохраняется в матч.',
      'The site starts an Overthrow server and gives you the connect command. The draft is saved with the match.'), L('≈ 1 мин', '≈ 1 min')],
  ];
  return `<div class="steps">${steps.map(([h, p, t], i) => `
    <div class="step"><span class="n">${i + 1}</span><h4>${h}</h4><p>${p}</p><span class="time label">${t}</span></div>`).join('')}</div>`;
}

function matchesHtml() {
  return matchList(pulse.matches.slice(0, 6)) + `<p style="margin-top:14px"><a class="label" href="#/matches">${L('вся история матчей →', 'full match history →')}</a></p>`;
}

function heroLink(name) {
  const h = heroByName[name];
  return h ? `<a href="#/hero/${h.id}">${esc(name)}</a>` : esc(name);
}

// ---------- lobby list ----------

function lobbyRows(list, compact) {
  if (!list.length) {
    return `<div class="empty"><h2 class="h2">${L('Пусто.<br><em>Создай первое</em> —<br>остальные подтянутся.', 'Empty.<br><em>Make the first one</em> —<br>others will follow.')}</h2>
      <p style="margin-top:18px">${compact
        ? `<a class="btn red" href="#/lobbies">${L('Создать лобби', 'Create a lobby')} <span class="arrow">→</span></a>`
        : `<button class="btn red" onclick="focusCreate()">${L('Создать лобби', 'Create a lobby')} <span class="arrow">→</span></button>`}</p></div>`;
  }
  return `<ol class="lobbies">${list.map((l, i) => {
    const half = l.size / 2;
    const pips = (n, t) => `<span class="pips ${TEAM_CLASS[t]}">${Array.from({ length: half }, (_, k) => `<i class="${k < n ? 'on' : ''}"></i>`).join('')}</span>`;
    const mine = lobby?.id === l.id;
    const canJoin = l.state === 'waiting' && l.players < l.size && !mine;
    let action;
    if (mine) action = `<a class="btn small red" href="#/lobby">${L('Моё лобби', 'My lobby')}</a>`;
    else if (canJoin) action = me ? `<button class="btn small" onclick="joinLobby('${l.id}')">${L('Войти', 'Join')} <span class="arrow">→</span></button>`
      : `<a class="btn small" href="${API}/auth/steam">${L('Войти', 'Join')}</a>`;
    else action = `<span class="stamp ${l.state === 'waiting' ? '' : 'red'}">${l.state === 'waiting' ? L('полное', 'full') : stateLabel(l.state)}</span>`;
    return `<li class="lrow">
      <span class="n">${pad(i + 1)}</span>
      <div><div class="lobby-title">${teamsTitle(l.teams.map((t) => t.name))}</div>
        <div class="sub label">${esc(modeNameById(l.mode))} · ${L('создал', 'by')} ${esc(l.owner)} · ${stateLabel(l.state)} · ${l.players}/${l.size}</div></div>
      <div class="fill">${l.teams.map((t, k) => `<div class="fill-team"><span>${esc(t.name)}</span>${pips(t.count, k)}</div>`).join('')}</div>
      <div class="go">${action}</div>
    </li>`;
  }).join('')}</ol>`;
}

function lobbiesPage() {
  const open = pulse.lobbies.filter((l) => l.state === 'waiting');
  const running = pulse.lobbies.filter((l) => l.state !== 'waiting');
  return `
    <section class="play">
      <div>
        <div class="play-head">
          <div><p class="kicker">${L('Ждут игроков · нажмите «Войти», чтобы занять слот', 'Waiting for players · press Join to take a slot')}</p><h1 class="h2">${L('Открытые лобби', 'Open lobbies')}</h1></div>
          <span class="count">${pad(open.length)}</span>
        </div>
        ${lobby ? `<div class="in-lobby"><span>${L('Вы уже в лобби', 'You are in the lobby')} <b>${teamsTitle(lobby.teams.map((t) => t.name))}</b> · ${stateLabel(lobby.state)}</span>
          <a class="btn small red" href="#/lobby">${L('Вернуться', 'Go back')} <span class="arrow">→</span></a></div>` : ''}
        ${lobbyRows(open)}
        <ul class="how-join">
          <li><b>${L('1. Войдите', '1. Sign in')}</b>${L('Через Steam — так соперники видят, с кем играют.', 'With Steam, so opponents know who they play.')}</li>
          <li><b>${L('2. Займите слот', '2. Take a slot')}</b>${L('«Войти» сажает в команду, где меньше людей. Пересесть можно кликом по свободному месту.',
            'Join puts you in the smaller team. Click a free slot to move.')}</li>
          <li><b>${L('3. Нажмите «Готов»', '3. Press Ready')}</b>${L('Когда готовы все, владелец лобби запускает драфт.', 'When everyone is ready, the lobby owner starts the draft.')}</li>
        </ul>
        ${running.length ? `<section class="section">${sectionHead('§', L('Идут сейчас', 'In progress'))}${lobbyRows(running)}</section>` : ''}
        ${pulse.matches.length ? `<section class="section">${sectionHead('§', L('Последние матчи', 'Recent matches'))}${matchesHtml()}</section>` : ''}
      </div>
      ${me ? createHtml() : `<div class="create"><h2 class="h3">${L('Своё лобби', 'Your own lobby')}</h2><p>${L('Создавать и заходить в лобби можно после входа.', 'Sign in to create and join lobbies.')}</p>
        <a class="btn red" href="${API}/auth/steam">${L('Войти через Steam', 'Sign in with Steam')}</a>${devLogin()}</div>`}
    </section>`;
}

function createHtml() {
  return `<form class="create" onsubmit="createLobby(event)">
    <h2 class="h3">${L('Новое лобби', 'New lobby')}</h2>
    <div class="mode-select">${config.modes.map((m, i) => `
      <label class="${m.available ? '' : 'off'}">
        <input type="radio" name="mode" value="${m.id}" ${m.available ? '' : 'disabled'} ${i === 0 ? 'checked' : ''}>
        <b>${esc(modeName(m))}</b><small class="label">${m.available ? `${m.team_size}×${m.team_size}` : L('скоро', 'soon')}</small>
      </label>`).join('')}</div>
    <div class="two">
      <label class="field"><span class="label">Amber</span><input class="input" id="team0" maxlength="32" placeholder="Amber"></label>
      <label class="field"><span class="label">Sapphire</span><input class="input" id="team1" maxlength="32" placeholder="Sapphire"></label>
    </div>
    <button class="btn red" ${lobby ? `disabled title="${L('Сначала выйдите из своего лобби', 'Leave your lobby first')}"` : ''}>${L('Создать лобби', 'Create a lobby')} <span class="arrow">→</span></button>
  </form>`;
}

// ---------- lobby ----------

const teamOf = (l, sid) => l.teams.findIndex((t) => t.slots.includes(sid));
const playersOf = (l, t) => l.teams[t].slots.filter(Boolean);
const nameOf = (l, sid) => l.users[sid]?.name || '—';

function lobbyView() {
  if (lobby.state === 'waiting') return waitingView(lobby);
  if (lobby.state === 'bans' || lobby.state === 'picks') return draftView(lobby);
  return liveView(lobby);
}

function waitingView(l) {
  const isOwner = l.owner === me.sid;
  const amReady = l.ready.includes(me.sid);
  const all = l.teams.flatMap((t) => t.slots).filter(Boolean);
  const allReady = all.every((sid) => l.ready.includes(sid));
  return `
    <section>
      <div class="lobby-head">
        <div><p class="kicker">${esc(modeNameById(l.mode))} · ${L('лобби', 'lobby')} №${esc(l.id)} · ${L('создал', 'by')} ${esc(nameOf(l, l.owner))}</p>
          <h1 class="display">${teamsTitle(l.teams.map((t) => t.name))}</h1></div>
        <div class="actions">
          <button class="btn big ${amReady ? 'ghost' : 'red'}" onclick="setReady(${!amReady})">${amReady ? L('Не готов', 'Not ready') : L('Готов', 'Ready')}</button>
          <button class="btn ghost" onclick="leave()">${L('Выйти', 'Leave')}</button>
          ${isOwner ? `<button class="btn" onclick="start()" ${allReady ? '' : 'disabled'}>${L('Начать драфт', 'Start the draft')} <span class="arrow">→</span></button>` : ''}
          <span class="note label">${L(`Готовы ${l.ready.length} из ${all.length}`, `Ready ${l.ready.length} of ${all.length}`)} · ${isOwner
            ? L('драфт запускаете вы', 'you start the draft') : L('драфт запускает владелец', 'the owner starts the draft')}</span>
        </div>
      </div>
      <div class="versus">${teamHtml(l, 0)}<div class="vs">vs</div>${teamHtml(l, 1)}</div>
      <p class="hint">${L('Кликните по свободному слоту, чтобы пересесть. Название команды меняет её капитан — первый игрок в составе. Ушедших с сайта больше чем на пару минут лобби отпускает само.',
        'Click a free slot to move. The team captain (first player in the team) can rename it. Players away from the site for more than a couple of minutes leave the lobby by themselves.')}</p>
    </section>`;
}

function teamHtml(l, t) {
  const team = l.teams[t];
  const isOwner = l.owner === me.sid;
  const canRename = isOwner || team.captain === me.sid;
  const count = team.slots.filter(Boolean).length;
  return `<div class="team ${TEAM_CLASS[t]}">
    <div class="team-head">
      <h2 class="team-name">${canRename ? `<input id="teamName${t}" value="${esc(team.name)}" maxlength="32" onchange="renameTeam(${t})" aria-label="${L('Название команды', 'Team name')}">` : esc(team.name)}</h2>
      <div class="team-meta"><span class="label">${TEAM_SIDE[t]}</span><div class="cnt">${count}/${team.slots.length}</div></div>
    </div>
    <ol class="slots">${team.slots.map((sid, s) => {
      if (!sid) return `<li class="slot free" onclick="takeSlot(${t}, ${s})"><span class="no">${pad(s + 1)}</span><span class="ph"></span><span class="nm">${L('Свободно', 'Free')}</span><span></span></li>`;
      const u = l.users[sid];
      const tags = [u?.rank?.tier ? `${u.mmr} MMR` : L('калибровка', 'calibration'), sid === me.sid && L('вы', 'you'), sid === l.owner && L('владелец', 'owner'),
        sid === team.captain && L('капитан', 'captain')].filter(Boolean).join(' · ');
      return `<li class="slot ${sid === me.sid ? 'me' : ''}">
        <span class="no">${pad(s + 1)}</span>${avatar(u)}
        <span class="nm"><a class="plink" href="#/player/${sid}">${esc(u?.name)}</a> ${rankBadge(u?.rank)}<small>${tags}</small></span>
        <span>${l.ready.includes(sid) ? `<span class="stamp red">${L('Готов', 'Ready')}</span>` : `<span class="stamp wait">${L('ждём', 'waiting')}</span>`}
          ${isOwner && sid !== me.sid ? `<button class="kick" onclick="kick('${sid}')" title="${L('Выгнать', 'Kick')}">×</button>` : ''}</span>
      </li>`;
    }).join('')}</ol>
  </div>`;
}

// ---------- draft ----------

function draftView(l) {
  const ph = l.phase;
  const mine = teamOf(l, me.sid);
  const bans = ph.kind === 'bans';
  const myNom = bans ? ph.noms[me.sid] : null;
  const picker = !bans && ph.pickers.includes(me.sid);
  const locked = !bans && ph.locked.includes(me.sid);
  const canAct = bans ? !myNom : picker && !locked;
  const mySel = bans ? (myNom || pendingBan) : ph.sel[me.sid];

  let title, sub;
  if (bans) {
    title = L('Баны', 'Bans');
    sub = myNom
      ? L(`Ваш бан — ${esc(myNom)}. Ждём остальных: из всех предложений случайно забанят ${config.bans}.`,
        `Your ban: ${esc(myNom)}. Waiting for the rest: ${config.bans} of all suggestions get banned at random.`)
      : L(`Предложите героя на бан. Из всех предложений случайно забанят ${config.bans}. Союзники видят ваш выбор, соперники — нет.`,
        `Suggest a hero to ban. ${config.bans} of all suggestions get banned at random. Teammates see your choice, opponents don't.`);
  } else {
    title = ph.repick ? L('Перепик', 'Re-pick') : L(`Раунд ${ph.round + 1}`, `Round ${ph.round + 1}`);
    const myRound = Math.floor(playersOf(l, mine).indexOf(me.sid) / 2) + 1;
    if (ph.repick && picker) sub = L('Обе команды взяли одного героя — он забанен. Выберите другого, тоже вслепую.',
      'Both teams took the same hero, so it is banned. Pick another one, blind again.');
    else if (picker) sub = locked ? L('Выбор зафиксирован. Ждём остальных.', 'Locked in. Waiting for the rest.')
      : L('Ваш ход. Выберите героя и зафиксируйте — соперник увидит его только после раунда.',
        'Your turn. Pick a hero and lock it in: the other team sees it only after the round.');
    else if (l.picks[me.sid]) sub = L(`Ваш герой — ${esc(l.picks[me.sid])}. Смотрим, как выбирают остальные.`,
      `Your hero: ${esc(l.picks[me.sid])}. Watching the others pick.`);
    else sub = L(`Выбирают: ${ph.pickers.map((p) => esc(nameOf(l, p))).join(', ')}. Ваш ход — в раунде ${myRound}.`,
      `Picking: ${ph.pickers.map((p) => esc(nameOf(l, p))).join(', ')}. Your turn is in round ${myRound}.`);
  }

  const rounds = bans ? '' : `<div class="rounds label">${Array.from({ length: ph.rounds }, (_, r) =>
    `<span class="${r === ph.round ? 'on' : r < ph.round ? 'done' : ''}">${L('Раунд', 'Round')} ${r + 1}</span>`).join('')}</div>`;

  const taken = {};
  for (const [sid, h] of Object.entries(l.picks)) taken[h] = nameOf(l, sid);
  const mates = bans ? {} : Object.fromEntries(Object.entries(ph.sel).filter(([sid]) => sid !== me.sid).map(([sid, h]) => [h, sid]));

  const tiles = config.heroes.map((h) => {
    const banned = l.banned.includes(h);
    const isTaken = h in taken;
    const mate = h in mates;
    const pic = heroByName[h]?.card;
    const cls = [pic && 'has-img', banned && 'banned', isTaken && 'taken', mate && 'mate', h === mySel && 'sel'].filter(Boolean).join(' ');
    const off = banned || isTaken || mate || !canAct;
    return `<button class="hero-tile ${cls}" data-hero="${esc(h)}" ${isTaken ? `data-owner="${esc(taken[h])}"` : ''}
      ${off ? 'disabled' : ''} onclick="heroClick(this.dataset.hero)" title="${esc(heroByName[h]?.role || h)}">
      ${pic ? `<img src="${img(pic)}" alt="" loading="lazy">` : `<span class="mono-mark">${esc(monogram(h))}</span>`}<span class="nm">${esc(h)}</span></button>`;
  }).join('');

  const strip = bans
    ? `<span class="label muted">${L('Предложения команды:', 'Team suggestions:')}</span>${Object.values(ph.noms).map((h) => `<span class="chip nom">${esc(h)}</span>`).join('') || `<span class="muted">${L('пока нет', 'none yet')}</span>`}`
    : `<span class="label muted">${L('Забанены:', 'Banned:')}</span>${l.banned.map((h) => `<span class="chip">${esc(h)}</span>`).join('') || `<span class="muted">${L('никто', 'nobody')}</span>`}`;

  let confirm;
  if (canAct) {
    const role = heroByName[mySel]?.role;
    confirm = `<div><span class="label muted">${bans ? L('Бан', 'Ban') : L('Ваш герой', 'Your hero')}${role ? ` · ${role}` : ''}</span><div class="pick-name">${esc(mySel || '—')}</div></div>
      <button class="btn big red" ${mySel ? '' : 'disabled'} onclick="${bans ? 'sendBan()' : 'lockPick()'}">${bans ? L('Предложить бан', 'Suggest the ban') : L('Зафиксировать', 'Lock in')}</button>`;
  } else if (bans) {
    confirm = `<div><span class="label muted">${L('Ваш бан', 'Your ban')}</span><div class="pick-name">${esc(myNom)}</div></div>`;
  } else if (locked) {
    confirm = `<div><span class="label muted">${L('Зафиксировано', 'Locked in')}</span><div class="pick-name">${esc(mySel)}</div></div>`;
  } else {
    confirm = `<span class="muted">${l.picks[me.sid] ? L('Ваш герой выбран.', 'Your hero is picked.') : L('Ждите своего раунда.', 'Wait for your round.')}</span>`;
  }

  return `<section class="night">
    <div class="draft-top">
      <div><p class="kicker">${esc(modeNameById(l.mode))} · ${esc(l.teams[0].name)} vs ${esc(l.teams[1].name)}</p><h1 class="display">${title}</h1><p class="sub">${sub}</p>${rounds}</div>
      <div class="clock" id="clock"><b id="clockNum">${Math.ceil(ph.seconds_left)}</b><div class="bar"><i id="clockBar"></i></div></div>
    </div>
    <div class="draft-grid">
      ${sideHtml(l, 0, mine)}
      <div class="pool ${locked ? 'locked-in' : ''}">
        <div class="pool-strip">${strip}</div>
        <div class="heroes">${tiles}</div>
        <div class="confirm">${confirm}</div>
      </div>
      ${sideHtml(l, 1, mine)}
    </div>
  </section>`;
}

function sideHtml(l, t, mine) {
  const ph = l.phase;
  const own = t === mine;
  const pic = (h) => heroByName[h]?.card ? `<img class="seat-pic" src="${img(heroByName[h].card)}" alt="">` : '';
  const seats = playersOf(l, t).map((sid, i) => {
    const who = `${esc(nameOf(l, sid))}${sid === me.sid ? ` · ${L('вы', 'you')}` : ''}`;
    let hero, now = false, face = '';
    if (l.picks[sid]) {
      face = pic(l.picks[sid]);
      hero = `<div class="hero">${esc(l.picks[sid])}</div>`;
    } else if (ph.kind === 'bans') {
      if (own && ph.noms[sid]) hero = `<div class="hero tentative">${L('бан', 'ban')}: ${esc(ph.noms[sid])}</div>`;
      else hero = `<div class="hero pending">${ph.nominated.includes(sid) ? L('бан предложен', 'ban suggested') : L('думает…', 'thinking…')}</div>`;
    } else if (ph.pickers.includes(sid)) {
      now = true;
      const isLocked = ph.locked.includes(sid);
      if (own && ph.sel[sid]) {
        face = pic(ph.sel[sid]);
        hero = `<div class="hero ${isLocked ? '' : 'tentative'}">${esc(ph.sel[sid])}${isLocked ? ' <span class="lock">■</span>' : ''}</div>`;
      } else if (!own && isLocked) hero = `<div class="hero hidden">??? <span class="lock">■</span></div>`;
      else hero = `<div class="hero pending">${L('выбирает…', 'picking…')}</div>`;
    } else {
      hero = `<div class="hero pending">${L('раунд', 'round')} ${Math.floor(i / 2) + 1}</div>`;
    }
    return `<li class="seat ${now ? 'now' : ''} ${sid === me.sid ? 'me' : ''}">${face}<div class="who">${who}</div>${hero}</li>`;
  }).join('');
  return `<ol class="side ${TEAM_CLASS[t]}"><li class="side-head">${esc(l.teams[t].name)}</li>${seats}</ol>`;
}

function monogram(name) {
  const words = name.replace(/&/g, ' ').split(/\s+/).filter(Boolean);
  return words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2);
}

function tickClock() {
  const num = $('clockNum');
  if (!num || !clock) return;
  const left = Math.max(0, clock.left - (performance.now() - clock.at) / 1000);
  num.textContent = Math.ceil(left);
  $('clockBar').style.transform = `scaleX(${clock.total ? left / clock.total : 0})`;
  $('clock').classList.toggle('hot', left <= 5);
}

// ---------- live ----------

function liveView(l) {
  const isOwner = l.owner === me.sid;
  const s = l.server || {};
  const roster = `<div class="roster">${[0, 1].map((t) => `
    <h3 class="h3 ${TEAM_CLASS[t]}">${esc(l.teams[t].name)}</h3>
    <ul>${playersOf(l, t).map((sid) => `<li><span>${esc(nameOf(l, sid))} ${delta(l.result?.deltas?.[sid])}</span><b>${esc(l.picks[sid] || '—')}</b></li>`).join('')}</ul>`).join('')}
    ${l.banned.length ? `<p class="label muted" style="margin-top:18px">${L('Баны', 'Bans')}: ${l.banned.map(esc).join(', ')}</p>` : ''}
  </div>`;
  const buttons = `<p style="margin-top:28px;display:flex;gap:10px;flex-wrap:wrap">
    ${isOwner ? `<button class="btn" onclick="closeLobby()">${s.pid ? L('Закрыть лобби и сервер', 'Close the lobby and server') : L('Закрыть лобби', 'Close the lobby')}</button>` : ''}
    ${l.state !== 'launching' ? `<button class="btn ghost" onclick="leave()">${L('Выйти из лобби', 'Leave the lobby')}</button>` : ''}
  </p>`;

  let left;
  if (l.state === 'launching') {
    left = `<h1 class="display">${L('Сервер<br>поднимается', 'Server<br>starting')}<span class="dots"></span></h1>
      <p class="sub">${L('Драфт окончен. Через минуту здесь появится команда для подключения.', 'The draft is over. The connect command shows up here in a minute.')}</p>`;
  } else if (l.state === 'error') {
    left = `<h1 class="display">${L('Сбой', 'Failed')}<em>.</em></h1><p class="sub">${L('Сервер не запустился', 'The server did not start')}: ${esc(s.error)}</p>`;
  } else {
    const myHero = heroByName[l.picks[me.sid]];
    left = `<h1 class="display">${L('Сервер<br>готов', 'Server<br>ready')}<em>.</em></h1>
      ${s.fake ? `<p class="sub muted">${L('Тестовый режим: сервер не запускался, адрес ненастоящий.', 'Test mode: no server was started, the address is not real.')}</p>` : ''}
      <div class="connect"><span class="label muted">${L('Команда для консоли', 'Console command')}</span>
        <div class="connect-box"><code id="connectCmd">connect ${esc(s.address)}</code><button onclick="copyConnect(this)">${L('Копировать', 'Copy')}</button></div>
        ${s.steam_id ? `<p class="label muted" style="margin-top:10px">${L('Через Steam, без проброса портов', 'Through Steam, no port forwarding')}: <code>connect ${esc(s.steam_id)}</code></p>` : ''}
      </div>
      <ol class="how">
        <li><span>${L('Запустите Deadlock. В настройках включите <b>Dev command console</b>.', 'Start Deadlock. Turn on <b>Dev command console</b> in the settings.')}</span></li>
        <li><span>${L('Нажмите <span class="kbd">F7</span> и вставьте команду.', 'Press <span class="kbd">F7</span> and paste the command.')}</span></li>
        <li><span>${L('Сервер сам рассадит по командам. Ваш герой — ', 'The server puts everyone in their team. Your hero: ')}${myHero
          ? `<a href="#/hero/${myHero.id}" style="color:var(--cream)">${esc(myHero.name)}</a>${L(', освежите умения перед боем', ' — refresh the abilities before the fight')}` : L('из драфта', 'from the draft')}.</span></li>
      </ol>`;
  }
  return `<section class="night">
    <p class="kicker">${esc(modeNameById(l.mode))} · ${esc(l.teams[0].name)} vs ${esc(l.teams[1].name)} · ${stateLabel(l.state)}</p>
    <div class="live"><div>${left}${resultPanel(l)}${buttons}</div>${roster}</div>
  </section>`;
}

function resultPanel(l) {
  if (l.state !== 'live') return '';
  if (l.result) {
    const d = l.result.deltas?.[me.sid];
    const via = { server: L(' · от сервера', ' · from the server'), timeout: L(' · принят без спора по таймеру', ' · accepted undisputed on timeout'),
      admin: L(' · решение админа', ' · decided by an admin') }[l.result.source]
      || L(' · подтверждён командами', ' · confirmed by the teams');
    return `<div class="result-box">
      <span class="label muted">${L('Результат', 'Result')}${via}</span>
      <h2 class="h2">${L('Победа', 'Win')}: ${esc(l.teams[l.result.winner].name)}${l.result.score ? ` <span class="score">${l.result.score[0]}:${l.result.score[1]}</span>` : ''}</h2>
      <p>${d == null ? L('Матч без рейтинга.', 'Unranked match.') : `${L('Ваш рейтинг', 'Your rating')}: ${delta(d)}`} <a href="#/match/${l.id}" style="color:var(--cream)">${L('Статистика матча →', 'Match stats →')}</a></p>
    </div>`;
  }
  if (l.match !== 'playing') return '';
  return resultControls({ id: l.id, teams: l.teams.map((t) => t.name), myTeam: teamOf(l, me.sid), report: l.report,
    unranked: l.unranked, name: (sid) => nameOf(l, sid), where: 'lobby' });
}

// report / confirm / dispute; where: 'lobby' acts through the lobby, 'match' through the match page
function resultControls(c) {
  const why = c.unranked ? `<p class="muted small">${L('Матч без рейтинга', 'Unranked match')}: ${esc(reasonText(c.unranked))}.</p>` : '';
  const left = (r) => r.auto_in > 0
    ? L(` Если никто не оспорит, итог примется сам через ${Math.ceil(r.auto_in / 60)} мин.`, ` If nobody disputes it, it stands by itself in ${Math.ceil(r.auto_in / 60)} min.`)
    : L(' Итог вот-вот примется сам.', ' It is about to stand by itself.');
  if (c.report) {
    const r = c.report;
    const text = `${esc(c.name(r.by))}: ${L('победа', 'win')} — <b>${esc(c.teams[r.winner])}</b>${r.score ? ` ${r.score[0]}:${r.score[1]}` : ''}`;
    const disputes = r.disputes ? L(` Споров: ${r.disputes} из ${config.max_disputes} — после ${config.max_disputes}-го матч отменится.`,
      ` Disputes: ${r.disputes} of ${config.max_disputes}; after the ${config.max_disputes}th the match is cancelled.`) : '';
    let actions;
    if (c.myTeam == null || c.myTeam < 0) actions = '';
    else if (c.myTeam !== r.team) actions = `<p class="row-btns"><button class="btn red" onclick="resultAct('${c.where}', '${c.id}', 'confirm')">${L('Подтвердить', 'Confirm')}</button>
      <button class="btn ghost" onclick="resultAct('${c.where}', '${c.id}', 'dispute')">${L('Оспорить', 'Dispute')}</button></p>`;
    else actions = `<p class="row-btns"><button class="btn ghost" onclick="openReport('${c.where}')">${L('Изменить', 'Change')}</button></p>`;
    return `<div class="result-box"><span class="label muted">${L('Результат ждёт подтверждения', 'The result waits for confirmation')}</span><p>${text}</p>
      <p class="muted small">${L(`Подтвердить или оспорить может игрок команды ${esc(c.teams[1 - r.team])}.`, `A player of ${esc(c.teams[1 - r.team])} can confirm or dispute it.`)}${left(r)}${disputes}</p>${actions}${why}</div>`;
  }
  if (c.myTeam == null || c.myTeam < 0) return why ? `<div class="result-box">${why}</div>` : '';
  return `<div class="result-box">
    <span class="label muted">${L('После матча', 'After the match')}</span>
    <h3 class="h3" style="margin:6px 0 12px">${L('Кто победил?', 'Who won?')}</h3>
    <p class="score-in"><input class="input" id="scoreA" type="number" min="0" max="999" placeholder="${esc(c.teams[0])}">
      <span>:</span><input class="input" id="scoreB" type="number" min="0" max="999" placeholder="${esc(c.teams[1])}"></p>
    <p class="row-btns">${[0, 1].map((t) => `<button class="btn ${t === 0 ? 'amber' : 'sapphire'}" onclick="reportWin('${c.where}', '${c.id}', ${t})">${esc(c.teams[t])}</button>`).join('')}</p>
    <p class="muted small">${L(`Счёт по убийствам — по желанию. Итог подтверждает игрок другой команды — здесь или на странице матча,
      даже если он уже вышел из лобби. Без спора итог примется сам через ${Math.round(config.report_timeout / 60)} мин.
      Если сервер пришлёт итог сам, он запишется без подтверждения.`,
      `The kill score is optional. A player of the other team confirms the result, here or on the match page,
      even after leaving the lobby. Undisputed, it stands by itself in ${Math.round(config.report_timeout / 60)} min.
      If the server sends the result itself, it is recorded without confirmation.`)}</p>${why}
  </div>`;
}

async function resultAct(where, id, action, body = {}) {
  if (where === 'lobby') return lobbyAct(action, body);
  try {
    remoteCache[`/api/match/${id}`] = { data: await api(`/api/match/${id}/${action}`, body), at: Date.now() };
  } catch (e) { showError(e.message); }
  render();
}

function reportWin(where, id, winner) {
  const a = $('scoreA')?.value, b = $('scoreB')?.value;
  const score = a !== '' && b !== '' && a != null && b != null ? [+a, +b] : null;
  resultAct(where, id, 'report', score ? { winner, score } : { winner });
}

function openReport(where) {
  // the reporter changes a pending report: the same buttons, sent again
  if (where === 'lobby') lobby.report = null;
  else for (const c of Object.values(remoteCache)) if (c.data?.report) c.data.report = null;
  lastHtml = '';
  render();
}

// ---------- rating ----------

const ROMAN6 = ['I', 'II', 'III', 'IV', 'V', 'VI'];
const fmtDate = (ts) => new Date(ts * 1000).toLocaleString(LOCALE(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const delta = (d) => d == null ? '' : `<span class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : '−'}${Math.abs(d)}</span>`;
const plink = (p) => `<a class="plink" href="#/player/${p.sid}">${esc(p.name)}</a>`;
const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';
const kdaText = (k) => k ? `${k[0] ?? 0} / ${k[1] ?? 0} / ${k[2] ?? 0}` : '—';

function rankName(r) {
  if (!r) return '';
  if (!r.tier) return L(`Калибровка · ещё ${r.calibration_left}`, `Calibration · ${r.calibration_left} to go`);
  return `${ranks[r.tier]?.name || L('Ранг ', 'Rank ') + r.tier} ${ROMAN6[r.sub - 1]}`;
}

function rankBadge(r, size = 'sm') {
  if (!r) return '';
  const file = r.tier ? `ranks/rank${r.tier}/badge_${size}_subrank${r.sub}_psd.${IMG_EXT}` : `ranks/rank0/badge_${size}_psd.${IMG_EXT}`;
  return `<img class="rank-badge ${size}" src="/static/data/img/${file}" alt="" title="${esc(rankName(r))}" onerror="this.remove()">`;
}

// GET data for a page: cached, refreshed in the background when older than maxAge
const remoteCache = {};
function remote(url, maxAge = 8000) {
  const c = remoteCache[url];
  if (!c || (!c.loading && Date.now() - c.at > maxAge)) {
    remoteCache[url] = { ...(c || { at: 0 }), loading: true };
    fetch(API + url, { headers: { 'X-Token': token || '', 'X-Lang': LANG } })
      .then((r) => r.json().then((d) => [r.ok, d]))
      .then(([ok, d]) => { remoteCache[url] = { data: ok ? d : null, error: ok ? null : d.error, at: Date.now() }; render(); })
      .catch(() => { remoteCache[url] = { data: null, error: L('Сервер недоступен', 'The server is unavailable'), at: Date.now() }; render(); });
  }
  return remoteCache[url];
}

function waitFor(c, title) {
  if (c?.data) return null;
  return `<section class="section">${sectionHead('§', title)}<p class="muted">${c?.error ? esc(c.error) : L('Загрузка…', 'Loading…')}</p></section>`;
}

function heroThumb(name, cls = '') {
  const h = heroByName[name];
  if (!h) return name ? `<span class="hthumb ${cls} none">${esc(monogram(name))}</span>` : `<span class="hthumb ${cls} none">?</span>`;
  return `<a class="hthumb ${cls}" href="#/hero/${h.id}" title="${esc(h.name)}" onclick="event.stopPropagation()"><img src="${img(h.icon || h.card)}" alt="${esc(h.name)}" loading="lazy"></a>`;
}

function statusStamp(m) {
  if (m.status === 'playing') return `<span class="stamp red">${L('идёт', 'live')}</span>`;
  if (m.status === 'unscored') return `<span class="stamp wait">${L('без итога', 'no result')}</span>`;
  if (m.status === 'cancelled') return `<span class="stamp wait">${L('отменён', 'cancelled')}</span>`;
  return m.ranked ? '' : `<span class="stamp wait" title="${esc(reasonText(m.unranked))}">${L('без рейтинга', 'unranked')}</span>`;
}

function matchList(list, forSid = me?.sid) {
  if (!list.length) return `<p class="muted">${L('Матчей пока нет. Сыграйте первый — он появится здесь.', 'No matches yet. Play the first one and it shows up here.')}</p>`;
  return `<ol class="mlist">${list.map((m) => {
    const side = (t) => m.players.filter((p) => p.team === t);
    const mine = m.players.find((p) => p.sid === forSid);
    const won = mine && m.status === 'finished' ? m.winner === mine.team : null;
    const team = (t) => `<div class="mside ${m.winner === t ? 'won' : ''} ${TEAM_CLASS[t]}">
      <b>${esc(m.teams[t])}</b><span class="thumbs">${side(t).map((p) => heroThumb(p.hero, 'sm')).join('')}</span></div>`;
    return `<li class="mrow ${won === true ? 'win' : won === false ? 'loss' : ''}" onclick="go('/match/${m.id}')">
      <span class="when label">${fmtDate(m.ts)}<br>${esc(modeNameById(m.mode))}</span>
      ${team(0)}
      <span class="mscore">${m.score ? `${m.score[0]}<i>:</i>${m.score[1]}` : m.status === 'finished' ? (m.winner === 0 ? 'W<i>:</i>L' : 'L<i>:</i>W') : '<i>vs</i>'}</span>
      ${team(1)}
      <span class="mres">${statusStamp(m)}${won != null ? `<span class="wl ${won ? 'up' : 'down'}">${won ? L('победа', 'win') : L('поражение', 'loss')}</span> ${delta(mine.delta)}` : ''}</span>
    </li>`;
  }).join('')}</ol>`;
}

function leaderboardPage() {
  const c = remote('/api/leaderboard');
  const wait = waitFor(c, L('Рейтинг', 'Ranking'));
  if (wait) return wait;
  const list = c.data.players;
  const podium = list.slice(0, 3).map((p) => `<a class="podium-card" href="#/player/${p.sid}">
      <span class="place">${p.place}</span>${rankBadge(p.rank, 'lg')}
      <b>${esc(p.name)}</b><span class="label">${rankName(p.rank)}</span><span class="mmr">${p.mmr}<small>MMR</small></span>
    </a>`).join('');
  const meRow = me && list.find((p) => p.sid === me.sid);
  const rows = list.map((p) => `<tr class="${p.sid === me?.sid ? 'me' : ''}" onclick="go('/player/${p.sid}')">
      <td class="place">${p.place}</td>
      <td><span class="pcell">${avatar(p, 'sm')}${plink(p)}</span></td>
      <td><span class="pcell">${rankBadge(p.rank)}${rankName(p.rank)}</span></td>
      <td><b>${p.mmr}</b></td><td>${p.games}</td><td>${p.wins}</td><td>${pct(p.wins, p.games)}</td>
      <td>${p.hero ? heroThumb(p.hero, 'sm') : '—'}</td><td>${kdaText(p.kda)}</td>
    </tr>`).join('');
  return `<section class="section">
    ${sectionHead('§', L('Рейтинг', 'Ranking'), L(`${list.length} игроков · Elo по командам`, `${list.length} players · team Elo`))}
    ${list.length ? `<div class="podium">${podium}</div>` : ''}
    ${me && !meRow ? `<p class="in-lobby" style="margin:0 0 18px"><span>${L(`Вас пока нет в таблице: в неё попадают после ${config.calibration} калибровочных матчей с рейтингом.`,
      `You are not in the table yet: players get in after ${config.calibration} ranked calibration matches.`)}</span><a class="btn small red" href="#/lobbies">${L('Найти лобби', 'Find a lobby')}</a></p>` : ''}
    ${list.length ? `<div class="table-wrap"><table class="htable ltable"><thead><tr>
      <th>#</th><th>${L('Игрок', 'Player')}</th><th>${L('Ранг', 'Rank')}</th><th>MMR</th><th>${L('Матчи', 'Matches')}</th><th>${L('Победы', 'Wins')}</th><th>%</th><th>${L('Герой', 'Hero')}</th><th>${L('У / С / П', 'K / D / A')}</th>
    </tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><h2 class="h2">${L('Пусто.<br><em>Первый матч</em> откроет таблицу.', 'Empty.<br><em>The first match</em> opens the table.')}</h2></div>`}
  </section>
  ${c.data.calibrating?.length ? `<section class="section">${sectionHead('§', L('На калибровке', 'Calibrating'), L(`в таблицу — после ${config.calibration} матчей`, `in the table after ${config.calibration} matches`))}
    <div class="calib">${c.data.calibrating.map((p) => `<a class="calib-card" href="#/player/${p.sid}">${avatar(p, 'sm')}<b>${esc(p.name)}</b>
      <span class="label">${p.games} ${L('из', 'of')} ${config.calibration}</span></a>`).join('')}</div></section>` : ''}
  <section class="section">${sectionHead('§', L('Как считается рейтинг', 'How the rating works'))}
    <div class="facts">
      <div><b>1000</b><span>${L('MMR у каждого на старте', 'MMR for everyone at the start')}</span></div>
      <div><b>${config.calibration}</b><span>${L('калибровочных матчей: изменения вдвое больше, ранг скрыт', 'calibration matches: double changes, rank hidden')}</span></div>
      <div><b>±16</b><span>${L('примерно за матч равных команд после калибровки; против сильных — больше', 'roughly per match of even teams after calibration; more against stronger ones')}</span></div>
      <div><b>${config.rank_step}</b><span>${L(`MMR — один подранг, от «${ranks[1]?.name || 'Послушник'} I» до «${ranks[11]?.name || 'Этернус'} VI»`,
        `MMR per subrank, from “${ranks[1]?.name || 'Initiate'} I” to “${ranks[11]?.name || 'Eternus'} VI”`)}</span></div>
      <div><b>${L('Команда', 'Team')}</b><span>${L('сила команды — средний MMR игроков, все в ней получают одно изменение (кроме калибровки)',
        'team strength is its players’ average MMR; everyone in it gets the same change (except during calibration)')}</span></div>
      <div><b>${L('2 команды', '2 teams')}</b><span>${L(`подтверждают итог: один сообщает, игрок соперника подтверждает. Без спора итог примется сам через ${Math.round(config.report_timeout / 60)} мин, после ${config.max_disputes} споров матч отменяется`,
        `confirm the result: one reports, a player of the other team confirms. Undisputed, it stands after ${Math.round(config.report_timeout / 60)} min; after ${config.max_disputes} disputes the match is cancelled`)}</span></div>
      <div><b>${config.min_team} ${L('на', 'vs')} ${config.min_team}+</b><span>${L(`в рейтинг идут только равные составы от ${config.min_team} на ${config.min_team} и только аккаунты Steam`,
        `only even teams of ${config.min_team} vs ${config.min_team} or more, Steam accounts only, count for the rating`)}</span></div>
    </div>
  </section>`;
}

function matchesPage() {
  const url = '/api/matches?limit=60' + (ui.mineOnly && me ? `&player=${me.sid}` : '');
  const c = remote(url);
  const wait = waitFor(c, L('Матчи', 'Matches'));
  if (wait) return wait;
  return `<section class="section">
    ${sectionHead('§', L('Матчи', 'Matches'), L('история и идущие сейчас', 'history and live'))}
    <div class="filters">
      <button class="chip-btn ${!ui.mineOnly ? 'on' : ''}" onclick="setMine(false)">${L('Все', 'All')}</button>
      ${me ? `<button class="chip-btn ${ui.mineOnly ? 'on' : ''}" onclick="setMine(true)">${L('Мои', 'Mine')}</button>` : ''}
    </div>
    ${matchList(c.data)}
  </section>`;
}

function matchPage(id) {
  const c = remote(`/api/match/${id}`, 5000);
  const wait = waitFor(c, L('Матч', 'Match'));
  if (wait) return wait;
  const m = c.data;
  const hasKda = m.players.some((p) => p.kills != null);
  const table = (t) => `<div class="team ${TEAM_CLASS[t]}">
    <div class="team-head"><h2 class="team-name">${esc(m.teams[t])}</h2>
      <div class="team-meta"><span class="label">${TEAM_SIDE[t]}</span>${m.winner === t ? `<div><span class="stamp red">${L('Победа', 'Win')}</span></div>` : ''}</div></div>
    <table class="htable sboard"><thead><tr><th>${L('Игрок', 'Player')}</th><th>${L('Герой', 'Hero')}</th>${hasKda ? `<th>${L('У', 'K')}</th><th>${L('С', 'D')}</th><th>${L('П', 'A')}</th><th>${L('Души', 'Souls')}</th>` : ''}<th>MMR</th></tr></thead>
    <tbody>${m.players.filter((p) => p.team === t).map((p) => `<tr>
      <td><span class="pcell">${avatar(p, 'sm')}${plink(p)}</span></td>
      <td><span class="pcell">${heroThumb(p.hero, 'sm')}${heroLink(p.hero || '—')}</span></td>
      ${hasKda ? `<td>${p.kills ?? '—'}</td><td>${p.deaths ?? '—'}</td><td>${p.assists ?? '—'}</td><td>${p.souls ?? '—'}</td>` : ''}
      <td>${p.mmr_after != null ? `${p.mmr_after} ${delta(p.delta)}` : (p.mmr_before ?? '—')}</td>
    </tr>`).join('')}</tbody></table></div>`;
  const dur = m.duration >= 60 ? `${Math.floor(m.duration / 60)} ${L('мин', 'min')}` : null;
  const source = { server: L('прислал сервер', 'sent by the server'), timeout: L('принят без спора по таймеру', 'accepted undisputed on timeout'),
    admin: L('решил админ', 'decided by an admin') }[m.source]
    || L('подтвердили игроки', 'confirmed by the players');
  return `<section class="section">
    <p class="kicker"><a href="#/matches">${L('← все матчи', '← all matches')}</a> · ${esc(modeNameById(m.mode))} · ${fmtDate(m.ts)}${dur ? ` · ${dur}` : ''} · ${L('матч', 'match')} №${esc(m.id)}</p>
    <div class="match-head">
      <h1 class="display">${esc(m.teams[0])}<span class="big-score">${m.score ? `${m.score[0]}:${m.score[1]}` : 'vs'}</span>${esc(m.teams[1])}</h1>
      <p>${statusStamp(m)} ${m.status === 'finished' ? `${L('Итог', 'Result')} ${source}.` : m.status === 'playing' ? L('Матч ещё идёт.', 'The match is still on.') : ''}
        ${m.unranked && m.status !== 'playing' ? `<span class="muted">${L('Без рейтинга', 'Unranked')}: ${esc(reasonText(m.unranked))}.</span>` : ''}</p>
    </div>
    ${m.status === 'playing' && me ? `<div class="night match-result">${resultControls({ id: m.id, teams: m.teams,
      myTeam: m.players.find((p) => p.sid === me.sid)?.team, report: m.report, unranked: m.unranked,
      name: (sid) => m.players.find((p) => p.sid === sid)?.name || '—', where: 'match' })}</div>` : ''}
    <div class="versus">${table(0)}<div class="vs">vs</div>${table(1)}</div>
    ${m.banned.length ? `<p class="label" style="margin-top:22px">${L('Баны', 'Bans')}: ${m.banned.map((h) => heroLink(h)).join(', ')}</p>` : ''}
    ${!hasKda && m.status === 'finished' ? `<p class="hint">${L('Убийства и смерти появятся, когда сервер начнёт присылать статистику сам.', 'Kills and deaths will show up once the server sends stats by itself.')}</p>` : ''}
  </section>`;
}

function mmrChart(history) {
  if (history.length < 2) return `<p class="muted">${L('График появится после двух матчей с рейтингом.', 'The chart shows up after two ranked matches.')}</p>`;
  const W = 640, H = 180, P = 28;
  const vals = history.map((h) => h.mmr);
  const lo = Math.min(...vals) - 20, hi = Math.max(...vals) + 20;
  const x = (i) => P + i * (W - 2 * P) / (history.length - 1);
  const y = (v) => H - P - (v - lo) * (H - 2 * P) / (hi - lo);
  const step = config.rank_step;
  // where each rank begins
  const lines = [];
  for (let tier = 1; tier <= 11; tier++) {
    const v = config.rank_base + (tier - 1) * step * 6;
    if (v > lo && v < hi) lines.push(`<line x1="${P}" x2="${W - P}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${W - P}" y="${y(v) - 4}" text-anchor="end">${esc(ranks[tier]?.name || '')}</text>`);
  }
  const pts = history.map((h, i) => `${x(i).toFixed(1)},${y(h.mmr).toFixed(1)}`).join(' ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${L('MMR по матчам', 'MMR by match')}">
    ${lines.join('')}
    <polyline points="${pts}" class="line"/>
    ${history.map((h, i) => `<circle cx="${x(i)}" cy="${y(h.mmr)}" r="3.5" class="${h.delta >= 0 ? 'up' : 'down'}"><title>${h.mmr} (${h.delta >= 0 ? '+' : ''}${h.delta}) · ${fmtDate(h.ts)}</title></circle>`).join('')}
    <text x="${P}" y="14">${Math.max(...vals)}</text><text x="${P}" y="${H - 8}">${Math.min(...vals)}</text>
  </svg>`;
}

function playerPage(sid) {
  const c = remote(`/api/player/${sid}`);
  const wait = waitFor(c, L('Игрок', 'Player'));
  if (wait) return wait;
  const p = c.data;
  const stat = (v, label) => `<div><b>${v}</b><span>${label}</span></div>`;
  const streak = p.streak ? `${p.streak > 0 ? '+' : '−'}${Math.abs(p.streak)}` : '—';
  return `<section class="hero-page">
    <aside class="hero-side player-side">
      <div class="pbadge">${rankBadge(p.rank, 'lg')}</div>
      <p class="label" style="text-align:center;margin:6px 0 0">${rankName(p.rank)}</p>
    </aside>
    <div>
      <div class="hero-head">
        <p class="kicker">${p.place ? L(`№ ${p.place} в рейтинге`, `#${p.place} in the ranking`) : L('ещё нет в рейтинге', 'not ranked yet')}</p>
        <h1 class="display pname">${avatar(p)}${esc(p.name)}</h1>
      </div>
      <div class="stat-grid">
        ${stat(p.mmr, 'MMR')}${stat(p.peak, L('Пик MMR', 'Peak MMR'))}${stat(p.games, L('Матчей с рейтингом', 'Ranked matches'))}${stat(pct(p.wins, p.games), L(`Побед (${p.wins})`, `Wins (${p.wins})`))}
        ${stat(streak, L('Серия', 'Streak'))}${stat(kdaText(p.kda), L('Убийства / смерти / помощь', 'Kills / deaths / assists'))}
      </div>
      <section class="section">${sectionHead('§', 'MMR', L('по матчам', 'by match'))}${mmrChart(p.history)}</section>
      <section class="section">${sectionHead('§', L('Герои', 'Heroes'))}
        ${p.heroes.length ? `<div class="table-wrap"><table class="htable"><thead><tr><th>${L('Герой', 'Hero')}</th><th>${L('Матчи', 'Matches')}</th><th>${L('Победы', 'Wins')}</th><th>%</th><th>${L('У / С / П', 'K / D / A')}</th></tr></thead>
          <tbody>${p.heroes.map((h) => `<tr><td><span class="pcell">${heroThumb(h.hero, 'sm')}${heroLink(h.hero)}</span></td>
            <td>${h.games}</td><td>${h.wins}</td><td>${pct(h.wins, h.games)}</td><td>${h.with_kda ? kdaText([h.kills, h.deaths, h.assists]) : '—'}</td></tr>`).join('')}</tbody></table></div>`
          : `<p class="muted">${L('Ещё ни одного завершённого матча.', 'No finished matches yet.')}</p>`}
      </section>
      <section class="section">${sectionHead('§', L('Последние матчи', 'Recent matches'))}${matchList(p.matches, p.sid)}</section>
    </div>
  </section>`;
}

function setMine(v) { ui.mineOnly = v; render(); }

// ---------- heroes ----------

const complexity = (n) => `<span class="dots-c" title="${L(`Сложность ${n} из 4`, `Complexity ${n} of 4`)}">${'●'.repeat(n)}<i>${'●'.repeat(Math.max(0, 4 - n))}</i></span>`;
const hc = (h) => h.color ? `--hc:${h.color.join(',')}` : '';
const localName = (h) => (h.name_local && h.name_local !== h.name ? h.name_local : '');

function heroCard(h) {
  return `<a class="hcard" href="#/hero/${h.id}" style="${hc(h)}">
    <img src="${img(h.card)}" alt="${esc(h.name)}" loading="lazy"><span class="bar"></span>
    <span class="cap"><b>${esc(h.name)}</b><small>${esc(h.type_local)}${localName(h) ? ` · ${esc(localName(h))}` : ''}</small></span></a>`;
}

function filteredHeroes() {
  const q = ui.heroQuery.trim().toLowerCase();
  return heroes.filter((h) => (!ui.heroType || h.type === ui.heroType)
    && (!q || [h.name, h.name_local, h.role, ...h.tags].join(' ').toLowerCase().includes(q)));
}

const HERO_COLUMNS = () => [
  ['name', L('Герой', 'Hero'), (h) => h.name],
  ['type', L('Роль', 'Role'), (h) => h.type_local],
  ['complexity', L('Сложн.', 'Compl.'), (h) => h.complexity],
  ['health', L('Здоровье', 'Health'), (h) => +h.stats.health],
  ['regen', L('Реген', 'Regen'), (h) => +h.stats.regen],
  ['dps', L('Урон/с', 'DPS'), (h) => +(h.weapon?.dps || 0)],
  ['bullet', L('Пуля', 'Bullet'), (h) => parseFloat(h.weapon?.bullet_damage || 0)],
  ['clip', L('Обойма', 'Clip'), (h) => h.weapon?.clip || 0],
  ['move', L('Скорость', 'Speed'), (h) => +h.stats.move],
  ['melee', L('Тяж. удар', 'Heavy melee'), (h) => +h.stats.heavy_melee],
];

function heroTableHtml(list) {
  const cols = HERO_COLUMNS();
  const col = cols.find((c) => c[0] === ui.heroSort) || cols[0];
  const sorted = list.slice().sort((a, b) => {
    const x = col[2](a), y = col[2](b);
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * ui.heroSortDir;
  });
  return `<div class="table-wrap"><table class="htable"><thead><tr>${cols.map(([k, label]) =>
    `<th class="${k === ui.heroSort ? 'on' : ''}" onclick="sortHeroes('${k}')">${label}${k === ui.heroSort ? (ui.heroSortDir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr></thead>
    <tbody>${sorted.map((h) => `<tr>
      <td><a href="#/hero/${h.id}"><img src="${img(h.icon || h.card)}" alt="" loading="lazy">${esc(h.name)}</a></td>
      <td>${esc(h.type_local)}</td><td>${complexity(h.complexity)}</td>
      <td>${h.stats.health}</td><td>${h.stats.regen}</td><td>${h.weapon?.dps ?? '—'}</td><td>${esc(h.weapon?.bullet_damage ?? '—')}</td>
      <td>${h.weapon?.clip ?? '—'}</td><td>${h.stats.move}</td><td>${h.stats.heavy_melee}</td></tr>`).join('')}</tbody></table></div>`;
}

function heroGridHtml() {
  const list = filteredHeroes();
  if (!list.length) return `<p class="muted">${L('Никого не нашлось.', 'Nobody found.')}</p>`;
  return ui.heroView === 'table' ? heroTableHtml(list) : `<div class="hgrid">${list.map(heroCard).join('')}</div>`;
}

function leadersHtml() {
  const top = (title, f, unit) => `<div><span class="label">${title}</span><ol>${heroes.slice().sort((a, b) => f(b) - f(a)).slice(0, 5)
    .map((h) => `<li><a href="#/hero/${h.id}">${esc(h.name)}</a><span>${f(h)}${unit}</span></li>`).join('')}</ol></div>`;
  return `<div class="leaders">
    ${top(L('Больше всех здоровья', 'Most health'), (h) => +h.stats.health, '')}
    ${top(L('Самый высокий урон/с', 'Highest DPS'), (h) => +(h.weapon?.dps || 0), '')}
    ${top(L('Самые быстрые', 'Fastest'), (h) => +h.stats.move, L(' м/с', ' m/s'))}
    ${top(L('Тяжёлый удар', 'Heavy melee'), (h) => +h.stats.heavy_melee, '')}
  </div>`;
}

function heroesPage() {
  if (!heroes.length) {
    return `<section class="section">${sectionHead('§', L('Герои', 'Heroes'))}
      <p>${L('Данные героев ещё не собраны. На сервере сайта выполните <code>python web/lobby/build_heroes.py</code> — он возьмёт героев, портреты и умения из установленной игры.',
        'Hero data is not built yet. Run <code>python web/lobby/build_heroes.py</code> on the site server: it takes heroes, portraits and abilities from the installed game.')}</p></section>`;
  }
  return `<section class="section">
    ${sectionHead('§', L('Герои', 'Heroes'), L(`${heroes.length} в пуле драфта · данные из файлов игры`, `${heroes.length} in the draft pool · data from the game files`))}
    <div class="filters">
      ${TYPES().map(([t, label]) => `<button class="chip-btn ${ui.heroType === t ? 'on' : ''}" onclick="setHeroType('${t}')">${label}</button>`).join('')}
      <span style="width:12px"></span>
      <button class="chip-btn ${ui.heroView === 'cards' ? 'on' : ''}" onclick="setHeroView('cards')">${L('Карточки', 'Cards')}</button>
      <button class="chip-btn ${ui.heroView === 'table' ? 'on' : ''}" onclick="setHeroView('table')">${L('Сравнить', 'Compare')}</button>
      <input class="input" id="heroSearch" placeholder="${L('Поиск: имя, роль, тег', 'Search: name, role, tag')}" value="${esc(ui.heroQuery)}" oninput="searchHeroes(this.value)">
    </div>
    <div id="heroGrid">${heroGridHtml()}</div>
  </section>
  <section class="section">${sectionHead('§', L('В цифрах', 'By the numbers'), L('базовые значения на 1 уровне', 'base values at level 1'))}${leadersHtml()}</section>`;
}

function heroPage(id) {
  const h = heroById[id];
  if (!h) return `<section class="section">${sectionHead('§', L('Герой не найден', 'Hero not found'))}<p><a href="#/heroes">${L('← ко всем героям', '← all heroes')}</a></p></section>`;
  const i = heroes.indexOf(h);
  const prev = heroes[(i - 1 + heroes.length) % heroes.length], next = heroes[(i + 1) % heroes.length];
  const w = h.weapon;
  const stat = (v, label, unit = '') => `<div><b>${esc(v)}${unit ? `<small>${unit}</small>` : ''}</b><span>${label}</span></div>`;
  return `<section class="hero-page" style="${hc(h)}">
    <aside class="hero-side">
      <div class="portrait"><img src="${img(h.card)}" alt="${esc(h.name)}"><span class="bar"></span></div>
      <div class="hero-nav">
        <a class="btn small ghost" href="#/hero/${prev.id}">← ${esc(prev.name)}</a>
        <a class="btn small ghost" href="#/hero/${next.id}">${esc(next.name)} →</a>
      </div>
      <p style="margin-top:12px"><a href="#/heroes" class="label">${L('← все герои', '← all heroes')}</a></p>
    </aside>
    <div>
      <div class="hero-head">
        <p class="kicker">${esc(h.type_local)} · ${L('сложность', 'complexity')} ${complexity(h.complexity)}</p>
        <h1 class="display">${esc(h.name)}</h1>
        ${localName(h) ? `<p class="ru">${esc(localName(h))}</p>` : ''}
        <div class="hero-meta">${h.tags.filter(Boolean).map((t) => `<span class="stamp">${esc(t)}</span>`).join('')}</div>
        ${h.role ? `<p class="tagline">${h.role}</p>` : ''}
      </div>
      <div class="stat-grid">
        ${stat(h.stats.health, L('Здоровье', 'Health'))}${stat(h.stats.regen, L('Реген здоровья', 'Health regen'), L('/с', '/s'))}
        ${stat(h.stats.move, L('Скорость', 'Speed'), L('м/с', 'm/s'))}${stat(h.stats.stamina, L('Выносливость', 'Stamina'))}
        ${stat(h.stats.light_melee, L('Лёгкий удар', 'Light melee'))}${stat(h.stats.heavy_melee, L('Тяжёлый удар', 'Heavy melee'))}
        ${w ? stat(w.dps, L('Урон оружия/с', 'Weapon DPS')) + stat(w.clip, L('Патронов в обойме', 'Clip size')) : ''}
      </div>

      <section class="section">${sectionHead('§', L('Умения', 'Abilities'), L('значения на старте, без бонусов от предметов', 'base values, no item bonuses'))}
        <div class="abilities">${h.abilities.map((a, k) => `
          <article class="ability">
            <div class="icon">${a.icon ? `<img src="${img(a.icon)}" alt="">` : ''}<span>${k + 1}</span></div>
            <div>
              <h3>${esc(a.name)}</h3>
              ${a.quip ? `<p class="quip">${a.quip}</p>` : ''}
              ${a.stats.length ? `<div class="chips">${a.stats.map((s) => `<span><b>${esc(s.label)}</b>${esc(s.value)}</span>`).join('')}</div>` : ''}
              <p class="desc">${a.desc}</p>
              ${a.upgrades.length ? `<ul class="upgrades">${a.upgrades.map((u) => `<li data-tier="${L('Улучшение', 'Upgrade')} ${ROMAN[u.tier - 1] || u.tier}">${u.text}</li>`).join('')}</ul>` : ''}
            </div>
          </article>`).join('')}</div>
      </section>

      ${w ? `<section class="section">${sectionHead('§', L('Оружие', 'Weapon'))}
        <div class="stat-grid weapon-grid" style="margin-top:0">
          ${stat(w.dps, L('Урон в секунду', 'Damage per second'))}${stat(w.bullet_damage, L('Урон пули', 'Bullet damage'))}${stat(w.fire_rate, L('Выстрелов', 'Shots'), L('/с', '/s'))}
          ${stat(w.clip, L('Обойма', 'Clip'))}${stat(w.reload, L('Перезарядка', 'Reload'), L('с', 's'))}${stat(w.falloff, L('Спад урона', 'Damage falloff'), L('м', 'm'))}
        </div></section>` : ''}

      ${h.playstyle ? `<section class="section">${sectionHead('§', L('Как играть', 'How to play'))}<p class="rich">${h.playstyle}</p></section>` : ''}
      ${h.lore ? `<section class="section">${sectionHead('§', L('История', 'Lore'))}<p class="rich">${h.lore}</p></section>` : ''}
    </div>
  </section>`;
}

// ---------- items ----------

function itemsPage() {
  if (!items) {
    loadItems();
    return `<section class="section">${sectionHead('§', L('Предметы', 'Items'))}<p class="muted">${L('Загрузка…', 'Loading…')}</p></section>`;
  }
  if (!items.length) {
    return `<section class="section">${sectionHead('§', L('Предметы', 'Items'))}<p>${L('Данные ещё не собраны', 'Data is not built yet')}: <code>python web/lobby/build_heroes.py</code>.</p></section>`;
  }
  const slots = SLOT_NAMES();
  const list = items.filter((i) => i.slot === ui.itemSlot);
  const sel = items.find((i) => i.id === ui.item && i.slot === ui.itemSlot) || list[0];
  const souls = L('душ', 'souls');
  const tiers = [1, 2, 3, 4].map((t) => {
    const inTier = list.filter((i) => i.tier === t);
    return `<div class="tier-col"><h3>${L('Тир', 'Tier')} ${ROMAN[t - 1]}<small>${inTier[0]?.cost ?? ''} ${souls}</small></h3>
      ${inTier.map((i) => `<button class="item-tile ${i === sel ? 'on' : ''}" onclick="pickItem('${i.id}')">
        <img src="${img(i.icon)}" alt="" loading="lazy"><span>${esc(i.name)}${i.active ? `<span class="act">${L('активный', 'active')}</span>` : ''}</span></button>`).join('')}</div>`;
  }).join('');
  return `<section class="section">
    ${sectionHead('§', L('Предметы', 'Items'), L(`${items.length} в магазине · данные из файлов игры`, `${items.length} in the shop · data from the game files`))}
    <div class="filters slot-tabs">${Object.entries(slots).map(([s, label]) =>
      `<button class="chip-btn ${ui.itemSlot === s ? 'on' : ''}" data-slot="${s}" onclick="setItemSlot('${s}')">${label} · ${items.filter((i) => i.slot === s).length}</button>`).join('')}</div>
    <div class="items-wrap slot-${ui.itemSlot}">
      <div class="tiers">${tiers}</div>
      ${sel ? `<aside class="item-detail">
        <img src="${img(sel.icon)}" alt="">
        <h3>${esc(sel.name)}</h3>
        <span class="label muted">${slots[sel.slot]} · ${L('тир', 'tier')} ${ROMAN[sel.tier - 1]} · ${sel.cost} ${souls}${sel.active ? ` · ${L('активный', 'active')}` : ''}${sel.cooldown ? ` · ${L('перезарядка', 'cooldown')} ${sel.cooldown} ${L('с', 's')}` : ''}</span>
        ${sel.bonuses.length ? `<ul>${sel.bonuses.map((b) => `<li><span>${b.label}</span><span>${esc(b.value)}</span></li>`).join('')}</ul>` : ''}
        ${sel.desc ? `<p>${sel.desc}</p>` : ''}
      </aside>` : ''}
    </div>
  </section>`;
}

let itemsLoading = false;
async function loadItems() {
  if (itemsLoading) return;
  itemsLoading = true;
  const lang = LANG;
  let list;
  try { list = await (await fetch(`/static/data/items${DATA_SUFFIX()}.json`)).json(); } catch { list = []; }
  if (lang !== LANG) return;  // the language changed meanwhile: that load is stale
  items = list;
  render();
}

// ---------- reference pages ----------

function modesPage() {
  return `<section class="section">${sectionHead('§', L('Режимы', 'Modes'), L('новые появятся здесь', 'new ones will show up here'))}${modesHtml()}</section>
    <section class="section">${sectionHead('§', L('Драфт', 'Draft'))}${stepsHtml()}</section>`;
}

function guidePage() {
  const counts = {};
  heroes.forEach((h) => { counts[h.type_local] = (counts[h.type_local] || 0) + 1; });
  const facts = [
    ['800 / 1600 / 3200 / 6400', L('душ стоят предметы I–IV тира', 'souls for tier I–IV items')],
    [heroes.length || '—', `${L('героев в пуле', 'heroes in the pool')}: ${Object.entries(counts).map(([t, n]) => `${t.toLowerCase()} — ${n}`).join(', ')}`],
    ['30', L('убийств нужно команде для победы в Overthrow', 'kills a team needs to win Overthrow')],
    ['3000', L('душ у каждого на старте Overthrow', 'souls for everyone at the start of Overthrow')],
    [L('+30/с', '+30/s'), L('душ всем живым, ещё +30/с — на дне ямы', 'souls for everyone alive, another +30/s on the pit floor')],
    [L('3 с + 1 с', '3 s + 1 s'), L('за уровень — время респауна', 'per level: respawn time')],
  ];
  const items = [
    [L('Как подключиться', 'How to connect'), L('В настройках Deadlock включите <b>Dev command console</b>, нажмите <code>F7</code> и вставьте команду <code>connect …</code>, которую сайт покажет после драфта.',
      'Turn on <b>Dev command console</b> in the Deadlock settings, press <code>F7</code> and paste the <code>connect …</code> command the site shows after the draft.')],
    [L('Через Steam или по IP', 'Through Steam or by IP'), L('Команда вида <code>connect [A:1:…]</code> идёт через ретрансляцию Steam — проброс портов не нужен. <code>connect IP:порт</code> — напрямую, быстрее, но порт должен быть открыт.',
      'A <code>connect [A:1:…]</code> command goes through Steam relays, no port forwarding needed. <code>connect IP:port</code> is direct and faster, but the port must be open.')],
    [L('Играю с того же ПК, что и сервер', 'Playing on the server’s PC'), L('Используйте <code>connect localhost:порт</code>. Порт 27015 занят главным меню самой игры, поэтому серверы сайта стартуют с 27020.',
      'Use <code>connect localhost:port</code>. Port 27015 belongs to the game’s own main menu, so the site’s servers start from 27020.')],
    [L('Полезные команды консоли', 'Useful console commands'), L('<code>status</code> — кто на сервере и пинг; <code>disconnect</code> — выйти с сервера; <code>net_graph 1</code> — FPS и пинг на экране.',
      '<code>status</code>: who is on the server and their ping; <code>disconnect</code>: leave the server; <code>net_graph 1</code>: FPS and ping on screen.')],
    [L('Как работает драфт', 'How the draft works'), L(`Сначала каждый предлагает героя на бан, из предложений случайно банятся ${config.bans}. Потом три раунда по два игрока от команды, выбор соперника скрыт до конца раунда. Если обе команды взяли одного героя, он уходит в бан, а эти двое выбирают заново за ${config.repick_seconds} секунд. Не успели — случайный герой.`,
      `First everyone suggests a hero to ban, and ${config.bans} of the suggestions are banned at random. Then three rounds of two players per team; the other team’s picks stay hidden until the round ends. If both teams take the same hero, it is banned and those two pick again in ${config.repick_seconds} seconds. Out of time: a random hero.`)],
    [L('Сменить героя в игре', 'Changing the hero in game'), L('Нельзя: на сервере Overthrow герой фиксируется после драфта. Это честно по отношению к тем, кто выбирал вслепую.',
      'Not possible: on the Overthrow server the hero is fixed after the draft. That is fair to everyone who picked blind.')],
    [L('Overthrow за минуту', 'Overthrow in a minute'), L('Бой в яме мид-босса. Первая команда до 30 убийств побеждает. Души капают всем, на дне ямы — вдвое быстрее, раз в минуту падает урна. Лидер по убийствам подсвечен и стоит +800 душ.',
      'A fight in the mid-boss pit. The first team to 30 kills wins. Everyone earns souls, twice as fast on the pit floor, and an urn drops every minute. The kill leader glows and is worth +800 souls.')],
    [L('Что купить первым', 'What to buy first'), L('Души копятся быстро: старт 3000 — это сразу несколько предметов I тира или один II тира. Смотрите <a href="#/items">каталог предметов</a> по трём веткам: оружие, живучесть и дух.',
      'Souls come fast: the 3000 at the start buy several tier I items or one tier II. See the <a href="#/items">item catalog</a> across the three trees: weapon, vitality and spirit.')],
    [L('Роли героев', 'Hero roles'), L('<b>Стрелки</b> наносят урон с дистанции, <b>мистики</b> играют от умений и спиритической мощи, <b>дебоширы</b> держат удар и лезут в ближний бой, <b>ассасины</b> выбирают момент и добивают. Сравнить цифры — в <a href="#/heroes">таблице героев</a>.',
      '<b>Marksmen</b> deal damage from range, <b>mystics</b> play off abilities and spirit power, <b>brawlers</b> take hits and go into melee, <b>assassins</b> pick their moment and finish. Compare the numbers in the <a href="#/heroes">hero table</a>.')],
    [L('Тяжёлый удар и парирование', 'Heavy melee and parry'), L('Ближний бой в яме решает: у каждого героя есть лёгкий и тяжёлый удар (значения — на странице героя), а тяжёлый удар соперника можно парировать.',
      'Melee decides fights in the pit: every hero has a light and a heavy melee (values on the hero page), and an opponent’s heavy melee can be parried.')],
  ];
  return `<section class="section">${sectionHead('§', L('Цифры, которые стоит знать', 'Numbers worth knowing'))}
    <div class="facts">${facts.map(([b, s]) => `<div><b>${b}</b><span>${s}</span></div>`).join('')}</div></section>
    <section class="section">${sectionHead('§', L('Как играть', 'How to play'))}
    <div class="guide">${items.map(([h, p]) => `<article><h4>${h}</h4><p>${p}</p></article>`).join('')}</div></section>`;
}

// ---------- notices ----------

// an announcement from the admins, the lobby switch, and the player's own ban or mute
function renderNotice() {
  const parts = [];
  if (me?.banned) parts.push(`<b>${L('Аккаунт заблокирован', 'Your account is banned')}</b>${me.ban_reason ? `: ${esc(me.ban_reason)}` : ''}`);
  if (pulse.announcement) parts.push(esc(pulse.announcement));
  if (pulse.chat_closed) parts.push(L('Общий чат временно закрыт.', 'The global chat is closed for now.'));
  if (pulse.lobbies_closed) parts.push(L('Создание новых лобби временно закрыто.', 'Creating new lobbies is closed for now.'));
  const html = parts.map((p) => `<span>${p}</span>`).join('');
  const box = $('notice');
  if (box.innerHTML !== html) box.innerHTML = html;
  box.hidden = !parts.length;
  box.classList.toggle('bad', !!me?.banned || pulse.announcement_kind === 'warn');
}

// ---------- chat ----------

function renderRail() {
  document.body.classList.add('with-rail');
  const muted = me?.muted_until > Date.now() / 1000;
  const till = muted ? new Date(me.muted_until * 1000).toLocaleTimeString(LOCALE(), { hour: '2-digit', minute: '2-digit' }) : '';
  $('say').placeholder = !me ? L('Войдите, чтобы писать', 'Sign in to write') : me.banned ? L('Аккаунт заблокирован', 'Account banned')
    : muted ? L(`Чат закрыт для вас до ${till}`, `You are muted till ${till}`) : L('Написать…', 'Write…');
  $('say').disabled = !me || me.banned || muted;
  const tabs = `<button class="${chat.channel === 'global' ? 'on' : ''}" onclick="switchChannel('global')">${L('Общий', 'Global')}</button>
    <button class="${chat.channel.startsWith('lobby:') ? 'on' : ''}" ${lobby ? '' : 'disabled'} onclick="switchChannel('lobby:${lobby?.id}')">${L('Лобби', 'Lobby')}</button>`;
  if ($('railTabs').innerHTML !== tabs) $('railTabs').innerHTML = tabs;
}

let chatBusy = false;
function switchChannel(channel) {
  if (chat.channel === channel && $('msgs').childElementCount) return;
  chat.channel = channel;
  chatBusy = false;  // a poll still running for the old channel drops its result
  renderMsgs(true);
  renderRail();
  pollChat();
}

// a system line is stored as {"k": code, ...}; older ones are plain Russian text
function sysText(text) {
  let m;
  try { m = JSON.parse(text); } catch { return text; }
  if (!m || typeof m !== 'object' || !m.k) return text;
  const score = m.score ? ` ${m.score[0]}:${m.score[1]}` : '';
  const lines = {
    created: [`${m.who} создал лобби`, `${m.who} created the lobby`],
    joined: [`${m.who} зашёл`, `${m.who} joined`],
    left: [`${m.who} вышел`, `${m.who} left`],
    kicked: [`${m.who} выгнан`, `${m.who} was kicked`],
    away: [`${m.who} ушёл с сайта`, `${m.who} left the site`],
    owner: [`Владелец лобби теперь ${m.who}`, `${m.who} owns the lobby now`],
    bans_start: ['Все готовы. Фаза банов: предложите героя на бан', 'Everyone is ready. Ban phase: suggest a hero to ban'],
    banned: [`Забанены: ${(m.heroes || []).join(', ')}`, `Banned: ${(m.heroes || []).join(', ')}`],
    no_bans: ['Банов нет', 'No bans'],
    clash: [`Обе команды выбрали ${m.hero}: герой забанен, ${m.a} и ${m.b} выбирают заново`,
      `Both teams picked ${m.hero}: it is banned, ${m.a} and ${m.b} pick again`],
    random_pick: [`${m.who} не успел: случайный герой ${m.hero}`, `${m.who} ran out of time: random hero ${m.hero}`],
    draft_done: ['Драфт окончен. Запускаем сервер', 'The draft is over. Starting the server'],
    server_ready: [`Сервер готов: connect ${m.address}`, `Server ready: connect ${m.address}`],
    server_failed: ['Сервер не запустился', 'The server did not start'],
    result: [`Победа: ${m.team}${score}. ${m.rated ? 'Рейтинг обновлён' : 'Матч без рейтинга'}`,
      `Win: ${m.team}${score}. ${m.rated ? 'Ratings updated' : 'Unranked match'}`],
    report: [`${m.who}: победа — ${m.team}${score}. Ждём подтверждения от ${m.wait} (без спора итог примется через ${m.minutes} мин)`,
      `${m.who}: ${m.team} won${score}. Waiting for ${m.wait} to confirm (it stands in ${m.minutes} min if undisputed)`],
    annulled: ['Админ отменил матч: рейтинг не меняется', 'An admin cancelled the match: ratings stay'],
    admin: [`Администрация: ${m.text}`, `Admins: ${m.text}`],
    dispute: [`${m.who} оспорил результат. ${m.cancelled ? 'Споров слишком много: матч отменён, рейтинг не меняется' : 'Сообщите его заново'}`,
      `${m.who} disputed the result. ${m.cancelled ? 'Too many disputes: the match is cancelled, ratings stay' : 'Report it again'}`],
  }[m.k];
  return lines ? L(lines[0], lines[1]) : text;
}

function msgHtml(m) {
  const time = new Date(m.ts * 1000);
  const t = `<span class="t">${pad(time.getHours())}:${pad(time.getMinutes())}</span>`;
  if (!m.user) return `<li class="msg sys">${t}${esc(sysText(m.text))}</li>`;
  return `<li class="msg ${m.user.sid === me?.sid ? 'mine' : ''}">${t}<b>${esc(m.user.name)}</b>${esc(m.text)}</li>`;
}

function renderMsgs(full, fresh = []) {
  const box = $('msgs');
  const log = chat.logs[chat.channel];
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  if (full) {
    box.innerHTML = log?.msgs.length ? log.msgs.map(msgHtml).join('')
      : `<li class="none">${log ? L('Тишина. Напишите первым.', 'Quiet. Be the first to write.') : L('Загрузка…', 'Loading…')}</li>`;
    box.scrollTop = box.scrollHeight;
    return;
  }
  if (!fresh.length) return;
  box.querySelector('.none')?.remove();
  box.insertAdjacentHTML('beforeend', fresh.map(msgHtml).join(''));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function pollChat() {
  if (chatBusy) return;
  const channel = chat.channel;
  const log = chat.logs[channel] || { since: 0, msgs: [] };
  chatBusy = true;
  try {
    const fresh = await api(`/api/chat?channel=${encodeURIComponent(channel)}&since=${log.since}`);
    if (channel !== chat.channel) return;
    addChat(channel, fresh);
  } catch { /* lost access to a closed lobby's chat: the next refresh switches back */ } finally {
    chatBusy = false;
  }
}

function addChat(channel, fresh) {
  const first = !chat.logs[channel];
  const log = chat.logs[channel] || { since: 0, msgs: [] };
  chat.logs[channel] = log;
  // a message already shown (by the other poll or sent from this tab) is not added twice
  const known = new Set(log.msgs.map((m) => m.id));
  const add = fresh.filter((m) => !known.has(m.id));
  log.msgs.push(...add);
  if (fresh.length) log.since = Math.max(log.since, fresh[fresh.length - 1].id);
  if (first || add.length) renderMsgs(first, add);
}

async function sendChat(e) {
  e.preventDefault();
  const input = $('say');
  const text = input.value.trim();
  if (!text) return;
  if (!me) return showError(L('Чат доступен после входа', 'Sign in to chat'));
  input.disabled = true;
  try {
    await api('/api/chat', { channel: chat.channel, text });
    input.value = '';
    chatBusy = false;
    await pollChat();
  } catch (err) { showError(err.message); } finally {
    input.disabled = false;
    input.focus();
  }
}

function toggleRail(open) { $('rail').classList.toggle('open', open); }

// ---------- actions ----------

async function devLoginSubmit(e) {
  e.preventDefault();
  try {
    const r = await api('/api/dev_login', { name: $('devName').value });
    setToken(r.token, false);
    go('/lobbies');
  } catch (err) { showError(err.message); }
  await refresh();
  pollChat();
}

async function logout() {
  try { await api('/api/logout', {}); } catch { /* the token is dropped anyway */ }
  setToken(null);
  chat.logs = {};
  chat.channel = 'global';
  $('msgs').innerHTML = '';
  refresh();
}

async function createLobby(e) {
  e.preventDefault();
  const mode = document.querySelector('input[name="mode"]:checked')?.value;
  document.activeElement.blur();
  await act('/api/lobbies', { mode, team0: $('team0').value, team1: $('team1').value });
}

function focusCreate() {
  const form = document.querySelector('.create');
  form?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('team0')?.focus({ preventScroll: true });
}

const joinLobby = (id) => act(`/api/lobbies/${id}/join`, {});
const lobbyAct = (action, body = {}) => act(`/api/lobbies/${lobby.id}/${action}`, body);
const takeSlot = (team, slot) => lobbyAct('slot', { team, slot });
const setReady = (ready) => lobbyAct('ready', { ready });
const leave = () => lobbyAct('leave');
const start = () => lobbyAct('start');
const kick = (sid) => lobbyAct('kick', { sid });
const closeLobby = () => confirm(L('Закрыть лобби для всех?', 'Close the lobby for everyone?')) && lobbyAct('close');

function renameTeam(t) {
  const name = $('teamName' + t).value;
  document.activeElement.blur();
  lobbyAct('team_name', { team: t, name });
}

function heroClick(hero) {
  if (lobby.state === 'bans') { pendingBan = hero; render(); }
  else lobbyAct('pick', { hero });
}

function sendBan() { if (pendingBan) lobbyAct('ban', { hero: pendingBan }); }
function lockPick() { const h = lobby.phase.sel[me.sid]; if (h) lobbyAct('pick', { hero: h, lock: true }); }

function copyConnect(button) {
  navigator.clipboard.writeText($('connectCmd').textContent).then(() => {
    button.textContent = L('Скопировано', 'Copied');
    setTimeout(() => { button.textContent = L('Копировать', 'Copy'); }, 1500);
  });
}

function setHeroType(t) { ui.heroType = t; render(); }
function setHeroView(v) { ui.heroView = v; render(); }
function sortHeroes(k) {
  ui.heroSortDir = ui.heroSort === k ? -ui.heroSortDir : (k === 'name' || k === 'type' ? 1 : -1);
  ui.heroSort = k;
  render();
}
function searchHeroes(q) {
  // only the grid is redrawn: the search field keeps focus and caret
  ui.heroQuery = q;
  $('heroGrid').innerHTML = heroGridHtml();
  lastHtml = view();
}
function setItemSlot(s) { ui.itemSlot = s; ui.item = null; render(); }
function pickItem(id) {
  ui.item = id;
  render();
  // on a narrow screen the details sit above the list
  document.querySelector('.item-detail')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- start ----------

(async () => {
  if (location.hash.startsWith('#token=')) {
    setToken(new URLSearchParams(location.hash.slice(1)).get('token'), true);
    history.replaceState(null, '', '/#/lobbies');
  } else if (location.hash.startsWith('#error=')) {
    history.replaceState(null, '', '/#/');
    setTimeout(() => showError(L('Не удалось войти через Steam', 'Steam sign-in failed')), 0);
  }
  applyStatic();
  [config] = await Promise.all([api('/api/config'), loadData()]);
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  await sync();
  syncLoop();
  const frame = () => { tickClock(); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
})();
