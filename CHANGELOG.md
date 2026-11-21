# Changelog

## 0.1.0 (unreleased)

First version, private while the live checks run.

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
