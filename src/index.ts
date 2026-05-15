#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import {
  checkMarketplaceMessages,
  closeBrowserContext,
  draftReplyForThread,
  fillListingForm,
  getMessageThread,
  getListingDetail,
  listMyListings,
  sendReply
} from "./facebook.js";
import { ensureMessageStore } from "./messageStore.js";
import {
  assertReadableFiles,
  ensureStorage,
  loadDraft,
  makeDraftId,
  saveDraft
} from "./storage.js";
import type { ListingDraft } from "./types.js";

const config = loadConfig();

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

const fillListingFormSchema = {
  draft_id: z.string().min(1),
  stop_before_publish: z.boolean().default(true)
};

const listMyListingsSchema = {
  max_scrolls: z.number().int().min(0).max(10).default(3)
};

const getListingDetailSchema = {
  listing_id: z.string().min(1)
};

const checkMarketplaceMessagesSchema = {
  since: z.string().min(1).default("last_check"),
  include_read: z.boolean().default(false),
  max_threads: z.number().int().min(1).max(100).default(20),
  max_scrolls: z.number().int().min(0).max(10).default(3)
};

const getMessageThreadSchema = {
  thread_id: z.string().min(1)
};

const draftReplySchema = {
  thread_id: z.string().min(1),
  intent: z.string().min(1).default("availability"),
  constraints: z.record(z.unknown()).default({})
};

const sendReplySchema = {
  thread_id: z.string().min(1),
  message: z.string().trim().min(1).max(2000),
  approval_token: z.string().trim().min(8)
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
        "Do not publish. Do not click Publish. If the user later asks to fill the form, call fill_listing_form with stop_before_publish=true.",
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
        "Never publish automatically. Tell the user they must manually review Facebook's final screen and click Publish themselves.",
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
    await ensureStorage(config);
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
      location: input.location ?? config.defaultLocation ?? "",
      photos,
      tags: input.tags ?? [],
      created_at: now,
      updated_at: now,
      status: "local_draft"
    };

    const draftPath = await saveDraft(config, draft);
    return jsonResult({
      draft_id: draft.draft_id,
      status: "saved",
      draft_path: draftPath
    });
  }
);

server.registerTool(
  "fill_listing_form",
  {
    title: "Fill Facebook Marketplace listing form",
    description:
      "Open Facebook Marketplace, fill a saved listing draft, save a screenshot, and stop before Publish.",
    inputSchema: fillListingFormSchema
  },
  async (input) => {
    assertStopBeforePublish(input.stop_before_publish);
    const draft = await loadDraft(config, input.draft_id);
    await assertReadableFiles(draft.photos);
    const result = await fillListingForm(config, draft);
    return jsonResult(result);
  }
);

server.registerTool(
  "resume_listing_draft",
  {
    title: "Resume Facebook Marketplace listing draft",
    description:
      "Reload a saved draft and fill the Facebook Marketplace form again, stopping before Publish.",
    inputSchema: {
      draft_id: z.string().min(1)
    }
  },
  async (input) => {
    const draft = await loadDraft(config, input.draft_id);
    await assertReadableFiles(draft.photos);
    const result = await fillListingForm(config, draft);
    return jsonResult(result);
  }
);

server.registerTool(
  "list_my_listings",
  {
    title: "List my Facebook Marketplace seller listings",
    description:
      "Open the Facebook Marketplace seller listings page, scrape visible listings, and sync local inventory.",
    inputSchema: listMyListingsSchema
  },
  async (input) => {
    const result = await listMyListings(config, {
      maxScrolls: input.max_scrolls
    });
    return jsonResult(result);
  }
);

server.registerTool(
  "get_listing_detail",
  {
    title: "Get Facebook Marketplace listing detail",
    description:
      "Open a Marketplace listing detail page, scrape visible metadata, and update local inventory.",
    inputSchema: getListingDetailSchema
  },
  async (input) => {
    const result = await getListingDetail(config, input.listing_id);
    return jsonResult(result);
  }
);

server.registerTool(
  "check_marketplace_messages",
  {
    title: "Check Facebook Marketplace messages",
    description:
      "Open the Marketplace/Messenger inbox, scrape visible threads, store them locally, and return newly seen buyer messages.",
    inputSchema: checkMarketplaceMessagesSchema
  },
  async (input) => {
    const result = await checkMarketplaceMessages(config, {
      since: input.since,
      includeRead: input.include_read,
      maxThreads: input.max_threads,
      maxScrolls: input.max_scrolls
    });
    return jsonResult(result);
  }
);

server.registerTool(
  "get_message_thread",
  {
    title: "Get Facebook Marketplace message thread",
    description:
      "Open a saved Marketplace/Messenger thread, scrape visible messages, and update local message memory.",
    inputSchema: getMessageThreadSchema
  },
  async (input) => {
    const result = await getMessageThread(config, input.thread_id);
    return jsonResult(result);
  }
);

server.registerTool(
  "draft_reply",
  {
    title: "Draft a Facebook Marketplace buyer reply",
    description:
      "Generate a local reply draft from a saved Marketplace/Messenger thread and classify reply risk. This never sends a message.",
    inputSchema: draftReplySchema
  },
  async (input) => {
    const result = await draftReplyForThread(config, {
      threadId: input.thread_id,
      intent: input.intent,
      constraints: input.constraints
    });
    return jsonResult(result);
  }
);

server.registerTool(
  "send_reply",
  {
    title: "Send a human-approved Facebook Marketplace buyer reply",
    description:
      "Open a saved Marketplace/Messenger thread, send a reply only when an approval token is supplied, and log the sent message locally.",
    inputSchema: sendReplySchema
  },
  async (input) => {
    const result = await sendReply(config, {
      threadId: input.thread_id,
      message: input.message,
      approvalToken: input.approval_token
    });
    return jsonResult(result);
  }
);

function assertStopBeforePublish(stopBeforePublish: boolean): void {
  if (!stopBeforePublish) {
    throw new Error(
      "Phase 1 refuses automatic publishing. Call fill_listing_form with stop_before_publish=true."
    );
  }
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
  await ensureStorage(config);
  await ensureMessageStore(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

let shuttingDown = false;

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  await closeBrowserContext();
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
