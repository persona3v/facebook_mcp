import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  MarketplaceMessageNotification,
  MarketplaceMessageRecord,
  MessageThreadRecord,
  RuntimeConfig
} from "./types.js";
import { ensureStorage } from "./storage.js";

const LAST_CHECK_KEY = "last_check_marketplace_messages_at";

export async function ensureMessageStore(config: RuntimeConfig): Promise<void> {
  await ensureStorage(config);
  const db = await openMessageDb(config);
  db.close();
}

export async function syncMessageThreads(
  config: RuntimeConfig,
  threads: Array<MessageThreadRecord & { messages: MarketplaceMessageRecord[] }>,
  options: { since: string; includeRead: boolean }
): Promise<{ newMessages: MarketplaceMessageNotification[]; checkedAt: string }> {
  const db = await openMessageDb(config);
  const checkedAt = new Date().toISOString();
  const sinceAt = resolveSince(db, options.since);
  const newMessages: MarketplaceMessageNotification[] = [];

  const upsertThread = db.prepare(`
    INSERT INTO message_threads (
      thread_id, listing_id, buyer_name, listing_title, status, url,
      last_message_at, first_seen_at, last_seen_at, raw_text
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      listing_id = COALESCE(excluded.listing_id, message_threads.listing_id),
      buyer_name = excluded.buyer_name,
      listing_title = COALESCE(excluded.listing_title, message_threads.listing_title),
      status = excluded.status,
      url = excluded.url,
      last_message_at = excluded.last_message_at,
      last_seen_at = excluded.last_seen_at,
      raw_text = COALESCE(excluded.raw_text, message_threads.raw_text)
  `);
  const existingMessage = db.prepare("SELECT message_id FROM messages WHERE message_id = ?");
  const insertMessage = db.prepare(`
    INSERT INTO messages (
      message_id, thread_id, listing_id, buyer_name, role, text, timestamp,
      first_seen_at, seen_at, requires_response, raw_text
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      seen_at = excluded.seen_at,
      listing_id = COALESCE(excluded.listing_id, messages.listing_id),
      buyer_name = excluded.buyer_name
  `);

  db.exec("BEGIN");
  try {
    for (const thread of threads) {
      upsertThread.run(
        thread.thread_id,
        thread.listing_id,
        thread.buyer_name,
        thread.listing_title,
        thread.status,
        thread.url,
        thread.last_message_at,
        thread.first_seen_at,
        thread.last_seen_at,
        thread.raw_text ?? null
      );

      for (const message of thread.messages) {
        const alreadySeen = existingMessage.get(message.message_id) !== undefined;
        insertMessage.run(
          message.message_id,
          message.thread_id,
          message.listing_id,
          message.buyer_name,
          message.role,
          message.text,
          message.timestamp,
          message.first_seen_at,
          message.seen_at,
          message.requires_response ? 1 : 0,
          message.raw_text ?? null
        );

        if (isNewMessageForPoll(message, alreadySeen, sinceAt, options.includeRead)) {
          newMessages.push({
            thread_id: message.thread_id,
            listing_id: message.listing_id,
            buyer_name: message.buyer_name,
            message: message.text,
            received_at: message.timestamp,
            requires_response: message.requires_response
          });
        }
      }
    }

    setMetadata(db, LAST_CHECK_KEY, checkedAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }

  db.close();
  return { newMessages, checkedAt };
}

export async function findMessageThread(
  config: RuntimeConfig,
  threadId: string
): Promise<MessageThreadRecord | undefined> {
  const db = await openMessageDb(config);
  const row = db.prepare("SELECT * FROM message_threads WHERE thread_id = ?").get(threadId);
  db.close();
  return row ? rowToThread(row as unknown as MessageThreadRow) : undefined;
}

export async function loadMessageThread(
  config: RuntimeConfig,
  threadId: string
): Promise<
  | {
      thread: MessageThreadRecord;
      messages: MarketplaceMessageRecord[];
    }
  | undefined
> {
  const db = await openMessageDb(config);
  const threadRow = db
    .prepare("SELECT * FROM message_threads WHERE thread_id = ?")
    .get(threadId);
  if (!threadRow) {
    db.close();
    return undefined;
  }

  const messageRows = db
    .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY timestamp ASC, first_seen_at ASC")
    .all(threadId);
  db.close();
  return {
    thread: rowToThread(threadRow as unknown as MessageThreadRow),
    messages: messageRows.map((row) => rowToMessage(row as unknown as MessageRow))
  };
}

export async function upsertMessageThread(
  config: RuntimeConfig,
  thread: MessageThreadRecord,
  messages: MarketplaceMessageRecord[]
): Promise<void> {
  await syncMessageThreads(config, [{ ...thread, messages }], {
    since: "1970-01-01T00:00:00.000Z",
    includeRead: true
  });
}

export async function recordSentReply(
  config: RuntimeConfig,
  details: {
    thread: MessageThreadRecord;
    message: string;
    sentAt: string;
    approvalToken: string;
    riskLevel: string;
  }
): Promise<MarketplaceMessageRecord> {
  const db = await openMessageDb(config);
  const message: MarketplaceMessageRecord = {
    message_id: makeMessageId([
      details.thread.thread_id,
      "seller",
      details.message,
      details.sentAt
    ]),
    thread_id: details.thread.thread_id,
    listing_id: details.thread.listing_id,
    buyer_name: details.thread.buyer_name,
    role: "seller",
    text: details.message,
    timestamp: details.sentAt,
    first_seen_at: details.sentAt,
    seen_at: details.sentAt,
    requires_response: false,
    raw_text: details.message
  };

  const approvalTokenHash = createHash("sha256")
    .update(details.approvalToken)
    .digest("hex");

  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO message_threads (
        thread_id, listing_id, buyer_name, listing_title, status, url,
        last_message_at, first_seen_at, last_seen_at, raw_text
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        listing_id = COALESCE(excluded.listing_id, message_threads.listing_id),
        buyer_name = excluded.buyer_name,
        listing_title = COALESCE(excluded.listing_title, message_threads.listing_title),
        status = excluded.status,
        url = excluded.url,
        last_message_at = excluded.last_message_at,
        last_seen_at = excluded.last_seen_at
    `).run(
      details.thread.thread_id,
      details.thread.listing_id,
      details.thread.buyer_name,
      details.thread.listing_title,
      details.thread.status,
      details.thread.url,
      details.sentAt,
      details.thread.first_seen_at,
      details.sentAt,
      details.thread.raw_text ?? null
    );

    db.prepare(`
      INSERT INTO messages (
        message_id, thread_id, listing_id, buyer_name, role, text, timestamp,
        first_seen_at, seen_at, requires_response, raw_text
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        seen_at = excluded.seen_at,
        raw_text = excluded.raw_text
    `).run(
      message.message_id,
      message.thread_id,
      message.listing_id,
      message.buyer_name,
      message.role,
      message.text,
      message.timestamp,
      message.first_seen_at,
      message.seen_at,
      0,
      message.raw_text ?? null
    );

    db.prepare(`
      INSERT INTO sent_replies (
        sent_reply_id, thread_id, listing_id, buyer_name, message,
        sent_at, approval_token_hash, risk_level
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `sent_${message.message_id.slice(4)}`,
      details.thread.thread_id,
      details.thread.listing_id,
      details.thread.buyer_name,
      details.message,
      details.sentAt,
      approvalTokenHash,
      details.riskLevel
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }

  db.close();
  return message;
}

export function makeMessageId(parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 24);
  return `msg_${digest}`;
}

async function openMessageDb(config: RuntimeConfig): Promise<DatabaseSync> {
  await ensureStorage(config);
  const db = new DatabaseSync(config.messagesDbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_threads (
      thread_id TEXT PRIMARY KEY,
      listing_id TEXT,
      buyer_name TEXT NOT NULL,
      listing_title TEXT,
      status TEXT NOT NULL,
      url TEXT NOT NULL,
      last_message_at TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      raw_text TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      listing_id TEXT,
      buyer_name TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      requires_response INTEGER NOT NULL,
      raw_text TEXT,
      FOREIGN KEY(thread_id) REFERENCES message_threads(thread_id)
    );

    CREATE INDEX IF NOT EXISTS messages_thread_timestamp_idx
      ON messages(thread_id, timestamp);

    CREATE TABLE IF NOT EXISTS sent_replies (
      sent_reply_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      listing_id TEXT,
      buyer_name TEXT NOT NULL,
      message TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      approval_token_hash TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES message_threads(thread_id)
    );

    CREATE INDEX IF NOT EXISTS sent_replies_thread_sent_at_idx
      ON sent_replies(thread_id, sent_at);
  `);
  await fs.chmod(config.messagesDbPath, 0o600).catch(() => undefined);
  return db;
}

function resolveSince(db: DatabaseSync, since: string): string | undefined {
  if (since === "last_check") {
    return getMetadata(db, LAST_CHECK_KEY);
  }

  const parsed = new Date(since);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function isNewMessageForPoll(
  message: MarketplaceMessageRecord,
  alreadySeen: boolean,
  sinceAt: string | undefined,
  includeRead: boolean
): boolean {
  if (message.role !== "buyer") {
    return false;
  }

  if (!includeRead && !message.requires_response) {
    return false;
  }

  if (alreadySeen) {
    return false;
  }

  if (!sinceAt) {
    return true;
  }

  return message.timestamp > sinceAt || message.first_seen_at > sinceAt;
}

function getMetadata(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setMetadata(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`
    INSERT INTO metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function rowToThread(row: MessageThreadRow): MessageThreadRecord {
  return {
    thread_id: row.thread_id,
    listing_id: row.listing_id,
    buyer_name: row.buyer_name,
    listing_title: row.listing_title,
    status: row.status as MessageThreadRecord["status"],
    url: row.url,
    last_message_at: row.last_message_at,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    raw_text: row.raw_text ?? undefined
  };
}

function rowToMessage(row: MessageRow): MarketplaceMessageRecord {
  return {
    message_id: row.message_id,
    thread_id: row.thread_id,
    listing_id: row.listing_id,
    buyer_name: row.buyer_name,
    role: row.role as MarketplaceMessageRecord["role"],
    text: row.text,
    timestamp: row.timestamp,
    first_seen_at: row.first_seen_at,
    seen_at: row.seen_at,
    requires_response: row.requires_response === 1,
    raw_text: row.raw_text ?? undefined
  };
}

interface MessageThreadRow {
  thread_id: string;
  listing_id: string | null;
  buyer_name: string;
  listing_title: string | null;
  status: string;
  url: string;
  last_message_at: string;
  first_seen_at: string;
  last_seen_at: string;
  raw_text: string | null;
}

interface MessageRow {
  message_id: string;
  thread_id: string;
  listing_id: string | null;
  buyer_name: string;
  role: string;
  text: string;
  timestamp: string;
  first_seen_at: string;
  seen_at: string;
  requires_response: number;
  raw_text: string | null;
}
