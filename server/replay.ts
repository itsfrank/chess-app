if (!process.argv[2]) throw new Error('Usage: npm run replay -- .data/sessions/<recording>.jsonl');
process.env.REPLAY_LOG = process.argv[2];
await import('./index.ts');
export {};
