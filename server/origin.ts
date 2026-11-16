const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Browsers attach Origin to every cross-site and POST request, so rejecting
 * non-loopback origins keeps other websites from driving the local API.
 * Requests without Origin (curl, same-origin GET) are allowed.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && loopbackHosts.has(url.hostname);
  } catch {
    return false;
  }
}
