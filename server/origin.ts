const localOrigins = new Set([
  'http://127.0.0.1:5173', 'http://localhost:5173',
  'http://127.0.0.1:3001', 'http://localhost:3001',
]);
export function isAllowedOrigin(origin: string | undefined): boolean {
  return origin === undefined || localOrigins.has(origin);
}
