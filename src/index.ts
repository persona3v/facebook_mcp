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
  message: z.string().min(1).max(2000),
  approval_token: z.string().min(8)
};

const server = new McpServer({
  name: "facebook-marketplace-assistant-mcp",
  version: "0.1.0"
});

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
