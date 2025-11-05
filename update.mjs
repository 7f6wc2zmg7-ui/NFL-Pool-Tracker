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

// --- ESPN FPI projections (header-indexed; robust TEAM extraction) ---
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
    .replace(/<[^>]+>/g,'')     // strip tags
    .replace(/\u00A0/g,' ')     // nbsp -> space
    .replace(/\s+/g,' ')        // collapse
    .trim();

  // Pull full page
  let html = '';
  try {
    const res = await fetch(BASE, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    console.error('FPI page fetch failed:', e?.message || e);
    return {};
  }

  // Find table with PROJ W-L + WIN SB%
  const tables = [];
  const tableRx = /<table[\s\S]*?<\/table>/gi;
  let tm; while ((tm = tableRx.exec(html)) !== null) tables.push(tm[0]);

  let chosen = null, header = [];
  for (const t of tables) {
    const thead = t.match(/<thead[\s\S]*?<\/thead>/i)?.[0] || '';
    const headCells = Array.from(thead.matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi))
      .map(x => normTxt(x[2]).toUpperCase());
    if (headCells.includes('PROJ W-L') && (headCells.includes('WIN SB%') || headCells.includes('SB WIN%'))) {
      chosen = t; header = headCells; break;
    }
  }
  if (!chosen) {
    console.log('FPI: projections table not found');
    return {};
  }
  console.log('FPI: matched table header=', header.join(' | '));

  // Header → body index (+1 because TEAM column is not in header)
  const colIndex = (name) => {
    const i = header.indexOf(name.toUpperCase());
    return i >= 0 ? (i + 1) : -1;
  };
  const ciProjWL = colIndex('PROJ W-L');
  const ciPO     = colIndex('PLAYOFF%');
  const ciDiv    = colIndex('WIN DIV%');
  const ciConf   = colIndex('MAKE CONF%');
  const ciSBApp  = colIndex('MAKE SB%');
  const ciSBWin  = colIndex('WIN SB%');

  // Helpers to extract TEAM from raw HTML of cell[0]
  const fromAttrs = (s, attr) => {
    const m = new RegExp(attr + '="([^"]+)"', 'i').exec(s);
    return m ? m[1].trim() : null;
  };
  const fromHrefSlug = (s) => {
    // e.g. /nfl/team/_/name/buf/buffalo-bills  →  Buffalo Bills
    const m = /href="[^"]*\/team\/_\/name\/([a-z0-9-]+)\/([a-z0-9-]+)"/i.exec(s);
    if (m && m[2]) {
      const slug = m[2].replace(/-/g, ' ');
      return slug.split(' ').map(w => w ? w[0].toUpperCase()+w.slice(1) : '').join(' ').trim();
    }
    return null;
  };
  const extractTeamName = (raw, text) => {
    // Prefer visible text if present
    if (text && /[A-Za-z]/.test(text)) return text;
    // Try aria-label, title, alt
    return (
      fromAttrs(raw, 'aria-label') ||
      fromAttrs(raw, 'title') ||
      fromAttrs(raw, 'alt') ||
      fromHrefSlug(raw) ||
      null
    );
  };

  // Parse body rows; collect both raw and text cells
  const out = {};
  const bodyHtml = chosen.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || chosen;
  const rowRx = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowsSeen = 0, used = 0, skipped = 0;
  const debugRows = [];

  while (true) {
    const m = rowRx.exec(bodyHtml);
    if (!m) break;
    rowsSeen++;

    const rawCells  = Array.from(m[1].matchAll(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi)).map(x => x[2]);
    const textCells = rawCells.map(normTxt);
    if (textCells.length < 3) { skipped++; continue; }

    // TEAM is body col 0 (raw+text)
    let teamName = extractTeamName(rawCells[0] || '', textCells[0] || '');
    if (!teamName) { skipped++; continue; }

    // PROJ W-L cell by header-mapped index (+1 offset)
    let projWlCell = (ciProjWL >= 0 && textCells[ciProjWL]) ? textCells[ciProjWL] : '';
    if (!/[0-9.]+\s*[–-]\s*[0-9.]+/.test(projWlCell)) {
      // fallback: find any N–N pattern in row
      const found = textCells.find(c => /[0-9.]+\s*[–-]\s*[0-9.]+/.test(c));
      if (found) projWlCell = found;
    }
    if (!projWlCell) { skipped++; continue; }

    const projWins = toNum(projWlCell.split(/[–-]/)[0]);
    if (projWins == null) { skipped++; continue; }

    const playoff  = (ciPO    >= 0 && textCells[ciPO]    != null) ? toNum(textCells[ciPO])    : null;
    const winDiv   = (ciDiv   >= 0 && textCells[ciDiv]   != null) ? toNum(textCells[ciDiv])   : null;
    const makeConf = (ciConf  >= 0 && textCells[ciConf]  != null) ? toNum(textCells[ciConf])  : null;
    const makeSB   = (ciSBApp >= 0 && textCells[ciSBApp] != null) ? toNum(textCells[ciSBApp]) : null;
    const winSB    = (ciSBWin >= 0 && textCells[ciSBWin] != null) ? toNum(textCells[ciSBWin]) : null;

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

    if (debugRows.length < 6) debugRows.push({ teamCellRaw: rawCells[0], teamCellText: textCells[0], projWlCell, textCells });
  }

  console.log(`FPI (header+offset+team): rows=${rowsSeen} used=${used} skipped=${skipped}`);
  try { await fs.writeFile('data/debug-fpi-table.html', chosen, 'utf8'); } catch {}
  try { await fs.writeFile('data/debug-fpi-cells.json', JSON.stringify(debugRows, null, 2), 'utf8'); } catch {}

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
