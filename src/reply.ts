import type {
  MarketplaceMessageRecord,
  MessageThreadRecord,
  ReplyConstraints,
  ReplyRiskLevel
} from "./types.js";

export interface ReplyDraftContext {
  thread: MessageThreadRecord;
  messages: MarketplaceMessageRecord[];
  intent: string;
  constraints: ReplyConstraints;
}

export interface ReplyRisk {
  level: ReplyRiskLevel;
  reasons: string[];
}

const MEDIUM_RISK_KEYS = [
  "min_price",
  "price",
  "hold",
  "delivery",
  "meeting_time",
  "meet_time",
  "phone",
  "address"
];

const HIGH_RISK_PATTERN =
  /\b(zelle|venmo|cash\s*app|paypal|apple\s*cash|deposit|prepay|wire|bank|routing|account number|full address|home address|come to my house|refund|dispute|scam)\b/i;

const MEDIUM_RISK_PATTERN =
  /\b(\$\s*\d+|price|offer|lowest|hold|deliver|delivery|meet|meeting|tonight|tomorrow|phone|call|text me|address)\b/i;

export function draftReply(context: ReplyDraftContext): string {
  const intent = normalizeIntent(context.intent);
  const latestBuyerMessage = [...context.messages].reverse().find(
    (message) => message.role === "buyer"
  );
  const constraints = context.constraints;
  const parts: string[] = [];

  if (intent === "availability" || mentionsAvailability(latestBuyerMessage?.text)) {
    parts.push("Yes, it is still available.");
  } else if (intent === "condition") {
    parts.push("It is in the condition described in the listing.");
  } else if (intent === "dimensions") {
    const dimensions = stringConstraint(constraints, "dimensions");
    parts.push(dimensions ? `The dimensions are ${dimensions}.` : "I can confirm the dimensions for you.");
  } else if (intent === "price_negotiation") {
    const minPrice = numberConstraint(constraints, "min_price");
    parts.push(
      minPrice === undefined
        ? "I am open to a reasonable offer."
        : `I can do $${formatPrice(minPrice)}.`
    );
  } else {
    parts.push("Thanks for reaching out.");
  }

  if (booleanConstraint(constraints, "pickup_only")) {
    parts.push("Pickup only.");
  }

  const pickupArea = stringConstraint(constraints, "pickup_area");
  if (pickupArea) {
    parts.push(`Pickup is near ${pickupArea}.`);
  }

  const availabilityWindow = stringConstraint(constraints, "availability_window");
  if (availabilityWindow) {
    parts.push(`I am available ${availabilityWindow}.`);
  }

  const customNote = stringConstraint(constraints, "note");
  if (customNote) {
    parts.push(customNote);
  }

  return parts.join(" ");
}

export function classifyReplyRisk(
  message: string,
  constraints: ReplyConstraints = {}
): ReplyRisk {
  const reasons: string[] = [];
  const searchable = [
    message,
    ...Object.entries(constraints).map(([key, value]) => `${key}: ${String(value)}`)
  ].join("\n");

  if (HIGH_RISK_PATTERN.test(searchable)) {
    reasons.push("Message or constraints mention payment, deposit, address, or dispute-sensitive content.");
  }

  const mediumKeys = Object.keys(constraints).filter((key) =>
    MEDIUM_RISK_KEYS.includes(key.toLowerCase())
  );
  if (mediumKeys.length > 0) {
    reasons.push(`Constraints include medium-risk field(s): ${mediumKeys.join(", ")}.`);
  }

  if (MEDIUM_RISK_PATTERN.test(searchable)) {
    reasons.push("Message or constraints mention price, hold, delivery, contact, or scheduling details.");
  }

  if (reasons.some((reason) => /payment|deposit|address|dispute/i.test(reason))) {
    return { level: "high", reasons };
  }

  if (reasons.length > 0) {
    return { level: "medium", reasons };
  }

  return {
    level: "low",
    reasons: ["Availability, pickup-only, broad location, dimensions, and condition replies are low risk."]
  };
}

function normalizeIntent(intent: string): string {
  return intent.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function mentionsAvailability(value: string | undefined): boolean {
  return /\b(still available|available|is this available)\b/i.test(value ?? "");
}

function stringConstraint(
  constraints: ReplyConstraints,
  key: string
): string | undefined {
  const value = constraints[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberConstraint(
  constraints: ReplyConstraints,
  key: string
): number | undefined {
  const value = constraints[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanConstraint(
  constraints: ReplyConstraints,
  key: string
): boolean {
  return constraints[key] === true;
}

function formatPrice(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
