import { createHash } from "node:crypto";
import type { ListingRecord, ListingStatus, MessageRole } from "./types.js";

const VISIBLE_THREAD_URL_PREFIX = "marketplace-visible-thread:";

export function makeMessageId(parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 24);
  return `msg_${digest}`;
}

export function normalizeFacebookUrl(rawUrl: string): string {
  const url = new URL(rawUrl, "https://www.facebook.com");
  return `${url.origin}${url.pathname}`;
}

export function visibleThreadUrlFromText(text: string): string {
  return `${VISIBLE_THREAD_URL_PREFIX}${encodeURIComponent(cleanMessageText(text).slice(0, 800))}`;
}

export function visibleThreadTextFromUrl(url: string): string {
  if (!isVisibleThreadUrl(url)) {
    return "";
  }

  try {
    return decodeURIComponent(url.slice(VISIBLE_THREAD_URL_PREFIX.length));
  } catch {
    return "";
  }
}

export function isVisibleThreadUrl(url: string): boolean {
  return url.startsWith(VISIBLE_THREAD_URL_PREFIX);
}

export function listingIdFromUrl(url: string): string | null {
  const match = url.match(/\/marketplace\/item\/(\d+)/i);
  return match ? `fb_${match[1]}` : null;
}

export function threadIdFromUrl(url: string): string | null {
  const decodedUrl = decodeURIComponent(url);
  const pathMatch = decodedUrl.match(/\/messages\/t\/([^/?#]+)/i);
  if (pathMatch) {
    return `thread_${sanitizeId(pathMatch[1])}`;
  }

  const tidMatch = decodedUrl.match(/[?&](?:tid|thread_id)=([^&#]+)/i);
  if (tidMatch) {
    return `thread_${sanitizeId(tidMatch[1])}`;
  }

  const inboxMatch = decodedUrl.match(/\/marketplace\/inbox\/([^/?#]+)/i);
  if (inboxMatch) {
    return `thread_${sanitizeId(inboxMatch[1])}`;
  }

  return null;
}

export function normalizeThreadId(input: string): string {
  const fromUrl = threadIdFromUrl(input);
  if (fromUrl) {
    return fromUrl;
  }
  if (input.startsWith("thread_")) {
    return input;
  }
  return `thread_${sanitizeId(input)}`;
}

export function threadUrlFromInput(input: string): string {
  if (/^https?:\/\//i.test(input) || input.startsWith("data:") || isVisibleThreadUrl(input)) {
    return input;
  }

  throw new Error(
    `Unknown thread_id ${input}. Run check_marketplace_messages first or pass a Messenger thread URL.`
  );
}

export function makeVisibleThreadId(
  parsed: ReturnType<typeof parseThreadPreview>,
  rawText: string
): string {
  const stableParts =
    parsed.buyerName !== "Unknown buyer" && parsed.listing
      ? ["thread_visible", parsed.buyerName, parsed.listing.listing_id]
      : ["thread_visible", rawText];
  return makeMessageId(stableParts).replace(/^msg_/, "thread_");
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-z0-9_.:-]+/gi, "_").replace(/^_+|_+$/g, "");
}

export function detailUrlFromListingId(listingId: string): string {
  const match = listingId.match(/^fb_(\d+)$/);
  if (!match) {
    throw new Error(
      `Unknown listing_id ${listingId}. Run list_my_listings first or pass a Facebook Marketplace item URL.`
    );
  }
  return `https://www.facebook.com/marketplace/item/${match[1]}`;
}

export function splitTextLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function looksLikeMarketplaceThreadPreview(
  text: string,
  listings: ListingRecord[]
): boolean {
  const cleaned = cleanMessageText(text);
  if (cleaned.length < 20 || cleaned.length > 1200) {
    return false;
  }

  if (/^(facebook|home|friends|groups|marketplace|messages|notifications|new message)$/i.test(cleaned)) {
    return false;
  }

  if (findListingInText(cleaned, listings)) {
    return true;
  }

  return (
    cleaned.includes(" · ") &&
    /\b(\d{1,2}:\d{2}\s*(?:AM|PM)|\d+\s*(?:m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)|just now|yesterday|today)\b/i.test(
      cleaned
    )
  );
}

export function parseThreadPreview(
  text: string,
  listings: ListingRecord[],
  now: string
): {
  buyerName: string;
  listing: ListingRecord | undefined;
  lastMessageText: string;
  lastMessageRole: MessageRole;
  lastMessageAt: string;
} {
  const compact = parseCompactThreadPreview(text, listings, now);
  if (compact) {
    return compact;
  }

  const lines = splitTextLines(text);
  const listing = findListingInText(text, listings);
  const timestamp = parseMessageTimestamp(text, now);
  const messageLine = [...lines]
    .reverse()
    .find((line) => isLikelyMessageLine(line, listing?.title));
  const buyerLine = lines.find(
    (line) =>
      line !== listing?.title &&
      line !== messageLine &&
      !isTimestampLike(line) &&
      !/^(marketplace|facebook|messenger|you sent|active now)$/i.test(line)
  );
  const { role, text: messageText } = parseRolePrefix(messageLine ?? "");

  return {
    buyerName: buyerLine ?? "Unknown buyer",
    listing,
    lastMessageText: messageText,
    lastMessageRole: role,
    lastMessageAt: timestamp
  };
}

function parseCompactThreadPreview(
  text: string,
  listings: ListingRecord[],
  now: string
): ReturnType<typeof parseThreadPreview> | undefined {
  const normalized = cleanMessageText(text);
  const match = normalized.match(/^(.{1,80}?)\s+·\s+(.+)$/);
  if (!match) {
    return undefined;
  }

  const buyerName = match[1].trim();
  const rest = match[2].trim();
  if (!buyerName || /^(marketplace|facebook|messages|notifications)$/i.test(buyerName)) {
    return undefined;
  }

  const listing = findListingInText(rest, listings);
  let lastMessageText = rest;
  if (listing) {
    const listingIndex = rest.toLowerCase().indexOf(listing.title.toLowerCase());
    if (listingIndex >= 0) {
      lastMessageText = rest.slice(listingIndex + listing.title.length);
    }
  }

  lastMessageText = stripTrailingMessageTimestamp(lastMessageText);

  return {
    buyerName,
    listing,
    lastMessageText,
    lastMessageRole: lastMessageText ? "buyer" : "unknown",
    lastMessageAt: parseMessageTimestamp(normalized, now)
  };
}

function findListingInText(
  text: string,
  listings: ListingRecord[]
): ListingRecord | undefined {
  const lowerText = text.toLowerCase();
  return listings.find((candidate) => lowerText.includes(candidate.title.toLowerCase()));
}

export function parseStructuredOrTextMessages(
  structuredMessages: Array<{ role: string; timestamp: string; text: string }>,
  bodyText: string,
  buyerName: string,
  now: string
): Array<{ role: MessageRole; text: string; timestamp: string }> {
  const structured = structuredMessages
    .map((message) => ({
      role: normalizeMessageRole(message.role),
      text: cleanMessageText(message.text),
      timestamp: normalizeTimestamp(message.timestamp, now)
    }))
    .filter((message) => message.text.length > 0);

  if (structured.length > 0) {
    return structured;
  }

  return splitTextLines(bodyText)
    .map((line) => {
      const parsed = parseRolePrefix(line, buyerName);
      return {
        role: parsed.role,
        text: parsed.text,
        timestamp: parseMessageTimestamp(line, now)
      };
    })
    .filter(
      (message) =>
        message.text.length > 0 &&
        message.role !== "unknown" &&
        !isTimestampLike(message.text)
    );
}

function parseRolePrefix(
  line: string,
  buyerName = "Unknown buyer"
): { role: MessageRole; text: string } {
  const trimmed = line.trim();
  const match = trimmed.match(/^([^:：]{1,40})[:：]\s*(.+)$/);
  if (!match) {
    return {
      role: "buyer",
      text: cleanMessageText(trimmed)
    };
  }

  const speaker = match[1].trim();
  const text = cleanMessageText(match[2]);
  if (/^(you|me|seller|saber)$/i.test(speaker)) {
    return { role: "seller", text };
  }
  if (speaker.toLowerCase() === buyerName.toLowerCase() || !/^(system|facebook)$/i.test(speaker)) {
    return { role: "buyer", text };
  }
  return { role: "system", text };
}

function normalizeMessageRole(role: string): MessageRole {
  if (/^(seller|you|me)$/i.test(role)) {
    return "seller";
  }
  if (/^buyer$/i.test(role)) {
    return "buyer";
  }
  if (/^system$/i.test(role)) {
    return "system";
  }
  return "unknown";
}

export function cleanMessageText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripTrailingMessageTimestamp(text: string): string {
  return cleanMessageText(text)
    .replace(/\b\d{1,2}:\d{2}\s*(?:AM|PM)\s*$/i, "")
    .replace(
      /\b(?:\d+\s*(?:m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)\s*(?:ago)?|just now|now|today|yesterday)\s*$/i,
      ""
    )
    .trim();
}

function isLikelyMessageLine(line: string, listingTitle: string | undefined): boolean {
  if (!line || line === listingTitle || isTimestampLike(line)) {
    return false;
  }
  return (
    /[?？.!。]$/.test(line) ||
    /^(you|me|seller|buyer|[^:：]{1,40})[:：]\s+/.test(line) ||
    line.split(/\s+/).length >= 3
  );
}

function parseMessageTimestamp(text: string, now: string): string {
  const isoMatch = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})?/);
  if (isoMatch) {
    return normalizeTimestamp(isoMatch[0], now);
  }

  const relativeMatch = text.match(/\b(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)\b/i);
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();
    const date = new Date(now);
    if (unit.startsWith("m")) {
      date.setMinutes(date.getMinutes() - amount);
    } else if (unit.startsWith("h")) {
      date.setHours(date.getHours() - amount);
    } else {
      date.setDate(date.getDate() - amount);
    }
    return date.toISOString();
  }

  const clockMatch = text.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
  if (clockMatch) {
    const date = new Date(now);
    let hours = Number(clockMatch[1]);
    const minutes = Number(clockMatch[2]);
    const meridiem = clockMatch[3].toUpperCase();
    if (meridiem === "PM" && hours < 12) {
      hours += 12;
    }
    if (meridiem === "AM" && hours === 12) {
      hours = 0;
    }
    date.setHours(hours, minutes, 0, 0);
    const nowDate = new Date(now);
    if (date.getTime() - nowDate.getTime() > 60 * 60 * 1000) {
      date.setDate(date.getDate() - 1);
    }
    return date.toISOString();
  }

  if (/\b(just now|now)\b/i.test(text)) {
    return now;
  }

  return now;
}

function normalizeTimestamp(value: string, fallback: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function isTimestampLike(line: string): boolean {
  return (
    /\d{4}-\d{2}-\d{2}T/.test(line) ||
    /\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i.test(line) ||
    /\b(\d+\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)|now|just now)\b/i.test(line)
  );
}

export function cleanThreadTitle(value: string): string | null {
  const cleaned = cleanTitle(value);
  return cleaned.length > 0 ? cleaned : null;
}

export function pickListingTitle(lines: string[]): string {
  const titleLine = lines.find(
    (line) =>
      !/^\$?\s*\d/.test(line) &&
      !/^(active|sold|pending|available|boost|views?|messages?)$/i.test(line)
  );

  return cleanTitle(titleLine ?? "Untitled listing");
}

export function cleanTitle(value: string): string {
  return value
    .replace(/\s*\|\s*Facebook Marketplace\s*$/i, "")
    .replace(/\s*\|\s*Facebook\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parsePrice(text: string): number | null {
  const match = text.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseStatus(text: string): ListingStatus {
  if (/\bsold\b/i.test(text)) {
    return "sold";
  }
  if (/\bpending\b/i.test(text)) {
    return "pending";
  }
  if (/\b(active|available)\b/i.test(text)) {
    return "active";
  }
  return "unknown";
}

export function parseDescription(
  ogDescription: string,
  bodyText: string
): string | null {
  const cleanedOgDescription = cleanDescription(ogDescription);
  if (cleanedOgDescription) {
    return cleanedOgDescription;
  }

  const lines = splitTextLines(bodyText);
  const start = lines.findIndex((line) =>
    /^(seller'?s description|description)$/i.test(line)
  );
  if (start === -1) {
    return null;
  }

  const collected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^(seller information|details|location|meetup preferences|send seller a message)$/i.test(line)) {
      break;
    }
    collected.push(line);
  }

  return cleanDescription(collected.join("\n"));
}

function cleanDescription(value: string): string | null {
  const cleaned = value
    .replace(/\s+/g, " ")
    .replace(/\s*\|\s*Facebook Marketplace\s*$/i, "")
    .replace(/\s*\|\s*Facebook\s*$/i, "")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function parseLabeledCount(text: string, labelPattern: string): number | null {
  const match = text.match(new RegExp(`(\\d[\\d,]*)\\s+${labelPattern}`, "i"));
  if (!match) {
    return null;
  }
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeReplyMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    throw new Error("send_reply requires a non-empty message.");
  }
  return trimmed;
}

export function normalizeApprovalToken(
  approvalToken: string,
  requester = "send_reply"
): string {
  const trimmed = approvalToken.trim();
  if (
    trimmed.length < 8 ||
    /^(none|null|false|auto|automatic|test|placeholder)$/i.test(trimmed)
  ) {
    throw new Error(`${requester} requires a real human approval token.`);
  }
  return trimmed;
}
