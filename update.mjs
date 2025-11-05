// update.mjs — Node 20
// - Odds API H2H implied win prob (optional)
// - ESPN futures (auto-discover; de-vigged)
// - ESPN FPI (rich scrape: projected wins + probs + ratings) with debug dump
// - ESPN current O/U stub (kept empty unless you wire it)
// - Cache: preserves last-good values if a section returns empty

import fs from 'node:fs/promises';

const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const YEAR = new Date().getFullYear();

// ---------- shared helpers (declare ONCE) ----------
const U = s => (s ?? '').toUpperCase().trim();

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
function num(x){ const n = Number(x); return Number.isFinite(n) ? n : null; }

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

// ---------- ESPN FPI (robust JSON extractor + fallback regex) ----------
async function fetchESPNFPIRich(){
const url = 'https://www.espn.com/nfl/fpi/_/view/projections';
  let html = '';
  try{
    const res = await fetch(url, { headers: UA_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  }catch(e){
    console.error('FPI fetch failed:', e?.message || e);
    return {};
  }

  // 0) Save full HTML
  try { await fs.writeFile('data/debug-fpi.html', html, 'utf8'); } catch {}

  // 1) Extract ALL <script> tags and save them so we can inspect
  const scripts = [];
  const scriptRx = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scriptRx.exec(html)) !== null) {
    scripts.push(sm[1]);
  }
  try {
    await fs.mkdir('data/debug-fpi-scripts', { recursive: true });
    const indexLines = [];
    for (let i=0; i<scripts.length; i++){
      const body = scripts[i].trim();
      const name = `script-${String(i+1).padStart(2,'0')}.txt`;
      indexLines.push(name + '  (' + Math.min(body.length, 200) + ' chars preview)');
      await fs.writeFile(`data/debug-fpi-scripts/${name}`, body, 'utf8');
    }
    await fs.writeFile('data/debug-fpi-scripts/index.txt', indexLines.join('\n'), 'utf8');
    console.log(`FPI debug: saved ${scripts.length} <script> blocks to data/debug-fpi-scripts/`);
  } catch {}

  // 2) Try common JSON carriers from those scripts
  function tryParseJSON(s){
    try { return JSON.parse(s); } catch { return null; }
  }

  // a) __NEXT_DATA__ (Next.js pattern)
  let jsonCandidates = [];
  const nextDataRx = /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i;
  const nm = nextDataRx.exec(html);
  if (nm) {
    const j = tryParseJSON(nm[1]);
    if (j) { jsonCandidates.push({ tag: '__NEXT_DATA__', obj: j }); }
  }

  // b) Any inline assignment like: window.__APOLLO_STATE__ = { ... };
  //    or: var __SOMETHING__ = { ... };
  const inlineObjRx = /\b([A-Za-z_$][\w$\.]*)\s*=\s*({[\s\S]*?});/g;
  let im;
  while ((im = inlineObjRx.exec(html)) !== null){
    const varName = im[1];
    let text = im[2];
    // Try to sanitize trailing commas / undefined / NaN
    const cleaned = text
      .replace(/\bundefined\b/g, 'null')
      .replace(/\bNaN\b/g, 'null')
      .replace(/,(\s*[}\]])/g, '$1');
    const parsed = tryParseJSON(cleaned);
    if (parsed) jsonCandidates.push({ tag: varName, obj: parsed });
  }

  console.log('FPI debug: JSON candidates found =', jsonCandidates.map(c=>c.tag).slice(0,8).join(', ') || 'none');

  // 3) DFS to find team-like nodes with projected wins inside those JSONs
  function toNum(x){ const n = Number(x); return Number.isFinite(n) ? n : null; }
  function nicknameFromDisplayName(name){
    if (!name) return null;
    const parts = String(name).trim().split(/\s+/);
    return (parts[parts.length - 1] || '').toUpperCase();
  }
  function collect(root){
    const out = {};
    const stack = [root];
    while (stack.length){
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;

      // Heuristics for ESPN FPI-like team objects
      const display = node.displayName || node.teamName || node.nameFull || node.name;
      const abbr    = node.abbreviation || node.teamAbbr || node.abbr;
      const projW   = (node.projectedWins ?? node.projWins ?? node.winsProj ?? null);

      if (typeof display === 'string' && (abbr || /[A-Z]{2,4}/.test(String(abbr||''))) && projW != null) {
        const nick = nicknameFromDisplayName(display);
        const wins = toNum(projW);
        if (nick && Number.isFinite(wins)) {
          const makePO = toNum(node.makePlayoffs ?? node.playoffPct);
          const winDiv = toNum(node.winDivision ?? node.divisionPct);
          const winConf= toNum(node.winConference ?? node.conferencePct);
          const winSB  = toNum(node.winSuperBowl ?? node.superBowlPct);
          out[nick] = {
            name: display,
            abbr: String(abbr || '').toUpperCase(),
            nick,
            projected_wins: wins,
            projected_losses: toNum(node.projectedLosses ?? node.projLosses),
            fpi: toNum(node.fpi ?? node.rating),
            fpi_rank: toNum(node.fpiRank ?? node.rank),
            off_fpi: toNum(node.offenseFpi ?? node.offFpi),
            def_fpi: toNum(node.defenseFpi ?? node.defFpi),
            st_fpi:  toNum(node.specialTeamsFpi ?? node.stFpi),
            make_playoffs: makePO,
            win_division:  winDiv,
            win_conference:winConf,
            win_super_bowl:winSB,
            sos_remaining: toNum(node.sosRemaining ?? node.remainingSos)
          };
        }
      }

      if (Array.isArray(node)){
        for (const v of node) stack.push(v);
      } else {
        for (const v of Object.values(node)) stack.push(v);
      }
    }
    return out;
  }

  let teams = {};
  for (const cand of jsonCandidates){
    const got = collect(cand.obj);
    if (Object.keys(got).length > Object.keys(teams).length) {
      teams = got;
      console.log(`FPI debug: best candidate so far = ${cand.tag}, teams=${Object.keys(teams).length}`);
    }
  }

  // 4) Final fallback: very wide regex on HTML
  if (Object.keys(teams).length < 20) {
    const wideRx = /"displayName"\s*:\s*"([^"]+)"[\s\S]{0,4000}?"projectedWins"\s*:\s*([0-9.]+)/g;
    let m, count=0;
    while ((m = wideRx.exec(html)) !== null){
      const displayName = m[1];
      const wins = toNum(m[2]);
      const nick = nicknameFromDisplayName(displayName);
      if (nick && Number.isFinite(wins)) {
        teams[nick] = Object.assign(teams[nick]||{}, { name: displayName, nick, projected_wins: wins });
        count++;
      }
    }
    console.log('FPI debug: wide regex hits =', count);
  }

  console.log('FPI rich: teamsParsed =', Object.keys(teams).length);
  return teams;
}

// ---------- ESPN current O/U (season wins) ----------
async function fetchESPNCurrentOU() {
  // Leave empty unless you’ve implemented this scraper.
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

  // Cache-preserving: if empty, keep previous non-empty
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
