const unescape = (value) =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

/** Parse an S3 ListObjectsV2 XML response. */
export function parseS3ListXml(xml) {
  if (typeof xml !== 'string' || !/^\s*<\?xml|^\s*<ListBucketResult/.test(xml))
    throw new Error('Malformed S3 XML');
  const keys = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(
    (m) => {
      const key = m[1].match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
      const date = m[1].match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1];
      if (key === undefined) throw new Error('Malformed S3 XML');
      return {
        key: unescape(key),
        lastModifiedMs: date ? Date.parse(date) : null,
      };
    },
  );
  const truncated = xml.match(/<IsTruncated>(true|false)<\/IsTruncated>/)?.[1];
  if (truncated === undefined) throw new Error('Malformed S3 XML');
  const token = xml.match(
    /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/,
  )?.[1];
  return {
    keys,
    isTruncated: truncated === 'true',
    nextContinuationToken: token ? unescape(token) : null,
  };
}

/** Parse a GLM granule key into its satellite and UTC time range. */
export function parseGranuleKey(key) {
  const m = key.match(
    /_G(16|18|19)_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{3})d?_e(\d{4})(\d{3})(\d{2})(\d{2})(\d{3})d?(?:_|\.)/,
  );
  if (!m) return null;
  const date = (i) => {
    const y = +m[i],
      d = +m[i + 1];
    const base = Date.UTC(y, 0, 1);
    const ms =
      base +
      (d - 1) * 86400000 +
      (+m[i + 2] * 3600 + +m[i + 3] * 60 + +m[i + 4] / 10) * 1000;
    return Number.isNaN(ms) ? null : ms;
  };
  const startMs = date(2);
  const endMs = date(7);
  return startMs === null || endMs === null
    ? null
    : { satelliteCode: `G${m[1]}`, startMs, endMs };
}

/** List objects in a public NOAA S3 bucket. */
export async function listObjects({
  bucket,
  prefix,
  fetchImpl = fetch,
  maxKeys = 1000,
  continuationToken,
  signal,
}) {
  const url = new URL(`https://${bucket}.s3.amazonaws.com/`);
  url.searchParams.set('list-type', '2');
  url.searchParams.set('prefix', prefix);
  url.searchParams.set('max-keys', maxKeys);
  if (continuationToken)
    url.searchParams.set('continuation-token', continuationToken);
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`S3 list failed: ${response.status}`);
  return parseS3ListXml(await response.text());
}

/** Download an S3 object while enforcing a byte limit. */
export async function fetchObjectBuffer({
  bucket,
  key,
  fetchImpl = fetch,
  maxBytes = 16 * 1024 * 1024,
  signal,
}) {
  const response = await fetchImpl(
    `https://${bucket}.s3.amazonaws.com/${key}`,
    { signal },
  );
  if (!response.ok) throw new Error(`S3 get failed: ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes) throw new Error('S3 object exceeds limit');
  const reader = response.body?.getReader();
  const chunks = [];
  let total = 0;
  if (!reader) {
    const b = Buffer.from(await response.arrayBuffer());
    if (b.length > maxBytes) throw new Error('S3 object exceeds limit');
    return b;
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('S3 object exceeds limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
