// update.mjs — Robust ESPN futures -> probabilities (de-vigged) + OddsAPI H2H
// Node 18+ (global fetch). Writes data/predictions.json
import fs from 'node:fs/promises';

const ODDS_API_KEY = process.env.ODDS_API_KEY || '';

function up(s){ return (s||'').toUpperCase().trim(); }
function moneylineToProb(ml){
  const n = Number(ml);
  if (!isFinite(n)) return null;
  return n < 0 ? (-n) / ((-n) + 100) : 100 / (n + 100);
}
function devigProbMap(rawMap){ // {TEAM: raw_p}
  const vals = Object.values(rawMap).filter(v => v > 0);
  const s = vals.reduce((a,b)=>a+b, 0);
  if (s <= 0) return {};
  const out = {};
  for (const [k,v] of Object.entries(rawMap)) if (v > 0) out[k] = v / s;
  return out;
}

async function safeJSON(url){
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function tryFetchJSON(urls){
  for (const u of urls){
    try { return await safeJSON(u); } catch(_) {}
  }
  return null;
}

// ---------- Odds API (optional) for next-game implied win % ----------
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
    const H = up(g.home_team), A = up(g.away_team);
    const h = m.outcomes?.find(o => up(o.name) === H);
    const a = m.outcomes?.find(o => up(o.name) === A);
    const ph = moneylineToProb(h?.price);
    const pa = moneylineToProb(a?.price);
    if (ph != null && pa != null){
      const s = ph + pa; // de-vig 2-way
      const nh = s > 0 ? ph / s : ph;
      const na = s > 0 ? pa / s : pa;
      byTeam[H] = { sport:'NFL', team:H, impliedNextGameWinProb:nh };
      byTeam[A] = { sport:'NFL', team:A, impliedNextGameWinProb:na };
    }
  }
  return Object.values(byTeam);
}

// ---------- ESPN futures (robust) ----------
const YEAR = new Date().getFullYear();

// Known good IDs
const FUTURE_IDS = {
  sb: [1561],                 // Super Bowl winner
  afcChamp: [2757],           // Win AFC (reach SB)
  nfcChamp: [3904],           // Win NFC (reach SB)
  afcDivs: [2740,2738,2737,2739], // EAST, NORTH, SOUTH, WEST
  nfcDivs: [3906,3905,3908,3907], // EAST, NORTH, SOUTH, WEST
  // ESPN sometimes publishes “make playoffs” under different ids per season/provider.
  // Try a handful of historical ids; we’ll use whatever returns.
  makePO: [11267, 11520, 11521, 11522, 11523] // best-effort guesses; harmless if 404/empty
};

// Given an ESPN futures collection, pick the entry with the most books, then
// resolve team refs and convert American odds -> probabilities, de-vig within that market.
async function fetchESPNFutureCollection(id){
  const urls = [
    `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${YEAR}/futures/${id}`,
    `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${YEAR-1}/futures/${id}`,
  ];
  const data = await tryFetchJSON(urls);
  if (!data) return null;

  // Choose the futures entry with the largest number of books
  let best = null;
  for (const f of (data.futures || [])){
    const count = (f.books || []).length;
    if (count && (!best || count > (best.books?.length || 0))) best = f;
  }
  if (!best || !best.books?.length) return null;

  // Resolve each book's team ref once (cache by URL)
  const teamCache = new Map();
  async function resolveTeamName(ref){
    if (!ref) return null;
    if (teamCache.has(ref)) return teamCache.get(ref);
    try{
      const tj = await safeJSON(ref);
      const nm = up(tj?.displayName || tj?.name || tj?.abbreviation || '');
      teamCache.set(ref, nm);
      return nm;
    }catch(_){
      return null;
    }
  }

  // Build raw prob map (team -> raw probability from ML)
  const raw = {};
  for (const b of best.books){
    const tRef = b.team?.$ref;
    const team = await resolveTeamName(tRef);
    const ml = b?.price?.american ?? b?.oddsAmerican ?? b?.odds?.american;
    const p = moneylineToProb(ml);
    if (team && p != null){
      // keep the MAX raw prob across entries (then de-vig once at the end)
      raw[team] = Math.max(raw[team] || 0, p);
    }
  }
  // De-vig within the market
  return devigProbMap(raw); // {TEAM: prob}
}

// Fetch and merge multiple ids for a given label; keep MAX prob per team (cross-provider)
async function fetchESPNFuturesMerged(ids){
  const out = {};
  for (const id of ids){
    try{
      const m = await fetchESPNFutureCollection(id);
      if (!m) continue;
      for (const [team, p] of Object.entries(m)){
        const T = up(team);
        out[T] = Math.max(out[T] || 0, p);
      }
    }catch(_){}
  }
  return out;
}

async function fetchAllESPNFutures(){
  // Parallel fetches
  const [
    sb, afc, nfc,
    afcDivE, afcDivN, afcDivS, afcDivW,
    nfcDivE, nfcDivN, nfcDivS, nfcDivW,
    makePO // may be empty
  ] = await Promise.all([
    fetchESPNFuturesMerged(FUTURE_IDS.sb),
    fetchESPNFuturesMerged(FUTURE_IDS.afcChamp),
    fetchESPNFuturesMerged(FUTURE_IDS.nfcChamp),
    fetchESPNFuturesMerged([FUTURE_IDS.afcDivs[0]]),
    fetchESPNFuturesMerged([FUTURE_IDS.afcDivs[1]]),
    fetchESPNFuturesMerged([FUTURE_IDS.afcDivs[2]]),
    fetchESPNFuturesMerged([FUTURE_IDS.afcDivs[3]]),
    fetchESPNFuturesMerged([FUTURE_IDS.nfcDivs[0]]),
    fetchESPNFuturesMerged([FUTURE_IDS.nfcDivs[1]]),
    fetchESPNFuturesMerged([FUTURE_IDS.nfcDivs[2]]),
    fetchESPNFuturesMerged([FUTURE_IDS.nfcDivs[3]]),
    fetchESPNFuturesMerged(FUTURE_IDS.makePO)
  ]);

  // Merge divisions: a team appears in exactly one division market; take max for safety.
  const div = {};
  for (const m of [afcDivE, afcDivN, afcDivS, afcDivW, nfcDivE, nfcDivN, nfcDivS, nfcDivW]){
    for (const [team, p] of Object.entries(m || {})){
      const T = up(team);
      div[T] = Math.max(div[T] || 0, p);
    }
  }

  // reach SB = win AFC or win NFC
  const reachSB = {};
  for (const [team, p] of Object.entries(afc || {})){
    const T = up(team); reachSB[T] = Math.max(reachSB[T] || 0, p);
  }
  for (const [team, p] of Object.entries(nfc || {})){
    const T = up(team); reachSB[T] = Math.max(reachSB[T] || 0, p);
  }

  // Build futures object per team
  const allTeams = new Set([
    ...Object.keys(sb || {}),
    ...Object.keys(reachSB || {}),
    ...Object.keys(div || {}),
    ...Object.keys(makePO || {})
  ].map(up));

  const futures = {};
  for (const T of allTeams){
    futures[T] = {
      sb: sb?.[T] || 0,
      reach_sb: reachSB?.[T] || 0,
      div: div?.[T] || 0,
      make_playoffs: makePO?.[T] || undefined // leave undefined if market absent
    };
  }
  return futures; // {TEAM:{div, reach_sb, sb, make_playoffs?}}
}

async function main(){
  let nflNextGame = [];
  try { nflNextGame = await fetchNFLOddsH2H(); }
  catch(e){ console.error('H2H fetch failed:', e?.message || e); }

  let nflFutures = {};
  try { nflFutures = await fetchAllESPNFutures(); }
  catch(e){ console.error('ESPN futures failed:', e?.message || e); }

  const payload = {
    generatedAt: new Date().toISOString(),
    sources: {
      nflNextGame: 'The Odds API (h2h)',
      nflFutures: 'ESPN futures collections (de-vigged, merged)'
    },
    nflNextGame,
    nflFutures
  };
  await fs.writeFile('data/predictions.json', JSON.stringify(payload, null, 2), 'utf8');
  console.log('Wrote data/predictions.json with', Object.keys(nflFutures).length, 'teams having futures');
}

main().catch(e => { console.error(e); process.exit(1); });
