Always ask before delete any file or folder.
Always back up configuration file before change it.

For Facebook Marketplace message and reply work:

- Do not create one-off `tmp_*.cjs`, `*_tmp.cjs`, or JSON probe files in this repository to inspect Facebook UI or send replies.
- Use the MCP tools first: `check_marketplace_messages`, `get_message_thread`, `draft_reply`, and `send_reply`.
- If the MCP tools cannot find a thread or selector, report the tool failure and ask before writing any exploratory script.
- If the user explicitly approves an exploratory script, write it outside the repository, preferably under `/tmp`, and do not commit private buyer/message data.
- Never bypass the MCP safety boundaries: no Facebook password storage, no automatic Publish without a human approval token, no automatic buyer reply without a human approval token.
- Publishing is opt-in and gated, never the default. A tool may click Publish only when the caller both sets `stop_before_publish=false` and supplies an approval token, and `broadcast_listing_draft` must additionally name its target accounts rather than fanning out to every configured profile. Do not add a code path that publishes on any weaker condition.
