import { useEffect, useEffectEvent, useRef } from 'react';
import { Icon } from './Icon';

const EDITABLE = 'input, textarea, select, [contenteditable="true"]';

/** `ply` is the number of half-moves shown; equal to `moves.length` at the live position. */
type Props = { moves: string[]; ply: number; onSelect: (ply: number) => void };

/** Steps through the game so far with buttons or the Left/Right keys. */
export function HistoryNavigation({ moves, ply, onSelect }: Props) {
  const live = ply === moves.length;

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    // Leave the arrow keys alone where they move a text cursor or change a selection.
    if ((event.target as HTMLElement).closest(EDITABLE)) return;
    event.preventDefault();
    onSelect(Math.max(0, Math.min(moves.length, ply + (event.key === 'ArrowLeft' ? -1 : 1))));
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  return (
    <div className="history-navigation" aria-label="History navigation">
      <button
        aria-label="Previous move"
        title="Previous move (Left arrow)"
        disabled={ply === 0}
        onClick={() => onSelect(ply - 1)}
      >
        <Icon name="left" />
      </button>
      <span>{live ? 'Live position' : `${ply} / ${moves.length} plies · review only`}</span>
      <button
        aria-label="Next move"
        title="Next move (Right arrow)"
        disabled={live}
        onClick={() => onSelect(ply + 1)}
      >
        <Icon name="right" />
      </button>
      {!live && <button onClick={() => onSelect(moves.length)}>Return to live game</button>}
    </div>
  );
}

/** The moves played so far; selecting one shows the position after it. */
export function MoveList({ moves, ply, onSelect }: Props) {
  const live = ply === moves.length;
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const current = element.querySelector<HTMLElement>('[aria-current]');
    if (live) element.scrollTop = element.scrollHeight;
    else if (current) element.scrollTop = current.offsetTop - element.offsetTop;
  }, [moves, ply, live]);

  if (!moves.length) return null;
  return (
    <div ref={list} className="game-moves" aria-label="Move history">
      {moves.map((san, index) => (
        <button
          key={index}
          aria-current={ply === index + 1 ? 'step' : undefined}
          onClick={() => onSelect(index + 1)}
        >
          {index % 2 === 0 && `${index / 2 + 1}. `}
          {san}
        </button>
      ))}
    </div>
  );
}
