const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

app.use(cors());
app.use(express.json());

// ── HELPER: apel API-Football direct api-sports ──
async function apiCall(endpoint, params) {
  const url = new URL(`https://v3.football.api-sports.io/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'x-apisports-key': API_KEY
    }
  });
  return res.json();
}

app.get('/status', async (req, res) => {
  try { res.json(await apiCall('status', {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/teams', async (req, res) => {
  try { res.json(await apiCall('teams', { search: req.query.name })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/form', async (req, res) => {
  try {
    const { team, season, last } = req.query;
    res.json(await apiCall('fixtures', { team, season: season||'2025', last: last||5, status:'FT' }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/team-stats', async (req, res) => {
  try {
    const { team, season, league } = req.query;
    res.json(await apiCall('teams/statistics', { team, season: season||'2025', league }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/h2h', async (req, res) => {
  try {
    const { h2h, last } = req.query;
    res.json(await apiCall('fixtures/headtohead', { h2h, last: last||10, status:'FT' }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/standings', async (req, res) => {
  try {
    const { league, season } = req.query;
    res.json(await apiCall('standings', { league, season: season||'2025' }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/injuries', async (req, res) => {
  try {
    const { team, season, league } = req.query;
    res.json(await apiCall('injuries', { team, season: season||'2025', league }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/fixtures', async (req, res) => {
  try {
    const { team, season, next, league } = req.query;
    const params = { team, season: season||'2025' };
    if (next) params.next = next;
    if (league) params.league = league;
    res.json(await apiCall('fixtures', params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/analyze', async (req, res) => {
  try {
    const { home_id, away_id, league_id, season } = req.query;
    const s = season || '2025';

    const [homeForm, awayForm, homeStats, awayStats, h2hData, homeInj, awayInj] = await Promise.all([
      apiCall('fixtures', { team: home_id, season: s, last: 5, status: 'FT' }),
      apiCall('fixtures', { team: away_id, season: s, last: 5, status: 'FT' }),
      apiCall('teams/statistics', { team: home_id, season: s, league: league_id }),
      apiCall('teams/statistics', { team: away_id, season: s, league: league_id }),
      apiCall('fixtures/headtohead', { h2h: `${home_id}-${away_id}`, last: 10, status: 'FT' }),
      apiCall('injuries', { team: home_id, season: s, league: league_id }),
      apiCall('injuries', { team: away_id, season: s, league: league_id })
    ]);

    let standings = { response: [] };
    if (league_id) standings = await apiCall('standings', { league: league_id, season: s });

    const results = {
      homeForm: homeForm.response || [],
      awayForm: awayForm.response || [],
      homeStats: homeStats.response || {},
      awayStats: awayStats.response || {},
      h2h: h2hData.response || [],
      standings: standings.response || [],
      homeInjuries: homeInj.response || [],
      awayInjuries: awayInj.response || []
    };

    res.json({ processed: processData(results, home_id, away_id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function processData(data, homeId, awayId) {
  const out = {};

  if (data.homeForm.length > 0) {
    out.homeFormStr = data.homeForm.slice(0, 5).map(f => {
      const isHome = f.teams?.home?.id == homeId;
      const hg = f.goals?.home || 0, ag = f.goals?.away || 0;
      const scored = isHome ? hg : ag;
      const conceded = isHome ? ag : hg;
      const won = isHome ? hg > ag : ag > hg;
      return { result: won ? 'V' : hg === ag ? 'E' : 'I', scored, conceded };
    });
    out.homeAvgGoals = +(out.homeFormStr.reduce((s,f)=>s+(f.scored||0),0)/out.homeFormStr.length).toFixed(2);
    out.homeAvgConcede = +(out.homeFormStr.reduce((s,f)=>s+(f.conceded||0),0)/out.homeFormStr.length).toFixed(2);
  }

  if (data.awayForm.length > 0) {
    out.awayFormStr = data.awayForm.slice(0, 5).map(f => {
      const isAway = f.teams?.away?.id == awayId;
      const hg = f.goals?.home || 0, ag = f.goals?.away || 0;
      const scored = isAway ? ag : hg;
      const conceded = isAway ? hg : ag;
      const won = isAway ? ag > hg : hg > ag;
      return { result: won ? 'V' : hg === ag ? 'E' : 'I', scored, conceded };
    });
    out.awayAvgGoals = +(out.awayFormStr.reduce((s,f)=>s+(f.scored||0),0)/out.awayFormStr.length).toFixed(2);
    out.awayAvgConcede = +(out.awayFormStr.reduce((s,f)=>s+(f.conceded||0),0)/out.awayFormStr.length).toFixed(2);
  }

  const hs = data.homeStats, as_ = data.awayStats;
  if (hs.fixtures) {
    out.homeWinPctHome = hs.fixtures.wins?.home && hs.fixtures.played?.home
      ? +((hs.fixtures.wins.home/hs.fixtures.played.home)*100).toFixed(1) : 0;
    out.homeGoalsForHome = hs.goals?.for?.average?.home || 0;
    out.homeGoalsAgainstHome = hs.goals?.against?.average?.home || 0;
  }
  if (as_.fixtures) {
    out.awayWinPctAway = as_.fixtures.wins?.away && as_.fixtures.played?.away
      ? +((as_.fixtures.wins.away/as_.fixtures.played.away)*100).toFixed(1) : 0;
    out.awayGoalsForAway = as_.goals?.for?.average?.away || 0;
    out.awayGoalsAgainstAway = as_.goals?.against?.average?.away || 0;
  }

  if (data.h2h.length > 0) {
    let hw=0, aw=0, dr=0;
    data.h2h.forEach(f => {
      const hg=f.goals?.home||0, ag=f.goals?.away||0;
      if(hg>ag) hw++; else if(ag>hg) aw++; else dr++;
    });
    out.h2hHomeWins=hw; out.h2hAwayWins=aw; out.h2hDraws=dr;
  }

  if (data.standings?.[0]?.league?.standings?.[0]) {
    const table = data.standings[0].league.standings[0];
    out.homeRank = table.find(r=>r.team?.id==homeId)?.rank || 0;
    out.awayRank = table.find(r=>r.team?.id==awayId)?.rank || 0;
  }

  out.homeInjuryCount = data.homeInjuries?.length || 0;
  out.awayInjuryCount = data.awayInjuries?.length || 0;

  return out;
}

app.listen(PORT, () => console.log(`Edge Engine Proxy running on port ${PORT}`));
