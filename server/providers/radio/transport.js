import https from 'node:https';
import { Readable } from 'node:stream';
import { isNonGlobalIpv4 } from './stations.js';
export function radioMirrorOrigin(value) {
  const hostname = String(value ?? '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!/^[a-z0-9-]+\.api\.radio-browser\.info$/.test(hostname)) return null;
  return `https://${hostname}`;
}

/** Return whether a resolved Radio Browser address is safe for an outbound request. */
export function isPublicRadioAddress(value) {
  const address = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!address) return false;
  if (!address.includes(':')) {
    const ipv4 = address.split('.');
    return (
      ipv4.length === 4 &&
      ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
      !isNonGlobalIpv4(address)
    );
  }
  const pieces = address.split('::');
  if (pieces.length > 2) return false;
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces[1] ? pieces[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (
    (pieces.length === 1 && missing !== 0) ||
    (pieces.length === 2 && missing < 1)
  )
    return false;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  )
    return false;
  const numeric = groups.reduce(
    (total, group) => (total << 16n) | BigInt(`0x${group}`),
    0n,
  );
  const inCidr = (base, prefix) => {
    const shift = 128n - BigInt(prefix);
    return numeric >> shift === base >> shift;
  };
  const base = (text) =>
    text
      .split(':')
      .reduce(
        (total, group) => (total << 16n) | BigInt(`0x${group || '0'}`),
        0n,
      );
  const cidr = (text, prefix) => inCidr(base(text), prefix);
  return (
    cidr('2000:0:0:0:0:0:0:0', 3) &&
    !cidr('2001:0:0:0:0:0:0:0', 23) &&
    !cidr('2001:db8:0:0:0:0:0:0', 32) &&
    !cidr('2002:0:0:0:0:0:0:0', 16) &&
    !cidr('3fff:0:0:0:0:0:0:0', 20)
  );
}

export function radioProxyDestination(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  const origin = radioMirrorOrigin(url.hostname);
  if (
    !origin ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    return null;
  const discovery =
    url.hostname.toLowerCase() === 'all.api.radio-browser.info' &&
    url.pathname === '/json/servers' &&
    !url.search;
  const directory = url.pathname === '/json/stations/search';
  const click = /^\/json\/url\/[0-9a-f-]+$/i.test(url.pathname) && !url.search;
  return discovery || directory || click ? url : null;
}

export async function resolveRadioProxyAddresses(hostname, lookupImpl) {
  const resolved = await lookupImpl(hostname, { all: true, verbatim: true });
  const rows = Array.isArray(resolved) ? resolved : [resolved];
  const addresses = rows
    .map((row) => ({
      address: String(row?.address || ''),
      family: Number(row?.family) || undefined,
    }))
    .filter((row) => row.address);
  if (
    !addresses.length ||
    addresses.some((row) => !isPublicRadioAddress(row.address))
  ) {
    throw new Error('Radio Browser resolved to a forbidden address');
  }
  return addresses;
}

export function fetchPinnedRadioResponse(url, options, addresses) {
  return new Promise((resolve, reject) => {
    const address = addresses[0];
    const request = https.request(
      url,
      {
        method: 'GET',
        headers: options.headers,
        signal: options.signal,
        lookup(_hostname, lookupOptions, callback) {
          if (lookupOptions?.all) callback(null, addresses);
          else callback(null, address.address, address.family);
        },
      },
      (response) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value))
            value.forEach((item) => headers.append(name, item));
          else if (value !== undefined) headers.set(name, String(value));
        }
        resolve(
          new Response(Readable.toWeb(response), {
            status: response.statusCode || 500,
            statusText: response.statusMessage || '',
            headers,
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}
