import { homedir } from "node:os";
import path from "node:path";
import type { RuntimeConfig } from "./types.js";

function expandHome(value: string): string {
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

export function loadConfig(): RuntimeConfig {
  const dataDir =
    optionalEnv("FB_MARKETPLACE_DATA_DIR") ??
    path.join(homedir(), ".hermes", "facebook-marketplace");

  const browserUserDataDir =
    optionalEnv("FB_CHROME_USER_DATA_DIR") ??
    optionalEnv("FB_CHROME_PROFILE_DIR") ??
    path.join(dataDir, "browser-profile");

  return {
    dataDir,
    draftsDir: path.join(dataDir, "drafts"),
    photosDir: path.join(dataDir, "photos"),
    screenshotsDir: path.join(dataDir, "screenshots"),
    logsDir: path.join(dataDir, "logs"),
    browserUserDataDir,
    browserChannel: optionalEnv("FB_BROWSER_CHANNEL"),
    chromeProfileName: optionalEnv("FB_CHROME_PROFILE_NAME"),
    marketplaceCreateUrl:
      optionalEnv("FB_MARKETPLACE_CREATE_URL") ??
      "https://www.facebook.com/marketplace/create/item",
    defaultLocation: optionalEnv("FB_MARKETPLACE_HOME_LOCATION"),
    headless: boolEnv("FB_HEADLESS", false),
    slowMoMs: numberEnv("FB_SLOW_MO_MS", 50)
  };
}
