import path from "node:path";
import { promises as fs } from "node:fs";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import type {
  FillListingResult,
  ListingDetailResult,
  ListingRecord,
  ListingStatus,
  ListMyListingsResult,
  ListingDraft,
  RuntimeConfig
} from "./types.js";
import {
  findListingRecord,
  normalizeListingId,
  syncListingRecords,
  updateDraft,
  upsertListingRecord
} from "./storage.js";

const SHORT_TIMEOUT_MS = 3000;
const FIELD_TIMEOUT_MS = 8000;
let activeContext: BrowserContext | undefined;

export async function closeBrowserContext(): Promise<void> {
  const context = activeContext;
  activeContext = undefined;
  await context?.close().catch(() => undefined);
}

export async function fillListingForm(
  config: RuntimeConfig,
  draft: ListingDraft
): Promise<FillListingResult> {
  const context = await getOrLaunchContext(config);
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
  options: { maxScrolls: number }
): Promise<ListMyListingsResult> {
  const context = await getOrLaunchContext(config);
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
  listingId: string
): Promise<ListingDetailResult> {
  const context = await getOrLaunchContext(config);
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

async function getOrLaunchContext(config: RuntimeConfig): Promise<BrowserContext> {
  if (activeContext) {
    return activeContext;
  }

  await fs.mkdir(config.browserUserDataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(config.browserUserDataDir, 0o700).catch(() => undefined);

  const args = config.chromeProfileName
    ? [`--profile-directory=${config.chromeProfileName}`]
    : [];

  activeContext = await chromium.launchPersistentContext(config.browserUserDataDir, {
    channel: config.browserChannel,
    headless: config.headless,
    slowMo: config.slowMoMs,
    viewport: { width: 1440, height: 1000 },
    args
  });
  activeContext.on("close", () => {
    activeContext = undefined;
  });
  return activeContext;
}

async function getWorkingPage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }
  return context.newPage();
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

function normalizeFacebookUrl(rawUrl: string): string {
  const url = new URL(rawUrl, "https://www.facebook.com");
  return `${url.origin}${url.pathname}`;
}

function listingIdFromUrl(url: string): string | null {
  const match = url.match(/\/marketplace\/item\/(\d+)/i);
  return match ? `fb_${match[1]}` : null;
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
