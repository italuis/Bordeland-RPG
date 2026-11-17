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
const MAX_PLAYERS = 12, MAX_NPCS = 30, MAX_ITEMS = 8, MAX_EQUIP = 4, IDLE_MS = 30 * 60 * 1000;
const ATTRS = ['F', 'I', 'A', 'P'];
const GEAR_ATTRS = ['F', 'I', 'A', 'P', 'DEF', 'DANO'];
const DICE = [4, 6, 8, 10, 12, 20, 100];
const SUIT_OF = { F: '♠', I: '♦', A: '♣', P: '♥' };
const SUITS = ['♠', '♦', '♣', '♥'];
const RULES = ['none', 'par', 'impar', 'ultimo', 'dobro'];
const KINDS = ['teste', 'enigma'];
const SUIT_NAMES = { '♠': 'Espadas', '♦': 'Ouros', '♣': 'Paus', '♥': 'Copas' };
const sanitizeReward = w => ({
  type: ['none', 'lives', 'pv', 'attr'].includes(w && w.type) ? w.type : 'none',
  attr: ATTRS.includes(w && w.attr) ? w.attr : 'F', amount: cl(w && w.amount, 0, 3)
});
// Anúncio cinematográfico: só texto e regras, sem testes
const sanitizeAnn = a => {
  const slides = (Array.isArray(a && a.slides) ? a.slides : [])
    .map(x => str(typeof x === 'string' ? x : (x && x.text), 800).trim()).filter(Boolean).slice(0, 12);
  if (!slides.length) return null;
  return { id: crypto.randomUUID(), kicker: str(a.kicker, 60), title: str(a.title, 40) || 'GAME', suit: SUITS.includes(a.suit) ? a.suit : '', difficulty: cl(a.difficulty, 1, 20), slides };
};
const sanitizeMap = m => ({
  id: str(m && m.id, 64) || crypto.randomUUID(), name: str(m && m.name, 40) || 'Mapa',
  img: m && typeof m.img === 'string' && m.img.startsWith('data:image/') ? m.img : '',
  w: cl(m && m.w || 1200, 200, 4000), h: cl(m && m.h || 800, 200, 4000), cell: cl(m && m.cell || 70, 20, 300)
});
// Condições de Sobrevivência e Trauma (aplicadas só pelo Mestre)
const COND = {
  paranoia: { name: 'Paranoia Aguda', mod: -1, scope: ['F', 'I', 'A', 'P'] },
  cegueira: { name: 'Cegueira Parcial', mod: -3, scope: 'all' },
  surdez: { name: 'Surdez Temporária', mod: -1, scope: ['I', 'P'] },
  hemorragia: { name: 'Hemorragia / Ferimento', mod: -2, scope: ['F', 'A'] },
  panico: { name: 'Pânico Congelante', mod: -2, scope: ['P'] },
  exaustao: { name: 'Exaustão Extrema', mod: -2, scope: ['F'] },
  adrenalina: { name: 'Adrenalina Forçada', mod: 2, scope: ['A', 'F'] },
  foco: { name: 'Foco Absoluto', mod: 1, scope: ['I'] },
  desorientacao: { name: 'Desorientação Leve', mod: -1, scope: ['I', 'A'] },
  instinto: { name: 'Instinto de Sobrevivência', mod: 2, scope: ['P'] }
};
const ATTR_NM = { F: 'Físico', I: 'Intelecto', A: 'Agilidade', P: 'Psicológico' };
const sanitizeConds = list => [...new Set(Array.isArray(list) ? list : [])].filter(k => COND[k]).slice(0, 10);
// Condição vale para o atributo testado, ou para qualquer teste se o escopo for 'all'
const condApplies = (c, attr) => c.scope === 'all' || (!!attr && c.scope.includes(attr));
const condParts = (conds, attr) => (conds || []).filter(k => COND[k] && condApplies(COND[k], attr)).map(k => ({ l: COND[k].name, v: COND[k].mod }));
// Rola 2d6 (ou 3d6 com vantagem, mantendo os 2 maiores) e soma todas as partes do cálculo
function rollDice(parts, adv) {
  const raw = Array.from({ length: adv ? 3 : 2 }, () => rnd(6));
  const kept = raw.slice().sort((a, b) => b - a).slice(0, 2);
  const v = parts.reduce((t, x) => t + x.v, 0);
  return { raw, kept, v, parts, total: kept[0] + kept[1] + v };
}
const cl = (n, a, b) => Math.max(a, Math.min(b, Math.round(+n) || 0));
const str = (s, n) => String(s || '').slice(0, n);
const ZONE_COLORS = ['#b22222', '#e5e7eb', '#374151', '#60a5fa', '#4d7c0f', '#ca8a04'];
const MAX_ZONES = 60;
const HIST_MAX = 50;
const ensureHist = r => r.hist || (r.hist = { u: [], r: [] });
const layoutSnap = r => ({
  pins: JSON.parse(JSON.stringify(r.pins || [])),
  zones: JSON.parse(JSON.stringify(r.zones || [])),
  players: Object.fromEntries(Object.values(r.players || {}).map(p => [p.id, { x: p.x, y: p.y }])),
  npcs: Object.fromEntries((r.npcs || []).map(n => [n.id, { x: n.x, y: n.y }]))
});
const histPush = r => {
  const h = ensureHist(r);
  h.u.push(layoutSnap(r));
  if (h.u.length > HIST_MAX) h.u.shift();
  h.r = [];
};
const histRestore = (r, s) => {
  r.pins = s.pins; r.zones = s.zones;
  Object.values(r.players || {}).forEach(p => { const q = s.players[p.id]; if (q) { p.x = q.x; p.y = q.y; } });
  (r.npcs || []).forEach(n => { const q = s.npcs[n.id]; if (q) { n.x = q.x; n.y = q.y; } });
};
const sanitizeZone = (z, m) => ({
  id: str(z.id, 64) || crypto.randomUUID(), map: m.id, name: str(z.name, 30) || 'Zona',
  x: cl(z.x, 0, m.w), y: cl(z.y, 0, m.h), r: cl(z.r, 10, 2000),
  color: ZONE_COLORS.includes(z.color) ? z.color : ZONE_COLORS[0]
});
const rnd = n => crypto.randomInt(1, n + 1);
const avatarOk = s => typeof s === 'string' && s.startsWith('data:image/') && s.length < 60000 ? s : '';

function clean(s = {}) {
  const a = s.attrs || {};
  return {
    name: str(s.name, 30), spec: str(s.spec, 40), avatar: avatarOk(s.avatar),
    attrs: { F: cl(a.F, -1, 2), I: cl(a.I, -1, 2), A: cl(a.A, -1, 2), P: cl(a.P, -1, 2) },
    pv: s.pv == null ? 6 : cl(s.pv, 0, 6), em: s.em == null ? 6 : cl(s.em, 0, 6), dias: s.dias == null ? 3 : cl(s.dias, 0, 99),
    inv: (Array.isArray(s.inv) ? s.inv : []).slice(0, 5).map(x => str(x, 40))
  };
}
// Campos que só o servidor controla: PV, EM, Dias e itens (gear)
function applySheet(p, s) {
  const keep = { pv: p.sheet.pv, em: p.sheet.em, dias: p.sheet.dias, gear: p.sheet.gear || [], conds: p.sheet.conds || [] };
  p.sheet = Object.assign(clean(s), keep);
}
const gearBonus = (sheet, attr) => (sheet.gear || []).reduce((t, g) => t + (g.eq && g.attr === attr ? g.bonus : 0), 0);
const gearDice = sheet => (sheet.gear || []).reduce((t, g) => t + (g.eq ? g.dd : 0), 0);

function code() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r; do { r = Array.from({ length: 4 }, () => c[crypto.randomInt(c.length)]).join(''); } while (rooms[r]);
  return r;
}

const evPub = e => ({
  title: e.title, phase: e.phase, idx: e.idx, members: e.members, rolls: e.rolls,
  results: e.results, outcome: e.outcome, jokerUsed: e.jokerUsed, revealed: e.revealed,
  suit: e.suit || '', enigReveal: !!e.enigReveal, startLives: e.startLives || {},
  lives: e.enigReveal ? (e.lives || {}) : {}, solved: e.enigReveal ? (e.solved || []) : [],
  subs: Object.fromEntries(Object.entries(e.sub || {}).map(([k, v]) => [k, v.tries])),
  scores: e.scores, hasCombat: e.rounds.some(x => x.kind === 'combate'),
  left: e.deadline ? Math.max(0, e.deadline - Date.now()) : null,
  rounds: e.rounds.map((x, i) => ({
    name: x.name, attr: x.attr, dc: x.dc, dano: x.dano, spec: x.spec, timer: x.timer, kind: x.kind, q: x.q || '', lives: x.lives || 0, mode: x.mode || 'multi', carry: x.carry || 'reset',
    hasRule: x.rule !== 'none',
    rule: (i < e.idx || e.phase === 'ended' || (i === e.idx && (e.revealed || e.phase === 'result'))) ? x.rule : null
  }))
});
function pub(r) {
  return {
    code: r.code, gmOnline: !!r.gmSock,
    players: Object.values(r.players).map(p => ({ id: p.id, online: p.online, x: p.x, y: p.y, sheet: p.sheet })),
    npcs: r.npcs, condDefs: COND, maps: (r.maps || []).map(m => ({ id: m.id, name: m.name, w: m.w, h: m.h, cell: m.cell })),
    pins: r.pins, zones: r.zones || [], map: { id: r.map.id, name: r.map.name, w: r.map.w, h: r.map.h, cell: r.map.cell }, log: r.log,
    event: r.event ? Object.assign(evPub(r.event), { atRisk: atRiskCount(r) }) : null,
    announce: r.announce || null,
    hist: { u: r.hist ? r.hist.u.length : 0, r: r.hist ? r.hist.r.length : 0 }
  };
}
function sendSecrets(r) {
  const e = r.event;
  for (const p of Object.values(r.players)) {
    if (!p.online || !p.sock) continue;
    const c = e && e.cards[p.id];
    io.to(p.sock).emit('card', c ? { suit: c.suit, joker: e.jokerId === p.id, jokerUsed: e.jokerUsed } : null);
  }
  if (r.gmSock) io.to(r.gmSock).emit('gmdata', e ? {
    rules: e.rounds.map(x => x.rule),
    answers: e.rounds.map(x => x.ans || ''),
    rewards: e.rounds.map(x => x.reward || null),
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
// Enigma: compara texto normalizado (sem espaços extras; minúsculas se ci)
const normText = (t, ci) => { const x = String(t || '').trim(); return ci ? x.toLowerCase() : x; };
// Naipe da arena: tema que modifica testes da rodada
function rewardParts(e, pid, attr) {
  const n = e && e.rewards && e.rewards[pid] && attr ? (e.rewards[pid][attr] || 0) : 0;
  return n ? [{ l: 'Recompensa', v: n }] : [];
}
function arenaParts(e, attr) {
  const out = [];
  if (!e || !e.suit) return out;
  if (e.suit === '♠' && attr === 'F') out.push({ l: 'Arena ♠', v: 1 });
  if (e.suit === '♣' && attr === 'A') out.push({ l: 'Arena ♣', v: 1 });
  if (e.suit === '♥') out.push({ l: 'Arena ♥', v: -1 });
  return out;
}
// Troca de mapa: tokens mantêm posição, ajustada aos limites do novo mapa
function switchMap(r, id) {
  const m = (r.maps || []).find(x => x.id === id); if (!m) return;
  r.map = m;
  for (const p of Object.values(r.players || {})) { p.x = cl(p.x, 0, m.w); p.y = cl(p.y, 0, m.h); }
  for (const n of (r.npcs || [])) { n.x = cl(n.x, 0, m.w); n.y = cl(n.y, 0, m.h); }
  io.to(r.code).emit('mapimg', m.img);
  push(r);
}

/* ---------- evento ---------- */
const isAlive = (r, id) => { const p = r.players[id]; return !!p && !!r.event && r.event.members.includes(id) && p.sheet.pv > 0; };
const aliveIds = r => (r.event ? r.event.members : []).filter(id => isAlive(r, id));
const clearT = e => { if (e && e.tmr) { clearTimeout(e.tmr); e.tmr = null; } };

function finish(r) {
  const e = r.event; if (!e) return;
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
  const e = r.event; if (!e) return;
  clearT(e);
  e.idx++; e.phase = 'round'; e.rolls = {}; e.results = null;
  e.order = []; e.jokerPlay = null; e.revealed = false; e.npcRolled = {};
  e.solved = []; e.lives = {}; e.sub = {}; e.enigReveal = false; e.startLives = {};
  if (e.rounds[e.idx].kind === 'enigma') {
    const rd0 = e.rounds[e.idx], bonusLife = e.suit === '♦' ? 1 : 0;
    for (const id of aliveIds(r)) {
      const carried = rd0.carry === 'carry' && e.carry && e.carry[id] != null;
      e.lives[id] = (carried ? e.carry[id] : rd0.lives + bonusLife) + ((e.nextLives || {})[id] || 0);
    }
    e.nextLives = {};
    e.startLives = { ...e.lives };
  }
  const rd = e.rounds[e.idx];
  if (rd.timer > 0) {
    const myIdx = e.idx;
    e.deadline = Date.now() + rd.timer * 1000;
    e.tmr = setTimeout(() => {
      if (r.event === e && e.phase === 'round' && e.idx === myIdx) endRound(r);
    }, rd.timer * 1000);
  } else e.deadline = null;
  push(r);
}

function resolveRound(r) {
  const e = r.event; if (!e) return;
  const rd = e.rounds[e.idx], ids = aliveIds(r);
  clearT(e); e.deadline = null;
  const last = e.order[e.order.length - 1];
  e.results = {};
  for (const id of ids) {
    const p = r.players[id], roll = e.rolls[id];
    const solved = e.solved || [];
    const pass = rd.kind === 'enigma'
      ? solved.includes(id)
      : (!!roll && roll.total >= rd.dc && ruleOK(rd.rule, roll ? roll.total : 0));
    let dmg = 0;
    if (!pass && rd.kind !== 'enigma') {
      dmg = rd.dano * (rd.rule === 'dobro' ? 2 : 1);
      if (rd.rule === 'ultimo' && id === last) dmg += 1;
      if (e.jokerPlay === id) dmg += 1;
      p.sheet.pv = Math.max(0, p.sheet.pv - dmg);
    }
    const hit = roll && rd.kind === 'combate' ? roll.dmg : 0;
    if (hit) e.scores[id] = (e.scores[id] || 0) + hit;
    e.results[id] = { name: p.sheet.name, total: roll ? roll.total : null, pass, dmg, hit, out: false };
  }
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

/* ---------- sessão, moderação e persistência ---------- */
const sanitizeGear = list => (Array.isArray(list) ? list : []).slice(0, MAX_ITEMS).map(g => ({
  id: str(g && g.id, 64) || crypto.randomUUID(), eq: !!(g && g.eq), name: str(g && g.name, 40) || 'Item',
  attr: GEAR_ATTRS.includes(g && g.attr) ? g.attr : 'DEF', bonus: cl(g && g.bonus, -3, 3), dd: cl(g && g.dd, 0, 3)
}));
function removePlayer(r, pid) {
  const p = r.players[pid]; if (!p) return;
  if (p.sock) {
    const s = io.sockets.sockets.get(p.sock);
    if (s) { s.leave(r.code); s.data.code = null; s.data.role = null; s.data.pid = null; }
  }
  if (r.event) {
    r.event.members = r.event.members.filter(x => x !== pid);
    if (r.event.rolls) delete r.event.rolls[pid];
    if (r.event.results) delete r.event.results[pid];
    if (r.event.scores) delete r.event.scores[pid];
  }
  delete r.players[pid];
}
// Depois de sair alguém, o evento não pode ficar travado esperando essa pessoa
function afterRemoval(r) {
  const e = r.event; if (!e || e.phase === 'ended') return;
  const alive = aliveIds(r);
  if (alive.length === 0) return finish(r);
  if (e.phase === 'round' && alive.every(id => e.rolls[id])) return resolveRound(r);
}
function armTimer(r) {
  const e = r.event; if (!e) return;
  clearT(e);
  const rd = e.rounds[e.idx];
  if (e.phase === 'round' && rd && rd.timer > 0) {
    const ms = e.pendingLeft != null ? e.pendingLeft : rd.timer * 1000;
    e.pendingLeft = null;
    const my = e.idx;
    e.deadline = Date.now() + ms;
    e.tmr = setTimeout(() => { if (r.event === e && e.phase === 'round' && e.idx === my) endRound(r); }, ms);
  } else e.deadline = null;
}
function exportRoom(r) {
  const e = r.event;
  return {
    app: 'borderland-vtt', version: 2, exportedAt: new Date().toISOString(), code: r.code,
    map: r.map, maps: r.maps, activeMap: r.map.id,
    players: Object.values(r.players).map(p => ({ id: p.id, x: p.x, y: p.y, sheet: p.sheet })),
    npcs: r.npcs, pins: r.pins, zones: r.zones || [], log: r.log, announce: r.announce || null,
    event: e ? {
      title: e.title, phase: e.phase, idx: e.idx, rounds: e.rounds, members: e.members, rolls: e.rolls,
      results: e.results, outcome: e.outcome, cards: e.cards, jokerId: e.jokerId, jokerUsed: e.jokerUsed,
      order: e.order, revealed: e.revealed, scores: e.scores, npcRolled: e.npcRolled,
      suit: e.suit, lives: e.lives, solved: e.solved, sub: e.sub, enigReveal: e.enigReveal, carry: e.carry, startLives: e.startLives, rewards: e.rewards, nextLives: e.nextLives,
      left: e.deadline ? Math.max(0, e.deadline - Date.now()) : null
    } : null
  };
}
// Reconstrói a sala a partir do JSON, validando cada campo antes de aceitar
function buildRoom(d, code, gmSid) {
  const map = d.map && typeof d.map === 'object' ? d.map : {};
  const r = {
    code, gmToken: crypto.randomUUID(), gmSock: gmSid, players: {}, npcs: [], pins: [], zones: [], log: [], event: null,
    map: {
      img: typeof map.img === 'string' && map.img.startsWith('data:image/') ? map.img : '',
      w: cl(map.w || 1200, 200, 4000), h: cl(map.h || 800, 200, 4000), cell: cl(map.cell || 70, 20, 300)
    },
    last: Date.now()
  };
  r.announce = d.announce ? sanitizeAnn(d.announce) : null;
  r.maps = (Array.isArray(d.maps) ? d.maps : []).filter(x => x && typeof x === 'object').slice(0, 8).map(sanitizeMap);
  if (r.maps.length) r.map = r.maps.find(m => m.id === d.activeMap) || r.maps[0];
  else { r.map.id = 'm1'; r.map.name = 'Mapa 1'; r.maps = [r.map]; }
  for (const p of (Array.isArray(d.players) ? d.players : []).slice(0, MAX_PLAYERS)) {
    if (!p || typeof p !== 'object') continue;
    const id = str(p.id, 64) || crypto.randomUUID();
    const sheet = clean(p.sheet || {});
    sheet.gear = sanitizeGear(p.sheet && p.sheet.gear);
    sheet.conds = sanitizeConds(p.sheet && p.sheet.conds);
    r.players[id] = { id, sock: null, online: false, x: cl(p.x, 0, r.map.w), y: cl(p.y, 0, r.map.h), sheet };
  }
  r.npcs = (Array.isArray(d.npcs) ? d.npcs : []).slice(0, MAX_NPCS).filter(n => n && typeof n === 'object').map(n => {
    const a = n.attrs || {};
    const maxpv = cl(n.maxpv || n.pv, 1, 30);
    return {
      id: str(n.id, 64) || crypto.randomUUID(), name: str(n.name, 40) || 'NPC', desc: str(n.desc, 300), avatar: avatarOk(n.avatar),
      attrs: { F: cl(a.F, -1, 3), I: cl(a.I, -1, 3), A: cl(a.A, -1, 3), P: cl(a.P, -1, 3) },
      pv: cl(n.pv, 0, maxpv), maxpv, atk: cl(n.atk, -3, 8), dano: cl(n.dano, 0, 6), def: cl(n.def, -3, 6),
      x: cl(n.x, 0, r.map.w), y: cl(n.y, 0, r.map.h), conds: sanitizeConds(n.conds), inScene: n.inScene !== false
    };
  });
  r.pins = (Array.isArray(d.pins) ? d.pins : []).slice(0, 200).filter(p => p && typeof p === 'object').map(p => ({
    id: str(p.id, 64) || crypto.randomUUID(), x: cl(p.x, 0, r.map.w), y: cl(p.y, 0, r.map.h), title: str(p.title, 60), desc: str(p.desc, 600)
  }));
  r.zones = (Array.isArray(d.zones) ? d.zones : []).slice(0, MAX_ZONES)
    .filter(z => z && typeof z === 'object')
    .map(z => { const m = r.maps.find(q => q.id === z.map); return m ? sanitizeZone(z, m) : null })
    .filter(Boolean);
  r.log = (Array.isArray(d.log) ? d.log : []).filter(x => x && typeof x === 'object').slice(0, 30);
  const e = d.event;
  if (e && typeof e === 'object' && Array.isArray(e.rounds) && e.rounds.length) {
    const members = (Array.isArray(e.members) ? e.members : []).filter(id => r.players[id]);
    if (members.length) {
      const rounds = e.rounds.slice(0, 10).filter(x => x && typeof x === 'object').map(x => ({
        name: str(x.name, 40) || 'Teste', attr: ATTRS.includes(x.attr) ? x.attr : '', dc: cl(x.dc, 2, 20), dano: cl(x.dano, 0, 6),
        spec: str(x.spec, 40), timer: cl(x.timer, 0, 600), rule: RULES.includes(x.rule) ? x.rule : 'none',
        kind: KINDS.includes(x.kind) ? x.kind : 'teste',
        q: str(x.q, 600), ans: str(x.ans, 80), ci: x.ci !== false, lives: cl(x.lives || 3, 1, 9), mode: x.mode === 'single' ? 'single' : 'multi', carry: x.carry === 'carry' ? 'carry' : 'reset', reward: sanitizeReward(x.reward)
      }));
      const cards = {}, scores = {};
      members.forEach(id => {
        const s = e.cards && e.cards[id] && e.cards[id].suit;
        cards[id] = { suit: SUITS.includes(s) ? s : SUITS[rnd(4) - 1] };
        scores[id] = cl(e.scores && e.scores[id], 0, 99999);
      });
      for (const k in (e.scores || {})) if (k.startsWith('npc:')) scores[k] = cl(e.scores[k], 0, 99999);
      const phase = ['intro', 'round', 'result', 'ended'].includes(e.phase) ? e.phase : 'intro';
      let idx = cl(e.idx, -1, rounds.length - 1);
      if (phase === 'intro') idx = -1;
      r.event = {
        title: str(e.title, 40) || 'GAME', rounds, phase, idx,
        rolls: e.rolls && typeof e.rolls === 'object' ? e.rolls : {}, results: e.results || null,
        members, outcome: e.outcome || null, cards,
        jokerId: members.includes(e.jokerId) ? e.jokerId : members[rnd(members.length) - 1],
        jokerUsed: !!e.jokerUsed, jokerPlay: null,
        order: (Array.isArray(e.order) ? e.order : []).filter(x => members.includes(x)),
        revealed: !!e.revealed, deadline: null, tmr: null, scores,
        npcRolled: e.npcRolled && typeof e.npcRolled === 'object' ? e.npcRolled : {},
        suit: SUITS.includes(e.suit) ? e.suit : '', sub: e.sub && typeof e.sub === 'object' ? e.sub : {}, enigReveal: !!e.enigReveal, rewards: e.rewards && typeof e.rewards === 'object' ? e.rewards : {}, nextLives: e.nextLives && typeof e.nextLives === 'object' ? e.nextLives : {}, carry: e.carry && typeof e.carry === 'object' ? e.carry : {}, startLives: e.startLives && typeof e.startLives === 'object' ? e.startLives : {},
        solved: (Array.isArray(e.solved) ? e.solved : []).filter(id => members.includes(id)),
        lives: Object.fromEntries(members.filter(id => e.lives && e.lives[id] != null).map(id => [id, cl(e.lives[id], 0, 9)])),
        pendingLeft: e.left != null ? cl(e.left, 0, 600000) : null
      };
      armTimer(r);
    }
  }
  return r;
}

// Plano do enigma: quem é eliminado e a classificação. Usado no aviso e na revelação.
// Ranking: quem acertou (pela ordem de acerto) vem antes; depois os que não acertaram, por vidas restantes.
// Eliminados: sem vidas (ou errou com 1 tentativa) + o último colocado (se houver 2 ou mais vivos).
function enigmaPlan(r) {
  const e = r.event, rd = e.rounds[e.idx];
  const sub = e.sub || {}, solved = e.solved || [], alive = aliveIds(r);
  const failIds = alive.filter(id => !solved.includes(id) && sub[id] && sub[id].tries > 0 && (rd.mode === 'single' || e.lives[id] <= 0));
  const solvedOrder = solved.filter(id => alive.includes(id));
  const rest = alive.filter(id => !solved.includes(id)).sort((a, b) => (e.lives[b] || 0) - (e.lives[a] || 0));
  const order = [...solvedOrder, ...rest];
  const ranks = {};
  order.forEach((id, i) => { ranks[id] = i + 1; });
  const outs = new Set(failIds);
  if (alive.length >= 2 && order.length) outs.add(order[order.length - 1]);
  return { outs: [...outs], ranks, order };
}
function atRiskCount(r) {
  const e = r.event; if (!e || e.phase !== 'round' || e.enigReveal) return 0;
  const rd = e.rounds[e.idx]; if (!rd || rd.kind !== 'enigma') return 0;
  return enigmaPlan(r).outs.length;
}
// Recompensa de quem acertou: vidas para o próximo enigma, PV, ou bônus de atributo no evento
function applyReward(r, id, rw) {
  const e = r.event, p = r.players[id];
  if (!e || !p || !rw || rw.type === 'none' || !(rw.amount > 0)) return;
  if (rw.type === 'pv') p.sheet.pv = Math.min(6, p.sheet.pv + rw.amount);
  if (rw.type === 'lives') { e.nextLives = e.nextLives || {}; e.nextLives[id] = (e.nextLives[id] || 0) + rw.amount; }
  if (rw.type === 'attr' && ATTRS.includes(rw.attr)) {
    e.rewards = e.rewards || {};
    e.rewards[id] = e.rewards[id] || {};
    e.rewards[id][rw.attr] = (e.rewards[id][rw.attr] || 0) + rw.amount;
  }
  addLog(r, { type: 'enigma', who: p.sheet.name, res: 'RECOMPENSA ' + (rw.type === 'pv' ? '+' + rw.amount + ' PV' : rw.type === 'lives' ? '+' + rw.amount + ' vidas no próximo enigma' : '+' + rw.amount + ' ' + ATTR_NM[rw.attr]), vidas: (e.lives || {})[id] || 0 });
}
// Revelação do enigma: o Mestre mostra os resultados de todos de uma vez
function revealEnigma(r) {
  const e = r.event; if (!e || e.phase !== 'round') return;
  const rd = e.rounds[e.idx];
  const plan = enigmaPlan(r);
  const sub = e.sub || {}, solved = e.solved || [], alive = aliveIds(r);
  e.enigReveal = true;
  e.carry = {};
  for (const id of alive) e.carry[id] = e.lives[id] || 0;
  for (const id of alive) {
    addLog(r, { type: 'enigma', who: r.players[id].sheet.name, res: solved.includes(id) ? 'ACERTOU' : (sub[id] && sub[id].tries ? 'ERROU' : 'SEM RESPOSTA'), vidas: e.lives[id] || 0 });
  }
  for (const id of solved) if (alive.includes(id)) applyReward(r, id, rd.reward);
  resolveRound(r);
  if (!r.event || r.event.phase === 'ended') return;
  for (const id of plan.outs) {
    if (!r.players[id]) continue;
    r.players[id].sheet.pv = 0;
    if (e.results && e.results[id]) e.results[id].out = true;
  }
  for (const id of Object.keys(plan.ranks)) {
    if (e.results && e.results[id]) e.results[id].rank = plan.ranks[id];
  }
  if (aliveIds(r).length === 0) return finish(r);
  push(r);
}
function endRound(r) {
  const e = r.event; if (!e) return;
  const rd = e.rounds[e.idx];
  if (rd && rd.kind === 'enigma') return revealEnigma(r);
  return resolveRound(r);
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
    const r = { code: code(), gmToken: crypto.randomUUID(), gmSock: socket.id, players: {}, npcs: [], pins: [], zones: [], log: [], event: null, last: Date.now() };
    r.map = { id: 'm1', name: 'Mapa 1', img: '', w: 1200, h: 800, cell: 70 };
    r.maps = [r.map];
    rooms[r.code] = r;
    enter(r, 'gm');
    cb && cb({ ok: true, code: r.code, token: r.gmToken });
  });

  socket.on('join', ({ code: c, name, sheet }, cb) => {
    const r = rooms[String(c || '').toUpperCase()];
    if (!r) return cb && cb({ ok: false, error: 'Sala não encontrada' });
    if (Object.keys(r.players).length >= MAX_PLAYERS) return cb && cb({ ok: false, error: 'Sala cheia (12 jogadores)' });
    const id = crypto.randomUUID(), n = Object.keys(r.players).length;
    const s = clean(sheet); s.name = str(name, 30) || s.name || 'Jogador'; s.gear = []; s.conds = [];
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
    if (p) { applySheet(p, s); push(r); }
  });
  socket.on('gm:sheet', ({ id, sheet }) => {
    const r = gm(), p = r && r.players[id];
    if (p) { applySheet(p, sheet); push(r); }
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
  socket.on('gm:hist:begin', () => { const r = gm(); if (r) histPush(r); });
  socket.on('gm:hist', ({ op } = {}) => {
    const r = gm(); if (!r) return;
    const h = ensureHist(r);
    if (op === 'undo' && h.u.length) { h.r.push(layoutSnap(r)); histRestore(r, h.u.pop()); }
    else if (op === 'redo' && h.r.length) { h.u.push(layoutSnap(r)); histRestore(r, h.r.pop()); }
    else return;
    push(r);
  });
  socket.on('gm:zone', ({ op, zone } = {}) => {
    const r = gm(); if (!r || !zone || typeof zone !== 'object') return;
    if (!Array.isArray(r.zones)) r.zones = [];
    if (op === 'add') {
      const m = r.maps.find(q => q.id === zone.map);
      if (!m || r.zones.length >= MAX_ZONES) return;
      histPush(r);
      r.zones.push(sanitizeZone({ ...zone, id: crypto.randomUUID() }, m));
    } else {
      const z = r.zones.find(q => q.id === zone.id);
      if (!z) return;
      if (op === 'move') {
        const m = r.maps.find(q => q.id === z.map);
        if (!m) return;
        z.x = cl(zone.x, 0, m.w); z.y = cl(zone.y, 0, m.h);
      } else if (op === 'edit') {
        histPush(r);
        z.name = str(zone.name, 30) || z.name;
        if (ZONE_COLORS.includes(zone.color)) z.color = zone.color;
      } else if (op === 'del') {
        histPush(r);
        r.zones = r.zones.filter(q => q.id !== zone.id);
      } else return;
    }
    push(r);
  });
  socket.on('gm:pin', ({ op, pin } = {}) => {
    const r = gm(); if (!r || !pin || typeof pin !== 'object') return;
    if (op === 'add') {
      histPush(r);
      r.pins.push({ id: crypto.randomUUID(), x: cl(pin.x, 0, r.map.w), y: cl(pin.y, 0, r.map.h), title: str(pin.title, 60), desc: str(pin.desc, 600) });
    } else {
      const p = r.pins.find(q => q.id === pin.id);
      if (!p) return;
      if (op === 'move') { p.x = cl(pin.x, 0, r.map.w); p.y = cl(pin.y, 0, r.map.h); }
      else if (op === 'edit') { histPush(r); p.title = str(pin.title, 60); p.desc = str(pin.desc, 600); }
      else if (op === 'del') { histPush(r); r.pins = r.pins.filter(q => q.id !== pin.id); }
      else return;
    }
    push(r);
  });

  /* ----- Itens: só o Mestre escreve bônus; o jogador só equipa ----- */
  socket.on('gm:item:save', ({ pid, item } = {}) => {
    const r = gm(), p = r && r.players[pid];
    if (!p || !item) return;
    const g = p.sheet.gear || (p.sheet.gear = []);
    const data = { name: str(item.name, 40) || 'Item', attr: GEAR_ATTRS.includes(item.attr) ? item.attr : 'DEF', bonus: cl(item.bonus, -3, 3), dd: cl(item.dd, 0, 3) };
    const ex = g.find(x => x.id === item.id);
    if (ex) Object.assign(ex, data);
    else { if (g.length >= MAX_ITEMS) return; g.push(Object.assign({ id: crypto.randomUUID(), eq: false }, data)); }
    push(r);
  });
  socket.on('gm:item:del', ({ pid, id } = {}) => {
    const r = gm(), p = r && r.players[pid];
    if (!p) return;
    p.sheet.gear = (p.sheet.gear || []).filter(x => x.id !== id);
    push(r);
  });
  socket.on('item:equip', ({ id, eq } = {}) => {
    const r = room(), p = r && r.players[socket.data.pid];
    if (!p) return;
    const it = (p.sheet.gear || []).find(x => x.id === id);
    if (!it) return;
    if (eq && p.sheet.gear.filter(x => x.eq).length >= MAX_EQUIP) return;
    it.eq = !!eq; push(r);
  });

  /* ----- NPCs (Mestre) ----- */
  /* ----- Múltiplos mapas (somente o Mestre) ----- */
  socket.on('gm:announce:start', (a = {}, cb) => {
    const r = gm(); if (!r) return cb && cb({ ok: false });
    const ann = sanitizeAnn(a);
    if (!ann) return cb && cb({ ok: false, error: 'Adicione ao menos um slide com texto' });
    r.announce = ann; push(r); cb && cb({ ok: true });
  });
  socket.on('gm:announce:close', () => {
    const r = gm(); if (r && r.announce) { r.announce = null; push(r); }
  });
  socket.on('gm:map:add', (m = {}, cb) => {
    const r = gm(); if (!r) return cb && cb({ ok: false });
    if (r.maps.length >= 8) return cb && cb({ ok: false, error: 'Limite de 8 mapas' });
    const nm = sanitizeMap(Object.assign({}, m, { id: crypto.randomUUID() }));
    r.maps.push(nm); switchMap(r, nm.id); cb && cb({ ok: true });
  });
  socket.on('gm:map:switch', ({ id } = {}) => { const r = gm(); if (r) switchMap(r, id); });
  socket.on('gm:map:del', ({ id } = {}, cb) => {
    const r = gm();
    if (!r) return;
    if (r.maps.length <= 1) return cb && cb({ ok: false, error: 'Precisa de ao menos um mapa' });
    const wasActive = r.map.id === id;
    r.maps = r.maps.filter(m => m.id !== id);
    if (wasActive) switchMap(r, r.maps[0].id); else push(r);
    cb && cb({ ok: true });
  });
  socket.on('gm:npc:save', ({ npc } = {}, cb) => {
    const r = gm();
    if (!r || !npc) return cb && cb({ ok: false, error: 'Sem permissão' });
    const a = npc.attrs || {};
    const data = {
      name: str(npc.name, 40) || 'NPC', desc: str(npc.desc, 300), avatar: avatarOk(npc.avatar),
      attrs: { F: cl(a.F, -1, 3), I: cl(a.I, -1, 3), A: cl(a.A, -1, 3), P: cl(a.P, -1, 3) },
      pv: cl(npc.pv, 1, 30), maxpv: cl(npc.pv, 1, 30), atk: cl(npc.atk, -3, 8), dano: cl(npc.dano, 0, 6), def: cl(npc.def, -3, 6)
    };
    const ex = r.npcs.find(x => x.id === npc.id);
    if (ex) Object.assign(ex, data, { pv: Math.min(ex.pv, data.maxpv), maxpv: data.maxpv });
    else {
      if (r.npcs.length >= MAX_NPCS) return cb && cb({ ok: false, error: 'Limite de NPCs atingido' });
      r.npcs.push(Object.assign({ id: crypto.randomUUID(), x: r.map.w / 2, y: r.map.h / 2 }, data, { pv: data.maxpv, conds: [], inScene: true }));
    }
    push(r); cb && cb({ ok: true });
  });
  // Em cena: só os NPCs marcados aparecem no mapa; os outros ficam guardados na sala
  socket.on('gm:npc:scene', ({ id, on } = {}) => {
    const r = gm(), n = r && (r.npcs || []).find(x => x.id === id);
    if (!n) return;
    n.inScene = !!on; push(r);
  });
  socket.on('gm:npc:del', ({ id } = {}) => {
    const r = gm(); if (!r) return;
    r.npcs = r.npcs.filter(n => n.id !== id); push(r);
  });
  socket.on('gm:npc:place', ({ id } = {}) => {
    const r = gm(), n = r && r.npcs.find(x => x.id === id); if (!n) return;
    n.x = r.map.w / 2; n.y = r.map.h / 2; push(r);
  });
  socket.on('gm:npc:move', ({ id, x, y } = {}) => {
    const r = gm(), n = r && r.npcs.find(x2 => x2.id === id); if (!n) return;
    n.x = cl(x, 0, r.map.w); n.y = cl(y, 0, r.map.h);
    socket.to(r.code).emit('npcmove', { id, x: n.x, y: n.y });
  });
  socket.on('gm:npc:adjust', ({ id, delta } = {}) => {
    const r = gm(), n = r && r.npcs.find(x => x.id === id); if (!n) return;
    n.pv = cl(n.pv + (+delta || 0), 0, n.maxpv); push(r);
  });
  // Ataque do NPC contra um jogador: 2d6 + ataque vs defesa 7 + bônus de Defesa dos itens
  // Rolagem do Mestre para um NPC: 2d6 + atributo do NPC + condições aplicáveis
  socket.on('gm:npc:roll', ({ id, attr } = {}) => {
    const r = gm(), n = r && (r.npcs || []).find(x => x.id === id);
    if (!n) return;
    const ok = ATTRS.includes(attr);
    const parts = ok
      ? [{ l: ATTR_NM[attr], v: (n.attrs || {})[attr] || 0 }, ...condParts(n.conds, attr)]
      : condParts(n.conds, null);
    const d = rollDice(parts, false);
    addLog(r, { type: 'npc', who: n.name, attr: ok ? attr : '', dice: d.kept, parts: d.parts, v: d.v, total: d.total, res: '' });
    push(r);
  });
  socket.on('gm:npc:attack', ({ npcId, targetId } = {}) => {
    const r = gm(), n = r && r.npcs.find(x => x.id === npcId), t = r && r.players[targetId];
    if (!n || !t) return;
    const d = rollDice([{ l: 'Ataque', v: n.atk }, ...condParts(n.conds, null)], false);
    const defense = 7 + gearBonus(t.sheet, 'DEF');
    const hit = d.total >= defense;
    const dmg = hit ? n.dano : 0;
    t.sheet.pv = Math.max(0, t.sheet.pv - dmg);
    addLog(r, { type: 'npc', who: n.name, dice: d.kept, parts: d.parts, v: d.v, total: d.total, res: hit ? `ACERTOU ${t.sheet.name} · −${dmg} PV` : `ERROU ${t.sheet.name}` });
    push(r);
  });
  socket.on('roll', ({ attr, adv } = {}) => {
    const r = room(); if (!r) return;
    const p = r.players[socket.data.pid];
    const ok = !!p && ATTRS.includes(attr);
    const parts = [];
    if (ok) {
      parts.push({ l: ATTR_NM[attr], v: p.sheet.attrs[attr] });
      const gb = gearBonus(p.sheet, attr);
      if (gb) parts.push({ l: 'Item', v: gb });
      parts.push(...condParts(p.sheet.conds, attr));
      parts.push(...rewardParts(r.event, socket.data.pid, attr));
    }
    const d = rollDice(parts, adv);
    addLog(r, { type: 'attr', who: p ? p.sheet.name : 'Mestre', attr: ok ? attr : '', adv: !!adv, dice: d.kept, parts: d.parts, v: d.v, total: d.total, res: tier(d.total) });
    push(r);
  });

  socket.on('dice:dmg', () => {
    const r = room(); if (!r) return;
    const p = r.players[socket.data.pid];
    const dd = p ? gearDice(p.sheet) : 0;
    const bonus = p ? gearBonus(p.sheet, 'DANO') : 0;
    const raw = Array.from({ length: dd }, () => rnd(6));
    const parts = bonus ? [{ l: 'Item dano', v: bonus }] : [];
    const total = raw.reduce((a, b) => a + b, 0) + bonus;
    addLog(r, { type: 'dano', who: p ? p.sheet.name : 'Mestre', dice: raw, parts, v: bonus, total, res: '' });
    push(r);
  });
  socket.on('dice:free', ({ sides, count, mod } = {}) => {
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
      timer: cl(x.timer, 0, 600), rule: RULES.includes(x.rule) ? x.rule : 'none',
      kind: KINDS.includes(x.kind) ? x.kind : 'teste',
      q: str(x.q, 600), ans: str(x.ans, 80), ci: x.ci !== false, lives: cl(x.lives || 3, 1, 9), mode: x.mode === 'single' ? 'single' : 'multi', carry: x.carry === 'carry' ? 'carry' : 'reset', reward: sanitizeReward(x.reward)
    }));
    if (!rounds.length) return cb && cb({ ok: false, error: 'Adicione ao menos uma rodada' });
    if (rounds.some(x => x.kind === 'enigma' && (!x.q || !x.ans))) return cb && cb({ ok: false, error: 'Enigma precisa de pergunta e resposta' });
    const members = Object.keys(r.players).filter(id => r.players[id].sheet.pv > 0);
    if (!members.length) return cb && cb({ ok: false, error: 'Nenhum jogador vivo na sala' });
    const cards = {}, scores = {};
    members.forEach(id => { cards[id] = { suit: SUITS[rnd(4) - 1] }; scores[id] = 0; });
    const jokerId = members[rnd(members.length) - 1];
    r.event = {
      title: str(ev.title, 40) || 'GAME', suit: SUITS.includes(ev.suit) ? ev.suit : '', solved: [], lives: {}, rewards: {}, nextLives: {}, rounds, phase: 'intro', idx: -1, rolls: {}, results: null,
      members, outcome: null, cards, jokerId, jokerUsed: false, jokerPlay: null, order: [],
      revealed: false, deadline: null, tmr: null, scores, npcRolled: {}
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
    const r = gm(); if (r && r.event && r.event.phase === 'round') endRound(r);
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

  socket.on('gm:event:lives', () => {
    const r = gm(), e = r && r.event;
    if (!e || e.phase !== 'round' || e.enigReveal) return;
    const rd = e.rounds[e.idx];
    if (!rd || rd.kind !== 'enigma') return;
    const bonusLife = e.suit === '♦' ? 1 : 0;
    for (const id of aliveIds(r)) e.lives[id] = rd.lives + bonusLife;
    e.startLives = { ...e.lives };
    e.sub = {};
    push(r);
  });
  socket.on('event:answer', ({ text } = {}) => {
    const r = room(), e = r && r.event;
    if (!e || e.phase !== 'round' || e.enigReveal) return;
    const pid = socket.data.pid, rd = e.rounds[e.idx];
    if (!pid || !rd || rd.kind !== 'enigma' || !isAlive(r, pid)) return;
    if (!e.lives || !(e.lives[pid] > 0)) return;
    if ((e.solved || []).includes(pid)) return;
    const sub = e.sub[pid] || (e.sub[pid] = { tries: 0, locked: false });
    if (sub.locked) return;
    const guess = normText(text, rd.ci);
    const ok = guess !== '' && guess.length <= 80 && guess === normText(rd.ans, rd.ci);
    sub.tries++;
    if (ok) { e.solved.push(pid); sub.locked = true; }
    else {
      e.lives[pid] -= 1;
      if (rd.mode === 'single' || e.lives[pid] <= 0) sub.locked = true;
    }
    push(r);
  });
  socket.on('event:roll', ({ joker } = {}) => {
    const r = room(), e = r && r.event;
    if (!e || e.phase !== 'round') return;
    const pid = socket.data.pid;
    if (!pid || !isAlive(r, pid) || e.rolls[pid]) return;
    if (e.rounds[e.idx].kind === 'enigma') return;
    const p = r.players[pid], rd = e.rounds[e.idx], card = e.cards[pid];
    const useJoker = !!joker && e.jokerId === pid && !e.jokerUsed;
    if (useJoker) { e.jokerUsed = true; e.jokerPlay = pid; }
    const adv = useJoker || hasSpec(p.sheet, rd);
    const parts = [];
    if (rd.attr) {
      parts.push({ l: ATTR_NM[rd.attr], v: p.sheet.attrs[rd.attr] });
      const gb = gearBonus(p.sheet, rd.attr);
      if (gb) parts.push({ l: 'Item', v: gb });
      if (card && card.suit === SUIT_OF[rd.attr]) parts.push({ l: 'Naipe', v: 1 });
    }
    parts.push(...condParts(p.sheet.conds, rd.attr || null));
    parts.push(...arenaParts(e, rd.attr));
    parts.push(...rewardParts(e, pid, rd.attr));
    const d = rollDice(parts, adv);
    const dmg = 0, extra = [];
    e.rolls[pid] = { dice: d.kept, total: d.total, v: d.v, adv, parts: d.parts, joker: useJoker, dmg, extra };
    e.order.push(pid);
    addLog(r, { type: 'event', who: p.sheet.name, attr: rd.attr, adv, dice: d.kept, parts: d.parts, v: d.v, total: d.total, joker: useJoker, dmgDice: extra, dmg, combat: rd.kind === 'combate', res: d.total >= rd.dc ? 'PASSOU' : 'FALHOU' });
    if (aliveIds(r).every(id => e.rolls[id])) resolveRound(r); else push(r);
  });

  /* ----- Condições: somente o Mestre aplica ou remove ----- */
  socket.on('gm:cond', ({ target, id, key, on } = {}, cb) => {
    const r = gm();
    if (!r) return cb && cb({ ok: false, error: 'Só o Mestre pode alterar condições' });
    if (!COND[key]) return cb && cb({ ok: false, error: 'Condição inválida' });
    const holder = target === 'npc' ? r.npcs.find(n => n.id === id) : (r.players[id] && r.players[id].sheet);
    if (!holder) return cb && cb({ ok: false, error: 'Alvo não encontrado' });
    const list = holder.conds || (holder.conds = []);
    if (on && !list.includes(key)) list.push(key);
    if (!on) holder.conds = list.filter(k => k !== key);
    push(r); cb && cb({ ok: true });
  });

  /* ----- Sessão, moderação e persistência ----- */
  socket.on('leave', (_, cb) => {
    const r = room();
    if (r) {
      if (socket.data.role === 'gm') {
        if (r.gmSock === socket.id) r.gmSock = null;
        socket.leave(r.code); socket.data.code = null; push(r);
      } else {
        removePlayer(r, socket.data.pid); socket.data.code = null; afterRemoval(r); push(r);
      }
    }
    cb && cb({ ok: true });
  });
  socket.on('gm:kick', ({ id } = {}, cb) => {
    const r = gm();
    if (!r || !r.players[id]) return cb && cb({ ok: false, error: 'Jogador não encontrado' });
    if (r.players[id].sock) io.to(r.players[id].sock).emit('kicked');
    removePlayer(r, id); afterRemoval(r); push(r);
    cb && cb({ ok: true });
  });
  socket.on('gm:export', (_, cb) => {
    const r = gm();
    if (!r) return cb && cb({ ok: false });
    cb && cb({ ok: true, data: exportRoom(r) });
  });
  socket.on('import', (d, cb) => {
    try {
      if (!d || d.app !== 'borderland-vtt') return cb && cb({ ok: false, error: 'Arquivo não é uma mesa válida' });
      const newCode = /^[A-Z0-9]{4}$/.test(String(d.code || '')) ? d.code : code();
      const old = rooms[newCode];
      if (old && old.gmSock) return cb && cb({ ok: false, error: 'Essa sala ainda está ativa com outro mestre' });
      if (old) clearT(old.event);
      const r = buildRoom(d, newCode, socket.id);
      rooms[newCode] = r;
      enter(r, 'gm');
      cb && cb({ ok: true, code: newCode, token: r.gmToken });
    } catch (err) {
      console.error('import:', err);
      cb && cb({ ok: false, error: 'Falha ao importar a mesa' });
    }
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
