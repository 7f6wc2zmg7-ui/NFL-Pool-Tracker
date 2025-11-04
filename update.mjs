// update.mjs — ESPN futures (auto-discover; handles book.value) + OddsAPI H2H
// Node 20. Writes data/predictions.json
import fs from 'node:fs/promises';

const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const YEAR = new Date().getFullYear();

const U = s => (s ?? '').toUpperCase().trim();

function mlToProb(mlLike){
  if (mlLike == null) return null;
  // mlLike may be "+1400", -145, or a string "1400"
  const str = String(mlLike).replace(/^\s*\+?/, ''); // remove leading '+'
  const n = Number(str.startsWith('-') ? str : ('+' + str)); // ensure + for pos
  if (!isFinite(n)) return null;
  if (n < 0) return (-n) / ((-n) + 100);
  return 100 / (n + 100);
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
    try { return await safeJSON(u); } catch {}
  }
  return null;
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

// ---------- ESPN futures (auto-discover, robust) ----------
function kindFromTitleAndSize(title, size){
  const t = U(title);
  // Strong title matches
  if (t.includes('SUPER BOWL')) return 'sb';
  if (t.includes('CONFERENCE CHAMP')) return 'reach_sb';
  if (t.includes('WIN AFC') || t.includes('AFC CHAMPION')) return 'reach_sb';
  if (t.includes('WIN NFC') || t.includes('NFC CHAMPION')) return 'reach_sb';
  if (t.includes('MAKE PLAYOFFS')) return 'make_playoffs';
  if (t.includes('DIVISION')) return 'div';

  // Heuristics by team count (common shapes)
  if (size >= 30) return 'sb';       // 32-team market → SB winner
  if (size >= 14 && size <= 18) return 'reach_sb'; // ~16-team market → conference
  if (size >= 4 && size <= 6 && /EAST|NORTH|SOUTH|WEST/.test(t)) return 'div'; // division group

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
  const data = await safeJSON(ref);
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
    const tj = await safeJSON(refUrl);
    const nm = U(tj?.displayName || tj?.name || tj?.abbreviation || '');
    cache.set(refUrl, nm);
    return nm;
  }catch{ return null; }
}

function extractMLfromBook(b){
  // Try several shapes: book.price.american, book.oddsAmerican, book.odds.american, or book.value
  const ml =
    b?.price?.american ??
    b?.oddsAmerican ??
    b?.odds?.american ??
    b?.value ?? null;
  return ml;
}

async function extractTeamProbs(meta){
  const raw = {};
  const teamCache = new Map();
  for (const f of meta.futures || []){
    for (const b of (f.books || [])){
      if (!b.team?.$ref) continue;
      const team = await resolveTeamName(b.team.$ref, teamCache);
      const ml = extractMLfromBook(b);
      const p = mlToProb(ml);
      if (team && p != null) raw[team] = Math.max(raw[team] || 0, p);
    }
  }
  return devigProbMap(raw);
}

async function fetchESPNFuturesAuto(){
  const refs = await listFuturesRefs();
  const reports = { total: refs.length, teamMarkets: 0, athleteMarkets: 0, titles: [] };

  const futures = {}; // TEAM -> {div, reach_sb, sb, make_playoffs}
  for (const ref of refs){
    let meta; try { meta = await fetchMarketMeta(ref); } catch { continue; }
    const { title, teamMode, athleteMode } = meta;

    if (reports.titles.length < 10) reports.titles.push(title);
    if (athleteMode && !teamMode) { reports.athleteMarkets++; continue; }
    if (!teamMode) continue;

    // Extract team probs (handles book.value odds)
    const probs = await extractTeamProbs(meta);
    const kind = kindFromTitleAndSize(title, Object.keys(probs).length);
    if (!kind) continue;

    reports.teamMarkets++;
    for (const [team, p] of Object.entries(probs)){
      const T = U(team);
      futures[T] = futures[T] || {};
      futures[T][kind] = Math.max(futures[T][kind] || 0, p);
    }
  }
  console.log(`ESPN futures: total markets=${reports.total}, teamMarkets=${reports.teamMarkets}, athleteMarkets=${reports.athleteMarkets}`);
  console.log('Sample titles:', reports.titles.join(' | '));
  return futures;
}

async function main(){
  let nflNextGame = [];
  try { nflNextGame = await fetchNFLOddsH2H(); }
  catch(e){ console.error('H2H fetch failed:', e?.message || e); }

  let nflFutures = {};
  try { nflFutures = await fetchESPNFuturesAuto(); }
  catch(e){ console.error('ESPN futures failed:', e?.message || e); }

  const payload = {
    generatedAt: new Date().toISOString(),
    sources: {
      nflNextGame: 'The Odds API (h2h)',
      nflFutures: 'ESPN futures (auto-discovered; team markets only; de-vigged; supports book.value)'
    },
    nflNextGame,
    nflFutures
  };
  await fs.writeFile('data/predictions.json', JSON.stringify(payload, null, 2), 'utf8');
  console.log('Wrote data/predictions.json. teamsWithFutures=', Object.keys(nflFutures).length);
}
// --- Regular Season Wins (current O/U) ---
const ouMap = {};
for (const f of allFutures.items || []) {
  if (f.displayName?.toLowerCase().includes('regular season wins')) {
    const resp = await fetch(f['$ref']);
    const fut = await resp.json();
    for (const book of fut.futures?.[0]?.books || []) {
      if (book.team?.$ref && book.value) {
        const teamId = book.team.$ref.split('/teams/').pop().split('?')[0];
        const teamName = teamNamesById[teamId]; // reuse your map from earlier
        if (teamName) ouMap[teamName.toUpperCase()] = parseFloat(book.value);
      }
    }
  }
}
pred.nflCurrentOU = ouMap;


main().catch(e => { console.error(e); process.exit(1); });
