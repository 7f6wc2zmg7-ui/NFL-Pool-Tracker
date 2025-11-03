// update.mjs — writes data/predictions.json
import fs from 'node:fs/promises';
import path from 'node:path';

const CFBD_API_KEY = process.env.CFBD_API_KEY || '';
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';

function moneylineToProb(ml) {
  if (ml == null || Number.isNaN(Number(ml))) return null;
  const n = Number(ml);
  if (n < 0) return (-n) / ((-n) + 100);
  return 100 / (n + 100);
}

async function fetchCFBFPI(year) {
  const y = year || new Date().getFullYear();
  const url = `https://api.collegefootballdata.com/ratings/fpi?year=${y}`;
  const headers = CFBD_API_KEY ? { 'Authorization': `Bearer ${CFBD_API_KEY}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`CFBD FPI failed: ${res.status}`);
  const data = await res.json();
  return data.map(r => ({
    sport: 'CFB',
    team: (r.team || '').toUpperCase(),
    conference: r.conference ?? null,
    fpi: r.fpi ?? null,
  }));
}

async function fetchNFLOdds() {
  if (!ODDS_API_KEY) return [];
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?regions=us&markets=h2h&apiKey=${ODDS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Odds API failed: ${res.status}`);
  const games = await res.json();
  const teamProbs = {};
  for (const g of games) {
    const book = g.bookmakers?.[0];
    const market = book?.markets?.find(m => m.key === 'h2h');
    if (!market) continue;
    const [home, away] = [g.home_team, g.away_team].map(x => (x || '').toUpperCase());
    const hSel = market.outcomes?.find(o => (o.name || '').toUpperCase() === home);
    const aSel = market.outcomes?.find(o => (o.name || '').toUpperCase() === away);
    const hProb = moneylineToProb(hSel?.price);
    const aProb = moneylineToProb(aSel?.price);
    let normH = hProb, normA = aProb;
    if (hProb != null && aProb != null) {
      const s = hProb + aProb;
      if (s > 0) { normH = hProb / s; normA = aProb / s; }
    }
    if (home) teamProbs[home] = { sport: 'NFL', team: home, impliedNextGameWinProb: normH ?? null };
    if (away) teamProbs[away] = { sport: 'NFL', team: away, impliedNextGameWinProb: normA ?? null };
  }
  return Object.values(teamProbs);
}

async function main() {
  const outPath = path.join('data', 'predictions.json');

  let cfb = [];
  try { cfb = await fetchCFBFPI(); } 
  catch (e) { console.error('CFB fetch failed (continuing):', e?.message || e); }

  let nfl = [];
  try { nfl = await fetchNFLOdds(); } 
  catch (e) { console.error('NFL fetch failed (continuing):', e?.message || e); }

  const payload = {
    generatedAt: new Date().toISOString(),
    sources: { cfb: 'CFBD FPI', nfl: 'The Odds API (h2h → implied)' },
    cfbFPI: Array.isArray(cfb) ? cfb : [],
    nflNextGame: Array.isArray(nfl) ? nfl : []
  };
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Wrote ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
