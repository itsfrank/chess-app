import { memo, useMemo } from 'react';
import Markdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ANNOTATION_PREFIX } from '../../shared/san';
import { remarkMoveLinks } from '../annotations';
import type { Message as ChatMessage } from '../hooks/useChat';

/** Highlights one of a message's arrows on the board, or clears the highlight when `arrowId` is null. */
export type Highlight = (message: ChatMessage, arrowId: string | null) => void;

/**
 * One chat message. Memoised because every streamed token re-renders the
 * list, and parsing Markdown for all earlier messages each time is wasteful.
 */
export const Message = memo(function Message(props: {
  message: ChatMessage;
  /** Whether the board currently shows the position this message discusses. */
  current: boolean;
  onHighlight: Highlight;
}) {
  const { message, current, onHighlight } = props;

  const plugins = useMemo<Options['remarkPlugins']>(
    () => [remarkGfm, [remarkMoveLinks, { fen: message.fen, arrows: message.arrows }]],
    [message.fen, message.arrows],
  );
  const components = useMemo<Components>(
    () => ({
      table: ({ children }) => (
        <div className="markdown-table">
          <table>{children}</table>
        </div>
      ),
      // Only arrow links become interactive; any other link from the model renders as plain text.
      a: ({ href, children }) => {
        // The model sometimes shortens "#annotation-ID" to "#ID".
        const id = href?.startsWith(ANNOTATION_PREFIX)
          ? href.slice(ANNOTATION_PREFIX.length)
          : href?.startsWith('#')
            ? href.slice(1)
            : null;
        const arrow = message.arrows.find(candidate => candidate.id === id);
        if (!arrow) return <span>{children}</span>;
        const show = () => onHighlight(message, arrow.id);
        const hide = () => onHighlight(message, null);
        return (
          <button
            className="move-reference"
            style={{ color: arrow.color }}
            disabled={!current}
            onMouseEnter={show}
            onMouseLeave={hide}
            onFocus={show}
            onBlur={hide}
            onClick={show}
          >
            {children}
          </button>
        );
      },
    }),
    [message, current, onHighlight],
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
