# Housing Telegram Bot

Monitors Dabang and Zigbang for Seoul-wide monthly-rent listings matching:

- Deposit <= 500만원
- Monthly rent <= 68만원
- Maintenance fee treated separately
- 원룸 and 오피스텔 only
- No 반지하 or 옥탑
- Minimum 6평
- Explicit text evidence for 전입신고 가능

## Setup

1. Create a Telegram bot with BotFather.
   - Open Telegram and message `@BotFather`.
   - Send `/newbot`.
   - Copy the bot token.

2. Get your chat ID.
   - Send any message to your new bot.
   - Open this URL in a browser, replacing the token:
     `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   - Copy `message.chat.id`.

3. Install dependencies.

```bash
npm install
npx playwright install chromium
```

4. Create `.env`.

```bash
cp .env.example .env
```

Then edit `.env` and set:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

5. Test without sending Telegram messages.

```bash
npm run dry-run
```

6. Initialize seen listings without alerting existing matches.

```bash
npm run init-seen
```

7. Start the polling bot.

```bash
npm start
```

## GitHub Actions Deployment

This is the recommended always-on setup. It runs on GitHub's servers every 20 minutes, so it continues even if your MacBook is closed or powered off.

1. Add repository secrets in GitHub: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
2. Enable Settings -> Actions -> General -> Workflow permissions -> Read and write permissions.
3. Open Actions -> Housing Telegram Bot -> Run workflow.

The first GitHub run records current matching listings in `data/seen.json` without sending them. Later runs only send newly discovered matches.

## Notes

`전입신고 가능` is not exposed as a stable boolean in the map-list responses available to this bot. The bot therefore treats it as a strict text filter: a listing must explicitly mention `전입` and must not contain obvious negative phrases such as `전입불가` or `전입X`.

Zigbang uses encrypted map search tokens in its current web app. The bot uses Playwright to load Zigbang's own map page, sweep a Seoul grid, collect listing IDs from the app's normal network responses, and then fetch listing details through Zigbang's JSON API.

For faster local testing, set `ZIGBANG_MAX_CENTERS=1` before `npm run dry-run`. The production default checks the full Seoul grid. If Zigbang gets slow, lower `ZIGBANG_DETAIL_CONCURRENCY` or raise `FETCH_TIMEOUT_MS` in `.env`.
