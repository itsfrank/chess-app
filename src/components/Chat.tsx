import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { MAX_MESSAGE_LENGTH } from '../../shared/protocol';
import type { PositionInfo } from '../chess';
import type { ChatState } from '../hooks/useChat';
import { Message, type Highlight } from './Message';

const EDITABLE = 'input, textarea, select, [contenteditable="true"]';
const MAX_INPUT_HEIGHT = 110;
/** Within this many pixels of the bottom, the list keeps following new text. */
const FOLLOW_THRESHOLD = 48;
const COACH_HELP = 'Reviews every move with Stockfish. Each review uses your model subscription.';

export function Chat(props: {
  chat: ChatState;
  /** Shown above the conversation. */
  analysisPanel: ReactNode;
  /** The position on the board; messages about other positions are dimmed and their links disabled. */
  fen: string;
  /** The positions of the current game, used to head each exchange with the move it follows. */
  positions: Map<string, PositionInfo>;
  /** Shows the position after `ply` half-moves on the board. */
  onSelectPly: (ply: number) => void;
  /** Whether every move is reviewed automatically; omitted where no moves are played. */
  coach?: { on: boolean; onChange: (on: boolean) => void };
  onAsk: (message: string) => void;
  onHighlight: Highlight;
}) {
  const { chat, analysisPanel, fen, positions, onSelectPly, coach, onAsk, onHighlight } = props;
  const { status, busy, queued } = chat;
  // A review's own heading already names the move, so its "Played …" line would only repeat it.
  const messages = chat.messages.filter(
    message => message.role === 'assistant' || message.kind === 'question',
  );
  const [input, setInput] = useState('');
  /** Each screen has its own composer, and a hidden screen stays in the document. */
  const inputId = useId();
  /** Whether the list is scrolled to the end and should stay there as text streams in. */
  const [following, setFollowing] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !following) return;
    const scrollToEnd = () => (list.scrollTop = list.scrollHeight);
    scrollToEnd();
    const observer = new ResizeObserver(scrollToEnd);
    observer.observe(list);
    return () => observer.disconnect();
  }, [following, messages, status]);

  useLayoutEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [input]);

  // Typing anywhere on the page continues the draft, so the board never steals the keyboard.
  useEffect(() => {
    const resumeTyping = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
      if (!printable || event.defaultPrevented || event.isComposing) return;
      if (target.closest(EDITABLE) || window.getSelection()?.toString()) return;
      // Preserve native Space activation on buttons and links.
      if (event.key === ' ' && target.closest('button, a')) return;
      event.preventDefault();
      inputRef.current?.focus();
      setInput(previous => (previous + event.key).slice(0, MAX_MESSAGE_LENGTH));
    };
    document.addEventListener('keydown', resumeTyping);
    return () => document.removeEventListener('keydown', resumeTyping);
  }, []);

  const submit = () => {
    const message = input.trim();
    if (!message) return;
    onAsk(message);
    setInput('');
    setFollowing(true);
    inputRef.current?.focus();
  };

  return (
    <aside className="companion" aria-label="Companion">
      {analysisPanel}
      <div
        className="chat-messages"
        ref={listRef}
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={event => {
          const list = event.currentTarget;
          setFollowing(list.scrollHeight - list.clientHeight - list.scrollTop < FOLLOW_THRESHOLD);
        }}
      >
        {!messages.length && (
          <div className="companion-welcome">
            <p>Ask about this position.</p>
            <small>Hover a colored move in a reply to highlight its arrow.</small>
          </div>
        )}
        {messages.map((message, index) => {
          const position = positions.get(message.fen);
          const current = message.fen === fen;
          return (
            <Fragment key={message.id}>
              {message.fen !== messages[index - 1]?.fen && (
                <h3 className="position-heading">
                  <button
                    disabled={!position || current}
                    title={position && !current ? 'Show this position on the board' : undefined}
                    onClick={() => position && onSelectPly(position.ply)}
                  >
                    {position?.label ?? 'Another line'}
                  </button>
                  {current && <span className="label">On the board</span>}
                </h3>
              )}
              <Message message={message} current={current} onHighlight={onHighlight} />
            </Fragment>
          );
        })}
      </div>
      {!following && (
        <button className="latest-button" onClick={() => setFollowing(true)}>
          ↓ Latest
        </button>
      )}
      <form
        className="composer"
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="sr-only" htmlFor={inputId}>
          Message the companion
        </label>
        <div className="composer-field">
          <textarea
            ref={inputRef}
            id={inputId}
            rows={1}
            value={input}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder="Ask about this position…"
            onChange={event => setInput(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit();
            }}
          />
          <button
            type="submit"
            className="label"
            disabled={!input.trim()}
            title="Send message (Enter) · Shift+Enter for a new line"
          >
            ↵ Send
          </button>
        </div>
        <div className="composer-footer">
          {coach && (
            <label className="switch-label" title={COACH_HELP}>
              <input
                type="checkbox"
                className="switch"
                checked={coach.on}
                onChange={event => coach.onChange(event.target.checked)}
              />
              Coach every move
            </label>
          )}
          <span role="status">{queued ? `${status} · ${queued} queued` : status}</span>
          {busy && (
            <button type="button" onClick={chat.stop}>
              Stop
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}
