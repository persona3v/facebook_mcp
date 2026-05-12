export type ListingDraftStatus = "local_draft" | "form_filled";

export interface ListingDraft {
  draft_id: string;
  title: string;
  price: number;
  category: string;
  condition: string;
  description: string;
  location: string;
  photos: string[];
  tags: string[];
  created_at: string;
  updated_at: string;
  status: ListingDraftStatus;
}

export interface FillListingResult {
  status: "ready_for_manual_publish";
  draft_id: string;
  screenshot_path: string;
  browser_state: "waiting_on_publish_screen";
  notes: string[];
}

export type ListingStatus = "active" | "sold" | "pending" | "unknown";

export interface ListingRecord {
  listing_id: string;
  draft_id: string | null;
  title: string;
  price: number | null;
  status: ListingStatus;
  url: string;
  description: string | null;
  views: number | null;
  messages_count: number | null;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
  raw_text?: string;
}

export interface ListingInventory {
  version: 1;
  updated_at: string;
  listings: ListingRecord[];
}

export interface ListMyListingsResult {
  listings: ListingRecord[];
  synced_at: string;
  screenshot_path: string;
  browser_state: "seller_listings_screen";
  notes: string[];
}

export interface ListingDetailResult extends ListingRecord {
  screenshot_path: string;
  browser_state: "listing_detail_screen";
  notes: string[];
}

export interface RuntimeConfig {
  dataDir: string;
  draftsDir: string;
  photosDir: string;
  screenshotsDir: string;
  logsDir: string;
  browserUserDataDir: string;
  browserChannel?: string;
  chromeProfileName?: string;
  marketplaceCreateUrl: string;
  marketplaceSellingUrl: string;
  defaultLocation?: string;
  headless: boolean;
  slowMoMs: number;
}
