// ---------------------------------------------------------------------------
// EventBus — publish/subscribe for real-time SSE events
// ---------------------------------------------------------------------------

export type RuntimeEventType =
  | 'chat:message'
  | 'chat:stream'
  | 'chat:complete'
  | 'chat:error'
  | 'gateway:inbound'
  | 'gateway:outbound'
  | 'gateway:error'
  | 'gateway:status'
  | 'job:start'
  | 'job:complete'
  | 'job:error'
  | 'session:created'
  | 'session:updated';

export interface RuntimeEvent {
  type: RuntimeEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

type Listener = (event: RuntimeEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  /** Subscribe to all events. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Publish an event to all subscribers. */
  emit(type: RuntimeEventType, data: Record<string, unknown>): void {
    const event: RuntimeEvent = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Never let a broken listener crash the emitter
      }
    }
  }

  /** Number of active subscribers. */
  get subscriberCount(): number {
    return this.listeners.size;
  }
}
