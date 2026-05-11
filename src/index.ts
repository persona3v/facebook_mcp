#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { fillListingForm } from "./facebook.js";
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
