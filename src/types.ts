export type ListingDraftStatus = "local_draft" | "form_filled" | "published";

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

export type FillListingStatus =
  | "ready_for_manual_publish"
  | "published"
  /** Publish was clicked but Facebook never landed on a page proving success. */
  | "publish_unconfirmed";

export interface FillListingResult {
  status: FillListingStatus;
  draft_id: string;
  profile: string;
  screenshot_path: string;
  browser_state: "waiting_on_publish_screen" | "published_screen";
  listing_url: string | null;
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

export type MessageRole = "buyer" | "seller" | "system" | "unknown";
export type MessageThreadStatus = "open" | "archived" | "unknown";

export interface MarketplaceMessageRecord {
  message_id: string;
  thread_id: string;
  listing_id: string | null;
  buyer_name: string;
  role: MessageRole;
  text: string;
  timestamp: string;
  first_seen_at: string;
  seen_at: string;
  requires_response: boolean;
  raw_text?: string;
}

export interface MessageThreadRecord {
  thread_id: string;
  listing_id: string | null;
  buyer_name: string;
  listing_title: string | null;
  status: MessageThreadStatus;
  url: string;
  last_message_at: string;
  first_seen_at: string;
  last_seen_at: string;
  raw_text?: string;
}

export interface MarketplaceMessageNotification {
  thread_id: string;
  listing_id: string | null;
  buyer_name: string;
  message: string;
  received_at: string;
  requires_response: boolean;
}

export interface MarketplaceMessageThreadSummary {
  thread_id: string;
  listing_id: string | null;
  buyer_name: string;
  listing_title: string | null;
  last_message: string | null;
  last_message_at: string;
  requires_response: boolean;
}

export interface CheckMarketplaceMessagesResult {
  threads: MarketplaceMessageThreadSummary[];
  new_messages: MarketplaceMessageNotification[];
  checked_at: string;
  screenshot_path: string;
  browser_state: "marketplace_messages_screen";
  notes: string[];
}

export interface GetMessageThreadResult {
  thread_id: string;
  listing_id: string | null;
  buyer_name: string;
  messages: Array<{
    role: MessageRole;
    text: string;
    timestamp: string;
  }>;
  screenshot_path: string;
  browser_state: "message_thread_screen";
  notes: string[];
}

export type ReplyRiskLevel = "low" | "medium" | "high";

export type ReplyConstraints = Record<string, unknown>;

export interface DraftReplyResult {
  thread_id: string;
  listing_id: string | null;
  buyer_name: string;
  reply_draft: string;
  risk_level: ReplyRiskLevel;
  requires_human_approval: true;
  risk_reasons: string[];
  notes: string[];
}

export interface SendReplyResult {
  status: "sent";
  thread_id: string;
  listing_id: string | null;
  buyer_name: string;
  message: string;
  risk_level: ReplyRiskLevel;
  sent_at: string;
  screenshot_path: string;
  browser_state: "message_thread_screen";
  notes: string[];
}

export type BrowserMode = "managed_profile" | "existing_cdp";

export interface BrowserConnectionOptions {
  browserMode?: BrowserMode;
  browserCdpUrl?: string;
}

/**
 * Serializes the Publish click across profiles so a broadcast never pushes the
 * same item to several accounts in the same instant.
 */
export type ExclusiveRunner = <T>(fn: () => Promise<T>) => Promise<T>;

export interface PublishOptions {
  approvalToken: string;
  runExclusive?: ExclusiveRunner;
}

export interface FillListingOptions extends BrowserConnectionOptions {
  publish?: PublishOptions;
  /** Broadcasts clone the shared draft per account, so they skip the shared write. */
  persistStatus?: boolean;
}

export interface ProfileSummary {
  profile: string;
  label: string | null;
  is_default: boolean;
  browser_mode: BrowserMode;
  browser_cdp_url: string | null;
  data_dir: string;
  drafts_dir: string;
  browser_user_data_dir: string;
}

export interface BroadcastProfileOutcome {
  profile: string;
  label: string | null;
  status: FillListingStatus | "failed";
  screenshot_path: string | null;
  listing_url: string | null;
  error: string | null;
  notes: string[];
}

export interface BroadcastListingResult {
  draft_id: string;
  published: boolean;
  succeeded: number;
  failed: number;
  /** Publish was clicked but not confirmed; these need a manual check. */
  unconfirmed: number;
  results: BroadcastProfileOutcome[];
  started_at: string;
  finished_at: string;
  notes: string[];
}

export interface RuntimeConfig {
  profileId: string;
  label?: string;
  dataDir: string;
  draftsDir: string;
  photosDir: string;
  screenshotsDir: string;
  logsDir: string;
  messagesDbPath: string;
  browserMode: BrowserMode;
  browserCdpUrl: string;
  browserUserDataDir: string;
  browserChannel?: string;
  chromeProfileName?: string;
  marketplaceCreateUrl: string;
  marketplaceSellingUrl: string;
  marketplaceMessagesUrl: string;
  defaultLocation?: string;
  headless: boolean;
  slowMoMs: number;
  stealth: boolean;
  screenshotFullPage: boolean;
}
