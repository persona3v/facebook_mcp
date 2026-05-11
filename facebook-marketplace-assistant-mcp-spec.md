# Facebook Marketplace Assistant MCP 架构 Spec

**Status:** Draft  
**Owner:** Saber / Hermes  
**Target Channel:** Discord Hermes  
**Last Updated:** 2026-05-10

## 1. Goal

构建一个本地运行的 **Facebook Marketplace Assistant MCP Server**，让 Hermes 可以通过 Discord 帮用户完成 Facebook Marketplace 二手物品上架辅助、listing 管理、买家私信监控与回复草稿生成。

核心原则：

- MCP 负责连接 Facebook Marketplace Web UI / Messenger Web UI。
- Hermes 负责自然语言交互、内容生成、审批流和 Discord 通知。
- Facebook 发布和关键私信发送默认保留人工确认。
- 不依赖官方 Facebook Marketplace API，因为普通个人 Marketplace 上架/私信没有稳定开放 API。

---

## 2. Non-Goals

本系统不做以下事情：

1. 不绕过 Facebook 登录、2FA、CAPTCHA 或风控。
2. 不默认自动点击 `Publish`。
3. 不默认自动发送涉及价格、地址、见面时间、付款方式的消息。
4. 不伪装成官方 Facebook API。
5. 不保存 Facebook 密码。
6. 不把 Facebook session cookie 上传到远程服务器。
7. 不保证 Facebook 页面更新后 selector 永远可用。

---

## 3. High-Level Architecture

```text
Discord Channel
    ↓
Hermes Agent
    ↓ native MCP client
Facebook Marketplace Assistant MCP Server
    ↓
Playwright persistent browser session
    ↓
Facebook Marketplace / Messenger Web UI
```

本地状态存储：

```text
~/.hermes/facebook-marketplace/
  inventory.db
  messages.db
  drafts/
  photos/
  screenshots/
  logs/
  config.yaml
```

---

## 4. Components

### 4.1 Hermes Discord Interface

用户通过 Discord 与 Hermes 交互，例如：

```text
帮我把这套餐桌椅上架，价格 $80，可议价，pickup only
```

Hermes 负责：

- 解析用户意图
- 生成 listing 标题、描述、价格建议
- 调用 MCP tools
- 把截图、状态、买家消息推回 Discord
- 处理人工确认指令，例如：
  - `确认发布`
  - `发送这个回复`
  - `改成 $70`
  - `不要回复`
  - `标记已售`

### 4.2 Facebook Marketplace Assistant MCP Server

本地 MCP server，推荐使用 Python 或 TypeScript 实现。

职责：

- 启动/连接 Playwright browser context
- 使用用户已登录的 Chrome profile
- 填写 Marketplace listing 表单
- 读取 seller listings
- 读取 Marketplace/Messenger 私信
- 执行人工确认后的回复
- 保存本地 draft、listing metadata、message thread state

### 4.3 Playwright Browser Layer

使用 Playwright 操作 Facebook Web UI。

建议使用 persistent context：

```text
chromium.launchPersistentContext(userDataDir)
```

或连接已有 Chrome profile。

要求：

- 用户手动登录 Facebook
- 用户手动完成 2FA / CAPTCHA
- MCP 不处理密码
- MCP 只在登录态存在时运行

---

## 5. MCP Tool Surface

### 5.1 Listing Draft Tools

#### `create_listing_draft`

创建本地 listing draft，不打开 Facebook。

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

Output:

```json
{
  "draft_id": "draft_20260510_001",
  "status": "saved",
  "draft_path": "~/.hermes/facebook-marketplace/drafts/draft_20260510_001.json"
}
```

---

#### `fill_listing_form`

打开 Facebook Marketplace 创建 listing 页面，并自动填入 draft 信息。

Input:

```json
{
  "draft_id": "draft_20260510_001",
  "stop_before_publish": true
}
```

Output:

```json
{
  "status": "ready_for_manual_publish",
  "screenshot_path": "~/.hermes/facebook-marketplace/screenshots/draft_20260510_001_review.png",
  "browser_state": "waiting_on_publish_screen"
}
```

Important behavior:

- 上传图片
- 填标题、价格、品类、condition、description、location
- 停在 publish/review 前
- 不自动点击 Publish

---

#### `resume_listing_draft`

重新打开某个本地 draft，并重新填表。

Input:

```json
{
  "draft_id": "draft_20260510_001"
}
```

Output:

```json
{
  "status": "form_refilled",
  "screenshot_path": "..."
}
```

---

### 5.2 Listing Management Tools

#### `list_my_listings`

读取用户当前 Marketplace seller listings。

Output:

```json
{
  "listings": [
    {
      "listing_id": "fb_123456",
      "title": "IKEA Desk",
      "price": 40,
      "status": "active",
      "url": "https://facebook.com/marketplace/item/...",
      "last_seen_at": "2026-05-10T19:30:00-05:00"
    }
  ]
}
```

---

#### `get_listing_detail`

Input:

```json
{
  "listing_id": "fb_123456"
}
```

Output:

```json
{
  "listing_id": "fb_123456",
  "title": "IKEA Desk",
  "price": 40,
  "status": "active",
  "description": "...",
  "views": null,
  "messages_count": 3,
  "url": "..."
}
```

---

#### `mark_listing_sold`

Input:

```json
{
  "listing_id": "fb_123456",
  "require_manual_confirmation": true
}
```

Behavior:

- 打开 listing management 页面
- 定位 “mark as sold”
- 默认停在确认前，等待用户手动确认或 Discord 审批

---

### 5.3 Message Monitoring Tools

#### `check_marketplace_messages`

检查 Marketplace/Messenger 新消息。

Input:

```json
{
  "since": "last_check",
  "include_read": false
}
```

Output:

```json
{
  "new_messages": [
    {
      "thread_id": "thread_abc",
      "listing_id": "fb_123456",
      "buyer_name": "John",
      "message": "Is this still available?",
      "received_at": "2026-05-10T19:32:00-05:00",
      "requires_response": true
    }
  ]
}
```

---

#### `get_message_thread`

Input:

```json
{
  "thread_id": "thread_abc"
}
```

Output:

```json
{
  "thread_id": "thread_abc",
  "listing_id": "fb_123456",
  "buyer_name": "John",
  "messages": [
    {
      "role": "buyer",
      "text": "Is this still available?",
      "timestamp": "..."
    },
    {
      "role": "seller",
      "text": "Yes, it is still available.",
      "timestamp": "..."
    }
  ]
}
```

---

### 5.4 Reply Tools

#### `draft_reply`

由 Hermes 或 MCP 生成回复草稿。

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

Output:

```json
{
  "reply_draft": "Yes, it’s still available. Pickup is near UMN. I can do $40, or $35 if you can pick it up today.",
  "risk_level": "low",
  "requires_human_approval": true
}
```

---

#### `send_reply`

发送经过用户确认的消息。

Input:

```json
{
  "thread_id": "thread_abc",
  "message": "Yes, it’s still available. Pickup is near UMN.",
  "approval_token": "discord_confirmed_..."
}
```

Output:

```json
{
  "status": "sent",
  "sent_at": "2026-05-10T19:35:00-05:00"
}
```

Rules:

- 没有 approval token 时拒绝发送
- 高风险内容必须人工确认
- 发送前可截图回传

---

## 6. Discord Workflow

### 6.1 Create Listing Flow

```text
User:
  帮我上架这个 desk，$40，pickup only

Hermes:
  生成 listing draft
  调用 create_listing_draft
  调用 fill_listing_form

MCP:
  打开 Facebook
  填写表单
  截图

Hermes:
  发截图到 Discord
  “已经填好，停在发布前。请你手动点击 Publish，或回复：重新生成/改价格/取消。”
```

---

### 6.2 Message Push Flow

Recommended first implementation: Hermes cron polling.

```text
Every 1–3 minutes:
  Hermes cron calls check_marketplace_messages
  If new messages:
    Hermes sends Discord notification
```

Example Discord output:

```text
📩 Facebook Marketplace 新消息

Listing: IKEA Desk — $40
Buyer: John

Message:
“Is this still available?”

建议回复：
“Yes, it’s still available. Pickup is near UMN.”

回复：
- 发送
- 改成 ...
- 不回复
```

---

### 6.3 Human Approval Reply Flow

```text
User:
  发送

Hermes:
  调用 send_reply with approval token

MCP:
  打开 thread
  填写消息
  点击发送
  返回 sent 状态
```

---

## 7. Risk Levels

### Low Risk

可以生成草稿，但仍建议确认：

- 是否还在
- pickup only
- 大致位置
- 商品尺寸
- 商品状态

### Medium Risk

必须人工确认：

- 价格谈判
- hold item
- delivery
- meeting time
- phone number
- address details

### High Risk

默认拒绝自动发送，只生成建议：

- 收款方式
- 押金
- Zelle/Venmo/Cash App
- 具体住址
- 争执性内容
- 可能违反 Facebook policy 的内容

---

## 8. Data Model

### 8.1 Draft

```json
{
  "draft_id": "draft_20260510_001",
  "title": "IKEA Desk",
  "price": 40,
  "category": "Furniture",
  "condition": "Good",
  "description": "...",
  "location": "Minneapolis, MN",
  "photos": [],
  "created_at": "...",
  "updated_at": "...",
  "status": "local_draft"
}
```

### 8.2 Listing

```json
{
  "listing_id": "fb_123456",
  "draft_id": "draft_20260510_001",
  "title": "IKEA Desk",
  "price": 40,
  "status": "active",
  "url": "...",
  "created_at": "...",
  "last_seen_at": "..."
}
```

### 8.3 Message Thread

```json
{
  "thread_id": "thread_abc",
  "listing_id": "fb_123456",
  "buyer_name": "John",
  "last_message_at": "...",
  "status": "open",
  "messages": []
}
```

---

## 9. Security Requirements

1. Facebook password must never be stored.
2. Facebook cookies/session files must stay local.
3. `~/.hermes/facebook-marketplace/` should be chmod-restricted.
4. Screenshots may contain private messages; avoid posting them outside approved Discord channels.
5. All sent messages should be logged locally.
6. Any destructive action requires confirmation:
   - delete listing
   - mark sold
   - send reply
   - publish listing

---

## 10. Hermes MCP Configuration Example

TypeScript MCP server example:

```yaml
mcp_servers:
  facebook_marketplace:
    command: "node"
    args:
      - "/path/to/facebook-marketplace-assistant-mcp/dist/index.js"
    env:
      FB_CHROME_PROFILE_DIR: "/Users/saber/Library/Application Support/Google/Chrome/Profile 1"
      FB_MARKETPLACE_HOME_LOCATION: "Minneapolis, MN"
    timeout: 180
    connect_timeout: 60
```

Python MCP server example:

```yaml
mcp_servers:
  facebook_marketplace:
    command: "uv"
    args:
      - "--directory"
      - "/path/to/facebook-marketplace-assistant-mcp"
      - "run"
      - "server.py"
    env:
      FB_MARKETPLACE_HOME_LOCATION: "Minneapolis, MN"
    timeout: 180
    connect_timeout: 60
```

---

## 11. Implementation Phases

### Phase 1 — Listing Form Fill MCP

Build first:

- `create_listing_draft`
- `fill_listing_form`
- screenshot return
- manual publish stop

Success criteria:

- User can send item info + photos in Discord.
- Hermes creates a draft.
- MCP opens Facebook and fills the listing form.
- User only needs to manually click Publish.

---

### Phase 2 — Listing Read/Management MCP

Add:

- `list_my_listings`
- `get_listing_detail`
- local listing sync
- basic status tracking

Success criteria:

- Hermes can show current active listings in Discord.
- Listings are matched to local drafts when possible.

---

### Phase 3 — Message Monitoring MCP

Add:

- `check_marketplace_messages`
- `get_message_thread`
- SQLite message memory
- Hermes cron polling

Success criteria:

- New buyer messages appear in Discord within 1–3 minutes.
- Messages are matched to listings.

---

### Phase 4 — Human-Approved Reply MCP

Add:

- `draft_reply`
- `send_reply`
- approval token
- risk classification

Success criteria:

- Hermes suggests replies.
- User confirms in Discord.
- MCP sends approved message through Facebook Messenger Web UI.

---

## 12. Open Questions

1. Facebook account should use existing Chrome profile or a dedicated automation Chrome profile?
2. Target environment is macOS only first, or should support Windows/Linux?
3. Should Discord approval happen by plain text command or buttons/reactions if platform supports it?
4. Should photos be copied into MCP storage or referenced by original path?
5. Should Hermes generate pricing recommendations using marketplace search data?
6. Should we integrate Google Sheets / Notion as inventory source later?

---

## 13. Recommended Initial Build

Start with the safest useful slice:

```text
Discord item intake
→ Hermes listing copy generation
→ MCP local draft save
→ Playwright Facebook form fill
→ screenshot back to Discord
→ user manually clicks Publish
```

This gives the highest value while keeping account risk lowest.
