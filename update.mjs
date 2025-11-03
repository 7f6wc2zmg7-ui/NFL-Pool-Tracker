// update.mjs — ESPN futures (auto-discover) + OddsAPI H2H
// Node 20. Writes data/predictions.json
import fs from 'node:fs/promises';

const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const YEAR = new Date().getFullYear();

function up(s){ return (s||'').toUpperCase().trim(); }
function moneylineToProb(ml){
  const n = Number(ml);
  if (!isFinite(n)) return null;
  return n < 0 ? (-n) / ((-n) + 100) : 100 / (n + 100);
}
function devigProbMap(raw){ // {TEAM: raw_p}
  const vals = Object.values(raw).filter(v => v > 0);
  const s = vals.reduce((a,b)=>a+b, 0);
  if (s <= 0) return {};
  const out = {};
  for (const [k,v] of Object.entries(raw)) if (v > 0) out[k] = v / s;
  return out;
}
async function safeJSON(url){
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function tryJSON(urls){
  for (const u of urls){
    try { return await safeJSON(u); } catch (_) {}
  }
  return null;
}

// ---------- Odds API H2H (unchanged) ----------
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
      const s = ph + pa;
      const nh = s > 0 ? ph / s : ph;
      const na = s > 0 ? pa / s : pa;
      byTeam[H] = { sport:'NFL', team:H, impliedNextGameWinProb:nh };
      byTeam[A] = { sport:'NFL', team:A, impliedNextGameWinProb:na };
    }
  }
  return Object.values(byTeam);
}

// ---------- ESPN futures (auto-discover, de-vig, categorize) ----------
function looksLikeDivision(name){
  const u = up(name);
  return u.includes('DIVISION') || u.includes('WIN AFC EAST') || u.includes('WIN NFC');
}
function looksLikeConference(name){
  const u = up(name);
  return u.includes('WIN AFC') || u.includes('WIN NFC') || u.includes('CONFERENCE CHAMPION');
}
function looksLikeSuperBowl(name){
  const u = up(name);
  return u.includes('SUPER BOWL') || u.includes('PRO FOOTBALL CHAMPION');
}
function looksLikeMakePlayoffs(name){
  const u = up(name);
  return u.includes('MAKE PLAYOFFS') || u.includes('TO MAKE PLAYOFFS');
}

async function listAllFutures(){
  // ESPN sometimes moves the season; try YEAR, then YEAR-1.
  const base = (y) => `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${y}/futures`;
  const root = await tryJSON([base(YEAR), base(YEAR-1)]);
  if (!root) return [];
  // Paginated structure: items is an array of $refs to futures/{id}
  // Some seasons include "items", others "entries". Handle both.
  const refs = [];
  const pushRefs = (arr) => arr?.forEach(x => x?.$ref && refs.push(x.$ref));
  pushRefs(root.items || root.entries || []);
  // (If there were multiple pages we'd follow next;, in practice NFL is single page.)
  return refs;
}

async function fetchFutureMarket(ref){
  // Load the collection and pick the entry with most books
  const data = await safeJSON(ref);
  let best = null;
  for (const f of (data.futures || [])){
    const count = (f.books || []).length;
    if (count && (!best || count > (best.books?.length || 0))) best = f;
  }
  if (!best || !best.books?.length) return null;

  // Resolve team refs once
  const teamCache = new Map();
  async function teamName(refUrl){
    if (!refUrl) return null;
    if (teamCache.has(refUrl)) return teamCache.get(refUrl);
    try{
      const tj = await safeJSON(refUrl);
      const nm = up(tj?.displayName || tj?.name || tj?.abbreviation || '');
      teamCache.set(refUrl, nm);
      return nm;
    }catch(_){ return null; }
  }

  const raw = {}; // team -> raw p
  for (const b of best.books){
    const team = await teamName(b.team?.$ref);
    const ml = b?.price?.american ?? b?.oddsAmerican ?? b?.odds?.american;
    const p = moneylineToProb(ml);
    if (team && p != null) raw[team] = Math.max(raw[team] || 0, p);
  }
  const probs = devigProbMap(raw);
  // Use the collection name to categorize
  const title = up(data?.name || data?.title || '');
  let kind = null;
  if (looksLikeSuperBowl(title)) kind = 'sb';
  else if (looksLikeConference(title)) kind = 'reach_sb';
  else if (looksLikeDivision(title)) kind = 'div';
  else if (looksLikeMakePlayoffs(title)) kind = 'make_playoffs';
  return { kind, probs, title };
}

async function fetchESPNFuturesAuto(){
  const refs = await listAllFutures();
  const futures = {}; // TEAM -> {div, reach_sb, sb, make_playoffs}
  const counts = { sb:0, reach_sb:0, div:0, make_playoffs:0 };
  for (const ref of refs){
    let market = null;
    try { market = await fetchFutureMarket(ref); } catch(_){}
    if (!market || !market.kind || !market.probs) continue;
    for (const [team, p] of Object.entries(market.probs)){
      const T = up(team);
      futures[T] = futures[T] || {};
      futures[T][market.kind] = Math.max(futures[T][market.kind] || 0, p);
    }
    counts[market.kind] = (counts[market.kind] || 0) + 1;
  }
  console.log('ESPN futures markets collected:', counts);
  return futures;
}

async function main(){
  // Odds API (optional)
  let nflNextGame = [];
  try { nflNextGame = await fetchNFLOddsH2H(); }
  catch(e){ console.error('H2H fetch failed:', e?.message || e); }

  // ESPN futures (auto-discovered)
  let nflFutures = {};
  try { nflFutures = await fetchESPNFuturesAuto(); }
  catch(e){ console.error('ESPN futures failed:', e?.message || e); }

  const payload = {
    generatedAt: new Date().toISOString(),
    sources: {
      nflNextGame: 'The Odds API (h2h)',
      nflFutures: 'ESPN futures (auto-discovered, de-vigged)'
    },
    nflNextGame,
    nflFutures
  };
  await fs.writeFile('data/predictions.json', JSON.stringify(payload, null, 2), 'utf8');
  console.log('Wrote data/predictions.json with futures for', Object.keys(nflFutures).length, 'teams');
}

main().catch(e => { console.error(e); process.exit(1); });
