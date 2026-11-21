# Unofficial Sophos Fusion Data Exporter

> **Unofficial project, not from Sophos.** This is a personal project by an individual. It is not an official Sophos product and it is not built, endorsed, supported, or warranted by Sophos. It calls the documented Sophos APIs with a credential you supply. Use it at your own risk, and raise problems as issues on this repository rather than with Sophos support.

The exporter reads one Sophos Fusion tenant through the documented Sophos APIs and writes a star schema of CSV files: cases, detections with MITRE ATT&CK, endpoint health, the Account Health Check, licenses, product alerts and Sophos AI Defense. Power BI, Grafana, Excel and most other BI tools can read the files. It only reads from Sophos. It sends no telemetry and there is no hosted service.

The repository also holds report templates for Power BI and Grafana, and a second, simpler way into Power BI that calls the Sophos APIs from Power Query. Read [the two paths](#two-paths-into-power-bi) before you pick one.

## Contents

- [Two paths into Power BI](#two-paths-into-power-bi)
- [What it reads](#what-it-reads)
- [Install](#install)
- [Sophos API credential](#sophos-api-credential)
- [Configure](#configure)
- [Run](#run)
- [Schedule](#schedule)
- [Run it in Azure (no machine)](#run-it-in-azure-no-machine)
- [Upload to SharePoint or OneDrive](#upload-to-sharepoint-or-onedrive)
- [Power BI, recommended path](#power-bi-recommended-path)
- [Power BI, alternative direct path](#power-bi-alternative-direct-path)
- [Grafana](#grafana)
- [The data](#the-data)
- [Personal data](#personal-data)
- [Security](#security)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## Two paths into Power BI

### Recommended: the exporter writes CSV files, Power BI reads them

```
Sophos APIs --> exporter (scheduled, read only) --> CSV folder --> SharePoint or OneDrive --> Power BI service
                                                         |
                                                         +--> Grafana, Excel, Tableau, Looker Studio
```

- The Sophos client secret stays on the machine that runs the exporter, or in Key Vault when it [runs in Azure](#run-it-in-azure-no-machine). Nothing in Power BI holds it.
- The Power BI service refreshes from a SharePoint or OneDrive folder on a schedule, with no gateway.
- The files keep history: detection counts, endpoint snapshots and case outcomes stay after Sophos's 90 day window ends.
- Each run makes a few calls (under 20 for a typical tenant) under its own budget of 60 a minute, well below Sophos's limit.
- Every row carries `tenant_id`, so a partner model can roll tenants up later.

### Alternative: a Power BI file that calls the Sophos APIs itself

`powerbi/direct` is a Power BI project whose Power Query signs in to Sophos and reads cases, detections, endpoints, alerts and licenses on every refresh. It needs no exporter and no SharePoint, which makes it quick to try. It is not the recommended path, for these reasons:

- The client secret sits in the file. It is a Power Query parameter, so anyone who can open the file, or edit the semantic model once it is published, can read it. A copy of the file is a copy of the credential.
- The data source must be Anonymous. Power Query only sends a POST anonymously, and both the Sophos token request and Sophos Fusion GraphQL are POSTs. Power BI can't protect the credential with its own credential store.
- Scheduled refresh in the service needs static addresses. Every request uses a fixed base URL with `RelativePath` and `Query`, and the tenant's regional host is a parameter you set (`SophosRegionHost`), not something the file looks up. Change those patterns and the service refuses to refresh.
- Privacy levels are switched off for the file. The token from `id.sophos.com` has to travel to the other Sophos hosts, which Power Query's privacy firewall otherwise blocks, so the file is saved with "Ignore the privacy levels" on.
- One tenant per file.
- No history past what Sophos keeps. Each refresh replaces the tables, so there is nothing older than Sophos's retention and no daily snapshots.
- Each refresh spends the shared rate limit. Sophos allows 100 calls a minute per credential, shared with every integration that uses it. Power BI Pro allows 8 scheduled refreshes a day, and each one reads everything again.
- It reads at most 10,000 detections per refresh (the most one search returns) and up to 30 days of them.

If you use it, create a dedicated credential with the least access you can, keep the file somewhere only its owners can read, and delete the credential in Sophos Central when you stop.

## What it reads

Only operations Sophos documents on [developer.sophos.com](https://developer.sophos.com). Every request goes through a read-only guard: GETs on the paths below, the token request, and the exporter's own GraphQL query documents, matched character for character. Anything else is refused before it leaves the process, even with a Super Admin credential. Tests validate every query against the published schemas in `schemas/fusion`.

| Data | API | Tables |
| --- | --- | --- |
| Tenant and licenses | Licensing API, `GET /licenses/v1/licenses`; `GET /whoami/v1` | `dim_tenant`, `fact_license` |
| Cases | Sophos Fusion Cases GraphQL v2; cases v1 REST for a tenant not yet on Sophos Fusion | `fact_case`, `dim_case_type`, `dim_case_status`, `dim_case_verdict` |
| Detections | Sophos Fusion Detections GraphQL v2 (`detectionSearch`, `detectionCountByTenant`) | `fact_detection`, `fact_detection_daily`, `fact_technique_daily`, `fact_sensor_daily`, the bridges, `dim_detector`, `dim_mitre_technique`, `dim_sensor_type` |
| Endpoint health | Endpoint API, `GET /endpoint/v1/endpoints`; Account Health Check, `GET /account-health-check/v1/health-check` | `fact_endpoint_snapshot`, `fact_health_check_snapshot` |
| Product alerts | Common API, `GET /common/v1/alerts` | `fact_alert` |
| Sophos AI Defense | AI Defense Activity GraphQL v1 (`secureAITenantSettings`, `inventorySummary`, `activities`, `appInventory`, `userInventory`) and AI Defense Policy GraphQL v1 (`appSanctioning`, `policies`) | `fact_ai_defense_snapshot`, `fact_ai_activity`, `fact_ai_activity_daily`, `dim_ai_app`, `fact_ai_app_snapshot`, `fact_ai_user_snapshot`, `dim_ai_policy` |

Ingestion volume, data source health, ITDR, Exposure Management and playbook runs are left out until Sophos documents them.

## Install

Node.js 22.13 or later.

```sh
git clone https://github.com/Aaronjacobs000/sophos-fusion-export.git
cd sophos-fusion-export
npm ci
npm run build
node dist/cli.js --help
```

The exporter has no runtime dependencies beyond Node.js.

## Sophos API credential

In Sophos Central, open **General Settings > API Credentials Management** and add a credential for the tenant. Give it the least privileged role that works for you; the exporter never writes, whatever the role. This release takes a tenant credential only. Partner and organization credentials are planned.

API credentials last three years and can't be renewed. An expired one disappears from Sophos Central without notice, and `doctor` then reports that Sophos refused it.

Put the client ID and secret in an env file only you can read:

```sh
cat > ~/.config/fusion-export.env <<'EOF'
SOPHOS_CLIENT_ID=your-client-id
SOPHOS_CLIENT_SECRET=your-client-secret
EOF
chmod 600 ~/.config/fusion-export.env
```

## Configure

Copy `fusion-export.config.example.json` and edit it. Every field is optional except where noted.

| Setting | Default | Meaning |
| --- | --- | --- |
| `outputDir` | `./export` | Folder for the CSV files and `_state/`. Relative to the config file. |
| `reportTimezone` | `UTC` | IANA zone for the `*_local_date` columns, for example `Australia/Sydney`. Set the Power BI refresh zone to match. |
| `tenantName` | the name Sophos reports | Name shown in `dim_tenant`. |
| `personalData` | `false` | Export hostnames, users, case titles and descriptions. See [Personal data](#personal-data). |
| `rate.perMinute`, `rate.perHour` | 60, 900 | Call budget. At most 100 a minute. |
| `maxCallsPerRun` | 2000 | A run stops at this many Sophos calls. |
| `backfillDays` | 90 | Days of detections a backfill reads. |
| `detections.trailingDays` | 7 | Days of detections each run reads again, because a detection's status changes after it is created. |
| `detections.retentionDays` | 90 | Detection detail older than this is pruned. The daily counts stay. |
| `detections.pageSize` | 10000 | Most detections one search reads. |
| `cases.overlapMinutes` | 15 | How far before the last run's newest change a run starts reading cases. |
| `aiDefense.trailingDays` | 3 | Days of AI Defense activity each run reads again, because Sophos adds telemetry to recent activities. A run after a gap reads from the last full read. |
| `aiDefense.backfillDays` | 30 | Most days of AI Defense activity a backfill reads. Sophos serves 100 activities a call. |
| `aiDefense.retentionDays` | 90 | AI Defense activity older than this is pruned. The daily counts stay. |
| `aiDefense.inventoryDays` | 30 | Window the AI application and user inventories and Sophos's AI Defense totals cover, ending at the run. |
| `datasets` | all | Any of `licenses`, `cases`, `detections`, `endpoints`, `alerts`, `aiDefense`. |
| `sharepoint` | none | See [Upload to SharePoint or OneDrive](#upload-to-sharepoint-or-onedrive). `sharepoint.auth` is `clientSecret` (the default) or `managedIdentity` for [Azure](#run-it-in-azure-no-machine). |

The exporter refuses a config file that holds anything that looks like a secret. Credentials go in the environment or an env file. In a container, the same JSON can go in the `FUSION_EXPORT_CONFIG_JSON` environment variable in place of `--config`.

## Run

```sh
node dist/cli.js doctor   --config fusion-export.config.json --env-file ~/.config/fusion-export.env
node dist/cli.js backfill --config fusion-export.config.json --env-file ~/.config/fusion-export.env --days 90
node dist/cli.js run      --config fusion-export.config.json --env-file ~/.config/fusion-export.env
node dist/cli.js schema   > data-dictionary.md
```

- `doctor` checks the credential, each API, the output folder and SharePoint, and estimates the calls a daily run makes. It uses about a dozen calls.
- `backfill` is the first load: every case, detections for `--days`, AI Defense activity for `--days` or `aiDefense.backfillDays`, whichever is shorter, and today's snapshots.
- `run` is the incremental load: cases changed since the last run, the last 7 days of detections, and today's snapshots. Rerunning is safe; the same data gives the same files.
- `schema` prints the data dictionary, or `_schema.json` with `--json`.

Each run appends a line to `_state/runs.jsonl` with the call count by operation, the busiest minute, any rate limiting and the rows per table. A 90 day backfill of a tenant with 100,000 detections took 54 calls and under 4 minutes; a daily run of the same tenant takes 9 calls. AI Defense activity is slower to read: a 30 day backfill of 23,000 activities took 237 calls and under 4 minutes.

## Schedule

Four runs a day is plenty: Sophos's data changes slowly at this level and Power BI Pro refreshes at most 8 times a day.

cron (Linux, macOS):

```cron
17 0,6,12,18 * * *  cd /opt/sophos-fusion-export && node dist/cli.js run --quiet --config /etc/fusion-export/config.json --env-file /etc/fusion-export/fusion-export.env >> /var/log/fusion-export.log 2>&1
```

Windows Task Scheduler:

```powershell
$action = New-ScheduledTaskAction -Execute "node.exe" -Argument "dist\cli.js run --quiet --config C:\fusion-export\config.json --env-file C:\fusion-export\fusion-export.env" -WorkingDirectory "C:\fusion-export\sophos-fusion-export"
$trigger = New-ScheduledTaskTrigger -Daily -At 00:17; $trigger.Repetition = (New-ScheduledTaskTrigger -Once -At 00:17 -RepetitionInterval (New-TimeSpan -Hours 6)).Repetition
Register-ScheduledTask -TaskName "Fusion Export" -Action $action -Trigger $trigger -User "SYSTEM"
```

Keep the env file readable by the account that runs the task and nobody else.

## Run it in Azure (no machine)

The exporter can also run as a scheduled Azure Container Apps job in your own Azure subscription, with the Sophos credential in Key Vault, the CSV folder on an Azure Files share, and the SharePoint upload signed in with the job's managed identity, so there's no app secret to manage. It costs about AUD 0 to 1 a month for one tenant. [docs/azure.md](docs/azure.md) has the setup, the costs, how to check a run, and how to update and remove it.

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FAaronjacobs000%2Fsophos-fusion-export%2Fmain%2Fdeploy%2Fazure%2Fazuredeploy.json)

The image is `ghcr.io/aaronjacobs000/sophos-fusion-export`, built from this repository by the [image workflow](.github/workflows/image.yml). To run your own build instead, `az acr build` it into an Azure Container Registry: see [Or build the image yourself](docs/azure.md#2-or-build-the-image-yourself).

## Upload to SharePoint or OneDrive

If the machine running the exporter syncs a SharePoint library or OneDrive folder, point `outputDir` into the synced folder and skip this section. Otherwise the exporter can upload the files itself through Microsoft Graph after each run. Only changed files are sent.

1. Create a SharePoint site (or use an existing one) and note its URL, for example `https://contoso.sharepoint.com/sites/reporting`.
2. In Microsoft Entra, register an app (single tenant) and add the Microsoft Graph **application** permission `Sites.Selected`. Grant admin consent. Add a client secret.
3. Give the app write access to that one site. `Sites.Selected` grants nothing until you do. As an admin, with Microsoft Graph PowerShell:

   ```powershell
   Connect-MgGraph -Scopes Sites.FullControl.All
   $site = Get-MgSite -SiteId "contoso.sharepoint.com:/sites/reporting"
   New-MgSitePermission -SiteId $site.Id -BodyParameter @{ roles = @("write"); grantedToIdentities = @(@{ application = @{ id = "<app client id>"; displayName = "Fusion Export Uploader" } }) }
   ```

4. Add the app's details to your env file and the site to your config:

   ```sh
   GRAPH_TENANT_ID=your-entra-tenant-id
   GRAPH_CLIENT_ID=the-app-client-id
   GRAPH_CLIENT_SECRET=the-app-secret
   ```

   ```json
   "sharepoint": { "siteUrl": "https://contoso.sharepoint.com/sites/reporting", "library": "Documents", "folder": "FusionExport/contoso" }
   ```

5. Run `doctor`. It checks the sign-in, the site and the library.

For a OneDrive for Business folder, use the OneDrive URL (`https://contoso-my.sharepoint.com/personal/user_contoso_com`) as `siteUrl` and grant the app write on that site the same way.

## Power BI, recommended path

`powerbi/csv` is a Power BI project (PBIP): the semantic model `FusionExport.SemanticModel` and the report `FusionExport.Report`, with six pages (overview, cases, detections and ATT&CK, endpoints and licenses, alerts, AI Defense). It reads the CSV folder through the SharePoint folder connector.

Publish it one of two ways:

- With Power BI Desktop (Windows), open `powerbi/csv/FusionExport.pbip`, set the parameters `SharePointSiteUrl` and `ExportFolder` (Transform data > Edit parameters), sign in to SharePoint with your organizational account when asked, then publish.
- Without Desktop (macOS, Linux), `scripts/publish-fabric.mjs` creates or updates the model and report in a workspace through the Fabric REST API.

  ```sh
  export FABRIC_TOKEN=$(az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv)
  node scripts/publish-fabric.mjs --project powerbi/csv/FusionExport --workspace me --name "Fusion Export" \
    --param SharePointSiteUrl=https://contoso.sharepoint.com/sites/reporting --param ExportFolder=FusionExport/contoso
  ```

Then, in the Power BI service, open the semantic model's settings once:

1. Under Data source credentials, choose Edit credentials: authentication method OAuth2, privacy level Organizational, then sign in with an account that can read the site.
2. Under Refresh, turn on scheduled refresh and pick times an hour or so after the exporter's runs. Set the time zone to match `reportTimezone`.

Licensing: a Microsoft Fabric (Free) license is enough to publish to and refresh in your own My workspace. Sharing the report, or a shared workspace, needs Power BI Pro (or a Fabric capacity). The repository has no `.pbit`; building one needs Power BI Desktop on Windows (open the PBIP, then File > Save as > Power BI template).

To try the report without a tenant, upload the synthetic `demo/` folder to SharePoint and point `ExportFolder` at it.

## Power BI, alternative direct path

Read the warnings in [Two paths into Power BI](#alternative-a-power-bi-file-that-calls-the-sophos-apis-itself) first.

1. Open `powerbi/direct/FusionDirect.pbip` in Power BI Desktop.
2. Set the parameters: `SophosClientId`, `SophosClientSecret`, `SophosRegionHost` (the tenant's data region host from `doctor` or `GET /whoami/v1`, for example `https://api-au01.central.sophos.com`) and `DetectionDays` (1 to 30).
3. When Power BI asks how to connect to `https://id.sophos.com`, `https://api.central.sophos.com`, the region host and `https://api.taegis.sophos.com`, choose **Anonymous** for each. The Authorization header carries the token.
4. Publish, then in the semantic model's settings set the same four data sources to Anonymous and tick **Skip test connection** for each: the service tests a source by reading its root address, which the Sophos API hosts answer with 404. Then turn on scheduled refresh.

On-demand and scheduled refresh of this path in the Power BI service were verified on 21/11/2026.

The tables here are a subset of the exporter's: `fact_case`, `fact_detection`, `fact_endpoint_snapshot`, `fact_alert` and `fact_license`, with the same column names. Dates are UTC dates.

## Grafana

`grafana/` holds five dashboards (overview, cases, detections and ATT&CK, endpoints with licenses and alerts, AI Defense), provisioning for the data source and dashboards, a small read-only file server for the CSV folder, and a Docker Compose file. The dashboards use the [Infinity data source](https://grafana.com/grafana/plugins/yesoreyeram-infinity-datasource/) and run every query on the Grafana server.

With Docker:

```sh
export FUSION_EXPORT_DIR=/path/to/export
export GRAFANA_ADMIN_PASSWORD='a-long-password'
docker compose -f grafana/docker-compose.yml up -d
```

Open `http://localhost:3000`. Point `FUSION_EXPORT_DIR` at `demo/` to see the dashboards with synthetic data.

Into an existing Grafana (12.2.5 or later):

1. Install the Infinity plugin, version 4.1.5 or later.
2. Serve the export folder to Grafana: `node grafana/csv-server.mjs --dir /path/to/export --host 127.0.0.1 --port 3301`. It serves the table files and `_schema.json` only, with no listing.
3. Copy `grafana/provisioning` into Grafana's provisioning folder and set `FUSION_EXPORT_CSV_URL=http://127.0.0.1:3301` and `FUSION_EXPORT_DASHBOARDS` (a folder holding `grafana/dashboards`) in Grafana's environment.

The endpoint, license and health check panels show one snapshot, picked at the top of the dashboard; the newest is picked on load. The AI Defense dashboard does the same for its application, user and license panels.

## The data

The full data dictionary is in [docs/data-dictionary.md](docs/data-dictionary.md), generated from the schema; `_schema.json` in the output folder has the same information for tools.

- Facts: `fact_case`, `fact_detection`, `fact_detection_daily`, `fact_technique_daily`, `fact_sensor_daily`, `fact_endpoint_snapshot`, `fact_health_check_snapshot`, `fact_license`, `fact_alert`, `fact_ai_defense_snapshot`, `fact_ai_activity`, `fact_ai_activity_daily`, `fact_ai_app_snapshot`, `fact_ai_user_snapshot`. Dimensions: `dim_tenant`, `dim_case_type`, `dim_case_status`, `dim_case_verdict`, `dim_detector`, `dim_mitre_technique`, `dim_sensor_type`, `dim_ai_app`, `dim_ai_policy`. Bridges: `bridge_detection_technique`, `bridge_detection_sensor`, `bridge_detection_entity`.
- Every row starts with `tenant_id`, the Sophos Central tenant ID. Keys are Sophos IDs paired with `tenant_id`.
- Timestamps are UTC ISO 8601 with `Z`. `*_local_date` columns are dates in `reportTimezone`, and `*_date_key` the same date as a number (YYYYMMDD).
- Load modes: cases, alerts and AI applications are upserted on their ID; detections and AI Defense activity are replaced inside the window each run reads; endpoints, licenses, health check scores and the AI Defense inventories are daily snapshots; reference lists, AI Defense policies among them, are replaced each run.
- AI Defense sanctioning status (APPROVED, WARNED, BLOCKED or NOT_COVERED) is what the tenant's policies give each application at the run.
- Severity bands for detections: Critical 0.8 and up, High 0.6, Medium 0.4, Low 0.2, otherwise Info.
- Case response time is created to closed. Sophos sends no acknowledged or first response time.

## Personal data

Off by default. With it off, these columns are written empty and `bridge_detection_entity` holds only its header: case titles and close reasons, detection descriptions, endpoint hostnames, IP addresses and associated users, alert descriptions, and AI Defense user names, device names and Sophos's actor IDs (a user SID, an ID made from the user's name, or an IP address). Turning the switch off later also empties what earlier runs wrote. IDs (case, detection, endpoint, assignee) are always exported. AI Defense rows always carry `user_key`, a SHA-256 hash of the tenant and the actor ID, so activity joins to users without naming them. It is pseudonymous: someone holding a list of candidate IDs can test them against it.

Turn it on with `"personalData": true` or `--personal-data` only where the files are protected to the same standard as the Sophos console. In SharePoint, apply a sensitivity label to the library. Case comments, key findings and playbook data are never exported.

## Security

- Read only, by construction: see [What it reads](#what-it-reads). Redirects from Sophos are refused rather than followed.
- Secrets come from the environment or an env file, never from the config file, the output folder or `_state/`. Nothing logs a secret.
- The CSV file server for Grafana listens on 127.0.0.1 by default and serves only the table files.
- The SharePoint upload can reach only the Entra token endpoint, Microsoft Graph and SharePoint upload URLs. With `Sites.Selected` it can write to the one site you granted.
- In Azure, the exporter also calls the managed identity endpoint on the local host and reads two secrets from the Key Vault you name. Both are off unless `SOPHOS_KEY_VAULT_URL` or `sharepoint.auth` asks for them.
- Report security issues privately: see [SECURITY.md](SECURITY.md).

## Limitations

- One tenant per credential in this release.
- Sophos keeps detections for 90 days (13 months or more with NG-SIEM), so a backfill can't reach further back. The exporter keeps what it has read for as long as you keep the files.
- One search returns at most 10,000 detections, so the exporter splits a busy window into time slices. A single second with more than 10,000 detections would be cut short, with a warning.
- Endpoint health, licenses and health check scores are snapshots from the exporter's runs. There is no history before the first run.
- Product alerts leave the Common API once acknowledged. The table keeps every alert the exporter has seen.
- Sophos serves AI Defense activity 100 to a call, so a backfill reads 30 days by default. The application inventory leaves out training policy, compliance and category fields: the live API refused them on 07/11/2026 although the published schema lists them.
- The Sophos Fusion GraphQL host may move to a Fusion-branded name; the exporter will need an update when it does.
- No `.pbit` template yet: see [Power BI, recommended path](#power-bi-recommended-path).

## Development

```sh
npm ci
npm test            # build, then unit, guard, limiter, golden CSV, idempotence and template tests
npm run typecheck
node scripts/build-grafana.mjs    # regenerate grafana/dashboards
node scripts/build-powerbi.mjs    # regenerate powerbi/ from the schema
npm run docs                      # regenerate docs/data-dictionary.md
npm run demo                      # regenerate demo/ (synthetic)
bicep build deploy/azure/main.bicep --outfile deploy/azure/azuredeploy.json   # after a template change
docker build -t sophos-fusion-export .                                         # the container image
UPDATE_GOLDEN=1 node --test test/run.test.mjs   # accept a deliberate change to the golden CSVs
```

Never commit a real export. `demo/` and the test fixtures are synthetic. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE). Vendored and adapted code is listed in [ATTRIBUTIONS.md](ATTRIBUTIONS.md) and [NOTICE](NOTICE). Sophos, Sophos Central and Sophos Fusion are trademarks of Sophos Limited; see [TRADEMARKS.md](TRADEMARKS.md).
