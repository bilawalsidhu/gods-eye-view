param environmentName string
param location string
param containerImage string
param entraTenantId string
param entraClientId string
param entraAllowedAudiences array
param foundryRealtimeModelName string
param foundryRealtimeModelVersion string
param foundryRealtimeSkuName string
param foundryRealtimeCapacity int
param foundryHudModelName string
param foundryHudModelVersion string
param foundryHudSkuName string
param foundryHudCapacity int
param aisStreamUrl string
param enableAisStream bool
param tags object

var suffix = toLower(uniqueString(subscription().id, resourceGroup().id, environmentName))
var compactEnvironment = take(replace(toLower(environmentName), '-', ''), 12)
var identityName = 'id-${environmentName}-web'
var registryName = take('cr${compactEnvironment}${suffix}', 50)
var keyVaultName = take('kv-${compactEnvironment}-${suffix}', 24)
var mapsName = take('maps-${environmentName}-${suffix}', 63)
var foundryName = take('ai-${compactEnvironment}-${suffix}', 64)
var containerEnvironmentName = 'cae-${environmentName}'
var containerAppName = 'ca-${environmentName}-web'

module identity './modules/identity.bicep' = {
  name: 'identity'
  params: {
    name: identityName
    location: location
    tags: tags
  }
}

module monitoring './modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    environmentName: environmentName
    location: location
    telemetryPrincipalId: identity.outputs.principalId
    tags: tags
  }
}

module registry './modules/registry.bicep' = {
  name: 'registry'
  params: {
    name: registryName
    location: location
    pullPrincipalId: identity.outputs.principalId
    tags: tags
  }
}

module keyVault './modules/key-vault.bicep' = {
  name: 'key-vault'
  params: {
    name: keyVaultName
    location: location
    dataPrincipalId: identity.outputs.principalId
    tags: tags
  }
}

module maps './modules/maps.bicep' = {
  name: 'maps'
  params: {
    name: mapsName
    location: 'global'
    dataPrincipalId: identity.outputs.principalId
    tags: tags
  }
}

module foundry './modules/foundry.bicep' = {
  name: 'foundry'
  params: {
    name: foundryName
    projectName: 'satview'
    location: location
    realtimeDeploymentName: 'satview-realtime'
    realtimeModelName: foundryRealtimeModelName
    realtimeModelVersion: foundryRealtimeModelVersion
    realtimeSkuName: foundryRealtimeSkuName
    realtimeCapacity: foundryRealtimeCapacity
    hudDeploymentName: 'satview-hud'
    hudModelName: foundryHudModelName
    hudModelVersion: foundryHudModelVersion
    hudSkuName: foundryHudSkuName
    hudCapacity: foundryHudCapacity
    inferencePrincipalId: identity.outputs.principalId
    tags: tags
  }
}

module containerApp './modules/container-app.bicep' = {
  name: 'container-app'
  params: {
    location: location
    managedEnvironmentName: containerEnvironmentName
    containerAppName: containerAppName
    containerImage: containerImage
    identityId: identity.outputs.id
    identityClientId: identity.outputs.clientId
    registryServer: registry.outputs.loginServer
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
    applicationInsightsConnectionString: monitoring.outputs.applicationInsightsConnectionString
    mapsClientId: maps.outputs.clientId
    foundryEndpoint: foundry.outputs.endpoint
    foundryRealtimeDeploymentName: foundry.outputs.realtimeDeploymentName
    foundryHudDeploymentName: foundry.outputs.hudDeploymentName
    aisStreamUrl: aisStreamUrl
    enableAisStream: enableAisStream
    keyVaultUri: keyVault.outputs.uri
    tags: tags
  }
}

module auth './modules/auth.bicep' = {
  name: 'built-in-auth'
  params: {
    containerAppName: containerApp.outputs.name
    tenantId: entraTenantId
    clientId: entraClientId
    allowedAudiences: entraAllowedAudiences
  }
}

output containerAppName string = containerApp.outputs.name
output containerAppUri string = containerApp.outputs.uri
output registryEndpoint string = registry.outputs.loginServer
output mapsClientId string = maps.outputs.clientId
output foundryEndpoint string = foundry.outputs.endpoint
output foundryProjectId string = foundry.outputs.projectId
output keyVaultUri string = keyVault.outputs.uri
