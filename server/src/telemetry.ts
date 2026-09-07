const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim();
if (connectionString) {
  const [{ DefaultAzureCredential }, { useAzureMonitor }] = await Promise.all([
    import('@azure/identity'),
    import('@azure/monitor-opentelemetry'),
  ]);
  const configuredRatio = Number(process.env.OTEL_TRACES_SAMPLER_ARG ?? '1');
  const samplingRatio = Number.isFinite(configuredRatio) && configuredRatio >= 0 && configuredRatio <= 1
    ? configuredRatio
    : 1;

  useAzureMonitor({
    azureMonitorExporterOptions: {
      connectionString,
      credential: new DefaultAzureCredential(
        process.env.AZURE_CLIENT_ID ? { managedIdentityClientId: process.env.AZURE_CLIENT_ID } : undefined,
      ),
    },
    enableLiveMetrics: true,
    samplingRatio,
  });
}
