# Attributions and vendored code

## @notfusion/sophos-core (vendored)

`src/vendor/sophos-core/` is a copy of part of `packages/sophos-core/src` from NotFusion, another project by the same author (private repository, branch main at commit `c439303`, 21/11/2026, which includes that day's case short ID fix), licensed Apache-2.0 AND MIT. The SecOps Toolkit vendors the same package the same way. It is meant to be replaced by a published package later, so the MCP server, NotFusion, the toolkit and this exporter stop drifting apart.

Only the transport is copied: `config.ts`, `http.ts`, `hosts.ts`, `logger.ts`, `auth/token-manager.ts`, `client/tenant-resolver.ts`, `client/sophos-client.ts`, `client/fusion-client.ts`, `types/sophos.ts` and `services/licenses.ts`. The services that write (isolation, scans, alert actions, case writes, policies, firewall and network changes) are left out, and the exporter's own GraphQL documents replace NotFusion's.

Local modifications, each marked "Exporter local modification" in the source:

| File | Change |
| --- | --- |
| `http.ts` | Adds `FetchLike` and `defaultFetch`. |
| `auth/token-manager.ts`, `client/tenant-resolver.ts`, `client/sophos-client.ts`, `client/fusion-client.ts` | Call an injected fetch instead of the global one, so the exporter's read-only, rate limited guard sees every request. |
| `client/fusion-client.ts` | `putPresigned` (the case file upload, a write) is removed. |
| `index.ts` | Replaced: exports only the copied files, and `createSophosCore` takes the fetch every client uses. |
| `client/sophos-client.ts` | Bug fix: a 4xx whose body is not JSON is no longer retried. The old check matched the message `Sophos API error 404:`, but a non-JSON body gives `Sophos API error (404):`, so it was sent twice more. |
| `client/fusion-client.ts` | Bug fix ported from NotFusion main `5e335a4`: the 503 Sophos Fusion returns for a tenant it does not hold (`isTenantNotOnFusion`) is no longer retried, since it is the same answer every time. Any other 503 is still retried. |

## SecOps Toolkit (adapted)

`src/sophos/guard.ts`, `src/sophos/limiter.ts` and `src/datasets/sensor-labels.ts` are adapted from the SecOps Toolkit (https://github.com/Aaronjacobs000/sophos-secops-toolkit), MIT License, same author. The guard here is stricter: no Search mutations, no XDR query runs, no download host, GET paths on an allowlist, and GraphQL documents compared whole rather than by operation name.

## sophos-mcp

Through sophos-core: `TokenManager`, `TenantResolver`, `SophosClient` and `FusionClient` are adapted from sophos-central-mcp-server (https://github.com/Aaronjacobs000/sophos-mcp), MIT License (`src/vendor/sophos-core/LICENSE-MIT`).

## Sophos Fusion GraphQL schemas

`schemas/fusion/cases-v2.graphql` and `schemas/fusion/detections-v2.graphql` are the schemas Sophos publishes on https://developer.sophos.com, copied unmodified from NotFusion's vendored set. Tests validate every query the exporter sends against them. They remain Sophos's material; this project's licence does not cover them.
