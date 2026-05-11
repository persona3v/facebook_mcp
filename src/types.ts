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
  defaultLocation?: string;
  headless: boolean;
  slowMoMs: number;
}
