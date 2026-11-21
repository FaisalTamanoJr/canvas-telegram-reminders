import { extractAssignments } from './ics.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// When to remind, measured back from the due time.
const REMINDERS = [3 * DAY, 2 * DAY, 1 * DAY, 5 * HOUR, 1 * HOUR, 30 * MIN];

// The free Workers plan allows 50 outbound requests per run; stay well under it.
const MAX_SENDS_PER_RUN = 25;
const DONE_TTL_SECONDS = 120 * 24 * 60 * 60;
const UNDO_STACK_SIZE = 10;

const tzOf = (env) => env.TIMEZONE || 'Asia/Manila';

// ---------- formatting ----------

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fmtLeft(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${mi}m`;
  return `${mi}m`;
}

function fmtDue(t, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(t));
}

function reminderText(a, now, tz) {
  return [
    `⏰ <b>${esc(a.title)}</b>`,
    a.course && `📚 ${esc(a.course)}`,
    `🗓 Due ${esc(fmtDue(a.due, tz))}`,
    `⏳ ${fmtLeft(a.due - now)} left`,
  ].filter(Boolean).join('\n');
}

function reminderKeyboard(a) {
  const row = [];
  if (a.url) row.push({ text: '🔗 Open', url: a.url });
  row.push({ text: '✅ Submitted', callback_data: `done:${a.id}` });
  return { inline_keyboard: [row] };
}

// ---------- Telegram + Canvas ----------

async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!json.ok) console.error(`telegram ${method} failed: ${json.description}`);
  return json;
}

const say = (env, text, extra = {}) =>
  tg(env, 'sendMessage', {
    chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML',
    disable_web_page_preview: true, ...extra,
  });

async function getAssignments(env) {
  const res = await fetch(env.CANVAS_ICS_URL, {
    headers: {
      // Canvas sometimes answers 403 to requests without a browser-like User-Agent.
      'User-Agent': 'Mozilla/5.0 (compatible; canvas-telegram-reminders/1.0)',
      Accept: 'text/calendar, */*',
    },
  });
  if (!res.ok) throw new Error(`feed fetch failed: ${res.status}`);
  return extractAssignments(await res.text(), tzOf(env));
}

const isDone = async (env, id) => (await env.KV.get(`done:${id}`)) !== null;

// ---------- scheduled reminders ----------

async function runReminders(env, now = Date.now()) {
  if (!env.TELEGRAM_CHAT_ID) return { sent: 0, note: 'TELEGRAM_CHAT_ID is not set' };

  let items;
  try {
    items = await getAssignments(env);
  } catch (err) {
    console.error(err);
    // Tell the user once a day at most, so a broken feed doesn't fail silently.
    if (!(await env.KV.get('feed_error_notified'))) {
      await say(env, `⚠️ Couldn't read your Canvas calendar feed (${esc(err.message)}). Reminders are paused until it works again.`);
      await env.KV.put('feed_error_notified', '1', { expirationTtl: 86400 });
    }
    return { sent: 0, note: err.message };
  }

  const sentLog = (await env.KV.get('sent', 'json')) || {}; // id -> { due, offs: [ms] }
  let changed = false;
  let sends = 0;

  for (const a of items) {
    if (a.due <= now) continue;
    const left = a.due - now;
    const passed = REMINDERS.filter((ms) => left <= ms);
    if (!passed.length) continue;

    let rec = sentLog[a.id];
    if (!rec || rec.due !== a.due) rec = { due: a.due, offs: [] }; // new, or due date moved
    if (passed.every((ms) => rec.offs.includes(ms))) continue;

    if (!(await isDone(env, a.id))) {
      if (sends >= MAX_SENDS_PER_RUN) break; // the rest go out on the next run
      const r = await say(env, reminderText(a, now, tzOf(env)), { reply_markup: reminderKeyboard(a) });
      if (!r.ok) continue; // retry next run
      sends++;
    }
    // One message covers every reminder point already passed (late rather than skipped,
    // without a burst of duplicates).
    rec.offs = [...new Set([...rec.offs, ...passed])];
    sentLog[a.id] = rec;
    changed = true;
  }

  for (const [id, rec] of Object.entries(sentLog)) {
    if (rec.due < now - DAY) { delete sentLog[id]; changed = true; }
  }
  if (changed) await env.KV.put('sent', JSON.stringify(sentLog));
  return { sent: sends };
}

// ---------- commands ----------

const HELP = [
  '<b>Canvas reminders</b>',
  "I'll message you 3 days, 2 days, 1 day, 5 hours, 1 hour and 30 minutes before each Canvas assignment is due.",
  '',
  'Tap <b>✅ Submitted</b> on a reminder to stop reminders for it.',
  '',
  '/due – unsubmitted assignments for the next 7 days',
  '/undo – un-mark the last assignment you marked submitted',
  '/check – check Canvas for reminders right now',
  '/help – this message',
].join('\n');

async function cmdDue(env) {
  const tz = tzOf(env);
  const now = Date.now();
  const soon = (await getAssignments(env)).filter((a) => a.due > now && a.due <= now + 7 * DAY);
  const done = await Promise.all(soon.map((a) => isDone(env, a.id)));
  const open = soon.filter((_, i) => !done[i]);

  if (!open.length) return say(env, '🎉 Nothing unsubmitted is due in the next 7 days.');

  const lines = open.slice(0, 30).map((a) => {
    const name = a.url ? `<a href="${esc(a.url)}">${esc(a.title)}</a>` : esc(a.title);
    const meta = [a.course && esc(a.course), esc(fmtDue(a.due, tz)), `${fmtLeft(a.due - now)} left`]
      .filter(Boolean).join(' · ');
    return `• <b>${name}</b>\n   ${meta}`;
  });
  if (open.length > 30) lines.push(`…and ${open.length - 30} more`);
  return say(env, `📋 <b>Due in the next 7 days (${open.length})</b>\n\n${lines.join('\n\n')}`);
}

async function cmdUndo(env) {
  const stack = (await env.KV.get('undo_stack', 'json')) || [];
  const last = stack.pop();
  if (!last) return say(env, 'Nothing to undo.');

  await env.KV.delete(`done:${last.id}`);
  await env.KV.put('undo_stack', JSON.stringify(stack));

  // Put the original reminder message back the way it was.
  if (last.messageId) {
    await tg(env, 'editMessageText', {
      chat_id: env.TELEGRAM_CHAT_ID, message_id: last.messageId,
      text: last.text, entities: last.entities, reply_markup: last.replyMarkup,
      disable_web_page_preview: true,
    });
  }
  return say(env, `↩️ Un-marked <b>${esc(last.title)}</b>. Its reminders will continue.`);
}

async function markSubmitted(env, cq, id) {
  const msg = cq.message;
  if (await isDone(env, id)) {
    return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Already marked as submitted' });
  }
  await env.KV.put(`done:${id}`, String(Date.now()), { expirationTtl: DONE_TTL_SECONDS });

  const text = msg?.text || '';
  const stack = (await env.KV.get('undo_stack', 'json')) || [];
  stack.push({
    id,
    title: text.split('\n')[0].replace(/^⏰\s*/, '') || 'assignment',
    messageId: msg?.message_id,
    text,
    entities: msg?.entities || [],
    replyMarkup: msg?.reply_markup,
  });
  await env.KV.put('undo_stack', JSON.stringify(stack.slice(-UNDO_STACK_SIZE)));

  if (msg) {
    // Keep the Open button, drop the Submitted one.
    const rows = (msg.reply_markup?.inline_keyboard || [])
      .map((row) => row.filter((b) => b.url))
      .filter((row) => row.length);
    await tg(env, 'editMessageText', {
      chat_id: msg.chat.id, message_id: msg.message_id,
      text: `${text}\n\n✅ Marked as submitted`,
      entities: msg.entities || [],
      reply_markup: { inline_keyboard: rows },
      disable_web_page_preview: true,
    });
  }
  return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Marked as submitted ✅' });
}

async function handleUpdate(env, update) {
  const allowed = (chatId) => String(chatId) === String(env.TELEGRAM_CHAT_ID);

  if (update.callback_query) {
    const cq = update.callback_query;
    if (!allowed(cq.message?.chat?.id)) {
      return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Not authorized' });
    }
    const m = /^done:([0-9a-f]+)$/.exec(cq.data || '');
    if (m) return markSubmitted(env, cq, m[1]);
    return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  }

  const msg = update.message;
  if (!msg?.text) return;
  const cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase();

  if (!allowed(msg.chat.id)) {
    // Helps during setup: tells you the chat ID to store as TELEGRAM_CHAT_ID.
    if (cmd === '/start' || cmd === '/id') {
      await tg(env, 'sendMessage', {
        chat_id: msg.chat.id,
        text: `This is a private reminder bot.\nYour chat ID is: ${msg.chat.id}`,
      });
    }
    return;
  }

  switch (cmd) {
    case '/due': return cmdDue(env);
    case '/undo': return cmdUndo(env);
    case '/check': {
      const r = await runReminders(env);
      return say(env, r.note ? `⚠️ ${esc(r.note)}` : `✅ Checked Canvas. Sent ${r.sent} reminder(s).`);
    }
    case '/id': return say(env, `Your chat ID is: ${msg.chat.id}`);
    case '/start':
    case '/help': return say(env, HELP);
  }
}

// ---------- one-time setup route ----------

async function setup(env, origin) {
  const report = {};
  report.setWebhook = await tg(env, 'setWebhook', {
    url: `${origin}/telegram`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  report.setMyCommands = await tg(env, 'setMyCommands', {
    commands: [
      { command: 'due', description: 'Unsubmitted assignments for the next 7 days' },
      { command: 'undo', description: 'Un-mark the last submitted assignment' },
      { command: 'check', description: 'Check Canvas for reminders now' },
      { command: 'help', description: 'How this bot works' },
    ],
  });

  try {
    const items = await getAssignments(env);
    const upcoming = items.filter((a) => a.due > Date.now()).length;
    report.feed = `ok: ${items.length} assignments in feed, ${upcoming} upcoming`;
  } catch (err) {
    report.feed = `error: ${err.message}`;
  }

  if (env.TELEGRAM_CHAT_ID) {
    report.testMessage = await say(env, `✅ <b>Canvas reminders are set up.</b>\nFeed: ${esc(report.feed)}\n\n${HELP}`);
  } else {
    report.next = 'TELEGRAM_CHAT_ID is not set yet. Send /start to your bot to get your chat ID, set it as a secret, then open /setup again.';
  }
  return report;
}

// ---------- entry points ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/telegram' && request.method === 'POST') {
      if (!env.WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      try {
        await handleUpdate(env, await request.json());
      } catch (err) {
        console.error(err); // still answer 200 so Telegram doesn't retry forever
      }
      return new Response('ok');
    }

    if (url.pathname === '/setup') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('secret') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const report = await setup(env, url.origin);
      return new Response(JSON.stringify(report, null, 2), { headers: { 'content-type': 'application/json' } });
    }

    return new Response('Canvas Telegram reminders are running.');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env).then((r) => console.log('reminders', JSON.stringify(r))));
  },
};
