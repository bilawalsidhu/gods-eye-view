# Azure deployment prerequisites

The Bicep templates provision SatView on Azure Container Apps with whole-app
Microsoft Entra authentication, managed identity, Azure Maps, Microsoft Foundry,
Key Vault, ACR, and Azure Monitor.

Before provisioning:

1. Create an Entra web app registration for the Container App.
2. Enable ID tokens on the registration.
3. Add `https://<container-app-host>/.auth/login/aad/callback` as a web redirect
   URI once the host name is known.
4. Supply its client ID as `entraClientId`. Unauthenticated browser navigation
   redirects to the built-in Container Apps Entra login flow.
5. Select a region with capacity for both configured Foundry model deployments
   and set model versions/capacities explicitly when the defaults are not
   available.

AISStream is disabled by default. To enable it:

1. Provision the foundation once.
2. Add a secret named `aisstream-api-key` to the generated Key Vault.
3. Set `enableAisStream` to `true` and reprovision.

The Container App identity already receives `Key Vault Secrets User` on that
generated vault. The template never accepts the AISStream key as a Bicep
parameter. Keep the Container App at one replica while AIS state remains
process-local.

Deployment is intentionally user-operated through `azd`; no deployment command
is run by tests or repository scripts.
