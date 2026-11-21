// The Azure Container Apps job path: config from FUSION_EXPORT_CONFIG_JSON,
// the Sophos credential from Key Vault and the SharePoint upload through the
// managed identity. Every Azure endpoint is a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertIdentityEndpoint,
  keyVaultOrigin,
  ManagedIdentity,
  ManagedIdentityError,
  managedIdentityFromEnv,
  readKeyVaultSecret,
  resolveSophosCredentials,
} from "../dist/azure/managed-identity.js";
import { buildConfig, ConfigError } from "../dist/config.js";
import { main, parseArgs, settings, sharepointConfig } from "../dist/cli.js";
import { SharePointSink } from "../dist/sinks/sharepoint.js";
import { fakeSophos } from "./helpers/fake-sophos.mjs";

const ENDPOINT = "http://localhost:42356/msi/token";
const HEADER = "identity-header-value";
const UAMI = "11111111-2222-3333-4444-555555555555";
const VAULT = "https://kv-fusion-test.vault.azure.net";
const KV_SECRETS = { "sophos-client-id": "kv-client-id", "sophos-client-secret": "kv-client-secret-value" };

/** A fake identity endpoint and Key Vault. Records every request. */
function fakeAzure({ tokenStatus = [], kvStatus = {} } = {}) {
  const requests = [];
  const statuses = [...tokenStatus];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ host: url.host, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: init.headers ?? {}, redirect: init.redirect });
    if (url.hostname === "localhost") {
      const status = statuses.shift() ?? 200;
      if (status !== 200) return Response.json({ statusCode: status, message: "not ready" }, { status });
      const resource = url.searchParams.get("resource");
      return Response.json({ access_token: `token-for-${resource}`, expires_on: String(Math.floor(Date.now() / 1000) + 3600), resource, token_type: "Bearer" });
    }
    if (url.hostname.endsWith(".vault.azure.net")) {
      const name = url.pathname.replace("/secrets/", "");
      const status = kvStatus[name] ?? (KV_SECRETS[name] ? 200 : 404);
      if (status === 403) return Response.json({ error: { code: "Forbidden", message: "Caller is not authorized", innererror: { code: "ForbiddenByRbac" } } }, { status });
      if (status === 404) return Response.json({ error: { code: "SecretNotFound", message: "not found" } }, { status });
      return Response.json({ value: KV_SECRETS[name], id: `${VAULT}/secrets/${name}/abc` });
    }
    return new Response("{}", { status: 599 });
  };
  return { fetch, requests };
}

test("managed identity: only a local endpoint, and the environment Container Apps sets", () => {
  assert.equal(assertIdentityEndpoint(ENDPOINT).port, "42356");
  assertIdentityEndpoint("http://127.0.0.1:41000/msi/token");
  assertIdentityEndpoint("http://169.254.169.254/metadata/identity/oauth2/token");
  assert.throws(() => assertIdentityEndpoint("https://identity.evil.test/msi/token"), ManagedIdentityError);
  assert.throws(() => assertIdentityEndpoint("http://user:pw@localhost/msi/token"), ManagedIdentityError);
  assert.throws(() => assertIdentityEndpoint("file:///etc/passwd"), ManagedIdentityError);
  assert.throws(() => managedIdentityFromEnv({}), /IDENTITY_ENDPOINT and IDENTITY_HEADER are not set/);
  assert.deepEqual(managedIdentityFromEnv({ IDENTITY_ENDPOINT: ENDPOINT, IDENTITY_HEADER: HEADER }), { endpoint: ENDPOINT, header: HEADER });
  assert.equal(managedIdentityFromEnv({ IDENTITY_ENDPOINT: ENDPOINT, IDENTITY_HEADER: HEADER, AZURE_CLIENT_ID: UAMI }).clientId, UAMI);
});

test("managed identity: the token request, the user-assigned identity and the cache", async () => {
  const azure = fakeAzure();
  const identity = new ManagedIdentity({ endpoint: ENDPOINT, header: HEADER, clientId: UAMI, fetch: azure.fetch });
  const first = await identity.token("https://graph.microsoft.com");
  assert.equal(first.value, "token-for-https://graph.microsoft.com");
  assert.ok(first.expiresAt > Date.now() + 3_000_000 && first.expiresAt <= Date.now() + 3_600_000);
  const [request] = azure.requests;
  assert.equal(request.path, "/msi/token");
  assert.deepEqual(request.query, { resource: "https://graph.microsoft.com", "api-version": "2019-08-01", client_id: UAMI });
  assert.equal(request.headers["X-IDENTITY-HEADER"], HEADER);
  assert.equal(request.redirect, "error");
  await identity.token("https://graph.microsoft.com");
  assert.equal(azure.requests.length, 1, "a live token is reused");
  await identity.token("https://vault.azure.net");
  assert.equal(azure.requests.length, 2, "each resource has its own token");
  const system = fakeAzure();
  await new ManagedIdentity({ endpoint: ENDPOINT, header: HEADER, fetch: system.fetch }).token("https://vault.azure.net");
  assert.equal(system.requests[0].query.client_id, undefined, "no client_id means the system-assigned identity");
});

test("managed identity: a 503 is retried, a 400 is not, and errors carry no token or header", async () => {
  const flaky = fakeAzure({ tokenStatus: [503] });
  const ok = await new ManagedIdentity({ endpoint: ENDPOINT, header: HEADER, fetch: flaky.fetch, attempts: 2 }).token("https://vault.azure.net");
  assert.ok(ok.value);
  assert.equal(flaky.requests.length, 2);
  const refused = fakeAzure({ tokenStatus: [400, 400] });
  const identity = new ManagedIdentity({ endpoint: ENDPOINT, header: HEADER, clientId: UAMI, fetch: refused.fetch, attempts: 3 });
  await assert.rejects(identity.token("https://vault.azure.net"), (error) => {
    assert.ok(error instanceof ManagedIdentityError);
    assert.match(error.message, /no token for https:\/\/vault.azure.net with the user-assigned identity 1111.*400/);
    assert.ok(!error.message.includes(HEADER));
    return true;
  });
  assert.equal(refused.requests.length, 1, "a 400 is final");
});

test("Key Vault: the address check, the secret read and plain errors", async () => {
  assert.equal(keyVaultOrigin("https://KV-Fusion-Test.vault.azure.net/"), "https://kv-fusion-test.vault.azure.net");
  assert.throws(() => keyVaultOrigin("http://kv-fusion-test.vault.azure.net"), ManagedIdentityError);
  assert.throws(() => keyVaultOrigin("https://kv-fusion-test.vault.azure.net.evil.test"), ManagedIdentityError);
  assert.throws(() => keyVaultOrigin("not a url"), ManagedIdentityError);
  const azure = fakeAzure();
  const identity = new ManagedIdentity({ endpoint: ENDPOINT, header: HEADER, fetch: azure.fetch });
  assert.equal(await readKeyVaultSecret(VAULT, "sophos-client-secret", identity, azure.fetch), "kv-client-secret-value");
  const read = azure.requests.find((r) => r.host.endsWith("vault.azure.net"));
  assert.equal(read.path, "/secrets/sophos-client-secret");
  assert.equal(read.query["api-version"], "7.4");
  assert.equal(read.headers.Authorization, "Bearer token-for-https://vault.azure.net");
  await assert.rejects(readKeyVaultSecret(VAULT, "missing", identity, azure.fetch), /has no secret named missing/);
  await assert.rejects(readKeyVaultSecret(VAULT, "../keys/x", identity, azure.fetch), /not a Key Vault secret name/);
  const denied = fakeAzure({ kvStatus: { "sophos-client-secret": 403 } });
  await assert.rejects(readKeyVaultSecret(VAULT, "sophos-client-secret", identity, denied.fetch), /Key Vault Secrets User role/);
});

test("Sophos credential: the environment first, then Key Vault for what is missing", async () => {
  const env = { SOPHOS_CLIENT_ID: "env-id", SOPHOS_CLIENT_SECRET: "env-secret", SOPHOS_KEY_VAULT_URL: VAULT };
  const unused = fakeAzure();
  assert.deepEqual(await resolveSophosCredentials(env, { fetch: unused.fetch }), { clientId: "env-id", clientSecret: "env-secret", source: "environment" });
  assert.equal(unused.requests.length, 0, "no Key Vault call when the environment has both");
  assert.deepEqual(await resolveSophosCredentials({}), { clientId: "", clientSecret: "", source: "environment" }, "unchanged without SOPHOS_KEY_VAULT_URL");

  const azure = fakeAzure();
  const identity = new ManagedIdentity({ endpoint: ENDPOINT, header: HEADER, fetch: azure.fetch });
  assert.deepEqual(await resolveSophosCredentials({ SOPHOS_KEY_VAULT_URL: VAULT }, { identity, fetch: azure.fetch }), {
    clientId: "kv-client-id",
    clientSecret: "kv-client-secret-value",
    source: "key vault",
  });
  const partial = fakeAzure();
  const partialIdentity = new ManagedIdentity({ endpoint: ENDPOINT, header: HEADER, fetch: partial.fetch });
  const mixed = await resolveSophosCredentials({ SOPHOS_KEY_VAULT_URL: VAULT, SOPHOS_CLIENT_ID: "env-id" }, { identity: partialIdentity, fetch: partial.fetch });
  assert.equal(mixed.clientId, "env-id");
  assert.equal(mixed.clientSecret, "kv-client-secret-value");
  assert.deepEqual(partial.requests.filter((r) => r.host.endsWith("vault.azure.net")).map((r) => r.path), ["/secrets/sophos-client-secret"]);
  await assert.rejects(resolveSophosCredentials({ SOPHOS_KEY_VAULT_URL: VAULT }), /IDENTITY_ENDPOINT and IDENTITY_HEADER are not set/);
  await assert.rejects(resolveSophosCredentials({ SOPHOS_KEY_VAULT_URL: "https://example.com" }), /not a Key Vault host/);
});

test("config: sharepoint.auth, the config in FUSION_EXPORT_CONFIG_JSON, and the local path unchanged", async () => {
  assert.equal(buildConfig({ sharepoint: { siteUrl: "https://contoso.sharepoint.com/sites/r" } }).sharepoint.auth, undefined);
  assert.equal(buildConfig({ sharepoint: { siteUrl: "https://contoso.sharepoint.com/sites/r", auth: "managedIdentity" } }).sharepoint.auth, "managedIdentity");
  assert.throws(() => buildConfig({ sharepoint: { siteUrl: "https://contoso.sharepoint.com/sites/r", auth: "password" } }), /sharepoint.auth must be/);

  const json = JSON.stringify({ outputDir: "/data", reportTimezone: "Australia/Sydney", sharepoint: { siteUrl: "https://contoso.sharepoint.com/sites/r", auth: "managedIdentity" } });
  const fromEnv = settings(parseArgs(["run"]), { FUSION_EXPORT_CONFIG_JSON: json });
  assert.equal(fromEnv.outputDir, resolve("/data"));
  assert.equal(fromEnv.reportTimezone, "Australia/Sydney");
  assert.equal(settings(parseArgs(["run", "--out", "/tmp/x"]), { FUSION_EXPORT_CONFIG_JSON: json }).outputDir, resolve("/tmp/x"));
  assert.equal(settings(parseArgs(["run", "--no-upload"]), { FUSION_EXPORT_CONFIG_JSON: json }).sharepoint, undefined);
  assert.throws(() => settings(parseArgs(["run", "--config", "x.json"]), { FUSION_EXPORT_CONFIG_JSON: json }), /not both/);
  assert.throws(() => settings(parseArgs(["run"]), { FUSION_EXPORT_CONFIG_JSON: "{" }), /FUSION_EXPORT_CONFIG_JSON is not valid JSON/);
  assert.throws(() => settings(parseArgs(["run"]), { FUSION_EXPORT_CONFIG_JSON: JSON.stringify({ sophosClientSecret: "x" }) }), ConfigError);
  assert.deepEqual(settings(parseArgs(["run"]), {}), buildConfig({}), "no config file and no variable gives the defaults, as before");

  const mi = sharepointConfig(fromEnv, { AZURE_CLIENT_ID: UAMI, GRAPH_CLIENT_SECRET: "unused" });
  assert.deepEqual(mi, { siteUrl: "https://contoso.sharepoint.com/sites/r", auth: "managedIdentity", managedIdentityClientId: UAMI });
  const secret = sharepointConfig(buildConfig({ sharepoint: { siteUrl: "https://contoso.sharepoint.com/sites/r" } }), { GRAPH_TENANT_ID: "t", GRAPH_CLIENT_ID: "c", GRAPH_CLIENT_SECRET: "s" });
  assert.deepEqual(secret, { siteUrl: "https://contoso.sharepoint.com/sites/r", tenantId: "t", clientId: "c", clientSecret: "s" });
  assert.throws(() => sharepointConfig(buildConfig({ sharepoint: { siteUrl: "https://contoso.sharepoint.com/sites/r" } }), {}), /GRAPH_CLIENT_SECRET is missing/);
});

test("SharePoint: the managed identity sign-in sends the identity's Graph token and no app secret", async () => {
  const calls = [];
  const fetch = async (input, init = {}) => {
    calls.push({ line: `${init.method ?? "GET"} ${new URL(input).pathname}`, auth: init.headers?.Authorization });
    if (input.includes("/drives?")) return Response.json({ value: [{ id: "drive1", name: "Documents" }] });
    if (input.includes("/sites/")) return Response.json({ id: "site1", webUrl: "https://contoso.sharepoint.com/sites/reporting" });
    if (init.method === "PUT") return Response.json({ webUrl: "https://contoso.sharepoint.com/x.csv" });
    return new Response("{}", { status: 404 });
  };
  const resources = [];
  const identity = { token: async (resource) => (resources.push(resource), { value: "mi-graph-token", expiresAt: Date.now() + 3_600_000 }) };
  const sink = new SharePointSink({ auth: "managedIdentity", siteUrl: "https://contoso.sharepoint.com/sites/reporting" }, fetch, identity);
  const { sent } = await sink.sync(new Map([["a.csv", "x\n1\n"]]), {});
  assert.deepEqual(sent, ["a.csv"]);
  assert.ok(!calls.some((c) => c.line.includes("oauth2")), "no Entra client credentials call");
  assert.ok(calls.every((c) => c.auth === "Bearer mi-graph-token"));
  assert.ok(resources.every((r) => r === "https://graph.microsoft.com"));
  assert.throws(() => new SharePointSink({ auth: "managedIdentity", siteUrl: "" }, fetch, identity), /needs siteUrl/);
  assert.throws(() => new SharePointSink({ auth: "managedIdentity", siteUrl: "https://contoso.sharepoint.com/sites/reporting" }), /IDENTITY_ENDPOINT and IDENTITY_HEADER are not set/);
});

test("the container path end to end: config from the environment, credential from Key Vault, upload with the managed identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fusion-export-aca-"));
  const sophos = fakeSophos();
  const azure = fakeAzure();
  const graph = [];
  const fakeFetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === "localhost" || url.hostname.endsWith(".vault.azure.net")) return azure.fetch(input, init);
    if (url.hostname === "login.microsoftonline.com") throw new Error("the client secret flow must not run");
    if (url.hostname === "graph.microsoft.com") {
      graph.push({ line: `${init.method ?? "GET"} ${url.pathname}`, auth: init.headers?.Authorization });
      if (url.pathname.endsWith("/drives")) return Response.json({ value: [{ id: "drive1", name: "Documents" }] });
      if (url.pathname.startsWith("/v1.0/sites/")) return Response.json({ id: "site1", webUrl: "https://contoso.sharepoint.com/sites/reporting" });
      if (init.method === "PUT") return Response.json({ webUrl: "https://contoso.sharepoint.com/x" });
      return new Response("{}", { status: 404 });
    }
    return sophos.fetch(input, init);
  };
  const env = {
    FUSION_EXPORT_CONFIG_JSON: JSON.stringify({
      outputDir: dir,
      reportTimezone: "Australia/Sydney",
      sharepoint: { siteUrl: "https://contoso.sharepoint.com/sites/reporting", folder: "FusionExport/test", auth: "managedIdentity" },
    }),
    SOPHOS_KEY_VAULT_URL: VAULT,
    IDENTITY_ENDPOINT: ENDPOINT,
    IDENTITY_HEADER: HEADER,
    AZURE_CLIENT_ID: UAMI,
  };
  const saved = { fetch: globalThis.fetch, env: { ...process.env }, log: console.log };
  const printed = [];
  try {
    for (const key of ["SOPHOS_CLIENT_ID", "SOPHOS_CLIENT_SECRET", "GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET"]) delete process.env[key];
    Object.assign(process.env, env);
    globalThis.fetch = fakeFetch;
    console.log = (m) => printed.push(String(m));
    const code = await main(["run"]);
    assert.equal(code, 0, printed.join("\n"));
  } finally {
    globalThis.fetch = saved.fetch;
    console.log = saved.log;
    for (const key of Object.keys(process.env)) if (!(key in saved.env)) delete process.env[key];
    Object.assign(process.env, saved.env);
  }
  const signIn = sophos.requests.find((r) => r.host === "id.sophos.com");
  assert.ok(String(signIn.body).includes("kv-client-id"), "the Sophos sign-in used the client ID from Key Vault");
  assert.deepEqual(azure.requests.filter((r) => r.host.endsWith("vault.azure.net")).map((r) => r.path).sort(), ["/secrets/sophos-client-id", "/secrets/sophos-client-secret"]);
  assert.ok(azure.requests.filter((r) => r.host.startsWith("localhost")).every((r) => r.query.client_id === UAMI));
  assert.ok(graph.length > 0 && graph.every((g) => g.auth === "Bearer token-for-https://graph.microsoft.com"));
  assert.ok(graph.some((g) => g.line === "PUT /v1.0/drives/drive1/root:/FusionExport/test/fact_case.csv:/content"));
  assert.ok(printed.some((m) => m.includes("Sophos credential read from Key Vault")));
  assert.ok(!printed.join("\n").includes("kv-client-secret-value"), "the secret is never printed");
  const runs = await readFile(join(dir, "_state", "runs.jsonl"), "utf8");
  assert.ok(!runs.includes("kv-client-secret-value") && !runs.includes(HEADER), "the run log holds no secret");
  assert.match(await readFile(join(dir, "_state", "uploads.json"), "utf8"), /fact_case\.csv/);
  await rm(dir, { recursive: true, force: true });
});
