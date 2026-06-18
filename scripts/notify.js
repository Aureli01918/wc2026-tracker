const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const PRIMARY_URL = 'https://raw.githubusercontent.com/upbound-web/worldcup-live.json/master/2026/worldcup.json';
const FALLBACK_URL = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';
const STATE_PATH = path.join(__dirname, '..', 'state.json');
const MELBOURNE_TZ = 'Australia/Melbourne';

// ---- Formatting helpers (mirrors app.js) -------------------------------

function scorePairText(pair) {
    return pair[0] + '–' + pair[1];
}

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

function goalsBody(m) {
    var goals = (m.goals1 || []).concat(m.goals2 || []);
    if (!goals.length) return 'Full time.';
    return goals
      .slice()
      .sort(function (a, b) { return goalSortKey(a) - goalSortKey(b); })
      .map(goalLineText)
      .join(', ');
}

// The feed has no stable id, so build one from date + team names.
function matchId(m) {
    return [m.date, m.team1, m.team2].join('|');
}

// ---- Date helpers (mirrors app.js) -------------------------------------

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

// Melbourne-local calendar-date key for a match, used to deep-link push
// notifications to the right day in the day browser. Falls back to the
// feed's raw date string if kickoff parsing fails for some reason.
function matchDateKey(m) {
    var kickoff = toKickoffDate(m.date, m.time);
    if (kickoff instanceof Date && !isNaN(kickoff)) return melbourneDateKey(kickoff);
    return (m.date || '').trim();
}

// ---- Feed fetch ----------------------------------------------------------

async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.json();
}

async function fetchFeed() {
    try {
          const json = await fetchJson(PRIMARY_URL);
          if (json && Array.isArray(json.matches) && json.matches.length) return json;
          throw new Error('Primary feed had no matches');
    } catch (err) {
          console.warn('Primary feed failed, trying fallback:', err.message);
          return fetchJson(FALLBACK_URL);
    }
}

// ---- State -----------------------------------------------------------

function loadState() {
    try {
          const raw = fs.readFileSync(STATE_PATH, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && parsed.notified) return parsed;
    } catch (err) {
          // file missing or invalid -- start fresh
    }
    return { notified: {} };
}

function saveState(state) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

// ---- Subscriptions -----------------------------------------------------

function loadSubscriptions() {
    const raw = process.env.PUSH_SUBSCRIPTIONS;
    if (!raw) return [];
    try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed;
          console.warn('PUSH_SUBSCRIPTIONS is not a JSON array; ignoring.');
    } catch (err) {
          console.warn('Could not parse PUSH_SUBSCRIPTIONS as JSON:', err.message);
    }
    return [];
}

async function sendToAll(subscriptions, payload) {
    const body = JSON.stringify(payload);
    await Promise.all(
          subscriptions.map(async (sub) => {
                  try {
                            await webpush.sendNotification(sub, body);
                  } catch (err) {
                            const statusCode = err && err.statusCode;
                            if (statusCode === 404 || statusCode === 410) {
                                        console.warn('Subscription expired/gone (status ' + statusCode + '); skipping.');
                            } else {
                                        console.warn('Push send failed:', err && err.message ? err.message : err);
                            }
                  }
          })
        );
}

// ---- Main ----------------------------------------------------------------

async function main() {
    const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
    const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
    const VAPID_SUBJECT = process.env.VAPID_SUBJECT;

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
        console.warn('VAPID secrets are not fully configured; skipping this run.');
        return;
  }
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const subscriptions = loadSubscriptions();
    if (!subscriptions.length) {
          console.log('No push subscriptions configured; will still update state.');
    }

  const feed = await fetchFeed();
    const matches = Array.isArray(feed.matches) ? feed.matches : [];
    const state = loadState();

  const newlyFinished = matches.filter(function (m) {
        if (!m || !m.score || !m.score.ft) return false;
        const id = matchId(m);
        return !state.notified[id];
  });

  if (!newlyFinished.length) {
        console.log('No newly finished matches this run.');
    return;
  }

  for (const m of newlyFinished) {
        const id = matchId(m);
        const title = 'FT: ' + m.team1 + ' ' + scorelineText(m.score) + ' ' + m.team2;
        const body = goalsBody(m);
        const url = './index.html?date=' + matchDateKey(m);
        console.log('Sending push:', title);
        if (subscriptions.length) {
                await sendToAll(subscriptions, { title: title, body: body, icon: './icons/icon-192.png', url: url });
        }
        state.notified[id] = true;
  }

  saveState(state);
    console.log('Notified ' + newlyFinished.length + ' newly finished match(es).');
}

main().catch(function (err) {
    console.error('notify.js failed:', err);
    process.exit(1);
});
