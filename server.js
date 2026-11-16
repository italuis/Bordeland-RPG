const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Server } = require('socket.io');

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#fff"/><text x="50" y="66" font-size="52" text-anchor="middle" font-family="sans-serif">♠</text></svg>';
const FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/manifest.json': ['manifest.json', 'application/manifest+json'] };

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/icon.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(ICON); }
  if (u === '/sw.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end("self.addEventListener('fetch',()=>{});"); }
  const f = FILES[u];
  if (!f) { res.writeHead(404); return res.end('404'); }
  fs.readFile(path.join(__dirname, f[0]), (e, d) => {
    if (e) { res.writeHead(500); return res.end('erro'); }
    res.writeHead(200, { 'Content-Type': f[1] }); res.end(d);
  });
});

const io = new Server(server, { transports: ['websocket', 'polling'], maxHttpBufferSize: 1e7, cors: { origin: '*' } });

const rooms = {};
const MAX_PLAYERS = 12, IDLE_MS = 30 * 60 * 1000;
const ATTRS = ['F', 'I', 'A', 'P'];
const DICE = [4, 6, 8, 10, 12, 20, 100];
const SUIT_OF = { F: '♠', I: '♦', A: '♣', P: '♥' };
const SUITS = ['♠', '♦', '♣', '♥'];
const RULES = ['none', 'par', 'impar', 'ultimo', 'dobro'];
const cl = (n, a, b) => Math.max(a, Math.min(b, Math.round(+n) || 0));
const str = (s, n) => String(s || '').slice(0, n);
const rnd = n => crypto.randomInt(1, n + 1);

function clean(s = {}) {
  const a = s.attrs || {};
  return {
    name: str(s.name, 30), spec: str(s.spec, 40),
    avatar: typeof s.avatar === 'string' && s.avatar.startsWith('data:image/') && s.avatar.length < 60000 ? s.avatar : '',
    attrs: { F: cl(a.F, -1, 2), I: cl(a.I, -1, 2), A: cl(a.A, -1, 2), P: cl(a.P, -1, 2) },
    pv: cl(s.pv, 0, 6), em: cl(s.em, 0, 6), dias: cl(s.dias, 0, 99),
    inv: (Array.isArray(s.inv) ? s.inv : []).slice(0, 5).map(x => str(x, 40))
  };
}
function code() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r; do { r = Array.from({ length: 4 }, () => c[crypto.randomInt(c.length)]).join(''); } while (rooms[r]);
  return r;
}

/* ---------- evento: estado público ---------- */
// Regra oculta: só aparece para os jogadores quando já passou, foi revelada ou o evento acabou
const evPub = e => ({
  title: e.title, phase: e.phase, idx: e.idx, members: e.members, rolls: e.rolls,
  results: e.results, outcome: e.outcome, jokerUsed: e.jokerUsed, revealed: e.revealed,
  left: e.deadline ? Math.max(0, e.deadline - Date.now()) : null,
  rounds: e.rounds.map((x, i) => ({
    name: x.name, attr: x.attr, dc: x.dc, dano: x.dano, spec: x.spec, timer: x.timer,
    hasRule: x.rule !== 'none',
    rule: (i < e.idx || e.phase === 'ended' || (i === e.idx && (e.revealed || e.phase === 'result'))) ? x.rule : null
  }))
});
function pub(r) {
  return {
    code: r.code, gmOnline: !!r.gmSock,
    players: Object.values(r.players).map(p => ({ id: p.id, online: p.online, x: p.x, y: p.y, sheet: p.sheet })),
    pins: r.pins, map: { w: r.map.w, h: r.map.h, cell: r.map.cell }, log: r.log,
    event: r.event ? evPub(r.event) : null
  };
}
// Cartas e dados secretos são enviados só para quem deve vê-los
function sendSecrets(r) {
  const e = r.event;
  for (const p of Object.values(r.players)) {
    if (!p.online || !p.sock) continue;
    const c = e && e.cards[p.id];
    io.to(p.sock).emit('card', c ? { suit: c.suit, joker: e.jokerId === p.id, jokerUsed: e.jokerUsed } : null);
  }
  if (r.gmSock) io.to(r.gmSock).emit('gmdata', e ? {
    rules: e.rounds.map(x => x.rule),
    cards: e.members.map(id => ({ name: r.players[id] ? r.players[id].sheet.name : '?', suit: e.cards[id].suit, joker: e.jokerId === id }))
  } : null);
}
const push = r => { r.last = Date.now(); io.to(r.code).emit('state', pub(r)); sendSecrets(r); };
const tier = t => t >= 10 ? 'SUCESSO' : t >= 7 ? 'SUCESSO COM CUSTO' : 'FALHA';
const addLog = (r, entry) => { r.log.unshift(Object.assign({ t: Date.now() }, entry)); r.log = r.log.slice(0, 30); };
const hasSpec = (sheet, rd) => {
  const a = (sheet.spec || '').toLowerCase().trim(), b = (rd.spec || '').toLowerCase().trim();
  return !!a && !!b && (a.includes(b) || b.includes(a));
};
const ruleOK = (rule, total) => rule === 'par' ? total % 2 === 0 : rule === 'impar' ? total % 2 === 1 : true;

/* ---------- evento: lógica ---------- */
const isAlive = (r, id) => { const p = r.players[id]; return !!p && r.event.members.includes(id) && p.sheet.pv > 0; };
const aliveIds = r => r.event.members.filter(id => isAlive(r, id));
const clearT = e => { if (e.tmr) { clearTimeout(e.tmr); e.tmr = null; } };

function finish(r) {
  const e = r.event;
  clearT(e);
  const name = id => (r.players[id] ? r.players[id].sheet.name : '?');
  e.phase = 'ended'; e.deadline = null;
  e.outcome = {
    survivors: e.members.filter(id => isAlive(r, id)).map(name),
    out: e.members.filter(id => !isAlive(r, id)).map(name)
  };
  push(r);
}

function startRound(r) {
  const e = r.event;
  clearT(e);
  e.idx++; e.phase = 'round'; e.rolls = {}; e.results = null;
  e.order = []; e.jokerPlay = null; e.revealed = false;
  const rd = e.rounds[e.idx];
  if (rd.timer > 0) {
    const myIdx = e.idx;
    e.deadline = Date.now() + rd.timer * 1000;
    e.tmr = setTimeout(() => {
      if (r.event === e && e.phase === 'round' && e.idx === myIdx) resolveRound(r);
    }, rd.timer * 1000);
  } else e.deadline = null;
  push(r);
}

function resolveRound(r) {
  const e = r.event, rd = e.rounds[e.idx], ids = aliveIds(r);
  clearT(e); e.deadline = null;
  const last = e.order[e.order.length - 1];
  e.results = {};
  for (const id of ids) {
    const p = r.players[id], roll = e.rolls[id];
    const pass = !!roll && roll.total >= rd.dc && ruleOK(rd.rule, roll ? roll.total : 0);
    let dmg = 0;
    if (!pass) {
      dmg = rd.dano * (rd.rule === 'dobro' ? 2 : 1);
      if (rd.rule === 'ultimo' && id === last) dmg += 1;
      if (e.jokerPlay === id) dmg += 1;
      p.sheet.pv = Math.max(0, p.sheet.pv - dmg);
    }
    e.results[id] = { name: p.sheet.name, total: roll ? roll.total : null, pass, dmg, out: false };
  }
  // Joker bem-sucedido: os outros vivos também perdem 1 PV
  if (e.jokerPlay && e.results[e.jokerPlay] && e.results[e.jokerPlay].pass) {
    for (const id of ids) {
      if (id === e.jokerPlay || !r.players[id] || r.players[id].sheet.pv <= 0) continue;
      r.players[id].sheet.pv--; e.results[id].dmg += 1;
    }
  }
  for (const id of ids) e.results[id].out = r.players[id].sheet.pv <= 0;
  e.phase = 'result';
  if (aliveIds(r).length === 0) return finish(r);
  push(r);
}

io.on('connection', socket => {
  const room = () => rooms[socket.data.code];
  const gm = () => socket.data.role === 'gm' && room();
  const enter = (r, role, pid) => {
    Object.assign(socket.data, { code: r.code, role, pid });
    socket.join(r.code);
    socket.emit('mapimg', r.map.img);
    push(r);
  };

  socket.on('create', (_, cb) => {
    const r = { code: code(), gmToken: crypto.randomUUID(), gmSock: socket.id, players: {}, pins: [], log: [], event: null, map: { img: '', w: 1200, h: 800, cell: 70 }, last: Date.now() };
    rooms[r.code] = r;
    enter(r, 'gm');
    cb && cb({ ok: true, code: r.code, token: r.gmToken });
  });

  socket.on('join', ({ code: c, name, sheet }, cb) => {
    const r = rooms[String(c || '').toUpperCase()];
    if (!r) return cb && cb({ ok: false, error: 'Sala não encontrada' });
    if (Object.keys(r.players).length >= MAX_PLAYERS) return cb && cb({ ok: false, error: 'Sala cheia (12 jogadores)' });
    const id = crypto.randomUUID(), n = Object.keys(r.players).length;
    const s = clean(sheet); s.name = str(name, 30) || s.name || 'Jogador';
    r.players[id] = { id, sock: socket.id, online: true, x: 60 + (n % 8) * 70, y: 60 + Math.floor(n / 8) * 70, sheet: s };
    enter(r, 'player', id);
    cb && cb({ ok: true, code: r.code, sid: id });
  });

  socket.on('rejoin', ({ code: c, token, sid }, cb) => {
    const r = rooms[String(c || '').toUpperCase()];
    if (!r) return cb && cb({ ok: false });
    if (token && token === r.gmToken) { r.gmSock = socket.id; enter(r, 'gm'); return cb && cb({ ok: true, role: 'gm' }); }
    const p = r.players[sid];
    if (!p) return cb && cb({ ok: false });
    p.sock = socket.id; p.online = true; enter(r, 'player', sid);
    cb && cb({ ok: true, role: 'player' });
  });

  socket.on('sheet', s => {
    const r = room(), p = r && r.players[socket.data.pid];
    if (!p) return;
    const { pv, em, dias } = p.sheet;
    p.sheet = clean(s); p.sheet.pv = pv; p.sheet.em = em; p.sheet.dias = dias;
    push(r);
  });
  socket.on('gm:sheet', ({ id, sheet }) => {
    const r = gm(); if (r && r.players[id]) { r.players[id].sheet = clean(sheet); push(r); }
  });
  socket.on('gm:adjust', ({ id, key, delta }) => {
    const r = gm(), p = r && r.players[id];
    if (!p || !['pv', 'em', 'dias'].includes(key)) return;
    p.sheet[key] = cl(p.sheet[key] + (+delta || 0), 0, key === 'dias' ? 99 : 6); push(r);
  });
  socket.on('gm:move', ({ id, x, y }) => {
    const r = gm(), p = r && r.players[id];
    if (!p) return;
    p.x = cl(x, 0, r.map.w); p.y = cl(y, 0, r.map.h);
    socket.to(r.code).emit('move', { id, x: p.x, y: p.y });
  });
  socket.on('gm:map', m => {
    const r = gm(); if (!r) return;
    if (typeof m.img === 'string') r.map.img = m.img.startsWith('data:image/') ? m.img : '';
    r.map.w = cl(m.w, 200, 4000); r.map.h = cl(m.h, 200, 4000); r.map.cell = cl(m.cell, 20, 300);
    if (typeof m.img === 'string') io.to(r.code).emit('mapimg', r.map.img);
    push(r);
  });
  socket.on('gm:pin', ({ op, pin }) => {
    const r = gm(); if (!r || !pin) return;
    if (op === 'add') r.pins.push({ id: crypto.randomUUID(), x: cl(pin.x, 0, r.map.w), y: cl(pin.y, 0, r.map.h), title: str(pin.title, 60), desc: str(pin.desc, 600) });
    const p = r.pins.find(q => q.id === pin.id);
    if (op === 'edit' && p) { p.title = str(pin.title, 60); p.desc = str(pin.desc, 600); }
    if (op === 'del') r.pins = r.pins.filter(q => q.id !== pin.id);
    push(r);
  });

  socket.on('roll', ({ attr, adv }) => {
    const r = room(); if (!r) return;
    const p = r.players[socket.data.pid];
    const v = p && ATTRS.includes(attr) ? p.sheet.attrs[attr] : 0;
    const raw = Array.from({ length: adv ? 3 : 2 }, () => rnd(6));
    const kept = raw.slice().sort((a, b) => b - a).slice(0, 2);
    const total = kept[0] + kept[1] + v;
    addLog(r, { type: 'attr', who: p ? p.sheet.name : 'Mestre', attr: attr || '', v, adv: !!adv, dice: raw, total, res: tier(total) });
    push(r);
  });

  socket.on('dice:free', ({ sides, count, mod }) => {
    const r = room(); if (!r || !DICE.includes(+sides)) return;
    const s = +sides, n = cl(count, 1, 20), m = cl(mod, -99, 99);
    const raw = Array.from({ length: n }, () => rnd(s));
    const total = raw.reduce((a, b) => a + b, 0) + m;
    const p = r.players[socket.data.pid];
    addLog(r, { type: 'free', who: p ? p.sheet.name : 'Mestre', sides: s, count: n, mod: m, dice: raw, total });
    push(r);
  });

  socket.on('gm:event:start', (ev, cb) => {
    const r = gm();
    if (!r) return cb && cb({ ok: false, error: 'Só o Mestre pode iniciar' });
    if (r.event) return cb && cb({ ok: false, error: 'Já existe um evento ativo' });
    const rounds = (Array.isArray(ev && ev.rounds) ? ev.rounds : []).slice(0, 10).map(x => ({
      name: str(x.name, 40) || 'Teste', attr: ATTRS.includes(x.attr) ? x.attr : '',
      dc: cl(x.dc, 2, 20), dano: cl(x.dano, 0, 6), spec: str(x.spec, 40),
      timer: cl(x.timer, 0, 600), rule: RULES.includes(x.rule) ? x.rule : 'none'
    }));
    if (!rounds.length) return cb && cb({ ok: false, error: 'Adicione ao menos uma rodada' });
    const members = Object.keys(r.players).filter(id => r.players[id].sheet.pv > 0);
    if (!members.length) return cb && cb({ ok: false, error: 'Nenhum jogador vivo na sala' });
    const cards = {};
    members.forEach(id => { cards[id] = { suit: SUITS[rnd(4) - 1] }; });
    const jokerId = members[rnd(members.length) - 1];
    r.event = {
      title: str(ev.title, 40) || 'GAME', rounds, phase: 'intro', idx: -1, rolls: {}, results: null,
      members, outcome: null, cards, jokerId, jokerUsed: false, jokerPlay: null, order: [],
      revealed: false, deadline: null, tmr: null
    };
    push(r);
    cb && cb({ ok: true });
  });

  socket.on('gm:event:next', () => {
    const r = gm(), e = r && r.event; if (!e) return;
    if (e.phase === 'intro' || e.phase === 'result') {
      if (e.idx + 1 < e.rounds.length) startRound(r); else finish(r);
    }
  });
  socket.on('gm:event:resolve', () => {
    const r = gm(); if (r && r.event && r.event.phase === 'round') resolveRound(r);
  });
  socket.on('gm:event:reveal', () => {
    const r = gm(); if (r && r.event && r.event.phase === 'round' && !r.event.revealed) { r.event.revealed = true; push(r); }
  });
  socket.on('gm:event:end', () => {
    const r = gm(); if (r && r.event && r.event.phase !== 'ended') finish(r);
  });
  socket.on('gm:event:close', () => {
    const r = gm(); if (r && r.event) { clearT(r.event); delete r.event; push(r); }
  });

  socket.on('event:roll', ({ joker } = {}) => {
    const r = room(), e = r && r.event;
    if (!e || e.phase !== 'round') return;
    const pid = socket.data.pid;
    if (!pid || !isAlive(r, pid) || e.rolls[pid]) return;
    const p = r.players[pid], rd = e.rounds[e.idx], card = e.cards[pid];
    const useJoker = !!joker && e.jokerId === pid && !e.jokerUsed;
    if (useJoker) { e.jokerUsed = true; e.jokerPlay = pid; }
    const adv = useJoker || hasSpec(p.sheet, rd);
    const bonus = card && rd.attr && card.suit === SUIT_OF[rd.attr] ? 1 : 0;
    const v = (rd.attr ? p.sheet.attrs[rd.attr] : 0) + bonus;
    const raw = Array.from({ length: adv ? 3 : 2 }, () => rnd(6));
    const kept = raw.slice().sort((a, b) => b - a).slice(0, 2);
    const total = kept[0] + kept[1] + v;
    e.rolls[pid] = { dice: raw, total, v, adv, bonus, joker: useJoker };
    e.order.push(pid);
    addLog(r, { type: 'event', who: p.sheet.name, attr: rd.attr, v, adv, dice: raw, total, joker: useJoker, res: total >= rd.dc ? 'PASSOU' : 'FALHOU' });
    if (aliveIds(r).every(id => e.rolls[id])) resolveRound(r); else push(r);
  });

  socket.on('disconnect', () => {
    const r = room(); if (!r) return;
    if (socket.data.role === 'gm' && r.gmSock === socket.id) r.gmSock = null;
    const p = r.players[socket.data.pid];
    if (p && p.sock === socket.id) p.online = false;
    push(r);
  });
});

setInterval(() => {
  for (const c in rooms) {
    const r = rooms[c];
    const any = r.gmSock || Object.values(r.players).some(p => p.online);
    if (any) r.last = Date.now(); else if (Date.now() - r.last > IDLE_MS) { if (r.event) clearT(r.event); delete rooms[c]; }
  }
}, 60000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Borderland VTT na porta ' + PORT));
