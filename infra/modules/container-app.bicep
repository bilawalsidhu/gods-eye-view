param location string
param managedEnvironmentName string
param containerAppName string
param containerImage string
param identityId string
param identityClientId string
param registryServer string
param logAnalyticsWorkspaceId string
param applicationInsightsConnectionString string
param mapsClientId string
param foundryEndpoint string
param foundryRealtimeDeploymentName string
param foundryHudDeploymentName string
param aisStreamUrl string
param enableAisStream bool
param keyVaultUri string
param tags object

var hasAis = enableAisStream
var baseEnvironment = [
  {
    name: 'NODE_ENV'
    value: 'production'
  }
  {
    name: 'OTEL_SERVICE_NAME'
    value: 'satview-bff'
  }
  {
    name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
    value: applicationInsightsConnectionString
  }
  {
    name: 'AZURE_CLIENT_ID'
    value: identityClientId
  }
  {
    name: 'AZURE_MAPS_CLIENT_ID'
    value: mapsClientId
  }
  {
    name: 'FOUNDRY_ENDPOINT'
    value: foundryEndpoint
  }
  {
    name: 'FOUNDRY_REALTIME_DEPLOYMENT'
    value: foundryRealtimeDeploymentName
  }
  {
    name: 'FOUNDRY_HUD_DEPLOYMENT'
    value: foundryHudDeploymentName
  }
  {
    name: 'AISSTREAM_URL'
    value: aisStreamUrl
  }
  {
    name: 'COMPATIBILITY_MODULE_PATH'
    value: '/app/server/compat/retained-api.mjs'
  }
]
var containerEnvironment = concat(baseEnvironment, hasAis ? [
  {
    name: 'AISSTREAM_API_KEY'
    secretRef: 'aisstream-api-key'
  }
] : [])

resource managedEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: managedEnvironmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
    zoneRedundant: false
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 3000
        transport: 'auto'
      }
      registries: [
        {
          server: registryServer
          identity: identityId
        }
      ]
      secrets: hasAis ? [
        {
          name: 'aisstream-api-key'
          keyVaultUrl: '${keyVaultUri}secrets/aisstream-api-key'
          identity: identityId
        }
      ] : []
    }
    template: {
      containers: [
        {
          name: 'web'
          image: containerImage
          env: containerEnvironment
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/live'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 10
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        // AISStream state is process-local; stay singleton until ingestion and
        // latest-position state move to a shared service.
        maxReplicas: 1
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '100'
              }
            }
          }
        ]
      }
      terminationGracePeriodSeconds: 15
    }
  }
}

output id string = app.id
output name string = app.name
output uri string = 'https://${app.properties.configuration.ingress.fqdn}'
output logAnalyticsWorkspaceId string = logAnalyticsWorkspaceId
