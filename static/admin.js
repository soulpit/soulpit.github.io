// ЯМА / SOULPIT admin desk: a page of its own at /admin/, for the admins listed in admins.txt.
// Same API and sign-in as the site (the token is shared through localStorage). Hash routes: #dashboard, #analytics,
// #stats, #lobbies, #matches, #players, #chat, #settings, #log. Live sections poll; the rest load on demand.

const API = ((window.SOULPIT && window.SOULPIT.api) || '').replace(/\/$/, '');
const TOKEN_KEY = 'yama_token';

let token = null;
let me = null;               // the signed-in player (an admin, once checked)
let config = null;
let heroes = {};             // hero name -> {id, card, icon}, from the site's data
let rankNames = {};          // tier -> name
let lastHtml = '';
const cache = {};            // path -> {data, error, at, loading}
const ui = { days: 30, matchStatus: 'playing', query: '', heroSort: 'picks', chatChannel: '', logAction: '', player: null };
let draft = null;            // the settings form while it is being edited

const SECTIONS = [
  ['dashboard', 'Пульт', 'now'], ['analytics', 'Аналитика', 'data'], ['stats', 'Статистика', 'data'],
  ['lobbies', 'Лобби', 'manage'], ['matches', 'Матчи', 'manage'], ['players', 'Игроки', 'manage'],
  ['chat', 'Чат', 'manage'], ['settings', 'Настройки', 'site'], ['log', 'Журнал', 'site'],
];
const GROUPS = { now: 'Сейчас', data: 'Цифры', manage: 'Управление', site: 'Площадка' };
const LIVE = new Set(['dashboard', 'lobbies', 'matches', 'chat']);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const section = () => (location.hash.replace(/^#/, '').split('?')[0] || 'dashboard');
const fmtDate = (ts) => ts ? new Date(ts * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many}`;
};
const ago = (ts) => {
  if (!ts) return '—';
  const s = Date.now() / 1000 - ts;
  if (s < 60) return 'сейчас';
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `${Math.round(s / 3600)} ч назад`;
  return fmtDate(ts);
};
const STATE = { waiting: 'набор', bans: 'баны', picks: 'пики', launching: 'запуск', live: 'идёт матч', error: 'ошибка сервера' };
const STATE_TAG = { waiting: '', bans: 'amber', picks: 'amber', launching: 'amber', live: 'green', error: 'red' };
const STATUS = { playing: ['ждёт итога', 'amber'], finished: ['завершён', 'green'], cancelled: ['отменён', ''], unscored: ['без итога', ''] };
const TEAM = ['amber', 'sapphire'];

// ---------- api ----------

async function api(path, body) {
  const res = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Token': token || '', 'X-Lang': 'ru' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

// cached GET: returns what is there now, fetches again when older than maxAge and re-renders on arrival
function load(path, maxAge = 10000) {
  const c = cache[path];
  if (!c || (!c.loading && Date.now() - c.at > maxAge)) {
    cache[path] = { ...(c || { at: 0 }), loading: true };
    api(path)
      .then((data) => { cache[path] = { data, at: Date.now() }; render(); })
      .catch((e) => { cache[path] = { data: c?.data, error: e.message, at: Date.now() }; render(); });
  }
  return cache[path];
}
const adm = (path, maxAge) => load('/api/admin/' + path, maxAge);
const waiting = (...cs) => {
  const bad = cs.find((c) => !c?.data);
  if (!bad) return null;
  return `<p class="loading">${bad?.error ? esc(bad.error) : 'Загрузка…'}</p>`;
};
function forget(...prefixes) {
  for (const k of Object.keys(cache)) if (prefixes.some((p) => k.startsWith(p))) delete cache[k];
}

// an admin action: optional question first, then the call, a note, fresh data
async function act(path, body = {}, done = 'Готово') {
  try {
    const out = await api('/api/admin/' + path, body);
    toast(done);
    forget('/api/admin/', '/api/player/');
    render();
    if (ui.player) openPlayer(ui.player);
    return out;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

let toastTimer = null;
function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 5000 : 2200);
}

// ---------- dialog: a question with fields, resolves to the values or null ----------

function ask({ title, text = '', fields = [], ok = 'Подтвердить', danger = false }) {
  return new Promise((resolve) => {
    const box = $('dialog');
    const field = (f) => {
      if (f.type === 'pick') {
        return `<div class="field"><span class="label">${esc(f.label)}</span><div class="pick">${f.options.map(([v, label], i) => `
          <label><input type="radio" name="${f.name}" value="${esc(v)}" ${i === 0 ? 'checked' : ''}>${esc(label)}</label>`).join('')}</div></div>`;
      }
      const input = f.type === 'textarea'
        ? `<textarea class="input" name="${f.name}" rows="3" maxlength="${f.max || 300}">${esc(f.value || '')}</textarea>`
        : `<input class="input" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>`;
      return `<label class="field"><span class="label">${esc(f.label)}</span>${input}${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</label>`;
    };
    box.innerHTML = `<form class="dialog" id="dialogForm">
      <h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}
      ${fields.map(field).join('')}
      <div class="row"><button type="button" class="btn ghost" id="dialogCancel">Отмена</button>
        <button class="btn ${danger ? 'red' : ''}">${esc(ok)}</button></div>
    </form>`;
    box.hidden = false;
    const close = (value) => { box.hidden = true; box.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(value); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    $('dialogCancel').onclick = () => close(null);
    box.onclick = (e) => { if (e.target === box) close(null); };
    $('dialogForm').onsubmit = (e) => {
      e.preventDefault();
      close(Object.fromEntries(new FormData(e.target).entries()));
    };
    (box.querySelector('input:not([type=radio]), textarea') || box.querySelector('button.btn:not(.ghost)')).focus();
  });
}

// ---------- shared bits ----------

function avatar(p, cls = 'ava') {
  return p?.avatar ? `<img class="${cls}" src="${esc(p.avatar)}" alt="" loading="lazy">`
    : `<span class="${cls} letter">${esc((p?.name || '?')[0].toUpperCase())}</span>`;
}
const who = (p) => `<span class="who-cell">${avatar(p)}<b>${esc(p?.name || p?.sid || '—')}</b></span>`;
const playerLink = (p) => `<a href="#" onclick="openPlayer('${esc(p.sid)}'); return false">${esc(p.name || p.sid)}</a>`;
const rankName = (r) => (r?.tier ? `${rankNames[r.tier] || 'Ранг ' + r.tier} ${r.sub}` : rankNames[0] || 'Калибровка');
const heroImg = (name) => (heroes[name] ? `<img src="/static/data/img/${encodeURIComponent(heroes[name].icon || heroes[name].card)}" alt="" loading="lazy">` : '');
const tag = (text, cls = '') => `<span class="tag ${cls}">${esc(text)}</span>`;
const kpi = (value, label, opts = {}) => `<div class="kpi ${opts.hot ? 'hot' : ''}">${opts.href ? `<a href="${opts.href}">` : ''}
  <b>${value}${opts.unit ? `<small>${opts.unit}</small>` : ''}</b><span>${label}</span>${opts.href ? '</a>' : ''}</div>`;

// daily bars: values with dates under them; the last day in red
function bars(values, dates, { height = 140, title = '', fmt = (v) => v } = {}) {
  const max = Math.max(...values, 0);
  if (!max) return chartBox(title, values, `<div class="empty-chart" style="--h:${height}px">Пока нет данных</div>`);
  const cols = values.map((v, i) => `<i class="${v ? '' : 'zero'} ${i === values.length - 1 ? 'hi' : ''}" style="height:${Math.max(2, (v / max) * 100)}%"
    title="${dates ? fmtDay(dates[i]) + ': ' : ''}${fmt(v)}"></i>`).join('');
  const axis = dates ? `<div class="axis"><span>${fmtDay(dates[0])}</span>${dates.length > 8 ? `<span>${fmtDay(dates[Math.floor(dates.length / 2)])}</span>` : ''}<span>${fmtDay(dates[dates.length - 1])}</span></div>` : '';
  return chartBox(title, values, `<div class="chart"><div class="bars" style="--h:${height}px">${cols}</div></div>${axis}`, fmt);
}
function chartBox(title, values, body, fmt = (v) => v) {
  if (!title) return body;
  const sum = values.reduce((a, b) => a + b, 0);
  return `<div><div class="chart-head"><b>${esc(title)}</b><span>всего ${fmt(sum)} · пик ${fmt(Math.max(...values, 0))}</span></div>${body}</div>`;
}

// a line of [ts, value] points (online over time); a second dashed series is optional
function line(points, { height = 160, second = null } = {}) {
  if (points.length < 2) return `<div class="empty-chart" style="--h:${height}px">Замеры онлайна копятся раз в 5 минут — график появится скоро</div>`;
  const t0 = points[0][0], t1 = points[points.length - 1][0];
  const max = Math.max(1, ...points.map((p) => p[1]), ...(second || []).map((p) => p[1]));
  const xy = (pts) => pts.map(([t, v]) => `${(((t - t0) / (t1 - t0 || 1)) * 1000).toFixed(1)},${(100 - (v / max) * 100).toFixed(1)}`).join(' ');
  return `<div class="chart"><svg class="line" style="--h:${height}px" viewBox="0 0 1000 100" preserveAspectRatio="none">
      <polygon class="area" points="0,100 ${xy(points)} 1000,100"></polygon>
      <polyline class="stroke" points="${xy(points)}"></polyline>
      ${second ? `<polyline class="stroke ink" points="${xy(second)}"></polyline>` : ''}
    </svg></div>
    <div class="axis"><span>${fmtDate(t0)}</span><span>макс ${max}</span><span>${fmtDate(t1)}</span></div>`;
}

// ---------- frame ----------

function frame(body) {
  const sec = section();
  const ov = cache['/api/admin/overview']?.data;
  const counts = { matches: ov?.playing || 0, lobbies: ov ? Object.values(ov.lobbies).reduce((a, b) => a + b, 0) : 0 };
  let group = '';
  const nav = SECTIONS.map(([id, name, g]) => {
    const head = g !== group ? `<span class="group">${GROUPS[g]}</span>` : '';
    group = g;
    return `${head}<a href="#${id}" class="${sec === id ? 'on' : ''}">${name}${counts[id] ? `<span class="count">${counts[id]}</span>` : ''}</a>`;
  }).join('');
  return `<div class="desk">
    <aside class="side">
      <a class="brand" href="#dashboard"><b>ЯМ<i>А</i></b><span>пульт админа</span></a>
      <nav>${nav}</nav>
      <div class="who">${avatar(me)}<div><b>${esc(me.name)}</b><a href="/">На сайт</a><button onclick="logout()">Выйти</button></div></div>
    </aside>
    <main class="main">${body}</main>
  </div>`;
}

function head(title, text = '', tools = '') {
  return `<header class="head"><div><h1>${title}</h1>${text ? `<p>${text}</p>` : ''}</div>${tools ? `<div class="tools">${tools}</div>` : ''}</header>`;
}

function periodChips() {
  return `<div class="chips">${[[7, '7 дней'], [30, '30 дней'], [90, '90 дней']].map(([d, label]) =>
    `<button class="chip ${ui.days === d ? 'on' : ''}" onclick="ui.days = ${d}; render()">${label}</button>`).join('')}</div>`;
}

// ---------- dashboard ----------

function dashboard() {
  const ov = adm('overview', 8000), an = adm('analytics?days=14', 60000), pl = adm('matches?status=playing&limit=50', 8000),
    lb = adm('lobbies', 8000), st = adm('settings', 30000);
  const wait = waiting(ov, an, pl, lb, st);
  if (wait) return head('Пульт') + wait;
  const o = ov.data, a = an.data, s = st.data.settings;
  const lobbyStates = o.lobbies;
  const inDraft = (lobbyStates.bans || 0) + (lobbyStates.picks || 0) + (lobbyStates.launching || 0);
  const today = (k) => a.series[k][a.series[k].length - 1];

  // what needs a hand
  const alerts = [];
  const reported = pl.data.filter((m) => m.report);
  const stale = pl.data.filter((m) => !m.report && Date.now() / 1000 - m.ts > 2 * 3600);
  if (reported.length) alerts.push(['hot', `${plural(reported.length, 'матч ждёт', 'матча ждут', 'матчей ждут')} подтверждения итога — можно решить за игроков`, '#matches', 'К матчам']);
  if (stale.length) alerts.push(['', `${plural(stale.length, 'матч идёт', 'матча идут', 'матчей идут')} больше 2 часов без итога`, '#matches', 'Разобрать']);
  const broken = lb.data.filter((l) => l.state === 'error');
  if (broken.length) alerts.push(['hot', `${plural(broken.length, 'лобби', 'лобби', 'лобби')} с ошибкой сервера`, '#lobbies', 'Открыть']);
  if (s.lobbies_closed) alerts.push(['hot', 'Создание новых лобби закрыто', '#settings', 'Настройки']);
  if (s.chat_closed) alerts.push(['', 'Общий чат закрыт для игроков', '#settings', 'Настройки']);
  if (s.announcement) alerts.push(['calm', `Висит объявление: «${esc(s.announcement)}»`, '#settings', 'Изменить']);
  if (s.disabled_heroes.length) alerts.push(['', `Выключено из драфта: ${plural(s.disabled_heroes.length, 'герой', 'героя', 'героев')}`, '#settings', 'Изменить']);
  if (!alerts.length) alerts.push(['calm', 'Всё спокойно: ничего не ждёт решения', '', '']);

  const recent = (a.recent || []).map((r) => [r[0], r[1]]);
  const inLobbies = (a.recent || []).map((r) => [r[0], r[3]]);
  return head('Пульт', 'Что происходит на площадке прямо сейчас.',
    `<button class="btn ghost" onclick="broadcast()">Написать всем в чат</button>`)
    + `<div class="kpis">
        ${kpi(o.online, 'в сети сейчас')}
        ${kpi(lobbyStates.waiting || 0, 'лобби набирают игроков', { href: '#lobbies' })}
        ${kpi(inDraft, 'лобби на драфте', { href: '#lobbies' })}
        ${kpi(lobbyStates.live || 0, 'матчей идёт', { href: '#lobbies' })}
        ${kpi(o.playing, `ждут итога, из них сообщён — ${o.pending_reports}`, { href: '#matches', hot: o.pending_reports > 0 })}
      </div>
      <ul class="alerts">${alerts.map(([cls, text, href, btn]) => `<li class="${cls}"><span>${text}</span>${href ? `<a class="btn tiny ghost" href="${href}">${btn}</a>` : ''}</li>`).join('')}</ul>
      <div class="kpis">
        ${kpi(today('active'), 'игроков заходили сегодня')}
        ${kpi(today('new_players'), 'новых игроков сегодня')}
        ${kpi(today('lobbies'), 'лобби создано сегодня')}
        ${kpi(today('matches'), 'матчей сыграно сегодня')}
        ${kpi(o.players, `игроков всего · в бане ${o.banned}`, { href: '#players' })}
      </div>
      <div class="grid2">
        <section class="block"><h2>Онлайн за 2 суток <span class="label">замер раз в 5 минут</span></h2>
          ${line(recent, { second: inLobbies })}
          <div class="legend"><span><i></i>в сети</span><span><i class="ink"></i>сидят в лобби</span></div></section>
        <section class="block"><h2>Игроки по дням <span class="label">14 дней</span></h2>
          ${bars(a.series.active, a.dates, { height: 160 })}</section>
      </div>
      <section class="block"><h2>Последние действия админов</h2>${logTable(o.log)}</section>`;
}

async function broadcast() {
  const v = await ask({ title: 'Сообщение всем', text: 'Появится в общем чате сайта как сообщение от администрации.',
    fields: [{ name: 'text', label: 'Текст', type: 'textarea', max: 300 }], ok: 'Отправить' });
  if (v?.text?.trim()) act('broadcast', { text: v.text }, 'Отправлено в общий чат');
}

// ---------- analytics ----------

const SERIES = [
  ['active', 'Активные игроки', 'заходили на сайт за день'],
  ['new_players', 'Новые игроки', 'первый вход через Steam'],
  ['lobbies', 'Создано лобби', ''],
  ['drafts', 'Начато драфтов', ''],
  ['servers', 'Запущено матчей', ''],
  ['matches', 'Сыграно с итогом', ''],
  ['messages', 'Сообщения в чате', ''],
  ['peak_online', 'Пиковый онлайн', ''],
];
const FUNNEL = { lobbies: 'Создали лобби', drafts: 'Дошли до драфта', servers: 'Запустили матч', matches: 'Записан итог', ranked: 'Пошли в рейтинг' };

function analytics() {
  const an = adm(`analytics?days=${ui.days}`, 60000);
  const wait = waiting(an);
  if (wait) return head('Аналитика', '', periodChips()) + wait;
  const a = an.data, p = a.players, t = a.totals;
  const top = a.funnel[0][1] || 0;
  const maxHour = Math.max(1, ...a.hours.map((h) => h.avg));
  const sizes = a.match.sizes.map(([n, c]) => `${n / 2 % 1 ? n : `${n / 2}×${n / 2}`}: ${c}`).join(' · ') || '—';
  return head('Аналитика', `Как живёт площадка за ${plural(a.days, 'день', 'дня', 'дней')}: кто приходит, доходят ли до матча, когда играют.`, periodChips())
    + `<div class="kpis">
        ${kpi(p.active_1, 'активны сегодня')}
        ${kpi(p.active_7, 'за 7 дней')}
        ${kpi(p.active_30, 'за 30 дней')}
        ${kpi(t.new_players, 'новых за период')}
        ${kpi(`${pct(p.returning, p.total)}<small>%</small>`, `возвращаются (заходили больше одного дня): ${p.returning} из ${p.total}`)}
        ${kpi(t.peak_online, 'пиковый онлайн за период')}
      </div>
      <div class="grid2">${SERIES.map(([k, title]) => `<section class="block">${bars(a.series[k], a.dates, { title, height: 120 })}</section>`).join('')}</div>
      <div class="grid2">
        <section class="block"><h2>Воронка <span class="label">от лобби до рейтинга</span></h2>
          <div class="funnel">${a.funnel.map(([k, n]) => `<div><span>${FUNNEL[k]}</span><em style="width:${top ? Math.max(1, (n / top) * 100) : 0}%"></em>
            <b>${n}<small>${top ? pct(n, top) + '%' : ''}</small></b></div>`).join('')}</div>
          <p class="small muted">Сильное падение между лобби и драфтом — лобби не набираются; между запуском и итогом — игроки не сообщают результат.</p></section>
        <section class="block"><h2>Когда играют <span class="label">средний онлайн по часам</span></h2>
          <div class="hours">${a.hours.map((h, i) => `<i class="${h.avg ? '' : 'none'}" style="opacity:${h.avg ? 0.15 + 0.85 * (h.avg / maxHour) : 1}" title="${i}:00 — в среднем ${h.avg}, максимум ${h.max}"></i>`).join('')}</div>
          <div class="axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
          <p class="small muted">По времени сервера (этого ПК). Наведите на клетку — средний и максимальный онлайн в этот час.</p></section>
      </div>
      <section class="block"><h2>Матчи</h2><div class="kpis">
        ${kpi(t.servers, 'запущено')}
        ${kpi(t.matches, 'с итогом')}
        ${kpi(t.cancelled, 'отменено')}
        ${kpi(a.match.avg_minutes ?? '—', 'средняя длительность', { unit: a.match.avg_minutes ? 'мин' : '' })}
        ${kpi(a.match.longest_minutes ?? '—', 'самый долгий', { unit: a.match.longest_minutes ? 'мин' : '' })}
        ${kpi(a.logins, 'входов через Steam')}
      </div><p class="small muted">Составы (игроков в матче): ${esc(sizes)}</p></section>`;
}

// ---------- statistics ----------

function stats() {
  const an = adm(`analytics?days=${ui.days}`, 60000);
  const wait = waiting(an);
  if (wait) return head('Статистика', '', periodChips()) + wait;
  const a = an.data, p = a.players;
  const games = a.series.servers.reduce((x, y) => x + y, 0);
  const rows = a.heroes.map((h) => ({ ...h, rate: h.finished ? h.wins / h.finished : null, pickRate: games ? h.picks / games : 0, banRate: games ? h.bans / games : 0 }));
  const key = ui.heroSort;
  rows.sort((x, y) => ((y[key] ?? -1) - (x[key] ?? -1)) || x.hero.localeCompare(y.hero));
  const th = (k, label) => `<th class="sort r ${key === k ? 'on' : ''}" onclick="ui.heroSort = '${k}'; render()">${label}</th>`;
  const heroTable = rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Герой</th>${th('picks', 'Пики')}${th('pickRate', 'Пик-рейт')}
      ${th('rate', 'Винрейт')}${th('bans', 'Баны')}${th('banRate', 'Бан-рейт')}</tr></thead><tbody>
      ${rows.map((h) => `<tr><td><span class="hero-cell">${heroImg(h.hero)}${esc(h.hero)}</span></td>
        <td class="r">${h.picks}</td><td class="r">${Math.round(h.pickRate * 100)}%<span class="meter"><i style="width:${Math.min(100, h.pickRate * 100)}%"></i></span></td>
        <td class="r">${h.rate == null ? '—' : `${Math.round(h.rate * 100)}%`}<span class="meter red"><i style="width:${(h.rate || 0) * 100}%"></i></span> <span class="muted small">(${h.finished})</span></td>
        <td class="r">${h.bans}</td><td class="r">${Math.round(h.banRate * 100)}%</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">За период матчей с героями не было.</p>';
  const mmrVals = a.mmr.map(([, n]) => n), mmrLabels = a.mmr.map(([b]) => b);
  const tierMax = Math.max(1, ...a.tiers.map(([, n]) => n));
  return head('Статистика', `Герои и игроки за ${plural(a.days, 'день', 'дня', 'дней')}. Матчей с героями: ${games}.`, periodChips())
    + `<div class="kpis">
        ${kpi(p.total, 'игроков всего')}
        ${kpi(p.played, 'сыграли хотя бы матч')}
        ${kpi(p.calibrated, 'прошли калибровку')}
        ${kpi(p.returning, 'возвращались')}
        ${kpi(p.banned, 'в бане', { href: '#players', hot: p.banned > 0 })}
      </div>
      <section class="block"><h2>Герои <span class="label">нажмите на заголовок, чтобы отсортировать</span></h2>${heroTable}</section>
      <div class="grid2">
        <section class="block"><h2>Рейтинг игроков <span class="label">MMR, шаг 50</span></h2>
          ${mmrVals.length ? `<div class="chart"><div class="bars" style="--h:140px">${mmrVals.map((n, i) => `<i style="height:${(n / Math.max(...mmrVals)) * 100}%" title="${mmrLabels[i]}–${mmrLabels[i] + 49}: ${n}"></i>`).join('')}</div></div>
          <div class="axis"><span>${mmrLabels[0]}</span><span>${mmrLabels[mmrLabels.length - 1] + 49}</span></div>` : '<div class="empty-chart">Ещё никто не сыграл</div>'}</section>
        <section class="block"><h2>Ранги</h2>
          ${a.tiers.length ? `<div class="funnel">${a.tiers.map(([tier, n]) => `<div><span>${esc(rankNames[tier] || (tier ? 'Ранг ' + tier : 'Калибровка'))}</span>
            <em style="width:${(n / tierMax) * 100}%"></em><b>${n}</b></div>`).join('')}</div>` : '<div class="empty-chart">Ещё никто не сыграл</div>'}</section>
      </div>
      <div class="grid2">
        <section class="block"><h2>Больше всех играли <span class="label">за период</span></h2>${peopleTable(a.busiest, 'period_games', 'Матчей')}</section>
        <section class="block"><h2>Больше всех пишут <span class="label">за период</span></h2>${peopleTable(a.talkers, 'messages', 'Сообщений')}</section>
      </div>`;
}

function peopleTable(list, field, label) {
  if (!list.length) return '<p class="muted">Пока никого.</p>';
  return `<table class="tbl"><thead><tr><th>Игрок</th><th class="r">${label}</th><th class="r">MMR</th></tr></thead><tbody>
    ${list.map((p) => `<tr class="click" onclick="openPlayer('${esc(p.sid)}')"><td>${who(p)}</td><td class="r">${p[field]}</td><td class="r">${p.mmr ?? '—'}</td></tr>`).join('')}
  </tbody></table>`;
}

// ---------- lobbies ----------

function lobbies() {
  const lb = adm('lobbies', 4000);
  const wait = waiting(lb);
  if (wait) return head('Лобби') + wait;
  const list = lb.data;
  const body = list.length ? `<ol class="rows">${list.map((l) => {
    const names = (sid) => l.users[sid]?.name || sid;
    const kickable = ['waiting', 'live', 'error'].includes(l.state);
    const team = (t) => {
      const seats = l.teams[t].slots.filter(Boolean);
      return `<div><span class="label" style="color:var(--${TEAM[t]})">${esc(l.teams[t].name)} · ${seats.length}</span>
        ${seats.map((sid) => `<p>${avatar(l.users[sid])}${playerLink({ sid, name: names(sid) })}${l.ready?.includes?.(sid) ? tag('готов', 'green') : ''}
          ${l.picks[sid] ? `<span class="muted small">${esc(l.picks[sid])}</span>` : ''}
          ${kickable ? `<button class="x" title="Выгнать" onclick="kick('${l.id}', '${esc(sid)}', '${esc(names(sid))}')">×</button>` : ''}</p>`).join('') || '<p class="muted">пусто</p>'}</div>`;
    };
    return `<li><div class="top"><b>${esc(l.teams[0].name)}<i>vs</i>${esc(l.teams[1].name)}</b>
        ${tag(STATE[l.state] || l.state, STATE_TAG[l.state])} <span class="label">№${esc(l.id)} · владелец ${esc(names(l.owner))} · создано ${ago(l.created)}</span>
        <span class="acts">${l.state === 'live' || l.match ? `<button class="btn tiny ghost" onclick="location.hash = 'matches'">Матч</button>` : ''}
          <button class="btn tiny" onclick="closeLobby('${l.id}')">Закрыть</button></span></div>
      ${l.server?.address ? `<p class="note mono">connect ${esc(l.server.address)}</p>` : ''}
      ${l.banned?.length ? `<p class="note">Баны: ${l.banned.map(esc).join(', ')}</p>` : ''}
      <div class="teams">${team(0)}${team(1)}</div></li>`;
  }).join('')}</ol>` : '<p class="muted">Лобби сейчас нет.</p>';
  return head('Лобби', 'Все лобби на сайте: набор, драфт и идущие матчи. Обновляется само.') + body;
}

async function kick(lid, sid, name) {
  if (await ask({ title: 'Выгнать из лобби', text: `${esc(name)} освободит слот. Зайти обратно сможет.`, ok: 'Выгнать', danger: true }))
    act(`lobby/${lid}/kick`, { sid }, 'Игрок выгнан');
}

async function closeLobby(lid) {
  if (await ask({ title: 'Закрыть лобби', text: 'Лобби пропадёт у всех. Матч без итога будет отменён, рейтинг не изменится.', ok: 'Закрыть', danger: true }))
    act(`lobby/${lid}/close`, {}, 'Лобби закрыто');
}

// ---------- matches ----------

function matches() {
  const filters = [['playing', 'Ждут итога'], ['finished', 'Завершённые'], ['cancelled', 'Отменённые'], ['', 'Все']];
  const tools = `<div class="chips">${filters.map(([k, label]) => `<button class="chip ${ui.matchStatus === k ? 'on' : ''}" onclick="ui.matchStatus = '${k}'; render()">${label}</button>`).join('')}</div>`;
  const ms = adm(`matches?status=${ui.matchStatus}&limit=100`, ui.matchStatus === 'playing' ? 5000 : 20000);
  const wait = waiting(ms);
  const intro = 'Итоги матчей: решить за игроков, отменить, аннулировать с откатом рейтинга.';
  if (wait) return head('Матчи', intro, tools) + wait;
  if (!ms.data.length) return head('Матчи', intro, tools) + '<p class="muted">Матчей нет.</p>';
  return head('Матчи', intro, tools) + `<ol class="rows">${ms.data.map((m) => {
    const [label, cls] = STATUS[m.status] || [m.status, ''];
    const team = (t) => `<div><span class="label" style="color:var(--${TEAM[t]})">${esc(m.teams[t])}${m.winner === t ? ' · победа' : ''}</span>
      ${m.players.filter((p) => p.team === t).map((p) => `<p>${heroImg(p.hero) ? `<span class="hero-cell" style="font-size:0">${heroImg(p.hero)}</span>` : ''}
        ${playerLink(p)} <span class="muted small">${esc(p.hero || '')}${p.delta != null ? ` · ${p.delta > 0 ? '+' : ''}${p.delta}` : ''}</span></p>`).join('') || '<p class="muted">—</p>'}</div>`;
    let acts = '';
    if (m.status === 'playing') {
      acts = `<button class="btn tiny red" onclick="decide('${m.id}')">Назначить итог</button>
        <button class="btn tiny ghost" onclick="annul('${m.id}', false)">Отменить</button>`;
    } else if (m.status === 'finished') {
      acts = `<button class="btn tiny ghost" onclick="annul('${m.id}', ${!!m.ranked})">Аннулировать</button>`;
    }
    const report = m.report ? `<p class="note">${tag('сообщён итог', 'amber')} победа ${esc(m.teams[m.report.winner])}${m.report.score ? ` ${m.report.score[0]}:${m.report.score[1]}` : ''} · споров ${m.report.disputes || 0}</p>` : '';
    return `<li><div class="top"><b>${esc(m.teams[0])}<i>${m.score ? `${m.score[0]}:${m.score[1]}` : 'vs'}</i>${esc(m.teams[1])}</b>
        ${tag(label, cls)} ${m.ranked ? tag('рейтинг') : ''} ${m.source === 'admin' ? tag('решил админ', 'red') : ''}
        <span class="label">${fmtDate(m.ts)} · №${esc(m.id)}${m.status === 'playing' ? ` · идёт ${ago(m.ts).replace(' назад', '')}` : ''}</span>
        <span class="acts">${acts}</span></div>
      ${report}<div class="teams">${team(0)}${team(1)}</div></li>`;
  }).join('')}</ol>`;
}

async function decide(id) {
  const m = (cache[`/api/admin/matches?status=${ui.matchStatus}&limit=100`]?.data || []).find((x) => x.id === id);
  if (!m) return;
  const v = await ask({
    title: 'Итог матча', text: 'Рейтинг пересчитается как после обычного итога.',
    fields: [{ name: 'winner', label: 'Победитель', type: 'pick', options: [[0, m.teams[0]], [1, m.teams[1]]] },
      { name: 'score', label: 'Счёт по убийствам', placeholder: '30:22', hint: 'Можно оставить пустым' }],
    ok: 'Записать итог',
  });
  if (!v) return;
  const s = (v.score || '').match(/^\s*(\d+)\s*[:\-–]\s*(\d+)\s*$/);
  act(`match/${id}/result`, s ? { winner: +v.winner, score: [+s[1], +s[2]] } : { winner: +v.winner }, 'Итог записан');
}

async function annul(id, ranked) {
  const ok = await ask({
    title: ranked ? 'Аннулировать матч' : 'Отменить матч',
    text: ranked ? 'Изменения рейтинга, матчи и победы игроков откатятся.' : 'Матч станет отменённым, рейтинг не изменится.',
    ok: ranked ? 'Аннулировать' : 'Отменить матч', danger: true,
  });
  if (ok) act(`match/${id}/annul`, {}, 'Матч отменён');
}

// ---------- players ----------

function players() {
  const pl = adm(`players?q=${encodeURIComponent(ui.query)}`, 15000);
  const search = `<form class="search" onsubmit="ui.query = this.q.value.trim(); render(); return false">
    <input class="input" name="q" placeholder="Ник или SteamID" value="${esc(ui.query)}"><button class="btn">Найти</button></form>`;
  const wait = waiting(pl);
  const intro = 'Нажмите на игрока: карточка с историей, чатом и действиями.';
  if (wait) return head('Игроки', intro) + search + wait;
  const rows = pl.data;
  return head('Игроки', intro) + search + (rows.length ? `<div class="table-wrap" style="margin-top:14px"><table class="tbl"><thead><tr>
      <th>Игрок</th><th>SteamID</th><th class="r">MMR</th><th class="r">Матчи</th><th>Статус</th><th>Пришёл</th><th>Был</th></tr></thead><tbody>
      ${rows.map((p) => `<tr class="click ${p.banned ? 'bad' : ''}" onclick="openPlayer('${esc(p.sid)}')"><td>${who(p)}</td><td class="mono">${esc(p.sid)}</td>
        <td class="r">${p.mmr}</td><td class="r">${p.games}</td>
        <td>${[p.admin && tag('админ', 'red'), p.banned && tag('бан', 'solid'), p.muted_until && tag('мут до ' + fmtTime(p.muted_until), 'amber'),
          p.lobby && tag('в лобби', 'green')].filter(Boolean).join(' ') || '<span class="muted">—</span>'}</td>
        <td class="small">${fmtDate(p.created)}</td><td class="small">${ago(p.last_seen)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">Никого не нашлось.</p>');
}

async function openPlayer(sid) {
  ui.player = sid;
  let wrap = $('drawer');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'drawer-wrap';
    wrap.id = 'drawer';
    wrap.onclick = (e) => { if (e.target === wrap) closePlayer(); };
    document.body.appendChild(wrap);
  }
  if (!wrap.innerHTML) wrap.innerHTML = '<aside class="drawer"><p class="loading">Загрузка…</p></aside>';
  let p;
  try { p = await api('/api/admin/player/' + sid); } catch (e) { wrap.innerHTML = `<aside class="drawer"><button class="close" onclick="closePlayer()">Закрыть ×</button><p>${esc(e.message)}</p></aside>`; return; }
  if (ui.player !== sid) return;
  const muted = p.muted_until > Date.now() / 1000;
  const acts = p.admin ? '<p class="muted small">Это админ: бан, мут и сброс к нему не применяются.</p>' : [
    p.banned ? `<button class="btn ghost" onclick="act('player/${sid}/unban', {}, 'Бан снят')">Снять бан</button>` : `<button class="btn red" onclick="banPlayer('${sid}')">Забанить</button>`,
    muted ? `<button class="btn ghost" onclick="act('player/${sid}/unmute', {}, 'Мут снят')">Снять мут</button>` : `<button class="btn ghost" onclick="mutePlayer('${sid}')">Закрыть чат</button>`,
    `<button class="btn ghost" onclick="resetPlayer('${sid}')">Сбросить рейтинг</button>`,
  ].join('');
  const matchesList = p.matches.length ? `<ul class="mini">${p.matches.map((m) => {
    const mine = m.players.find((x) => x.sid === sid);
    const res = m.status !== 'finished' ? (STATUS[m.status] || [m.status])[0] : m.winner === mine?.team ? 'победа' : 'поражение';
    return `<li><span class="t">${fmtDate(m.ts)}</span><span>${esc(m.teams[0])} ${m.score ? m.score.join(':') : 'vs'} ${esc(m.teams[1])} · ${esc(mine?.hero || '—')}</span><b>${res}${mine?.delta != null ? ` ${mine.delta > 0 ? '+' : ''}${mine.delta}` : ''}</b></li>`;
  }).join('')}</ul>` : '<p class="muted small">Матчей нет.</p>';
  const chatList = p.chat.length ? `<ul class="mini">${p.chat.map((c) => `<li><span class="t">${fmtDate(c.ts)}</span><span>${c.channel === 'global' ? '' : '<span class="muted">[лобби]</span> '}${esc(c.text)}</span>
      <button class="btn tiny ghost" onclick="deleteMessage(${c.id})">Удалить</button></li>`).join('')}</ul>` : '<p class="muted small">Не писал в чат.</p>';
  const actionsList = p.actions.length ? `<ul class="mini">${p.actions.map((a) => `<li><span class="t">${fmtDate(a.ts)}</span><span>${esc(ACTIONS[a.action] || a.action)} ${a.details ? `<span class="muted">· ${esc(details(a.details))}</span>` : ''}</span><span class="muted">${esc(a.admin)}</span></li>`).join('')}</ul>` : '<p class="muted small">Админы с ним ничего не делали.</p>';
  wrap.innerHTML = `<aside class="drawer">
    <button class="close" onclick="closePlayer()">Закрыть ×</button>
    <div class="pcard">${avatar(p)}<div><h3>${esc(p.name)}</h3>
      <p>${p.admin ? tag('админ', 'red') : ''}${p.banned ? tag('бан' + (p.ban_reason ? ': ' + p.ban_reason : ''), 'solid') : ''}${muted ? tag('мут до ' + fmtTime(p.muted_until), 'amber') : ''}${p.lobby ? tag('в лобби', 'green') : ''}
        <a class="mono" href="https://steamcommunity.com/profiles/${esc(sid)}" target="_blank" rel="noopener">${esc(sid)} ↗</a></p></div></div>
    <div class="facts">
      <div><b>${p.mmr}</b><span>MMR · ${esc(rankName(p.rank))}</span></div>
      <div><b>${p.games}</b><span>матчей, побед ${p.wins}</span></div>
      <div><b>${p.place ?? '—'}</b><span>место в таблице</span></div>
      <div><b>${p.active_days}</b><span>дней на сайте</span></div>
      <div><b>${p.logins}</b><span>входов через Steam</span></div>
      <div><b>${p.lobbies_created}</b><span>создал лобби</span></div>
      <div><b>${p.messages}</b><span>сообщений</span></div>
      <div><b class="small">${ago(p.last_seen)}</b><span>был · пришёл ${fmtDate(p.created)}</span></div>
    </div>
    <div class="acts">${acts}</div>
    <h4>Матчи</h4>${matchesList}
    <h4>Сообщения</h4>${chatList}
    <h4>Действия админов</h4>${actionsList}
  </aside>`;
}

function closePlayer() {
  ui.player = null;
  $('drawer')?.remove();
}

async function banPlayer(sid) {
  const v = await ask({ title: 'Бан', text: 'Игрок сможет только смотреть сайт. Из лобби в наборе его выкинет.',
    fields: [{ name: 'reason', label: 'Причина (игрок её увидит)', placeholder: 'например, читы' }], ok: 'Забанить', danger: true });
  if (v) act(`player/${sid}/ban`, { reason: v.reason }, 'Игрок забанен');
}

async function mutePlayer(sid) {
  const v = await ask({ title: 'Закрыть чат', fields: [{ name: 'minutes', label: 'На сколько минут', type: 'number', value: 60, hint: '60 — час, 1440 — сутки, 10080 — неделя' }], ok: 'Закрыть чат' });
  if (v && +v.minutes > 0) act(`player/${sid}/mute`, { minutes: +v.minutes }, 'Чат закрыт');
}

async function resetPlayer(sid) {
  if (await ask({ title: 'Сбросить рейтинг', text: 'MMR станет 1000, матчи и победы обнулятся. История матчей останется.', ok: 'Сбросить', danger: true }))
    act(`player/${sid}/reset`, {}, 'Рейтинг сброшен');
}

// ---------- chat ----------

function chat() {
  const tools = `<div class="chips">${[['', 'Все'], ['global', 'Общий']].map(([k, label]) => `<button class="chip ${ui.chatChannel === k ? 'on' : ''}" onclick="ui.chatChannel = '${k}'; render()">${label}</button>`).join('')}</div>
    <button class="btn" onclick="broadcast()">Написать всем</button>`;
  const ch = adm(`chat?limit=200${ui.chatChannel ? '&channel=' + ui.chatChannel : ''}`, 4000);
  const wait = waiting(ch);
  const intro = 'Сообщения игроков во всех каналах, новые сверху. Удалить, закрыть чат автору.';
  if (wait) return head('Чат', intro, tools) + wait;
  if (!ch.data.length) return head('Чат', intro, tools) + '<p class="muted">Сообщений нет.</p>';
  return head('Чат', intro, tools) + `<ol class="chatlog">${ch.data.map((m) => {
    let text = m.text;
    if (!m.user) { try { const j = JSON.parse(m.text); text = j.k === 'admin' ? 'Администрация: ' + j.text : '[' + j.k + ']'; } catch { /* plain */ } }
    return `<li class="${m.user ? '' : 'sys'}"><span class="t">${fmtDate(m.ts)}<br>${m.channel === 'global' ? 'общий' : 'лобби'}</span>
      <span>${m.user ? playerLink(m.user) : 'система'}</span><span class="txt">${esc(text)}</span>
      <span class="acts" style="display:flex;gap:4px">${m.user && !m.user.admin ? `<button class="btn tiny ghost" onclick="mutePlayer('${esc(m.user.sid)}')">Мут</button>` : ''}
        <button class="btn tiny" onclick="deleteMessage(${m.id})">Удалить</button></span></li>`;
  }).join('')}</ol>`;
}

function deleteMessage(id) { act(`message/${id}/delete`, {}, 'Сообщение удалено'); }

// ---------- settings: the basic changes, applied at once ----------

const NUMBERS = {
  draft: [['ban_seconds', 'Фаза банов, секунд'], ['pick_seconds', 'Раунд пиков, секунд'], ['repick_seconds', 'Перепик при совпадении, секунд'], ['bans', 'Сколько героев банится']],
  rules: [['report_minutes', 'Итог без спора принимается через, минут'], ['max_disputes', 'Споров до отмены матча'], ['min_team', 'Минимум игроков в команде для рейтинга'], ['calibration', 'Калибровочных матчей']],
};

function settings() {
  const st = adm('settings', 600000);
  const wait = waiting(st);
  if (wait) return head('Настройки') + wait;
  if (!draft) draft = fromSettings(st.data.settings);
  const d = draft, s = st.data;
  const def = (k) => (k === 'report_minutes' ? Math.round(s.defaults.report_seconds / 60) : s.defaults[k]);
  const lim = (k) => (k === 'report_minutes' ? [1, 1440] : s.limits[k]);
  const num = ([k, label]) => `<label class="field"><span class="label">${label}</span>
    <input class="input" type="number" min="${lim(k)[0]}" max="${lim(k)[1]}" value="${d[k]}" oninput="setDraft('${k}', +this.value)">
    <small>по умолчанию ${def(k)} · от ${lim(k)[0]} до ${lim(k)[1]}</small></label>`;
  const sw = (k, label, hint) => `<label class="switch"><input type="checkbox" ${d[k] ? 'checked' : ''} onchange="setDraft('${k}', this.checked)">
    <span>${label}${hint ? `<small>${hint}</small>` : ''}</span></label>`;
  const save = (keys, label = 'Сохранить') => {
    const changed = keys.some((k) => JSON.stringify(d[k]) !== JSON.stringify(fromSettings(s.settings)[k]));
    return `<div class="save-row"><button class="btn red" onclick="saveSettings(${esc(JSON.stringify(keys))})" ${changed ? '' : 'disabled'}>${label}</button>
      ${changed ? '<span class="label">есть несохранённые изменения</span>' : ''}</div>`;
  };
  const pool = s.heroes.map((name) => {
    const h = heroes[name];
    const off = d.disabled_heroes.includes(name);
    return `<button type="button" class="${off ? 'off' : ''}" onclick="toggleHero('${esc(name)}')" title="${off ? 'Включить' : 'Выключить'}">
      ${h ? `<img src="/static/data/img/${encodeURIComponent(h.card)}" alt="" loading="lazy">` : '<img alt="">'}<span>${esc(name)}</span></button>`;
  }).join('');
  const modeRows = s.modes.map((m) => {
    const o = d.modes[m.id] || {};
    const val = (f) => (o[f] ?? m[f] ?? '');
    return `<div class="mode-row"><b>${esc(m.name)}</b>
      <label class="switch" style="padding:8px"><input type="checkbox" ${val('available') ? 'checked' : ''} onchange="setMode('${m.id}', 'available', this.checked)"><span>открыт</span></label>
      <label class="field"><span class="label">в команде</span><input class="input" type="number" min="1" max="6" value="${val('team_size')}" oninput="setMode('${m.id}', 'team_size', +this.value)"></label>
      <label class="field"><span class="label">описание</span><input class="input" value="${esc(val('tagline'))}" oninput="setMode('${m.id}', 'tagline', this.value)"></label>
      <label class="field"><span class="label">описание (EN)</span><input class="input" value="${esc(val('tagline_en'))}" oninput="setMode('${m.id}', 'tagline_en', this.value)"></label></div>`;
  }).join('');
  return head('Настройки', 'Базовые изменения площадки. Сохранённое начинает действовать сразу, без перезапуска; игроки увидят его, обновив страницу. Каждое изменение пишется в журнал.')
    + `<div class="form">
      <fieldset class="fieldset"><legend>Объявление</legend><p>Полоса наверху каждой страницы сайта. Пусто — скрыто.</p>
        <div class="fields"><label class="field wide"><span class="label">Текст</span><textarea class="input" maxlength="300" oninput="setDraft('announcement', this.value, true)">${esc(d.announcement)}</textarea></label>
          <label class="field"><span class="label">Вид</span><select class="input" onchange="setDraft('announcement_kind', this.value)">
            <option value="info" ${d.announcement_kind === 'info' ? 'selected' : ''}>обычное (чёрное)</option>
            <option value="warn" ${d.announcement_kind === 'warn' ? 'selected' : ''}>важное (красное)</option></select></label></div>
        ${save(['announcement', 'announcement_kind'])}</fieldset>

      <fieldset class="fieldset"><legend>Площадка и чат</legend><p>Аварийные выключатели и правила общего чата.</p>
        <div class="fields">
          ${sw('lobbies_closed', 'Закрыть создание лобби', 'идущие лобби и матчи не трогаются')}
          ${sw('chat_closed', 'Закрыть общий чат', 'писать смогут только админы; чат лобби работает')}
          <label class="field"><span class="label">Медленный режим, секунд между сообщениями</span>
            <input class="input" type="number" min="0" max="60" step="0.5" value="${d.chat_slow}" oninput="setDraft('chat_slow', +this.value)"><small>меньше 0.7 не бывает</small></label>
          <label class="field wide"><span class="label">Запрещённые слова — через запятую</span>
            <textarea class="input" rows="2" oninput="setDraft('banned_words', this.value, true)">${esc(Array.isArray(d.banned_words) ? d.banned_words.join(', ') : d.banned_words)}</textarea>
            <small>в сообщениях заменяются звёздочками, регистр не важен</small></label>
        </div>${save(['lobbies_closed', 'chat_closed', 'chat_slow', 'banned_words'])}</fieldset>

      <fieldset class="fieldset"><legend>Драфт</legend><p>Действует с драфтов, которые начнутся после сохранения.</p>
        <div class="fields">${NUMBERS.draft.map(num).join('')}</div>${save(NUMBERS.draft.map((x) => x[0]))}</fieldset>

      <fieldset class="fieldset"><legend>Итоги и рейтинг</legend><p>Как принимаются результаты и кто попадает в рейтинг.</p>
        <div class="fields">${NUMBERS.rules.map(num).join('')}</div>${save(NUMBERS.rules.map((x) => x[0]))}</fieldset>

      <fieldset class="fieldset"><legend>Герои в драфте</legend><p>Нажмите на героя, чтобы убрать его из драфта (например, сломан после патча). Выключено: ${d.disabled_heroes.length} из ${s.heroes.length}.</p>
        <div class="pool">${pool}</div>${save(['disabled_heroes'])}</fieldset>

      <fieldset class="fieldset"><legend>Режимы</legend><p>Какие режимы открыты для новых лобби, сколько игроков в команде и описание на сайте.</p>
        ${modeRows}${save(['modes'])}</fieldset>
    </div>`;
}

function fromSettings(s) {
  return { ...JSON.parse(JSON.stringify(s)), report_minutes: Math.round(s.report_seconds / 60), banned_words: s.banned_words.join(', ') };
}

// quiet: typing in a text box keeps its focus, so only the save buttons are redrawn by the next full render
function setDraft(k, v, quiet = false) {
  draft[k] = v;
  if (!quiet) render(true); else refreshSaveRows();
}
function refreshSaveRows() {
  clearTimeout(refreshSaveRows.t);
  refreshSaveRows.t = setTimeout(() => render(true), 400);
}
function toggleHero(name) {
  draft.disabled_heroes = draft.disabled_heroes.includes(name) ? draft.disabled_heroes.filter((h) => h !== name) : [...draft.disabled_heroes, name];
  render(true);
}
function setMode(id, field, value) {
  draft.modes = { ...draft.modes, [id]: { ...(draft.modes[id] || {}), [field]: value } };
  if (field === 'available') render(true); else refreshSaveRows();
}

async function saveSettings(keys) {
  const body = {};
  for (const k of keys) {
    if (k === 'report_minutes') body.report_seconds = Math.round(draft.report_minutes * 60);
    else body[k] = draft[k];
  }
  try {
    const saved = await api('/api/admin/settings', body);
    cache['/api/admin/settings'].data.settings = saved;
    const fresh = fromSettings(saved);
    for (const k of keys) draft[k] = fresh[k];
    forget('/api/admin/overview', '/api/admin/log');
    toast('Сохранено, уже действует');
    render(true);
  } catch (e) { toast(e.message, true); }
}

// ---------- log ----------

const ACTIONS = {
  ban: 'бан', unban: 'снят бан', mute: 'закрыт чат', unmute: 'снят мут', reset_rating: 'сброс рейтинга', set_result: 'итог матча',
  annul: 'матч отменён', close_lobby: 'лобби закрыто', kick: 'выгнан из лобби', delete_message: 'удалено сообщение',
  settings: 'настройки', broadcast: 'сообщение всем',
};
const DETAIL_NAMES = {
  reason: 'причина', minutes: 'минут', winner: 'победа', score: 'счёт', teams: 'команды', lobby: 'лобби', text: 'текст', was: 'было',
  channel: 'канал', mmr: 'MMR', games: 'матчей', wins: 'побед', announcement: 'объявление', announcement_kind: 'вид объявления',
  lobbies_closed: 'лобби закрыты', chat_closed: 'чат закрыт', chat_slow: 'медленный режим', banned_words: 'запрещённые слова',
  ban_seconds: 'баны, с', pick_seconds: 'пики, с', repick_seconds: 'перепик, с', bans: 'банов', report_seconds: 'итог через, с',
  max_disputes: 'споров', min_team: 'мин. команда', calibration: 'калибровка', disabled_heroes: 'выключенные герои', modes: 'режимы',
};
function details(d) {
  const show = (k, v) => k === 'winner' && typeof v === 'number' ? `команда ${v + 1}`
    : Array.isArray(v) ? (v.length ? v.join(v.every((x) => typeof x === 'number') ? ':' : ', ') : 'нет')
    : v && typeof v === 'object' ? Object.entries(v).map(([a, b]) => `${DETAIL_NAMES[a] || a} ${show(a, b)}`).join(', ')
    : v === true ? 'да' : v === false ? 'нет' : v === '' ? 'пусто' : v ?? '—';
  return Object.entries(d).map(([k, v]) => `${DETAIL_NAMES[k] || k}: ${show(k, v)}`).join(' · ');
}

function logTable(rows) {
  if (!rows.length) return '<p class="muted">Пока пусто.</p>';
  return `<div class="table-wrap"><table class="tbl"><thead><tr><th>Когда</th><th>Админ</th><th>Действие</th><th>Кому / что</th><th>Подробности</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="small">${fmtDate(r.ts)}</td><td>${esc(r.admin)}</td><td>${esc(ACTIONS[r.action] || r.action)}</td>
      <td>${r.target_name ? playerLink({ sid: r.target, name: r.target_name }) : `<span class="mono">${esc(r.target)}</span>`}</td>
      <td class="small muted">${r.details ? esc(details(r.details)) : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

function log() {
  const lg = adm('log', 15000);
  const wait = waiting(lg);
  if (wait) return head('Журнал') + wait;
  const kinds = [...new Set(lg.data.map((r) => r.action))];
  const tools = `<select class="input" style="width:auto" onchange="ui.logAction = this.value; render()"><option value="">все действия</option>
    ${kinds.map((k) => `<option value="${k}" ${ui.logAction === k ? 'selected' : ''}>${esc(ACTIONS[k] || k)}</option>`).join('')}</select>`;
  return head('Журнал', 'Кто из админов что и когда сделал. Последние 200 действий.', tools)
    + logTable(lg.data.filter((r) => !ui.logAction || r.action === ui.logAction));
}

// ---------- sign-in ----------

function gate(text = '') {
  return `<div class="gate"><div>
    <b class="logo">ЯМ<i>А</i></b>
    <h1>Пульт админа</h1>
    <p>${text || 'Вход через Steam. Пускает только тех, кто есть в списке админов (admins.txt).'}</p>
    <a class="btn" href="${API}/auth/steam?after=admin">Войти через Steam</a>
    ${config?.dev_login ? `<form class="dev" onsubmit="devLogin(event)"><input class="input" name="name" placeholder="тестовый вход: имя"><button class="btn">Войти</button></form>` : ''}
    <br><a class="back" href="/">← на сайт</a>
  </div></div>`;
}

async function devLogin(e) {
  e.preventDefault();
  const { token: t } = await api('/api/dev_login', { name: e.target.name.value.trim() });
  setToken(t);
  start();
}

function setToken(t) {
  token = t;
  try {
    if (t) { localStorage.setItem(TOKEN_KEY, t); sessionStorage.setItem(TOKEN_KEY, t); }
    else { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); }
  } catch { /* private mode */ }
}

async function logout() {
  try { await api('/api/logout', {}); } catch { /* gone anyway */ }
  setToken(null);
  me = null;
  start();
}

// ---------- run ----------

function render(force = false) {
  if (!me) return;
  const sec = section();
  const view = { dashboard, analytics, stats, lobbies, matches, players, chat, settings, log }[sec] || dashboard;
  const html = frame(view());
  if (!force && html === lastHtml) return;
  // keep the focused text box and its caret when the page is drawn again
  const el = document.activeElement;
  const path = el && el !== document.body && $('app').contains(el) ? domPath(el) : null;
  const caret = path && 'selectionStart' in el ? [el.selectionStart, el.selectionEnd] : null;
  $('app').innerHTML = html;
  lastHtml = html;
  if (path) {
    const again = fromPath(path);
    if (again) {
      again.focus();
      if (caret) try { again.setSelectionRange(...caret); } catch { /* number inputs */ }
    }
  }
}
function domPath(el) {
  const path = [];
  while (el && el.id !== 'app') { path.unshift([...el.parentNode.children].indexOf(el)); el = el.parentNode; }
  return path;
}
function fromPath(path) {
  let el = $('app');
  for (const i of path) { el = el?.children[i]; }
  return el;
}

async function start() {
  // a token from the Steam sign-in comes in the address
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (hash.get('token')) {
    setToken(hash.get('token'));
    history.replaceState(null, '', location.pathname + '#dashboard');
  }
  if (hash.get('error')) history.replaceState(null, '', location.pathname);
  try { token = token || sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY); } catch { /* private mode */ }
  try { config = config || await api('/api/config'); } catch { $('app').innerHTML = gate('Сервер сайта недоступен. Проверьте, что он запущен.'); return; }
  if (!token) { $('app').innerHTML = gate(); return; }
  try {
    const mine = await api('/api/me');
    if (!mine.user.admin) { $('app').innerHTML = gate(`Вы вошли как ${esc(mine.user.name)}, но этого аккаунта нет в списке админов.`); return; }
    me = mine.user;
  } catch (e) {
    if (e.status === 401) setToken(null);
    $('app').innerHTML = gate(e.status === 401 ? 'Сессия закончилась, войдите снова.' : esc(e.message));
    return;
  }
  const [list, ranks] = await Promise.all([
    fetch('/static/data/heroes.json').then((r) => (r.ok ? r.json() : [])).catch(() => []),
    fetch('/static/data/ranks.json').then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  heroes = Object.fromEntries(list.map((h) => [h.name, h]));
  rankNames = Object.fromEntries(ranks.map((r) => [r.tier, r.name]));
  if (!location.hash) history.replaceState(null, '', '#dashboard');
  render(true);
}

window.addEventListener('hashchange', () => { closePlayer(); window.scrollTo(0, 0); render(true); });
// live sections refresh themselves; the overview also feeds the counters in the menu
setInterval(() => {
  if (!me || document.hidden || !$('dialog').hidden) return;
  if (LIVE.has(section())) { adm('overview', 8000); render(); }
}, 4000);
start();
