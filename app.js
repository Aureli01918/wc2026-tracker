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

  // ---- Day-by-day browser: date range + grouping + status -------------

  var TOURNAMENT_START_KEY = '2026-06-11';
  var TOURNAMENT_END_KEY = '2026-07-19';

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  // Builds the full list of Melbourne-calendar-date keys spanning the
  // tournament, inclusive: ["2026-06-11", "2026-06-12", ..., "2026-07-19"].
  function buildTournamentDates() {
    var startParts = TOURNAMENT_START_KEY.split('-');
    var endParts = TOURNAMENT_END_KEY.split('-');
    var cursor = Date.UTC(parseInt(startParts[0], 10), parseInt(startParts[1], 10) - 1, parseInt(startParts[2], 10));
    var end = Date.UTC(parseInt(endParts[0], 10), parseInt(endParts[1], 10) - 1, parseInt(endParts[2], 10));
    var dates = [];
    while (cursor <= end) {
      var d = new Date(cursor);
      dates.push(d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()));
      cursor += 24 * 60 * 60 * 1000;
    }
    return dates;
  }

  // Clamps an arbitrary date key into the tournament's date range, snapping
  // to the nearest bound when it falls outside (e.g. "today" before/after
  // the tournament still lands on a valid, navigable day).
  function clampDateKey(key, dates) {
    if (!dates || !dates.length) return key;
    if (dates.indexOf(key) !== -1) return key;
    if (key < dates[0]) return dates[0];
    if (key > dates[dates.length - 1]) return dates[dates.length - 1];
    return dates[0];
  }

  // Groups matches by Melbourne-LOCAL calendar date: kickoff is converted to
  // Melbourne time first via melbourneDateKey(), then grouped -- never by the
  // feed's raw `date` field, which may reflect a different timezone/day.
  function groupMatchesByMelbourneDate(matches) {
    var map = {};
    matches.forEach(function (m) {
      var key = melbourneDateKey(m.kickoff);
      if (!map[key]) map[key] = [];
      map[key].push(m);
    });
    Object.keys(map).forEach(function (key) {
      map[key].sort(function (a, b) { return a.kickoff - b.kickoff; });
    });
    return map;
  }

  // Human-readable heading for a date key, e.g. "Thursday, 11 June 2026".
  function dateKeyToLabel(dateKey) {
    var parts = dateKey.split('-');
    // Noon UTC on the target date is still the same calendar day in
    // Melbourne (UTC+10/+11) regardless of DST, so this is safe.
    var d = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0));
    try {
      var fmt = new Intl.DateTimeFormat('en-AU', {
        timeZone: MELBOURNE_TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      });
      return fmt.format(d);
    } catch (e) {
      return dateKey;
    }
  }

  // Per-match status within the day browser: 'finished' | 'playing' | 'upcoming'.
  function dayMatchStatus(m) {
    if (hasFinalScore(m)) return 'finished';
    if (m.kickoff.getTime() <= Date.now()) return 'playing';
    return 'upcoming';
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

  // Picks the right row renderer for a single day's match based on its
  // status (finished / playing / upcoming) -- reuses the same row builders
  // as the existing Results/Playing-now/Today-Upcoming sections.
  function dayMatchRow(m) {
    var status = dayMatchStatus(m);
    if (status === 'finished') return resultRow(m);
    if (status === 'playing') return playingNowRow(m);
    return matchRow(m);
  }

    // ---- Day-by-day browser: navigator + quick-filter wiring ------------

  // Tracks the matches from the most recent fetch/refresh and the
  // currently-selected day, so prev/next/quick-filter navigation can
  // re-render instantly without re-fetching.
  var dayBrowserState = { matches: [], selectedKey: null };

  // Shifts a YYYY-MM-DD key by `delta` days using UTC arithmetic (the key
  // is just a calendar date, so this avoids any local-timezone/DST drift).
  function addDaysToKey(key, delta) {
    var parts = key.split('-');
    var d = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)));
    d.setUTCDate(d.getUTCDate() + delta);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  // Renders the day browser (heading, prev/next disabled state, match
  // list) for `dateKey` using `matches`. No-ops if the day-browser markup
  // isn't present on the page yet.
  function renderDayBrowser(dateKey, matches) {
    var dayLabel = document.getElementById('day-label');
    var dayList = document.getElementById('day-matches');
    var prevBtn = document.getElementById('day-prev-btn');
    var nextBtn = document.getElementById('day-next-btn');
    if (!dayLabel || !dayList) return;

    var dates = buildTournamentDates();
    var key = clampDateKey(dateKey, dates);
    dayBrowserState.selectedKey = key;

    dayLabel.textContent = dateKeyToLabel(key);

    var grouped = groupMatchesByMelbourneDate(matches);
    var dayMatches = grouped[key] || [];
    renderList(dayList, dayMatches, 'No matches — rest day.', dayMatchRow);

    if (prevBtn) prevBtn.disabled = (key === dates[0]);
    if (nextBtn) nextBtn.disabled = (key === dates[dates.length - 1]);
  }

  // Navigates the day browser to `dateKey` (clamped into the tournament
  // range) and re-renders from the last-fetched match list.
  function goToDate(dateKey) {
    renderDayBrowser(dateKey, dayBrowserState.matches);
  }

  function goToRelativeDay(delta) {
    var current = dayBrowserState.selectedKey || melbourneDateKey(new Date());
    goToDate(addDaysToKey(current, delta));
  }

  // Updates quick-filter button labels/enabled-state (e.g. live count).
  // No-ops for any button not present on the page yet.
  function updateQuickFilters(matches) {
    var b = bucketMatches(matches);

    var liveBtn = document.getElementById('quick-live-btn');
    if (liveBtn) {
      liveBtn.textContent = 'Live now (' + b.playingNow.length + ')';
      liveBtn.disabled = !b.playingNow.length;
    }

    var nextMatchBtn = document.getElementById('quick-next-btn');
    if (nextMatchBtn) {
      var upcomingAll = b.today.concat(b.upcoming);
      nextMatchBtn.disabled = !upcomingAll.length;
    }

    var latestBtn = document.getElementById('quick-latest-btn');
    if (latestBtn) {
      latestBtn.disabled = !b.results.length;
    }
  }

  // Wires the prev/next day-navigator buttons and the four quick-filter
  // buttons (Today / Live now / Next match / Latest result). Safe to call
  // before the markup exists -- each handler is only attached if its
  // element is found.
  function wireDayBrowser() {
    var prevBtn = document.getElementById('day-prev-btn');
    var nextBtn = document.getElementById('day-next-btn');
    var todayBtn = document.getElementById('quick-today-btn');
    var liveBtn = document.getElementById('quick-live-btn');
    var nextMatchBtn = document.getElementById('quick-next-btn');
    var latestBtn = document.getElementById('quick-latest-btn');

    if (prevBtn) prevBtn.addEventListener('click', function () { goToRelativeDay(-1); });
    if (nextBtn) nextBtn.addEventListener('click', function () { goToRelativeDay(1); });

    if (todayBtn) {
      todayBtn.addEventListener('click', function () {
        goToDate(melbourneDateKey(new Date()));
      });
    }
    if (liveBtn) {
      liveBtn.addEventListener('click', function () {
        var b = bucketMatches(dayBrowserState.matches);
        if (b.playingNow.length) goToDate(melbourneDateKey(b.playingNow[0].kickoff));
      });
    }
    if (nextMatchBtn) {
      nextMatchBtn.addEventListener('click', function () {
        var b = bucketMatches(dayBrowserState.matches);
        var upcomingAll = b.today.concat(b.upcoming).sort(function (a, c) { return a.kickoff - c.kickoff; });
        if (upcomingAll.length) goToDate(melbourneDateKey(upcomingAll[0].kickoff));
      });
    }
    if (latestBtn) {
      latestBtn.addEventListener('click', function () {
        var b = bucketMatches(dayBrowserState.matches);
        if (b.results.length) goToDate(melbourneDateKey(b.results[0].kickoff));
      });
    }
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
    var b = bucketMatches(result.matches);

    if (playingList) renderList(playingList, b.playingNow, 'No matches in progress.', playingNowRow);
    if (todayList) renderList(todayList, b.today, 'No matches today.');
    if (upcomingList) renderList(upcomingList, b.upcoming, 'No upcoming matches found.');
    if (resultsList) renderList(resultsList, b.results, 'No results yet.', resultRow);

    dayBrowserState.matches = result.matches;
    if (!dayBrowserState.selectedKey) {
      dayBrowserState.selectedKey = clampDateKey(melbourneDateKey(new Date()), buildTournamentDates());
    }
    renderDayBrowser(dayBrowserState.selectedKey, result.matches);
    updateQuickFilters(result.matches);

    if (status) {
      if (result.source === 'cache') {
        status.textContent = 'Showing cached schedule from ' + new Date(result.savedAt).toLocaleString() + ' (offline)';
      } else {
        status.textContent = 'Schedule updated · source: ' + result.source;
      }
    }
  }

  // ---- Push notifications -----------------------------------------------

  var VAPID_PUBLIC_KEY = 'BGot07xw1QMLSUPxGBI8wwGWBPAldwF7Irhr_j9oD8DmO75DcJBznuerMs1lcsFNIarIdhZUAQsCZgZPLTqLBHE';

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  function showSubscriptionJson(subscription) {
    var wrap = document.getElementById('subscription-display');
    var textarea = document.getElementById('subscription-json');
    if (!wrap || !textarea) return;
    textarea.value = JSON.stringify(subscription.toJSON(), null, 2);
    wrap.hidden = false;
  }

  function enableNotifications() {
    var status = document.getElementById('notify-status');
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      if (status) status.textContent = 'Push notifications are not supported in this browser.';
      return;
    }
    Notification.requestPermission().then(function (permission) {
      if (permission !== 'granted') {
        if (status) status.textContent = 'Notification permission was not granted.';
        return;
      }
      navigator.serviceWorker.ready.then(function (registration) {
        return registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
      }).then(function (subscription) {
        if (status) status.textContent = 'Notifications enabled. Copy the subscription below and send it to the site owner.';
        showSubscriptionJson(subscription);
      }).catch(function (err) {
        console.error('Could not subscribe for push:', err);
        if (status) status.textContent = 'Could not enable notifications: ' + err.message;
      });
    });
  }

  function wireNotifications() {
    var btn = document.getElementById('enable-notifications-btn');
    if (btn) btn.addEventListener('click', enableNotifications);
    var copyBtn = document.getElementById('copy-subscription-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var textarea = document.getElementById('subscription-json');
        if (!textarea) return;
        var status = document.getElementById('notify-status');
        var done = function () {
          if (status) status.textContent = 'Subscription JSON copied to clipboard.';
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(textarea.value).then(done).catch(function () {
            textarea.select();
            document.execCommand('copy');
            done();
          });
        } else {
          textarea.select();
          document.execCommand('copy');
          done();
        }
      });
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
    wireDayBrowser();
    wireNotifications();
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
  window.WC2026.buildTournamentDates = buildTournamentDates;
  window.WC2026.clampDateKey = clampDateKey;
  window.WC2026.groupMatchesByMelbourneDate = groupMatchesByMelbourneDate;
  window.WC2026.dateKeyToLabel = dateKeyToLabel;
  window.WC2026.dayMatchStatus = dayMatchStatus;
  window.WC2026.addDaysToKey = addDaysToKey;
  window.WC2026.renderDayBrowser = renderDayBrowser;
  window.WC2026.goToDate = goToDate;
  window.WC2026.goToRelativeDay = goToRelativeDay;
  window.WC2026.updateQuickFilters = updateQuickFilters;
  window.WC2026.wireDayBrowser = wireDayBrowser;
  window.WC2026.urlBase64ToUint8Array = urlBase64ToUint8Array;
  window.WC2026.enableNotifications = enableNotifications;
  window.WC2026.wireNotifications = wireNotifications;
})();
