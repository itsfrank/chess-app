import { expect, it } from 'vitest';
import { ConversationStore } from './conversations.ts';

type Item = { name: string; touched: number; busy: boolean };

it('evicts the least recently used idle conversation when full', () => {
  const disposed: string[] = [];
  const store = new ConversationStore<Item>({
    max: 2,
    isBusy: item => item.busy,
    dispose: item => disposed.push(item.name),
  });
  const add = (name: string, touched: number, busy = false) =>
    store.add(name, () => ({ name, touched, busy }));

  add('old', 1);
  add('busy', 0, true);
  add('new', 2);
  expect(disposed).toEqual(['old']);
  expect(store.get('old')).toBeUndefined();
  expect(store.get('busy')).toBeDefined();

  store.get('new')!.busy = true;
  expect(() => add('overflow', 3)).toThrow('Too many active conversations');
  store.disposeAll();
  expect(disposed).toEqual(['old', 'busy', 'new']);
});
