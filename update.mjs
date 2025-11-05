// update.mjs — pulls ESPN futures, The Odds API, and ESPN FPI projections
import fs from 'node:fs/promises';

// optional: set ODDS_API_KEY in your environment if you want next-game win probs
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const YEAR = new Date().getFullYear();

const U = s => (s ?? '').toUpperCase().trim();

/* ---------- basic helpers ---------- */
function mlToProb(mlLike) {
  if (mlLike == null) return null;
  const str = String(mlLike).replace(/^\s*\+?/, '');
  const n = Number(str.startsWith('-') ? str : ('+' + str));
  if (!isFinite(n)) return null;
  return n < 0 ? (-n) / ((-n) + 100) : 100 / (n + 100);
}
function devigProbMap(raw) {
  const vals = Object.values(raw).filter(v => v > 0);
  const s = vals.reduce((a, b) => a + b, 0);
  if (s <= 0) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) if (v > 0) out[k] = v / s;
  return out;
}
async function safeJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function tryJSON(urls) {
  for (const u of urls) {
    try { return await safeJSON(u); } catch {}
  }
  return null;
}

/* ---------- The Odds API ---------- */
async function fetchNFLOddsH2H() {
  if (!ODDS_API_KEY) return [];
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?regions=us&markets=h2h&oddsFormat=american&apiKey=${ODDS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`H2H odds failed: ${res.status}`);
  const games = await res.json();
  const byTeam = {};
  for (const g of games) {
    const book = g.bookmakers?.[0];
    const m = book?.markets?.find(x => x.key === 'h2h');
    if (!m) continue;
    const H = U(g.home_team), A = U(g.away_team);
    const h = m.outcomes?.find(o => U(o.name) === H);
    const a = m.outcomes?.find(o => U(o.name) === A);
    const ph = mlToProb(h?.price);
    const pa = mlToProb(a?.price);
    if (ph != null && pa != null) {
      const s = ph + pa;
      const nh = s > 0 ? ph / s : ph;
      const na = s > 0 ? pa / s : pa;
      byTeam[H] = { sport: 'NFL', team: H, impliedNextGameWinProb: nh };
      byTeam[A] = { sport: 'NFL', team: A, impliedNextGameWinProb: na };
    }
  }
  return Object.values(byTeam);
}

/* ---------- ESPN futures (team markets) ---------- */
function kindFromTitleAndSize(title, size) {
  const t = U(title);
  if (t.includes('SUPER BOWL')) return 'sb';
  if (t.includes('CONFERENCE CHAMP')) return 'reach_sb';
  if (t.includes('WIN AFC') || t.includes('AFC CHAMPION')) return 'reach_sb';
  if (t.includes('WIN NFC') || t.includes('NFC CHAMPION')) return 'reach_sb';
  if (t.includes('MAKE PLAYOFFS')) return 'make_playoffs';
  if (t.includes('DIVISION')) return 'div';
  if (size >= 30) return 'sb';
  if (size >= 14 && size <= 18) return 'reach_sb';
  if (size >= 4 && size <= 6 && /EAST|NORTH|SOUTH|WEST/.test(t)) return 'div';
  return null;
}

async function listFuturesRefs() {
  const base = y => `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${y}/futures`;
  const root = await tryJSON([base(YEAR), base(YEAR - 1)]);
  if (!root) return [];
  const items = root.items || root.entries || [];
  return items.map(x => x?.$ref).filter(Boolean);
}

async function fetchMarketMeta(ref) {
  const data = await safeJSON(ref);
  const title = data?.name || data?.title || '';
  const futs = Array.isArray(data?.futures) ? data.futures : [];
  let teamMode = false, athleteMode = false;
  for (const f of futs) {
    for (const b of (f.books || [])) {
      if (b.team?.$ref) teamMode = true;
      if (b.athlete?.$ref) athleteMode = true;
    }
  }
  return { ref, title, futures: futs, teamMode, athleteMode };
}

async function resolveTeamName(refUrl, cache) {
  if (!refUrl) return null;
  if (cache.has(refUrl)) return cache.get(refUrl);
  try {
    const tj = await safeJSON(refUrl);
    const nm = U(tj?.displayName || tj?.name || tj?.abbreviation || '');
    cache.set(refUrl, nm);
    return nm;
  } catch { return null; }
}

function extractMLfromBook(b) {
  return (
    b?.price?.american ??
    b?.oddsAmerican ??
    b?.odds?.american ??
    b?.value ?? null
  );
}

async function extractTeamProbs(meta) {
  const raw = {};
  const teamCache = new Map();
  for (const f of meta.futures || []) {
    for (const b of (f.books || [])) {
      if (!b.team?.$ref) continue;
      const team = await resolveTeamName(b.team.$ref, teamCache);
      const ml = extractMLfromBook(b);
      const p = mlToProb(ml);
      if (team && p != null) raw[team] = Math.max(raw[team] || 0, p);
    }
  }
  return devigProbMap(raw);
}

async function fetchESPNFuturesAuto() {
  const refs = await listFuturesRefs();
  const futures = {};
  for (const ref of refs) {
    let meta; try { meta = await fetchMarketMeta(ref); } catch { continue; }
    const { title, teamMode, athleteMode } = meta;
    if (athleteMode && !teamMode) continue;
    if (!teamMode) continue;
    const probs = await extractTeamProbs(meta);
    const kind = kindFromTitleAndSize(title, Object.keys(probs).length);
    if (!kind) continue;
    for (const [team, p] of Object.entries(probs)) {
      const T = U(team);
      futures[T] = futures[T] || {};
      futures[T][kind] = Math.max(futures[T][kind] || 0, p);
    }
  }
  console.log('Fetched ESPN futures: teams=', Object.keys(futures).length);
  return futures;
}

// --- ESPN FPI projections (uses ?xhr=1 JSON, with HTML inside) ---
async function fetchESPNFPIProjectionTable() {
  const BASE = 'https://www.espn.com/nfl/fpi/_/view/projections';
  // Helper to turn "Buffalo Bills" -> "BILLS"
  const nickFromFull = (name) => {
    if (!name) return null;
    const parts = String(name).trim().split(/\s+/);
    return (parts[parts.length - 1] || '').toUpperCase();
  };
  const toNum = (s) => {
    const n = Number(String(s).replace(/[,%]/g,'').trim());
    return Number.isFinite(n) ? n : null;
  };

  // 1) Try the XHR JSON endpoint (preferred)
  try {
    const res = await fetch(`${BASE}?xhr=1`, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json,text/html,*/*'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();

    // The JSON typically holds HTML in "content" fields; flatten them
    const htmlChunks = [];
    (function collect(node){
      if (!node || typeof node !== 'object') return;
      if (typeof node.content === 'string') htmlChunks.push(node.content);
      for (const v of Array.isArray(node) ? node : Object.values(node)) collect(v);
    })(j);

    const html = htmlChunks.join('\n');
    // Save for debugging
    try { await fs.writeFile('data/debug-fpi-xhr.json', JSON.stringify(j, null, 2), 'utf8'); } catch {}
    try { await fs.writeFile('data/debug-fpi-xhr.html', html, 'utf8'); } catch {}

    // Parse rows out of the HTML we just collected
    const out = {};
    const rowRx = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = rowRx.exec(html)) !== null) {
      const row = m[1];
      const cells = Array.from(row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi))
        .map(x => x[1].replace(/<[^>]+>/g, '').replace(/\s+/g,' ').trim());
      // Expecting at least 9 tds: Team | W-L-T | PROJ W-L | PLAYOFF% | WIN DIV% | MAKE DIV% | MAKE CONF% | MAKE SB% | WIN SB%
      if (cells.length < 9) continue;

      const teamFull = cells[0];
      const projWL   = cells[2];   // e.g., "12.0-5.0"
      const playoff  = toNum(cells[3]);
      const winDiv   = toNum(cells[4]);
      const makeConf = toNum(cells[6]);
      const makeSB   = toNum(cells[7]);
      const winSB    = toNum(cells[8]);

      if (!teamFull || !projWL) continue;
      const projWins = toNum(projWL.split('-')[0]);
      const nick = nickFromFull(teamFull);
      if (!nick || projWins == null) continue;

      out[nick] = {
        projected_wins: projWins,
        playoff: (playoff ?? 0) / 100,
        div:     (winDiv  ?? 0) / 100,
        conf:    (makeConf?? 0) / 100,
        sb:      (makeSB  ?? 0) / 100,
        win_sb:  (winSB   ?? 0) / 100
      };
    }

    console.log('FPI (xhr) parsed teams =', Object.keys(out).length);
    if (Object.keys(out).length) return out;
  } catch (e) {
    console.error('FPI xhr fetch failed:', e?.message || e);
  }

  // 2) Fallback to plain HTML (in case xhr=1 is blocked)
  try {
    const res = await fetch(BASE, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    try { await fs.writeFile('data/debug-fpi-page.html', html, 'utf8'); } catch {}

    const out = {};
    const rowRx = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = rowRx.exec(html)) !== null) {
      const row = m[1];
      const cells = Array.from(row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi))
        .map(x => x[1].replace(/<[^>]+>/g, '').replace(/\s+/g,' ').trim());
      if (cells.length < 9) continue;

      const teamFull = cells[0];
      const projWL   = cells[2];
      const playoff  = toNum(cells[3]);
      const winDiv   = toNum(cells[4]);
      const makeConf = toNum(cells[6]);
      const makeSB   = toNum(cells[7]);
      const winSB    = toNum(cells[8]);

      if (!teamFull || !projWL) continue;
      const projWins = toNum(projWL.split('-')[0]);
      const nick = nickFromFull(teamFull);
      if (!nick || projWins == null) continue;

      out[nick] = {
        projected_wins: projWins,
        playoff: (playoff ?? 0) / 100,
        div:     (winDiv  ?? 0) / 100,
        conf:    (makeConf?? 0) / 100,
        sb:      (makeSB  ?? 0) / 100,
        win_sb:  (winSB   ?? 0) / 100
      };
    }
    console.log('FPI (html) parsed teams =', Object.keys(out).length);
    return out;
  } catch (e) {
    console.error('FPI plain fetch failed:', e?.message || e);
    return {};
  }
}

/* ---------- main ---------- */
async function main() {
  let nflNextGame = [];
  try { nflNextGame = await fetchNFLOddsH2H(); }
  catch (e) { console.error('H2H fetch failed:', e?.message || e); }

  let nflFutures = {};
  try { nflFutures = await fetchESPNFuturesAuto(); }
  catch (e) { console.error('ESPN futures failed:', e?.message || e); }

  let nflFPI = {};
  try { nflFPI = await fetchESPNFPIProjectionTable(); }
  catch (e) { console.error('FPI projection table failed:', e?.message || e); }

  const payload = {
    generatedAt: new Date().toISOString(),
    sources: {
      nflNextGame: 'The Odds API (h2h)',
      nflFutures: 'ESPN futures (auto-discovered)',
      nflFPI: 'ESPN FPI projections table scrape'
    },
    nflNextGame,
    nflFutures,
    nflFPI
  };

  await fs.writeFile('data/predictions.json', JSON.stringify(payload, null, 2), 'utf8');
  console.log(
    'Wrote data/predictions.json.',
    'teamsWithFutures=', Object.keys(nflFutures).length,
    'teamsWithFPI=', Object.keys(nflFPI).length
  );
}

main().catch(e => { console.error(e); process.exit(1); });
