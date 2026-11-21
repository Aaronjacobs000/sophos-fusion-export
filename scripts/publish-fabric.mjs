#!/usr/bin/env node
/**
 * Publishes a PBIP project from powerbi/ (semantic model and report) to a
 * Power BI or Fabric workspace through the Fabric REST API, so Power BI
 * Desktop isn't needed (handy on macOS and Linux). Creates the items, or
 * updates their definitions when items with the same names exist.
 *
 *   export FABRIC_TOKEN=$(az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv)
 *   node scripts/publish-fabric.mjs --project powerbi/csv/FusionExport --workspace me \
 *     --name "Fusion Export" --param SharePointSiteUrl=https://contoso.sharepoint.com/sites/reporting \
 *     --param ExportFolder=FusionExport/acme
 *
 * --workspace takes a workspace ID, or "me" for My workspace. Parameters
 * are written into the uploaded model only, never into the repository. After
 * the first publish, set the data source credentials once in the semantic
 * model's settings (README: Power BI service setup).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const API = "https://api.fabric.microsoft.com/v1";

function args() {
  const out = { params: {} };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--project") out.project = next();
    else if (a === "--workspace") out.workspace = next();
    else if (a === "--name") out.name = next();
    else if (a === "--param") {
      const [k, ...v] = next().split("=");
      out.params[k] = v.join("=");
    } else if (a === "--help") out.help = true;
    else throw new Error(`Unknown option ${a}`);
  }
  return out;
}

const token = process.env.FABRIC_TOKEN;

async function call(method, path, body) {
  const response = await fetch(path.startsWith("https://") ? path : `${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (response.status === 202) return { pending: response.headers.get("Location") ?? `${API}/operations/${response.headers.get("x-ms-operation-id")}`, retry: Number(response.headers.get("Retry-After") ?? 3) };
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 600)}`);
  return data;
}

async function settle(result) {
  if (!result?.pending) return result;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, Math.max(1, result.retry) * 1000));
    const state = await call("GET", result.pending);
    if (state.status === "Succeeded") return call("GET", `${result.pending.replace(/\/$/, "")}/result`).catch(() => state);
    if (state.status === "Failed") throw new Error(`Fabric refused the definition: ${JSON.stringify(state.error)}`);
  }
  throw new Error("Timed out waiting for Fabric.");
}

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === ".pbi" || name === ".gitignore") return [];
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

const part = (path, text) => ({ path, payload: Buffer.from(text, "utf8").toString("base64"), payloadType: "InlineBase64" });

function modelParts(dir, params) {
  const bim = JSON.parse(readFileSync(join(dir, "model.bim"), "utf8"));
  for (const e of bim.model.expressions ?? []) {
    if (!(e.name in params)) continue;
    const meta = String(e.expression).indexOf(" meta ");
    if (meta < 0) throw new Error(`${e.name} is not a parameter`);
    e.expression = `${JSON.stringify(params[e.name])}${String(e.expression).slice(meta)}`;
  }
  const unknown = Object.keys(params).filter((k) => !(bim.model.expressions ?? []).some((e) => e.name === k));
  if (unknown.length) throw new Error(`The model has no parameter ${unknown.join(", ")}`);
  return [part("model.bim", JSON.stringify(bim, null, 2)), part("definition.pbism", readFileSync(join(dir, "definition.pbism"), "utf8"))];
}

function reportParts(dir, modelId) {
  return filesUnder(dir).map((file) => {
    const rel = relative(dir, file).split("\\").join("/");
    if (rel !== "definition.pbir") return part(rel, readFileSync(file, "utf8"));
    const pbir = JSON.parse(readFileSync(file, "utf8"));
    pbir.datasetReference = { byConnection: { connectionString: `semanticmodelid=${modelId}` } };
    return part(rel, JSON.stringify(pbir, null, 2));
  });
}

async function upsert(workspace, kind, name, description, parts) {
  const list = await call("GET", `/workspaces/${workspace}/${kind}`);
  const found = (list.value ?? []).find((x) => x.displayName === name);
  if (found) {
    await settle(await call("POST", `/workspaces/${workspace}/${kind}/${found.id}/updateDefinition`, { definition: { parts } }));
    return { id: found.id, created: false };
  }
  const created = await settle(await call("POST", `/workspaces/${workspace}/${kind}`, { displayName: name, description, definition: { parts } }));
  return { id: created.id, created: true };
}

async function main() {
  const a = args();
  if (a.help || !a.project) {
    console.log("Usage: node scripts/publish-fabric.mjs --project powerbi/csv/FusionExport --workspace <id|me> --name <display name> [--param Name=Value]...");
    return;
  }
  if (!token) throw new Error("Set FABRIC_TOKEN to a Fabric API access token (see the comment at the top of this script).");
  let workspace = a.workspace ?? "me";
  if (workspace === "me") {
    const list = await call("GET", "/workspaces");
    workspace = (list.value ?? []).find((w) => w.type === "Personal")?.id;
    if (!workspace) throw new Error("Couldn't find My workspace for this account.");
  }
  const base = a.project.replace(/\/$/, "");
  const name = a.name ?? base.split("/").pop();
  const model = await upsert(workspace, "semanticModels", name, "Unofficial Sophos Fusion Data Exporter model. Not a Sophos product.", modelParts(`${base}.SemanticModel`, a.params));
  console.log(`Semantic model ${model.created ? "created" : "updated"}: ${model.id}`);
  const report = await upsert(workspace, "reports", name, "Unofficial Sophos Fusion Data Exporter report. Not a Sophos product.", reportParts(`${base}.Report`, model.id));
  console.log(`Report ${report.created ? "created" : "updated"}: ${report.id}`);
  console.log(`Open: https://app.powerbi.com/groups/${a.workspace === "me" || !a.workspace ? "me" : workspace}/reports/${report.id}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
