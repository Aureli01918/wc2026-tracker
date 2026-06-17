(function () {
  'use strict';

  var PRIMARY_URL = 'https://raw.githubusercontent.com/upbound-web/worldcup-live.json/master/2026/worldcup.json';
  var FALLBACK_URL = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';
  var CACHE_KEY = 'wc2026-matches-cache-v1';
  var MELBOURNE_TZ = 'Australia/Melbourne';

  // ---- Parsing -------------------------------------------------------

  // Parses "13:00 UTC-6" into { hours, minutes, offset }.
  function parseTimeString(timeStr) {
    var m = /^(\d{1,2}):(\d{2})\s*UTC([+-]\d+(?:\.\d+)?)$/.exec((timeStr || '').trim());
    if (!m) return null;
    return {
      hours: parseInt(m[1], 10),
      minutes: parseInt(m[2], 10),
      offset: parseFloat(m[3])
    };
  }

  // Combines date "2026-06-11" + time "13:00 UTC-6" into a real UTC Date instant.
  function toKickoffDate(dateStr, timeStr) {
    var dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dateStr || '').trim());
    var time = parseTimeString(timeStr);
    if (!dateParts || !time) return null;
    var year = parseInt(dateParts[1], 10);
    var month = parseInt(dateParts[2], 10) - 1;
    var day = parseInt(dateParts[3], 10);
    // Local kickoff time at the venue is in a zone `offset` hours from UTC.
    // UTC = local - offset
    var utcHours = time.hours - time.offset;
    return new Date(Date.UTC(year, month, day, utcHours, time.minutes, 0));
  }

  function normalizeMatch(raw) {
    var kickoff = toKickoffDate(raw.date, raw.time);
    return {
      round: raw.round || '',
      group: raw.group || '',
      team1: raw.team1 || 'TBD',
      team2: raw.team2 || 'TBD',
      venue: raw.ground || raw.venue || 'TBD',
      kickoff: kickoff,
      score: raw.score || null,
      goals1: raw.goals1 || [],
      goals2: raw.goals2 || [],
      played: !!raw.score
    };
  }

  function parseSchedule(json) {
    if (!json || !Array.isArray(json.matches)) return [];
    return json.matches
      .map(normalizeMatch)
      .filter(function (m) { return m.kickoff instanceof Date && !isNaN(m.kickoff); });
  }

  // ---- Fetch + cache ---------------------------------------------------

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      return res.json();
    });
  }

  function saveCache(matches) {
    try {
      var payload = {
        savedAt: new Date().toISOString(),
        matches: matches.map(function (m) {
          return {
            round: m.round,
            group: m.group,
            team1: m.team1,
            team2: m.team2,
            venue: m.venue,
            kickoff: m.kickoff.toISOString(),
            score: m.score,
            goals1: m.goals1,
            goals2: m.goals2,
            played: m.played
          };
        })
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('Could not cache match data:', e);
    }
  }

  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var payload = JSON.parse(raw);
      var matches = (payload.matches || []).map(function (m) {
        return {
          round: m.round,
          group: m.group,
          team1: m.team1,
          team2: m.team2,
          venue: m.venue,
          kickoff: new Date(m.kickoff),
          score: m.score || null,
          goals1: m.goals1 || [],
          goals2: m.goals2 || [],
          played: m.played
        };
      });
      return { savedAt: payload.savedAt, matches: matches };
    } catch (e) {
      return null;
    }
  }

  // Tries the primary source, then the fallback source, then the local cache.
  // Resolves to { matches, source: 'primary'|'fallback'|'cache', savedAt? }.
  function fetchMatches() {
    return fetchJson(PRIMARY_URL)
      .then(function (json) {
        var matches = parseSchedule(json);
        if (!matches.length) throw new Error('Primary source returned no matches');
        saveCache(matches);
        return { matches: matches, source: 'primary' };
      })
      .catch(function (primaryErr) {
        console.warn('Primary schedule source failed:', primaryErr);
        return fetchJson(FALLBACK_URL)
          .then(function (json) {
            var matches = parseSchedule(json);
            if (!matches.length) throw new Error('Fallback source returned no matches');
            saveCache(matches);
            return { matches: matches, source: 'fallback' };
          })
          .catch(function (fallbackErr) {
            console.warn('Fallback schedule source failed:', fallbackErr);
            var cached = loadCache();
            if (cached && cached.matches.length) {
              return { matches: cached.matches, source: 'cache', savedAt: cached.savedAt };
            }
            throw new Error('No live or cached schedule data available');
          });
      });
  }

  // ---- Score / goal helpers --------------------------------------------

  function hasFinalScore(m) {
    return !!(m.score && m.score.ft);
  }

  function scorePairText(pair) {
    return pair[0] + '–' + pair[1];
  }

  // Layers ft, then et (if any), then p (if any): e.g. "1–1 · AET 2–1 · Pens 4–3".
  function scorelineText(score) {
    if (!score || !score.ft) return '';
    var parts = [scorePairText(score.ft)];
    if (score.et) parts.push('AET ' + scorePairText(score.et));
    if (score.p) parts.push('Pens ' + scorePairText(score.p));
    return parts.join(' · ');
  }

  function goalMinuteText(g) {
    var txt = String(g.minute);
    if (g.offset) txt += '+' + g.offset;
    return txt + "'";
  }

  function goalAnnotationText(g) {
    var tags = [];
    if (g.penalty) tags.push('pen.');
    if (g.owngoal) tags.push('OG');
    return tags.length ? ' (' + tags.join(', ') + ')' : '';
  }

  function goalLineText(g) {
    return g.name + ' ' + goalMinuteText(g) + goalAnnotationText(g);
  }

  function goalSortKey(g) {
    return g.minute + (g.offset || 0) / 100;
  }

  // ---- Rendering ------------------------------------------------------

  function formatKickoff(date) {
    try {
      var fmt = new Intl.DateTimeFormat('en-AU', {
        timeZone: MELBOURNE_TZ,
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
      return fmt.format(date) + ' (Melbourne)';
    } catch (e) {
      return date.toString();
    }
  }

  // Returns YYYY-MM-DD for the given instant, in Melbourne local time.
  function melbourneDateKey(date) {
    var fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: MELBOURNE_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return fmt.format(date);
  }

  // Splits matches into four buckets:
  //  - results:    has a final (ft) score, sorted most-recent kickoff first
  //  - playingNow: no final score yet, but kickoff has already passed (in progress)
  //  - today:      no score, kickoff still ahead, same Melbourne calendar day
  //  - upcoming:   no score, kickoff still ahead, a future Melbourne calendar day
  function bucketMatches(matches) {
    var now = Date.now();
    var todayKey = melbourneDateKey(new Date());
    var results = [];
    var playingNow = [];
    var today = [];
    var upcoming = [];

    matches.forEach(function (m) {
      if (hasFinalScore(m)) {
        results.push(m);
      } else if (m.kickoff.getTime() <= now) {
        playingNow.push(m);
      } else if (melbourneDateKey(m.kickoff) === todayKey) {
        today.push(m);
      } else {
        upcoming.push(m);
      }
    });

    results.sort(function (a, b) { return b.kickoff - a.kickoff; });
    playingNow.sort(function (a, b) { return a.kickoff - b.kickoff; });
    today.sort(function (a, b) { return a.kickoff - b.kickoff; });
    upcoming.sort(function (a, b) { return a.kickoff - b.kickoff; });

    return { results: results, playingNow: playingNow, today: today, upcoming: upcoming };
  }

  // Back-compat wrapper for the original two-way split.
  function splitTodayAndUpcoming(matches) {
    var b = bucketMatches(matches);
    return { today: b.today, upcoming: b.upcoming };
  }

  function flagSpan(name) {
    var span = document.createElement('span');
    span.className = 'flag';
    span.setAttribute('aria-hidden', 'true');
    if (window.WC2026Flags && typeof window.WC2026Flags.svgFor === 'function') {
      span.innerHTML = window.WC2026Flags.svgFor(name);
    }
    return span;
  }

  // A decorative flag + the team/country name, safe to drop into any row.
  function teamFragment(name) {
    var frag = document.createDocumentFragment();
    frag.appendChild(flagSpan(name));
    var text = document.createElement('span');
    text.className = 'team-name';
    text.textContent = name;
    frag.appendChild(text);
    return frag;
  }

  function scorersList(goals) {
    var ul = document.createElement('ul');
    ul.className = 'scorers-list';
    goals.slice().sort(function (a, b) { return goalSortKey(a) - goalSortKey(b); })
      .forEach(function (g) {
        var li = document.createElement('li');
        li.textContent = goalLineText(g);
        ul.appendChild(li);
      });
    return ul;
  }

  function matchRow(m) {
    var li = document.createElement('li');
    li.className = 'match-row';

    var time = document.createElement('span');
    time.className = 'match-time';
    time.textContent = formatKickoff(m.kickoff);

    var teams = document.createElement('span');
    teams.className = 'match-teams';
    teams.appendChild(teamFragment(m.team1));
    var vs = document.createElement('span');
    vs.className = 'vs-sep';
    vs.textContent = ' vs ';
    teams.appendChild(vs);
    teams.appendChild(teamFragment(m.team2));

    var meta = document.createElement('span');
    meta.className = 'match-meta';
    meta.textContent = [m.group, m.venue].filter(Boolean).join(' · ');

    li.appendChild(time);
    li.appendChild(teams);
    li.appendChild(meta);
    return li;
  }

  function playingNowRow(m) {
    var li = document.createElement('li');
    li.className = 'match-row playing-row';

    var badge = document.createElement('span');
    badge.className = 'live-badge';
    badge.textContent = 'In progress';
    li.appendChild(badge);

    var time = document.createElement('span');
    time.className = 'match-time';
    time.textContent = formatKickoff(m.kickoff);
    li.appendChild(time);

    var teams = document.createElement('span');
    teams.className = 'match-teams';
    teams.appendChild(teamFragment(m.team1));
    var vs = document.createElement('span');
    vs.className = 'vs-sep';
    vs.textContent = ' vs ';
    teams.appendChild(vs);
    teams.appendChild(teamFragment(m.team2));
    li.appendChild(teams);

    var note = document.createElement('span');
    note.className = 'match-note';
    note.textContent = 'Score will appear after full-time';
    li.appendChild(note);

    var meta = document.createElement('span');
    meta.className = 'match-meta';
    meta.textContent = [m.round, m.group, m.venue].filter(Boolean).join(' · ');
    li.appendChild(meta);

    return li;
  }

  function resultRow(m) {
    var li = document.createElement('li');
    li.className = 'match-row result-row';

    var time = document.createElement('span');
    time.className = 'match-time';
    time.textContent = formatKickoff(m.kickoff);
    li.appendChild(time);

    var scoreWrap = document.createElement('div');
    scoreWrap.className = 'match-score-wrap';

    var t1 = document.createElement('span');
    t1.className = 'team team1';
    t1.appendChild(teamFragment(m.team1));

    var score = document.createElement('span');
    score.className = 'scoreline';
    score.textContent = scorelineText(m.score);

    var t2 = document.createElement('span');
    t2.className = 'team team2';
    t2.appendChild(teamFragment(m.team2));

    scoreWrap.appendChild(t1);
    scoreWrap.appendChild(score);
    scoreWrap.appendChild(t2);
    li.appendChild(scoreWrap);

    var hasGoals1 = m.goals1 && m.goals1.length;
    var hasGoals2 = m.goals2 && m.goals2.length;
    if (hasGoals1 || hasGoals2) {
      var goalsWrap = document.createElement('div');
      goalsWrap.className = 'match-goals';

      var g1 = document.createElement('div');
      g1.className = 'team-goals';
      if (hasGoals1) g1.appendChild(scorersList(m.goals1));

      var g2 = document.createElement('div');
      g2.className = 'team-goals';
      if (hasGoals2) g2.appendChild(scorersList(m.goals2));

      goalsWrap.appendChild(g1);
      goalsWrap.appendChild(g2);
      li.appendChild(goalsWrap);
    }

    var meta = document.createElement('span');
    meta.className = 'match-meta';
    meta.textContent = [m.round, m.group, m.venue].filter(Boolean).join(' · ');
    li.appendChild(meta);

    return li;
  }

  function renderList(listEl, matches, emptyText, rowFn) {
    listEl.innerHTML = '';
    if (!matches.length) {
      var li = document.createElement('li');
      li.className = 'match-empty';
      li.textContent = emptyText;
      listEl.appendChild(li);
      return;
    }
    matches.forEach(function (m) {
      listEl.appendChild((rowFn || matchRow)(m));
    });
  }

  function renderSchedule(result) {
    var playingList = document.getElementById('playing-matches');
    var todayList = document.getElementById('today-matches');
    var upcomingList = document.getElementById('upcoming-matches');
    var resultsList = document.getElementById('results-matches');
    var status = document.getElementById('status');
    if (!todayList || !upcomingList) return;

    var b = bucketMatches(result.matches);

    if (playingList) renderList(playingList, b.playingNow, 'No matches in progress.', playingNowRow);
    renderList(todayList, b.today, 'No matches today.');
    renderList(upcomingList, b.upcoming, 'No upcoming matches found.');
    if (resultsList) renderList(resultsList, b.results, 'No results yet.', resultRow);

    if (status) {
      if (result.source === 'cache') {
        status.textContent = 'Showing cached schedule from ' + new Date(result.savedAt).toLocaleString() + ' (offline)';
      } else {
        status.textContent = 'Schedule updated · source: ' + result.source;
      }
    }
  }

  // ---- Init + manual refresh --------------------------------------------

  function init() {
    var status = document.getElementById('status');
    if (status) status.textContent = 'Loading schedule…';
    fetchMatches()
      .then(renderSchedule)
      .catch(function (err) {
        console.error('Could not load schedule:', err);
        if (status) status.textContent = 'Unable to load schedule. Check your connection.';
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    init();
    var refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        refreshBtn.disabled = true;
        var status = document.getElementById('status');
        if (status) status.textContent = 'Refreshing…';
        fetchMatches()
          .then(renderSchedule)
          .catch(function (err) {
            console.error('Refresh failed:', err);
            if (status) status.textContent = 'Refresh failed. Showing last known schedule.';
          })
          .then(function () {
            refreshBtn.disabled = false;
          });
      });
    }
  });

  window.WC2026 = window.WC2026 || {};
  window.WC2026.fetchMatches = fetchMatches;
  window.WC2026.renderSchedule = renderSchedule;
  window.WC2026.splitTodayAndUpcoming = splitTodayAndUpcoming;
  window.WC2026.bucketMatches = bucketMatches;
  window.WC2026.formatKickoff = formatKickoff;
  window.WC2026.scorelineText = scorelineText;
  window.WC2026.goalLineText = goalLineText;
  window.WC2026.MELBOURNE_TZ = MELBOURNE_TZ;
})();
