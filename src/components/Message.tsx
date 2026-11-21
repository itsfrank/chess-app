import { memo, useMemo } from 'react';
import Markdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { decodeVariation, parseAnnotationHref } from '../../shared/san';
import { legalMoveForArrow, remarkMoveLinks } from '../annotations';
import type { Message as ChatMessage } from '../hooks/useChat';

/** Highlights one of a message's arrows on the board, or clears the highlight when `arrowId` is null. */
export type Highlight = (message: ChatMessage, arrowId: string | null) => void;

/** Plays a SAN variation starting from `fen` and lands on 1-based `step`. */
export type PlayVariation = (fen: string, moves: string[], step: number) => void;

/**
 * One chat message. Memoised because every streamed token re-renders the
 * list, and parsing Markdown for all earlier messages each time is wasteful.
 */
export const Message = memo(function Message(props: {
  message: ChatMessage;
  /** Whether the board currently shows the position this message discusses. */
  current: boolean;
  /** Whether clicking variations from this message's position can play on the board. */
  playable?: boolean;
  onHighlight: Highlight;
  onPlayVariation?: PlayVariation;
}) {
  const { message, current, playable = false, onHighlight, onPlayVariation } = props;
  const allowVariations = Boolean(onPlayVariation);

  const plugins = useMemo<Options['remarkPlugins']>(
    () => [
      remarkGfm,
      [remarkMoveLinks, { fen: message.fen, arrows: message.arrows, variations: allowVariations }],
    ],
    [message.fen, message.arrows, allowVariations],
  );
  const components = useMemo<Components>(
    () => ({
      table: ({ children }) => (
        <div className="markdown-table">
          <table>{children}</table>
        </div>
      ),
      // Only arrow and variation links become interactive; any other link from the model renders as plain text.
      a: ({ href, children }) => {
        const variation = href ? decodeVariation(href) : null;
        if (variation && onPlayVariation) {
          return (
            <button
              type="button"
              className="variation-move"
              disabled={!playable}
              title={playable ? 'Play on the board' : undefined}
              onClick={() => onPlayVariation(message.fen, variation.moves, variation.step)}
            >
              {children}
            </button>
          );
        }

        const parsed = parseAnnotationHref(href);
        const arrow = parsed
          ? message.arrows.find(candidate => candidate.id === parsed.id)
          : undefined;
        if (!arrow) return <span>{children}</span>;

        const playLine = onPlayVariation
          ? (parsed?.variation ??
            (() => {
              const san = legalMoveForArrow(message.fen, arrow);
              return san ? { moves: [san], step: 1 } : null;
            })())
          : null;
        const canPlay = Boolean(onPlayVariation && playable && playLine);
        const show = () => current && onHighlight(message, arrow.id);
        const hide = () => current && onHighlight(message, null);
        return (
          <button
            type="button"
            className="move-reference"
            style={{ color: arrow.color }}
            disabled={!current && !canPlay}
            title={
              canPlay
                ? current
                  ? 'Hover to highlight · Click to play on the board'
                  : 'Play on the board'
                : undefined
            }
            onMouseEnter={current ? show : undefined}
            onMouseLeave={current ? hide : undefined}
            onFocus={current ? show : undefined}
            onBlur={current ? hide : undefined}
            onClick={() => {
              if (canPlay && playLine && onPlayVariation) {
                onHighlight(message, null);
                onPlayVariation(message.fen, playLine.moves, playLine.step);
              } else {
                show();
              }
            }}
          >
            {children}
          </button>
        );
      },
    }),
    [message, current, playable, onHighlight, onPlayVariation],
  );

  return (
    <article className={`message message-${message.role}${current ? '' : ' past'}`}>
      {message.role === 'user' && <span className="label">You</span>}
      <Markdown remarkPlugins={plugins} components={components}>
        {message.text}
      </Markdown>
      {message.error && (
        <p role="alert" className="context-note">
          {message.error}
        </p>
      )}
    </article>
  );
});
