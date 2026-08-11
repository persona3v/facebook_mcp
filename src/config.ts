import { homedir } from "node:os";
import path from "node:path";
import type { BrowserMode, RuntimeConfig } from "./types.js";

const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

export const DEFAULT_PROFILE_ID = "default";

export function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? expandHome(value) : undefined;
}

function boolEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(value);
}

function numberEnv(name: string, defaultValue: number): number {
  const value = process.env[name]?.trim();
  if (!value) {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function browserModeEnv(name: string, defaultValue: BrowserMode): BrowserMode {
  const value = process.env[name]?.trim();
  if (!value) {
    return defaultValue;
  }
  if (value === "managed_profile" || value === "existing_cdp") {
    return value;
  }
  throw new Error(
    `${name} must be either "managed_profile" or "existing_cdp"; received "${value}".`
  );
}

/**
 * Environment-derived settings shared by every profile. Per-profile overrides in
 * profiles.json fall back to these.
 */
export interface BaseSettings {
  rootDataDir: string;
  profilesFile: string;
  browserMode: BrowserMode;
  browserCdpUrl: string;
  browserUserDataDirOverride?: string;
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

export interface ProfilePaths {
  profileId: string;
  label?: string;
  /**
   * Everything per-account (inventory.json, messages.db, screenshots, logs)
   * derives from this directory, so profiles must not share one.
   */
  dataDir: string;
  /** Authoring artifacts, deliberately pointed at the shared root. */
  draftsDir: string;
  photosDir: string;
  browserUserDataDir: string;
  browserMode?: BrowserMode;
  browserCdpUrl?: string;
  browserChannel?: string;
  chromeProfileName?: string;
  defaultLocation?: string;
  headless?: boolean;
}

export function loadBaseSettings(): BaseSettings {
  const rootDataDir =
    optionalEnv("FB_MARKETPLACE_DATA_DIR") ??
    path.join(homedir(), ".hermes", "facebook-marketplace");

  return {
    rootDataDir,
    profilesFile:
      optionalEnv("FB_PROFILES_FILE") ?? path.join(rootDataDir, "profiles.json"),
    browserMode: browserModeEnv("FB_BROWSER_MODE", "managed_profile"),
    browserCdpUrl: optionalEnv("FB_BROWSER_CDP_URL") ?? DEFAULT_CDP_URL,
    browserUserDataDirOverride:
      optionalEnv("FB_CHROME_USER_DATA_DIR") ?? optionalEnv("FB_CHROME_PROFILE_DIR"),
    browserChannel: optionalEnv("FB_BROWSER_CHANNEL"),
    chromeProfileName: optionalEnv("FB_CHROME_PROFILE_NAME"),
    marketplaceCreateUrl:
      optionalEnv("FB_MARKETPLACE_CREATE_URL") ??
      "https://www.facebook.com/marketplace/create/item",
    marketplaceSellingUrl:
      optionalEnv("FB_MARKETPLACE_SELLING_URL") ??
      "https://www.facebook.com/marketplace/you/selling",
    marketplaceMessagesUrl:
      optionalEnv("FB_MARKETPLACE_MESSAGES_URL") ??
      "https://www.facebook.com/marketplace/inbox",
    defaultLocation: optionalEnv("FB_MARKETPLACE_HOME_LOCATION"),
    headless: boolEnv("FB_HEADLESS", false),
    slowMoMs: numberEnv("FB_SLOW_MO_MS", 0),
    // Stealth is registered once on the shared playwright-extra launcher, so it
    // cannot vary per profile.
    stealth: boolEnv("FB_STEALTH", true),
    screenshotFullPage: boolEnv("FB_SCREENSHOT_FULL_PAGE", false)
  };
}

export function makeConfig(base: BaseSettings, paths: ProfilePaths): RuntimeConfig {
  return {
    profileId: paths.profileId,
    label: paths.label,
    dataDir: paths.dataDir,
    draftsDir: paths.draftsDir,
    photosDir: paths.photosDir,
    screenshotsDir: path.join(paths.dataDir, "screenshots"),
    logsDir: path.join(paths.dataDir, "logs"),
    messagesDbPath: path.join(paths.dataDir, "messages.db"),
    browserMode: paths.browserMode ?? base.browserMode,
    browserCdpUrl: paths.browserCdpUrl ?? base.browserCdpUrl,
    browserUserDataDir: paths.browserUserDataDir,
    browserChannel: paths.browserChannel ?? base.browserChannel,
    chromeProfileName: paths.chromeProfileName ?? base.chromeProfileName,
    marketplaceCreateUrl: base.marketplaceCreateUrl,
    marketplaceSellingUrl: base.marketplaceSellingUrl,
    marketplaceMessagesUrl: base.marketplaceMessagesUrl,
    defaultLocation: paths.defaultLocation ?? base.defaultLocation,
    headless: paths.headless ?? base.headless,
    slowMoMs: base.slowMoMs,
    stealth: base.stealth,
    screenshotFullPage: base.screenshotFullPage
  };
}

/**
 * The single-account layout used when no profiles.json exists: every path stays
 * at the data directory root, exactly where existing installs already have their
 * logged-in browser profile, inventory, and message database.
 */
export function loadConfig(base = loadBaseSettings()): RuntimeConfig {
  return makeConfig(base, {
    profileId: DEFAULT_PROFILE_ID,
    dataDir: base.rootDataDir,
    draftsDir: path.join(base.rootDataDir, "drafts"),
    photosDir: path.join(base.rootDataDir, "photos"),
    browserUserDataDir:
      base.browserUserDataDirOverride ?? path.join(base.rootDataDir, "browser-profile")
  });
}
