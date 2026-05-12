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

Opens the configured Facebook Marketplace/Messenger inbox URL, scrapes visible buyer threads, stores them in local SQLite message memory, and returns newly seen buyer messages.

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

Generates a local reply draft for a saved Marketplace/Messenger thread and classifies the reply risk. This tool never sends a message.

Input:

```json
{
  "thread_id": "thread_abc",
  "intent": "availability",
  "constraints": {
    "min_price": 35,
    "pickup_only": true,
    "pickup_area": "near UMN"
  }
}
```

### `send_reply`

Opens a saved Marketplace/Messenger thread, sends a buyer reply only when a human approval token is supplied, logs the sent message locally, and returns a screenshot path.

Input:

```json
{
  "thread_id": "thread_abc",
  "message": "Yes, it is still available. Pickup is near UMN.",
  "approval_token": "discord_confirmed_..."
}
```

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
- `FB_CHROME_PROFILE_NAME`: optional Chrome profile name when using a Chrome user data directory.
- `FB_HEADLESS`: should stay `false` for manual Facebook login/review.

Recommended first run:

1. Start the MCP server with `FB_HEADLESS=false`.
2. Call `fill_listing_form` once.
3. Log in manually in the opened browser if Facebook asks.
4. Complete any 2FA or CAPTCHA manually.
5. Re-run `fill_listing_form` after login if the form was not visible.

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
