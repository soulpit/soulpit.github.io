// ЯМА: one page, hash routes, polling instead of sockets.
// The API may live elsewhere (the site on GitHub Pages, the API on another host): config.js sets window.SOULPIT.api.
// Routes: #/ · #/lobbies · #/lobby · #/heroes · #/hero/<id> · #/items · #/modes · #/guide

const API = ((window.SOULPIT && window.SOULPIT.api) || '').replace(/\/$/, '');
const TOKEN_KEY = 'yama_token';
let token = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
let config = null;
let me = null;             // {sid, name, avatar}
let lobby = null;          // the lobby I sit in, as the server shows it to me
let pulse = { online: 0, lobbies: [], matches: [] };
let heroes = [];           // static/data/heroes.json (build_heroes.py); empty when not built
let items = null;          // static/data/items.json, loaded on the items page
let heroById = {}, heroByName = {};
let featured = [];        // heroes shown on the front page, picked once per visit
let ranks = [];           // static/data/ranks.json: names of rank 0 (calibration) .. 11
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
const img = (file) => file ? `/static/data/img/${encodeURIComponent(file)}` : '';
const TEAM_CLASS = ['amber', 'sapphire'];
const TEAM_SIDE = ['Amber', 'Sapphire'];
const TYPES = [['', 'Все'], ['Marksman', 'Стрелки'], ['Mystic', 'Мистики'], ['Brawler', 'Дебоширы'], ['Assassin', 'Ассасины']];
const SLOT_NAMES = { weapon: 'Оружие', vitality: 'Живучесть', spirit: 'Дух' };
const ROMAN = ['I', 'II', 'III', 'IV'];

// ---------- api ----------

async function api(path, body) {
  const res = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Token': token || '' },
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
  try {
    return await api(path, body);
  } catch (e) {
    showError(e.message);
  } finally {
    await refresh();
  }
}

// ---------- polling ----------

async function refresh() {
  if (!token) { me = null; lobby = null; return render(); }
  try {
    const r = await api('/api/me');
    me = r.user;
    lobby = r.lobby;
  } catch (e) {
    if (token) showError(e.message);
  }
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

// ---------- shell ----------

function render() {
  renderNav();
  renderMe();
  renderRail();
  const html = view();
  const key = route() + ':' + (lobby?.state || '');
  if (html !== lastHtml) {
    // don't redraw the same screen while the user types in it
    const typing = document.activeElement?.tagName === 'INPUT' && $('view').contains(document.activeElement);
    if (!(typing && key === lastKey)) {
      $('view').innerHTML = html;
      lastHtml = html;
      lastKey = key;
      afterRender();
    }
  }
  tickClock();
}

function afterRender() {
  const box = $('modelBox');
  if (box && box.dataset.auto === '1' && !box.dataset.loaded) loadModel(box.dataset.hero);
}

function renderNav() {
  const open = pulse.lobbies.filter((l) => l.state === 'waiting').length;
  const r = route();
  const items = [
    ['/', 'Главная'],
    ['/lobbies', `Лобби${open ? ` <sup>${open}</sup>` : ''}`],
    ...(lobby ? [['/lobby', 'Моё лобби', 'mine']] : []),
    ['/top', 'Рейтинг'],
    ['/matches', 'Матчи'],
    ['/heroes', 'Герои'],
    ['/items', 'Предметы'],
    ['/guide', 'Как играть'],
  ];
  const on = (p) => r === p || (p === '/heroes' && r.startsWith('/hero/')) || (p === '/matches' && r.startsWith('/match/'));
  const html = items.map(([p, label, cls]) => `<a href="#${p}" class="${on(p) ? 'on' : ''} ${cls || ''}">${label}</a>`).join('');
  if ($('nav').innerHTML !== html) $('nav').innerHTML = html;
}

function avatar(u, cls = '') {
  return u?.avatar
    ? `<img class="avatar ${cls}" src="${esc(u.avatar)}" alt="">`
    : `<span class="avatar ${cls}">${esc((u?.name || '?').slice(0, 1))}</span>`;
}

function renderMe() {
  const html = me
    ? `<a class="who" href="#/player/${me.sid}"><b>${esc(me.name)}</b><span class="label">${me.rank?.tier ? `${me.mmr} MMR` : 'калибровка'}</span></a>
       ${rankBadge(me.rank)}<button class="logout" onclick="logout()" title="Выйти">выйти</button>`
    : `<a class="btn small" href="${API}/auth/steam">Войти через Steam</a>`;
  if ($('me').innerHTML !== html) $('me').innerHTML = html;
}

function renderTicker() {
  const date = new Date().toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  const open = pulse.lobbies.filter((l) => l.state === 'waiting').length;
  const playing = pulse.lobbies.filter((l) => l.state !== 'waiting').length;
  const html = `
    <span>${esc(date)}</span>
    <span class="on-air">В сети <b>${pulse.online}</b></span>
    <span>Открытых лобби <b>${open}</b></span>
    <span>Идёт матчей <b>${playing}</b></span>
    ${heroes.length ? `<span>Героев в пуле <b>${heroes.length}</b></span>` : ''}
    ${config?.server_mode === 'fake' ? '<span>Серверы: тестовый режим</span>' : ''}`;
  if ($('ticker').innerHTML !== html) $('ticker').innerHTML = html;
}

function stateLabel(s) {
  return { waiting: 'сбор', bans: 'баны', picks: 'драфт', launching: 'запуск', live: 'в игре', error: 'сбой' }[s] || s;
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

// ---------- home ----------

function homeView() {
  return `
    <section class="front">
      <div>
        <p class="kicker">Deadlock · кастомные матчи · Overthrow</p>
        <h1 class="display">Двенадцать<br>входят.<br><em>Яма</em> решает.</h1>
      </div>
      <div class="front-side">
        <p class="lede">Собери лобби до шести на шесть, пройди слепой драфт и получи свой сервер за пару минут.</p>
        ${me
          ? `<a class="btn big red" href="#${lobby ? '/lobby' : '/lobbies'}">${lobby ? 'Вернуться в лобби' : 'Открыть лобби'} <span class="arrow">→</span></a>`
          : `<a class="btn big red" href="${API}/auth/steam">Войти через Steam <span class="arrow">→</span></a>${devLogin()}`}
      </div>
    </section>
    <section class="section">
      ${sectionHead('01', 'Открытые лобби', `<a href="#/lobbies">все лобби и создание →</a>`)}
      ${lobbyRows(pulse.lobbies.filter((l) => l.state === 'waiting').slice(0, 5), true)}
    </section>
    <section class="section">
      ${sectionHead('02', 'Режимы', 'сейчас открыт один')}
      ${modesHtml()}
    </section>
    <section class="section">
      ${sectionHead('03', 'Как проходит матч', 'от лобби до сервера ~3 минуты')}
      ${stepsHtml()}
    </section>
    ${heroes.length ? `<section class="section">${sectionHead('04', 'Герои', `<a href="#/heroes">все ${heroes.length} →</a>`)}
      <div class="hgrid">${featured.map(heroCard).join('')}</div></section>` : ''}
    ${pulse.matches.length ? `<section class="section">${sectionHead('05', 'Последние матчи')}${matchesHtml()}</section>` : ''}`;
}

function devLogin() {
  if (!config?.dev_login) return '';
  return `<div class="dev-login">
    <p class="label muted">Тестовый вход без Steam · у каждой вкладки свой игрок</p>
    <form onsubmit="devLoginSubmit(event)"><input class="input" id="devName" placeholder="Имя" maxlength="32"><button class="btn small">Войти</button></form>
  </div>`;
}

function modesHtml() {
  return `<div class="modes">${config.modes.map((m) => m.available ? `
    <article class="mode on">
      <span class="label">Открыт · ${m.team_size} на ${m.team_size} · ${esc(m.map)}</span>
      <h3 class="h2">${esc(m.name)}</h3>
      <p>${esc(m.tagline)}</p>
      ${m.rules ? `<ul>${m.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      <a class="btn red" href="#/lobbies">Играть <span class="arrow">→</span></a>
    </article>` : `
    <article class="mode off">
      <span class="label">${m.team_size} на ${m.team_size}</span>
      <h3 class="h2">${esc(m.name)}</h3>
      <p>${esc(m.tagline)}</p>
      <span class="stamp red">Скоро</span>
    </article>`).join('')}</div>`;
}

function stepsHtml() {
  const steps = [
    ['Сбор', 'До шести на шесть. Начать можно и меньшим составом — когда все нажали «Готов».', 'без лимита'],
    ['Баны', `Каждый предлагает героя на бан. Из всех предложений случайно банятся ${config.bans}.`, '30 с'],
    ['Пики вслепую', 'Три раунда, по два игрока от команды. Соперник видит выбор только после раунда. Совпали — герой в бан, перепик.', '3 × 30 с'],
    ['Сервер', 'Сайт поднимает сервер Overthrow и выдаёт команду connect. Драфт сохраняется в матч.', '≈ 1 мин'],
  ];
  return `<div class="steps">${steps.map(([h, p, t], i) => `
    <div class="step"><span class="n">${i + 1}</span><h4>${h}</h4><p>${p}</p><span class="time label">${t}</span></div>`).join('')}</div>`;
}

function matchesHtml() {
  return matchList(pulse.matches.slice(0, 6)) + `<p style="margin-top:14px"><a class="label" href="#/matches">вся история матчей →</a></p>`;
}

function heroLink(name) {
  const h = heroByName[name];
  return h ? `<a href="#/hero/${h.id}">${esc(name)}</a>` : esc(name);
}

// ---------- lobby list ----------

function lobbyRows(list, compact) {
  if (!list.length) {
    return `<div class="empty"><h2 class="h2">Пусто.<br><em>Создай первое</em> —<br>остальные подтянутся.</h2>
      <p style="margin-top:18px">${compact
        ? `<a class="btn red" href="#/lobbies">Создать лобби <span class="arrow">→</span></a>`
        : `<button class="btn red" onclick="focusCreate()">Создать лобби <span class="arrow">→</span></button>`}</p></div>`;
  }
  return `<ol class="lobbies">${list.map((l, i) => {
    const half = l.size / 2;
    const pips = (n, t) => `<span class="pips ${TEAM_CLASS[t]}">${Array.from({ length: half }, (_, k) => `<i class="${k < n ? 'on' : ''}"></i>`).join('')}</span>`;
    const mine = lobby?.id === l.id;
    const canJoin = l.state === 'waiting' && l.players < l.size && !mine;
    let action;
    if (mine) action = `<a class="btn small red" href="#/lobby">Моё лобби</a>`;
    else if (canJoin) action = me ? `<button class="btn small" onclick="joinLobby('${l.id}')">Войти <span class="arrow">→</span></button>`
      : `<a class="btn small" href="${API}/auth/steam">Войти</a>`;
    else action = `<span class="stamp ${l.state === 'waiting' ? '' : 'red'}">${l.state === 'waiting' ? 'полное' : stateLabel(l.state)}</span>`;
    return `<li class="lrow">
      <span class="n">${pad(i + 1)}</span>
      <div><div class="lobby-title">${teamsTitle(l.teams.map((t) => t.name))}</div>
        <div class="sub label">${esc(modeOf(l.mode).name)} · создал ${esc(l.owner)} · ${stateLabel(l.state)} · ${l.players}/${l.size}</div></div>
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
          <div><p class="kicker">Ждут игроков · нажмите «Войти», чтобы занять слот</p><h1 class="h2">Открытые лобби</h1></div>
          <span class="count">${pad(open.length)}</span>
        </div>
        ${lobby ? `<div class="in-lobby"><span>Вы уже в лобби <b>${teamsTitle(lobby.teams.map((t) => t.name))}</b> · ${stateLabel(lobby.state)}</span>
          <a class="btn small red" href="#/lobby">Вернуться <span class="arrow">→</span></a></div>` : ''}
        ${lobbyRows(open)}
        <ul class="how-join">
          <li><b>1. Войдите</b>Через Steam — так соперники видят, с кем играют.</li>
          <li><b>2. Займите слот</b>«Войти» сажает в команду, где меньше людей. Пересесть можно кликом по свободному месту.</li>
          <li><b>3. Нажмите «Готов»</b>Когда готовы все, владелец лобби запускает драфт.</li>
        </ul>
        ${running.length ? `<section class="section">${sectionHead('§', 'Идут сейчас')}${lobbyRows(running)}</section>` : ''}
        ${pulse.matches.length ? `<section class="section">${sectionHead('§', 'Последние матчи')}${matchesHtml()}</section>` : ''}
      </div>
      ${me ? createHtml() : `<div class="create"><h2 class="h3">Своё лобби</h2><p>Создавать и заходить в лобби можно после входа.</p>
        <a class="btn red" href="${API}/auth/steam">Войти через Steam</a>${devLogin()}</div>`}
    </section>`;
}

function createHtml() {
  return `<form class="create" onsubmit="createLobby(event)">
    <h2 class="h3">Новое лобби</h2>
    <div class="mode-select">${config.modes.map((m, i) => `
      <label class="${m.available ? '' : 'off'}">
        <input type="radio" name="mode" value="${m.id}" ${m.available ? '' : 'disabled'} ${i === 0 ? 'checked' : ''}>
        <b>${esc(m.name)}</b><small class="label">${m.available ? `${m.team_size}×${m.team_size}` : 'скоро'}</small>
      </label>`).join('')}</div>
    <div class="two">
      <label class="field"><span class="label">Amber</span><input class="input" id="team0" maxlength="32" placeholder="Amber"></label>
      <label class="field"><span class="label">Sapphire</span><input class="input" id="team1" maxlength="32" placeholder="Sapphire"></label>
    </div>
    <button class="btn red" ${lobby ? 'disabled title="Сначала выйдите из своего лобби"' : ''}>Создать лобби <span class="arrow">→</span></button>
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
        <div><p class="kicker">${esc(modeOf(l.mode).name)} · лобби №${esc(l.id)} · создал ${esc(nameOf(l, l.owner))}</p>
          <h1 class="display">${teamsTitle(l.teams.map((t) => t.name))}</h1></div>
        <div class="actions">
          <button class="btn big ${amReady ? 'ghost' : 'red'}" onclick="setReady(${!amReady})">${amReady ? 'Не готов' : 'Готов'}</button>
          <button class="btn ghost" onclick="leave()">Выйти</button>
          ${isOwner ? `<button class="btn" onclick="start()" ${allReady ? '' : 'disabled'}>Начать драфт <span class="arrow">→</span></button>` : ''}
          <span class="note label">Готовы ${l.ready.length} из ${all.length} · ${isOwner ? 'драфт запускаете вы' : 'драфт запускает владелец'}</span>
        </div>
      </div>
      <div class="versus">${teamHtml(l, 0)}<div class="vs">vs</div>${teamHtml(l, 1)}</div>
      <p class="hint">Кликните по свободному слоту, чтобы пересесть. Название команды меняет её капитан — первый игрок в составе. Ушедших с сайта больше чем на пару минут лобби отпускает само.</p>
    </section>`;
}

function teamHtml(l, t) {
  const team = l.teams[t];
  const isOwner = l.owner === me.sid;
  const canRename = isOwner || team.captain === me.sid;
  const count = team.slots.filter(Boolean).length;
  return `<div class="team ${TEAM_CLASS[t]}">
    <div class="team-head">
      <h2 class="team-name">${canRename ? `<input id="teamName${t}" value="${esc(team.name)}" maxlength="32" onchange="renameTeam(${t})" aria-label="Название команды">` : esc(team.name)}</h2>
      <div class="team-meta"><span class="label">${TEAM_SIDE[t]}</span><div class="cnt">${count}/${team.slots.length}</div></div>
    </div>
    <ol class="slots">${team.slots.map((sid, s) => {
      if (!sid) return `<li class="slot free" onclick="takeSlot(${t}, ${s})"><span class="no">${pad(s + 1)}</span><span class="ph"></span><span class="nm">Свободно</span><span></span></li>`;
      const u = l.users[sid];
      const tags = [u?.rank?.tier ? `${u.mmr} MMR` : 'калибровка', sid === me.sid && 'вы', sid === l.owner && 'владелец',
        sid === team.captain && 'капитан'].filter(Boolean).join(' · ');
      return `<li class="slot ${sid === me.sid ? 'me' : ''}">
        <span class="no">${pad(s + 1)}</span>${avatar(u)}
        <span class="nm"><a class="plink" href="#/player/${sid}">${esc(u?.name)}</a> ${rankBadge(u?.rank)}<small>${tags}</small></span>
        <span>${l.ready.includes(sid) ? '<span class="stamp red">Готов</span>' : '<span class="stamp wait">ждём</span>'}
          ${isOwner && sid !== me.sid ? `<button class="kick" onclick="kick('${sid}')" title="Выгнать">×</button>` : ''}</span>
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
    title = 'Баны';
    sub = myNom
      ? `Ваш бан — ${esc(myNom)}. Ждём остальных: из всех предложений случайно забанят ${config.bans}.`
      : `Предложите героя на бан. Из всех предложений случайно забанят ${config.bans}. Союзники видят ваш выбор, соперники — нет.`;
  } else {
    title = ph.repick ? 'Перепик' : `Раунд ${ph.round + 1}`;
    const myRound = Math.floor(playersOf(l, mine).indexOf(me.sid) / 2) + 1;
    if (ph.repick && picker) sub = 'Обе команды взяли одного героя — он забанен. Выберите другого, тоже вслепую.';
    else if (picker) sub = locked ? 'Выбор зафиксирован. Ждём остальных.' : 'Ваш ход. Выберите героя и зафиксируйте — соперник увидит его только после раунда.';
    else if (l.picks[me.sid]) sub = `Ваш герой — ${esc(l.picks[me.sid])}. Смотрим, как выбирают остальные.`;
    else sub = `Выбирают: ${ph.pickers.map((p) => esc(nameOf(l, p))).join(', ')}. Ваш ход — в раунде ${myRound}.`;
  }

  const rounds = bans ? '' : `<div class="rounds label">${Array.from({ length: ph.rounds }, (_, r) =>
    `<span class="${r === ph.round ? 'on' : r < ph.round ? 'done' : ''}">Раунд ${r + 1}</span>`).join('')}</div>`;

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
    ? `<span class="label muted">Предложения команды:</span>${Object.values(ph.noms).map((h) => `<span class="chip nom">${esc(h)}</span>`).join('') || '<span class="muted">пока нет</span>'}`
    : `<span class="label muted">Забанены:</span>${l.banned.map((h) => `<span class="chip">${esc(h)}</span>`).join('') || '<span class="muted">никто</span>'}`;

  let confirm;
  if (canAct) {
    const role = heroByName[mySel]?.role;
    confirm = `<div><span class="label muted">${bans ? 'Бан' : 'Ваш герой'}${role ? ` · ${role}` : ''}</span><div class="pick-name">${esc(mySel || '—')}</div></div>
      <button class="btn big red" ${mySel ? '' : 'disabled'} onclick="${bans ? 'sendBan()' : 'lockPick()'}">${bans ? 'Предложить бан' : 'Зафиксировать'}</button>`;
  } else if (bans) {
    confirm = `<div><span class="label muted">Ваш бан</span><div class="pick-name">${esc(myNom)}</div></div>`;
  } else if (locked) {
    confirm = `<div><span class="label muted">Зафиксировано</span><div class="pick-name">${esc(mySel)}</div></div>`;
  } else {
    confirm = `<span class="muted">${l.picks[me.sid] ? 'Ваш герой выбран.' : 'Ждите своего раунда.'}</span>`;
  }

  return `<section class="night">
    <div class="draft-top">
      <div><p class="kicker">${esc(modeOf(l.mode).name)} · ${esc(l.teams[0].name)} vs ${esc(l.teams[1].name)}</p><h1 class="display">${title}</h1><p class="sub">${sub}</p>${rounds}</div>
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
    const who = `${esc(nameOf(l, sid))}${sid === me.sid ? ' · вы' : ''}`;
    let hero, now = false, face = '';
    if (l.picks[sid]) {
      face = pic(l.picks[sid]);
      hero = `<div class="hero">${esc(l.picks[sid])}</div>`;
    } else if (ph.kind === 'bans') {
      if (own && ph.noms[sid]) hero = `<div class="hero tentative">бан: ${esc(ph.noms[sid])}</div>`;
      else hero = `<div class="hero pending">${ph.nominated.includes(sid) ? 'бан предложен' : 'думает…'}</div>`;
    } else if (ph.pickers.includes(sid)) {
      now = true;
      const isLocked = ph.locked.includes(sid);
      if (own && ph.sel[sid]) {
        face = pic(ph.sel[sid]);
        hero = `<div class="hero ${isLocked ? '' : 'tentative'}">${esc(ph.sel[sid])}${isLocked ? ' <span class="lock">■</span>' : ''}</div>`;
      } else if (!own && isLocked) hero = `<div class="hero hidden">??? <span class="lock">■</span></div>`;
      else hero = `<div class="hero pending">выбирает…</div>`;
    } else {
      hero = `<div class="hero pending">раунд ${Math.floor(i / 2) + 1}</div>`;
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
    ${l.banned.length ? `<p class="label muted" style="margin-top:18px">Баны: ${l.banned.map(esc).join(', ')}</p>` : ''}
  </div>`;
  const buttons = `<p style="margin-top:28px;display:flex;gap:10px;flex-wrap:wrap">
    ${isOwner ? `<button class="btn" onclick="closeLobby()">Закрыть лобби${s.pid ? ' и сервер' : ''}</button>` : ''}
    ${l.state !== 'launching' ? `<button class="btn ghost" onclick="leave()">Выйти из лобби</button>` : ''}
  </p>`;

  let left;
  if (l.state === 'launching') {
    left = `<h1 class="display">Сервер<br>поднимается<span class="dots"></span></h1>
      <p class="sub">Драфт окончен. Через минуту здесь появится команда для подключения.</p>`;
  } else if (l.state === 'error') {
    left = `<h1 class="display">Сбой<em>.</em></h1><p class="sub">Сервер не запустился: ${esc(s.error)}</p>`;
  } else {
    const myHero = heroByName[l.picks[me.sid]];
    left = `<h1 class="display">Сервер<br>готов<em>.</em></h1>
      ${s.fake ? '<p class="sub muted">Тестовый режим: сервер не запускался, адрес ненастоящий.</p>' : ''}
      <div class="connect"><span class="label muted">Команда для консоли</span>
        <div class="connect-box"><code id="connectCmd">connect ${esc(s.address)}</code><button onclick="copyConnect(this)">Копировать</button></div>
        ${s.steam_id ? `<p class="label muted" style="margin-top:10px">Через Steam, без проброса портов: <code>connect ${esc(s.steam_id)}</code></p>` : ''}
      </div>
      <ol class="how">
        <li><span>Запустите Deadlock. В настройках включите <b>Dev command console</b>.</span></li>
        <li><span>Нажмите <span class="kbd">F7</span> и вставьте команду.</span></li>
        <li><span>Сервер сам рассадит по командам. Ваш герой — ${myHero ? `<a href="#/hero/${myHero.id}" style="color:var(--cream)">${esc(myHero.name)}</a>, освежите умения перед боем` : 'из драфта'}.</span></li>
      </ol>`;
  }
  return `<section class="night">
    <p class="kicker">${esc(modeOf(l.mode).name)} · ${esc(l.teams[0].name)} vs ${esc(l.teams[1].name)} · ${stateLabel(l.state)}</p>
    <div class="live"><div>${left}${resultPanel(l)}${buttons}</div>${roster}</div>
  </section>`;
}

function resultPanel(l) {
  if (l.state !== 'live') return '';
  if (l.result) {
    const d = l.result.deltas?.[me.sid];
    const via = { server: ' · от сервера', timeout: ' · принят без спора по таймеру' }[l.result.source] || ' · подтверждён командами';
    return `<div class="result-box">
      <span class="label muted">Результат${via}</span>
      <h2 class="h2">Победа: ${esc(l.teams[l.result.winner].name)}${l.result.score ? ` <span class="score">${l.result.score[0]}:${l.result.score[1]}</span>` : ''}</h2>
      <p>${d == null ? 'Матч без рейтинга.' : `Ваш рейтинг: ${delta(d)}`} <a href="#/match/${l.id}" style="color:var(--cream)">Статистика матча →</a></p>
    </div>`;
  }
  if (l.match !== 'playing') return '';
  return resultControls({ id: l.id, teams: l.teams.map((t) => t.name), myTeam: teamOf(l, me.sid), report: l.report,
    unranked: l.unranked, name: (sid) => nameOf(l, sid), where: 'lobby' });
}

// report / confirm / dispute; where: 'lobby' acts through the lobby, 'match' through the match page
function resultControls(c) {
  const why = c.unranked ? `<p class="muted small">Матч без рейтинга: ${esc(c.unranked)}.</p>` : '';
  const left = (r) => r.auto_in > 0 ? ` Если никто не оспорит, итог примется сам через ${Math.ceil(r.auto_in / 60)} мин.` : ' Итог вот-вот примется сам.';
  if (c.report) {
    const r = c.report;
    const text = `${esc(c.name(r.by))}: победа — <b>${esc(c.teams[r.winner])}</b>${r.score ? ` ${r.score[0]}:${r.score[1]}` : ''}`;
    const disputes = r.disputes ? ` Споров: ${r.disputes} из ${config.max_disputes} — после ${config.max_disputes}-го матч отменится.` : '';
    let actions;
    if (c.myTeam == null || c.myTeam < 0) actions = '';
    else if (c.myTeam !== r.team) actions = `<p class="row-btns"><button class="btn red" onclick="resultAct('${c.where}', '${c.id}', 'confirm')">Подтвердить</button>
      <button class="btn ghost" onclick="resultAct('${c.where}', '${c.id}', 'dispute')">Оспорить</button></p>`;
    else actions = `<p class="row-btns"><button class="btn ghost" onclick="openReport('${c.where}')">Изменить</button></p>`;
    return `<div class="result-box"><span class="label muted">Результат ждёт подтверждения</span><p>${text}</p>
      <p class="muted small">Подтвердить или оспорить может игрок команды ${esc(c.teams[1 - r.team])}.${left(r)}${disputes}</p>${actions}${why}</div>`;
  }
  if (c.myTeam == null || c.myTeam < 0) return why ? `<div class="result-box">${why}</div>` : '';
  return `<div class="result-box">
    <span class="label muted">После матча</span>
    <h3 class="h3" style="margin:6px 0 12px">Кто победил?</h3>
    <p class="score-in"><input class="input" id="scoreA" type="number" min="0" max="999" placeholder="${esc(c.teams[0])}">
      <span>:</span><input class="input" id="scoreB" type="number" min="0" max="999" placeholder="${esc(c.teams[1])}"></p>
    <p class="row-btns">${[0, 1].map((t) => `<button class="btn ${t === 0 ? 'amber' : 'sapphire'}" onclick="reportWin('${c.where}', '${c.id}', ${t})">${esc(c.teams[t])}</button>`).join('')}</p>
    <p class="muted small">Счёт по убийствам — по желанию. Итог подтверждает игрок другой команды — здесь или на странице матча,
      даже если он уже вышел из лобби. Без спора итог примется сам через ${Math.round(config.report_timeout / 60)} мин.
      Если сервер пришлёт итог сам, он запишется без подтверждения.</p>${why}
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
const fmtDate = (ts) => new Date(ts * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const delta = (d) => d == null ? '' : `<span class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : '−'}${Math.abs(d)}</span>`;
const plink = (p) => `<a class="plink" href="#/player/${p.sid}">${esc(p.name)}</a>`;
const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';
const kdaText = (k) => k ? `${k[0] ?? 0} / ${k[1] ?? 0} / ${k[2] ?? 0}` : '—';

function rankName(r) {
  if (!r) return '';
  if (!r.tier) return `Калибровка · ещё ${r.calibration_left}`;
  return `${ranks[r.tier]?.name || 'Ранг ' + r.tier} ${ROMAN6[r.sub - 1]}`;
}

function rankBadge(r, size = 'sm') {
  if (!r) return '';
  const file = r.tier ? `ranks/rank${r.tier}/badge_${size}_subrank${r.sub}_psd.png` : `ranks/rank0/badge_${size}_psd.png`;
  return `<img class="rank-badge ${size}" src="/static/data/img/${file}" alt="" title="${esc(rankName(r))}" onerror="this.remove()">`;
}

// GET data for a page: cached, refreshed in the background when older than maxAge
const remoteCache = {};
function remote(url, maxAge = 8000) {
  const c = remoteCache[url];
  if (!c || (!c.loading && Date.now() - c.at > maxAge)) {
    remoteCache[url] = { ...(c || { at: 0 }), loading: true };
    fetch(API + url, { headers: { 'X-Token': token || '' } })
      .then((r) => r.json().then((d) => [r.ok, d]))
      .then(([ok, d]) => { remoteCache[url] = { data: ok ? d : null, error: ok ? null : d.error, at: Date.now() }; render(); })
      .catch(() => { remoteCache[url] = { data: null, error: 'Сервер недоступен', at: Date.now() }; render(); });
  }
  return remoteCache[url];
}

function waitFor(c, title) {
  if (c?.data) return null;
  return `<section class="section">${sectionHead('§', title)}<p class="muted">${c?.error ? esc(c.error) : 'Загрузка…'}</p></section>`;
}

function heroThumb(name, cls = '') {
  const h = heroByName[name];
  if (!h) return name ? `<span class="hthumb ${cls} none">${esc(monogram(name))}</span>` : `<span class="hthumb ${cls} none">?</span>`;
  return `<a class="hthumb ${cls}" href="#/hero/${h.id}" title="${esc(h.name)}" onclick="event.stopPropagation()"><img src="${img(h.icon || h.card)}" alt="${esc(h.name)}" loading="lazy"></a>`;
}

function statusStamp(m) {
  if (m.status === 'playing') return '<span class="stamp red">идёт</span>';
  if (m.status === 'unscored') return '<span class="stamp wait">без итога</span>';
  if (m.status === 'cancelled') return '<span class="stamp wait">отменён</span>';
  return m.ranked ? '' : `<span class="stamp wait" title="${esc(m.unranked || '')}">без рейтинга</span>`;
}

function matchList(list, forSid = me?.sid) {
  if (!list.length) return '<p class="muted">Матчей пока нет. Сыграйте первый — он появится здесь.</p>';
  return `<ol class="mlist">${list.map((m) => {
    const side = (t) => m.players.filter((p) => p.team === t);
    const mine = m.players.find((p) => p.sid === forSid);
    const won = mine && m.status === 'finished' ? m.winner === mine.team : null;
    const team = (t) => `<div class="mside ${m.winner === t ? 'won' : ''} ${TEAM_CLASS[t]}">
      <b>${esc(m.teams[t])}</b><span class="thumbs">${side(t).map((p) => heroThumb(p.hero, 'sm')).join('')}</span></div>`;
    return `<li class="mrow ${won === true ? 'win' : won === false ? 'loss' : ''}" onclick="go('/match/${m.id}')">
      <span class="when label">${fmtDate(m.ts)}<br>${esc(modeOf(m.mode).name)}</span>
      ${team(0)}
      <span class="mscore">${m.score ? `${m.score[0]}<i>:</i>${m.score[1]}` : m.status === 'finished' ? (m.winner === 0 ? 'W<i>:</i>L' : 'L<i>:</i>W') : '<i>vs</i>'}</span>
      ${team(1)}
      <span class="mres">${statusStamp(m)}${won != null ? `<span class="wl ${won ? 'up' : 'down'}">${won ? 'победа' : 'поражение'}</span> ${delta(mine.delta)}` : ''}</span>
    </li>`;
  }).join('')}</ol>`;
}

function leaderboardPage() {
  const c = remote('/api/leaderboard');
  const wait = waitFor(c, 'Рейтинг');
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
    ${sectionHead('§', 'Рейтинг', `${list.length} игроков · Elo по командам`)}
    ${list.length ? `<div class="podium">${podium}</div>` : ''}
    ${me && !meRow ? `<p class="in-lobby" style="margin:0 0 18px"><span>Вас пока нет в таблице: в неё попадают после ${config.calibration} калибровочных матчей с рейтингом.</span><a class="btn small red" href="#/lobbies">Найти лобби</a></p>` : ''}
    ${list.length ? `<div class="table-wrap"><table class="htable ltable"><thead><tr>
      <th>#</th><th>Игрок</th><th>Ранг</th><th>MMR</th><th>Матчи</th><th>Победы</th><th>%</th><th>Герой</th><th>У / С / П</th>
    </tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty"><h2 class="h2">Пусто.<br><em>Первый матч</em> откроет таблицу.</h2></div>'}
  </section>
  ${c.data.calibrating?.length ? `<section class="section">${sectionHead('§', 'На калибровке', `в таблицу — после ${config.calibration} матчей`)}
    <div class="calib">${c.data.calibrating.map((p) => `<a class="calib-card" href="#/player/${p.sid}">${avatar(p, 'sm')}<b>${esc(p.name)}</b>
      <span class="label">${p.games} из ${config.calibration}</span></a>`).join('')}</div></section>` : ''}
  <section class="section">${sectionHead('§', 'Как считается рейтинг')}
    <div class="facts">
      <div><b>1000</b><span>MMR у каждого на старте</span></div>
      <div><b>${config.calibration}</b><span>калибровочных матчей: изменения вдвое больше, ранг скрыт</span></div>
      <div><b>±16</b><span>примерно за матч равных команд после калибровки; против сильных — больше</span></div>
      <div><b>${config.rank_step}</b><span>MMR — один подранг, от «${ranks[1]?.name || 'Послушник'} I» до «${ranks[11]?.name || 'Этернус'} VI»</span></div>
      <div><b>Команда</b><span>сила команды — средний MMR игроков, все в ней получают одно изменение (кроме калибровки)</span></div>
      <div><b>2 команды</b><span>подтверждают итог: один сообщает, игрок соперника подтверждает. Без спора итог примется сам через ${Math.round(config.report_timeout / 60)} мин, после ${config.max_disputes} споров матч отменяется</span></div>
      <div><b>${config.min_team} на ${config.min_team}+</b><span>в рейтинг идут только равные составы от ${config.min_team} на ${config.min_team} и только аккаунты Steam</span></div>
    </div>
  </section>`;
}

function matchesPage() {
  const url = '/api/matches?limit=60' + (ui.mineOnly && me ? `&player=${me.sid}` : '');
  const c = remote(url);
  const wait = waitFor(c, 'Матчи');
  if (wait) return wait;
  return `<section class="section">
    ${sectionHead('§', 'Матчи', 'история и идущие сейчас')}
    <div class="filters">
      <button class="chip-btn ${!ui.mineOnly ? 'on' : ''}" onclick="setMine(false)">Все</button>
      ${me ? `<button class="chip-btn ${ui.mineOnly ? 'on' : ''}" onclick="setMine(true)">Мои</button>` : ''}
    </div>
    ${matchList(c.data)}
  </section>`;
}

function matchPage(id) {
  const c = remote(`/api/match/${id}`, 5000);
  const wait = waitFor(c, 'Матч');
  if (wait) return wait;
  const m = c.data;
  const hasKda = m.players.some((p) => p.kills != null);
  const table = (t) => `<div class="team ${TEAM_CLASS[t]}">
    <div class="team-head"><h2 class="team-name">${esc(m.teams[t])}</h2>
      <div class="team-meta"><span class="label">${TEAM_SIDE[t]}</span>${m.winner === t ? '<div><span class="stamp red">Победа</span></div>' : ''}</div></div>
    <table class="htable sboard"><thead><tr><th>Игрок</th><th>Герой</th>${hasKda ? '<th>У</th><th>С</th><th>П</th><th>Души</th>' : ''}<th>MMR</th></tr></thead>
    <tbody>${m.players.filter((p) => p.team === t).map((p) => `<tr>
      <td><span class="pcell">${avatar(p, 'sm')}${plink(p)}</span></td>
      <td><span class="pcell">${heroThumb(p.hero, 'sm')}${heroLink(p.hero || '—')}</span></td>
      ${hasKda ? `<td>${p.kills ?? '—'}</td><td>${p.deaths ?? '—'}</td><td>${p.assists ?? '—'}</td><td>${p.souls ?? '—'}</td>` : ''}
      <td>${p.mmr_after != null ? `${p.mmr_after} ${delta(p.delta)}` : (p.mmr_before ?? '—')}</td>
    </tr>`).join('')}</tbody></table></div>`;
  const dur = m.duration >= 60 ? `${Math.floor(m.duration / 60)} мин` : null;
  return `<section class="section">
    <p class="kicker"><a href="#/matches">← все матчи</a> · ${esc(modeOf(m.mode).name)} · ${fmtDate(m.ts)}${dur ? ` · ${dur}` : ''} · матч №${esc(m.id)}</p>
    <div class="match-head">
      <h1 class="display">${esc(m.teams[0])}<span class="big-score">${m.score ? `${m.score[0]}:${m.score[1]}` : 'vs'}</span>${esc(m.teams[1])}</h1>
      <p>${statusStamp(m)} ${m.status === 'finished' ? `Итог ${{ server: 'прислал сервер', timeout: 'принят без спора по таймеру' }[m.source] || 'подтвердили игроки'}.` : m.status === 'playing' ? 'Матч ещё идёт.' : ''}
        ${m.unranked && m.status !== 'playing' ? `<span class="muted">Без рейтинга: ${esc(m.unranked)}.</span>` : ''}</p>
    </div>
    ${m.status === 'playing' && me ? `<div class="night match-result">${resultControls({ id: m.id, teams: m.teams,
      myTeam: m.players.find((p) => p.sid === me.sid)?.team, report: m.report, unranked: m.unranked,
      name: (sid) => m.players.find((p) => p.sid === sid)?.name || '—', where: 'match' })}</div>` : ''}
    <div class="versus">${table(0)}<div class="vs">vs</div>${table(1)}</div>
    ${m.banned.length ? `<p class="label" style="margin-top:22px">Баны: ${m.banned.map((h) => heroLink(h)).join(', ')}</p>` : ''}
    ${!hasKda && m.status === 'finished' ? '<p class="hint">Убийства и смерти появятся, когда сервер начнёт присылать статистику сам.</p>' : ''}
  </section>`;
}

function mmrChart(history) {
  if (history.length < 2) return '<p class="muted">График появится после двух матчей с рейтингом.</p>';
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
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="MMR по матчам">
    ${lines.join('')}
    <polyline points="${pts}" class="line"/>
    ${history.map((h, i) => `<circle cx="${x(i)}" cy="${y(h.mmr)}" r="3.5" class="${h.delta >= 0 ? 'up' : 'down'}"><title>${h.mmr} (${h.delta >= 0 ? '+' : ''}${h.delta}) · ${fmtDate(h.ts)}</title></circle>`).join('')}
    <text x="${P}" y="14">${Math.max(...vals)}</text><text x="${P}" y="${H - 8}">${Math.min(...vals)}</text>
  </svg>`;
}

function playerPage(sid) {
  const c = remote(`/api/player/${sid}`);
  const wait = waitFor(c, 'Игрок');
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
        <p class="kicker">${p.place ? `№ ${p.place} в рейтинге` : 'ещё нет в рейтинге'}</p>
        <h1 class="display pname">${avatar(p)}${esc(p.name)}</h1>
      </div>
      <div class="stat-grid">
        ${stat(p.mmr, 'MMR')}${stat(p.peak, 'Пик MMR')}${stat(p.games, 'Матчей с рейтингом')}${stat(pct(p.wins, p.games), `Побед (${p.wins})`)}
        ${stat(streak, 'Серия')}${stat(kdaText(p.kda), 'Убийства / смерти / помощь')}
      </div>
      <section class="section">${sectionHead('§', 'MMR', 'по матчам')}${mmrChart(p.history)}</section>
      <section class="section">${sectionHead('§', 'Герои')}
        ${p.heroes.length ? `<div class="table-wrap"><table class="htable"><thead><tr><th>Герой</th><th>Матчи</th><th>Победы</th><th>%</th><th>У / С / П</th></tr></thead>
          <tbody>${p.heroes.map((h) => `<tr><td><span class="pcell">${heroThumb(h.hero, 'sm')}${heroLink(h.hero)}</span></td>
            <td>${h.games}</td><td>${h.wins}</td><td>${pct(h.wins, h.games)}</td><td>${h.with_kda ? kdaText([h.kills, h.deaths, h.assists]) : '—'}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">Ещё ни одного завершённого матча.</p>'}
      </section>
      <section class="section">${sectionHead('§', 'Последние матчи')}${matchList(p.matches, p.sid)}</section>
    </div>
  </section>`;
}

function setMine(v) { ui.mineOnly = v; render(); }

// ---------- heroes ----------

const complexity = (n) => `<span class="dots-c" title="Сложность ${n} из 4">${'●'.repeat(n)}<i>${'●'.repeat(Math.max(0, 4 - n))}</i></span>`;
const hc = (h) => h.color ? `--hc:${h.color.join(',')}` : '';

function heroCard(h) {
  return `<a class="hcard" href="#/hero/${h.id}" style="${hc(h)}">
    <img src="${img(h.card)}" alt="${esc(h.name)}" loading="lazy"><span class="bar"></span>
    <span class="cap"><b>${esc(h.name)}</b><small>${esc(h.type_ru)} · ${esc(h.name_ru)}</small></span></a>`;
}

function filteredHeroes() {
  const q = ui.heroQuery.trim().toLowerCase();
  return heroes.filter((h) => (!ui.heroType || h.type === ui.heroType)
    && (!q || [h.name, h.name_ru, h.role, ...h.tags].join(' ').toLowerCase().includes(q)));
}

const HERO_COLUMNS = [
  ['name', 'Герой', (h) => h.name],
  ['type', 'Роль', (h) => h.type_ru],
  ['complexity', 'Сложн.', (h) => h.complexity],
  ['health', 'Здоровье', (h) => +h.stats.health],
  ['regen', 'Реген', (h) => +h.stats.regen],
  ['dps', 'Урон/с', (h) => +(h.weapon?.dps || 0)],
  ['bullet', 'Пуля', (h) => parseFloat(h.weapon?.bullet_damage || 0)],
  ['clip', 'Обойма', (h) => h.weapon?.clip || 0],
  ['move', 'Скорость', (h) => +h.stats.move],
  ['melee', 'Тяж. удар', (h) => +h.stats.heavy_melee],
];

function heroTableHtml(list) {
  const col = HERO_COLUMNS.find((c) => c[0] === ui.heroSort) || HERO_COLUMNS[0];
  const sorted = list.slice().sort((a, b) => {
    const x = col[2](a), y = col[2](b);
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * ui.heroSortDir;
  });
  return `<div class="table-wrap"><table class="htable"><thead><tr>${HERO_COLUMNS.map(([k, label]) =>
    `<th class="${k === ui.heroSort ? 'on' : ''}" onclick="sortHeroes('${k}')">${label}${k === ui.heroSort ? (ui.heroSortDir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr></thead>
    <tbody>${sorted.map((h) => `<tr>
      <td><a href="#/hero/${h.id}"><img src="${img(h.icon || h.card)}" alt="" loading="lazy">${esc(h.name)}</a></td>
      <td>${esc(h.type_ru)}</td><td>${complexity(h.complexity)}</td>
      <td>${h.stats.health}</td><td>${h.stats.regen}</td><td>${h.weapon?.dps ?? '—'}</td><td>${esc(h.weapon?.bullet_damage ?? '—')}</td>
      <td>${h.weapon?.clip ?? '—'}</td><td>${h.stats.move}</td><td>${h.stats.heavy_melee}</td></tr>`).join('')}</tbody></table></div>`;
}

function heroGridHtml() {
  const list = filteredHeroes();
  if (!list.length) return '<p class="muted">Никого не нашлось.</p>';
  return ui.heroView === 'table' ? heroTableHtml(list) : `<div class="hgrid">${list.map(heroCard).join('')}</div>`;
}

function leadersHtml() {
  const top = (title, f, unit) => `<div><span class="label">${title}</span><ol>${heroes.slice().sort((a, b) => f(b) - f(a)).slice(0, 5)
    .map((h) => `<li><a href="#/hero/${h.id}">${esc(h.name)}</a><span>${f(h)}${unit}</span></li>`).join('')}</ol></div>`;
  return `<div class="leaders">
    ${top('Больше всех здоровья', (h) => +h.stats.health, '')}
    ${top('Самый высокий урон/с', (h) => +(h.weapon?.dps || 0), '')}
    ${top('Самые быстрые', (h) => +h.stats.move, ' м/с')}
    ${top('Тяжёлый удар', (h) => +h.stats.heavy_melee, '')}
  </div>`;
}

function heroesPage() {
  if (!heroes.length) {
    return `<section class="section">${sectionHead('§', 'Герои')}
      <p>Данные героев ещё не собраны. На сервере сайта выполните <code>python web/lobby/build_heroes.py</code> — он возьмёт героев, портреты и умения из установленной игры.</p></section>`;
  }
  return `<section class="section">
    ${sectionHead('§', 'Герои', `${heroes.length} в пуле драфта · данные из файлов игры`)}
    <div class="filters">
      ${TYPES.map(([t, label]) => `<button class="chip-btn ${ui.heroType === t ? 'on' : ''}" onclick="setHeroType('${t}')">${label}</button>`).join('')}
      <span style="width:12px"></span>
      <button class="chip-btn ${ui.heroView === 'cards' ? 'on' : ''}" onclick="setHeroView('cards')">Карточки</button>
      <button class="chip-btn ${ui.heroView === 'table' ? 'on' : ''}" onclick="setHeroView('table')">Сравнить</button>
      <input class="input" id="heroSearch" placeholder="Поиск: имя, роль, тег" value="${esc(ui.heroQuery)}" oninput="searchHeroes(this.value)">
    </div>
    <div id="heroGrid">${heroGridHtml()}</div>
  </section>
  <section class="section">${sectionHead('§', 'В цифрах', 'базовые значения на 1 уровне')}${leadersHtml()}</section>`;
}

function heroPage(id) {
  const h = heroById[id];
  if (!h) return `<section class="section">${sectionHead('§', 'Герой не найден')}<p><a href="#/heroes">← ко всем героям</a></p></section>`;
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
      <p style="margin-top:12px"><a href="#/heroes" class="label">← все герои</a></p>
    </aside>
    <div>
      <div class="hero-head">
        <p class="kicker">${esc(h.type_ru)} · сложность ${complexity(h.complexity)}</p>
        <h1 class="display">${esc(h.name)}</h1>
        <p class="ru">${esc(h.name_ru)}</p>
        <div class="hero-meta">${h.tags.filter(Boolean).map((t) => `<span class="stamp">${esc(t)}</span>`).join('')}</div>
        ${h.role ? `<p class="tagline">${h.role}</p>` : ''}
      </div>
      <div class="stat-grid">
        ${stat(h.stats.health, 'Здоровье')}${stat(h.stats.regen, 'Реген здоровья', '/с')}
        ${stat(h.stats.move, 'Скорость', 'м/с')}${stat(h.stats.stamina, 'Выносливость')}
        ${stat(h.stats.light_melee, 'Лёгкий удар')}${stat(h.stats.heavy_melee, 'Тяжёлый удар')}
        ${w ? stat(w.dps, 'Урон оружия/с') + stat(w.clip, 'Патронов в обойме') : ''}
      </div>

      <section class="section">${sectionHead('§', 'Умения', 'значения на старте, без бонусов от предметов')}
        <div class="abilities">${h.abilities.map((a, k) => `
          <article class="ability">
            <div class="icon">${a.icon ? `<img src="${img(a.icon)}" alt="">` : ''}<span>${k + 1}</span></div>
            <div>
              <h3>${esc(a.name)}</h3>
              ${a.quip ? `<p class="quip">${a.quip}</p>` : ''}
              ${a.stats.length ? `<div class="chips">${a.stats.map((s) => `<span><b>${esc(s.label)}</b>${esc(s.value)}</span>`).join('')}</div>` : ''}
              <p class="desc">${a.desc}</p>
              ${a.upgrades.length ? `<ul class="upgrades">${a.upgrades.map((u) => `<li data-tier="Улучшение ${ROMAN[u.tier - 1] || u.tier}">${u.text}</li>`).join('')}</ul>` : ''}
            </div>
          </article>`).join('')}</div>
      </section>

      ${w ? `<section class="section">${sectionHead('§', 'Оружие')}
        <div class="stat-grid weapon-grid" style="margin-top:0">
          ${stat(w.dps, 'Урон в секунду')}${stat(w.bullet_damage, 'Урон пули')}${stat(w.fire_rate, 'Выстрелов', '/с')}
          ${stat(w.clip, 'Обойма')}${stat(w.reload, 'Перезарядка', 'с')}${stat(w.falloff, 'Спад урона', 'м')}
        </div></section>` : ''}

      ${config.models ? `<section class="section">${sectionHead('§', '3D-модель', 'из файлов игры')}
        <div class="model-box" id="modelBox" data-hero="${h.id}">
          <div><p class="muted" style="margin:0 0 14px">Модель грузится из игры: ~6 МБ, первый раз — несколько секунд.</p>
          <button class="btn" onclick="loadModel('${h.id}')">Показать модель</button></div>
        </div>
      </section>` : ''}

      ${h.playstyle ? `<section class="section">${sectionHead('§', 'Как играть')}<p class="rich">${h.playstyle}</p></section>` : ''}
      ${h.lore ? `<section class="section">${sectionHead('§', 'История')}<p class="rich">${h.lore}</p></section>` : ''}
    </div>
  </section>`;
}

// three.js viewer: the model turns slowly, drag to rotate, wheel to zoom
let viewer = null;
async function loadModel(id) {
  const box = $('modelBox');
  if (!box || box.dataset.loaded) return;
  box.dataset.loaded = '1';
  box.innerHTML = '<p class="label muted">Загрузка модели<span class="dots"></span></p>';
  try {
    const THREE = await import('three');
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
    const gltf = await new GLTFLoader().loadAsync(`${API}/models/${id}.glb`);
    if ($('modelBox') !== box) return;  // the user went elsewhere meanwhile
    viewer?.stop();
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xfff4e0, 0x2b2823, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(2, 3, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xc8321f, 1.6);
    rim.position.set(-3, 2, -3);
    scene.add(rim);
    const model = gltf.scene;
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    // models come Z-up from the game: stand them up when they lie
    if (size.z > size.y * 1.2) model.rotation.x = -Math.PI / 2;
    const bounds = new THREE.Box3().setFromObject(model);
    const center = bounds.getCenter(new THREE.Vector3());
    const dims = bounds.getSize(new THREE.Vector3());
    model.position.sub(center);
    const pivot = new THREE.Group();
    pivot.add(model);
    scene.add(pivot);
    const camera = new THREE.PerspectiveCamera(30, box.clientWidth / box.clientHeight, 0.01, 1000);
    const dist = dims.y / (2 * Math.tan(Math.PI * 30 / 360)) * 0.95;
    camera.position.set(0, dims.y * 0.05, dist);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    renderer.setSize(box.clientWidth, box.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    box.innerHTML = '<span class="hint-3d">тяните — повернуть · колесо — приблизить</span>';
    box.prepend(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = dist * 0.3;
    controls.maxDistance = dist * 2;
    let spin = true, running = true;
    controls.addEventListener('start', () => { spin = false; });
    const frame = () => {
      if (!running || !document.body.contains(renderer.domElement)) { renderer.dispose(); return; }
      if (spin) pivot.rotation.y += 0.004;
      controls.update();
      renderer.render(scene, camera);
      requestAnimationFrame(frame);
    };
    frame();
    viewer = { stop: () => { running = false; } };
  } catch (e) {
    box.dataset.loaded = '';
    box.innerHTML = `<div><p>Не удалось показать модель: ${esc(e.message)}</p><button class="btn" onclick="loadModel('${id}')">Ещё раз</button></div>`;
  }
}

// ---------- items ----------

function itemsPage() {
  if (!items) {
    loadItems();
    return `<section class="section">${sectionHead('§', 'Предметы')}<p class="muted">Загрузка…</p></section>`;
  }
  if (!items.length) {
    return `<section class="section">${sectionHead('§', 'Предметы')}<p>Данные ещё не собраны: <code>python web/lobby/build_heroes.py</code>.</p></section>`;
  }
  const list = items.filter((i) => i.slot === ui.itemSlot);
  const sel = items.find((i) => i.id === ui.item && i.slot === ui.itemSlot) || list[0];
  const tiers = [1, 2, 3, 4].map((t) => {
    const inTier = list.filter((i) => i.tier === t);
    return `<div class="tier-col"><h3>Тир ${ROMAN[t - 1]}<small>${inTier[0]?.cost ?? ''} душ</small></h3>
      ${inTier.map((i) => `<button class="item-tile ${i === sel ? 'on' : ''}" onclick="pickItem('${i.id}')">
        <img src="${img(i.icon)}" alt="" loading="lazy"><span>${esc(i.name)}${i.active ? '<span class="act">активный</span>' : ''}</span></button>`).join('')}</div>`;
  }).join('');
  return `<section class="section">
    ${sectionHead('§', 'Предметы', `${items.length} в магазине · данные из файлов игры`)}
    <div class="filters slot-tabs">${Object.entries(SLOT_NAMES).map(([s, label]) =>
      `<button class="chip-btn ${ui.itemSlot === s ? 'on' : ''}" data-slot="${s}" onclick="setItemSlot('${s}')">${label} · ${items.filter((i) => i.slot === s).length}</button>`).join('')}</div>
    <div class="items-wrap slot-${ui.itemSlot}">
      <div class="tiers">${tiers}</div>
      ${sel ? `<aside class="item-detail">
        <img src="${img(sel.icon)}" alt="">
        <h3>${esc(sel.name)}</h3>
        <span class="label muted">${SLOT_NAMES[sel.slot]} · тир ${ROMAN[sel.tier - 1]} · ${sel.cost} душ${sel.active ? ' · активный' : ''}${sel.cooldown ? ` · перезарядка ${sel.cooldown} с` : ''}</span>
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
  try { items = await (await fetch('/static/data/items.json')).json(); } catch { items = []; }
  render();
}

// ---------- reference pages ----------

function modesPage() {
  return `<section class="section">${sectionHead('§', 'Режимы', 'новые появятся здесь')}${modesHtml()}</section>
    <section class="section">${sectionHead('§', 'Драфт')}${stepsHtml()}</section>`;
}

function guidePage() {
  const counts = {};
  heroes.forEach((h) => { counts[h.type_ru] = (counts[h.type_ru] || 0) + 1; });
  const facts = [
    ['800 / 1600 / 3200 / 6400', 'душ стоят предметы I–IV тира'],
    [heroes.length || '—', `героев в пуле: ${Object.entries(counts).map(([t, n]) => `${t.toLowerCase()} — ${n}`).join(', ')}`],
    ['30', 'убийств нужно команде для победы в Overthrow'],
    ['3000', 'душ у каждого на старте Overthrow'],
    ['+30/с', 'душ всем живым, ещё +30/с — на дне ямы'],
    ['3 с + 1 с', 'за уровень — время респауна'],
  ];
  const items = [
    ['Как подключиться', 'В настройках Deadlock включите <b>Dev command console</b>, нажмите <code>F7</code> и вставьте команду <code>connect …</code>, которую сайт покажет после драфта.'],
    ['Через Steam или по IP', 'Команда вида <code>connect [A:1:…]</code> идёт через ретрансляцию Steam — проброс портов не нужен. <code>connect IP:порт</code> — напрямую, быстрее, но порт должен быть открыт.'],
    ['Играю с того же ПК, что и сервер', 'Используйте <code>connect localhost:порт</code>. Порт 27015 занят главным меню самой игры, поэтому серверы сайта стартуют с 27020.'],
    ['Полезные команды консоли', '<code>status</code> — кто на сервере и пинг; <code>disconnect</code> — выйти с сервера; <code>net_graph 1</code> — FPS и пинг на экране.'],
    ['Как работает драфт', `Сначала каждый предлагает героя на бан, из предложений случайно банятся ${config.bans}. Потом три раунда по два игрока от команды, выбор соперника скрыт до конца раунда. Если обе команды взяли одного героя, он уходит в бан, а эти двое выбирают заново за 15 секунд. Не успели — случайный герой.`],
    ['Сменить героя в игре', 'Нельзя: на сервере Overthrow герой фиксируется после драфта. Это честно по отношению к тем, кто выбирал вслепую.'],
    ['Overthrow за минуту', 'Бой в яме мид-босса. Первая команда до 30 убийств побеждает. Души капают всем, на дне ямы — вдвое быстрее, раз в минуту падает урна. Лидер по убийствам подсвечен и стоит +800 душ.'],
    ['Что купить первым', 'Души копятся быстро: старт 3000 — это сразу несколько предметов I тира или один II тира. Смотрите <a href="#/items">каталог предметов</a> по трём веткам: оружие, живучесть и дух.'],
    ['Роли героев', '<b>Стрелки</b> наносят урон с дистанции, <b>мистики</b> играют от умений и спиритической мощи, <b>дебоширы</b> держат удар и лезут в ближний бой, <b>ассасины</b> выбирают момент и добивают. Сравнить цифры — в <a href="#/heroes">таблице героев</a>.'],
    ['Тяжёлый удар и парирование', 'Ближний бой в яме решает: у каждого героя есть лёгкий и тяжёлый удар (значения — на странице героя), а тяжёлый удар соперника можно парировать.'],
  ];
  return `<section class="section">${sectionHead('§', 'Цифры, которые стоит знать')}
    <div class="facts">${facts.map(([b, s]) => `<div><b>${b}</b><span>${s}</span></div>`).join('')}</div></section>
    <section class="section">${sectionHead('§', 'Как играть')}
    <div class="guide">${items.map(([h, p]) => `<article><h4>${h}</h4><p>${p}</p></article>`).join('')}</div></section>`;
}

// ---------- chat ----------

function renderRail() {
  document.body.classList.add('with-rail');
  $('say').placeholder = me ? 'Написать…' : 'Войдите, чтобы писать';
  $('say').disabled = !me;
  const tabs = `<button class="${chat.channel === 'global' ? 'on' : ''}" onclick="switchChannel('global')">Общий</button>
    <button class="${chat.channel.startsWith('lobby:') ? 'on' : ''}" ${lobby ? '' : 'disabled'} onclick="switchChannel('lobby:${lobby?.id}')">Лобби</button>`;
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

function msgHtml(m) {
  const time = new Date(m.ts * 1000);
  const t = `<span class="t">${pad(time.getHours())}:${pad(time.getMinutes())}</span>`;
  if (!m.user) return `<li class="msg sys">${t}${esc(m.text)}</li>`;
  return `<li class="msg ${m.user.sid === me?.sid ? 'mine' : ''}">${t}<b>${esc(m.user.name)}</b>${esc(m.text)}</li>`;
}

function renderMsgs(full, fresh = []) {
  const box = $('msgs');
  const log = chat.logs[chat.channel];
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  if (full) {
    box.innerHTML = log?.msgs.length ? log.msgs.map(msgHtml).join('')
      : `<li class="none">${log ? 'Тишина. Напишите первым.' : 'Загрузка…'}</li>`;
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
    const first = !chat.logs[channel];
    chat.logs[channel] = log;
    // a message already shown (sent from this tab) is not added twice
    const known = new Set(log.msgs.map((m) => m.id));
    const add = fresh.filter((m) => !known.has(m.id));
    log.msgs.push(...add);
    if (fresh.length) log.since = fresh[fresh.length - 1].id;
    renderMsgs(first, add);
  } catch { /* lost access to a closed lobby's chat: the next refresh switches back */ } finally {
    chatBusy = false;
  }
}

async function sendChat(e) {
  e.preventDefault();
  const input = $('say');
  const text = input.value.trim();
  if (!text) return;
  if (!me) return showError('Чат доступен после входа');
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
const closeLobby = () => confirm('Закрыть лобби для всех?') && lobbyAct('close');

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
    button.textContent = 'Скопировано';
    setTimeout(() => { button.textContent = 'Копировать'; }, 1500);
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
    setTimeout(() => showError('Не удалось войти через Steam'), 0);
  }
  [config, heroes, ranks] = await Promise.all([
    api('/api/config'),
    fetch('/static/data/heroes.json').then((r) => (r.ok ? r.json() : [])).catch(() => []),
    fetch('/static/data/ranks.json').then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  ranks = Object.fromEntries(ranks.map((r) => [r.tier, r]));
  heroById = Object.fromEntries(heroes.map((h) => [h.id, h]));
  heroByName = Object.fromEntries(heroes.map((h) => [h.name, h]));
  featured = heroes.slice().sort(() => 0.5 - Math.random()).slice(0, 8);
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  await Promise.all([refresh(), refreshPulse()]);
  pollChat();
  setInterval(refresh, 1000);
  setInterval(refreshPulse, 3000);
  setInterval(pollChat, 1500);
  const frame = () => { tickClock(); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
})();
