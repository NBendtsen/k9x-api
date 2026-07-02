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
      var raw = await r2.text();
      // vlr.gg returns HTML-entity-encoded content (Cloudflare); decode before parsing
      var html = raw
        .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
        .replace(/&quot;/g,'"').replace(/&#39;/g,"'");
      log.vlrgg.htmlLength = html.length;
      var matchIdx = html.indexOf('data-match-id=');
      log.vlrgg.matchFound = matchIdx > -1;
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
// vlr.gg structure (confirmed from live page samples):
//   data-match-id="N"  →  anchor for each result row
//   m-item-team-name   →  team names
//   m-item-result mod-win / mod-loss  →  outcome + scores in <span>N</span>
//   m-item-date        →  date as yyyy/mm/dd
function scrapeHtml(html) {
  var results  = [];
  var upcoming = [];
  var seen     = {};
  var MONTHS   = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

  var idRe = /data-match-id="(\d+)"/g;
  var m;
  while ((m = idRe.exec(html)) !== null) {
    var matchId = m[1];
    if (seen[matchId]) continue; // expandable sub-items also carry data-match-id
    seen[matchId] = true;

    var pos   = m.index;
    // block before pos holds event + team names; block after holds scores + date
    var pre   = html.slice(Math.max(0, pos - 2000), pos);
    var post  = html.slice(pos, pos + 600);

    try {
      // Win / loss / upcoming
      var isLoss     = /mod-loss/.test(post.slice(0, 200));
      var isWin      = /mod-win/.test(post.slice(0, 200));

      // Scores — appear as <span>N</span> right after the opening result div
      var scoreNums  = (post.match(/<span>(\d+)<\/span>/g) || [])
                        .map(function(s){ return parseInt(s.replace(/<\/?span>/g,'')); });
      var k9xScore   = scoreNums[0] != null ? scoreNums[0] : null;
      var oppScore   = scoreNums[1] != null ? scoreNums[1] : null;

      // K9X (home) is in pre; opponent is in extended post (up to 6000 chars after match-id)
      var extPost = html.slice(pos, pos + 6000);
      var tnRe = /m-item-team-name[^>]*>\s*([\s\S]+?)\s*<\/span>/g;
      var tn;
      var k9xFound = false;
      while ((tn = tnRe.exec(pre)) !== null) {
        if (isK9X({ name: tn[1].replace(/<[^>]+>/g,'').trim() })) { k9xFound = true; break; }
      }
      if (!k9xFound) continue;
      tnRe.lastIndex = 0;
      var opp = null;
      while ((tn = tnRe.exec(extPost)) !== null) {
        var n = tn[1].replace(/<[^>]+>/g,'').trim();
        if (n && !isK9X({ name: n })) { opp = n; break; }
      }
      if (!opp) continue;

      // Event name — font-weight:700 div near top of pre block
      var evM = pre.match(/font-weight:\s*700[^>]*>\s*([\s\S]*?)<\/div>/);
      var eventName = evM ? evM[1].replace(/<[^>]+>/g,'').trim() : 'Valorant';

      // Stage — Group Stage / Playoffs / SF / R1 …
      var stM = pre.match(/(Group Stage|Playoffs|Play.In|Swiss)[^<\n]*/i);
      var rnM = pre.match(/\b(R\d+|SF|QF|GF)\b/);
      var stage = (stM ? stM[0].replace(/&[a-z]+;/g,' ').trim() : '') +
                  (rnM ? ' · ' + rnM[0] : '');

      // Date yyyy/mm/dd in extended post block
      var dtM = extPost.match(/(\d{4})\/(\d{2})\/(\d{2})/);
      var date = dtM
        ? (parseInt(dtM[3]) + ' ' + MONTHS[parseInt(dtM[2])-1] + ' ' + dtM[1])
        : '';

      var status = (isWin || isLoss) ? 'result' : 'upcoming';
      var match  = {
        id:     matchId,
        event:  eventName,
        stage:  stage.trim(),
        date:   date,
        status: status,
        teamA:  { name:'K9X', score:k9xScore },
        teamB:  { name:opp, tag:tagFrom({ name:opp }), score:oppScore },
        result: isLoss ? 'L' : (isWin ? 'W' : null),
        format: '',
        time:   'TBD',
      };

      if (status === 'result') results.push(match);
      else upcoming.push(match);
    } catch(_) {}
  }

  return { results:results, upcoming:upcoming };
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
