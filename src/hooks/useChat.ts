import { useEffect, useRef, useState } from 'react';
import type { Annotation, GameContext, PlayerColor, Snapshot, Totals } from '../../shared/protocol';
import { fetchLifetimeUsage, streamChat } from '../api';

export type Message = {
  id: number;
  role: 'user' | 'assistant';
  /** Whether the turn was typed by the user or is an automatic move review. */
  kind: 'question' | 'review';
  text: string;
  /** The position this message is about; its arrows only make sense there. */
  fen: string;
  arrows: Annotation[];
  error?: string;
};
type Turn = {
  kind: 'question' | 'review';
  /** Sent to the model. */
  message: string;
  /** Shown in the chat as the user's side of the turn. */
  label: string;
  snapshot: Snapshot;
  playerColor: PlayerColor;
  /** The finished game the position belongs to, when reviewing one. */
  game?: GameContext;
};

const reviewPrompt = (move: string) =>
  `The latest move was ${move}. Identify which side played it from the history, then briefly review the move and current position using Stockfish. Highlight one useful idea with arrows when appropriate.`;

/**
 * The companion conversation. Turns run strictly one at a time: questions and
 * automatic move reviews wait in a queue, with questions ahead of reviews.
 */
export function useChat({
  onArrows,
}: {
  /** Called as arrows arrive; must keep the same identity across renders. */
  onArrows: (fen: string, arrows: Annotation[]) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [usage, setUsage] = useState({
    session: { tokens: 0, cost: 0 },
    lifetime: { tokens: 0, cost: 0 },
  });
  /** Progress of the running turn; empty when idle. */
  const [status, setStatus] = useState('');
  const [queued, setQueued] = useState(0);

  const queue = useRef<Turn[]>([]);
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const conversationId = useRef<string | undefined>(undefined);
  const nextId = useRef(0);

  useEffect(() => {
    const abort = new AbortController();
    fetchLifetimeUsage(abort.signal)
      .then((lifetime: Totals) => setUsage(previous => ({ ...previous, lifetime })))
      .catch(() => {}); // The totals are informational; the chat works without them.
    return () => abort.abort();
  }, []);

  async function run(turn: Turn) {
    const { fen } = turn.snapshot;
    const questionId = nextId.current++;
    const answerId = nextId.current++;
    const patch = (change: (message: Message) => Message) =>
      setMessages(previous =>
        previous.map(message => (message.id === answerId ? change(message) : message)),
      );
    setMessages(previous => [
      ...previous,
      { id: questionId, role: 'user', kind: turn.kind, text: turn.label, fen, arrows: [] },
      { id: answerId, role: 'assistant', kind: turn.kind, text: '', fen, arrows: [] },
    ]);
    setStatus('Thinking…');
    onArrows(fen, []);
    controller.current = new AbortController();
    try {
      const request = {
        ...turn.snapshot,
        message: turn.message,
        playerColor: turn.playerColor,
        game: turn.game,
        conversationId: conversationId.current,
      };
      for await (const event of streamChat(request, controller.current.signal)) {
        switch (event.type) {
          case 'conversation':
            conversationId.current = event.id;
            break;
          case 'text':
            patch(message => ({ ...message, text: message.text + event.delta }));
            setStatus('Responding…');
            break;
          case 'replace_text':
            patch(message => ({ ...message, text: event.text }));
            break;
          case 'arrows':
            patch(message => ({ ...message, arrows: event.arrows }));
            onArrows(fen, event.arrows);
            break;
          case 'usage':
            setUsage({ session: event.session, lifetime: event.lifetime });
            break;
          case 'status':
            setStatus(event.text);
            break;
          case 'error':
            throw new Error(event.message);
        }
      }
    } catch (error) {
      const stopped = error instanceof Error && error.name === 'AbortError';
      const text = stopped ? 'Stopped.' : error instanceof Error ? error.message : String(error);
      patch(message => ({ ...message, error: text }));
    } finally {
      controller.current = null;
    }
  }

  async function drain() {
    if (running.current) return;
    running.current = true;
    for (let turn = queue.current.shift(); turn; turn = queue.current.shift()) {
      setQueued(queue.current.length);
      await run(turn);
    }
    running.current = false;
    setStatus('');
  }

  function enqueue(turn: Turn) {
    const reviews = queue.current.findIndex(queuedTurn => queuedTurn.kind === 'review');
    const index = turn.kind === 'question' && reviews >= 0 ? reviews : queue.current.length;
    queue.current.splice(index, 0, turn);
    setQueued(queue.current.length);
    void drain();
  }

  return {
    messages,
    usage,
    status,
    busy: status !== '',
    queued,
    /** Asks about `snapshot`; `label` is shown as the question when `message` is a longer brief. */
    ask: (
      message: string,
      snapshot: Snapshot,
      playerColor: PlayerColor,
      game?: GameContext,
      label = message,
    ) => enqueue({ kind: 'question', message, label, snapshot, playerColor, game }),
    /** Queues an automatic review of the move that led to `snapshot`. */
    review: (snapshot: Snapshot, playerColor: PlayerColor) => {
      const move = snapshot.moves.at(-1);
      if (move)
        enqueue({
          kind: 'review',
          message: reviewPrompt(move),
          label: `Played ${move}`,
          snapshot,
          playerColor,
        });
    },
    stop: () => controller.current?.abort(),
  };
}
export type ChatState = ReturnType<typeof useChat>;
