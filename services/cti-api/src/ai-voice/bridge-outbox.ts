/**
 * Messages waiting for the OpenAI socket (before the bridge starts, or while
 * the socket is still connecting). Bounded: past OUTBOX_MAX the oldest
 * droppable entry (caller audio) is discarded; configuration and conversation
 * items are never dropped. `onOverflow` fires once, the first time audio is
 * dropped.
 */

export const OUTBOX_MAX = 500;

interface Entry {
  data: string;
  droppable: boolean;
}

export class Outbox {
  private entries: Entry[] = [];
  private overflowed = false;

  constructor(
    private readonly onOverflow: () => void,
    private readonly max: number = OUTBOX_MAX,
  ) {}

  push(data: string, droppable: boolean): void {
    const kept = this.entries.length >= this.max ? this.dropOldestDroppable() : this.entries;
    this.entries = [...kept, { data, droppable }];
  }

  /** Put a message ahead of everything queued (`session.update`). */
  prepend(data: string): void {
    this.entries = [{ data, droppable: false }, ...this.entries];
  }

  /** Take everything queued, oldest first. */
  drain(): string[] {
    const out = this.entries.map((e) => e.data);
    this.entries = [];
    return out;
  }

  clear(): void {
    this.entries = [];
  }

  private dropOldestDroppable(): Entry[] {
    const i = this.entries.findIndex((e) => e.droppable);
    if (i < 0) return this.entries;
    if (!this.overflowed) {
      this.overflowed = true;
      this.onOverflow();
    }
    return [...this.entries.slice(0, i), ...this.entries.slice(i + 1)];
  }
}
