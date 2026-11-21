# Unofficial Sophos Fusion Data Exporter

> **Unofficial project, not from Sophos.** This is a personal project by an individual. It is not an official Sophos product and it is not built, endorsed, supported, or warranted by Sophos. It calls the documented Sophos APIs with a credential you supply. Use it at your own risk, and raise problems as issues on this repository rather than with Sophos support.

The exporter reads one Sophos Fusion tenant through the documented Sophos APIs and writes a star schema of CSV files: cases, detections with MITRE ATT&CK, endpoint health, the Account Health Check, licenses and product alerts. Power BI, Grafana, Excel and most other BI tools can read the files. It only reads from Sophos. It sends no telemetry and there is no hosted service.

The repository also holds report templates for Power BI and Grafana, and a second, simpler way into Power BI that calls the Sophos APIs from Power Query. Read [the two paths](#two-paths-into-power-bi) before you pick one.

## Contents

- [Two paths into Power BI](#two-paths-into-power-bi)
- [What it reads](#what-it-reads)
- [Install](#install)
- [Sophos API credential](#sophos-api-credential)
- [Configure](#configure)
- [Run](#run)
- [Schedule](#schedule)
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

- The Sophos client secret stays on the machine that runs the exporter. Nothing in Power BI holds it.
- The Power BI service refreshes from a SharePoint or OneDrive folder on a schedule, with no gateway.
- The files keep history: detection counts, endpoint snapshots and case outcomes stay after Sophos's 90 day window ends.
- Each run makes a few calls (about 10 for a typical tenant) under its own budget of 60 a minute, well below Sophos's limit.
- Every row carries `tenant_id`, so a partner model can roll tenants up later.

### Alternative: a Power BI file that calls the Sophos APIs itself

`powerbi/direct` is a Power BI project whose Power Query signs in to Sophos and reads cases, detections, endpoints, alerts and licenses on every refresh. It needs no exporter and no SharePoint, which makes it quick to try. It is not the recommended path, for these reasons:

- **The client secret sits in the file.** It is a Power Query parameter, so anyone who can open the file, or edit the semantic model once it is published, can read it. A copy of the file is a copy of the credential.
- **The data source must be Anonymous.** Power Query only sends a POST anonymously, and both the Sophos token request and Sophos Fusion GraphQL are POSTs. Power BI can't protect the credential with its own credential store.
- **Scheduled refresh in the service needs static addresses.** Every request uses a fixed base URL with `RelativePath` and `Query`, and the tenant's regional host is a parameter you set (`SophosRegionHost`), not something the file looks up. Change those patterns and the service refuses to refresh.
- **One tenant per file.**
- **No history past what Sophos keeps.** Each refresh replaces the tables, so there is nothing older than Sophos's retention and no daily snapshots.
- **Each refresh spends the shared rate limit.** Sophos allows 100 calls a minute per credential, shared with every integration that uses it. Power BI can refresh 8 times a day on Pro and retries failed refreshes.
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
| `datasets` | all | Any of `licenses`, `cases`, `detections`, `endpoints`, `alerts`. |
| `sharepoint` | none | See [Upload to SharePoint or OneDrive](#upload-to-sharepoint-or-onedrive). |

The exporter refuses a config file that holds anything that looks like a secret. Credentials go in the environment or an env file.

## Run

```sh
node dist/cli.js doctor   --config fusion-export.config.json --env-file ~/.config/fusion-export.env
node dist/cli.js backfill --config fusion-export.config.json --env-file ~/.config/fusion-export.env --days 90
node dist/cli.js run      --config fusion-export.config.json --env-file ~/.config/fusion-export.env
node dist/cli.js schema   > data-dictionary.md
```

- `doctor` checks the credential, each API, the output folder and SharePoint, and estimates the calls a daily run makes. It uses about ten calls.
- `backfill` is the first load: every case, detections for `--days`, and today's snapshots.
- `run` is the incremental load: cases changed since the last run, the last 7 days of detections, and today's snapshots. Rerunning is safe; the same data gives the same files.
- `schema` prints the data dictionary, or `_schema.json` with `--json`.

Each run appends a line to `_state/runs.jsonl` with the call count by operation, the busiest minute, any rate limiting and the rows per table. A 90 day backfill of a tenant with 100,000 detections took 54 calls and under 4 minutes; a daily run of the same tenant takes 9 calls.

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

`powerbi/csv` is a Power BI project (PBIP): the semantic model `FusionExport.SemanticModel` and the report `FusionExport.Report`, with five pages (overview, cases, detections and ATT&CK, endpoints and licenses, alerts). It reads the CSV folder through the SharePoint folder connector.

Publish it one of two ways:

- **Power BI Desktop (Windows):** open `powerbi/csv/FusionExport.pbip`, set the parameters `SharePointSiteUrl` and `ExportFolder` (Transform data > Edit parameters), sign in to SharePoint with your organizational account when asked, then publish.
- **Without Desktop (macOS, Linux):** `scripts/publish-fabric.mjs` creates or updates the model and report in a workspace through the Fabric REST API.

  ```sh
  export FABRIC_TOKEN=$(az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv)
  node scripts/publish-fabric.mjs --project powerbi/csv/FusionExport --workspace me --name "Fusion Export" \
    --param SharePointSiteUrl=https://contoso.sharepoint.com/sites/reporting --param ExportFolder=FusionExport/contoso
  ```

Then, in the Power BI service, open the semantic model's settings once:

1. **Data source credentials > Edit credentials:** authentication method OAuth2, privacy level Organizational, then sign in with an account that can read the site.
2. **Refresh:** turn on scheduled refresh and pick times an hour or so after the exporter's runs. Set the time zone to match `reportTimezone`.

Licensing: a Microsoft Fabric (Free) license is enough to publish to and refresh in your own My workspace. Sharing the report, or a shared workspace, needs Power BI Pro (or a Fabric capacity). The repository has no `.pbit`; building one needs Power BI Desktop on Windows (open the PBIP, then File > Save as > Power BI template).

To try the report without a tenant, upload the synthetic `demo/` folder to SharePoint and point `ExportFolder` at it.

## Power BI, alternative direct path

Read the warnings in [Two paths into Power BI](#alternative-a-power-bi-file-that-calls-the-sophos-apis-itself) first.

1. Open `powerbi/direct/FusionDirect.pbip` in Power BI Desktop.
2. Set the parameters: `SophosClientId`, `SophosClientSecret`, `SophosRegionHost` (the tenant's data region host from `doctor` or `GET /whoami/v1`, for example `https://api-au01.central.sophos.com`) and `DetectionDays` (1 to 30).
3. When Power BI asks how to connect to `https://id.sophos.com`, `https://api.central.sophos.com`, the region host and `https://api.taegis.sophos.com`, choose **Anonymous** for each. The Authorization header carries the token.
4. Publish, then in the semantic model's settings set the same four data sources to Anonymous and turn on scheduled refresh.

The tables here are a subset of the exporter's: `fact_case`, `fact_detection`, `fact_endpoint_snapshot`, `fact_alert` and `fact_license`, with the same column names. Dates are UTC dates.

## Grafana

`grafana/` holds four dashboards (overview, cases, detections and ATT&CK, endpoints with licenses and alerts), provisioning for the data source and dashboards, a small read-only file server for the CSV folder, and a Docker Compose file. The dashboards use the [Infinity data source](https://grafana.com/grafana/plugins/yesoreyeram-infinity-datasource/) and run every query on the Grafana server.

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

The endpoint, license and health check panels show one snapshot, picked at the top of the dashboard; the newest is picked on load.

## The data

The full data dictionary is in [docs/data-dictionary.md](docs/data-dictionary.md), generated from the schema; `_schema.json` in the output folder has the same information for tools.

- Facts: `fact_case`, `fact_detection`, `fact_detection_daily`, `fact_technique_daily`, `fact_sensor_daily`, `fact_endpoint_snapshot`, `fact_health_check_snapshot`, `fact_license`, `fact_alert`. Dimensions: `dim_tenant`, `dim_case_type`, `dim_case_status`, `dim_case_verdict`, `dim_detector`, `dim_mitre_technique`, `dim_sensor_type`. Bridges: `bridge_detection_technique`, `bridge_detection_sensor`, `bridge_detection_entity`.
- Every row starts with `tenant_id`, the Sophos Central tenant ID. Keys are Sophos IDs paired with `tenant_id`.
- Timestamps are UTC ISO 8601 with `Z`. `*_local_date` columns are dates in `reportTimezone`, and `*_date_key` the same date as a number (YYYYMMDD).
- Load modes: cases and alerts are upserted on their ID; detections are replaced inside the window each run reads; endpoints, licenses and health check scores are daily snapshots; reference lists are replaced each run.
- Severity bands for detections: Critical 0.8 and up, High 0.6, Medium 0.4, Low 0.2, otherwise Info.
- Case response time is created to closed. Sophos sends no acknowledged or first response time.

## Personal data

Off by default. With it off, these columns are written empty and `bridge_detection_entity` holds only its header: case titles and close reasons, detection descriptions, endpoint hostnames, IP addresses and associated users, and alert descriptions. Turning the switch off later also empties what earlier runs wrote. IDs (case, detection, endpoint, assignee) are always exported.

Turn it on with `"personalData": true` or `--personal-data` only where the files are protected to the same standard as the Sophos console. In SharePoint, apply a sensitivity label to the library. Case comments, key findings and playbook data are never exported.

## Security

- Read only, by construction: see [What it reads](#what-it-reads). Redirects from Sophos are refused rather than followed.
- Secrets come from the environment or an env file, never from the config file, the output folder or `_state/`. Nothing logs a secret.
- The CSV file server for Grafana listens on 127.0.0.1 by default and serves only the table files.
- The SharePoint upload can reach only the Entra token endpoint, Microsoft Graph and SharePoint upload URLs. With `Sites.Selected` it can write to the one site you granted.
- Report security issues privately: see [SECURITY.md](SECURITY.md).

## Limitations

- One tenant per credential in this release.
- Sophos keeps detections for 90 days (13 months or more with NG-SIEM), so a backfill can't reach further back. The exporter keeps what it has read for as long as you keep the files.
- One search returns at most 10,000 detections, so the exporter splits a busy window into time slices. A single second with more than 10,000 detections would be cut short, with a warning.
- Endpoint health, licenses and health check scores are snapshots from the exporter's runs. There is no history before the first run.
- Product alerts leave the Common API once acknowledged. The table keeps every alert the exporter has seen.
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
UPDATE_GOLDEN=1 node --test test/run.test.mjs   # accept a deliberate change to the golden CSVs
```

Never commit a real export. `demo/` and the test fixtures are synthetic. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE). Vendored and adapted code is listed in [ATTRIBUTIONS.md](ATTRIBUTIONS.md) and [NOTICE](NOTICE). Sophos, Sophos Central and Sophos Fusion are trademarks of Sophos Limited; see [TRADEMARKS.md](TRADEMARKS.md).
