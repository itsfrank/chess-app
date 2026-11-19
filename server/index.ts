import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createApp } from './app.ts';
import { ChatService } from './chat.ts';
import { MODEL_PROVIDER, PORT, SETTINGS_FILE } from './config.ts';
import { GameReviewService } from './game-review.ts';
import { MaiaOpponent } from './opponent.ts';
import { Replay } from './recording.ts';
import { RepertoireService } from './repertoires.ts';
import { SettingsStore } from './settings.ts';
import { loadTotals } from './usage.ts';

/** Model, engines and conversations for live use; a replay server needs none of them. */
async function liveServices(gameReview: GameReviewService) {
  const modelRuntime = await ModelRuntime.create();
  // Not fatal: the model can be changed in the settings, which need the backend running.
  if (!modelRuntime.getModel(MODEL_PROVIDER, settings.current.model)) {
    console.warn(`Pi model ${MODEL_PROVIDER}/${settings.current.model} is unavailable.`);
  }
  const lifetime = loadTotals();
  return {
    lifetime,
    chat: new ChatService({
      modelRuntime,
      settings,
      lifetime,
      reviewGame: moves => gameReview.summary(moves),
    }),
    opponent: new MaiaOpponent(),
  };
}

const settings = new SettingsStore(SETTINGS_FILE);
/** Game review uses only Stockfish, so like the repertoires it also works beside a replay. */
const gameReview = new GameReviewService({ depth: () => settings.current.gameReviewDepth });
const replayLog = process.env.REPLAY_LOG;
const services = replayLog
  ? { lifetime: loadTotals(), replay: new Replay(replayLog), chat: undefined, opponent: undefined }
  : await liveServices(gameReview);
/** Repertoire analysis uses only Stockfish and Lichess, so it also works beside a replay. */
const repertoires = new RepertoireService({ depth: () => settings.current.repertoireDepth });
const server = createApp({ ...services, repertoires, gameReview, settings });

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Chess API: http://127.0.0.1:${PORT}${replayLog ? ' (offline replay)' : ''}`);
});

const shutdown = () => {
  services.opponent?.close();
  services.chat?.dispose();
  repertoires.dispose();
  gameReview.dispose();
  server.close();
  // Streaming responses would otherwise keep the process alive.
  server.closeAllConnections();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
