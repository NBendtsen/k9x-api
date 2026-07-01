// K9X Esport — match feed
// Vercel serverless function: fetches results + upcoming from vlr.gg


const TEAM_ID   = 21696;
const TEAM_SLUG = 'esperg-rde-esport-k9x';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=120');

  var debug = req.query && req.query.debug === '1';

  try {
    var result = await fetchMatches(debug);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Fetch failed', message: String(err.message) });
  }
};

// ── fetch strategy ────────────────────────────────────────────────────────────
async function fetchMatches(debug) {
  var log = {};

  // 1) Try vlresports JSON API
  try {
    var ctrl1 = new AbortController();
    var t1 = setTimeout(function() { ctrl1.abort(); }, 6000);
    var r1 = await fetch('https://vlr.orlandomm.net/api/v1/teams/' + TEAM_ID, {
      headers: { 'User-Agent': 'K9XSite/1.0' },
      signal: ctrl1.signal,
    });
    clearTimeout(t1);
    var json1 = null;
    if (r1.ok) {
      json1 = await r1.json();
      var out1 = normalizeVlresports(json1);
      log.vlresports = { status: r1.status, results: out1.results.length, upcoming: out1.upcoming.length };
      if (out1.results.length || out1.upcoming.length) {
        if (debug) out1._debug = log;
        return out1;
      }
    } else {
      log.vlresports = { status: r1.status };
    }
  } catch (e) {
    log.vlresports = { error: String(e.message) };
  }

  // 2) Scrape vlr.gg team matches page (full slug URL)
  var vlrUrl = 'https://www.vlr.gg/team/matches/' + TEAM_ID + '/' + TEAM_SLUG;
  try {
    var ctrl2 = new AbortController();
    var t2 = setTimeout(function() { ctrl2.abort(); }, 9000);
    var r2 = await fetch(vlrUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: ctrl2.signal,
    });
    clearTimeout(t2);
    log.vlrgg = { url: vlrUrl, status: r2.status };
    if (r2.ok) {
      var html = await r2.text();
      log.vlrgg.htmlLength = html.length;
      log.vlrgg.sampleHtml = html.slice(0, 800); // first 800 chars for debug
      var out2 = scrapeHtml(html);
      log.vlrgg.results = out2.results.length;
      log.vlrgg.upcoming = out2.upcoming.length;
      if (debug) out2._debug = log;
      return out2;
    }
  } catch (e) {
    log.vlrgg = { error: String(e.message) };
  }

  var empty = { results: [], upcoming: [] };
  if (debug) empty._debug = log;
  return empty;
}

// ── vlresports API normalizer ─────────────────────────────────────────────────
function normalizeVlresports(json) {
  var d = (json && json.data) || json || {};
  return {
    results:  (d.results  || []).map(function(m) { return norm(m, 'result'); }),
    upcoming: (d.upcoming || []).map(function(m) { return norm(m, 'upcoming'); }),
  };
}

function norm(item, status) {
  var teams  = item.teams || [];
  var a      = teams.find(isK9X) || teams[0] || {};
  var b      = teams.find(function(t) { return t !== a; }) || teams[1] || {};
  var aScore = parseScore(a.points != null ? a.points : a.score);
  var bScore = parseScore(b.points != null ? b.points : b.score);
  var result = (status === 'result' && aScore != null && bScore != null)
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

// ── vlr.gg HTML scraper ───────────────────────────────────────────────────────
function scrapeHtml(html) {
  var results  = [];
  var upcoming = [];

  // vlr.gg wraps each match row in <a class="wf-module-item match-item ...">
  var blocks = html.split('match-item');

  for (var i = 1; i < Math.min(blocks.length, 40); i++) {
    var block = blocks[i];
    try {
      var completed = /mod-completed/i.test(block) || /match-item-status--completed/i.test(block);
      var live      = /mod-live/i.test(block);

      // Event name
      var evMatch    = block.match(/match-item-event["\s][^>]*>\s*<[^>]+>\s*([^<]+)/);
      var serMatch   = block.match(/match-item-event-series["\s][^>]*>\s*([^<\n]+)/);

      // Date
      var dateMatch  = block.match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{2,4})/);
      var dateMatch2 = block.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/i);

      // Team names — vlr.gg uses .match-item-vs-team-name
      var teamRe   = /match-item-vs-team-name[^>]*>\s*([^<]+?)\s*</g;
      var scoreRe  = /match-item-vs-team-score[^>]*>\s*(\d+)\s*</g;
      // Also try simpler selectors as fallback
      var teamRe2  = /wf-title-med[^>]*>\s*([^<]+?)\s*</g;
      var scoreRe2 = /match-score[^>]*>\s*(\d+)\s*</g;

      var teamNames = [], scores = [], m;
      while ((m = teamRe.exec(block))  !== null) teamNames.push(m[1].trim());
      while ((m = scoreRe.exec(block)) !== null) scores.push(parseInt(m[1]));
      if (!teamNames.length) {
        while ((m = teamRe2.exec(block))  !== null) teamNames.push(m[1].trim());
        while ((m = scoreRe2.exec(block)) !== null) scores.push(parseInt(m[1]));
      }
      if (teamNames.length < 2) continue;

      var k9xFirst = isK9X({ name: teamNames[0] });
      var aScore   = k9xFirst ? (scores[0] != null ? scores[0] : null) : (scores[1] != null ? scores[1] : null);
      var bScore   = k9xFirst ? (scores[1] != null ? scores[1] : null) : (scores[0] != null ? scores[0] : null);
      var opp      = k9xFirst ? teamNames[1] : teamNames[0];

      var status = completed ? 'result' : 'upcoming';
      var match = {
        id:     Math.random().toString(36).slice(2),
        event:  (evMatch && evMatch[1].trim()) || 'Valorant',
        stage:  (serMatch && serMatch[1].trim()) || '',
        date:   (dateMatch2 && dateMatch2[0]) || (dateMatch && dateMatch[0]) || '',
        status: status,
        teamA:  { name: 'K9X', score: aScore },
        teamB:  { name: opp, tag: tagFrom({ name: opp }), score: bScore },
        result: (completed && aScore != null && bScore != null) ? (aScore > bScore ? 'W' : 'L') : null,
        format: '',
        time:   'TBD',
      };

      if (completed || live) results.push(match);
      else upcoming.push(match);
    } catch (_) {}
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
  if (isNaN(d.getTime())) return String(v).slice(0, 14).toUpperCase();
  return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

function fmtTime(v) {
  if (!v) return 'TBD';
  var d = new Date(v);
  if (isNaN(d.getTime())) return 'TBD';
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' UTC';
}
