// Works out the public origin of the *gateway* (not the dashboard) so the key
// page can print a base URL a client can actually call. Kept in its own module
// because the rule has three cases and deserves direct tests.

/**
 * @param {object} options
 * @param {string} [options.configured]  explicit override (env or config.json)
 * @param {string} [options.proto]       x-forwarded-proto, or the request scheme
 * @param {string} [options.host]        x-forwarded-host or Host header
 * @param {number} [options.gatewayPort] port the API listens on
 * @returns {string} origin with no trailing slash, e.g. "https://api.example.com"
 */
export function resolvePublicOrigin({ configured = '', proto = 'http', host = '127.0.0.1', gatewayPort = 3190 } = {}) {
  const override = String(configured || '').trim();
  if (override) return override.replace(/\/+$/, '');

  const scheme = String(proto || 'http').split(',')[0].trim() || 'http';
  const rawHost = String(host || '127.0.0.1').split(',')[0].trim();
  const match = /^(.+?)(?::(\d+))?$/.exec(rawHost);
  const name = match?.[1] || rawHost;
  const port = match?.[2] ? Number(match[2]) : null;

  // A public name with no port, or already on the gateway port, is used as is.
  if (!port) return scheme + '://' + name;
  // A standard port for the scheme is equivalent to no port at all.
  if ((scheme === 'https' && port === 443) || (scheme === 'http' && port === 80)) return scheme + '://' + name;
  if (port === Number(gatewayPort)) return scheme + '://' + name + ':' + port;
  // A local dashboard port is not where the API lives; point at the gateway.
  return scheme + '://' + name + ':' + gatewayPort;
}
