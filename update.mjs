// update.mjs — builds data/predictions.json with:
// - nflNextGame: next-game implied win % from h2h odds
// - nflFutures: implied probabilities from "outrights" (div/playoffs/conf/SB)
// Requires Node 18+. Uses The Odds API if ODDS_API_KEY is set.

import fs from 'node:fs/promises';
import path from 'node:path';

const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const CFBD_API_KEY = process.env.CFBD_API_KEY || ''; // unused here but harmless

// --- Helpers ---
function moneylineToProb(ml) {
  const n = Number(ml);
  if (!isFinite(n)) return null;
  if (n < 0) return (-n) / ((-n) + 100);
  return 100 / (n + 100);
}
function normalizeProbs(outcomes) {
  // Remove nulls, divide by sum to de-vigorish within a given market.
  const arr = outcomes.map(p => (p ?? 0));
  const s = arr.reduce((a,b)=>a+b,0);
  return (s > 0) ? arr.map(p => p/s) : outcomes;
}
function up(s){ return (s||'').toUpperCase(); }

// --- Odds API: next-game h2h (unchanged from earlier) ---
async function fetchNFLOddsH2H() {
  if (!ODDS_API_KEY) return [];
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?regions=us&markets=h2h&apiKey=${ODDS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`H2H odds failed: ${res.status}`);
  const games = await res.json();
  const teamProbs = {};
  for (const g of games) {
    const book = g.bookmakers?.[0];
    const market = book?.markets?.find(m => m.key === 'h2h');
    if (!market) continue;
    const H = up(g.home_team), A = up(g.away_team);
    const hSel = market.outcomes?.find(o => up(o.name) === H);
    const aSel = market.outcomes?.find(o => up(o.name) === A);
    const hProb = moneylineToProb(hSel?.price);
    const aProb = moneylineToProb(aSel?.price);
    let [ph, pa] = [hProb, aProb];
    if (ph != null && pa != null) [ph, pa] = normalizeProbs([ph, pa]);
    if (H) teamProbs[H] = { sport: 'NFL', team: H, impliedNextGameWinProb: ph ?? null };
    if (A) teamProbs[A] = { sport: 'NFL', team: A, impliedNextGameWinProb: pa ?? null };
  }
  return Object.values(teamProbs);
}

// --- Odds API: outrights / futures ---
// We look for market/outcome names that contain these phrases.
// This is resilient: if a book uses slightly different labels, we still try common variants.
const MARKET_HINTS = [
  'OUTRIGHTS', 'FUTURE', 'FUTURES'
];
const OUTCOME_MAP = [
  { key: 'div',  includes: ['WIN DIVISION','TO WIN DIVISION'] },
  { key: 'make_playoffs', includes: ['MAKE PLAYOFFS','TO MAKE PLAYOFFS','MAKE THE PLAYOFFS'] },
  { key: 'conf', includes: ['WIN CONFERENCE','TO WIN CONFERENCE'] },
  { key: 'sb',   includes: ['WIN SUPER BOWL','TO WIN SUPER BOWL','SUPER BOWL WINNER'] },
  { key: 'reach_conf_champ', includes: ['REACH CONFERENCE CHAMPIONSHIP','TO REACH CONFERENCE CHAMPIONSHIP'] },
  { key: 'reach_sb', includes: ['REACH SUPER BOWL','TO REACH SUPER BOWL','TO MAKE SUPER BOWL'] }
];

function outcomeKeyFor(name) {
  const u = up(name);
  for (const m of OUTCOME_MAP) {
    for (const token of m.includes) {
      if (u.includes(token)) return m.key;
    }
  }
  return null;
}

async function fetchNFLOutrights() {
  if (!ODDS_API_KEY) return {};
  // Try to fetch an "outrights/futures" listing.
  // If your plan doesn't expose it, this call may 404 or return empty — we'll handle that.
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?regions=us&markets=outrights&oddsFormat=american&apiKey=${ODDS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error('Outrights fetch not available:', res.status);
    return {};
  }
  const books = await res.json();

  // Collect probabilities per team per outcome key.
  // For each market, normalize prices to probabilities within that market before storing.
  const prob = {}; // prob[TEAM][key] = probability
  for (const b of books) {
    for (const m of (b.markets || [])) {
      const mName = up(m.key || m.name || '');
      // ensure it's an outright/futures-y market
      if (!MARKET_HINTS.some(h => mName.includes(h)) && up(m.key) !== 'OUTRIGHTS') continue;

      const outcomes = (m.outcomes || []).map(o => ({
        team: up(o.name || ''),
        key: outcomeKeyFor(o.description || o.name || ''),
        p: moneylineToProb(o.price)
      })).filter(x => x.key && x.team && x.p != null);

      // group by key, normalize within key
      const byKey = {};
      for (const o of outcomes) {
        byKey[o.key] = byKey[o.key] || [];
        byKey[o.key].push(o);
      }
      for (const k of Object.keys(byKey)) {
        const arr = byKey[k];
        const norm = normalizeProbs(arr.map(x => x.p));
        arr.forEach((x,i) => {
          const team = x.team;
          prob[team] = prob[team] || {};
          prob[team][k] = Math.max(prob[team][k] ?? 0, norm[i]); // keep max across books
        });
      }
    }
  }
  return prob;
}

async function main() {
  const outPath = path.join('data', 'predictions.json');

  // Next-game odds (for a simple wins proxy)
  let nflNextGame = [];
  try { nflNextGame = await fetchNFLOddsH2H(); }
  catch (e) { console.error('H2H fetch failed (continuing):', e?.message || e); }

  // Outrights: division/playoffs/conference/SB/reach rounds
  let nflFutures = {};
  try { nflFutures = await fetchNFLOutrights(); }
  catch (e) { console.error('Outrights fetch failed (continuing):', e?.message || e); }

  const payload = {
    generatedAt: new Date().toISOString(),
    sources: {
      nflNextGame: 'The Odds API h2h moneyline',
      nflFutures: 'The Odds API outrights (normalized per market)'
    },
    nflNextGame, // [{team, impliedNextGameWinProb}]
    nflFutures   // {TEAM: {div, make_playoffs, conf, sb, reach_conf_champ, reach_sb}}
  };

  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Wrote ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
