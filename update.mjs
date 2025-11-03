<script>
async function j(path){ const r=await fetch(path,{cache:'no-store'}); if(!r.ok) throw new Error('load '+path); return r.json(); }
function mlToMultiplier(ml){ const n=Number(ml); if(!isFinite(n)) return 0; return n>=0 ? (n/100) : (100/Math.abs(n)); }
function winsProjFromNextGameProb(p){ return 17 * (Number(p||0)); }
function winTotalPoints(winsProj, ou, rules){
  const baseOver = Number(rules.win_total.base_points_if_over||20);
  const baseUnder = Number(rules.win_total.base_points_if_not_over||-20);
  const deltaPts = Number(rules.win_total.points_per_win_delta||1);
  const equalIsNotOver = !!rules.win_total.equal_counts_as_not_over;
  if (!isFinite(ou)) return 0;
  if (winsProj > ou) return baseOver + (winsProj - ou) * deltaPts;
  if (winsProj < ou) return baseUnder - (ou - winsProj) * deltaPts;
  return equalIsNotOver ? baseUnder : 0;
}
function clamp01(x){ return Math.max(0, Math.min(1, x)); }

async function main(){
  const [pred, rules, rosters, odds] = await Promise.all([
    j('../data/predictions.json'),
    j('../data/rules.json'),
    j('../data/rosters.json'),
    j('../data/odds.json')
  ]);
  document.getElementById('updated').textContent = 'Updated ' + new Date(pred.generatedAt).toLocaleString();

  const byTeamNext = Object.create(null);
  for(const t of pred.nflNextGame||[]) byTeamNext[(t.team||'').toUpperCase()] = t;
  const futures = pred.nflFutures || {}; // {TEAM:{div,make_playoffs,conf,sb,reach_conf_champ,reach_sb}}

  const ouByTeam = Object.create(null);
  const divMlByTeam = Object.create(null);
  for(const t of odds.teams||[]){ ouByTeam[t.team]=t.ou_wins; divMlByTeam[t.team]=t.div_ml; }

  // Points config
  const PTS_DIV_WIN_BASE = Number(rules.division_winner.base_points||20);
  const PTS_WC = Number(rules.wild_card_spot_points||10);
  const PTS_WC_ROUND = Number(rules.playoff_points?.wc_round||15);
  const PTS_DIV_ROUND = Number(rules.playoff_points?.divisional_round||30);
  const PTS_CONF_CHAMP = Number(rules.playoff_points?.conference_champ||50);
  const PTS_SB_APPEAR = Number(rules.playoff_points?.super_bowl_appearance||75);
  const PTS_SB_WIN = Number(rules.playoff_points?.super_bowl_win||100);

  const leaderboard = [];
  const teamRows = [];

  for(const player of rosters.players){
    let total = 0;
    const parts = [];

    for(const pick of player.teams){
      const name = (pick.name||'').toUpperCase();

      // Proj wins from next-game prob (placeholder; can replace with wins futures)
      const nextProb = byTeamNext[name]?.impliedNextGameWinProb ?? 0.5;
      const projWins = winsProjFromNextGameProb(nextProb);

      // Win-total EV vs preseason OU
      const ou = Number(ouByTeam[name] ?? NaN);
      const wtPts = winTotalPoints(projWins, ou, rules);

      // Division EV = (base * preseason ML multiplier) * P_div(current)
      const ml = divMlByTeam[name];
      const mult = mlToMultiplier(ml);
      const pDiv = clamp01((futures[name]?.div) ?? 0);
      const divEV = (PTS_DIV_WIN_BASE * mult) * pDiv;

      // WC EV (spot): only if they don't win division
      const pPO = clamp01((futures[name]?.make_playoffs) ?? 0);
      const wcSpotEV = PTS_WC * Math.max(pPO - pDiv, 0);

      // Playoff rounds EV using futures probabilities (if present)
      // If we have explicit round-reach markets, use them. Otherwise derive lower bounds from pPO/pDiv.
      const pReachConf = clamp01((futures[name]?.reach_conf_champ) ?? 0);
      const pReachSB   = clamp01((futures[name]?.reach_sb) ?? (futures[name]?.sb ?? 0)); // reaching SB >= winning SB
      const pWinSB     = clamp01((futures[name]?.sb) ?? 0);

      // Approx for WC Round reach probability: playoffs but not div winners
      const pReachWCRound = Math.max(pPO - pDiv, 0);

      // Approx for Divisional Round reach probability:
      // floor = div winners (already in divisional) + WC winners (unknown). If no explicit market, use a conservative 40% WC-advance rate.
      const assumedWCAdvance = 0.40;
      const pReachDivRound = Math.max(
        pDiv,
        Math.min(1, pDiv + (pPO - pDiv) * assumedWCAdvance)
      );
      // If we have explicit pReachConf, it must be ≤ pReachDivRound. Use the max for EV lower bound consistency.
      const pReachConfRound = Math.max(pReachConf, 0);

      const evWCRound  = PTS_WC_ROUND   * pReachWCRound;
      const evDivRound = PTS_DIV_ROUND  * pReachDivRound;
      const evConf     = PTS_CONF_CHAMP * pReachConfRound;
      const evSBApp    = PTS_SB_APPEAR  * pReachSB;
      const evSBWin    = PTS_SB_WIN     * pWinSB;

      const teamTotal = wtPts + divEV + wcSpotEV + evWCRound + evDivRound + evConf + evSBApp + evSBWin;

      total += teamTotal;
      parts.push(`${name} ${teamTotal.toFixed(1)} (WT ${wtPts.toFixed(1)} | DivEV ${divEV.toFixed(1)} | PO EV ${(wcSpotEV+evWCRound+evDivRound+evConf+evSBApp+evSBWin).toFixed(1)})`);

      teamRows.push([
        player.owner, name,
        projWins.toFixed(1),
        isFinite(ou)?ou:'—',
        wtPts.toFixed(1),
        divEV.toFixed(1),
        wcSpotEV.toFixed(1),
        evWCRound.toFixed(1),
        evDivRound.toFixed(1),
        evConf.toFixed(1),
        evSBApp.toFixed(1),
        evSBWin.toFixed(1)
      ]);
    }

    leaderboard.push([player.owner, total, parts.join(' • ')]);
  }

  leaderboard.sort((a,b)=>b[1]-a[1]);

  // Render Leaderboard
  const lb = document.querySelector('#board tbody'); lb.innerHTML='';
  for(const r of leaderboard){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r[0]}</td><td>${r[1].toFixed(1)}</td><td class="small">${r[2]}</td>`;
    lb.appendChild(tr);
  }

  // Render Teams (replace table header to show new cols)
  document.querySelector('#teams thead').innerHTML =
    '<tr><th>Owner</th><th>Team</th><th>Proj Wins</th><th>O/U</th><th>WT Pts</th><th>Div EV</th><th>WC EV</th><th>WC Rnd</th><th>Div Rnd</th><th>Conf</th><th>SB App</th><th>SB Win</th></tr>';

  const tt = document.querySelector('#teams tbody'); tt.innerHTML='';
  for(const r of teamRows){
    const tr = document.createElement('tr');
    tr.innerHTML = r.map(x=>`<td>${x}</td>`).join('');
    tt.appendChild(tr);
  }
}
main().catch(e=>{
  document.body.insertAdjacentHTML('beforeend', `<p style="color:#b00">Error: ${e.message}</p>`);
  console.error(e);
});
</script>
