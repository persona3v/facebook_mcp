import { promises as fs } from "node:fs";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Page } from "playwright";
import type {
  BrowserConnectionOptions,
  BrowserMode,
  RuntimeConfig
} from "./types.js";

interface BrowserSession {
  mode: BrowserMode;
  cdpUrl?: string;
  context: BrowserContext;
  browser?: Browser;
}

let activeSession: BrowserSession | undefined;
let stealthRegistered = false;

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

export async function getOrLaunchContext(
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

export async function getWorkingPage(context: BrowserContext): Promise<Page> {
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
