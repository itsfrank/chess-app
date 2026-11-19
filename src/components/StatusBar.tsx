import type { ReactNode } from 'react';
import type { Totals } from '../../shared/protocol';

const USAGE_HELP =
  'USD estimates supplied by Pi, not subscription charges. Session means this conversation; lifetime totals are saved on this machine. Zero can mean pricing was unavailable.';

const usageLabel = (totals: Totals) =>
  `${totals.tokens.toLocaleString()} tok · $${totals.cost.toFixed(4)}`;

/** The strip along the bottom of the window: the position's FEN and what the companion has cost. */
export function StatusBar(props: {
  /** Shown first, before the FEN. */
  lead?: ReactNode;
  fen: string;
  usage: { session: Totals; lifetime: Totals };
  /** The latest announcement about the game, read out by screen readers. */
  notice: string;
}) {
  const { lead, fen, usage, notice } = props;
  return (
    <footer className="status-bar">
      {lead}
      <span>FEN</span>
      <code>{fen}</code>
      <p className="sr-only" role="status">
        {notice}
      </p>
      <span className="usage" title={USAGE_HELP}>
        Session {usageLabel(usage.session)}
      </span>
      <span title={USAGE_HELP}>All time ${usage.lifetime.cost.toFixed(2)}</span>
    </footer>
  );
}
