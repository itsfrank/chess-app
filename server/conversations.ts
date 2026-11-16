import { HttpError } from './http.ts';

/**
 * A bounded set of conversations. When full, the least recently used idle one
 * is disposed to make room, so reloading the page never exhausts the limit.
 */
export class ConversationStore<T extends { touched: number }> {
  private readonly items = new Map<string, T>();
  private readonly max: number;
  private readonly isBusy: (item: T) => boolean;
  private readonly dispose: (item: T) => void;

  constructor(options: { max: number; isBusy: (item: T) => boolean; dispose: (item: T) => void }) {
    this.max = options.max;
    this.isBusy = options.isBusy;
    this.dispose = options.dispose;
  }

  get(id: string) {
    return this.items.get(id);
  }

  add(id: string, create: () => T): T {
    if (this.items.size >= this.max) this.evict();
    const item = create();
    this.items.set(id, item);
    return item;
  }

  disposeAll() {
    for (const item of this.items.values()) this.dispose(item);
    this.items.clear();
  }

  private evict() {
    let oldest: [string, T] | undefined;
    for (const entry of this.items) {
      if (!this.isBusy(entry[1]) && (!oldest || entry[1].touched < oldest[1].touched))
        oldest = entry;
    }
    if (!oldest) throw new HttpError(503, 'Too many active conversations; try again shortly');
    this.dispose(oldest[1]);
    this.items.delete(oldest[0]);
  }
}
