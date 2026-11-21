# Canvas → Telegram deadline reminders

A small bot that reads your Canvas calendar and messages you on Telegram before every assignment is due:
**3 days, 2 days, 1 day, 5 hours, 1 hour and 30 minutes** before the deadline.

It runs on Cloudflare Workers' free plan, so your computer doesn't need to stay on.

Each reminder shows the course, the assignment, the due time and how long is left, with two buttons:

- **🔗 Open**: opens the assignment in Canvas
- **✅ Submitted**: stops the reminders for that assignment

Commands you can send the bot:

| Command  | What it does                                               |
|----------|------------------------------------------------------------|
| `/due`   | Lists unsubmitted assignments due in the next 7 days       |
| `/undo`  | Un-marks the last assignment you marked as submitted       |
| `/check` | Checks Canvas right now instead of waiting up to 10 minutes |
| `/help`  | Shows the help message                                     |

It only reads Canvas's calendar feed (no Canvas API token needed), and it only answers your own Telegram account.

---

## Setup (about 15 minutes)

You need:
- [Node.js](https://nodejs.org) 20 or newer
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- Telegram

### 1. Get the code

```bash
git clone https://github.com/FaisalTamanoJr/canvas-telegram-reminders.git
cd canvas-telegram-reminders
npm install
```

### 2. Create your Telegram bot

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Pick a name and a username (must end in `bot`).
3. BotFather replies with a **token** like `123456789:AAH...`. Save it and keep it private, because anyone with it can control your bot.

### 3. Get your Canvas calendar feed link

1. Open Canvas in a browser and go to **Calendar**.
2. At the bottom of the right sidebar, click **Calendar Feed**.
3. Copy the link. It looks like `https://<school>.instructure.com/feeds/calendars/user_....ics`.
   Keep it private, since it shows your whole Canvas calendar.

### 4. Log in to Cloudflare and create storage

```bash
npx wrangler login
npx wrangler kv namespace create KV
```

The second command prints an `id`. Open `wrangler.toml` and replace `PASTE_YOUR_KV_NAMESPACE_ID_HERE` with it.
(If wrangler offers to add it to your config for you, say yes; just make sure only one `[[kv_namespaces]]` block remains.)

If you're not in the Philippines, also change `TIMEZONE` in `wrangler.toml`
(for example `America/New_York`, `Europe/London`, `Asia/Singapore`).

### 5. Deploy

```bash
npx wrangler deploy
```

It prints your bot's address, for example `https://canvas-notifs.<your-subdomain>.workers.dev`. You'll need it in step 7.

### 6. Add your secrets

Run each command and paste the value when asked. The values are stored encrypted on Cloudflare, never in the code.

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN   # the token from BotFather
npx wrangler secret put CANVAS_ICS_URL       # the Canvas feed link
npx wrangler secret put WEBHOOK_SECRET       # any random password, letters/numbers only
```

For `WEBHOOK_SECRET` you can generate one with `openssl rand -hex 32`, or just mash the keyboard (letters and numbers only).

### 7. Connect Telegram to your bot

Open this in your browser (use your address from step 5 and your `WEBHOOK_SECRET`):

```
https://canvas-notifs.<your-subdomain>.workers.dev/setup?secret=<WEBHOOK_SECRET>
```

You should see `"ok": true` under `setWebhook`, and a `feed` line saying how many assignments it found.

### 8. Tell the bot who you are

1. In Telegram, open your new bot and send `/start`.
2. It replies with **"Your chat ID is: 123456789"**.
3. Save that number as a secret:

```bash
npx wrangler secret put TELEGRAM_CHAT_ID
```

4. Open the `/setup` link from step 7 again. You should get a **"Canvas reminders are set up"** message in Telegram. 🎉

From now on it checks Canvas every 10 minutes. Send `/due` to see what's coming up.

---

## Troubleshooting

**No messages at all**
- Open the `/setup` link again and read the result. `setWebhook` should be `ok`, and `feed` should not say `error`.
- Make sure all four secrets are set: `npx wrangler secret list`.
- Watch live logs while you message the bot: `npx wrangler tail`.

**"Couldn't read your Canvas calendar feed (feed fetch failed: 403/404)"**
- Your feed link is wrong or was reset. Copy it again from Canvas → Calendar → Calendar Feed and run `npx wrangler secret put CANVAS_ICS_URL`.

**Due times are off by a few hours**
- Set `TIMEZONE` in `wrangler.toml` to your time zone and run `npx wrangler deploy` again.

**The bot says "This is a private reminder bot"**
- Your `TELEGRAM_CHAT_ID` secret doesn't match your chat. Set it to the number the bot shows you.

**I leaked my bot token or feed link**
- Bot token: in @BotFather send `/revoke`, pick your bot, then `npx wrangler secret put TELEGRAM_BOT_TOKEN` with the new one and open `/setup` again.
- Canvas feed: Canvas has a "reset" option next to the Calendar Feed link. Then update `CANVAS_ICS_URL`.

---

## How it works

- `src/ics.js` downloads and parses the Canvas `.ics` feed. Only assignment events are used, not regular calendar events.
- `src/index.js` holds the Worker:
  - A **cron trigger** runs every 10 minutes. For each upcoming assignment it checks which reminder points have passed and sends a message for any not yet sent. Sent reminders are recorded in Cloudflare KV, so nothing repeats. If a check is missed, the reminder is sent late instead of being skipped (one message, not several).
  - If an instructor moves a deadline, reminders restart for the new due time.
  - `POST /telegram` receives button taps and commands. It checks Telegram's secret header and only accepts your chat ID.
  - `GET /setup?secret=...` registers the webhook and bot commands, then sends a test message.

Run the parser tests with `npm test`.

Everything fits comfortably in Cloudflare's free tier.
