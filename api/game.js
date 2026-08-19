// Nightfall backend — one shared deck, live lobby, persistent Elo.
// Needs a Redis store attached in Vercel (Storage tab).

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

const TTL = 43200;          // a running game lives 12 hours
const LOBBY_TTL = 3600;     // a lobby nobody starts frees its code after an hour
const ELO_KEY = 'nf:elo';
const START = 1200;
const K = 20;      // pot size per head on the smaller side
const CAP = 40;    // most any one player can move in a single game

async function redis(args) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const gk = (code) => 'nf:g:' + code;

async function getGame(code) {
  const raw = await redis(['GET', gk(code)]);
  return raw ? JSON.parse(raw) : null;
}
async function putGame(code, g) {
  const life = g.status === 'lobby' ? LOBBY_TTL : TTL;
  await redis(['SET', gk(code), JSON.stringify(g), 'EX', String(life)]);
}

/* ---------- deck ---------- */
function makeDeck(s) {
  const d = [];
  for (let i = 0; i < s.mafia; i++) d.push('mafia');
  if (s.doctor) d.push('doctor');
  if (s.detective) d.push('detective');
  while (d.length < s.size) d.push('villager');
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
async function freshCode() {
  const AB = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // no I, O, 0 or 1 to mishear
  for (let tries = 0; tries < 12; tries++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += AB[Math.floor(Math.random() * AB.length)];
    const taken = await redis(['EXISTS', gk(s)]);
    if (!Number(taken)) return s;
  }
  throw new Error('Could not find a free code, try again.');
}

/* ---------- atomic join ---------- */
// Two people tapping join at the same instant must not land on the same card,
// so the whole read-check-write runs inside Redis as one step.
const JOIN_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '{"error":"nogame"}' end
local g = cjson.decode(raw)
if g.players[ARGV[1]] ~= nil then
  return cjson.encode({ok = true, idx = g.players[ARGV[1]].idx})
end
if g.status ~= 'lobby' then return '{"error":"started"}' end
local n = 0
for _ in pairs(g.players) do n = n + 1 end
if n >= g.size then return '{"error":"full"}' end
g.players[ARGV[1]] = {name = ARGV[2], idx = n}
redis.call('SET', KEYS[1], cjson.encode(g), 'EX', ARGV[3])
return cjson.encode({ok = true, idx = n})
`;

/* ---------- elo ---------- */
async function readElo(names) {
  if (!names.length) return {};
  const out = {};
  const vals = await redis(['HMGET', ELO_KEY, ...names.map((n) => n.toLowerCase())]);
  names.forEach((n, i) => {
    let v = null;
    try { v = vals[i] ? JSON.parse(vals[i]) : null; } catch (e) {}
    out[n.toLowerCase()] = v || { name: n, r: START, g: 0, w: 0 };
  });
  return out;
}
function expected(a, b) { return 1 / (1 + Math.pow(10, (b - a) / 400)); }

// Mafia and villagers do not win equally often, and that has nothing to do with
// skill — it is baked into how many mafia are in the deck. Two mafia in eight is
// roughly even; one in eight is a slaughter for the villagers. So before comparing
// ratings we give the mafia side a handicap for the deck they were dealt, and
// judge each side against what that deck says they should have managed.
function baselineMafiaWinRate(mafia, total) {
  const r = mafia / total;
  return Math.min(0.75, Math.max(0.25, 0.5 + 2 * (r - 0.25)));
}

async function applyElo(roster, winner) {
  const names = roster.map((p) => p.name);
  const cur = await readElo(names);

  const mafia = roster.filter((p) => p.role === 'mafia');
  const town = roster.filter((p) => p.role !== 'mafia');
  const m = mafia.length, t = town.length;
  if (!m || !t) return [];

  const avg = (list) =>
    list.reduce((s, p) => s + cur[p.name.toLowerCase()].r, 0) / list.length;
  const mAvg = avg(mafia), tAvg = avg(town);

  const p = baselineMafiaWinRate(m, roster.length);
  const handicap = -400 * Math.log10(1 / p - 1);          // in rating points
  const eMafia = expected(mAvg + handicap, tAvg);
  const sMafia = winner === 'mafia' ? 1 : 0;

  // One pot, split between the sides. Whatever one side gains, the other loses —
  // no points appear from nowhere. The pot scales with the smaller side, so a
  // two-against-six win is worth more per head to the two than to the six.
  const pot = K * Math.min(m, t) * (sMafia - eMafia);

  const raw = roster.map((pl) => ({
    name: pl.name,
    role: pl.role,
    d: pl.role === 'mafia' ? pot / m : -pot / t,
  }));

  // Keep any single swing sane without breaking the balance: if one is over the
  // cap, scale everyone by the same factor.
  const biggest = Math.max(...raw.map((x) => Math.abs(x.d)));
  const squeeze = biggest > CAP ? CAP / biggest : 1;

  // Rounding can lose or invent a point; hand the difference to the largest mover.
  const rounded = raw.map((x) => Object.assign({}, x, { d: Math.round(x.d * squeeze) }));
  const drift = rounded.reduce((s, x) => s + x.d, 0);
  if (drift !== 0) {
    let big = 0;
    rounded.forEach((x, i) => { if (Math.abs(x.d) > Math.abs(rounded[big].d)) big = i; });
    rounded[big].d -= drift;
  }

  const deltas = [];
  const writes = [];
  for (const x of rounded) {
    const key = x.name.toLowerCase();
    const rec = cur[key];
    const won = (x.role === 'mafia') === (winner === 'mafia');
    const next = { name: x.name, r: rec.r + x.d, g: rec.g + 1, w: rec.w + (won ? 1 : 0) };
    deltas.push({ name: x.name, role: x.role, before: rec.r, after: next.r, delta: x.d });
    writes.push(key, JSON.stringify(next));
  }
  if (writes.length) await redis(['HSET', ELO_KEY, ...writes]);
  return deltas;
}

/* ---------- shape the state for one client ---------- */
function view(g, client) {
  const roster = Object.entries(g.players)
    .map(([id, p]) => ({ id, name: p.name, idx: p.idx }))
    .sort((a, b) => a.idx - b.idx);

  const me = g.players[client] || null;
  const out = {
    code: g.code,
    size: g.size,
    settings: { mafia: g.mafia, doctor: g.doctor, detective: g.detective },
    status: g.status,
    round: g.round || 1,
    isHost: g.host === client,
    joined: roster.length,
    players: roster.map((p) => ({ name: p.name, idx: p.idx, me: p.id === client })),
    me: me ? { name: me.name, idx: me.idx } : null,
  };
  if (me && g.status !== 'lobby') out.me.role = g.deck[me.idx];
  if (g.status === 'ended') {
    out.result = {
      winner: g.winner,
      deltas: g.deltas || [],
      roles: roster.map((p) => ({ name: p.name, role: g.deck[p.idx] })),
    };
  }
  if (g.host === client && g.status !== 'lobby') {
    out.sheet = roster.map((p) => ({ name: p.name, role: g.deck[p.idx] }));
  }
  return out;
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  if (!URL_ || !TOKEN) {
    return res.status(500).json({
      error:
        'No storage attached yet. In Vercel: Storage tab, create an Upstash Redis database, connect it to this project, then redeploy.',
    });
  }

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const q = req.query || {};
    const action = String(q.action || b.action || '');
    const client = String(b.client || q.client || '').slice(0, 64);
    const code = String(b.code || q.code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

    if (action === 'board') {
      const all = await redis(['HGETALL', ELO_KEY]);
      const rows = [];
      for (let i = 1; i < (all || []).length; i += 2) {
        try {
          const v = JSON.parse(all[i]);
          if (v && v.g) rows.push(v);
        } catch (e) {}
      }
      rows.sort((x, y) => y.r - x.r || y.g - x.g);
      return res.status(200).json({ rows });
    }

    if (action === 'create') {
      const size = parseInt(b.size, 10);
      const mafia = parseInt(b.mafia, 10);
      if (!(size >= 4 && size <= 24)) return res.status(400).json({ error: 'Bad player count.' });
      if (!(mafia >= 1 && mafia < Math.ceil(size / 2)))
        return res.status(400).json({ error: 'Bad mafia count.' });
      const s = { size, mafia, doctor: !!b.doctor, detective: !!b.detective };
      if (mafia + (s.doctor ? 1 : 0) + (s.detective ? 1 : 0) > size)
        return res.status(400).json({ error: 'More special roles than players.' });

      const c = String(b.wanted || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      let final;
      if (c) {
        if (c.length < 3 || c.length > 6)
          return res.status(400).json({ error: 'A custom code needs 3 to 6 letters or numbers.' });
        const old = await getGame(c);
        // Closing a tab tells us nothing, so a code can look taken when the game
        // behind it is abandoned. Take it back if it's yours, if nobody ever
        // joined, or if that game already finished.
        const reclaimable =
          !old ||
          old.host === client ||
          old.status === 'ended' ||
          Object.keys(old.players || {}).length === 0;
        if (!reclaimable)
          return res.status(409).json({ error: 'A game is running on that code right now.' });
        final = c;
      } else {
        final = await freshCode();
      }
      const g = {
        code: final, host: client, status: 'lobby',
        size, mafia, doctor: s.doctor, detective: s.detective,
        deck: makeDeck(s), players: {}, round: 1,
      };
      await putGame(final, g);
      return res.status(200).json(view(g, client));
    }

    if (!code) return res.status(400).json({ error: 'Missing game code.' });

    if (action === 'join') {
      const name = String(b.name || '').trim().slice(0, 18);
      if (!name) return res.status(400).json({ error: 'Pick a name first.' });
      const raw = await redis(['EVAL', JOIN_LUA, '1', gk(code), client, name, String(LOBBY_TTL)]);
      const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (r.error === 'nogame') return res.status(404).json({ error: 'No game with that code.' });
      if (r.error === 'full') return res.status(409).json({ error: 'That game is already full.' });
      if (r.error === 'started')
        return res.status(409).json({ error: 'That game has already started.' });
      const g = await getGame(code);
      return res.status(200).json(view(g, client));
    }

    if (action === 'state') {
      const g = await getGame(code);
      if (!g) return res.status(404).json({ error: 'No game with that code.' });
      return res.status(200).json(view(g, client));
    }

    if (action === 'start') {
      const g = await getGame(code);
      if (!g) return res.status(404).json({ error: 'No game with that code.' });
      if (g.host !== client) return res.status(403).json({ error: 'Only the host can start.' });
      if (Object.keys(g.players).length < 4)
        return res.status(400).json({ error: 'Need at least four players.' });
      // Deal for exactly who turned up, not who was expected.
      const n = Object.keys(g.players).length;
      if (n < g.size) {
        g.size = n;
        g.mafia = Math.min(g.mafia, Math.max(1, Math.ceil(n / 2) - 1));
        g.deck = makeDeck({ size: n, mafia: g.mafia, doctor: g.doctor, detective: g.detective });
      }
      g.status = 'playing';
      await putGame(code, g);
      return res.status(200).json(view(g, client));
    }

    if (action === 'end') {
      const winner = b.winner === 'mafia' ? 'mafia' : 'town';
      const g = await getGame(code);
      if (!g) return res.status(404).json({ error: 'No game with that code.' });
      if (g.host !== client) return res.status(403).json({ error: 'Only the host can end it.' });
      if (g.status === 'ended') return res.status(200).json(view(g, client));

      const roster = Object.values(g.players)
        .sort((a, c) => a.idx - c.idx)
        .map((p) => ({ name: p.name, role: g.deck[p.idx] }));
      g.deltas = await applyElo(roster, winner);
      g.winner = winner;
      g.status = 'ended';
      await putGame(code, g);
      return res.status(200).json(view(g, client));
    }

    if (action === 'rematch') {
      const g = await getGame(code);
      if (!g) return res.status(404).json({ error: 'No game with that code.' });
      if (g.host !== client) return res.status(403).json({ error: 'Only the host can redeal.' });
      const n = Object.keys(g.players).length;
      g.size = n;
      g.mafia = Math.min(g.mafia, Math.max(1, Math.ceil(n / 2) - 1));
      g.deck = makeDeck({ size: n, mafia: g.mafia, doctor: g.doctor, detective: g.detective });
      g.status = 'playing';
      g.round = (g.round || 1) + 1;
      delete g.winner;
      delete g.deltas;
      await putGame(code, g);
      return res.status(200).json(view(g, client));
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ error: 'Server error: ' + e.message });
  }
}
