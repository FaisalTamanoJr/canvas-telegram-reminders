// Minimal iCalendar (.ics) parsing for Canvas calendar feeds.

// Split an .ics file into VEVENT objects: { NAME: { value, params } }.
export function parseICS(text) {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '') // unfold continued lines
    .split('\n');

  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;

    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const [name, ...paramParts] = line.slice(0, colon).split(';');
    const params = {};
    for (const p of paramParts) {
      const eq = p.indexOf('=');
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
    }
    cur[name.toUpperCase()] = { value: line.slice(colon + 1), params };
  }
  return events;
}

export function unescapeText(v = '') {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
}

// Offset (ms) of a time zone from UTC at instant t.
function tzOffset(t, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(t));
  const g = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour, +g.minute, +g.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

// Wall-clock time in a time zone -> UTC epoch ms.
export function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off = tzOffset(guess, tz);
  let t = guess - off;
  const off2 = tzOffset(t, tz);
  if (off2 !== off) t = guess - off2;
  return t;
}

// Parse a DTSTART/DUE property into epoch ms.
export function parseICSDate(prop, defaultTz) {
  if (!prop) return null;
  const v = prop.value.trim();

  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    // Date-only: Canvas uses this for "due at end of day".
    return zonedToUtc(+m[1], +m[2], +m[3], 23, 59, 0, defaultTz);
  }

  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);

  let tz = prop.params.TZID || defaultTz;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = defaultTz; }
  return zonedToUtc(+y, +mo, +d, +h, +mi, +s, tz);
}

async function shortId(uid) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(uid));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Canvas titles look like "Lab Report 3 [CPECOG2 - S11]".
export function splitTitle(summary) {
  const m = summary.match(/^(.*\S)\s*\[([^\]]+)\]\s*$/);
  return m ? { title: m[1], course: m[2] } : { title: summary, course: '' };
}

// Assignment events from a Canvas feed: [{ id, uid, title, course, due, url }].
export async function extractAssignments(icsText, tz) {
  const out = [];
  for (const ev of parseICS(icsText)) {
    const uid = ev.UID?.value || '';
    if (!/assignment/i.test(uid)) continue; // skip plain calendar events
    const due = parseICSDate(ev.DTSTART || ev.DUE, tz);
    if (!due) continue;
    const { title, course } = splitTitle(unescapeText(ev.SUMMARY?.value || 'Untitled'));
    const url = (ev.URL?.value || '').trim();
    out.push({
      id: await shortId(uid),
      uid,
      title,
      course,
      due,
      url: /^https?:\/\//.test(url) ? url : '',
    });
  }
  return out.sort((a, b) => a.due - b.due);
}
