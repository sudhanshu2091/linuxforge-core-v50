/**
 * LinuxForge AI Telemetry & Observability (Server-Side).
 *
 * In-memory bounded ring buffer tracking all AI gateway invocations,
 * latencies, token consumption, schema validation results, and fallbacks.
 *
 * Secrets and credentials are NEVER recorded in telemetry.
 */

import type { AiOperationName, AiTelemetryEvent } from "./ai-contracts";

const MAX_TELEMETRY_EVENTS = 200;
const eventsBuffer: AiTelemetryEvent[] = [];

let counter = 0;

export function recordAiTelemetry(
  event: Omit<AiTelemetryEvent, "id" | "timestamp">,
): AiTelemetryEvent {
  counter += 1;
  const fullEvent: AiTelemetryEvent = {
    ...event,
    id: `telemetry-${Date.now()}-${counter}`,
    timestamp: new Date().toISOString(),
  };

  eventsBuffer.push(fullEvent);
  if (eventsBuffer.length > MAX_TELEMETRY_EVENTS) {
    eventsBuffer.shift();
  }

  return fullEvent;
}

export function getAiTelemetryEvents(filter?: {
  operation?: AiOperationName;
  success?: boolean;
  fallbackUsed?: boolean;
  provider?: string;
}): AiTelemetryEvent[] {
  return eventsBuffer.filter((event) => {
    if (filter?.operation && event.operation !== filter.operation) return false;
    if (filter?.success !== undefined && event.success !== filter.success) return false;
    if (filter?.fallbackUsed !== undefined && event.fallbackUsed !== filter.fallbackUsed) return false;
    if (filter?.provider && event.provider !== filter.provider) return false;
    return true;
  });
}

export function getLatestAiTelemetry(operation?: AiOperationName): AiTelemetryEvent | null {
  if (!operation) {
    return eventsBuffer.length > 0 ? eventsBuffer[eventsBuffer.length - 1] ?? null : null;
  }
  for (let i = eventsBuffer.length - 1; i >= 0; i--) {
    const item = eventsBuffer[i];
    if (item && item.operation === operation) {
      return item;
    }
  }
  return null;
}

export function clearAiTelemetry(): void {
  eventsBuffer.length = 0;
  counter = 0;
}
