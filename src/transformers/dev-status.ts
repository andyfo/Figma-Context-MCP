import type { DevStatusTrait } from "@figma/rest-api-spec";

type RawDevStatus = NonNullable<DevStatusTrait["devStatus"]>;

export interface SimplifiedDevStatus {
  type: "READY_FOR_DEV" | "COMPLETED";
  // The designer's handoff note ("what changed"), when they left one.
  description?: string;
}

// The API sends `devStatus: null` for frames that never had a status, so the
// key being present isn't enough.
export function isDevStatus(val: unknown): val is RawDevStatus {
  return typeof val === "object" && val !== null && "type" in val;
}

/**
 * `NONE` is how the API spells "no status" (a status that was set and then
 * cleared), so it's dropped like any other default.
 */
export function simplifyDevStatus(status: RawDevStatus): SimplifiedDevStatus | undefined {
  if (status.type === "NONE") return undefined;
  return {
    type: status.type,
    ...(status.description && { description: status.description }),
  };
}
