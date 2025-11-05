// update.mjs — Node 20
// - Odds API H2H implied win prob
// - ESPN futures (auto-discover)
// - ESPN FPI (rich scrape: projected wins + probs + ratings)
// - ESPN current O/U (your existing hook, optional; kept as stub)
// - Caches last-good values if a fetch returns 0 teams

import fs from 'node:fs/promises';

const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const YEAR = new Date().getFullYear();

const U = s => (s ?? '').toUpperCase().trim();

// ---------- helpers ----------
function mlToProb(mlLike){
  if (mlLike == null) return null;
  const raw = String(mlLike).trim();
  const sign = raw.startsWith('-') ? -1 : 1;
  const num = Number(raw.replace(/^\+/, ''));
  if (!Number.isFinite(num)) return null;
  if (sign < 0) return (-num) / ((-num) + 100);
  return 100 / (num + 100);
}
function devigProbMap(raw){ // {TEAM: raw_p}
  const vals = Object.values(raw).filter(v => v > 0);
  const s = vals.reduce((a,b)=>a+b, 0);
  if (s <= 0) return {};
  const out = {};
  for (const [k,v] of Object.entries(raw)) if (v > 0) out[k] = v / s;
  return out;
}
async function safeJSON(url, init){
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function tryJSON(urls, init){
  for (const u of urls){
    try { return await safeJSON(u, init); } catch {}
  }
  return null;
}
function nicknameFromDisplayName(name){
  if (!name) return null;
  const parts = String(name).trim().split(/\s+/);
  return (parts[parts.length - 1] || '').toUpperCase(); // "Buffalo Bills" -> "BILLS"
}
const UA_HEADERS = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  'Accept':'text/html,application/xhtml+xml',
  'Accept-Language':'en-US,en;q=0.9',
  'Cache-Control':'no-cache'
};

// ---------- cache last-good predictions ----------
async function readLastPredictions(){
  try {
    const buf = await fs.readFile('data/predictions.json','utf8');
    return JSON.parse(buf);
  } catch { return null; }
}

// ---------- Odds API H2H (optional) ----------
async function fetchNFLOddsH2H(){
  if (!ODDS_API_KEY) return [];
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?regions=us&markets=h2h&oddsFormat=american&apiKey=${ODDS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`H2H odds failed: ${res.status}`);
  const games = await res.json();
  const byTeam = {};
  for (const g of games){
    const book = g.bookmakers?.[0];
    const m = book?.markets?.find(x => x.key === 'h2h');
    if (!m) continue;
    const H = U(g.home_team), A = U(g.away_team);
    const h = m.outcomes?.find(o => U(o.name) === H);
    const a = m.outcomes?.find(o => U(o.name) === A);
    const ph = mlToProb(h?.price);
    const pa = mlToProb(a?.price);
    if (ph != null && pa != null){
      const s = ph + pa;
      const nh = s > 0 ? ph / s : ph;
      const na = s > 0 ? pa / s : pa;
      byTeam[H] = { sport:'NFL', team:H, impliedNextGameWinProb:nh };
      byTeam[A] = { sport:'NFL', team:A, impliedNextGameWinProb:na };
    }
  }
  return Object.values(byTeam);
}

// ---------- ESPN futures (auto-discover) ----------
function kindFromTitleAndSize(title, size){
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
async function listFuturesRefs(){
  const base = y => `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${y}/futures`;
  const root = await tryJSON([base(YEAR), base(YEAR-1)]);
  if (!root) return [];
  const items = root.items || root.entries || [];
  return items.map(x => x?.$ref).filter(Boolean);
}
async function fetchMarketMeta(ref){
  const data = await safeJSON(ref, { headers: UA_HEADERS });
  const title = data?.name || data?.title || '';
  const futs = Array.isArray(data?.futures) ? data.futures : [];
  let teamMode = false, athleteMode = false, teamBooks = 0;
  for (const f of futs){
    for (const b of (f.books || [])){
      if (b.team?.$ref) { teamMode = true; teamBooks++; }
      if (b.athlete?.$ref) athleteMode = true;
    }
  }
  return { ref, title, futures: futs, teamMode, athleteMode, teamBooks };
}
async function resolveTeamName(refUrl, cache){
  if (!refUrl) return null;
  if (cache.has(refUrl)) return cache.get(refUrl);
  try{
    const tj = await safeJSON(refUrl, { headers: UA_HEADERS });
    const nm = U(tj?.displayName || tj?.name || tj?.abbreviation || '');
    cache.set(refUrl, nm);
    return nm;
  }catch{ return null; }
}
function extractMLfromBook(b){
  return b?.price?.american ?? b?.oddsAmerican ?? b?.odds?.american ?? b?.value ?? null;
}
async function extractTeamProbs(meta){
  const raw = {};
  const cache = new Map();
  for (const f of meta.futures || []){
    for (const b of (f.books || [])){
      if (!b.team?.$ref) continue;
      const team = await resolveTeamName(b.team.$ref, cache);
      const ml = extractMLfromBook(b);
      const p = mlToProb(ml);
      if (team && p != null) raw[team] = Math.max(raw[team] || 0, p);
    }
  }
  return devigProbMap(raw);
}
async function fetchESPNFuturesAuto(){
  const refs = await listFuturesRefs();
  const futures = {};
  let teamMkts = 0;
  for (const ref of refs){
    let meta; try { meta = await fetchMarketMeta(ref); } catch { continue; }
    if (!meta.teamMode || meta.athleteMode) continue;
    const probs = await extractTeamProbs(meta);
    const kind = kindFromTitleAndSize(meta.title, Object.keys(probs).length);
    if (!kind) continue;
    teamMkts++;
    for (const [team, p] of Object.entries(probs)){
      const T = U(team);
      futures[T] = futures[T] || {};
      futures[T][kind] = Math.max(futures[T][kind] || 0, p);
    }
  }
  console.log(`ESPN futures parsed: teamMarkets=${teamMkts}, teamsWithAny=${Object.keys(futures).length}`);
  return futures;
}

// ---------- ESPN FPI rich (scrape) ----------
function num(x){ const n = Number(x); return Number.isFinite(n) ? n : null; }

async function fetchESPNFPIRich(){
  const url = 'https://www.espn.com/nfl/fpi';
  let html = '';
  try{
    const res = await fetch(url, { headers: UA_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  }catch(e){
    console.error('FPI fetch failed:', e?.message || e);
    return {};
  }

  // Primary pattern: team block with projectedWins nearby
  const teamBlockRx = /"displayName"\s*:\s*"([^"]+)"[\s\S]{0,800}?"abbreviation"\s*:\s*"([A-Z0-9]{2,4})"[\s\S]{0,1600}?"projectedWins"\s*:\s*([0-9.]+)/g;

  const out = {};
  let m, hits = 0;
  while ((m = teamBlockRx.exec(html)) !== null){
    const displayName = m[1];
    const abbr = m[2];
    const projWins = num(m[3]);
    const nick = nicknameFromDisplayName(displayName);
    if (!nick || !Number.isFinite(projWins)) continue;

    // harvest a local window around the current match for more fields
    const start = Math.max(0, teamBlockRx.lastIndex - 2200);
    const end   = Math.min(html.length, teamBlockRx.lastIndex + 2200);
    const blob  = html.slice(start, end);

    const get = (label) => {
      const rx = new RegExp(`"${label}"\\s*:\\s*([0-9.]+)`);
      const mm = rx.exec(blob);
      return mm ? num(mm[1]) : null;
    };

    const projLoss = get('projectedLosses');
    const fpi      = get('fpi');
    const fpiRank  = get('fpiRank');
    const offFPI   = get('offenseFpi');
    const defFPI   = get('defenseFpi');
    const stFPI    = get('specialTeamsFpi');
    const makePO   = get('makePlayoffs');   // often 0–100
    const winDiv   = get('winDivision');    // 0–100
    const winConf  = get('winConference');  // 0–100
    const winSB    = get('winSuperBowl');   // 0–100
    const sosRem   = get('sosRemaining');

    out[nick] = {
      name: displayName,
      abbr,
      nick,
      projected_wins: projWins,
      projected_losses: projLoss,
      fpi, fpi_rank: fpiRank,
      off_fpi: offFPI, def_fpi: defFPI, st_fpi: stFPI,
      make_playoffs: makePO, win_division: winDiv, win_conference: winConf, win_super_bowl: winSB,
      sos_remaining: sosRem
    };
    hits++;
  }

  // Fallback diagnostic: how many "projectedWins" tokens exist at all?
  const pwAll = [...html.matchAll(/"projectedWins"\s*:\s*[0-9.]+/g)].length;
  console.log(`FPI rich: teams=${Object.keys(out).length}, blocks=${hits}, projectedWinsTokens=${pwAll}`);

  return out;
}

// ---------- ESPN current O/U (season wins) ----------
async function fetchESPNCurrentOU() {
  // If you’ve already got a working implementation, keep it.
  // Leaving as empty to avoid overwriting with {} unless we actually parse some.
  return {};
}

// ---------- main ----------
async function main(){
  const prev = await readLastPredictions();

  let nflNextGame = [];
  try { nflNextGame = await fetchNFLOddsH2H(); }
  catch(e){ console.error('H2H fetch failed:', e?.message || e); }

  let nflFutures = {};
  try { nflFutures = await fetchESPNFuturesAuto(); }
  catch(e){ console.error('ESPN futures failed:', e?.message || e); }

  let nflFPI = {};
  try { nflFPI = await fetchESPNFPIRich(); }
  catch(e){ console.error('FPI scrape failed:', e?.message || e); }

  let nflCurrentOU = {};
  try { nflCurrentOU = await fetchESPNCurrentOU(); }
  catch(e){ console.error('Current OU fetch failed:', e?.message || e); }

  // Cache-preserving: if a section came back empty, keep previous non-empty
  if ((!nflFPI || !Object.keys(nflFPI).length) && prev?.nflFPI && Object.keys(prev.nflFPI).length) {
    console.log('Keeping cached nflFPI (empty this run)');
    nflFPI = prev.nflFPI;
  }
  if ((!nflCurrentOU || !Object.keys(nflCurrentOU).length) && prev?.nflCurrentOU && Object.keys(prev.nflCurrentOU).length) {
    console.log('Keeping cached nflCurrentOU (empty this run)');
    nflCurrentOU = prev.nflCurrentOU;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    sources: {
      nflNextGame: 'The Odds API (h2h)',
      nflFutures:  'ESPN futures (auto-discovered; de-vigged)',
      nflFPI:      'ESPN FPI (rich scrape: proj wins, probs, ratings)',
      nflCurrentOU:'ESPN Season Wins (if parsed; falls back to cache)'
    },
    nflNextGame,
    nflFutures,
    nflFPI,
    nflCurrentOU
  };

  await fs.writeFile('data/predictions.json', JSON.stringify(payload, null, 2), 'utf8');
  console.log('✅ Wrote data/predictions.json',
              'futuresTeams=', Object.keys(nflFutures).length,
              'fpiTeams=', Object.keys(nflFPI).length,
              'currentOU=', Object.keys(nflCurrentOU).length);
}

main().catch(e => { console.error(e); process.exit(1); });
