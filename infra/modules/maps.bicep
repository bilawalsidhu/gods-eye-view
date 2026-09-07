param name string
param location string = 'global'
param dataPrincipalId string
param tags object

resource maps 'Microsoft.Maps/accounts@2023-06-01' = {
  name: name
  location: location
  tags: tags
  kind: 'Gen2'
  sku: {
    name: 'G2'
  }
  properties: {
    disableLocalAuth: true
  }
}

resource mapsDataReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(maps.id, dataPrincipalId, 'AzureMapsDataReader')
  scope: maps
  properties: {
    principalId: dataPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '6be48352-4f82-47c9-ad5e-0acacefdb005'
    )
  }
}

output id string = maps.id
output clientId string = maps.properties.uniqueId
