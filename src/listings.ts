import type { Page } from "playwright";
import type {
  BrowserConnectionOptions,
  ListingDetailResult,
  ListingRecord,
  ListingStatus,
  ListMyListingsResult,
  RuntimeConfig
} from "./types.js";
import {
  findListingRecord,
  normalizeListingId,
  syncListingRecords,
  upsertListingRecord
} from "./storage.js";
import { getOrLaunchContext, getWorkingPage } from "./browser.js";
import { captureScreenshot, scrollPage, waitForPageReady } from "./pageUtils.js";
import {
  LISTING_CARD_LINK_SELECTOR,
  LISTING_DETAIL_ANCHORS,
  SELLER_LISTINGS_ANCHORS
} from "./selectors.js";
import {
  cleanTitle,
  detailUrlFromListingId,
  listingIdFromUrl,
  normalizeFacebookUrl,
  parseDescription,
  parseLabeledCount,
  parsePrice,
  parseStatus,
  pickListingTitle,
  splitTextLines
} from "./parse.js";

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

  await waitForPageReady(page, SELLER_LISTINGS_ANCHORS, "seller listings page", notes);

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

  const screenshotPath = await captureScreenshot(config, page, "seller_listings");

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

  await waitForPageReady(page, LISTING_DETAIL_ANCHORS, "listing detail page", notes);

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

  const screenshotPath = await captureScreenshot(config, page, normalizedId);

  return {
    ...savedRecord,
    screenshot_path: screenshotPath,
    browser_state: "listing_detail_screen",
    notes
  };
}

async function scrapeVisibleListingCards(page: Page): Promise<ListingCardScrape[]> {
  const rawCards = await page
    .locator(LISTING_CARD_LINK_SELECTOR)
    .evaluateAll((anchors, itemLinkSelector) => {
      const records: Array<{ href: string; text: string }> = [];

      for (const anchor of anchors as any[]) {
        const href = anchor.href || anchor.getAttribute?.("href") || "";
        let container = anchor;

        for (let depth = 0; depth < 5 && container?.parentElement; depth += 1) {
          const parent = container.parentElement;
          const parentText = String(parent.innerText || parent.textContent || "");
          const itemLinks = parent.querySelectorAll?.(itemLinkSelector);
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
    }, LISTING_CARD_LINK_SELECTOR);

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
