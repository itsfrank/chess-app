/** `npm run replay -- <recording>`: serve a recorded session instead of the live model. */
if (!process.argv[2]) throw new Error('Usage: npm run replay -- .data/sessions/<recording>.jsonl');
process.env.REPLAY_LOG = process.argv[2];
await import('./index.ts');
export {};
