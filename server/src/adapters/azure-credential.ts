import type { TokenCredential } from '@azure/identity';

export function createAzureCredential(managedIdentityClientId?: string): TokenCredential {
  let credential: Promise<TokenCredential> | undefined;
  const resolveCredential = () => {
    credential ??= import('@azure/identity').then(({ DefaultAzureCredential }) => (
      new DefaultAzureCredential(
        managedIdentityClientId ? { managedIdentityClientId } : undefined,
      )
    ));
    return credential;
  };
  return {
    async getToken(scopes, options) {
      return (await resolveCredential()).getToken(scopes, options);
    },
  };
}
