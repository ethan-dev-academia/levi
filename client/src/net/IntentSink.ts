import { IntentSchema, type Intent } from "@levi/shared";

/**
 * The ONLY path from player input to game state. Input code builds intents
 * and calls send(); it never mutates entities directly.
 */
export interface IntentSink {
  send(intent: Intent): void;
}

/** Offline sink: validates exactly like the server will, then applies locally. */
export class LocalIntentSink implements IntentSink {
  constructor(private readonly apply: (intent: Intent) => void) {}

  send(intent: Intent): void {
    const parsed = IntentSchema.safeParse(intent);
    if (parsed.success) this.apply(parsed.data);
  }
}
