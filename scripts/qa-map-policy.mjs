/** Install before navigation, without intercepting workers or ordinary tiles. */
export async function blockPaidQaMaps(page, { allowPaidMaps = false } = {}) {
  if (allowPaidMaps) return;
  const session = await page.createCDPSession();
  await session.send('Network.enable');
  await session.send('Network.setBlockedURLs', {
    urls: [
      '*://tile.googleapis.com/*',
      '*://*.googleapis.com/*3dtiles*',
      '*://api.cesium.com/v1/assets/2275207/*',
      '*/api/google/tiles*',
    ],
  });
  return session;
}
