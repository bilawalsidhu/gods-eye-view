export function createIngestion({
  state: layerState,
  services,
  parts,
  source,
}) {
  const methods = {
    update() {
      parts.subject.refreshSelectedSubject();
      return Promise.resolve();
    },
  };

  return { methods };
}
