import type { PlayerColor } from '../shared/protocol';

/** Request to open the Board tab at an exact game/drill position sparring against Maia3. */
export type SparRequest = {
  id: number;
  /** SAN moves from the starting position to the sparring starting point. */
  moves: string[];
  playerColor: PlayerColor;
  elo: number;
  /** Short description shown in the status bar, e.g. "Italian Game · after 12. Nd5". */
  label?: string;
};
