const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

app.use(cors());
app.use(express.json());

// ── HELPER: apel API-Football ──
async function apiCall(endpoint, params) {
  const url = new URL(`https://v3.football.api-sports.io/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const res = await fetch(url.toString(), {
    headers: { 'x-apisports-key': API_KEY }
  });
  return res.json();
}

// ── STATUS ──
app.get('/status', async (req, res) => {
  try {
    const data = await apiCall('status', {});
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CAUTĂ ECHIPĂ ──
app.get('/teams', async (req, res) => {
  try {
    const { name } = req.query;
    const data = await apiCall('teams', { search: name });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FORMĂ RECENTĂ (ultimele 5 meciuri) ──
app.get('/form', async (req, res) => {
  try {
    const { team, season, last } = req.query;
    const data = await apiCall('fixtures', {
      team,
      season: season || '2025',
      last: last || 5,
      status: 'FT'
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── STATISTICI ECHIPĂ (sezon) ──
app.get('/team-stats', async (req, res) => {
  try {
    const { team, season, league } = req.query;
    const data = await apiCall('teams/statistics', {
      team,
      season: season || '2025',
      league
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── H2H ──
app.get('/h2h', async (req, res) => {
  try {
    const { h2h, last } = req.query;
    const data = await apiCall('fixtures/headtohead', {
      h2h,
      last: last || 10,
      status: 'FT'
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ACCIDENTAȚI / SUSPENDAȚI ──
app.get('/injuries', async (req, res) => {
  try {
    const { team, fixture, season, league } = req.query;
    const params = {};
    if (fixture) params.fixture = fixture;
    else { params.team = team; params.season = season || '2025'; if (league) params.league = league; }
    const data = await apiCall('injuries', params);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLASAMENT ──
app.get('/standings', async (req, res) => {
  try {
    const { league, season } = req.query;
    const data = await apiCall('standings', {
      league,
      season: season || '2025'
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── COTE BOOKMAKERS ──
app.get('/odds', async (req, res) => {
  try {
    const { fixture } = req.query;
    const data = await apiCall('odds', { fixture, bookmaker: 8 }); // 8 = Bet365
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── MECIURI VIITOARE (caută fixture ID) ──
app.get('/fixtures', async (req, res) => {
  try {
    const { team, season, next, league } = req.query;
    const params = { team, season: season || '2025' };
    if (next) params.next = next;
    if (league) params.league = league;
    const data = await apiCall('fixtures', params);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── STATISTICI MECI (posesie, suturi etc) ──
app.get('/fixture-stats', async (req, res) => {
  try {
    const { fixture } = req.query;
    const data = await apiCall('fixtures/statistics', { fixture });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ANALIZĂ COMPLETĂ AUTO ──
// Trage tot ce e necesar pentru un meci dintr-un singur apel
app.get('/analyze', async (req, res) => {
  try {
    const { home_id, away_id, league_id, season, fixture_id } = req.query;
    const s = season || '2025';

    const results = {};

    // Formă recentă
    const [homeForm, awayForm] = await Promise.all([
      apiCall('fixtures', { team: home_id, season: s, last: 5, status: 'FT' }),
      apiCall('fixtures', { team: away_id, season: s, last: 5, status: 'FT' })
    ]);
    results.homeForm = homeForm.response || [];
    results.awayForm = awayForm.response || [];

    // Statistici sezon
    const [homeStats, awayStats] = await Promise.all([
      apiCall('teams/statistics', { team: home_id, season: s, league: league_id }),
      apiCall('teams/statistics', { team: away_id, season: s, league: league_id })
    ]);
    results.homeStats = homeStats.response || {};
    results.awayStats = awayStats.response || {};

    // H2H
    const h2h = await apiCall('fixtures/headtohead', {
      h2h: `${home_id}-${away_id}`,
      last: 10,
      status: 'FT'
    });
    results.h2h = h2h.response || [];

    // Clasament
    if (league_id) {
      const standings = await apiCall('standings', { league: league_id, season: s });
      results.standings = standings.response || [];
    }

    // Accidentați
    const [homeInj, awayInj] = await Promise.all([
      apiCall('injuries', { team: home_id, season: s, league: league_id }),
      apiCall('injuries', { team: away_id, season: s, league: league_id })
    ]);
    results.homeInjuries = homeInj.response || [];
    results.awayInjuries = awayInj.response || [];

    // Cote (dacă avem fixture_id)
    if (fixture_id) {
      const odds = await apiCall('odds', { fixture: fixture_id, bookmaker: 8 });
      results.odds = odds.response || [];
    }

    // ── PROCESARE DATE → format simplu pentru frontend ──
    const processed = processData(results, home_id, away_id);
    res.json({ raw: results, processed });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PROCESARE DATE ──
function processData(data, homeId, awayId) {
  const out = {};

  // Formă X
  if (data.homeForm.length > 0) {
    out.homeFormStr = data.homeForm.slice(0, 5).map(f => {
      const hg = f.goals?.home, ag = f.goals?.away;
      const isHome = f.teams?.home?.id == homeId;
      const scored = isHome ? hg : ag;
      const conceded = isHome ? ag : hg;
      const won = isHome ? hg > ag : ag > hg;
      const draw = hg === ag;
      return { result: won ? 'V' : draw ? 'E' : 'I', scored, conceded };
    });
    out.homeAvgGoals = +(out.homeFormStr.reduce((s, f) => s + (f.scored || 0), 0) / out.homeFormStr.length).toFixed(2);
    out.homeAvgConcede = +(out.homeFormStr.reduce((s, f) => s + (f.conceded || 0), 0) / out.homeFormStr.length).toFixed(2);
  }

  // Formă Y
  if (data.awayForm.length > 0) {
    out.awayFormStr = data.awayForm.slice(0, 5).map(f => {
      const hg = f.goals?.home, ag = f.goals?.away;
      const isAway = f.teams?.away?.id == awayId;
      const scored = isAway ? ag : hg;
      const conceded = isAway ? hg : ag;
      const won = isAway ? ag > hg : hg > ag;
      const draw = hg === ag;
      return { result: won ? 'V' : draw ? 'E' : 'I', scored, conceded };
    });
    out.awayAvgGoals = +(out.awayFormStr.reduce((s, f) => s + (f.scored || 0), 0) / out.awayFormStr.length).toFixed(2);
    out.awayAvgConcede = +(out.awayFormStr.reduce((s, f) => s + (f.conceded || 0), 0) / out.awayFormStr.length).toFixed(2);
  }

  // Statistici sezon
  const hs = data.homeStats;
  const as_ = data.awayStats;
  if (hs.fixtures) {
    out.homeWinPctHome = hs.fixtures.wins?.home && hs.fixtures.played?.home
      ? +((hs.fixtures.wins.home / hs.fixtures.played.home) * 100).toFixed(1) : 0;
    out.homeGoalsForHome = hs.goals?.for?.average?.home || 0;
    out.homeGoalsAgainstHome = hs.goals?.against?.average?.home || 0;
  }
  if (as_.fixtures) {
    out.awayWinPctAway = as_.fixtures.wins?.away && as_.fixtures.played?.away
      ? +((as_.fixtures.wins.away / as_.fixtures.played.away) * 100).toFixed(1) : 0;
    out.awayGoalsForAway = as_.goals?.for?.average?.away || 0;
    out.awayGoalsAgainstAway = as_.goals?.against?.average?.away || 0;
  }

  // H2H
  if (data.h2h.length > 0) {
    let hw = 0, aw = 0, dr = 0;
    data.h2h.forEach(f => {
      const hg = f.goals?.home, ag = f.goals?.away;
      if (hg > ag) hw++;
      else if (ag > hg) aw++;
      else dr++;
    });
    out.h2hHomeWins = hw;
    out.h2hAwayWins = aw;
    out.h2hDraws = dr;
    out.h2hTotal = data.h2h.length;
  }

  // Clasament
  if (data.standings?.[0]?.league?.standings?.[0]) {
    const table = data.standings[0].league.standings[0];
    const homeRow = table.find(r => r.team?.id == homeId);
    const awayRow = table.find(r => r.team?.id == awayId);
    out.homeRank = homeRow?.rank || 0;
    out.awayRank = awayRow?.rank || 0;
  }

  // Accidentați
  out.homeInjuryCount = data.homeInjuries?.filter(p =>
    ['Injured','Suspended'].includes(p.player?.reason)
  ).length || data.homeInjuries?.length || 0;
  out.awayInjuryCount = data.awayInjuries?.filter(p =>
    ['Injured','Suspended'].includes(p.player?.reason)
  ).length || data.awayInjuries?.length || 0;

  // Cote
  if (data.odds?.[0]?.bookmakers?.[0]?.bets) {
    const match_winner = data.odds[0].bookmakers[0].bets.find(b => b.name === 'Match Winner');
    if (match_winner) {
      out.oddsHome = parseFloat(match_winner.values.find(v => v.value === 'Home')?.odd || 0);
      out.oddsDraw = parseFloat(match_winner.values.find(v => v.value === 'Draw')?.odd || 0);
      out.oddsAway = parseFloat(match_winner.values.find(v => v.value === 'Away')?.odd || 0);
    }
  }

  return out;
}

app.listen(PORT, () => console.log(`Edge Engine Proxy running on port ${PORT}`));
