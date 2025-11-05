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

// --- ESPN FPI projections (hardy row-scan fallback) ---
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
    const n = Number(String(s).replace(/[,%\u00A0]/g,'').trim());
    return Number.isFinite(n) ? n : null;
  };
  const normTxt = s => String(s||'')
    .replace(/<script[\s\S]*?<\/script>/gi,'')
    .replace(/<style[\s\S]*?<\/style>/gi,'')
    .replace(/\u00A0/g,' ')
    .replace(/\s+/g,' ')
    .trim();

  // Helpers to pull team name from a <td> raw HTML
  const fromAttr = (raw, attr) => {
    const m = new RegExp(attr + '="([^"]+)"','i').exec(raw);
    return m ? m[1].trim() : null;
  };
  const fromHrefSlug = raw => {
    // /nfl/team/_/name/buf/buffalo-bills  →  Buffalo Bills
    const m = /href="[^"]*\/nfl\/team\/_\/name\/[a-z0-9-]+\/([a-z0-9-]+)"/i.exec(raw);
    if (!m) return null;
    return m[1].split('-').map(w => w ? w[0].toUpperCase()+w.slice(1) : '').join(' ').trim();
  };
  const extractTeamName = (rawCell) =>
    fromAttr(rawCell,'aria-label') ||
    fromAttr(rawCell,'title') ||
    fromAttr(rawCell,'alt') ||
    fromHrefSlug(rawCell);

  // Fetch page
  let html = '';
  try {
    const res = await fetch(BASE, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    console.error('FPI page fetch failed:', e?.message || e);
    return {};
  }

  // Pick projections table (header contains PROJ W-L and WIN SB%)
  const tables = [];
  const tableRx = /<table[\s\S]*?<\/table>/gi;
  let tm; while ((tm = tableRx.exec(html)) !== null) tables.push(tm[0]);

  let chosen = null;
  for (const t of tables) {
    const head = t.match(/<thead[\s\S]*?<\/thead>/i)?.[0] || '';
    const headCells = Array.from(head.matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi))
      .map(x => normTxt(x[2]).toUpperCase());
    if (headCells.includes('PROJ W-L') && (headCells.includes('WIN SB%') || headCells.includes('SB WIN%'))) {
      chosen = t; break;
    }
  }
  if (!chosen) {
    console.log('FPI: projections table not found');
    return {};
  }

  // Parse <tbody> rows that contain a team link
  const bodyHtml = chosen.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || chosen;
  const rowRx = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;

  const out = {};
  let rows=0, used=0, skipped=0;
  const firstFew = [];

  while (true) {
    const m = rowRx.exec(bodyHtml);
    if (!m) break;
    rows++;
    const rowHtml = m[1];
    if (!/\/nfl\/team\/_\/name\//i.test(rowHtml)) { skipped++; continue; } // no team link → skip

    // Cells (keep both raw and text)
    const rawCells  = Array.from(rowHtml.matchAll(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi)).map(x => x[2]);
    const textCells = rawCells.map(c => normTxt(c));

    if (!rawCells.length) { skipped++; continue; }

    // TEAM is first cell (raw)
    const teamName = extractTeamName(rawCells[0]);
    if (!teamName) { skipped++; continue; }

    // PROJ W-L: look anywhere in row for N–N (accept hyphen or en-dash)
    const wlMatch = rowHtml.match(/(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)/);
    if (!wlMatch) { skipped++; continue; }
    const projWins = toNum(wlMatch[1]);
    if (projWins == null) { skipped++; continue; }

    // Percentages in order after PROJ W-L header: PLAYOFF, WIN DIV, MAKE DIV, MAKE CONF, MAKE SB, WIN SB
    const percents = Array.from(rowHtml.matchAll(/(\d+(?:\.\d+)?)\s*%/g)).map(x => toNum(x[1]));
    // Be defensive: ESPN sometimes repeats % elsewhere; we try by relative order:
    const playoff  = percents[0] ?? null;
    const winDiv   = percents[1] ?? null;
    // percents[2] = MAKE DIV (not used in our model)
    const makeConf = percents[3] ?? null;
    const makeSB   = percents[4] ?? null;
    const winSB    = percents[5] ?? null;

    const key = teamName.toUpperCase();

    out[key] = {
      projected_wins: projWins,
      playoff: (playoff ?? 0) / 100,
      div:     (winDiv  ?? 0) / 100,
      conf:    (makeConf?? 0) / 100,
      sb:      (makeSB  ?? 0) / 100,
      win_sb:  (winSB   ?? 0) / 100
    };
    used++;

    if (firstFew.length < 6) {
      firstFew.push({
        teamName, projWins,
        percentsSample: percents.slice(0,6),
        sampleRowSnippet: normTxt(rowHtml).slice(0,200)
      });
    }
  }

  console.log(`FPI (row-scan fallback): rows=${rows} used=${used} skipped=${skipped}`);
  try { await fs.writeFile('data/debug-fpi-table.html', chosen, 'utf8'); } catch {}
  try { await fs.writeFile('data/debug-fpi-cells.json', JSON.stringify(firstFew, null, 2), 'utf8'); } catch {}

  return out;
}

// --- Covers.com win totals (static HTML scrape + name normalization) ---
async function fetchCoversWinTotals() {
  const URL = 'https://www.covers.com/nfl/nfl-odds-win-totals';
  const UA = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/xhtml+xml,*/*' };

  const res = await fetch(URL, { headers: UA });
  if (!res.ok) throw new Error(`Covers win totals HTTP ${res.status}`);
  const html = await res.text();
  try { await fs.writeFile('data/debug-covers-win-totals.html', html, 'utf8'); } catch {}

  // Canonical map (nicknames/short → full). Keys and values are UPPERCASE.
  const CANON = {
    'ARIZONA CARDINALS':'ARIZONA CARDINALS','CARDINALS':'ARIZONA CARDINALS',
    'ATLANTA FALCONS':'ATLANTA FALCONS','FALCONS':'ATLANTA FALCONS',
    'BALTIMORE RAVENS':'BALTIMORE RAVENS','RAVENS':'BALTIMORE RAVENS',
    'BUFFALO BILLS':'BUFFALO BILLS','BILLS':'BUFFALO BILLS',
    'CAROLINA PANTHERS':'CAROLINA PANTHERS','PANTHERS':'CAROLINA PANTHERS',
    'CHICAGO BEARS':'CHICAGO BEARS','BEARS':'CHICAGO BEARS',
    'CINCINNATI BENGALS':'CINCINNATI BENGALS','BENGALS':'CINCINNATI BENGALS',
    'CLEVELAND BROWNS':'CLEVELAND BROWNS','BROWNS':'CLEVELAND BROWNS',
    'DALLAS COWBOYS':'DALLAS COWBOYS','COWBOYS':'DALLAS COWBOYS',
    'DENVER BRONCOS':'DENVER BRONCOS','BRONCOS':'DENVER BRONCOS',
    'DETROIT LIONS':'DETROIT LIONS','LIONS':'DETROIT LIONS',
    'GREEN BAY PACKERS':'GREEN BAY PACKERS','PACKERS':'GREEN BAY PACKERS',
    'HOUSTON TEXANS':'HOUSTON TEXANS','TEXANS':'HOUSTON TEXANS',
    'INDIANAPOLIS COLTS':'INDIANAPOLIS COLTS','COLTS':'INDIANAPOLIS COLTS',
    'JACKSONVILLE JAGUARS':'JACKSONVILLE JAGUARS','JAGUARS':'JACKSONVILLE JAGUARS','JAGS':'JACKSONVILLE JAGUARS',
    'KANSAS CITY CHIEFS':'KANSAS CITY CHIEFS','CHIEFS':'KANSAS CITY CHIEFS',
    'LAS VEGAS RAIDERS':'LAS VEGAS RAIDERS','RAIDERS':'LAS VEGAS RAIDERS',
    'LOS ANGELES CHARGERS':'LOS ANGELES CHARGERS','LA CHARGERS':'LOS ANGELES CHARGERS','CHARGERS':'LOS ANGELES CHARGERS',
    'LOS ANGELES RAMS':'LOS ANGELES RAMS','LA RAMS':'LOS ANGELES RAMS','RAMS':'LOS ANGELES RAMS',
    'MIAMI DOLPHINS':'MIAMI DOLPHINS','DOLPHINS':'MIAMI DOLPHINS',
    'MINNESOTA VIKINGS':'MINNESOTA VIKINGS','VIKINGS':'MINNESOTA VIKINGS',
    'NEW ENGLAND PATRIOTS':'NEW ENGLAND PATRIOTS','PATRIOTS':'NEW ENGLAND PATRIOTS','PATS':'NEW ENGLAND PATRIOTS',
    'NEW ORLEANS SAINTS':'NEW ORLEANS SAINTS','SAINTS':'NEW ORLEANS SAINTS',
    'NEW YORK GIANTS':'NEW YORK GIANTS','NY GIANTS':'NEW YORK GIANTS','GIANTS':'NEW YORK GIANTS',
    'NEW YORK JETS':'NEW YORK JETS','NY JETS':'NEW YORK JETS','JETS':'NEW YORK JETS',
    'PHILADELPHIA EAGLES':'PHILADELPHIA EAGLES','EAGLES':'PHILADELPHIA EAGLES',
    'PITTSBURGH STEELERS':'PITTSBURGH STEELERS','STEELERS':'PITTSBURGH STEELERS',
    'SAN FRANCISCO 49ERS':'SAN FRANCISCO 49ERS','49ERS':'SAN FRANCISCO 49ERS','NINERS':'SAN FRANCISCO 49ERS',
    'SEATTLE SEAHAWKS':'SEATTLE SEAHAWKS','SEAHAWKS':'SEATTLE SEAHAWKS',
    'TAMPA BAY BUCCANEERS':'TAMPA BAY BUCCANEERS','BUCCANEERS':'TAMPA BAY BUCCANEERS','BUCS':'TAMPA BAY BUCCANEERS',
    'TENNESSEE TITANS':'TENNESSEE TITANS','TITANS':'TENNESSEE TITANS',
    'WASHINGTON COMMANDERS':'WASHINGTON COMMANDERS','COMMANDERS':'WASHINGTON COMMANDERS',
    'DALLAS':'DALLAS COWBOYS','NYG':'NEW YORK GIANTS','NYJ':'NEW YORK JETS','LAC':'LOS ANGELES CHARGERS','LAR':'LOS ANGELES RAMS','LV':'LAS VEGAS RAIDERS','SF 49ERS':'SAN FRANCISCO 49ERS'
  };
  const canon = t => CANON[t] || CANON[t.replace(/\s+/g,' ').trim()] || t;

  // Grab a likely table section
  const section = html.split('Updated NFL win totals odds')[1] || html;

  // Find rows: team in first <td>/<a>, number in the next <td>
  const rows = [];
  const rowRx = /<tr[^>]*>\s*<td[^>]*>[\s\S]*?(?:>([A-Za-z0-9 .'\-]+)<\/a>|>([A-Za-z0-9 .'\-]+)<\/span>|>\s*([A-Za-z0-9 .'\-]+)\s*)[\s\S]*?<\/td>\s*<td[^>]*>\s*([0-9]+(?:\.[05])?)\s*</gi;
  let m; while ((m = rowRx.exec(section)) !== null) {
    const name = (m[1] || m[2] || m[3] || '').toUpperCase().trim();
    const val = Number(m[4]);
    if (name && Number.isFinite(val)) rows.push([canon(name), val]);
  }

  const ou = {};
  for (const [T, v] of rows) ou[T] = v;

  // If we somehow have < 32, try a laxer pass over the whole page
  if (Object.keys(ou).length < 32) {
    const looseRx = />([A-Za-z .'\-]{3,40})<\/(?:a|span|strong|td)>[\s\S]*?([0-9]+(?:\.[05])?)\s*</gi;
    let m2; while ((m2 = looseRx.exec(html)) !== null) {
      const T = canon(m2[1].toUpperCase().trim());
      const v = Number(m2[2]);
      if (T && Number.isFinite(v) && /[A-Z]/.test(T)) ou[T] = v;
    }
  }

  return { source: 'Covers.com win totals', url: URL, ou };
}

/* ---------- main ---------- */
async function main() {
  let nflNextGame = [];
  let nflFPI = {}; // FPI disabled for now
  try { nflNextGame = await fetchNFLOddsH2H(); }
  catch (e) { console.error('H2H fetch failed:', e?.message || e); }

  let nflFutures = {};
  try { nflFutures = await fetchESPNFuturesAuto(); }
  catch (e) { console.error('ESPN futures failed:', e?.message || e); }

  let nflCurrentOU = {};
try {
  const c = await fetchCoversWinTotals();
  nflCurrentOU = c.ou || {};
  console.log('Covers win totals parsed teams=', Object.keys(nflCurrentOU).length);
} catch (e) {
  console.error('Covers win totals failed:', e?.message || e);
}

const payload = {
  generatedAt: new Date().toISOString(),
  sources: {
    nflNextGame: 'The Odds API (h2h)',
    nflFutures: 'ESPN futures (auto-discovered; de-vigged)',
    nflCurrentOU: 'Covers.com win totals (scraped HTML)'
  },
  nflNextGame,
  nflFutures,
  nflCurrentOU
};
await fs.writeFile('data/predictions.json', JSON.stringify(payload, null, 2), 'utf8');
  console.log(
    'Wrote data/predictions.json.',
    'teamsWithFutures=', Object.keys(nflFutures).length,
    'teamsWithFPI=', Object.keys(nflFPI).length
  );
}

main().catch(e => { console.error(e); process.exit(1); });
