// update.mjs — ESPN futures + OddsAPI + current Regular Season Wins (O/U)
// Node 20+. Writes data/predictions.json
import fs from "node:fs/promises";

const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const YEAR = new Date().getFullYear();

const U = s => (s ?? "").toUpperCase().trim();

// --- utility conversions ---
function mlToProb(mlLike) {
  if (mlLike == null) return null;
  const n = Number(String(mlLike).replace(/[^\d-]/g, ""));
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

// ---------- Odds API (for next-game win probs) ----------
async function fetchNFLOddsH2H() {
  if (!ODDS_API_KEY) return [];
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?regions=us&markets=h2h&oddsFormat=american&apiKey=${ODDS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`H2H odds failed: ${res.status}`);
  const games = await res.json();
  const byTeam = {};
  for (const g of games) {
    const book = g.bookmakers?.[0];
    const m = book?.markets?.find(x => x.key === "h2h");
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
      byTeam[H] = { team: H, impliedNextGameWinProb: nh };
      byTeam[A] = { team: A, impliedNextGameWinProb: na };
    }
  }
  return Object.values(byTeam);
}

// ---------- ESPN futures helpers ----------
function kindFromTitleAndSize(title, size) {
  const t = U(title);
  if (t.includes("SUPER BOWL")) return "sb";
  if (t.includes("CONFERENCE")) return "reach_sb";
  if (t.includes("MAKE PLAYOFFS")) return "make_playoffs";
  if (t.includes("DIVISION")) return "div";
  if (size >= 30) return "sb";
  if (size >= 14 && size <= 18) return "reach_sb";
  if (size >= 4 && size <= 6 && /EAST|NORTH|SOUTH|WEST/.test(t)) return "div";
  return null;
}

async function listFuturesRefs() {
  const base = y => `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${y}/futures`;
  const root = await tryJSON([base(YEAR), base(YEAR - 1)]);
  if (!root) return [];
  return (root.items || root.entries || []).map(x => x?.$ref).filter(Boolean);
}

async function fetchMarketMeta(ref) {
  const data = await safeJSON(ref);
  const title = data?.name || data?.title || "";
  const futs = Array.isArray(data?.futures) ? data.futures : [];
  let teamMode = false;
  for (const f of futs) {
    for (const b of (f.books || [])) if (b.team?.$ref) teamMode = true;
  }
  return { ref, title, futures: futs, teamMode };
}

async function resolveTeamName(refUrl, cache) {
  if (!refUrl) return null;
  if (cache.has(refUrl)) return cache.get(refUrl);
  try {
    const tj = await safeJSON(refUrl);
    const nm = U(tj?.displayName || tj?.name || tj?.abbreviation || "");
    cache.set(refUrl, nm);
    return nm;
  } catch { return null; }
}

function extractMLfromBook(b) {
  return b?.price?.american ?? b?.oddsAmerican ?? b?.odds?.american ?? b?.value ?? null;
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

// ---------- ESPN futures (auto-discover all) ----------
async function fetchESPNFuturesAuto() {
  const refs = await listFuturesRefs();
  const futures = {}; // TEAM -> {div, reach_sb, sb, make_playoffs}
  for (const ref of refs) {
    let meta; try { meta = await fetchMarketMeta(ref); } catch { continue; }
    if (!meta.teamMode) continue;
    const probs = await extractTeamProbs(meta);
    const kind = kindFromTitleAndSize(meta.title, Object.keys(probs).length);
    if (!kind) continue;
    for (const [team, p] of Object.entries(probs)) {
      const T = U(team);
      futures[T] = futures[T] || {};
      futures[T][kind] = Math.max(futures[T][kind] || 0, p);
    }
  }
  console.log("Fetched ESPN futures markets:", Object.keys(futures).length);
  return futures;
}

// ---------- ESPN Regular Season Wins (O/U) ----------
async function fetchCurrentWinTotals() {
  const refs = await listFuturesRefs();
  const teamCache = new Map();
  const out = {};

  for (const ref of refs) {
    let meta; try { meta = await fetchMarketMeta(ref); } catch { continue; }
    const title = (meta?.title || "").toLowerCase();
    if (!title.includes("regular season wins")) continue;

    for (const f of (meta.futures || [])) {
      for (const b of (f.books || [])) {
        if (!b.team?.$ref) continue;
        const val = b?.value ?? b?.overUnder ?? b?.total ?? null;
        const n = Number(val);
        if (!isFinite(n)) continue;
        const name = await resolveTeamName(b.team.$ref, teamCache);
        if (name) out[U(name)] = n;
      }
    }
  }
  console.log("Fetched current O/U totals:", Object.keys(out).length);
  return out;
}

// ---------- Main ----------
async function main() {
  let nflNextGame = [];
  try { nflNextGame = await fetchNFLOddsH2H(); }
  catch (e) { console.error("H2H fetch failed:", e?.message || e); }

  let nflFutures = {};
  try { nflFutures = await fetchESPNFuturesAuto(); }
  catch (e) { console.error("ESPN futures failed:", e?.message || e); }

  let nflCurrentOU = {};
  try { nflCurrentOU = await fetchCurrentWinTotals(); }
  catch (e) { console.error("Current OU fetch failed:", e?.message || e); }

  const payload = {
    generatedAt: new Date().toISOString(),
    sources: {
      nflNextGame: "The Odds API (h2h)",
      nflFutures: "ESPN futures (auto-discovered)",
      nflCurrentOU: "ESPN futures — Regular Season Wins"
    },
    nflNextGame,
    nflFutures,
    nflCurrentOU
  };

  await fs.writeFile("data/predictions.json", JSON.stringify(payload, null, 2), "utf8");
  console.log("✅ Wrote data/predictions.json",
              "teamsWithFutures=", Object.keys(nflFutures).length,
              "teamsWithCurrentOU=", Object.keys(nflCurrentOU).length);
}

main().catch(e => { console.error(e); process.exit(1); });
