import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type {
  ListingDraft,
  ListingInventory,
  ListingRecord,
  RuntimeConfig
} from "./types.js";

const DRAFT_ID_PATTERN = /^draft_\d{8}_\d{6}_[a-z0-9]{4}$/;
const INVENTORY_VERSION = 1;

export async function ensureStorage(config: RuntimeConfig): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(config.dataDir, 0o700).catch(() => undefined);

  for (const dir of [
    config.draftsDir,
    config.photosDir,
    config.screenshotsDir,
    config.logsDir
  ]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => undefined);
  }
}

export function makeDraftId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "")
    .replace("T", "_");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `draft_${stamp}_${suffix}`;
}

export function draftPath(config: RuntimeConfig, draftId: string): string {
  assertSafeDraftId(draftId);
  return path.join(config.draftsDir, `${draftId}.json`);
}

export function inventoryPath(config: RuntimeConfig): string {
  return path.join(config.dataDir, "inventory.json");
}

export async function saveDraft(
  config: RuntimeConfig,
  draft: ListingDraft
): Promise<string> {
  await ensureStorage(config);
  const filePath = draftPath(config, draft.draft_id);
  const body = `${JSON.stringify(draft, null, 2)}\n`;
  await fs.writeFile(filePath, body, { mode: 0o600, flag: "wx" });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
  return filePath;
}

export async function updateDraft(
  config: RuntimeConfig,
  draft: ListingDraft
): Promise<string> {
  await ensureStorage(config);
  const filePath = draftPath(config, draft.draft_id);
  const body = `${JSON.stringify(draft, null, 2)}\n`;
  await fs.writeFile(filePath, body, { mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
  return filePath;
}

export async function loadDraft(
  config: RuntimeConfig,
  draftId: string
): Promise<ListingDraft> {
  const filePath = draftPath(config, draftId);
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as ListingDraft;
  if (parsed.draft_id !== draftId) {
    throw new Error(`Draft id mismatch in ${filePath}`);
  }
  return parsed;
}

export async function listDrafts(config: RuntimeConfig): Promise<ListingDraft[]> {
  await ensureStorage(config);
  const entries = await fs.readdir(config.draftsDir).catch(() => []);
  const drafts: ListingDraft[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }

    const draftId = entry.slice(0, -".json".length);
    try {
      drafts.push(await loadDraft(config, draftId));
    } catch {
      // Ignore malformed draft files so one broken draft does not block sync.
    }
  }

  return drafts;
}

export async function loadInventory(
  config: RuntimeConfig
): Promise<ListingInventory> {
  await ensureStorage(config);
  const filePath = inventoryPath(config);

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as ListingInventory;
    return {
      version: INVENTORY_VERSION,
      updated_at: parsed.updated_at ?? new Date().toISOString(),
      listings: Array.isArray(parsed.listings) ? parsed.listings : []
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        version: INVENTORY_VERSION,
        updated_at: new Date().toISOString(),
        listings: []
      };
    }
    throw error;
  }
}

export async function saveInventory(
  config: RuntimeConfig,
  inventory: ListingInventory
): Promise<string> {
  await ensureStorage(config);
  const filePath = inventoryPath(config);
  const body = `${JSON.stringify(inventory, null, 2)}\n`;
  await fs.writeFile(filePath, body, { mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
  return filePath;
}

export async function syncListingRecords(
  config: RuntimeConfig,
  scrapedListings: ListingRecord[]
): Promise<ListingRecord[]> {
  const now = new Date().toISOString();
  const inventory = await loadInventory(config);
  const drafts = await listDrafts(config);
  const existingById = new Map(
    inventory.listings.map((listing) => [listing.listing_id, listing])
  );

  const mergedListings = scrapedListings.map((listing) => {
    const existing = existingById.get(listing.listing_id);
    return mergeListingRecord(existing, {
      ...listing,
      draft_id:
        listing.draft_id ??
        existing?.draft_id ??
        matchDraftId(listing, drafts) ??
        null,
      first_seen_at: existing?.first_seen_at ?? listing.first_seen_at ?? now,
      last_seen_at: listing.last_seen_at || now,
      updated_at: now
    });
  });

  const mergedById = new Map(inventory.listings.map((listing) => [
    listing.listing_id,
    listing
  ]));

  for (const listing of mergedListings) {
    mergedById.set(listing.listing_id, listing);
  }

  const updatedInventory: ListingInventory = {
    version: INVENTORY_VERSION,
    updated_at: now,
    listings: [...mergedById.values()].sort((a, b) =>
      b.last_seen_at.localeCompare(a.last_seen_at)
    )
  };

  await saveInventory(config, updatedInventory);
  return mergedListings;
}

export async function findListingRecord(
  config: RuntimeConfig,
  listingId: string
): Promise<ListingRecord | undefined> {
  const inventory = await loadInventory(config);
  const normalizedId = normalizeListingId(listingId);
  return inventory.listings.find((listing) => listing.listing_id === normalizedId);
}

export async function upsertListingRecord(
  config: RuntimeConfig,
  listing: ListingRecord
): Promise<ListingRecord> {
  const now = new Date().toISOString();
  const inventory = await loadInventory(config);
  const existing = inventory.listings.find(
    (candidate) => candidate.listing_id === listing.listing_id
  );
  const merged = mergeListingRecord(existing, {
    ...listing,
    first_seen_at: existing?.first_seen_at ?? listing.first_seen_at ?? now,
    last_seen_at: listing.last_seen_at || now,
    updated_at: now
  });

  const listings = inventory.listings.filter(
    (candidate) => candidate.listing_id !== merged.listing_id
  );
  listings.push(merged);
  await saveInventory(config, {
    version: INVENTORY_VERSION,
    updated_at: now,
    listings: listings.sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
  });

  return merged;
}

export async function assertReadableFiles(paths: string[]): Promise<void> {
  for (const filePath of paths) {
    if (!path.isAbsolute(filePath)) {
      throw new Error(`Photo path must be absolute: ${filePath}`);
    }
    await fs.access(filePath, constants.R_OK);
  }
}

function assertSafeDraftId(draftId: string): void {
  if (!DRAFT_ID_PATTERN.test(draftId)) {
    throw new Error(`Invalid draft_id: ${draftId}`);
  }
}

export function normalizeListingId(value: string): string {
  const trimmed = value.trim();
  const urlMatch = trimmed.match(/\/marketplace\/item\/(\d+)/i);
  if (urlMatch) {
    return `fb_${urlMatch[1]}`;
  }

  if (/^fb_\d+$/.test(trimmed)) {
    return trimmed;
  }

  if (/^\d+$/.test(trimmed)) {
    return `fb_${trimmed}`;
  }

  return trimmed;
}

function mergeListingRecord(
  existing: ListingRecord | undefined,
  incoming: ListingRecord
): ListingRecord {
  return {
    listing_id: incoming.listing_id,
    draft_id: incoming.draft_id ?? existing?.draft_id ?? null,
    title: incoming.title || existing?.title || "Untitled listing",
    price: incoming.price ?? existing?.price ?? null,
    status: incoming.status ?? existing?.status ?? "unknown",
    url: incoming.url || existing?.url || "",
    description: incoming.description ?? existing?.description ?? null,
    views: incoming.views ?? existing?.views ?? null,
    messages_count: incoming.messages_count ?? existing?.messages_count ?? null,
    first_seen_at: incoming.first_seen_at || existing?.first_seen_at || incoming.updated_at,
    last_seen_at: incoming.last_seen_at || existing?.last_seen_at || incoming.updated_at,
    updated_at: incoming.updated_at,
    raw_text: incoming.raw_text ?? existing?.raw_text
  };
}

function matchDraftId(
  listing: ListingRecord,
  drafts: ListingDraft[]
): string | null {
  const listingTitle = normalizeText(listing.title);

  for (const draft of drafts) {
    const sameTitle = normalizeText(draft.title) === listingTitle;
    const samePrice = listing.price === null || draft.price === listing.price;
    if (sameTitle && samePrice) {
      return draft.draft_id;
    }
  }

  return null;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
