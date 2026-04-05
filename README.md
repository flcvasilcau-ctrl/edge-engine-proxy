# Edge Engine Proxy

Proxy server pentru API-Football — rezolvă CORS pentru Edge Engine 2.0.

## Deploy pe Railway

1. Fork acest repo
2. Conectează-l pe Railway.app
3. Adaugă variabila de mediu: `API_KEY=cheia_ta_rapidapi`
4. Deploy automat

## Endpoints

- `GET /status` — verifică API
- `GET /teams?name=Real Madrid` — caută echipă
- `GET /analyze?home_id=541&away_id=529&league_id=140&season=2025` — analiză completă auto
- `GET /form?team=541&season=2025&last=5` — formă recentă
- `GET /h2h?h2h=541-529&last=10` — head to head
- `GET /standings?league=140&season=2025` — clasament
- `GET /injuries?team=541&season=2025&league=140` — accidentați
