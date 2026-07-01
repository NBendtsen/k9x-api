// K9X Esport — match feed
// Vercel serverless function: fetches results + upcoming from vlr.gg


const TEAM_ID = 21696;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  // Vercel CDN serves cached response for 10 min — keeps invocations minimal
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=120');

  try {
    const data = await fetchMatches();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Fetch failed', message: String(err.message) });
  }
};

// ── fetch strategy ────────────────────────────────────────────────────────────
async function fetchMatches() {
  // 1) Try the community vlresports JSON API (server-side → no CORS issue)
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`https://vlr.orlandomm.net/api/v1/teams/${TEAM_ID}`, {
      headers: { 'User-Agent': 'K9XSite/1.0' },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (r.ok) {
      const json = await r.json();
      const out = normalizeVlresports(json);
      if (out.results.length || out.upcoming.length) return out;
    }
  } catch (_) { /* fall through */ }

  // 2) Fallback: scrape vlr.gg team matches page directly
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  const r = await fetch(`https://www.vlr.gg/team/matches/${TEAM_ID}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; K9XSite/1.0)',
      'Accept': 'text/html',
    },
    signal: ctrl.signal,
  });
  clearTimeout(t);
  if (!r.ok) throw new Error(`vlr.gg responded with ${r.status}`);
  return scrapeHtml(await r.text());
}

// ── vlresports API normalizer ─────────────────────────────────────────────────
function normalizeVlresports(json) {
  const d = (json && json.data) || json || {};
  return {
    results:  (d.results  || []).map(function(m) { return norm(m, 'result'); }),
    upcoming: (d.upcoming || []).map(function(m) { return norm(m, 'upcoming'); }),
  };
}

function norm(item, status) {
  const teams  = item.teams || [];
  const a      = teams.find(isK9X) || teams[0] || {};
  const b      = teams.find(function(t) { return t !== a; }) || teams[1] || {};
  const aScore = parseScore(a.points != null ? a.points : a.score);
  const bScore = parseScore(b.points != null ? b.points : b.score);
  const result = (status === 'result' && aScore != null && bScore != null)
    ? (aScore > bScore ? 'W' : 'L') : null;
  return {
    id:     String((item.id) || (item.match && item.match.id) || Math.random()),
    event:  (item.event && item.event.name) || item.tournament || 'Valorant',
    stage:  (item.event && item.event.series) || item.round || '',
    date:   fmtDate(item.utc || item.date),
    status: status,
    teamA:  { name: 'K9X', score: aScore },
    teamB:  { name: b.name || 'TBD', tag: tagFrom(b), score: bScore },
    result: result,
    format: item.format || '',
    time:   fmtTime(item.utc || item.time),
  };
}

// ── vlr.gg HTML scraper (fallback) ────────────────────────────────────────────
function scrapeHtml(html) {
  const results  = [];
  const upcoming = [];
  const blocks   = html.split(/class="match-item/);

  for (var i = 1; i < Math.min(blocks.length, 30); i++) {
    var block = blocks[i];
    try {
      var completed  = /completed|final/i.test(block);
      var eventMatch = block.match(/match-item-event[^>]*>([^<]+)/);
      var stageMatch = block.match(/match-item-event-series[^>]*>([^<]+)/);
      var dateMatch  = block.match(/(\d{1,2}\s+\w{3}\s+\d{4})/);
      var teamRe     = /team-name[^>]*>\s*([^<]+?)\s*</g;
      var scoreRe    = /team-score[^>]*>\s*(\d+)\s*</g;
      var teamNames  = []; var m;
      while ((m = teamRe.exec(block)) !== null) teamNames.push(m[1].trim());
      var scores = [];
      while ((m = scoreRe.exec(block)) !== null) scores.push(parseInt(m[1]));
      if (teamNames.length < 2) continue;

      var k9xFirst = isK9X({ name: teamNames[0] });
      var aScore   = k9xFirst ? (scores[0] != null ? scores[0] : null) : (scores[1] != null ? scores[1] : null);
      var bScore   = k9xFirst ? (scores[1] != null ? scores[1] : null) : (scores[0] != null ? scores[0] : null);
      var opp      = k9xFirst ? teamNames[1] : teamNames[0];

      var match = {
        id:     Math.random().toString(36).slice(2),
        event:  (eventMatch && eventMatch[1].trim()) || 'Valorant',
        stage:  (stageMatch && stageMatch[1].trim()) || '',
        date:   (dateMatch && dateMatch[1]) || '',
        status: completed ? 'result' : 'upcoming',
        teamA:  { name: 'K9X', score: aScore },
        teamB:  { name: opp, tag: tagFrom({ name: opp }), score: bScore },
        result: (completed && aScore != null && bScore != null) ? (aScore > bScore ? 'W' : 'L') : null,
        format: '',
        time:   'TBD',
      };

      if (completed) results.push(match);
      else upcoming.push(match);
    } catch (_) { /* skip malformed block */ }
  }

  return { results: results, upcoming: upcoming };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function isK9X(t) {
  return /k9x|esperg/i.test((t && t.name) || '');
}

function parseScore(v) {
  if (v == null) return null;
  var n = parseInt(String(v).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function tagFrom(t) {
  var nm = ((t && t.name) || '').trim();
  if (t && t.tag && t.tag.length <= 5) return String(t.tag).toUpperCase();
  var words = nm.replace(/esports?|academy|gaming|team|club|gg/gi, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.map(function(w) { return w[0]; }).join('').slice(0, 4).toUpperCase();
  return nm.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'TBD';
}

var MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function fmtDate(v) {
  if (!v) return '';
  var d = new Date(v);
  if (isNaN(d.getTime())) return String(v).slice(0, 12).toUpperCase();
  return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

function fmtTime(v) {
  if (!v) return 'TBD';
  var d = new Date(v);
  if (isNaN(d.getTime())) return 'TBD';
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' UTC';
}
