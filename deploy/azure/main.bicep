// Unofficial Sophos Fusion Data Exporter as an Azure Container Apps job, in the
// customer's own subscription. Not a Sophos product. See docs/azure.md.
//
// Creates: a Log Analytics workspace, a user-assigned managed identity, a Key
// Vault holding the Sophos credential, a storage account with the Azure Files
// share that keeps the CSV folder between runs, a Container Apps environment
// (Consumption), a scheduled job (run) and a manual job (backfill), and the
// role assignments the identity needs. Compile with `bicep build main.bicep
// --outfile azuredeploy.json` after any change.

metadata description = 'Unofficial Sophos Fusion Data Exporter: a scheduled Azure Container Apps job that writes the CSV star schema to an Azure Files share and uploads it to SharePoint for Power BI. Not a Sophos product.'

@description('Azure region for every resource. Pick the one nearest the Sophos tenant\'s data region, for example Australia East for an api-au01 tenant. The CSV files are stored here.')
param location string = resourceGroup().location

@description('Prefix for resource names. Lowercase letters, digits and hyphens.')
@minLength(3)
@maxLength(20)
param namePrefix string = 'fusion-export'

@description('Container image. The default is the public image built from the GitHub repository. For your own build, use <registry>.azurecr.io/sophos-fusion-export:<tag> and set registryName.')
param image string = 'ghcr.io/aaronjacobs000/sophos-fusion-export:0.1.0'

@description('Optional. An Azure Container Registry in this resource group to pull the image from with the managed identity. Leave empty for a public image.')
param registryName string = ''

@description('Sophos Fusion tenant API credential: the client ID. Stored in Key Vault.')
@secure()
param sophosClientId string

@description('Sophos Fusion tenant API credential: the client secret. Stored in Key Vault.')
@secure()
param sophosClientSecret string

@description('IANA time zone for the *_local_date columns, for example Australia/Sydney. Set the Power BI refresh time zone to match.')
param reportTimezone string = 'UTC'

@description('Optional. Tenant name shown in dim_tenant. Empty means the name Sophos reports.')
param tenantName string = ''

@description('Export hostnames, users, case titles and descriptions. Off by default; read the Personal data section of the README first.')
param personalData bool = false

@description('Optional. SharePoint site or OneDrive URL to upload the CSV files to, for example https://contoso.sharepoint.com/sites/reporting. The managed identity needs Sites.Selected with write on it (docs/azure.md). Empty means no upload.')
param sharePointSiteUrl string = ''

@description('Document library on the SharePoint site.')
param sharePointLibrary string = 'Documents'

@description('Folder in the library for the CSV files.')
param sharePointFolder string = 'FusionExport'

@description('When the scheduled job runs, as a cron expression in UTC. The default runs four times a day at 00:17, 06:17, 12:17 and 18:17 UTC.')
param cronExpression string = '17 0,6,12,18 * * *'

@description('Memory for each run, in GiB. 4 fits a tenant with a few hundred thousand rows of history; 8 doubles the CPU and the compute cost.')
@allowed([
  4
  8
])
param memoryGiB int = 4

@description('Mount options for the Azure Files share. The defaults make the container\'s node user (uid 1000) the owner.')
param mountOptions string = 'uid=1000,gid=1000,dir_mode=0700,file_mode=0600'

var suffix = uniqueString(resourceGroup().id, namePrefix)
var exportMountPath = '/data'
var shareName = 'export'
var cpuCores = memoryGiB / 2
var heapMb = memoryGiB * 768
var keyVaultSecretsUserRole = '4633458b-17de-408a-b874-0445c86b69e6'
var acrPullRole = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var useRegistry = !empty(registryName)

var exporterConfig = union(
  {
    reportTimezone: reportTimezone
    personalData: personalData
  },
  empty(tenantName) ? {} : { tenantName: tenantName },
  empty(sharePointSiteUrl)
    ? {}
    : {
        sharepoint: {
          siteUrl: sharePointSiteUrl
          library: sharePointLibrary
          folder: sharePointFolder
          auth: 'managedIdentity'
        }
      }
)

resource logs 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: '${namePrefix}-logs'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    // 30 days is inside the retention Log Analytics includes at no charge; the cap keeps ingestion inside the monthly free allowance.
    retentionInDays: 30
    workspaceCapping: {
      dailyQuotaGb: json('0.1')
    }
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: '${namePrefix}-identity'
  location: location
}

resource vault 'Microsoft.KeyVault/vaults@2025-05-01' = {
  name: 'kv${suffix}'
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}

resource sophosClientIdSecret 'Microsoft.KeyVault/vaults/secrets@2025-05-01' = {
  parent: vault
  name: 'sophos-client-id'
  properties: {
    value: sophosClientId
  }
}

resource sophosClientSecretSecret 'Microsoft.KeyVault/vaults/secrets@2025-05-01' = {
  parent: vault
  name: 'sophos-client-secret'
  properties: {
    value: sophosClientSecret
  }
}

resource vaultReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, keyVaultSecretsUserRole)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRole)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' existing = if (useRegistry) {
  name: useRegistry ? registryName : 'none'
}

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (useRegistry) {
  name: guid(resourceGroup().id, registryName, identity.id, acrPullRole)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRole)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2025-01-01' = {
  name: 'st${suffix}'
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    // The Container Apps SMB mount signs in with the account key.
    allowSharedKeyAccess: true
    publicNetworkAccess: 'Enabled'
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2025-01-01' = {
  parent: storage
  name: 'default'
  properties: {
    shareDeleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2025-01-01' = {
  parent: fileService
  name: shareName
  properties: {
    shareQuota: 5
    enabledProtocols: 'SMB'
    accessTier: 'TransactionOptimized'
  }
}

resource appEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${namePrefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
  }
}

resource environmentStorage 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: appEnvironment
  name: shareName
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: share.name
      accessMode: 'ReadWrite'
    }
  }
}

var containerEnv = [
  {
    name: 'FUSION_EXPORT_CONFIG_JSON'
    value: string(exporterConfig)
  }
  {
    name: 'SOPHOS_KEY_VAULT_URL'
    value: vault.properties.vaultUri
  }
  {
    name: 'AZURE_CLIENT_ID'
    value: identity.properties.clientId
  }
  {
    name: 'NODE_OPTIONS'
    value: '--max-old-space-size=${heapMb}'
  }
]

var registries = useRegistry
  ? [
      {
        server: '${registryName}${environment().suffixes.acrLoginServer}'
        identity: identity.id
      }
    ]
  : []

var jobs = [
  {
    name: namePrefix
    triggerType: 'Schedule'
    command: 'run'
    replicaTimeout: 1800
  }
  {
    name: '${namePrefix}-backfill'
    triggerType: 'Manual'
    command: 'backfill'
    replicaTimeout: 3600
  }
]

resource exportJobs 'Microsoft.App/jobs@2025-01-01' = [
  for job in jobs: {
    name: job.name
    location: location
    identity: {
      type: 'UserAssigned'
      userAssignedIdentities: {
        '${identity.id}': {}
      }
    }
    properties: {
      environmentId: appEnvironment.id
      workloadProfileName: 'Consumption'
      configuration: {
        triggerType: job.triggerType
        replicaTimeout: job.replicaTimeout
        // One retry covers a platform interruption; reruns write the same files.
        replicaRetryLimit: 1
        scheduleTriggerConfig: job.triggerType == 'Schedule'
          ? {
              cronExpression: cronExpression
              parallelism: 1
              replicaCompletionCount: 1
            }
          : null
        manualTriggerConfig: job.triggerType == 'Manual'
          ? {
              parallelism: 1
              replicaCompletionCount: 1
            }
          : null
        registries: registries
      }
      template: {
        containers: [
          {
            name: 'exporter'
            image: image
            args: [
              job.command
              '--out'
              exportMountPath
            ]
            env: containerEnv
            resources: {
              cpu: cpuCores
              memory: '${memoryGiB}Gi'
            }
            volumeMounts: [
              {
                volumeName: 'export'
                mountPath: exportMountPath
              }
            ]
          }
        ]
        volumes: [
          {
            name: 'export'
            storageType: 'AzureFile'
            storageName: environmentStorage.name
            mountOptions: mountOptions
          }
        ]
      }
    }
    dependsOn: [
      vaultReader
      registryPull
      sophosClientIdSecret
      sophosClientSecretSecret
    ]
  }
]

@description('Name of the scheduled job.')
output jobName string = exportJobs[0].name

@description('Name of the manual job that runs the first load. Start it once after the SharePoint grant.')
output backfillJobName string = exportJobs[1].name

@description('Client ID (app ID) of the managed identity. Grant it Sites.Selected and write on the SharePoint site.')
output identityClientId string = identity.properties.clientId

@description('Object ID of the managed identity\'s service principal, for the Sites.Selected app role assignment.')
output identityPrincipalId string = identity.properties.principalId

@description('Key Vault that holds the Sophos credential.')
output keyVaultName string = vault.name

@description('Storage account that holds the CSV folder in its export share.')
output storageAccountName string = storage.name

@description('Log Analytics workspace ID (customer ID) for the job logs.')
output logAnalyticsWorkspaceId string = logs.properties.customerId
