# Turning on the X and Telegram posts

repo.ing can post two kinds of messages by itself, from the worker service:

- **Launch posts:** one post per new market.
- **Graduation posts:** when a market passes 25, 50, 75 or 90% of its graduation target, and when it graduates.

They go to an X account, a Telegram channel, or both. Nothing is posted until the keys below are in place and the switches are turned on. Every post is recorded in the database before it is sent, so nothing is ever posted twice, even if the worker restarts.

## 1. What the owner creates and sends

Send the values through a password manager share, or paste them into Railway yourself. Never send them in chat, email or a GitHub issue.

### X: four values

1. Sign in to the [X Developer Console](https://developer.x.com) **as the account that should post** (for example @repoing).
2. Create a Project and an App inside it.
3. In the App, open **User authentication settings** and set **App permissions** to **Read and write**. Save. (App type: "Web App, Automated App or Bot". Callback URL and website can both be `https://repo.ing`.)
4. Open **Keys and tokens** and copy:
   - the **API Key** and **API Key Secret** (also called Consumer Key and Secret);
   - the **Access Token** and **Access Token Secret**. Generate these **after** step 3, while signed in as the posting account. Tokens made before the switch to Read and write stay read-only and cannot post. If in doubt, regenerate them.
5. Buy **X API credits** in the Developer Console. The X API is pay-per-use with prepaid credits: without them every call fails, the check below included. On X's price list (October 2026) a post with a link costs $0.20 and every repo.ing post has one, so each X post costs about $0.20; each run of the check costs about $0.01. Set a spending limit in the console as a backstop.

Send: **API Key, API Key Secret, Access Token, Access Token Secret.** These are not the OAuth 2.0 Client ID and Secret, which are for "Connect X" on the site.

### Telegram: two values

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and pick a name and a username ending in `bot`. Copy the **bot token** it replies with.
2. Create the channel, or use the existing one. A public channel is best: every post then has a link.
3. Add the bot to the channel as an **administrator** with **Post messages** turned on (channel → Administrators → Add Admin).
4. Note the **chat id**: `@channelusername` for a public channel, or the channel's numeric id starting with `-100` for a private one.

Send: **the bot token and the chat id.**

## 2. Go-live checklist

Every variable below goes on the **worker** service in Railway.

1. **Add the keys:** `X_BOT_API_KEY`, `X_BOT_API_SECRET`, `X_BOT_ACCESS_TOKEN`, `X_BOT_ACCESS_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. To post Hugging Face model markets too, also set `HF_MARKETS_ENABLED=true` on the worker, the same as on web (model posts link to model pages, which only exist while web has it on). Leave the `*_ENABLED` switches below off for now.
2. **Check the keys without posting.** On the worker container (it has the variables), run:

   ```sh
   railway ssh --service worker -- node scripts/alerts-check.mjs
   ```

   It shows the X account that would post and its access level (it must be `read-write`), and whether the Telegram bot may post in the channel. It never prints a secret and never posts. It exits with an error on any problem and says how to fix it. Run it again until it ends with "All checks passed".
3. **Preview the posts:**

   ```sh
   railway ssh --service worker -- node scripts/alerts-preview.mjs
   ```

   With the switches still off it shows what would go out if they were on now: the exact Telegram and X texts for the markets of the last 24 hours that qualify, and why any market is held back. It only reads: nothing is claimed, locked or sent. `--launch-max` and `--graduation-max` preview other caps, and `--models` or `--no-models` previews with or without model markets. (`--since` previews another cutoff; one still to come shows nothing until then, which is what the worker will do.) Read each text once. Graduation posts appear only after the first run has recorded where each market stands, so before go-live the preview shows none.
4. **Turn it on:** set these on the worker. Railway redeploys it.

   ```sh
   LAUNCH_ALERTS_SINCE=2026-10-05T16:00:00Z      # the go-live time in UTC; nothing from before it is ever posted
   LAUNCH_ALERTS_MAX_PER_DAY=5
   LAUNCH_ALERTS_ENABLED=true
   GRADUATION_ALERTS_SINCE=2026-10-05T16:00:00Z  # the same go-live time
   GRADUATION_ALERTS_MAX_PER_DAY=5
   GRADUATION_ALERTS_ENABLED=true
   ```

5. **Confirm the worker picked it up.** Its log should show one `{"launchAlertsOn":…}` and one `{"milestoneAlertsOn":…}` line with the channels, cutoff, cap and whether models are included, and no `launchAlertError` or `milestoneAlertError` line. Run the check from step 2 once more.
6. **Watch the first posts.** The worker logs `{"launchAlerts":{"posts":[…]}}` and `{"milestoneAlerts":{"posts":[…]}}` only when it posts. Open the X profile and the channel and read the first few. The first graduation run posts nothing: it only records where each market stands, and later crossings are posted. In the database:

   ```sql
   select channel, status, attempts, message_url, error, created_at from launch_alerts order by id desc limit 20;
   select channel, milestone, status, attempts, message_url, error, created_at from milestone_alerts order by id desc limit 20;
   ```

### Safe caps

Start with **5 launch posts and 5 graduation posts per channel per day**, and raise them after a few calm days. However high the caps, each run (about once a minute) posts at most 2 per channel, 10 seconds apart. On X the caps also set the spend: at about $0.20 a post, 5 + 5 is at most about $2 a day (about $60 a month), and the defaults (15 + 10) at most about $5 a day (about $150 a month). Quiet days cost less: only real launches and crossings are posted. Telegram is free and its limits are far higher.

## 3. What gets posted

- **Launch posts:** markets indexed after `LAUNCH_ALERTS_SINCE`, within 24 hours of launch. A new repository (under 30 days old or under 10 stars) is posted only once its market reaches 10% of its graduation target within those 24 hours. Every Hugging Face model market follows the same rule: likes and downloads never count.
- **Graduation posts:** only crossings that happen after `GRADUATION_ALERTS_SINCE`. A jump from 20% to 80% posts 75% only, and falling back and crossing again posts nothing.
- **Never posted:** repositories and models on the do-not-promote list (`PROMOTION_EXCLUDED_REPO_IDS`, including `hf:` entries) and those whose maintainer or model owner opted out.
- **Turning model posts on later:** if `HF_MARKETS_ENABLED=true` is added to the worker after go-live, model markets from the previous 24 hours that qualify are announced on the next runs, like any market still in its window. To skip them, move `LAUNCH_ALERTS_SINCE` to that moment at the same time.

Model posts name the model by its Hugging Face id and always carry the disclaimer line. Likes come from Hugging Face at posting time and are left out if it does not answer within 5 seconds. Examples (X and Telegram read the same; X posts are shortened to fit 280 characters):

```text
🚀 New on repo.ing: octo/hello-world — $HELLO
⭐ 12.3k · A friendly greeter.
Every trade pays the repo's builders.
https://repo.ing/token/<mint>

🚀 New on repo.ing: Hugging Face model openai-community/gpt2 — $GPT2
❤️ 3.1k likes · Text generation · License: mit
Every trade pays the model's owner.
Community launch · Not endorsed by the creators · Not affiliated with Hugging Face
https://repo.ing/token/<mint>

📈 $GPT2 passed 75% of the way to graduating on repo.ing — 20 SOL to go.
Hugging Face model openai-community/gpt2
Community launch · Not endorsed by the creators · Not affiliated with Hugging Face
https://repo.ing/token/<mint>
```

## 4. Stopping and fixing

- **Stop:** set `LAUNCH_ALERTS_ENABLED=false` or `GRADUATION_ALERTS_ENABLED=false` on the worker. Posting stops when the worker restarts with the new value.
- **A post marked `failed`:** X or Telegram refused it, so nothing was posted. It is retried automatically after at least 5 minutes, up to 3 tries in all.
- **A post marked `unknown`:** it may have gone out (a timeout, for example), so it is never retried. Look at the channel. If it is missing and should go out, delete that row to allow one new attempt. If it posted, leave the row.
- **Changed keys:** update the variables, run the check from step 2, and watch the next posts.

More detail: [Launch alerts](PRODUCTION.md#launch-alerts) and [Graduation milestone alerts](PRODUCTION.md#graduation-milestone-alerts).
