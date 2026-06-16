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

  function splitTodayAndUpcoming(matches) {
    var todayKey = melbourneDateKey(new Date());
    var sorted = matches.slice().sort(function (a, b) {
      return a.kickoff - b.kickoff;
    });
    var today = [];
    var upcoming = [];
    sorted.forEach(function (m) {
      if (melbourneDateKey(m.kickoff) === todayKey) {
        today.push(m);
      } else if (m.kickoff.getTime() >= Date.now()) {
        upcoming.push(m);
      }
    });
    return { today: today, upcoming: upcoming };
  }

  function matchRow(m) {
    var li = document.createElement('li');
    li.className = 'match-row';

    var time = document.createElement('span');
    time.className = 'match-time';
    time.textContent = formatKickoff(m.kickoff);

    var teams = document.createElement('span');
    teams.className = 'match-teams';
    teams.textContent = m.team1 + ' vs ' + m.team2;

    var meta = document.createElement('span');
    meta.className = 'match-meta';
    meta.textContent = [m.group, m.venue].filter(Boolean).join(' \u00B7 ');

    li.appendChild(time);
    li.appendChild(teams);
    li.appendChild(meta);
    return li;
  }

  function renderList(listEl, matches, emptyText) {
    listEl.innerHTML = '';
    if (!matches.length) {
      var li = document.createElement('li');
      li.className = 'match-empty';
      li.textContent = emptyText;
      listEl.appendChild(li);
      return;
    }
    matches.forEach(function (m) {
      listEl.appendChild(matchRow(m));
    });
  }

  function renderSchedule(result) {
    var todayList = document.getElementById('today-matches');
    var upcomingList = document.getElementById('upcoming-matches');
    var status = document.getElementById('status');
    if (!todayList || !upcomingList) return;

    var split = splitTodayAndUpcoming(result.matches);
    renderList(todayList, split.today, 'No matches today.');
    renderList(upcomingList, split.upcoming, 'No upcoming matches found.');

    if (status) {
      if (result.source === 'cache') {
        status.textContent = 'Showing cached schedule from ' + new Date(result.savedAt).toLocaleString() + ' (offline)';
      } else {
        status.textContent = 'Schedule updated \u00B7 source: ' + result.source;
      }
    }
  }

  window.WC2026 = window.WC2026 || {};
  window.WC2026.fetchMatches = fetchMatches;
  window.WC2026.renderSchedule = renderSchedule;
  window.WC2026.splitTodayAndUpcoming = splitTodayAndUpcoming;
  window.WC2026.formatKickoff = formatKickoff;
  window.WC2026.MELBOURNE_TZ = MELBOURNE_TZ;
})();
