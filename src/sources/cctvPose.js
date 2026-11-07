/** Catalog-derived CCTV pose defaults shared by the server and map client. */
export const CCTV_DEFAULT_FOV_DEG = 74;
export const CCTV_DEFAULT_PITCH_DEG = -17;

/** Match the client camera's historical 33-hash when no heading is published. */
export function cctvFallbackHeadingFromId(id) {
  const text = String(id || '');
  let acc = 0;
  for (let i = 0; i < text.length; i++) {
    acc = (acc * 33 + text.charCodeAt(i)) >>> 0;
  }
  return (acc % 16) * 22.5;
}
