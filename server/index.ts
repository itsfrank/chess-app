import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createApp } from './app.ts';
import { ChatService } from './chat.ts';
import { MODEL, MODEL_NAME, PORT } from './config.ts';
import { MaiaOpponent } from './opponent.ts';
import { Replay } from './recording.ts';
import { loadTotals } from './usage.ts';

/** Model, engines and conversations for live use; a replay server needs none of them. */
async function liveServices() {
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(MODEL.provider, MODEL.id);
  if (!model) throw new Error(`Pi model ${MODEL_NAME} is unavailable; no fallback configured.`);
  const lifetime = loadTotals();
  return {
    lifetime,
    chat: new ChatService({ modelRuntime, model, lifetime }),
    opponent: new MaiaOpponent(),
  };
}

const replayLog = process.env.REPLAY_LOG;
const services = replayLog
  ? { lifetime: loadTotals(), replay: new Replay(replayLog), chat: undefined, opponent: undefined }
  : await liveServices();
const server = createApp(services);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Chess API: http://127.0.0.1:${PORT}${replayLog ? ' (offline replay)' : ''}`);
});

const shutdown = () => {
  services.opponent?.close();
  services.chat?.dispose();
  server.close();
  // Streaming responses would otherwise keep the process alive.
  server.closeAllConnections();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
