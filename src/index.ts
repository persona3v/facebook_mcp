#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  checkMarketplaceMessages,
  closeAllBrowserContexts,
  draftReplyForThread,
  fillListingForm,
  getMessageThread,
  getListingDetail,
  listMyListings,
  sendReply
} from "./facebook.js";
import { ensureMessageStore } from "./messageStore.js";
import { withLock } from "./mutex.js";
import { normalizeApprovalToken } from "./parse.js";
import { loadProfiles, resolveProfileConfig, summarizeProfiles } from "./profiles.js";
import {
  assertReadableFiles,
  ensureStorage,
  loadDraft,
  makeDraftId,
  saveDraft
} from "./storage.js";
import type {
  BroadcastListingResult,
  BroadcastProfileOutcome,
  BrowserConnectionOptions,
  BrowserMode,
  ListingDraft,
  RuntimeConfig
} from "./types.js";

const registry = loadProfiles();

/** Drafts and photos are shared, so draft I/O always goes through one config. */
const sharedConfig = resolveProfileConfig(registry);

/** Serializes the Publish click across every account in a broadcast. */
const PUBLISH_LOCK_KEY = "__marketplace_publish__";
const PUBLISH_STAGGER_MIN_MS = 5000;
const PUBLISH_STAGGER_MAX_MS = 15000;

const createListingDraftSchema = {
  title: z.string().min(1).max(100),
  price: z.number().nonnegative(),
  category: z.string().min(1).max(80),
  condition: z.string().min(1).max(80),
  description: z.string().min(1).max(5000),
  location: z.string().min(1).max(160).optional(),
  photos: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1).max(80)).default([])
};

const profileSchema = {
  profile: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Configured Facebook account to act as. Call list_profiles to see the options. Defaults to the default profile."
    )
};

const browserConnectionSchema = {
  browser_mode: z
    .enum(["managed_profile", "existing_cdp"])
    .optional()
    .describe("Override the configured browser mode for this tool call."),
  browser_cdp_url: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("CDP endpoint for browser_mode=existing_cdp, for example http://127.0.0.1:9222.")
};

const publishAuthorizationSchema = {
  stop_before_publish: z
    .boolean()
    .default(true)
    .describe("Keep true to fill the form and stop at the review screen."),
  approval_token: z
    .string()
    .trim()
    .min(8)
    .optional()
    .describe(
      "Required only with stop_before_publish=false. Publishing without an explicit human approval token is refused."
    )
};

const fillListingFormSchema = {
  draft_id: z.string().min(1),
  ...publishAuthorizationSchema,
  ...profileSchema,
  ...browserConnectionSchema
};

const broadcastListingDraftSchema = {
  draft_id: z.string().min(1),
  profiles: z
    .array(z.string().trim().min(1))
    .min(1)
    .optional()
    .describe("Accounts to list on. Defaults to every configured profile."),
  ...publishAuthorizationSchema,
  fill_concurrency: z
    .number()
    .int()
    .min(1)
    .max(16)
    .optional()
    .describe("How many accounts fill their form at once. Defaults to all of them."),
  publish_stagger_ms: z
    .number()
    .int()
    .min(0)
    .max(300000)
    .optional()
    .describe(
      "Fixed gap between publishes instead of the default randomized 5-15s spacing."
    )
};

const listMyListingsSchema = {
  max_scrolls: z.number().int().min(0).max(10).default(3),
  ...profileSchema,
  ...browserConnectionSchema
};

const getListingDetailSchema = {
  listing_id: z.string().min(1),
  ...profileSchema,
  ...browserConnectionSchema
};

const checkMarketplaceMessagesSchema = {
  since: z.string().min(1).default("last_check"),
  include_read: z.boolean().default(false),
  max_threads: z.number().int().min(1).max(100).default(20),
  max_scrolls: z.number().int().min(0).max(10).default(3),
  ...profileSchema,
  ...browserConnectionSchema
};

const getMessageThreadSchema = {
  thread_id: z.string().min(1),
  ...profileSchema,
  ...browserConnectionSchema
};

const draftReplySchema = {
  thread_id: z.string().min(1),
  intent: z.string().min(1).default("availability"),
  constraints: z.record(z.unknown()).default({}),
  ...profileSchema
};

const sendReplySchema = {
  thread_id: z.string().min(1),
  message: z.string().trim().min(1).max(2000),
  approval_token: z.string().trim().min(8),
  ...profileSchema,
  ...browserConnectionSchema
};

const server = new McpServer({
  name: "facebook-marketplace-assistant-mcp",
  version: "0.1.0"
});

server.registerPrompt(
  "create_marketplace_listing_from_notes",
  {
    title: "Create Marketplace listing from notes",
    description:
      "Turn item notes into a safe Facebook Marketplace draft workflow. Creates a local draft only unless the user explicitly asks to fill the form.",
    argsSchema: {
      notes: z.string().min(1).describe("Raw item notes from the user."),
      target_price: z
        .string()
        .optional()
        .describe("Optional target price or price range from the user."),
      category: z
        .string()
        .optional()
        .describe("Optional Facebook Marketplace category hint."),
      condition: z.string().optional().describe("Optional item condition."),
      pickup_area: z
        .string()
        .optional()
        .describe("Optional general pickup area. Do not include exact address."),
      photo_paths: z
        .string()
        .optional()
        .describe("Optional newline- or comma-separated absolute local photo paths.")
    }
  },
  async (input) =>
    userPrompt(
      "Create a Facebook Marketplace listing draft from user notes.",
      [
        "You are preparing a Facebook Marketplace listing through the local MCP server.",
        "Use the user's notes to produce concise Marketplace-ready fields, then call create_listing_draft if enough information is present.",
        "Do not publish. If the user later asks to fill the form, call fill_listing_form with stop_before_publish=true.",
        "To list on several accounts at once, call broadcast_listing_draft. Keep stop_before_publish=true unless the user explicitly authorizes publishing and supplies an approval token.",
        "Ask a short follow-up if required fields are missing: title, price, category, condition, description, or usable photo paths.",
        "Keep pickup location general and avoid exact addresses, payment instructions, or anything that could increase account risk.",
        "",
        "User notes:",
        input.notes,
        optionalPromptLine("Target price", input.target_price),
        optionalPromptLine("Category hint", input.category),
        optionalPromptLine("Condition hint", input.condition),
        optionalPromptLine("Pickup area", input.pickup_area),
        optionalPromptLine("Photo paths", input.photo_paths)
      ]
    )
);

server.registerPrompt(
  "review_listing_before_publish",
  {
    title: "Review listing before publish",
    description:
      "Review a draft or filled form before the user manually publishes it. The workflow never publishes automatically.",
    argsSchema: {
      draft_id: z.string().min(1).describe("Local draft id to review."),
      review_focus: z
        .string()
        .optional()
        .describe("Optional focus, such as price, safety, clarity, or photos."),
      screenshot_path: z
        .string()
        .optional()
        .describe("Optional local screenshot path from a previous fill attempt.")
    }
  },
  async (input) =>
    userPrompt(
      "Review a Facebook Marketplace draft before manual publish.",
      [
        "Review the draft for Marketplace clarity, pricing consistency, safety, and missing information.",
        "If the form needs to be opened or refreshed, call resume_listing_draft or fill_listing_form and keep stop_before_publish=true.",
        "Do not publish on your own initiative. Publishing requires the user to explicitly ask for it and to supply an approval token; otherwise tell them to review Facebook's final screen and click Publish themselves.",
        "Flag risky content: exact address, payment app instructions, pressure tactics, policy-sensitive wording, or private buyer data.",
        "Return a compact review with: ready/not ready, issues, suggested edits, and next safe action.",
        "",
        `Draft id: ${input.draft_id}`,
        optionalPromptLine("Review focus", input.review_focus),
        optionalPromptLine("Screenshot path", input.screenshot_path)
      ]
    )
);

server.registerPrompt(
  "triage_marketplace_buyer_messages",
  {
    title: "Triage Marketplace buyer messages",
    description:
      "Check buyer messages and triage them for safe human-approved follow-up. This prompt does not send replies.",
    argsSchema: {
      since: z
        .string()
        .min(1)
        .default("last_check")
        .describe("Message window to check, usually last_check."),
      include_read: z
        .preprocess(
          (v) => (typeof v === "string" ? v.trim().toLowerCase() === "true" : v),
          z.boolean()
        )
        .default(false)
        .describe("Whether to include read threads."),
      max_threads: z
        .preprocess(
          (v) =>
            typeof v === "string" && v.trim() !== "" ? Number(v) : v,
          z.number().int().min(1).max(100)
        )
        .optional()
        .describe("Optional maximum number of threads to inspect (1-100).")
    }
  },
  async (input) =>
    userPrompt(
      "Triage Facebook Marketplace buyer messages.",
      [
        "Check Marketplace messages with check_marketplace_messages, then summarize only what needs attention.",
        "Do not send replies. If drafting a response, keep it as a suggestion that requires human approval.",
        "Classify each new buyer message as low, medium, or high risk.",
        "Low risk: availability, pickup-only reminders, item dimensions, basic condition.",
        "Medium risk: price negotiation, holds, delivery, meeting time, phone number, or broad pickup area.",
        "High risk: payment apps, deposits, exact address, disputes, policy-sensitive content, or anything that should not be automated.",
        "For each actionable thread, include buyer name, listing reference if available, message summary, risk level, and suggested next action.",
        "",
        `Since: ${input.since}`,
        `Include read: ${input.include_read}`,
        optionalPromptLine("Max threads", input.max_threads)
      ]
    )
);

server.registerPrompt(
  "reply_to_marketplace_buyer_message",
  {
    title: "Reply to Marketplace buyer message",
    description:
      "Find the relevant Marketplace buyer thread and send only a human-approved reply through the MCP tools. Never creates temporary scripts.",
    argsSchema: {
      thread_id: z
        .string()
        .optional()
        .describe("Optional saved thread_id from check_marketplace_messages."),
      buyer_name: z.string().optional().describe("Optional buyer name hint if thread_id is unknown."),
      listing_hint: z
        .string()
        .optional()
        .describe("Optional listing title or item hint if thread_id is unknown."),
      reply_message: z.string().min(1).describe("Exact reply text the user wants to send."),
      approval_token: z
        .string()
        .optional()
        .describe("Human approval token required before send_reply may be called.")
    }
  },
  async (input) =>
    userPrompt(
      "Reply to a Facebook Marketplace buyer message through the MCP server.",
      [
        "Use only the MCP tools in this server. Do not write or run temporary Playwright, CJS, JS, or JSON probe files in the repository.",
        "If thread_id is missing, call check_marketplace_messages first and use buyer_name or listing_hint to identify the matching returned thread summary.",
        "If the returned thread was scraped from a visible inbox row, use its saved thread_id normally; the MCP server handles opening the row.",
        "Call get_message_thread if conversation context is needed before replying.",
        "Call send_reply only when approval_token is supplied and the user has approved the exact reply_message.",
        "If the thread cannot be found or the MCP tool fails, report the failure and ask for guidance instead of creating a local script.",
        "",
        optionalPromptLine("Thread id", input.thread_id),
        optionalPromptLine("Buyer name", input.buyer_name),
        optionalPromptLine("Listing hint", input.listing_hint),
        `Reply message: ${input.reply_message}`,
        optionalPromptLine("Approval token", input.approval_token)
      ]
    )
);

server.registerPrompt(
  "debug_marketplace_login_or_selector_failure",
  {
    title: "Debug Marketplace login or selector failure",
    description:
      "Guide safe debugging for Facebook login, checkpoint, CAPTCHA, or selector drift failures without requesting passwords or cookies.",
    argsSchema: {
      failure_context: z
        .string()
        .min(1)
        .describe("Observed error, tool result, or user description."),
      last_tool: z
        .string()
        .optional()
        .describe("Optional last MCP tool that failed."),
      screenshot_path: z
        .string()
        .optional()
        .describe("Optional local screenshot path from the failed run.")
    }
  },
  async (input) =>
    userPrompt(
      "Debug a Facebook Marketplace MCP failure safely.",
      [
        "Help diagnose the MCP failure using local evidence only.",
        "Do not ask for the user's Facebook password, session cookie, 2FA code, or uploaded browser profile.",
        "If Facebook shows login, 2FA, CAPTCHA, checkpoint, or risk review, instruct the user to complete it manually in the opened browser.",
        "If the browser reached the expected page but automation failed, treat it as possible selector drift and suggest a narrow code inspection path.",
        "Prefer actionable next steps: retry after manual login, inspect screenshot, verify configured URLs, or update selectors.",
        "Keep account safety first and avoid bypass language.",
        "",
        "Failure context:",
        input.failure_context,
        optionalPromptLine("Last tool", input.last_tool),
        optionalPromptLine("Screenshot path", input.screenshot_path)
      ]
    )
);

server.registerTool(
  "create_listing_draft",
  {
    title: "Create Facebook Marketplace listing draft",
    description:
      "Create a local listing draft JSON file. This does not open Facebook or publish anything.",
    inputSchema: createListingDraftSchema
  },
  async (input) => {
    await ensureStorage(sharedConfig);
    const photos = input.photos ?? [];
    await assertReadableFiles(photos);

    const now = new Date().toISOString();
    const draft: ListingDraft = {
      draft_id: makeDraftId(),
      title: input.title,
      price: input.price,
      category: input.category,
      condition: input.condition,
      description: input.description,
      location: input.location ?? sharedConfig.defaultLocation ?? "",
      photos,
      tags: input.tags ?? [],
      created_at: now,
      updated_at: now,
      status: "local_draft"
    };

    const draftPath = await saveDraft(sharedConfig, draft);
    return jsonResult({
      draft_id: draft.draft_id,
      status: "saved",
      draft_path: draftPath
    });
  }
);

server.registerTool(
  "list_profiles",
  {
    title: "List configured Facebook accounts",
    description:
      "Return every configured Facebook profile this server can act as, including which one is the default.",
    inputSchema: {}
  },
  async () =>
    jsonResult({
      default_profile: registry.defaultProfileId,
      source: registry.source,
      profiles_file: registry.profilesFile,
      profiles: summarizeProfiles(registry)
    })
);

server.registerTool(
  "fill_listing_form",
  {
    title: "Fill Facebook Marketplace listing form",
    description:
      "Open Facebook Marketplace, fill a saved listing draft, save a screenshot, and stop before Publish unless a human approval token authorizes publishing.",
    inputSchema: fillListingFormSchema
  },
  async (input) => {
    const approvalToken = assertPublishAuthorized(
      input.stop_before_publish,
      input.approval_token,
      "fill_listing_form"
    );
    const draft = await loadDraft(sharedConfig, input.draft_id);
    await assertReadableFiles(draft.photos);

    return jsonResult(
      await withProfile(input.profile, (config) =>
        fillListingForm(config, draft, {
          ...browserOptionsFromInput(input),
          publish: approvalToken ? { approvalToken } : undefined
        })
      )
    );
  }
);

server.registerTool(
  "resume_listing_draft",
  {
    title: "Resume Facebook Marketplace listing draft",
    description:
      "Reload a saved draft and fill the Facebook Marketplace form again, stopping before Publish.",
    inputSchema: {
      draft_id: z.string().min(1),
      ...profileSchema,
      ...browserConnectionSchema
    }
  },
  async (input) => {
    const draft = await loadDraft(sharedConfig, input.draft_id);
    await assertReadableFiles(draft.photos);

    return jsonResult(
      await withProfile(input.profile, (config) =>
        fillListingForm(config, draft, browserOptionsFromInput(input))
      )
    );
  }
);

server.registerTool(
  "broadcast_listing_draft",
  {
    title: "Broadcast a listing draft to every Facebook account",
    description:
      "Fill one saved draft into the Marketplace form of several configured accounts at once. Every account fills in parallel; publishing, when authorized, is serialized and staggered so the same item is never pushed to all accounts in the same instant.",
    inputSchema: broadcastListingDraftSchema
  },
  async (input) => jsonResult(await broadcastListingDraft(input))
);

server.registerTool(
  "list_my_listings",
  {
    title: "List my Facebook Marketplace seller listings",
    description:
      "Open the Facebook Marketplace seller listings page, scrape visible listings, and sync local inventory.",
    inputSchema: listMyListingsSchema
  },
  async (input) =>
    jsonResult(
      await withProfile(input.profile, (config) =>
        listMyListings(config, {
          maxScrolls: input.max_scrolls,
          ...browserOptionsFromInput(input)
        })
      )
    )
);

server.registerTool(
  "get_listing_detail",
  {
    title: "Get Facebook Marketplace listing detail",
    description:
      "Open a Marketplace listing detail page, scrape visible metadata, and update local inventory.",
    inputSchema: getListingDetailSchema
  },
  async (input) =>
    jsonResult(
      await withProfile(input.profile, (config) =>
        getListingDetail(config, input.listing_id, browserOptionsFromInput(input))
      )
    )
);

server.registerTool(
  "check_marketplace_messages",
  {
    title: "Check Facebook Marketplace messages",
    description:
      "Open the Marketplace/Messenger inbox, scrape visible threads, store them locally, and return newly seen buyer messages.",
    inputSchema: checkMarketplaceMessagesSchema
  },
  async (input) =>
    jsonResult(
      await withProfile(input.profile, (config) =>
        checkMarketplaceMessages(config, {
          since: input.since,
          includeRead: input.include_read,
          maxThreads: input.max_threads,
          maxScrolls: input.max_scrolls,
          ...browserOptionsFromInput(input)
        })
      )
    )
);

server.registerTool(
  "get_message_thread",
  {
    title: "Get Facebook Marketplace message thread",
    description:
      "Open a saved Marketplace/Messenger thread, scrape visible messages, and update local message memory.",
    inputSchema: getMessageThreadSchema
  },
  async (input) =>
    jsonResult(
      await withProfile(input.profile, (config) =>
        getMessageThread(config, input.thread_id, browserOptionsFromInput(input))
      )
    )
);

server.registerTool(
  "draft_reply",
  {
    title: "Draft a Facebook Marketplace buyer reply",
    description:
      "Generate a local reply draft from a saved Marketplace/Messenger thread and classify reply risk. This never sends a message.",
    inputSchema: draftReplySchema
  },
  async (input) =>
    // Reads that account's local message store only, so it skips the browser
    // lock and never queues behind a running scrape.
    jsonResult(
      await draftReplyForThread(resolveProfileConfig(registry, input.profile), {
        threadId: input.thread_id,
        intent: input.intent,
        constraints: input.constraints
      })
    )
);

server.registerTool(
  "send_reply",
  {
    title: "Send a human-approved Facebook Marketplace buyer reply",
    description:
      "Open a saved Marketplace/Messenger thread, send a reply only when an approval token is supplied, and log the sent message locally.",
    inputSchema: sendReplySchema
  },
  async (input) =>
    jsonResult(
      await withProfile(input.profile, (config) =>
        sendReply(config, {
          threadId: input.thread_id,
          message: input.message,
          approvalToken: input.approval_token,
          ...browserOptionsFromInput(input)
        })
      )
    )
);

/**
 * Runs browser work as one account. The per-profile lock keeps two calls from
 * driving the same Chrome window (or launching it twice against a locked user
 * data directory) while leaving separate accounts free to run in parallel.
 */
async function withProfile<T>(
  profileId: string | undefined,
  fn: (config: RuntimeConfig) => Promise<T>
): Promise<T> {
  const config = resolveProfileConfig(registry, profileId);
  return withLock(config.profileId, () => fn(config));
}

/**
 * Publishing stays refused by default. It is allowed only when the caller both
 * turns off stop_before_publish and supplies a real human approval token.
 */
function assertPublishAuthorized(
  stopBeforePublish: boolean,
  approvalToken: string | undefined,
  requester: string
): string | undefined {
  if (stopBeforePublish) {
    return undefined;
  }
  if (!approvalToken) {
    throw new Error(
      `${requester} refuses to publish without a human approval token. Pass approval_token together with stop_before_publish=false, or keep stop_before_publish=true to stop at the review screen.`
    );
  }
  return normalizeApprovalToken(approvalToken, requester);
}

async function broadcastListingDraft(input: {
  draft_id: string;
  profiles?: string[];
  stop_before_publish: boolean;
  approval_token?: string;
  fill_concurrency?: number;
  publish_stagger_ms?: number;
}): Promise<BroadcastListingResult> {
  const approvalToken = assertPublishAuthorized(
    input.stop_before_publish,
    input.approval_token,
    "broadcast_listing_draft"
  );

  // Resolve every requested account before touching a browser so a typo fails
  // fast instead of half way through the fan-out.
  const targets = (input.profiles ?? [...registry.profiles.keys()]).map((profileId) =>
    resolveProfileConfig(registry, profileId)
  );
  assertDistinctTargets(targets);

  const draft = await loadDraft(sharedConfig, input.draft_id);
  await assertReadableFiles(draft.photos);

  const startedAt = new Date().toISOString();
  let publishCount = 0;
  const runPublishExclusive = <T,>(fn: () => Promise<T>): Promise<T> =>
    withLock(PUBLISH_LOCK_KEY, async () => {
      if (publishCount > 0) {
        await delay(input.publish_stagger_ms ?? randomStaggerMs());
      }
      publishCount += 1;
      return fn();
    });

  const results = await mapWithConcurrency(
    targets,
    input.fill_concurrency ?? Math.max(targets.length, 1),
    async (config): Promise<BroadcastProfileOutcome> => {
      try {
        const result = await withLock(config.profileId, () =>
          fillListingForm(config, structuredClone(draft), {
            // The draft file is shared, so per-account fill state must not be
            // written back into it.
            persistStatus: false,
            publish: approvalToken
              ? { approvalToken, runExclusive: runPublishExclusive }
              : undefined
          })
        );
        return {
          profile: config.profileId,
          label: config.label ?? null,
          status: result.status,
          screenshot_path: result.screenshot_path,
          listing_url: result.listing_url,
          error: null,
          notes: result.notes
        };
      } catch (error) {
        return {
          profile: config.profileId,
          label: config.label ?? null,
          status: "failed",
          screenshot_path: null,
          listing_url: null,
          error: error instanceof Error ? error.message : String(error),
          notes: []
        };
      }
    }
  );

  const failed = results.filter((result) => result.status === "failed").length;
  const notes: string[] = [];
  if (!approvalToken) {
    notes.push(
      "Every account stopped at its review screen. Check each open browser window and click Publish yourself."
    );
  }
  if (failed > 0) {
    notes.push(
      `${failed} of ${results.length} account(s) failed. An account that is not logged in parks on the Facebook login screen; log in there and retry just that profile.`
    );
  }

  return {
    draft_id: draft.draft_id,
    published: approvalToken !== undefined,
    succeeded: results.length - failed,
    failed,
    results,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    notes
  };
}

function assertDistinctTargets(targets: RuntimeConfig[]): void {
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.profileId)) {
      throw new Error(
        `Profile "${target.profileId}" was requested more than once. List each account at most once.`
      );
    }
    seen.add(target.profileId);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index]);
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function randomStaggerMs(): number {
  const span = PUBLISH_STAGGER_MAX_MS - PUBLISH_STAGGER_MIN_MS;
  return PUBLISH_STAGGER_MIN_MS + Math.floor(Math.random() * (span + 1));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function browserOptionsFromInput(input: {
  browser_mode?: BrowserMode;
  browser_cdp_url?: string;
}): BrowserConnectionOptions {
  return {
    browserMode: input.browser_mode,
    browserCdpUrl: input.browser_cdp_url
  };
}

function jsonResult(value: object) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ],
    structuredContent: value as { [x: string]: unknown }
  };
}

function userPrompt(description: string, lines: Array<string | undefined>) {
  return {
    description,
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: lines.filter(Boolean).join("\n")
        }
      }
    ]
  };
}

function optionalPromptLine(
  label: string,
  value: string | number | undefined
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.length === 0) return undefined;
  return `${label}: ${value}`;
}

async function main(): Promise<void> {
  // Sequential: several profiles share the drafts and photos directories, so
  // creating them one at a time avoids concurrent mkdir on the same paths.
  for (const profileConfig of registry.profiles.values()) {
    await ensureStorage(profileConfig);
    await ensureMessageStore(profileConfig);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

let shuttingDown = false;

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  await closeAllBrowserContexts();
  process.exit(exitCode);
}

process.once("SIGINT", () => {
  void shutdown(130);
});

process.once("SIGTERM", () => {
  void shutdown(0);
});

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
