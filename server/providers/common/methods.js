const HTTP_METHOD = /^[A-Z]+$/;

/**
 * Format the `Allow` header value for a route's accepted methods. Every 405
 * response must declare the methods its route actually accepts (RFC 9110
 * §15.5.6), so handlers build the value here instead of spelling it inline.
 * @param {...string} methods - Accepted methods, in the route's own order.
 * @returns {string} Comma-separated header value such as `GET, HEAD`.
 */
export function allowedMethods(...methods) {
  if (!methods.length || !methods.every((m) => HTTP_METHOD.test(m))) {
    throw new TypeError(
      `allowedMethods needs uppercase HTTP methods, got ${JSON.stringify(methods)}`,
    );
  }
  return [...new Set(methods)].join(', ');
}
