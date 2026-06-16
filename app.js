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

  window.WC2026 = window.WC2026 || {};
  window.WC2026.fetchMatches = fetchMatches;
  window.WC2026.MELBOURNE_TZ = MELBOURNE_TZ;
})();
