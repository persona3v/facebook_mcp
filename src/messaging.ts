import type { Locator, Page } from "playwright";
import type {
  BrowserConnectionOptions,
  CheckMarketplaceMessagesResult,
  DraftReplyResult,
  GetMessageThreadResult,
  ListingRecord,
  MarketplaceMessageRecord,
  MessageThreadRecord,
  ReplyConstraints,
  RuntimeConfig,
  SendReplyResult
} from "./types.js";
import { loadInventory } from "./storage.js";
import {
  findMessageThread,
  loadMessageThread,
  recordSentReply,
  syncMessageThreads,
  upsertMessageThread
} from "./messageStore.js";
import { classifyReplyRisk, draftReply } from "./reply.js";
import { getOrLaunchContext, getWorkingPage } from "./browser.js";
import {
  FIELD_TIMEOUT_MS,
  SHORT_TIMEOUT_MS,
  captureScreenshot,
  firstUsableLocator,
  scrollPage,
  waitForAnyVisible,
  waitForPageReady
} from "./pageUtils.js";
import {
  COMPOSER_SELECTORS,
  MESSAGE_INBOX_ANCHORS,
  MESSAGE_THREAD_ANCHORS,
  THREAD_LINK_SELECTOR
} from "./selectors.js";
import {
  cleanMessageText,
  cleanThreadTitle,
  isVisibleThreadUrl,
  listingIdFromUrl,
  looksLikeMarketplaceThreadPreview,
  makeMessageId,
  makeVisibleThreadId,
  normalizeApprovalToken,
  normalizeFacebookUrl,
  normalizeReplyMessage,
  normalizeThreadId,
  parseStructuredOrTextMessages,
  parseThreadPreview,
  threadIdFromUrl,
  threadUrlFromInput,
  visibleThreadTextFromUrl,
  visibleThreadUrlFromText
} from "./parse.js";

const SEND_VERIFY_TIMEOUT_MS = 5000;

export async function checkMarketplaceMessages(
  config: RuntimeConfig,
  options: {
    since: string;
    includeRead: boolean;
    maxThreads: number;
    maxScrolls: number;
  } & BrowserConnectionOptions
): Promise<CheckMarketplaceMessagesResult> {
  const context = await getOrLaunchContext(config, options);
  const notes: string[] = [];
  const page = await getWorkingPage(context);

  await page.goto(config.marketplaceMessagesUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await waitForPageReady(page, MESSAGE_INBOX_ANCHORS, "Marketplace inbox", notes);

  await scrollPage(page, options.maxScrolls);

  const inventory = await loadInventory(config);
  const scrapedThreads = await scrapeVisibleMessageThreads(
    page,
    inventory.listings,
    options.maxThreads
  );

  if (scrapedThreads.length === 0) {
    notes.push("No visible Marketplace/Messenger thread rows were found.");
  }

  const { newMessages, checkedAt } = await syncMessageThreads(config, scrapedThreads, {
    since: options.since,
    includeRead: options.includeRead
  });
  const screenshotPath = await captureScreenshot(config, page, "marketplace_messages");

  return {
    threads: scrapedThreads.map((thread) => {
      const lastMessage = thread.messages.at(-1);
      return {
        thread_id: thread.thread_id,
        listing_id: thread.listing_id,
        buyer_name: thread.buyer_name,
        listing_title: thread.listing_title,
        last_message: lastMessage?.text ?? null,
        last_message_at: thread.last_message_at,
        requires_response: lastMessage?.requires_response ?? false
      };
    }),
    new_messages: newMessages,
    checked_at: checkedAt,
    screenshot_path: screenshotPath,
    browser_state: "marketplace_messages_screen",
    notes
  };
}

export async function getMessageThread(
  config: RuntimeConfig,
  threadId: string,
  browserOptions?: BrowserConnectionOptions
): Promise<GetMessageThreadResult> {
  const context = await getOrLaunchContext(config, browserOptions);
  const notes: string[] = [];
  const knownThread = await findMessageThread(config, threadId);
  const resolvedThreadId = knownThread?.thread_id ?? normalizeThreadId(threadId);
  const url = knownThread?.url ?? threadUrlFromInput(threadId);
  const page = await getWorkingPage(context);

  await openMessageThreadPage(config, page, url, knownThread ?? undefined, notes);

  const inventory = await loadInventory(config);
  const scraped = await scrapeMessageThreadPage(
    page,
    inventory.listings,
    knownThread ?? undefined,
    resolvedThreadId,
    url
  );
  await upsertMessageThread(config, scraped.thread, scraped.messages);
  const saved = await loadMessageThread(config, scraped.thread.thread_id);
  const screenshotPath = await captureScreenshot(config, page, scraped.thread.thread_id);

  if (!saved) {
    throw new Error(`Message thread ${scraped.thread.thread_id} was not saved.`);
  }

  return {
    thread_id: saved.thread.thread_id,
    listing_id: saved.thread.listing_id,
    buyer_name: saved.thread.buyer_name,
    messages: saved.messages.map((message) => ({
      role: message.role,
      text: message.text,
      timestamp: message.timestamp
    })),
    screenshot_path: screenshotPath,
    browser_state: "message_thread_screen",
    notes
  };
}

export async function draftReplyForThread(
  config: RuntimeConfig,
  input: {
    threadId: string;
    intent: string;
    constraints: ReplyConstraints;
  }
): Promise<DraftReplyResult> {
  const resolvedThreadId = normalizeThreadId(input.threadId);
  const saved = await loadMessageThread(config, resolvedThreadId);
  if (!saved) {
    throw new Error(
      `Message thread ${input.threadId} is not saved. Run check_marketplace_messages or get_message_thread first.`
    );
  }

  const replyDraft = draftReply({
    thread: saved.thread,
    messages: saved.messages,
    intent: input.intent,
    constraints: input.constraints
  });
  const risk = classifyReplyRisk(replyDraft, input.constraints);
  const notes: string[] = [];
  if (saved.messages.length === 0) {
    notes.push("No saved messages were found for this thread; generated a generic reply.");
  }

  return {
    thread_id: saved.thread.thread_id,
    listing_id: saved.thread.listing_id,
    buyer_name: saved.thread.buyer_name,
    reply_draft: replyDraft,
    risk_level: risk.level,
    requires_human_approval: true,
    risk_reasons: risk.reasons,
    notes
  };
}

export async function sendReply(
  config: RuntimeConfig,
  input: {
    threadId: string;
    message: string;
    approvalToken: string;
  } & BrowserConnectionOptions
): Promise<SendReplyResult> {
  const approvalToken = normalizeApprovalToken(input.approvalToken);
  const message = normalizeReplyMessage(input.message);

  const context = await getOrLaunchContext(config, input);
  const notes: string[] = [];
  const knownThread = await findMessageThread(config, normalizeThreadId(input.threadId));
  const resolvedThreadId = knownThread?.thread_id ?? normalizeThreadId(input.threadId);
  const url = knownThread?.url ?? threadUrlFromInput(input.threadId);
  const page = await getWorkingPage(context);

  await openMessageThreadPage(config, page, url, knownThread ?? undefined, notes);

  const inventory = await loadInventory(config);
  const scraped = await scrapeMessageThreadPage(
    page,
    inventory.listings,
    knownThread ?? undefined,
    resolvedThreadId,
    url
  );
  await upsertMessageThread(config, scraped.thread, scraped.messages);

  const risk = classifyReplyRisk(message);
  const sendMethod = await fillAndSendMessage(page, message);
  notes.push(`Sent reply using ${sendMethod}.`);
  if (risk.level === "high") {
    notes.push("Reply was high risk; sending was allowed only because an approval token was supplied.");
  }

  const sentAt = new Date().toISOString();
  await recordSentReply(config, {
    thread: scraped.thread,
    message,
    sentAt,
    approvalToken,
    riskLevel: risk.level
  });

  const screenshotPath = await captureScreenshot(
    config,
    page,
    `${scraped.thread.thread_id}_sent`
  );

  return {
    status: "sent",
    thread_id: scraped.thread.thread_id,
    listing_id: scraped.thread.listing_id,
    buyer_name: scraped.thread.buyer_name,
    message,
    risk_level: risk.level,
    sent_at: sentAt,
    screenshot_path: screenshotPath,
    browser_state: "message_thread_screen",
    notes
  };
}

async function openMessageThreadPage(
  config: RuntimeConfig,
  page: Page,
  url: string,
  knownThread: MessageThreadRecord | undefined,
  notes: string[]
): Promise<void> {
  if (isVisibleThreadUrl(url)) {
    await page.goto(config.marketplaceMessagesUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await waitForPageReady(page, MESSAGE_INBOX_ANCHORS, "Marketplace inbox", notes);

    const clicked = await clickVisibleMessageThreadRow(page, knownThread, url);
    if (!clicked) {
      throw new Error(
        "Could not find the saved visible Marketplace inbox row. Run check_marketplace_messages again before replying."
      );
    }

    notes.push("Opened saved visible Marketplace inbox row.");
    const composerReady = await waitForAnyVisible(
      page,
      COMPOSER_SELECTORS,
      FIELD_TIMEOUT_MS
    );
    if (!composerReady) {
      notes.push("Message composer did not appear after opening the inbox row.");
    }
    return;
  }

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await waitForPageReady(page, MESSAGE_THREAD_ANCHORS, "message thread", notes);
}

async function clickVisibleMessageThreadRow(
  page: Page,
  knownThread: MessageThreadRecord | undefined,
  url: string
): Promise<boolean> {
  const target = {
    rawText: knownThread?.raw_text ?? visibleThreadTextFromUrl(url),
    buyerName: knownThread?.buyer_name ?? null,
    listingTitle: knownThread?.listing_title ?? null
  };

  return page.evaluate((target) => {
    const normalize = (value: string | null | undefined) =>
      String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const rawText = normalize(target.rawText);
    const buyerName = normalize(target.buyerName);
    const listingTitle = normalize(target.listingTitle);
    const doc = (globalThis as any).document;
    const buttons = Array.from(doc.querySelectorAll('[role="button"]')) as any[];

    const candidates = buttons
      .map((button) => ({
        button,
        text: normalize(button.innerText || button.textContent)
      }))
      .filter((candidate) => candidate.text.length > 0);

    const match =
      candidates.find(
        (candidate) =>
          rawText.length > 0 &&
          (candidate.text === rawText ||
            candidate.text.includes(rawText) ||
            rawText.includes(candidate.text))
      ) ??
      candidates.find((candidate) => {
        if (!buyerName || !candidate.text.startsWith(`${buyerName} ·`)) {
          return false;
        }
        return !listingTitle || candidate.text.includes(listingTitle);
      });

    if (!match) {
      return false;
    }

    match.button.scrollIntoView({ block: "center", inline: "nearest" });
    match.button.click();
    return true;
  }, target);
}

async function fillAndSendMessage(page: Page, message: string): Promise<string> {
  const composer = await findMessageComposer(page);
  const visibleMessageCountBefore = await countVisibleText(page, message);

  await composer.scrollIntoViewIfNeeded({ timeout: FIELD_TIMEOUT_MS }).catch(() => undefined);
  await composer.click({ timeout: FIELD_TIMEOUT_MS });
  await composer.fill(message, { timeout: FIELD_TIMEOUT_MS }).catch(async () => {
    await composer.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await composer.press("Backspace");
    await composer.pressSequentially(message, { delay: 20 });
  });
  await page.waitForTimeout(300);

  await composer.press("Enter");
  await verifySendAccepted(page, composer, message, visibleMessageCountBefore);
  return "composer Enter key";
}

async function findMessageComposer(page: Page): Promise<Locator> {
  const composer = await firstUsableLocator(page, COMPOSER_SELECTORS, FIELD_TIMEOUT_MS);
  if (!composer) {
    throw new Error("Could not find a visible Facebook Messenger message composer.");
  }

  return composer;
}

async function verifySendAccepted(
  page: Page,
  composer: Locator,
  message: string,
  visibleMessageCountBefore: number
): Promise<void> {
  const failureNotice = page
    .getByText(/could not send|failed to send|message not sent|try again/i)
    .first();
  const deadline = Date.now() + SEND_VERIFY_TIMEOUT_MS;

  for (;;) {
    if (await failureNotice.isVisible().catch(() => false)) {
      throw new Error("Facebook did not accept the reply; not recording it as sent.");
    }

    const composerText = await composer.innerText({ timeout: SHORT_TIMEOUT_MS }).catch(() => "");
    const composerCleared = cleanMessageText(composerText).length === 0;
    const visibleMessageAdded =
      (await countVisibleText(page, message)) > visibleMessageCountBefore;
    if (composerCleared || visibleMessageAdded) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error("Could not verify that Facebook accepted the reply; not recording it as sent.");
    }
    await page.waitForTimeout(250);
  }
}

async function countVisibleText(page: Page, text: string): Promise<number> {
  return page.getByText(text, { exact: true }).count().catch(() => 0);
}

async function scrapeVisibleMessageThreads(
  page: Page,
  listings: ListingRecord[],
  maxThreads: number
): Promise<Array<MessageThreadRecord & { messages: MarketplaceMessageRecord[] }>> {
  const rawThreads = await page.evaluate((threadLinkSelector) => {
    const doc = (globalThis as any).document;
    const records: Array<{ href: string | null; text: string }> = [];

    const normalize = (value: string | null | undefined) =>
      String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    for (const anchor of Array.from(doc.querySelectorAll(threadLinkSelector)) as any[]) {
      const href = anchor.href || anchor.getAttribute?.("href") || "";
      let container = anchor;

      for (let depth = 0; depth < 7 && container?.parentElement; depth += 1) {
        const parent = container.parentElement;
        const parentText = String(parent.innerText || parent.textContent || "");
        const threadLinks = parent.querySelectorAll?.(threadLinkSelector);
        if (parentText.length > 20 && threadLinks?.length <= 3) {
          container = parent;
        }
      }

      const text = normalize(container?.innerText || anchor.innerText);
      records.push({ href, text });
    }

    for (const button of Array.from(doc.querySelectorAll('[role="button"]')) as any[]) {
      const text = normalize(button.innerText || button.textContent);
      if (text.length >= 20) {
        records.push({ href: null, text });
      }
    }

    return records;
  }, THREAD_LINK_SELECTOR);

  const now = new Date().toISOString();
  const byThreadId = new Map<string, MessageThreadRecord & { messages: MarketplaceMessageRecord[] }>();

  for (const rawThread of rawThreads) {
    if (!looksLikeMarketplaceThreadPreview(rawThread.text, listings)) {
      continue;
    }

    const parsed = parseThreadPreview(rawThread.text, listings, now);
    const url = rawThread.href
      ? normalizeFacebookUrl(rawThread.href)
      : visibleThreadUrlFromText(rawThread.text);
    const threadId =
      threadIdFromUrl(url) ?? makeVisibleThreadId(parsed, rawThread.text);
    if (byThreadId.has(threadId)) {
      continue;
    }
    const listingId = parsed.listing?.listing_id ?? (rawThread.href ? listingIdFromUrl(url) : null);
    const messageId = makeMessageId([
      threadId,
      parsed.lastMessageRole,
      parsed.lastMessageText,
      parsed.lastMessageAt
    ]);
    const thread: MessageThreadRecord & { messages: MarketplaceMessageRecord[] } = {
      thread_id: threadId,
      listing_id: listingId,
      buyer_name: parsed.buyerName,
      listing_title: parsed.listing?.title ?? null,
      status: "open",
      url,
      last_message_at: parsed.lastMessageAt,
      first_seen_at: now,
      last_seen_at: now,
      raw_text: rawThread.text,
      messages: parsed.lastMessageText
        ? [
            {
              message_id: messageId,
              thread_id: threadId,
              listing_id: listingId,
              buyer_name: parsed.buyerName,
              role: parsed.lastMessageRole,
              text: parsed.lastMessageText,
              timestamp: parsed.lastMessageAt,
              first_seen_at: now,
              seen_at: now,
              requires_response:
                parsed.lastMessageRole === "buyer" && parsed.lastMessageText.length > 0,
              raw_text: rawThread.text
            }
          ]
        : []
    };

    byThreadId.set(threadId, thread);
    if (byThreadId.size >= maxThreads) {
      break;
    }
  }

  return [...byThreadId.values()];
}

async function scrapeMessageThreadPage(
  page: Page,
  listings: ListingRecord[],
  knownThread: MessageThreadRecord | undefined,
  threadId: string,
  url: string
): Promise<{ thread: MessageThreadRecord; messages: MarketplaceMessageRecord[] }> {
  const raw = await page.evaluate(() => {
    const doc = (globalThis as any).document;
    const structuredMessages = Array.from(doc.querySelectorAll("[data-message]")).map(
      (element: any) => ({
        role: String(element.getAttribute("data-role") || ""),
        timestamp: String(element.getAttribute("data-timestamp") || ""),
        text: String(element.innerText || element.textContent || "")
      })
    );

    return {
      title: String(doc.querySelector("h1")?.innerText || doc.title || ""),
      bodyText: String(doc.body?.innerText || ""),
      structuredMessages
    };
  });
  const now = new Date().toISOString();
  const preview = parseThreadPreview(raw.bodyText, listings, now);
  const buyerName =
    knownThread?.buyer_name ??
    preview.buyerName ??
    cleanThreadTitle(raw.title) ??
    "Unknown buyer";
  const listing = preview.listing;
  const parsedMessages = parseStructuredOrTextMessages(
    raw.structuredMessages,
    raw.bodyText,
    buyerName,
    now
  );

  const messages = parsedMessages.map((message) => ({
    message_id: makeMessageId([threadId, message.role, message.text, message.timestamp]),
    thread_id: threadId,
    listing_id: listing?.listing_id ?? knownThread?.listing_id ?? null,
    buyer_name: buyerName,
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
    first_seen_at: now,
    seen_at: now,
    requires_response: message.role === "buyer" && message.text.length > 0,
    raw_text: message.text
  }));

  const lastMessage = messages.at(-1);
  const thread: MessageThreadRecord = {
    thread_id: threadId,
    listing_id: listing?.listing_id ?? knownThread?.listing_id ?? null,
    buyer_name: buyerName,
    listing_title: listing?.title ?? knownThread?.listing_title ?? null,
    status: "open",
    url,
    last_message_at: lastMessage?.timestamp ?? knownThread?.last_message_at ?? now,
    first_seen_at: knownThread?.first_seen_at ?? now,
    last_seen_at: now,
    raw_text: raw.bodyText
  };

  return { thread, messages };
}
