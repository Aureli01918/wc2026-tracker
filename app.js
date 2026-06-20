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

  // Short Melbourne local time only, e.g. "15:00" -- used in the collapsed
  // match-card's status line ("Kick-off HH:MM").
  function formatTimeShort(date) {
    try {
      var fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: MELBOURNE_TZ,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
      return fmt.format(date);
    } catch (e) {
      return '';
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

  // Formats an instant as a short Melbourne local time (e.g. "3:45 pm"),
  // used in the "Last updated …" status line.
  function formatUpdatedAt(date) {
    try {
      var fmt = new Intl.DateTimeFormat('en-AU', {
        timeZone: MELBOURNE_TZ,
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
      return fmt.format(date);
    } catch (e) {
      return date.toString();
    }
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

  // Returns the 3-letter abbreviation for a team name via flags.js, falling
  // back to the first 3 letters if flags.js hasn't loaded for some reason.
  function abbrText(name) {
    if (window.WC2026Flags && typeof window.WC2026Flags.abbrFor === 'function') {
      return window.WC2026Flags.abbrFor(name);
    }
    return (name || '').slice(0, 3).toUpperCase();
  }

  // Flag SVG span when a bundled flag exists for `name`; otherwise a small
  // text "chip" showing the abbreviation, so a missing flag never renders as
  // a broken image.
  function flagSpan(name) {
    var hasFlag = window.WC2026Flags && typeof window.WC2026Flags.hasFlag === 'function' && window.WC2026Flags.hasFlag(name);
    if (hasFlag) {
      var span = document.createElement('span');
      span.className = 'flag';
      span.setAttribute('aria-hidden', 'true');
      span.innerHTML = window.WC2026Flags.svgFor(name);
      return span;
    }
    var chip = document.createElement('span');
    chip.className = 'flag-chip';
    chip.setAttribute('aria-hidden', 'true');
    chip.textContent = abbrText(name);
    return chip;
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

  // ---- Match card (soft-depth tile) ------------------------------------

  // Which team (if any) won outright -- penalties decide first, then extra
  // time, then full time. Returns null for an undecided/drawn match.
  function decidedWinner(m) {
    if (!m.score || !m.score.ft) return null;
    if (m.score.p) {
      if (m.score.p[0] > m.score.p[1]) return m.team1;
      if (m.score.p[1] > m.score.p[0]) return m.team2;
      return null;
    }
    var g1 = m.score.et ? m.score.et[0] : m.score.ft[0];
    var g2 = m.score.et ? m.score.et[1] : m.score.ft[1];
    if (g1 > g2) return m.team1;
    if (g2 > g1) return m.team2;
    return null;
  }

  function buildTeamRow(name, isWinner) {
    var row = document.createElement('div');
    row.className = 'team-row';
    row.appendChild(flagSpan(name));

    var abbr = document.createElement('span');
    abbr.className = 'team-abbr';
    abbr.textContent = abbrText(name);
    row.appendChild(abbr);

    var nameSpan = document.createElement('span');
    nameSpan.className = 'team-name' + (isWinner ? ' winner' : '');
    nameSpan.textContent = name;
    row.appendChild(nameSpan);

    return row;
  }

  // Builds the collapsed card's top status line: "Full time" (+ AET/Pens
  // note), a pulsing gold "LIVE" pill with an approximate elapsed minute, or
  // "Kick-off HH:MM" for matches still ahead. There's no live-clock field in
  // the feed, so the live minute is estimated from elapsed time since kickoff
  // -- a display-only approximation, not a change to the data model.
  function statusLineContent(m) {
    var status = dayMatchStatus(m);

    if (status === 'finished') {
      var text = 'Full time';
      if (m.score && m.score.p) text += ' · Pens ' + scorePairText(m.score.p);
      else if (m.score && m.score.et) text += ' · AET';
      var span = document.createElement('span');
      span.className = 'status-text';
      span.textContent = text;
      return span;
    }

    if (status === 'playing') {
      var pill = document.createElement('span');
      pill.className = 'live-pill';
      var dot = document.createElement('span');
      dot.className = 'live-dot';
      pill.appendChild(dot);
      var minutes = Math.max(0, Math.floor((Date.now() - m.kickoff.getTime()) / 60000));
      var minuteText = minutes > 90 ? '90+' : String(minutes);
      pill.appendChild(document.createTextNode('LIVE ' + minuteText + "'"));
      return pill;
    }

    var upcoming = document.createElement('span');
    upcoming.className = 'status-text';
    upcoming.textContent = 'Kick-off ' + formatTimeShort(m.kickoff);
    return upcoming;
  }

  function buildChevron() {
    var chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9">' +
      '</polyline></svg>';
    return chevron;
  }

  function buildCardHeader(m) {
    var header = document.createElement('button');
    header.type = 'button';
    header.className = 'match-card-header';
    header.setAttribute('aria-expanded', 'false');

    var statusRow = document.createElement('div');
    statusRow.className = 'status-row';
    statusRow.appendChild(statusLineContent(m));
    statusRow.appendChild(buildChevron());
    header.appendChild(statusRow);

    var body = document.createElement('div');
    body.className = 'card-body';

    var teamsCol = document.createElement('div');
    teamsCol.className = 'teams-col';
    var winner = decidedWinner(m);
    teamsCol.appendChild(buildTeamRow(m.team1, winner === m.team1));
    teamsCol.appendChild(buildTeamRow(m.team2, winner === m.team2));
    body.appendChild(teamsCol);

    if (dayMatchStatus(m) === 'finished') {
      var scoreCol = document.createElement('div');
      scoreCol.className = 'score-col';
      var s1 = document.createElement('span');
      s1.className = 'score-value';
      s1.textContent = String(m.score.ft[0]);
      var s2 = document.createElement('span');
      s2.className = 'score-value';
      s2.textContent = String(m.score.ft[1]);
      scoreCol.appendChild(s1);
      scoreCol.appendChild(s2);
      body.appendChild(scoreCol);
    } else {
      var kickoffWrap = document.createElement('div');
      kickoffWrap.className = 'kickoff-col-wrap';
      var kt = document.createElement('span');
      kt.className = 'kickoff-time';
      kt.textContent = formatTimeShort(m.kickoff);
      kickoffWrap.appendChild(kt);
      body.appendChild(kickoffWrap);
    }

    header.appendChild(body);
    return header;
  }

  // Merged, minute-sorted goalscorer rows for the expansion: "Name · ABR"
  // with the minute in gold and penalty/own-goal annotations. Only shown for
  // finished/live matches. Rows carry a --row-index custom property so the
  // CSS stagger-in animation can offset each row by ~60ms.
  function buildScorersBlock(m) {
    var goals1 = (m.goals1 || []).map(function (g) { return { g: g, team: m.team1 }; });
    var goals2 = (m.goals2 || []).map(function (g) { return { g: g, team: m.team2 }; });
    var all = goals1.concat(goals2).sort(function (a, b) { return goalSortKey(a.g) - goalSortKey(b.g); });
    if (!all.length) return null;

    var block = document.createElement('div');
    block.className = 'scorers-block';
    var h = document.createElement('h4');
    h.textContent = 'Goalscorers';
    block.appendChild(h);

    all.forEach(function (entry, i) {
      var row = document.createElement('div');
      row.className = 'scorer-row';
      row.style.setProperty('--row-index', String(i));

      var name = document.createElement('span');
      name.className = 'scorer-name';
      name.textContent = entry.g.name + ' · ' + abbrText(entry.team) + goalAnnotationText(entry.g);

      var minute = document.createElement('span');
      minute.className = 'scorer-minute';
      minute.textContent = goalMinuteText(entry.g);

      row.appendChild(name);
      row.appendChild(minute);
      block.appendChild(row);
    });

    return block;
  }

  // Meta fact rows: Kick-off (Melbourne date + time), Venue, Stage (group +
  // round/matchday). Shown for every match, including upcoming ones.
  function buildMetaBlock(m) {
    var block = document.createElement('div');
    block.className = 'meta-block';
    var h = document.createElement('h4');
    h.textContent = 'Match info';
    block.appendChild(h);

    var dl = document.createElement('dl');

    function row(label, value) {
      if (!value) return;
      var wrap = document.createElement('div');
      wrap.className = 'meta-row';
      var dt = document.createElement('dt');
      dt.textContent = label;
      var dd = document.createElement('dd');
      dd.textContent = value;
      wrap.appendChild(dt);
      wrap.appendChild(dd);
      dl.appendChild(wrap);
    }

    row('Kick-off', formatKickoff(m.kickoff));
    row('Venue', m.venue);
    row('Stage', [m.group, m.round].filter(Boolean).join(' · '));

    block.appendChild(dl);
    return block;
  }

  function buildCardExpand(m, matches) {
    var wrap = document.createElement('div');
    wrap.className = 'match-card-expand';

    var inner = document.createElement('div');
    inner.className = 'match-card-expand-inner';

    var content = document.createElement('div');
    content.className = 'expand-content';

    var divider = document.createElement('div');
    divider.className = 'expand-divider';
    content.appendChild(divider);

    var status = dayMatchStatus(m);
    if (status === 'finished' || status === 'playing') {
      var scorers = buildScorersBlock(m);
      if (scorers) content.appendChild(scorers);
    }

    content.appendChild(buildMetaBlock(m));

    var groupTable = buildGroupTableBlock(matches, m);
    if (groupTable) content.appendChild(groupTable);

    inner.appendChild(content);
    wrap.appendChild(inner);
    return wrap;
  }

  // Single unified match-card builder (collapsed header + accordion
  // expansion) used for every match in the day browser, replacing the old
  // separate matchRow/playingNowRow/resultRow builders. The expansion is a
  // sibling of the header (not a descendant), so taps inside the expanded
  // content never bubble into the header's own click handler and collapse it.
  function matchCard(m, matches) {
    var li = document.createElement('li');
    li.className = 'match-card';

    var header = buildCardHeader(m);
    var expand = buildCardExpand(m, matches);

    header.addEventListener('click', function () {
      var isOpen = header.getAttribute('aria-expanded') === 'true';
      header.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
    });

    li.appendChild(header);
    li.appendChild(expand);
    return li;
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

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // Runs `applyFn` (the actual DOM update for a day change), animating it
  // directionally when `direction` is given and motion isn't disabled: via
  // the View Transitions API where supported, a CSS keyframe slide otherwise.
  function animateDayChange(dayList, direction, applyFn) {
    if (!direction || !dayList || prefersReducedMotion()) {
      applyFn();
      return;
    }

    var root = document.documentElement;
    if (typeof document.startViewTransition === 'function') {
      root.setAttribute('data-day-dir', direction);
      var transition = document.startViewTransition(applyFn);
      transition.finished.then(function () {
        root.removeAttribute('data-day-dir');
      }).catch(function () {
        root.removeAttribute('data-day-dir');
      });
      return;
    }

    var cls = direction === 'back' ? 'day-slide-in-back' : 'day-slide-in-fwd';
    dayList.classList.remove('day-slide-in-fwd', 'day-slide-in-back');
    applyFn();
    // Force a reflow so re-adding the same class reliably restarts the animation.
    void dayList.offsetWidth;
    dayList.classList.add(cls);
    dayList.addEventListener('animationend', function handler() {
      dayList.classList.remove(cls);
      dayList.removeEventListener('animationend', handler);
    });
  }

  // Renders the day browser (heading, prev/next disabled state, match list,
  // active-tab underline) for `dateKey` using `matches`. `direction`
  // ('forward' | 'back' | falsy) drives the optional slide-in animation.
  // No-ops if the day-browser markup isn't present on the page yet.
  function renderDayBrowser(dateKey, matches, direction) {
    var dayLabel = document.getElementById('day-label');
    var dayList = document.getElementById('day-matches');
    var prevBtn = document.getElementById('day-prev-btn');
    var nextBtn = document.getElementById('day-next-btn');
    if (!dayLabel || !dayList) return;

    var dates = buildTournamentDates();
    var key = clampDateKey(dateKey, dates);

    function applyContent() {
      dayBrowserState.selectedKey = key;
      dayLabel.textContent = dateKeyToLabel(key);

      var grouped = groupMatchesByMelbourneDate(matches);
      var dayMatches = grouped[key] || [];
      renderList(dayList, dayMatches, 'No matches — rest day.', function (m) { return matchCard(m, matches); });
      // Only reveal the real list once content has actually been rendered
      // into it -- the skeleton/list visibility are otherwise independent.
      dayList.hidden = false;

      if (prevBtn) prevBtn.disabled = (key === dates[0]);
      if (nextBtn) nextBtn.disabled = (key === dates[dates.length - 1]);

      updateActiveTabUI(matches, key);
    }

    animateDayChange(dayList, direction, applyContent);
  }

  // Navigates the day browser to `dateKey` (clamped into the tournament
  // range) and re-renders from the last-fetched match list. If `direction`
  // isn't given explicitly, it's inferred from whether the target date is
  // later/earlier than the currently-selected one (YYYY-MM-DD strings sort
  // chronologically), so jumping via a quick-filter button still slides the
  // right way.
  function goToDate(dateKey, direction) {
    if (direction === undefined) {
      var current = dayBrowserState.selectedKey;
      if (current && dateKey > current) direction = 'forward';
      else if (current && dateKey < current) direction = 'back';
      else direction = null;
    }
    renderDayBrowser(dateKey, dayBrowserState.matches, direction);
  }

  function goToRelativeDay(delta) {
    var current = dayBrowserState.selectedKey || melbourneDateKey(new Date());
    goToDate(addDaysToKey(current, delta), delta > 0 ? 'forward' : 'back');
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

  // Marks whichever quick-filter button corresponds to the currently
  // selected day as the active tab, and slides the gold underline beneath
  // it. The underline hides itself when the selected day doesn't match any
  // of the four quick filters (e.g. after manual prev/next navigation).
  function updateActiveTabUI(matches, selectedKey) {
    var bar = document.getElementById('quick-filters');
    var underline = document.getElementById('tab-underline');
    if (!bar || !underline) return;

    var b = bucketMatches(matches);
    var todayKey = melbourneDateKey(new Date());
    var liveKey = b.playingNow.length ? melbourneDateKey(b.playingNow[0].kickoff) : null;
    var upcomingAll = b.today.concat(b.upcoming).sort(function (a, c) { return a.kickoff - c.kickoff; });
    var nextKey = upcomingAll.length ? melbourneDateKey(upcomingAll[0].kickoff) : null;
    var latestKey = b.results.length ? melbourneDateKey(b.results[0].kickoff) : null;

    var activeId = null;
    if (liveKey && selectedKey === liveKey) activeId = 'quick-live-btn';
    else if (selectedKey === todayKey) activeId = 'quick-today-btn';
    else if (nextKey && selectedKey === nextKey) activeId = 'quick-next-btn';
    else if (latestKey && selectedKey === latestKey) activeId = 'quick-latest-btn';

    var buttons = bar.querySelectorAll('.tab-btn');
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.classList.toggle('is-active', btn.id === activeId);
    });

    if (!activeId) {
      underline.classList.remove('is-visible');
      return;
    }
    var activeBtn = document.getElementById(activeId);
    if (!activeBtn) {
      underline.classList.remove('is-visible');
      return;
    }
    underline.style.left = activeBtn.offsetLeft + 'px';
    underline.style.width = activeBtn.offsetWidth + 'px';
    underline.classList.add('is-visible');
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

    window.addEventListener('resize', function () {
      updateActiveTabUI(dayBrowserState.matches, dayBrowserState.selectedKey);
    });
  }

  // ---- Group standings -------------------------------------------------

  // Returns the sorted list of group labels present in `matches`, e.g.
  // ["Group A", "Group B", ...]. Matches without a `group` (knockout
  // rounds) are ignored.
  function groupLabels(matches) {
    var seen = {};
    var labels = [];
    matches.forEach(function (m) {
      if (m.group && !seen[m.group]) {
        seen[m.group] = true;
        labels.push(m.group);
      }
    });
    return labels.sort();
  }

  function emptyStanding(team) {
    return { team: team, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, pts: 0 };
  }

  // Builds the standings table for a single group: every team that has
  // appeared in a group-stage match for `groupLabel` gets a row (even
  // before it has played), sorted by points, then goal difference, then
  // goals scored, then name -- the standard table tie-break order minus
  // head-to-head/disciplinary points, which the feed doesn't expose.
  //
  // NOTE: this function and its sort order are intentionally left untouched
  // by the soft-depth redesign -- the main Standings section keeps exactly
  // this behavior. The per-match-card group mini-table uses a separate
  // head-to-head-aware comparator (see compareWithHeadToHead /
  // computeGroupStandingsForCard below), which only re-sorts a copy of these
  // same rows and never feeds back into this function.
  function computeGroupStandings(matches, groupLabel) {
    var groupMatches = matches.filter(function (m) { return m.group === groupLabel; });
    var table = {};
    var order = [];

    function ensure(team) {
      if (!table[team]) {
        table[team] = emptyStanding(team);
        order.push(team);
      }
      return table[team];
    }

    groupMatches.forEach(function (m) {
      ensure(m.team1);
      ensure(m.team2);
    });

    groupMatches.forEach(function (m) {
      if (!hasFinalScore(m)) return;
      var a = table[m.team1];
      var b = table[m.team2];
      var ga = m.score.ft[0];
      var gb = m.score.ft[1];

      a.played++;
      b.played++;
      a.gf += ga;
      a.ga += gb;
      b.gf += gb;
      b.ga += ga;

      if (ga > gb) {
        a.won++;
        a.pts += 3;
        b.lost++;
      } else if (ga < gb) {
        b.won++;
        b.pts += 3;
        a.lost++;
      } else {
        a.drawn++;
        a.pts += 1;
        b.drawn++;
        b.pts += 1;
      }
    });

    var rows = order.map(function (team) {
      var row = table[team];
      row.gd = row.gf - row.ga;
      return row;
    });

    rows.sort(function (x, y) {
      if (y.pts !== x.pts) return y.pts - x.pts;
      if (y.gd !== x.gd) return y.gd - x.gd;
      if (y.gf !== x.gf) return y.gf - x.gf;
      return x.team.localeCompare(y.team);
    });

    return rows;
  }

  // ---- Group mini-table tiebreak (per match-card only) -----------------
  //
  // Points teamA earned vs teamB across their head-to-head group meeting(s)
  // in `matches`, or null if they haven't played each other yet.
  function headToHeadPoints(matches, teamA, teamB) {
    var games = matches.filter(function (m) {
      return m.group && hasFinalScore(m) &&
        ((m.team1 === teamA && m.team2 === teamB) || (m.team1 === teamB && m.team2 === teamA));
    });
    if (!games.length) return null;

    var aPts = 0;
    var bPts = 0;
    games.forEach(function (m) {
      var ga = m.team1 === teamA ? m.score.ft[0] : m.score.ft[1];
      var gb = m.team1 === teamA ? m.score.ft[1] : m.score.ft[0];
      if (ga > gb) aPts += 3;
      else if (ga < gb) bPts += 3;
      else { aPts += 1; bPts += 1; }
    });
    return { aPts: aPts, bPts: bPts };
  }

  // Modular comparator factory: points -> goal difference -> goals scored ->
  // head-to-head result -> name. Used ONLY by the per-card group mini-table
  // (via computeGroupStandingsForCard, below) -- computeGroupStandings and
  // its sort order above are never modified or replaced by this.
  function compareWithHeadToHead(matches) {
    return function (x, y) {
      if (y.pts !== x.pts) return y.pts - x.pts;
      if (y.gd !== x.gd) return y.gd - x.gd;
      if (y.gf !== x.gf) return y.gf - x.gf;
      var h2h = headToHeadPoints(matches, x.team, y.team);
      if (h2h && h2h.aPts !== h2h.bPts) return h2h.bPts - h2h.aPts;
      return x.team.localeCompare(y.team);
    };
  }

  // Row data is identical to computeGroupStandings (same stats per team);
  // only the final ordering differs, via the head-to-head-aware comparator.
  function computeGroupStandingsForCard(matches, groupLabel) {
    var rows = computeGroupStandings(matches, groupLabel);
    return rows.slice().sort(compareWithHeadToHead(matches));
  }

  // Group mini-table for a single match's expansion: pos / flag+abbr+name /
  // P / GD / Pts, with the two teams in this match highlighted and a gold
  // inset-left bar on the top-2 (qualifying) rows. Returns null for matches
  // with no group (knockout rounds).
  function buildGroupTableBlock(matches, m) {
    if (!m.group) return null;
    var rows = computeGroupStandingsForCard(matches, m.group);
    if (!rows.length) return null;

    var block = document.createElement('div');
    block.className = 'group-table-block';
    var h = document.createElement('h4');
    h.textContent = m.group;
    block.appendChild(h);

    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    [
      { label: '#', cls: '' },
      { label: '', cls: '' },
      { label: 'Team', cls: 'gt-team-head' },
      { label: 'P', cls: '' },
      { label: 'GD', cls: '' },
      { label: 'Pts', cls: '' }
    ].forEach(function (col) {
      var th = document.createElement('th');
      if (col.cls) th.className = col.cls;
      th.textContent = col.label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    rows.forEach(function (row, index) {
      var tr = document.createElement('tr');
      var isMatchTeam = row.team === m.team1 || row.team === m.team2;
      var classes = [];
      if (isMatchTeam) classes.push('gt-highlight');
      if (index < 2) classes.push('gt-qualify');
      if (classes.length) tr.className = classes.join(' ');

      var pos = document.createElement('td');
      pos.textContent = String(index + 1);
      tr.appendChild(pos);

      var flagTd = document.createElement('td');
      flagTd.appendChild(flagSpan(row.team));
      tr.appendChild(flagTd);

      var teamTd = document.createElement('td');
      teamTd.className = 'gt-team';
      var abbr = document.createElement('span');
      abbr.className = 'team-abbr';
      abbr.textContent = abbrText(row.team);
      var name = document.createElement('span');
      name.className = 'gt-name';
      name.textContent = row.team;
      teamTd.appendChild(abbr);
      teamTd.appendChild(name);
      tr.appendChild(teamTd);

      var pCell = document.createElement('td');
      pCell.textContent = String(row.played);
      tr.appendChild(pCell);

      var gdCell = document.createElement('td');
      gdCell.textContent = row.gd > 0 ? '+' + row.gd : String(row.gd);
      tr.appendChild(gdCell);

      var ptsCell = document.createElement('td');
      ptsCell.textContent = String(row.pts);
      tr.appendChild(ptsCell);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    block.appendChild(table);
    return block;
  }

  // Tracks the matches from the most recent fetch/refresh and the
  // currently-selected group, so switching groups can re-render instantly
  // without re-fetching.
  var standingsState = { matches: [], selectedGroup: null };

  // Fills the group <select> with one option per group found in `matches`,
  // preserving the current selection where possible. No-ops if the
  // standings markup isn't present on the page yet.
  function populateStandingsGroupSelect(matches) {
    var select = document.getElementById('standings-group-select');
    if (!select) return null;

    var labels = groupLabels(matches);
    var existing = Array.prototype.map.call(select.options, function (opt) { return opt.value; });
    var sameOptions = existing.length === labels.length && existing.every(function (v, i) { return v === labels[i]; });

    if (!sameOptions) {
      select.innerHTML = '';
      labels.forEach(function (label) {
        var opt = document.createElement('option');
        opt.value = label;
        opt.textContent = label;
        select.appendChild(opt);
      });
    }

    if (!standingsState.selectedGroup || labels.indexOf(standingsState.selectedGroup) === -1) {
      standingsState.selectedGroup = labels[0] || null;
    }
    select.value = standingsState.selectedGroup || '';
    return labels;
  }

  // Renders the standings table body for `groupLabel`. Highlights the top
  // two rows (the qualifying spots) with the `standings-qualify` class.
  function renderStandingsTable(matches, groupLabel) {
    var body = document.getElementById('standings-body');
    if (!body) return;

    body.innerHTML = '';
    if (!groupLabel) return;

    var rows = computeGroupStandings(matches, groupLabel);
    rows.forEach(function (row, index) {
      var tr = document.createElement('tr');
      tr.className = 'standings-row' + (index < 2 ? ' standings-qualify' : '');

      var pos = document.createElement('td');
      pos.className = 'standings-pos';
      pos.textContent = String(index + 1);
      tr.appendChild(pos);

      var team = document.createElement('td');
      team.className = 'standings-team';
      team.appendChild(teamFragment(row.team));
      tr.appendChild(team);

      function numCell(value, extraClass) {
        var td = document.createElement('td');
        td.className = 'standings-num' + (extraClass ? ' ' + extraClass : '');
        td.textContent = String(value);
        return td;
      }

      tr.appendChild(numCell(row.played));
      tr.appendChild(numCell(row.won));
      tr.appendChild(numCell(row.drawn));
      tr.appendChild(numCell(row.lost));
      tr.appendChild(numCell(row.gd > 0 ? '+' + row.gd : row.gd));
      tr.appendChild(numCell(row.pts, 'standings-pts'));

      body.appendChild(tr);
    });
  }

  // Single entry point called from renderSchedule(): refreshes the group
  // selector (if the set of groups changed) and re-renders the currently
  // selected group's table from the latest matches.
  function renderStandings(matches) {
    var section = document.getElementById('standings-section');
    if (!section) return;
    standingsState.matches = matches;
    populateStandingsGroupSelect(matches);
    renderStandingsTable(matches, standingsState.selectedGroup);
  }

  // Wires the group <select> so switching groups re-renders instantly
  // from the last-fetched matches. Safe to call before the markup exists.
  function wireStandings() {
    var select = document.getElementById('standings-group-select');
    if (!select) return;
    select.addEventListener('change', function () {
      standingsState.selectedGroup = select.value;
      renderStandingsTable(standingsState.matches, standingsState.selectedGroup);
    });
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
      listEl.appendChild(rowFn(m));
    });
  }

  // ---- Loading / error / offline UI helpers ------------------------------

  // Toggles the loading-skeleton placeholder shown while the first fetch of
  // a page load is in flight. Independent of the real list's visibility.
  function showSkeleton() {
    var skeleton = document.getElementById('day-skeleton');
    if (skeleton) skeleton.hidden = false;
  }

  function hideSkeleton() {
    var skeleton = document.getElementById('day-skeleton');
    if (skeleton) skeleton.hidden = true;
  }

  // Friendly error + retry block, shown only when there's truly nothing to
  // display (every source -- primary, fallback, and cache -- failed).
  function showFeedError(message) {
    var errorBox = document.getElementById('feed-error');
    var errorText = document.getElementById('feed-error-text');
    if (errorText) errorText.textContent = message;
    if (errorBox) errorBox.hidden = false;
  }

  function hideFeedError() {
    var errorBox = document.getElementById('feed-error');
    if (errorBox) errorBox.hidden = true;
  }

  // Reads a "?date=YYYY-MM-DD" query param so a notification click (or any
  // other deep link) can open the day browser straight to a match's day.
  function parseDeepLinkDate() {
    try {
      var params = new URLSearchParams(window.location.search);
      var date = params.get('date');
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    } catch (e) {
      // URLSearchParams unsupported or a malformed query string -- ignore.
    }
    return null;
  }

  // Renders the "Last updated …" line and the offline banner based on
  // where the just-loaded data came from.
  function updateStatusLine(result) {
    var status = document.getElementById('status');
    var offlineBanner = document.getElementById('offline-banner');

    if (status) {
      if (result.source === 'cache') {
        var savedAt = result.savedAt ? new Date(result.savedAt) : null;
        status.textContent = savedAt
          ? 'Last updated ' + formatUpdatedAt(savedAt) + ' Melbourne'
          : 'Last updated unknown';
      } else {
        status.textContent = 'Last updated ' + formatUpdatedAt(new Date()) + ' Melbourne';
      }
    }

    if (offlineBanner) {
      if (result.source === 'cache') {
        offlineBanner.textContent = 'Offline — showing cached data';
        offlineBanner.hidden = false;
      } else {
        offlineBanner.hidden = true;
      }
    }
  }

  function renderSchedule(result) {
    dayBrowserState.matches = result.matches;
    if (!dayBrowserState.selectedKey) {
      dayBrowserState.selectedKey = clampDateKey(melbourneDateKey(new Date()), buildTournamentDates());
    }
    renderDayBrowser(dayBrowserState.selectedKey, result.matches);
    updateQuickFilters(result.matches);
    renderStandings(result.matches);

    updateStatusLine(result);
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

  // ---- Load orchestration: skeleton, errors, deep-link, auto-refresh ----

  var isLoading = false;
  var lastLoadAt = 0;
  var MIN_AUTO_REFRESH_INTERVAL_MS = 30 * 1000;
  var deepLinkApplied = false;

  // Single entry point for both the first load and every subsequent
  // refresh (manual button, retry button, or focus/visibility auto-refresh).
  // Handles the loading skeleton, status text, the error+retry state, and
  // applying the day-browser deep link on the first successful load.
  function loadSchedule(options) {
    var opts = options || {};
    var isFirstLoad = !!opts.isFirstLoad;
    var refreshBtn = document.getElementById('refresh-btn');
    var status = document.getElementById('status');

    if (isLoading) return;
    isLoading = true;

    hideFeedError();
    if (isFirstLoad) {
      showSkeleton();
    } else {
      if (status) status.textContent = 'Refreshing…';
      if (refreshBtn) refreshBtn.disabled = true;
    }

    fetchMatches()
      .then(function (result) {
        renderSchedule(result);

        if (!deepLinkApplied) {
          deepLinkApplied = true;
          var deepLinkDate = parseDeepLinkDate();
          if (deepLinkDate) goToDate(deepLinkDate);
        }
      })
      .catch(function (err) {
        console.error('Could not load schedule:', err);
        showFeedError('Unable to load the match schedule. Check your connection and try again.');
        if (isFirstLoad && status) status.textContent = 'Unable to load schedule.';
      })
      .catch(function (cleanupErr) {
        // Guards against any unexpected exception inside the error-handling
        // path above (e.g. a render/DOM issue) so the skeleton/loading state
        // can never get stuck open even when something goes wrong.
        console.error('Unexpected error while handling a failed schedule load:', cleanupErr);
      })
      .then(function () {
        isLoading = false;
        lastLoadAt = Date.now();
        hideSkeleton();
        if (refreshBtn) refreshBtn.disabled = false;
      });
  }

  // Re-loads the feed if it's been at least MIN_AUTO_REFRESH_INTERVAL_MS
  // since the last load -- called when the app regains focus/visibility so
  // reopening the installed PWA pulls fresh data without hammering the feed.
  function refreshIfStale() {
    if (isLoading) return;
    if (Date.now() - lastLoadAt < MIN_AUTO_REFRESH_INTERVAL_MS) return;
    loadSchedule({ isFirstLoad: false });
  }

  // Wires focus + visibility events so reopening the installed app (or
  // switching back to its tab) refreshes the feed automatically.
  function wireVisibilityRefresh() {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') refreshIfStale();
    });
    window.addEventListener('focus', refreshIfStale);
  }

  document.addEventListener('DOMContentLoaded', function () {
    loadSchedule({ isFirstLoad: true });
    wireDayBrowser();
    wireStandings();
    wireNotifications();
    wireVisibilityRefresh();

    var refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        loadSchedule({ isFirstLoad: false });
      });
    }

    var retryBtn = document.getElementById('retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', function () {
        loadSchedule({ isFirstLoad: true });
      });
    }
  });

  window.WC2026 = window.WC2026 || {};
  window.WC2026.fetchMatches = fetchMatches;
  window.WC2026.renderSchedule = renderSchedule;
  window.WC2026.splitTodayAndUpcoming = splitTodayAndUpcoming;
  window.WC2026.bucketMatches = bucketMatches;
  window.WC2026.formatKickoff = formatKickoff;
  window.WC2026.formatUpdatedAt = formatUpdatedAt;
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
  window.WC2026.updateActiveTabUI = updateActiveTabUI;
  window.WC2026.wireDayBrowser = wireDayBrowser;
  window.WC2026.groupLabels = groupLabels;
  window.WC2026.computeGroupStandings = computeGroupStandings;
  window.WC2026.headToHeadPoints = headToHeadPoints;
  window.WC2026.compareWithHeadToHead = compareWithHeadToHead;
  window.WC2026.computeGroupStandingsForCard = computeGroupStandingsForCard;
  window.WC2026.matchCard = matchCard;
  window.WC2026.decidedWinner = decidedWinner;
  window.WC2026.renderStandings = renderStandings;
  window.WC2026.wireStandings = wireStandings;
  window.WC2026.urlBase64ToUint8Array = urlBase64ToUint8Array;
  window.WC2026.enableNotifications = enableNotifications;
  window.WC2026.wireNotifications = wireNotifications;
  window.WC2026.parseDeepLinkDate = parseDeepLinkDate;
  window.WC2026.updateStatusLine = updateStatusLine;
  window.WC2026.showSkeleton = showSkeleton;
  window.WC2026.hideSkeleton = hideSkeleton;
  window.WC2026.showFeedError = showFeedError;
  window.WC2026.hideFeedError = hideFeedError;
  window.WC2026.loadSchedule = loadSchedule;
  window.WC2026.refreshIfStale = refreshIfStale;
})();
