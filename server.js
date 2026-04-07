const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// API KEYS din environment variables
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY;

app.use(cors());
app.use(express.json());

// ══════════════════════════════════════
// HELPERS
// ══════════════════════════════════════

async function callApiFootball(endpoint, params = {}) {
  const url = new URL(`https://v3.football.api-sports.io/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const res = await fetch(url.toString(), {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY }
  });
  return res.json();
}

async function callOddsApi(endpoint, params = {}) {
  const url = new URL(`https://api.the-odds-api.com/v4/${endpoint}`);
  url.searchParams.append('apiKey', ODDS_API_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const res = await fetch(url.toString());
  return res.json();
}

async function callFootballData(endpoint) {
  const res = await fetch(`https://api.football-data.org/v4/${endpoint}`, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY }
  });
  return res.json();
}

async function callUnderstat(league, season) {
  // Understat - scraping JSON endpoint
  const leagueMap = {
    'EPL': 'EPL', 'La_Liga': 'La_liga', 'Bundesliga': 'Bundesliga',
    'Serie_A': 'Serie_A', 'Ligue_1': 'Ligue_1', 'RFPL': 'RFPL'
  };
  const lg = leagueMap[league] || 'EPL';
  try {
    const res = await fetch(`https://understat.com/league/${lg}/${season}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = await res.text();
    // Extract JSON data from script tags
    const match = html.match(/var teamsData\s*=\s*JSON\.parse\('(.+?)'\)/);
    if (match) {
      const decoded = match[1].replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)));
      return JSON.parse(decoded);
    }
  } catch (e) {
    console.log('Understat error:', e.message);
  }
  return null;
}

// ══════════════════════════════════════
// POISSON DISTRIBUTION
// ══════════════════════════════════════

function poissonPMF(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let log_pmf = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) log_pmf -= Math.log(i);
  return Math.exp(log_pmf);
}

function calcMatchProbabilities(lambdaH, lambdaA) {
  const maxG = 8;
  let pH = 0, pD = 0, pA = 0;
  const scores = [];

  for (let i = 0; i <= maxG; i++) {
    for (let j = 0; j <= maxG; j++) {
      const p = poissonPMF(lambdaH, i) * poissonPMF(lambdaA, j);
      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;
      if (p > 0.01) scores.push({ h: i, a: j, p: +(p * 100).toFixed(2) });
    }
  }
  scores.sort((a, b) => b.p - a.p);
  return { pH, pD, pA, topScores: scores.slice(0, 6) };
}

// ══════════════════════════════════════
// EDGE CALCULATOR
// ══════════════════════════════════════

function calculateEdge(modelProb, bookOdds) {
  if (!bookOdds || bookOdds <= 1) return null;
  const impliedProb = 1 / bookOdds;
  const edge = modelProb - impliedProb;
  const ev = (modelProb * bookOdds) - 1;
  const fairOdds = modelProb > 0 ? 1 / modelProb : 0;
  return {
    modelProb: +(modelProb * 100).toFixed(2),
    impliedProb: +(impliedProb * 100).toFixed(2),
    edge: +(edge * 100).toFixed(2),
    ev: +(ev * 100).toFixed(2),
    fairOdds: +fairOdds.toFixed(2),
    isValue: edge > 0.05 && bookOdds >= 1.70
  };
}

function kellyStake(modelProb, bookOdds, bankroll, fraction = 0.25) {
  const b = bookOdds - 1;
  const p = modelProb;
  const q = 1 - p;
  const kelly = Math.max((b * p - q) / b, 0);
  const fractional = kelly * fraction;
  return {
    kellyPct: +(fractional * 100).toFixed(2),
    stakeAmount: +(fractional * bankroll).toFixed(2)
  };
}

// ══════════════════════════════════════
// MODEL STRENGTH CALCULATOR
// ══════════════════════════════════════

function calcTeamStrength(stats, isHome) {
  if (!stats) return { attack: 1.0, defense: 1.0 };

  const goalsFor = isHome
    ? (parseFloat(stats.goals?.for?.average?.home) || 1.35)
    : (parseFloat(stats.goals?.for?.average?.away) || 1.10);

  const goalsAgainst = isHome
    ? (parseFloat(stats.goals?.against?.average?.home) || 1.35)
    : (parseFloat(stats.goals?.against?.average?.away) || 1.10);

  const leagueAvgHome = 1.35;
  const leagueAvgAway = 1.10;

  return {
    attack: goalsFor / (isHome ? leagueAvgHome : leagueAvgAway),
    defense: goalsAgainst / (isHome ? leagueAvgHome : leagueAvgAway),
    goalsFor,
    goalsAgainst
  };
}

function calcFormScore(fixtures, teamId, isHome) {
  if (!fixtures || fixtures.length === 0) return 0.5;

  const weights = [5, 4, 3, 2, 1];
  let score = 0, total = 0;

  fixtures.slice(0, 5).forEach((f, i) => {
    const w = weights[i] || 1;
    const tIsHome = f.teams?.home?.id == teamId;
    const hg = f.goals?.home || 0;
    const ag = f.goals?.away || 0;
    const won = tIsHome ? hg > ag : ag > hg;
    const draw = hg === ag;
    score += won ? w : draw ? w * 0.4 : 0;
    total += w;
  });

  return total > 0 ? score / total : 0.5;
}

function calcInjuryImpact(injuries) {
  if (!injuries || injuries.length === 0) return 0;
  let impact = 0;
  injuries.forEach(inj => {
    const pos = inj.player?.type || '';
    if (pos.includes('Goalkeeper')) impact += 0.9;
    else if (pos.includes('Attacker')) impact += 0.7;
    else if (pos.includes('Midfielder')) impact += 0.5;
    else if (pos.includes('Defender')) impact += 0.4;
    else impact += 0.3;
  });
  return Math.min(impact / 10, 0.3); // max 30% penalty
}

// ══════════════════════════════════════
// MAIN SCANNER ENGINE
// ══════════════════════════════════════

async function scanLeague(sport, leagueKey, season) {
  const valueBets = [];

  try {
    // 1. Get upcoming fixtures + odds from The Odds API
    const oddsData = await callOddsApi(`sports/${sport}/odds`, {
      regions: 'eu',
      markets: 'h2h',
      oddsFormat: 'decimal',
      dateFormat: 'iso'
    });

    if (!oddsData || !Array.isArray(oddsData)) return valueBets;

    // Filter relevant league
    const fixtures = oddsData.filter(g =>
      g.sport_key === sport || sport === 'all'
    ).slice(0, 20); // limit to save API calls

    for (const fixture of fixtures) {
      try {
        const homeTeam = fixture.home_team;
        const awayTeam = fixture.away_team;

        // Get best odds from bookmakers
        let bestOddsH = 0, bestOddsD = 0, bestOddsA = 0;
        let bookH = '', bookD = '', bookA = '';

        fixture.bookmakers?.forEach(bk => {
          bk.markets?.forEach(mkt => {
            if (mkt.key === 'h2h') {
              mkt.outcomes?.forEach(o => {
                if (o.name === homeTeam && o.price > bestOddsH) {
                  bestOddsH = o.price; bookH = bk.title;
                }
                if (o.name === 'Draw' && o.price > bestOddsD) {
                  bestOddsD = o.price; bookD = bk.title;
                }
                if (o.name === awayTeam && o.price > bestOddsA) {
                  bestOddsA = o.price; bookA = bk.title;
                }
              });
            }
          });
        });

        // Skip if no valid odds
        if (!bestOddsH || !bestOddsD || !bestOddsA) continue;

        // Calculate overround
        const overround = (1/bestOddsH + 1/bestOddsD + 1/bestOddsA);

        // Get team stats from API-Football
        const [homeSearch, awaySearch] = await Promise.all([
          callApiFootball('teams', { search: homeTeam.split(' ')[0] }),
          callApiFootball('teams', { search: awayTeam.split(' ')[0] })
        ]);

        const homeTeamData = homeSearch.response?.[0];
        const awayTeamData = awaySearch.response?.[0];

        if (!homeTeamData || !awayTeamData) continue;

        const homeId = homeTeamData.team.id;
        const awayId = awayTeamData.team.id;

        // Get stats + form + h2h + injuries in parallel
        const [homeStats, awayStats, homeForm, awayForm, h2hData, homeInj, awayInj] = await Promise.all([
          callApiFootball('teams/statistics', { team: homeId, season, league: leagueKey }),
          callApiFootball('teams/statistics', { team: awayId, season, league: leagueKey }),
          callApiFootball('fixtures', { team: homeId, season, last: 5, status: 'FT' }),
          callApiFootball('fixtures', { team: awayId, season, last: 5, status: 'FT' }),
          callApiFootball('fixtures/headtohead', { h2h: `${homeId}-${awayId}`, last: 10, status: 'FT' }),
          callApiFootball('injuries', { team: homeId, season, league: leagueKey }),
          callApiFootball('injuries', { team: awayId, season, league: leagueKey })
        ]);

        // Calculate team strengths
        const homeStrength = calcTeamStrength(homeStats.response, true);
        const awayStrength = calcTeamStrength(awayStats.response, false);

        // Lambda for Poisson
        const lgAvg = 1.35;
        const lambdaH = homeStrength.attack * awayStrength.defense * lgAvg;
        const lambdaA = awayStrength.attack * homeStrength.defense * lgAvg * 0.85;

        // Base probabilities from Poisson
        let { pH, pD, pA } = calcMatchProbabilities(lambdaH, lambdaA);

        // Adjust with form
        const homeFormScore = calcFormScore(homeForm.response, homeId, true);
        const awayFormScore = calcFormScore(awayForm.response, awayId, false);
        const formAdj = (homeFormScore - awayFormScore) * 0.1;
        pH = Math.min(Math.max(pH + formAdj, 0.05), 0.90);
        pA = Math.min(Math.max(pA - formAdj, 0.05), 0.90);

        // Adjust with injuries
        const homeInjImpact = calcInjuryImpact(homeInj.response);
        const awayInjImpact = calcInjuryImpact(awayInj.response);
        pH = Math.max(pH - homeInjImpact, 0.05);
        pA = Math.max(pA - awayInjImpact, 0.05);

        // Normalize
        const total = pH + pD + pA;
        pH /= total; pD /= total; pA /= total;

        // H2H adjustment
        const h2h = h2hData.response || [];
        if (h2h.length >= 3) {
          let hw = 0, aw = 0;
          h2h.forEach(f => {
            const hg = f.goals?.home || 0, ag = f.goals?.away || 0;
            if (hg > ag) hw++;
            else if (ag > hg) aw++;
          });
          const h2hAdj = ((hw - aw) / h2h.length) * 0.05;
          pH = Math.min(Math.max(pH + h2hAdj, 0.05), 0.90);
          pA = Math.min(Math.max(pA - h2hAdj, 0.05), 0.90);
        }

        // Calculate edges
        const edgeH = calculateEdge(pH, bestOddsH);
        const edgeD = calculateEdge(pD, bestOddsD);
        const edgeA = calculateEdge(pA, bestOddsA);

        // Check for value bets
        const bets = [
          { selection: `${homeTeam} WIN`, market: '1', prob: pH, odds: bestOddsH, book: bookH, edge: edgeH },
          { selection: 'DRAW', market: 'X', prob: pD, odds: bestOddsD, book: bookD, edge: edgeD },
          { selection: `${awayTeam} WIN`, market: '2', prob: pA, odds: bestOddsA, book: bookA, edge: edgeA }
        ];

        bets.forEach(bet => {
          if (bet.edge?.isValue && bet.odds >= 1.70 && bet.odds <= 4.00) {
            valueBets.push({
              id: `${fixture.id}_${bet.market}`,
              match: `${homeTeam} vs ${awayTeam}`,
              date: fixture.commence_time,
              league: fixture.sport_title,
              selection: bet.selection,
              market: bet.market,
              odds: bet.odds,
              bestBook: bet.book,
              modelProb: bet.edge.modelProb,
              impliedProb: bet.edge.impliedProb,
              edge: bet.edge.edge,
              ev: bet.edge.ev,
              fairOdds: bet.edge.fairOdds,
              overround: +((overround - 1) * 100).toFixed(1),
              lambdaH: +lambdaH.toFixed(2),
              lambdaA: +lambdaA.toFixed(2),
              homeForm: homeFormScore,
              awayForm: awayFormScore,
              homeInjuries: homeInj.response?.length || 0,
              awayInjuries: awayInj.response?.length || 0,
              confidence: bet.edge.edge > 10 ? 'HIGH' : bet.edge.edge > 7 ? 'MEDIUM' : 'LOW'
            });
          }
        });

      } catch (matchErr) {
        console.log('Match error:', matchErr.message);
        continue;
      }
    }
  } catch (e) {
    console.log('League scan error:', e.message);
  }

  return valueBets;
}

// ══════════════════════════════════════
// ROUTES
// ══════════════════════════════════════

// Status
app.get('/status', async (req, res) => {
  try {
    const afStatus = await callApiFootball('status', {});
    res.json({
      status: 'ok',
      apiFootball: afStatus.response?.subscription?.plan || 'connected',
      oddsApi: ODDS_API_KEY ? 'configured' : 'missing',
      footballData: FOOTBALL_DATA_KEY ? 'configured' : 'missing',
      understat: 'available'
    });
  } catch (e) {
    res.json({ status: 'ok', message: 'Server running' });
  }
});

// Scan for value bets
app.get('/scan', async (req, res) => {
  const { sport = 'soccer_italy_serie_a', league = '135', season = '2024' } = req.query;

  try {
    const valueBets = await scanLeague(sport, league, season);
    valueBets.sort((a, b) => b.edge - a.edge);

    res.json({
      timestamp: new Date().toISOString(),
      total: valueBets.length,
      valueBets
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get available sports/leagues from Odds API
app.get('/leagues', async (req, res) => {
  try {
    const sports = await callOddsApi('sports', { all: 'false' });
    const football = sports.filter(s =>
      s.key.includes('soccer') || s.key.includes('football')
    );
    res.json(football);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get upcoming fixtures with odds
app.get('/fixtures', async (req, res) => {
  const { sport = 'soccer_italy_serie_a' } = req.query;
  try {
    const data = await callOddsApi(`sports/${sport}/odds`, {
      regions: 'eu',
      markets: 'h2h',
      oddsFormat: 'decimal'
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Single match analysis
app.get('/analyze', async (req, res) => {
  const { home, away, homeId, awayId, leagueId, season = '2024', oddsH, oddsD, oddsA } = req.query;

  try {
    const [homeStats, awayStats, homeForm, awayForm, h2hData, homeInj, awayInj] = await Promise.all([
      callApiFootball('teams/statistics', { team: homeId, season, league: leagueId }),
      callApiFootball('teams/statistics', { team: awayId, season, league: leagueId }),
      callApiFootball('fixtures', { team: homeId, season, last: 5, status: 'FT' }),
      callApiFootball('fixtures', { team: awayId, season, last: 5, status: 'FT' }),
      callApiFootball('fixtures/headtohead', { h2h: `${homeId}-${awayId}`, last: 10, status: 'FT' }),
      callApiFootball('injuries', { team: homeId, season, league: leagueId }),
      callApiFootball('injuries', { team: awayId, season, league: leagueId })
    ]);

    const homeStrength = calcTeamStrength(homeStats.response, true);
    const awayStrength = calcTeamStrength(awayStats.response, false);

    const lgAvg = 1.35;
    const lambdaH = homeStrength.attack * awayStrength.defense * lgAvg;
    const lambdaA = awayStrength.attack * homeStrength.defense * lgAvg * 0.85;

    let { pH, pD, pA, topScores } = calcMatchProbabilities(lambdaH, lambdaA);

    const homeFormScore = calcFormScore(homeForm.response, homeId, true);
    const awayFormScore = calcFormScore(awayForm.response, awayId, false);
    const formAdj = (homeFormScore - awayFormScore) * 0.1;

    pH = Math.min(Math.max(pH + formAdj, 0.05), 0.90);
    pA = Math.min(Math.max(pA - formAdj, 0.05), 0.90);

    const homeInjImpact = calcInjuryImpact(homeInj.response);
    const awayInjImpact = calcInjuryImpact(awayInj.response);
    pH = Math.max(pH - homeInjImpact, 0.05);
    pA = Math.max(pA - awayInjImpact, 0.05);

    const total = pH + pD + pA;
    pH /= total; pD /= total; pA /= total;

    const edgeH = oddsH ? calculateEdge(pH, parseFloat(oddsH)) : null;
    const edgeD = oddsD ? calculateEdge(pD, parseFloat(oddsD)) : null;
    const edgeA = oddsA ? calculateEdge(pA, parseFloat(oddsA)) : null;

    res.json({
      match: `${home} vs ${away}`,
      probabilities: {
        home: +(pH * 100).toFixed(2),
        draw: +(pD * 100).toFixed(2),
        away: +(pA * 100).toFixed(2)
      },
      lambdas: { home: +lambdaH.toFixed(3), away: +lambdaA.toFixed(3) },
      topScores,
      edges: { home: edgeH, draw: edgeD, away: edgeA },
      form: { home: +homeFormScore.toFixed(3), away: +awayFormScore.toFixed(3) },
      injuries: { home: homeInj.response?.length || 0, away: awayInj.response?.length || 0 },
      teamStrength: { home: homeStrength, away: awayStrength }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Teams search
app.get('/teams', async (req, res) => {
  try {
    const data = await callApiFootball('teams', { search: req.query.name });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Standings
app.get('/standings', async (req, res) => {
  try {
    const data = await callApiFootball('standings', {
      league: req.query.league || '135',
      season: req.query.season || '2024'
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Football-data.org standings (backup)
app.get('/fd-standings', async (req, res) => {
  try {
    const data = await callFootballData(`competitions/${req.query.code || 'SA'}/standings`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Value Bet Scanner running on port ${PORT}`));
