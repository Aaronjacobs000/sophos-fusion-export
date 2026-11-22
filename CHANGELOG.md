# Changelog

## 0.1.0 (22/11/2026)

First release.

- Exporter for one tenant credential: licenses, cases (Sophos Fusion Cases v2, cases v1 for a tenant not yet on Sophos Fusion), detections with MITRE ATT&CK, endpoint health, Account Health Check scores and product alerts, from documented APIs only.
- Star schema CSV with `tenant_id` on every row, `_schema.json`, watermarks in `_state/`, and reruns that write the same files for the same data.
- Detections are read in time slices of at most 10,000, since offset paging past 10,000 repeats rows.
- Commands: `doctor`, `run`, `backfill`, `schema`.
- Personal data switch, off by default.
- Call budget of 60 a minute and 900 an hour, under Sophos's 100 a minute per credential.
- Upload to SharePoint or OneDrive through Microsoft Graph, sending only changed files.
- Power BI projects for the CSV path and the direct path, and a script that publishes them through the Fabric REST API.
- Grafana dashboards, provisioning, a read-only CSV server and a Docker Compose file.
- Synthetic demo data.
- The Sophos Fusion 503 for a tenant Sophos Fusion does not hold is sent once, not retried twice (NotFusion fix `5e335a4`).
- A 429 whose Retry-After is an HTTP date pauses the credential until that date, not for the 30 s default.
- Sophos AI Defense, from the documented AI Defense Activity and Policy GraphQL APIs: license and inventory totals, activity with daily counts, applications with their sanctioning status, users and policies, in seven new tables (schema 1.1). User and device names are personal columns; a hashed `user_key` joins activity to users.
- An AI Defense dashboard in Grafana and an AI Defense page in the Power BI CSV path report.
- Runs in Azure with no machine: a container image (`ghcr.io/aaronjacobs000/sophos-fusion-export`, non-root, built by a workflow), and a Bicep template with a Deploy to Azure button for a scheduled Azure Container Apps job, its manual backfill job, Key Vault, an Azure Files share for the output folder, Log Analytics and the role assignments. See `docs/azure.md`.
- The Sophos credential can come from Key Vault (`SOPHOS_KEY_VAULT_URL`) and the SharePoint upload can sign in with the host's managed identity (`sharepoint.auth: "managedIdentity"`). The config can come from `FUSION_EXPORT_CONFIG_JSON`. All three are off unless set.
