# Facebook Marketplace Assistant MCP

Local Phase 1, Phase 2, Phase 3, and Phase 4 MCP server for creating Facebook Marketplace listing drafts, filling the Marketplace listing form, reading seller listings, monitoring buyer messages, and sending human-approved replies through Playwright.

This implementation follows these safety boundaries:

- It never stores a Facebook password.
- It uses a local persistent browser profile.
- It does not bypass login, 2FA, CAPTCHA, or Facebook risk checks.
- It refuses to publish automatically.
- It refuses to send buyer replies without a human approval token.
- It stops with the browser open so the user can review and manually click `Publish`.

## Tools

### `create_listing_draft`

Creates a local JSON draft under `~/.hermes/facebook-marketplace/drafts` by default.

Input:

```json
{
  "title": "IKEA Desk",
  "price": 40,
  "category": "Furniture",
  "condition": "Good",
  "description": "Used IKEA desk in good condition. Pickup only.",
  "location": "Minneapolis, MN",
  "photos": ["/absolute/path/photo1.jpg"],
  "tags": ["desk", "ikea", "pickup only"]
}
```

### `fill_listing_form`

Loads a saved draft, opens `https://www.facebook.com/marketplace/create/item`, fills the form, saves a screenshot, and stops before publish.

Input:

```json
{
  "draft_id": "draft_20260510_193000_abcd",
  "stop_before_publish": true
}
```

### `resume_listing_draft`

Reloads an existing local draft and fills the form again.

### `list_my_listings`

Opens the Facebook Marketplace seller listings page, scrapes visible listing cards, syncs local inventory, saves a screenshot, and returns the current visible listings.

Input:

```json
{
  "max_scrolls": 3
}
```

### `get_listing_detail`

Opens a Marketplace listing detail page by local listing id, Facebook item id, or Marketplace item URL. It scrapes visible detail metadata and updates local inventory.

Input:

```json
{
  "listing_id": "fb_123456"
}
```

### `check_marketplace_messages`

Opens the configured Facebook Marketplace/Messenger inbox URL, scrapes visible buyer threads, stores them in local SQLite message memory, returns visible thread summaries, and returns newly seen buyer messages.

Input:

```json
{
  "since": "last_check",
  "include_read": false,
  "max_threads": 20,
  "max_scrolls": 3
}
```

### `get_message_thread`

Opens a saved Marketplace/Messenger thread, scrapes visible messages, updates local message memory, and returns the thread conversation.

Input:

```json
{
  "thread_id": "thread_abc"
}
```

### `draft_reply`

Generates a local reply draft for a saved thread and classifies risk. It never sends a message.

### `send_reply`

Opens a saved Marketplace/Messenger thread, sends only the exact human-approved message when an approval token is supplied, and logs the sent reply locally.

Input:

```json
{
  "thread_id": "thread_abc",
  "message": "Yes, it is still available.",
  "approval_token": "human-approved-2026-05-28"
}
```

## Prompts

The server exposes MCP prompts for safe Hermes workflows. These are prompt templates, not direct actions; they guide Hermes toward the tools above while preserving the manual-review boundaries.

### `create_marketplace_listing_from_notes`

Turns raw item notes into a Marketplace-ready draft workflow. It should call `create_listing_draft` only when the required draft fields are present, and should not open Facebook unless the user explicitly asks for form fill.

Arguments:

- `notes`: raw item notes from the user.
- `target_price`: optional target price or price range.
- `category`: optional category hint.
- `condition`: optional condition hint.
- `pickup_area`: optional general pickup area, not an exact address.
- `photo_paths`: optional newline- or comma-separated absolute local photo paths.

### `review_listing_before_publish`

Reviews a local draft or filled form before manual publish. It may use `fill_listing_form` or `resume_listing_draft`, but only with the server's stop-before-publish behavior.

Arguments:

- `draft_id`: local draft id.
- `review_focus`: optional focus such as price, safety, clarity, or photos.
- `screenshot_path`: optional local screenshot path from a previous fill attempt.

### `triage_marketplace_buyer_messages`

Checks buyer messages and triages them for human-approved follow-up. It does not send replies.

Arguments:

- `since`: message window to check. Default: `last_check`.
- `include_read`: `false` or `true`. Default: `false`.
- `max_threads`: optional maximum number of threads to inspect.

### `reply_to_marketplace_buyer_message`

Finds the relevant buyer thread and sends a human-approved reply through the MCP tools only. The prompt explicitly tells agents not to create temporary Playwright, CJS, JS, or JSON probe files in this repository.

Arguments:

- `thread_id`: optional saved thread id from `check_marketplace_messages`.
- `buyer_name`: optional buyer name hint if the thread id is unknown.
- `listing_hint`: optional listing title or item hint.
- `reply_message`: exact reply text the user approved.
- `approval_token`: human approval token required before `send_reply`.

### `debug_marketplace_login_or_selector_failure`

Guides safe debugging for login, checkpoint, CAPTCHA, or selector-drift failures without asking for passwords, 2FA codes, cookies, or browser profile uploads.

Arguments:

- `failure_context`: observed error, tool result, or user description.
- `last_tool`: optional last MCP tool that failed.
- `screenshot_path`: optional local screenshot path from the failed run.

## Setup

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Run as an MCP server over stdio:

```bash
npm start
```

## Environment

Copy `.env.example` if your launcher supports env files, or set these variables in Hermes MCP config.

Important variables:

- `FB_MARKETPLACE_DATA_DIR`: local state directory. Default: `~/.hermes/facebook-marketplace`.
- `FB_MARKETPLACE_HOME_LOCATION`: fallback listing location.
- `FB_MARKETPLACE_SELLING_URL`: seller listings URL. Default: `https://www.facebook.com/marketplace/you/selling`.
- `FB_MARKETPLACE_MESSAGES_URL`: Marketplace/Messenger inbox URL. Default: `https://www.facebook.com/marketplace/inbox`.
- `FB_CHROME_USER_DATA_DIR`: browser profile directory. Default: `~/.hermes/facebook-marketplace/browser-profile`.
- `FB_BROWSER_CHANNEL`: optional browser channel, for example `chrome`.
- `FB_BROWSER_MODE`: `managed_profile` launches the configured local profile; `existing_cdp` connects to an already-open Chrome instance that was started with remote debugging. Default: `managed_profile`.
- `FB_BROWSER_CDP_URL`: CDP endpoint for `existing_cdp`. Default: `http://127.0.0.1:9222`.
- `FB_CHROME_PROFILE_NAME`: optional Chrome profile name when using a Chrome user data directory.
- `FB_HEADLESS`: should stay `false` for manual Facebook login/review.
- `FB_SLOW_MO_MS`: extra delay per Playwright operation in milliseconds. Default: `0`. Raise it only if you want slower, easier-to-watch automation.
- `FB_SCREENSHOT_FULL_PAGE`: capture full-page screenshots instead of viewport-only. Default: `false`. Full-page captures of long Facebook pages are slower and larger.
- `FB_STEALTH`: apply `puppeteer-extra-plugin-stealth` fingerprint patches (`navigator.webdriver`, plugins, languages, WebGL vendor, headless UA, etc.). Default: `true`. Set to `false` only to debug without the stealth shim.

Recommended first run:

1. Start the MCP server with `FB_HEADLESS=false`.
2. Call `fill_listing_form` once.
3. Log in manually in the opened browser if Facebook asks.
4. Complete any 2FA or CAPTCHA manually.
5. Re-run `fill_listing_form` after login if the form was not visible.

### Directly attach to an already logged-in Chrome

To let the MCP server use a Chrome window you already logged into, start Chrome with a remote debugging port before opening Facebook:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.hermes/facebook-marketplace/cdp-profile"
```

Then log in to Facebook in that Chrome window and either set:

```bash
FB_BROWSER_MODE=existing_cdp
FB_BROWSER_CDP_URL=http://127.0.0.1:9222
```

or pass these optional fields to any browser-using tool:

```json
{
  "browser_mode": "existing_cdp",
  "browser_cdp_url": "http://127.0.0.1:9222"
}
```

Ordinary Chrome windows cannot be attached after the fact; Chrome must be launched with `--remote-debugging-port` first. If CDP connection fails, the tool reports a setup error and does not silently fall back to a separate browser profile.

## Browser Fingerprint Stealth

The persistent browser context launches through [`playwright-extra`](https://github.com/berstend/puppeteer-extra/tree/master/packages/playwright-extra) with [`puppeteer-extra-plugin-stealth`](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth) registered. This suppresses common automation tells (`navigator.webdriver`, empty `navigator.plugins`, `HeadlessChrome` UA, SwiftShader WebGL vendor) that Facebook risk checks fingerprint on. Toggle with `FB_STEALTH=false` to disable.

Verify the patches in your environment:

```bash
node scripts/test-stealth.mjs
```

The script launches a throwaway profile (it does not touch your real Marketplace browser profile), probes the fingerprint signals with stealth off and on, and prints a side-by-side diff plus a pass/fail verdict.

## Hermes Config

See `examples/hermes.mcp.example.yaml`.

## Local Data

Default local state:

```text
~/.hermes/facebook-marketplace/
  drafts/
  photos/
  screenshots/
  logs/
  browser-profile/
  inventory.json
  messages.db
```

The server creates these directories with restricted permissions when possible.

## Phase 1 Limitations

Facebook Marketplace selectors can change. The form filler uses resilient label and placeholder selectors, but some fields may still need manual review if Facebook changes the UI or localizes field names.

Phase 2 listing reads depend on Facebook's current web UI. The scraper stores visible listing metadata in `inventory.json`, but some fields may remain `null` when Facebook hides them or changes the layout.

Phase 3 message reads depend on Facebook's current Marketplace/Messenger UI. The scraper stores visible message thread metadata in `messages.db`; Hermes should poll `check_marketplace_messages` every 1-3 minutes and send returned `new_messages` to Discord.

Phase 4 reply sending depends on Facebook's current Messenger composer UI. `send_reply` refuses missing or placeholder approval tokens, classifies reply risk, and logs sent replies in `messages.db`.

This phase does not implement marking listings sold.
