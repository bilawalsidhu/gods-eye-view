targetScope = 'subscription'

@minLength(2)
@maxLength(32)
@description('Short environment name used in resource names.')
param environmentName string

@description('Azure region for the resource group and regional resources.')
param location string

@description('Container image used during provisioning. azd replaces this during service deployment.')
param containerImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

@description('Microsoft Entra tenant containing the built-in authentication app registration.')
param entraTenantId string = tenant().tenantId

@description('Required existing Entra application client ID used by Container Apps built-in authentication.')
@minLength(36)
param entraClientId string

@description('Allowed token audiences for built-in authentication.')
param entraAllowedAudiences array = []

@description('Foundry realtime model catalog name.')
param foundryRealtimeModelName string = 'gpt-realtime'

@description('Optional pinned Foundry realtime model version. Empty selects the service default.')
param foundryRealtimeModelVersion string = ''

@description('Foundry realtime deployment SKU.')
param foundryRealtimeSkuName string = 'GlobalStandard'

@minValue(1)
@description('Foundry realtime deployment capacity.')
param foundryRealtimeCapacity int = 10

@description('Foundry HUD text model catalog name.')
param foundryHudModelName string = 'gpt-5-nano'

@description('Optional pinned Foundry HUD model version. Empty selects the service default.')
param foundryHudModelVersion string = ''

@description('Foundry HUD deployment SKU.')
param foundryHudSkuName string = 'GlobalStandard'

@minValue(1)
@description('Foundry HUD deployment capacity.')
param foundryHudCapacity int = 10

@description('AISStream websocket URL.')
param aisStreamUrl string = 'wss://stream.aisstream.io/v0/stream'

@description('Enable AISStream after seeding the generated Key Vault with an aisstream-api-key secret.')
param enableAisStream bool = false

@description('Resource tags.')
param tags object = {
  'azd-env-name': environmentName
  workload: 'satview'
}

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module resources './resources.bicep' = {
  name: 'satview-${environmentName}'
  scope: resourceGroup
  params: {
    environmentName: environmentName
    location: location
    containerImage: containerImage
    entraTenantId: entraTenantId
    entraClientId: entraClientId
    entraAllowedAudiences: entraAllowedAudiences
    foundryRealtimeModelName: foundryRealtimeModelName
    foundryRealtimeModelVersion: foundryRealtimeModelVersion
    foundryRealtimeSkuName: foundryRealtimeSkuName
    foundryRealtimeCapacity: foundryRealtimeCapacity
    foundryHudModelName: foundryHudModelName
    foundryHudModelVersion: foundryHudModelVersion
    foundryHudSkuName: foundryHudSkuName
    foundryHudCapacity: foundryHudCapacity
    aisStreamUrl: aisStreamUrl
    enableAisStream: enableAisStream
    tags: tags
  }
}

output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP string = resourceGroup.name
output SERVICE_WEB_NAME string = resources.outputs.containerAppName
output SERVICE_WEB_RESOURCE_GROUP_NAME string = resourceGroup.name
output SERVICE_WEB_URI string = resources.outputs.containerAppUri
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.registryEndpoint
output AZURE_MAPS_CLIENT_ID string = resources.outputs.mapsClientId
output FOUNDRY_ENDPOINT string = resources.outputs.foundryEndpoint
output FOUNDRY_PROJECT_ID string = resources.outputs.foundryProjectId
output KEY_VAULT_URI string = resources.outputs.keyVaultUri
