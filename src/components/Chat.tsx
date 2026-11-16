import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MAX_MESSAGE_LENGTH, type Totals } from '../../shared/protocol';
import type { ChatState } from '../hooks/useChat';
import { Message, type Highlight } from './Message';

const EDITABLE = 'input, textarea, select, [contenteditable="true"]';
const MAX_INPUT_HEIGHT = 110;
/** Within this many pixels of the bottom, the list keeps following new text. */
const FOLLOW_THRESHOLD = 48;
const USAGE_HELP =
  'USD estimates supplied by Pi, not subscription charges. Session means this conversation; lifetime totals are saved on this machine. Zero can mean pricing was unavailable.';

const usageLabel = (totals: Totals) =>
  `${totals.tokens.toLocaleString()} tok · $${totals.cost.toFixed(4)}`;

export function Chat(props: {
  chat: ChatState;
  /** Shown above the conversation. */
  analysisPanel: ReactNode;
  /** The position on the board; messages about other positions are marked and their links disabled. */
  fen: string;
  onAsk: (message: string) => void;
  onHighlight: Highlight;
}) {
  const { chat, analysisPanel, fen, onAsk, onHighlight } = props;
  const { messages, usage, status, busy, queued } = chat;
  const [input, setInput] = useState('');
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

  const hint = status || '↵ to send · Shift ↵ new line';
  return (
    <aside aria-label="Companion chat">
      {analysisPanel}
      <div className="chat-heading">
        <h2>Companion</h2>
        <span className="badge">Pi / Stockfish</span>
      </div>
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
        {messages.map(message => (
          <Message
            key={message.id}
            message={message}
            current={message.fen === fen}
            onHighlight={onHighlight}
          />
        ))}
      </div>
      {!following && (
        <button className="latest-button" onClick={() => setFollowing(true)}>
          ↓ Latest
        </button>
      )}
      <form
        className="chat-footer"
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="sr-only" htmlFor="chat">
          Message the companion
        </label>
        <textarea
          ref={inputRef}
          id="chat"
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
        <div className="composer-toolbar">
          <span role="status">{queued ? `${hint} · ${queued} queued` : hint}</span>
          <div className="composer-actions">
            {busy && (
              <button type="button" onClick={chat.stop}>
                Stop
              </button>
            )}
            <button
              type="submit"
              disabled={!input.trim()}
              aria-label="Send message"
              title="Send message (Enter)"
            >
              ↵ Enter
            </button>
          </div>
        </div>
      </form>
      <div className="usage-strip" title={USAGE_HELP}>
        <span>
          Session <strong>{usageLabel(usage.session)}</strong>
        </span>
        <span>
          All time <strong>{usageLabel(usage.lifetime)}</strong>
        </span>
      </div>
    </aside>
  );
}
