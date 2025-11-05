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

// --- ESPN FPI projections (robust header-driven table scrape; team is first col) ---
async function fetchESPNFPIProjectionTable() {
  const BASE = 'https://www.espn.com/nfl/fpi/_/view/projections';

  const UA = {
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache'
  };

  const toNum = s => {
    if (s == null) return null;
    const n = Number(String(s).replace(/[,%]/g,'').trim());
    return Number.isFinite(n) ? n : null;
  };
  const normTxt = s => String(s||'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();

  // Fetch HTML
  let html = '';
  try {
    const res = await fetch(BASE, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    console.error('FPI page fetch failed:', e?.message || e);
    return {};
  }

  // Save for inspection
  try { await fs.writeFile('data/debug-fpi-page.html', html, 'utf8'); } catch {}

  // Extract all tables
  const tables = [];
  const tableRx = /<table[\s\S]*?<\/table>/gi;
  let tm;
  while ((tm = tableRx.exec(html)) !== null) tables.push(tm[0]);
  if (!tables.length) { console.log('FPI: no <table> tags found'); return {}; }

  // Parse header helper
  function parseHeader(tableHtml) {
    const thead = tableHtml.match(/<thead[\s\S]*?<\/thead>/i)?.[0] || tableHtml;
    const tr = thead.match(/<tr[\s\S]*?<\/tr>/i)?.[0] || '';
    const ths = Array.from(tr.matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi)).map(x=>normTxt(x[2]));
    return ths;
  }

  // Find the projections table by its distinctive headers
  let chosen = null, header = [];
  for (const t of tables) {
    const h = parseHeader(t).map(s=>s.toUpperCase());
    if (h.includes('PROJ W-L') && (h.includes('WIN SB%') || h.includes('SB WIN%'))) {
      chosen = t; header = h; break;
    }
  }
  if (!chosen) {
    // fallback: pick the table with the longest header row
    let best = tables[0], bestH = parseHeader(tables[0]);
    for (const t of tables.slice(1)) {
      const h = parseHeader(t);
      if (h.length > bestH.length) { best = t; bestH = h; }
    }
    chosen = best; header = bestH.map(s=>s.toUpperCase());
    console.log('FPI: using fallback table; header=', header.join(' | '));
  } else {
    console.log('FPI: matched table header=', header.join(' | '));
  }

  // Build index map for known headers (TEAM is not in header on ESPN)
  function idx(nameCandidates) {
    for (const cand of nameCandidates) {
      const i = header.indexOf(cand.toUpperCase());
      if (i >= 0) return i;
    }
    return -1;
  }
  const idxWLT    = idx(['W-L-T']);
  const idxProjWL = idx(['PROJ W-L','PROJECTED W-L']);
  const idxPO     = idx(['PLAYOFF%','MAKE PLAYOFFS%','PLAYOFFS%']);
  const idxDiv    = idx(['WIN DIV%','DIVISION%']);
  const idxConf   = idx(['MAKE CONF%','WIN CONF%','CONF%']);
  const idxSBApp  = idx(['MAKE SB%','SB APP%','SUPER BOWL%']);
  const idxSBWin  = idx(['WIN SB%','SB WIN%']);

  if (idxWLT < 0 || idxProjWL < 0) {
    console.log('FPI: missing critical columns — header seen:', header);
    return {};
  }

  // Parse body rows; assume TEAM is the 1st cell BEFORE W-L-T (ESPN omits it from header)
  const out = {};
  const bodyHtml = chosen.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || chosen;
  const rowRx = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm;
  while ((rm = rowRx.exec(bodyHtml)) !== null) {
    const row = rm[1];
    const cells = Array.from(row.matchAll(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi)).map(x=>normTxt(x[2]));
    if (!cells.length) continue;

    // If ESPN omitted TEAM in header, the first body cell is team name
    const teamCellIndex = (header.includes('TEAM') ? header.indexOf('TEAM') : 0);
    const teamFull = cells[teamCellIndex] || '';
    const projWL   = cells[teamCellIndex + (idxProjWL - idxWLT + 1)] // rough alignment
                  || cells[idxProjWL] || cells.find(c => /^\d+(\.\d+)?-\d+(\.\d+)?$/.test(c)) || '';

    // If the above heuristic is too fancy, fall back to a simpler rule:
    // TEAM = first cell, PROJ W-L = the first cell matching N-N pattern.
    const teamName = teamFull || cells[0] || '';
    const projWlCell = projWL || (cells.find(c => /^\d+(\.\d+)?-\d+(\.\d+)?$/.test(c)) || '');

    if (!teamName || !projWlCell.includes('-')) continue;

    const projWins = toNum(projWlCell.split('-')[0]);
    if (projWins == null) continue;

    const playoff  = (idxPO    >= 0 ? toNum(cells[idxPO + (teamCellIndex>0?1:0)])    : null);
    const winDiv   = (idxDiv   >= 0 ? toNum(cells[idxDiv + (teamCellIndex>0?1:0)])   : null);
    const makeConf = (idxConf  >= 0 ? toNum(cells[idxConf + (teamCellIndex>0?1:0)])  : null);
    const makeSB   = (idxSBApp >= 0 ? toNum(cells[idxSBApp + (teamCellIndex>0?1:0)]) : null);
    const winSB    = (idxSBWin >= 0 ? toNum(cells[idxSBWin + (teamCellIndex>0?1:0)]) : null);

    const teamKey = teamName.toUpperCase();
    out[teamKey] = {
      projected_wins: projWins,
      playoff: (playoff ?? 0) / 100,
      div:     (winDiv  ?? 0) / 100,
      conf:    (makeConf?? 0) / 100,
      sb:      (makeSB  ?? 0) / 100,
      win_sb:  (winSB   ?? 0) / 100
    };
  }

  console.log('FPI (header-parse) teams =', Object.keys(out).length);
  try { await fs.writeFile('data/debug-fpi-table.html', chosen, 'utf8'); } catch {}
  return out;
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
