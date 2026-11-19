import { Fragment, useEffect, useEffectEvent, useRef } from 'react';
import { Icon } from './Icon';

const EDITABLE = 'input, textarea, select, [contenteditable="true"]';

/** `ply` is the number of half-moves shown; equal to `moves.length` at the live position. */
type Props = { moves: string[]; ply: number; onSelect: (ply: number) => void };

/** Steps through the game so far with buttons or the Left/Right keys. */
export function HistoryNavigation({
  moves,
  ply,
  onSelect,
  endLabel = 'Return to live game',
}: Props & { /** Names the button that jumps to the last position. */ endLabel?: string }) {
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
    <div className="history-navigation" role="group" aria-label="History navigation">
      <button
        aria-label="Start of game"
        title="Start of game"
        disabled={ply === 0}
        onClick={() => onSelect(0)}
      >
        <Icon name="first" />
      </button>
      <button
        aria-label="Previous move"
        title="Previous move (Left arrow)"
        disabled={ply === 0}
        onClick={() => onSelect(ply - 1)}
      >
        <Icon name="left" />
      </button>
      <span
        className={live ? undefined : 'reviewing'}
        title={live ? 'Live position' : 'Reviewing an earlier position'}
      >
        {ply} / {moves.length}
      </span>
      <button
        aria-label="Next move"
        title="Next move (Right arrow)"
        disabled={live}
        onClick={() => onSelect(ply + 1)}
      >
        <Icon name="right" />
      </button>
      <button
        aria-label={endLabel}
        title={endLabel}
        disabled={live}
        onClick={() => onSelect(moves.length)}
      >
        <Icon name="last" />
      </button>
    </div>
  );
}

/** A verdict shown beside a move: a short glyph, styled by `className` and explained by `title`. */
export type MoveMark = { glyph: string; className: string; title: string };

/** The moves played so far as a scoresheet; selecting one shows the position after it. */
export function MoveList({
  moves,
  ply,
  onSelect,
  marks,
}: Props & {
  /** One entry per move, where there is something to say about it. */ marks?: (
    MoveMark | undefined
  )[];
}) {
  const live = ply === moves.length;
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const current = element.querySelector<HTMLElement>('[aria-current]');
    if (live) element.scrollTop = element.scrollHeight;
    else if (current) element.scrollTop = current.offsetTop - element.offsetTop;
  }, [moves, ply, live]);

  return (
    <aside className="move-list" aria-label="Move history">
      <h2 className="label">Moves</h2>
      {moves.length ? (
        <div ref={list} className="move-rows">
          {moves.map((san, index) => (
            <Fragment key={index}>
              {index % 2 === 0 && <span>{index / 2 + 1}</span>}
              <button
                aria-current={ply === index + 1 ? 'step' : undefined}
                className={marks?.[index]?.className}
                title={marks?.[index]?.title}
                onClick={() => onSelect(index + 1)}
              >
                {san}
                {marks?.[index]?.glyph && <i>{marks[index].glyph}</i>}
              </button>
            </Fragment>
          ))}
        </div>
      ) : (
        <p>No moves yet.</p>
      )}
    </aside>
  );
}
