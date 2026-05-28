import path from "node:path";
import { promises as fs } from "node:fs";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import type {
  BrowserConnectionOptions,
  BrowserMode,
  CheckMarketplaceMessagesResult,
  DraftReplyResult,
  FillListingResult,
  GetMessageThreadResult,
  ListingDetailResult,
  ListingRecord,
  ListingStatus,
  ListMyListingsResult,
  ListingDraft,
  MarketplaceMessageRecord,
  MessageRole,
  ReplyConstraints,
  SendReplyResult,
  MessageThreadRecord,
  RuntimeConfig
} from "./types.js";
import {
  findListingRecord,
  loadInventory,
  normalizeListingId,
  syncListingRecords,
  updateDraft,
  upsertListingRecord
} from "./storage.js";
import {
  findMessageThread,
  loadMessageThread,
  makeMessageId,
  recordSentReply,
  syncMessageThreads,
  upsertMessageThread
} from "./messageStore.js";
import { classifyReplyRisk, draftReply } from "./reply.js";

const SHORT_TIMEOUT_MS = 3000;
const FIELD_TIMEOUT_MS = 8000;
const THREAD_LINK_SELECTOR = [
  'a[href*="/messages/t/"]',
  'a[href*="messenger.com/t/"]',
  'a[href*="/marketplace/inbox"]'
].join(", ");
const VISIBLE_THREAD_URL_PREFIX = "marketplace-visible-thread:";
let stealthRegistered = false;

interface BrowserSession {
  mode: BrowserMode;
  cdpUrl?: string;
  context: BrowserContext;
  browser?: Browser;
}

let activeSession: BrowserSession | undefined;

function ensureStealthRegistered(): void {
  if (stealthRegistered) {
    return;
  }
  chromium.use(StealthPlugin());
  stealthRegistered = true;
}

export async function closeBrowserContext(): Promise<void> {
  const session = activeSession;
  activeSession = undefined;
  if (!session) {
    return;
  }
  if (session.mode === "existing_cdp") {
    await session.browser?.close().catch(() => undefined);
    return;
  }
  await session.context.close().catch(() => undefined);
}

export async function fillListingForm(
  config: RuntimeConfig,
  draft: ListingDraft,
  browserOptions?: BrowserConnectionOptions
): Promise<FillListingResult> {
  const context = await getOrLaunchContext(config, browserOptions);
  const notes: string[] = [];

  try {
    const page = await getWorkingPage(context);
    await page.goto(config.marketplaceCreateUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {
      notes.push("Facebook did not reach networkidle; continuing with visible form fields.");
    });

    await uploadPhotos(page, draft.photos, notes);
    await fillSimpleField(page, "title", draft.title, [
      'input[aria-label*="Title" i]',
      'input[placeholder*="Title" i]',
      '[role="textbox"][aria-label*="Title" i]'
    ]);
    await fillSimpleField(page, "price", String(draft.price), [
      'input[aria-label*="Price" i]',
      'input[placeholder*="Price" i]',
      'input[inputmode="decimal"]',
      'input[type="number"]'
    ]);
    await chooseDropdownValue(page, "category", draft.category, [
      '[aria-label*="Category" i]',
      '[role="combobox"]:has-text("Category")',
      'label:has-text("Category")'
    ], notes);
    await chooseDropdownValue(page, "condition", draft.condition, [
      '[aria-label*="Condition" i]',
      '[role="combobox"]:has-text("Condition")',
      'label:has-text("Condition")'
    ], notes);
    await fillDescription(page, draft.description, notes);
    await fillLocation(page, draft.location || config.defaultLocation, notes);

    const screenshotPath = await makeScreenshotPath(config, draft.draft_id);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    draft.status = "form_filled";
    draft.updated_at = new Date().toISOString();
    await updateDraft(config, draft);

    return {
      status: "ready_for_manual_publish",
      draft_id: draft.draft_id,
      screenshot_path: screenshotPath,
      browser_state: "waiting_on_publish_screen",
      notes
    };
  } catch (error) {
    const page = context.pages().at(-1);
    if (page) {
      const screenshotPath = await makeScreenshotPath(config, `${draft.draft_id}_error`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      notes.push(`Error screenshot saved at ${screenshotPath}`);
    }
    throw error;
  }
}

export async function listMyListings(
  config: RuntimeConfig,
  options: { maxScrolls: number } & BrowserConnectionOptions
): Promise<ListMyListingsResult> {
  const context = await getOrLaunchContext(config, options);
  const notes: string[] = [];
  const page = await getWorkingPage(context);

  await page.goto(config.marketplaceSellingUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {
    notes.push("Facebook did not reach networkidle; scraping visible seller listings.");
  });

  await scrollPage(page, options.maxScrolls);

  const scraped = await scrapeVisibleListingCards(page);
  const now = new Date().toISOString();
  const listingRecords = scraped.map((listing) => ({
    listing_id: listing.listing_id,
    draft_id: null,
    title: listing.title,
    price: listing.price,
    status: listing.status,
    url: listing.url,
    description: null,
    views: null,
    messages_count: null,
    first_seen_at: now,
    last_seen_at: now,
    updated_at: now,
    raw_text: listing.raw_text
  }));

  const syncedListings = await syncListingRecords(config, listingRecords);
  if (syncedListings.length === 0) {
    notes.push("No Marketplace item links were found on the seller listings page.");
  }

  const screenshotPath = await makeScreenshotPath(config, "seller_listings");
  await page.screenshot({ path: screenshotPath, fullPage: true });

  return {
    listings: syncedListings,
    synced_at: now,
    screenshot_path: screenshotPath,
    browser_state: "seller_listings_screen",
    notes
  };
}

export async function getListingDetail(
  config: RuntimeConfig,
  listingId: string,
  browserOptions?: BrowserConnectionOptions
): Promise<ListingDetailResult> {
  const context = await getOrLaunchContext(config, browserOptions);
  const notes: string[] = [];
  const knownListing = await findListingRecord(config, listingId);
  const normalizedId = normalizeListingId(listingId);
  const page = await getWorkingPage(context);
  const url = knownListing?.url ?? detailUrlFromListingId(normalizedId);

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {
    notes.push("Facebook did not reach networkidle; scraping visible listing detail.");
  });

  const scraped = await scrapeListingDetailPage(page);
  const now = new Date().toISOString();
  const record: ListingRecord = {
    listing_id: normalizedId,
    draft_id: knownListing?.draft_id ?? null,
    title: scraped.title || knownListing?.title || "Untitled listing",
    price: scraped.price ?? knownListing?.price ?? null,
    status: scraped.status,
    url,
    description: scraped.description ?? knownListing?.description ?? null,
    views: scraped.views ?? knownListing?.views ?? null,
    messages_count: scraped.messages_count ?? knownListing?.messages_count ?? null,
    first_seen_at: knownListing?.first_seen_at ?? now,
    last_seen_at: now,
    updated_at: now,
    raw_text: scraped.raw_text
  };

  const savedRecord = await upsertListingRecord(config, record);
  if (!scraped.description) {
    notes.push("Could not confidently extract a listing description.");
  }

  const screenshotPath = await makeScreenshotPath(config, normalizedId);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  return {
    ...savedRecord,
    screenshot_path: screenshotPath,
    browser_state: "listing_detail_screen",
    notes
  };
}

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

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {
    notes.push("Facebook did not reach networkidle; scraping visible message threads.");
  });

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
  const screenshotPath = await makeScreenshotPath(config, "marketplace_messages");
  await page.screenshot({ path: screenshotPath, fullPage: true });

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
  const screenshotPath = await makeScreenshotPath(config, scraped.thread.thread_id);
  await page.screenshot({ path: screenshotPath, fullPage: true });

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

  const screenshotPath = await makeScreenshotPath(config, `${scraped.thread.thread_id}_sent`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

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

async function getOrLaunchContext(
  config: RuntimeConfig,
  browserOptions?: BrowserConnectionOptions
): Promise<BrowserContext> {
  const mode = browserOptions?.browserMode ?? config.browserMode;
  const cdpUrl = browserOptions?.browserCdpUrl ?? config.browserCdpUrl;
  if (
    activeSession &&
    activeSession.mode === mode &&
    (mode !== "existing_cdp" || activeSession.cdpUrl === cdpUrl)
  ) {
    return activeSession.context;
  }

  await closeBrowserContext();

  if (mode === "existing_cdp") {
    activeSession = await connectExistingBrowserContext(cdpUrl);
    return activeSession.context;
  }

  await fs.mkdir(config.browserUserDataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(config.browserUserDataDir, 0o700).catch(() => undefined);

  if (config.stealth) {
    ensureStealthRegistered();
  }

  const args = config.chromeProfileName
    ? [`--profile-directory=${config.chromeProfileName}`]
    : [];

  const context = (await chromium.launchPersistentContext(config.browserUserDataDir, {
    channel: config.browserChannel,
    headless: config.headless,
    slowMo: config.slowMoMs,
    viewport: { width: 1440, height: 1000 },
    args
  })) as unknown as BrowserContext;
  activeSession = { mode, context };
  context.on("close", () => {
    if (activeSession?.context === context) {
      activeSession = undefined;
    }
  });
  return context;
}

async function connectExistingBrowserContext(cdpUrl: string): Promise<BrowserSession> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not connect to an existing Chrome browser over CDP at ${cdpUrl}. ` +
        "Start Chrome with --remote-debugging-port=9222 and log in to Facebook there, " +
        "or use browser_mode=\"managed_profile\". " +
        `Original error: ${detail}`
    );
  }

  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => undefined);
    throw new Error(
      `Connected to Chrome over CDP at ${cdpUrl}, but no default browser context was available.`
    );
  }

  const session: BrowserSession = {
    mode: "existing_cdp",
    cdpUrl,
    context,
    browser
  };
  browser.on("disconnected", () => {
    if (activeSession?.browser === browser) {
      activeSession = undefined;
    }
  });
  return session;
}

async function getWorkingPage(context: BrowserContext): Promise<Page> {
  const pages = context.pages().filter((page) => !page.isClosed());
  const existing =
    pages.find((page) => {
      try {
        return new URL(page.url()).hostname.endsWith("facebook.com");
      } catch {
        return false;
      }
    }) ?? pages[0];
  if (existing) {
    return existing;
  }
  return context.newPage();
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

    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {
      notes.push("Facebook did not reach networkidle; selecting a visible inbox row.");
    });

    const clicked = await clickVisibleMessageThreadRow(page, knownThread, url);
    if (!clicked) {
      throw new Error(
        "Could not find the saved visible Marketplace inbox row. Run check_marketplace_messages again before replying."
      );
    }

    notes.push("Opened saved visible Marketplace inbox row.");
    await page.waitForTimeout(2500);
    return;
  }

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {
    notes.push("Facebook did not reach networkidle; continuing with visible message thread.");
  });
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

async function uploadPhotos(
  page: Page,
  photos: string[],
  notes: string[]
): Promise<void> {
  if (photos.length === 0) {
    notes.push("No photos supplied.");
    return;
  }

  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: FIELD_TIMEOUT_MS });
  await input.setInputFiles(photos);
  notes.push(`Uploaded ${photos.length} photo(s).`);
}

async function fillSimpleField(
  page: Page,
  fieldName: string,
  value: string,
  selectors: string[]
): Promise<void> {
  const locator = await firstUsableLocator(page, selectors);
  if (!locator) {
    throw new Error(`Could not find Facebook Marketplace ${fieldName} field.`);
  }
  await locator.scrollIntoViewIfNeeded({ timeout: FIELD_TIMEOUT_MS }).catch(() => undefined);
  await locator.fill(value, { timeout: FIELD_TIMEOUT_MS });
}

async function chooseDropdownValue(
  page: Page,
  fieldName: string,
  value: string,
  selectors: string[],
  notes: string[]
): Promise<void> {
  const trigger = await firstUsableLocator(page, selectors);
  if (!trigger) {
    notes.push(`Could not find ${fieldName} dropdown; leaving it for manual review.`);
    return;
  }

  await trigger.scrollIntoViewIfNeeded({ timeout: FIELD_TIMEOUT_MS }).catch(() => undefined);
  await trigger.click({ timeout: FIELD_TIMEOUT_MS });
  await page.keyboard.type(value);
  await page.waitForTimeout(500);

  const exactOption = page.getByText(value, { exact: true }).last();
  if (await exactOption.isVisible({ timeout: SHORT_TIMEOUT_MS }).catch(() => false)) {
    await exactOption.click();
    return;
  }

  await page.keyboard.press("Enter");
  notes.push(`Selected ${fieldName} using keyboard fallback: ${value}`);
}

async function fillDescription(
  page: Page,
  description: string,
  notes: string[]
): Promise<void> {
  const selectors = [
    'textarea[aria-label*="Description" i]',
    'textarea[placeholder*="Description" i]',
    '[role="textbox"][aria-label*="Description" i]',
    '[contenteditable="true"][aria-label*="Description" i]'
  ];
  const locator = await firstUsableLocator(page, selectors);
  if (!locator) {
    notes.push("Could not find description field; leaving it for manual review.");
    return;
  }

  await locator.scrollIntoViewIfNeeded({ timeout: FIELD_TIMEOUT_MS }).catch(() => undefined);
  await locator.fill(description, { timeout: FIELD_TIMEOUT_MS }).catch(async () => {
    await locator.click({ timeout: FIELD_TIMEOUT_MS });
    await page.keyboard.insertText(description);
  });
}

async function fillLocation(
  page: Page,
  location: string | undefined,
  notes: string[]
): Promise<void> {
  if (!location) {
    notes.push("No location supplied.");
    return;
  }

  const locator = await firstUsableLocator(page, [
    'input[aria-label*="Location" i]',
    'input[placeholder*="Location" i]',
    '[role="combobox"][aria-label*="Location" i]'
  ]);

  if (!locator) {
    notes.push("Could not find location field; leaving it for manual review.");
    return;
  }

  await locator.scrollIntoViewIfNeeded({ timeout: FIELD_TIMEOUT_MS }).catch(() => undefined);
  await locator.fill(location, { timeout: FIELD_TIMEOUT_MS });
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter").catch(() => undefined);
}

async function firstUsableLocator(
  page: Page,
  selectors: string[]
): Promise<Locator | undefined> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout: SHORT_TIMEOUT_MS }).catch(() => false)) {
      return locator;
    }
  }
  return undefined;
}

async function fillAndSendMessage(page: Page, message: string): Promise<string> {
  const composer = await findMessageComposer(page);
  const visibleMessageCountBefore = await countVisibleText(page, message);

  await composer.scrollIntoViewIfNeeded({ timeout: FIELD_TIMEOUT_MS }).catch(() => undefined);
  await composer.click({ timeout: FIELD_TIMEOUT_MS });
  await composer.fill(message, { timeout: FIELD_TIMEOUT_MS }).catch(async () => {
    await composer.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await composer.press("Backspace");
    await composer.pressSequentially(message);
  });
  await page.waitForTimeout(500);

  await composer.press("Enter");
  await verifySendAccepted(page, composer, message, visibleMessageCountBefore);
  return "composer Enter key";
}

async function findMessageComposer(page: Page): Promise<Locator> {
  const composer = await firstUsableLocator(page, [
    '[role="textbox"][contenteditable="true"][aria-label*="Message" i]',
    '[role="textbox"][contenteditable="true"][aria-label*="Type a message" i]',
    '[role="textbox"][contenteditable="true"][aria-label*="Reply" i]',
    '[contenteditable="true"][aria-label*="Message" i]',
    '[contenteditable="true"][aria-label*="Type a message" i]',
    '[contenteditable="true"][aria-label*="Reply" i]'
  ]);
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
  await page.waitForTimeout(1000);

  const failureNotice = page
    .locator([
      'text=/could not send/i',
      'text=/failed to send/i',
      'text=/message not sent/i',
      'text=/try again/i'
    ].join(", "))
    .first();
  if (await failureNotice.isVisible({ timeout: SHORT_TIMEOUT_MS }).catch(() => false)) {
    throw new Error("Facebook did not accept the reply; not recording it as sent.");
  }

  const composerText = await composer.innerText({ timeout: SHORT_TIMEOUT_MS }).catch(() => "");
  const visibleMessageCountAfter = await countVisibleText(page, message);
  const composerCleared = cleanMessageText(composerText).length === 0;
  const visibleMessageAdded = visibleMessageCountAfter > visibleMessageCountBefore;

  if (!composerCleared && !visibleMessageAdded) {
    throw new Error("Could not verify that Facebook accepted the reply; not recording it as sent.");
  }
}

async function countVisibleText(page: Page, text: string): Promise<number> {
  return page.getByText(text, { exact: true }).count().catch(() => 0);
}

function normalizeReplyMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    throw new Error("send_reply requires a non-empty message.");
  }
  return trimmed;
}

function normalizeApprovalToken(approvalToken: string): string {
  const trimmed = approvalToken.trim();
  if (
    trimmed.length < 8 ||
    /^(none|null|false|auto|automatic|test|placeholder)$/i.test(trimmed)
  ) {
    throw new Error("send_reply requires a real human approval token.");
  }
  return trimmed;
}

async function makeScreenshotPath(
  config: RuntimeConfig,
  basename: string
): Promise<string> {
  await fs.mkdir(config.screenshotsDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "_").slice(0, 15);
  return path.join(config.screenshotsDir, `${basename}_${stamp}.png`);
}

async function scrollPage(page: Page, maxScrolls: number): Promise<void> {
  for (let i = 0; i < maxScrolls; i += 1) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(800);
  }
}

async function scrapeVisibleListingCards(page: Page): Promise<ListingCardScrape[]> {
  const rawCards = await page
    .locator('a[href*="/marketplace/item/"]')
    .evaluateAll((anchors) => {
      const records: Array<{ href: string; text: string }> = [];

      for (const anchor of anchors as any[]) {
        const href = anchor.href || anchor.getAttribute?.("href") || "";
        let container = anchor;

        for (let depth = 0; depth < 5 && container?.parentElement; depth += 1) {
          const parent = container.parentElement;
          const parentText = String(parent.innerText || parent.textContent || "");
          const itemLinks = parent.querySelectorAll?.('a[href*="/marketplace/item/"]');
          if (parentText.length > 20 && itemLinks?.length <= 3) {
            container = parent;
          }
        }

        const text = String(container?.innerText || anchor.innerText || "")
          .replace(/\u00a0/g, " ")
          .trim();
        records.push({ href, text });
      }

      return records;
    });

  const cardsById = new Map<string, ListingCardScrape>();

  for (const rawCard of rawCards) {
    const url = normalizeFacebookUrl(rawCard.href);
    const listingId = listingIdFromUrl(url);
    if (!listingId || cardsById.has(listingId)) {
      continue;
    }

    const lines = splitTextLines(rawCard.text);
    cardsById.set(listingId, {
      listing_id: listingId,
      title: pickListingTitle(lines),
      price: parsePrice(rawCard.text),
      status: parseStatus(rawCard.text),
      url,
      raw_text: rawCard.text
    });
  }

  return [...cardsById.values()];
}

async function scrapeListingDetailPage(page: Page): Promise<ListingDetailScrape> {
  const rawDetail = await page.evaluate(() => {
    const doc = (globalThis as any).document;
    const meta = (selector: string) =>
      String(doc.querySelector(selector)?.getAttribute("content") || "");

    return {
      h1: String(doc.querySelector("h1")?.innerText || ""),
      ogTitle: meta('meta[property="og:title"]'),
      ogDescription: meta('meta[property="og:description"]'),
      bodyText: String(doc.body?.innerText || "")
    };
  });

  const combinedText = [
    rawDetail.h1,
    rawDetail.ogTitle,
    rawDetail.ogDescription,
    rawDetail.bodyText
  ]
    .filter(Boolean)
    .join("\n");

  return {
    title: cleanTitle(rawDetail.h1 || rawDetail.ogTitle),
    price: parsePrice(combinedText),
    status: parseStatus(combinedText),
    description: parseDescription(rawDetail.ogDescription, rawDetail.bodyText),
    views: parseLabeledCount(combinedText, "views?"),
    messages_count: parseLabeledCount(combinedText, "messages?"),
    raw_text: rawDetail.bodyText
  };
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

function normalizeFacebookUrl(rawUrl: string): string {
  const url = new URL(rawUrl, "https://www.facebook.com");
  return `${url.origin}${url.pathname}`;
}

function visibleThreadUrlFromText(text: string): string {
  return `${VISIBLE_THREAD_URL_PREFIX}${encodeURIComponent(cleanMessageText(text).slice(0, 800))}`;
}

function visibleThreadTextFromUrl(url: string): string {
  if (!isVisibleThreadUrl(url)) {
    return "";
  }

  try {
    return decodeURIComponent(url.slice(VISIBLE_THREAD_URL_PREFIX.length));
  } catch {
    return "";
  }
}

function isVisibleThreadUrl(url: string): boolean {
  return url.startsWith(VISIBLE_THREAD_URL_PREFIX);
}

function listingIdFromUrl(url: string): string | null {
  const match = url.match(/\/marketplace\/item\/(\d+)/i);
  return match ? `fb_${match[1]}` : null;
}

function threadIdFromUrl(url: string): string | null {
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

function normalizeThreadId(input: string): string {
  const fromUrl = threadIdFromUrl(input);
  if (fromUrl) {
    return fromUrl;
  }
  if (input.startsWith("thread_")) {
    return input;
  }
  return `thread_${sanitizeId(input)}`;
}

function threadUrlFromInput(input: string): string {
  if (/^https?:\/\//i.test(input) || input.startsWith("data:") || isVisibleThreadUrl(input)) {
    return input;
  }

  throw new Error(
    `Unknown thread_id ${input}. Run check_marketplace_messages first or pass a Messenger thread URL.`
  );
}

function makeFallbackThreadId(url: string, text: string): string {
  return makeMessageId(["thread", url, text]).replace(/^msg_/, "thread_");
}

function makeVisibleThreadId(
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

function detailUrlFromListingId(listingId: string): string {
  const match = listingId.match(/^fb_(\d+)$/);
  if (!match) {
    throw new Error(
      `Unknown listing_id ${listingId}. Run list_my_listings first or pass a Facebook Marketplace item URL.`
    );
  }
  return `https://www.facebook.com/marketplace/item/${match[1]}`;
}

function splitTextLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function looksLikeMarketplaceThreadPreview(text: string, listings: ListingRecord[]): boolean {
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

function parseThreadPreview(
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

function findListingInText(text: string, listings: ListingRecord[]): ListingRecord | undefined {
  const lowerText = text.toLowerCase();
  return listings.find((candidate) => lowerText.includes(candidate.title.toLowerCase()));
}

function parseStructuredOrTextMessages(
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

function cleanMessageText(text: string): string {
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

function cleanThreadTitle(value: string): string | null {
  const cleaned = cleanTitle(value);
  return cleaned.length > 0 ? cleaned : null;
}

function pickListingTitle(lines: string[]): string {
  const titleLine = lines.find(
    (line) =>
      !/^\$?\s*\d/.test(line) &&
      !/^(active|sold|pending|available|boost|views?|messages?)$/i.test(line)
  );

  return cleanTitle(titleLine ?? "Untitled listing");
}

function cleanTitle(value: string): string {
  return value
    .replace(/\s*\|\s*Facebook Marketplace\s*$/i, "")
    .replace(/\s*\|\s*Facebook\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePrice(text: string): number | null {
  const match = text.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStatus(text: string): ListingStatus {
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

function parseDescription(
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

function parseLabeledCount(text: string, labelPattern: string): number | null {
  const match = text.match(new RegExp(`(\\d[\\d,]*)\\s+${labelPattern}`, "i"));
  if (!match) {
    return null;
  }
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

interface ListingCardScrape {
  listing_id: string;
  title: string;
  price: number | null;
  status: ListingStatus;
  url: string;
  raw_text: string;
}

interface ListingDetailScrape {
  title: string;
  price: number | null;
  status: ListingStatus;
  description: string | null;
  views: number | null;
  messages_count: number | null;
  raw_text: string;
}
