# Run it in Azure (no machine)

> **Unofficial project, not from Sophos.** The exporter calls the documented Sophos APIs with a credential you supply, and it only reads. See the [README](../README.md).

The exporter can run as a scheduled [Azure Container Apps job](https://learn.microsoft.com/en-us/azure/container-apps/jobs) in your own Azure subscription, so no server or PC has to stay on. Each run starts a container, reads Sophos, writes the CSV folder to an Azure Files share, uploads the changed files to SharePoint, and stops. Power BI reads SharePoint exactly as it does on the [recommended path](../README.md#power-bi-recommended-path).

```
Sophos APIs --> Container Apps job (4 runs a day) --> Azure Files share (history, _state)
                     |      |                                   |
          Key Vault -+      +-- managed identity token ------> SharePoint --> Power BI service
     (Sophos credential)
```

Tested on 22/11/2026 in a pay-as-you-go subscription in Australia East, deployed from the template and image this page links to. The backfill and the next run both succeeded: each read the Sophos credential from Key Vault and uploaded with the managed identity, and the second run kept the backfill's history on the share. A scheduled run takes about 75 seconds.

## What it creates

[`deploy/azure/main.bicep`](../deploy/azure/main.bicep), compiled to [`deploy/azure/azuredeploy.json`](../deploy/azure/azuredeploy.json), creates in one resource group:

- A Container Apps environment on the Consumption plan, with two jobs: `fusion-export` runs `run` on a schedule, and `fusion-export-backfill` runs `backfill` when you start it.
- A user-assigned managed identity that both jobs run as.
- A Key Vault holding the Sophos client ID and secret as `sophos-client-id` and `sophos-client-secret`. The identity has Key Vault Secrets User on that vault only, and the exporter reads the two secrets at the start of each run.
- A storage account with an Azure Files share, `export`, mounted at `/data` as the output folder. It keeps the history and `_state/` between runs.
- A Log Analytics workspace for the job logs, with 30 days of retention and a 0.1 GB daily cap.

Each run gets 2 vCPU and 4 GiB of memory (8 GiB and 4 vCPU with `memoryGiB` set to 8), a 30 minute timeout and one retry. Reruns write the same files, so a retry is safe.

## What it costs

One tenant, four runs a day, 122 runs a month, priced for Australia East on 22/11/2026 from the Azure retail price API, in AUD including GST:

| Item | Use | AUD a month |
| --- | --- | --- |
| Compute | About 29,280 vCPU seconds and 58,560 GiB seconds, inside the monthly free grant of 180,000 and 360,000 per subscription | 0 (1.92 if other apps have used the grant) |
| Azure Files share | About 0.1 GB and a few thousand operations | Under 0.50 |
| Key Vault | A few hundred secret reads | Under 0.05 |
| Log Analytics | A few MB, inside the 5 GB a month that is free | 0 |
| Data out | Up to 60 MB a run to SharePoint, inside the 100 GB a month that is free | 0 |
| Image | The public image on GitHub Container Registry | 0 |
| Image, your own build | Azure Container Registry Basic | 7.92 |

That comes to about AUD 0 to 1 a month with the public image, or about AUD 9 with your own registry. The free grant needs a pay-as-you-go subscription with a payment method on file, even when usage stays inside it.

## What your admin sets up

About an hour for an admin who has granted Entra app permissions before.

1. An Azure subscription, and Owner on a resource group in it. The template assigns roles to the job's identity, which Contributor can't do.
2. A Sophos Fusion tenant API credential, from **General Settings > API Credentials Management** in Sophos Central, as in the [README](../README.md#sophos-api-credential). It goes into the deployment form and from there into Key Vault.
3. The SharePoint site for the CSV files, and after the deployment, the `Sites.Selected` grant for the job's identity (step 3 below). Skip this if you don't want the upload.

Nothing changes on the Power BI side.

## Deploy

### 1. Deploy the template

With the button (public image):

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FAaronjacobs000%2Fsophos-fusion-export%2Fmain%2Fdeploy%2Fazure%2Fazuredeploy.json)

Pick the subscription, a new resource group and a region near the Sophos tenant's data region (Australia East for an `api-au01` tenant). Fill in the Sophos client ID and secret, the report time zone, and the SharePoint site URL, library and folder. Leave the image as it is.

Or with the Azure CLI, for example in [Azure Cloud Shell](https://shell.azure.com). The CLI asks for the Sophos client ID and secret without showing them:

```sh
az group create --name fusion-export --location australiaeast
az deployment group create --resource-group fusion-export --name fusion-export \
  --template-uri https://raw.githubusercontent.com/Aaronjacobs000/sophos-fusion-export/main/deploy/azure/azuredeploy.json \
  --parameters reportTimezone=Australia/Sydney \
    sharePointSiteUrl=https://contoso.sharepoint.com/sites/reporting sharePointFolder=FusionExport/contoso
```

The deployment takes about 15 minutes, most of it for the Container Apps environment. Its outputs name the jobs, the Key Vault, the storage account and the identity. Keep `identityPrincipalId` for step 3. In the portal they are under the resource group's **Deployments**, and with the CLI:

```sh
az deployment group show --resource-group fusion-export --name fusion-export --query properties.outputs
```

### 2. Or build the image yourself

If you'd rather run an image you built, build it into an Azure Container Registry in the same resource group from a clone of this repository, then deploy with `image` and `registryName`. The identity gets AcrPull on that registry.

```sh
git clone https://github.com/Aaronjacobs000/sophos-fusion-export.git && cd sophos-fusion-export
az acr create --resource-group fusion-export --name contosofusionacr --sku Basic
az acr build --registry contosofusionacr --image sophos-fusion-export:0.1.0 .
az deployment group create --resource-group fusion-export --name fusion-export --template-file deploy/azure/azuredeploy.json \
  --parameters image=contosofusionacr.azurecr.io/sophos-fusion-export:0.1.0 registryName=contosofusionacr \
    reportTimezone=Australia/Sydney sharePointSiteUrl=https://contoso.sharepoint.com/sites/reporting
```

### 3. Grant the identity write on the SharePoint site

Do this straight after the deployment, before the first scheduled run. Azure caches managed identity tokens for around 24 hours, so a run that happens before the grant can keep failing its upload for up to a day after it.

The Azure portal can't give a managed identity a Microsoft Graph application permission, so use Microsoft Graph PowerShell, as a Global Administrator, or as a Privileged Role Administrator for the app role and a SharePoint Administrator for the site permission:

```powershell
Connect-MgGraph -Scopes Application.Read.All, AppRoleAssignment.ReadWrite.All, Sites.FullControl.All
$mi = Get-MgServicePrincipal -ServicePrincipalId "<identityPrincipalId>"
$graph = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"
$role = $graph.AppRoles | Where-Object { $_.Value -eq "Sites.Selected" -and $_.AllowedMemberTypes -contains "Application" }
New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $mi.Id -PrincipalId $mi.Id -ResourceId $graph.Id -AppRoleId $role.Id
$site = Get-MgSite -SiteId "contoso.sharepoint.com:/sites/reporting"
New-MgSitePermission -SiteId $site.Id -BodyParameter @{ roles = @("write"); grantedToIdentities = @(@{ application = @{ id = $mi.AppId; displayName = $mi.DisplayName } }) }
```

`Sites.Selected` gives the identity nothing until the site permission is added, and then only that site. No app registration or client secret is needed.

### 4. Run the first load

Start the backfill job once. It reads every case, 90 days of detections and 30 days of AI Defense activity. For a tenant with 95,000 detections and 22,000 AI Defense activities, that took 8 minutes and 279 Sophos API calls. Start it at least 15 minutes away from a scheduled run time (00:17, 06:17, 12:17 and 18:17 UTC by default), because two runs writing the same folder at once can lose the backfill's older detections.

```sh
az containerapp job start --resource-group fusion-export --name fusion-export-backfill
```

In the portal: open the `fusion-export-backfill` job and select **Run now**.

## Check a run

```sh
az containerapp job execution list --resource-group fusion-export --name fusion-export --output table \
  --query '[].{Status: properties.status, Name: name, Start: properties.startTime}'
```

The run's own log says what it read and uploaded, one line per data set:

```sh
WORKSPACE=$(az containerapp env show --resource-group fusion-export --name fusion-export-env \
  --query properties.appLogsConfiguration.logAnalyticsConfiguration.customerId --output tsv)
RUN=$(az containerapp job execution list --resource-group fusion-export --name fusion-export --query "[0].name" --output tsv)
az monitor log-analytics query --workspace "$WORKSPACE" --query "[].Log_s" --output tsv \
  --analytics-query "ContainerAppConsoleLogs_CL | where ContainerGroupName_s startswith '$RUN' | order by _timestamp_d asc"
```

Log lines reach Log Analytics a few minutes after the run writes them, so a query straight after a run can come back empty or partial; run it again.

In the portal, the job's **Execution history** lists the runs and links to their logs. The share itself is under the storage account's **File shares > export**: `_state/runs.jsonl` has one line per run with the call count and rows per table.

A run that fails exits with an error, the job retries it once, and the execution shows as Failed. The usual causes are in the log's first lines:

- `may not read secrets`: the Key Vault role assignment hasn't applied yet (a few minutes after deployment).
- `Sophos refused the credential`: a wrong or expired Sophos credential. Update it as below.
- `Microsoft Graph answered 403`: the SharePoint grant in step 3 is missing, or the identity's cached token predates it.

## Update

A new release of the image:

```sh
for job in fusion-export fusion-export-backfill; do
  az containerapp job update --resource-group fusion-export --name "$job" --image ghcr.io/aaronjacobs000/sophos-fusion-export:0.2.0
done
```

A new Sophos credential, or any other template setting: deploy the template again into the same resource group with the new values. The share and its history stay. (Writing the secret straight into Key Vault also works, but the vault uses Azure RBAC, so you need Key Vault Secrets Officer on it first.)

The schedule is UTC. To keep local run times through daylight saving, change `cronExpression` when the clocks change, or pick times that suit both offsets.

## Remove

```sh
az group delete --name fusion-export
```

This deletes the jobs, the identity, the vault, the logs and the share with its history, so copy the share first if you want to keep it. The vault stays soft-deleted for 7 days and keeps its name. To deploy again into a resource group of the same name within those 7 days, purge it first with `az keyvault purge --name <keyVaultName>`, which needs a subscription role such as Contributor. Then remove the identity's permission from the SharePoint site (`Get-MgSitePermission` and `Remove-MgSitePermission`) and delete the API credential in Sophos Central.

## Security

- The Sophos client secret lives in Key Vault, not in the job's settings, the image, the share or the logs.
- Anyone who can change or start the jobs can run a container of their choosing with the job's identity, and through it read the Sophos secret and write to the SharePoint site. That includes Owner, Contributor, Container Apps Jobs Contributor and Container Apps Jobs Operator on the resource group. Keep those roles to the admins who own the export.
- The share is mounted with the storage account key, which the Container Apps environment holds. Managed identity mounts for SMB are in preview.
- Key Vault, the storage account and Log Analytics use their public endpoints, protected by Entra ID and the account key. A Consumption environment without a virtual network has no fixed outbound address to restrict them to.
- Run it in the subscription of the organization that owns the Sophos tenant, with its own credential. Running one copy for other organizations' tenants is a different use under the [Sophos API terms of use](https://www.sophos.com/en-us/legal/sophos-api-and-plugin-termsofuse).
