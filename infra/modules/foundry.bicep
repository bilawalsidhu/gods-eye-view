param name string
param projectName string
param location string
param realtimeDeploymentName string
param realtimeModelName string
param realtimeModelVersion string
param realtimeSkuName string
param realtimeCapacity int
param hudDeploymentName string
param hudModelName string
param hudModelVersion string
param hudSkuName string
param hudCapacity int
param inferencePrincipalId string
param tags object

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: name
  location: location
  tags: tags
  kind: 'AIServices'
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: 'S0'
  }
  properties: {
    allowProjectManagement: true
    customSubDomainName: name
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: account
  name: projectName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    displayName: 'SatView'
    description: 'SatView Microsoft Foundry project'
  }
}

resource realtimeDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: account
  name: realtimeDeploymentName
  sku: {
    name: realtimeSkuName
    capacity: realtimeCapacity
  }
  properties: {
    model: union({
      format: 'OpenAI'
      name: realtimeModelName
    }, empty(realtimeModelVersion) ? {} : {
      version: realtimeModelVersion
    })
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
  }
}

resource hudDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: account
  name: hudDeploymentName
  sku: {
    name: hudSkuName
    capacity: hudCapacity
  }
  properties: {
    model: union({
      format: 'OpenAI'
      name: hudModelName
    }, empty(hudModelVersion) ? {} : {
      version: hudModelVersion
    })
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
  }
}

resource inferenceUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, inferencePrincipalId, 'CognitiveServicesOpenAIUser')
  scope: account
  properties: {
    principalId: inferencePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
    )
  }
}

output id string = account.id
output endpoint string = 'https://${name}.openai.azure.com'
output projectId string = project.id
output realtimeDeploymentName string = realtimeDeployment.name
output hudDeploymentName string = hudDeployment.name
