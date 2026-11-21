// The Azure template and the image agree with the exporter: the variables it
// reads, the Key Vault secret names, the output folder, the image tag and the
// defaults. CI also runs bicep lint and checks azuredeploy.json is current.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CONFIG_ENV } from "../dist/config.js";
import { SOPHOS_CLIENT_ID_SECRET, SOPHOS_CLIENT_SECRET_SECRET } from "../dist/azure/managed-identity.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("azuredeploy.json: parameters, secrets, the job's variables and its output folder", async () => {
  const template = JSON.parse(await read("deploy/azure/azuredeploy.json"));
  const pkg = JSON.parse(await read("package.json"));
  const p = template.parameters;
  assert.equal(p.image.defaultValue, `ghcr.io/aaronjacobs000/sophos-fusion-export:${pkg.version}`, "the default image is this version's published image");
  assert.equal(p.sophosClientId.type, "securestring");
  assert.equal(p.sophosClientSecret.type, "securestring");
  assert.equal(p.sophosClientSecret.defaultValue, undefined);
  assert.equal(p.personalData.defaultValue, false, "personal data stays off by default");
  assert.equal(p.cronExpression.defaultValue, "17 0,6,12,18 * * *", "four runs a day, as in the README");
  assert.match(p.mountOptions.defaultValue, /\buid=1000\b.*\bgid=1000\b/, "the share belongs to the image's node user");

  const secrets = template.resources.filter((r) => r.type === "Microsoft.KeyVault/vaults/secrets").map((r) => r.name);
  assert.ok(secrets.some((n) => n.includes(`'${SOPHOS_CLIENT_ID_SECRET}'`)));
  assert.ok(secrets.some((n) => n.includes(`'${SOPHOS_CLIENT_SECRET_SECRET}'`)));

  const job = template.resources.find((r) => r.type === "Microsoft.App/jobs");
  const container = job.properties.template.containers[0];
  assert.deepEqual(container.env.map((e) => e.name).sort(), [CONFIG_ENV, "AZURE_CLIENT_ID", "NODE_OPTIONS", "SOPHOS_KEY_VAULT_URL"].sort());
  assert.ok(!container.env.some((e) => e.secretRef), "no Container Apps secrets: the credential stays in Key Vault");
  assert.equal(container.args[1], "--out");
  assert.equal(container.volumeMounts[0].mountPath, container.args[2]);
  assert.deepEqual(template.variables.jobs.map((j) => [j.triggerType, j.command]), [["Schedule", "run"], ["Manual", "backfill"]]);
  assert.equal(job.properties.configuration.replicaRetryLimit, 1);
  assert.match(template.variables.exporterConfig, /'auth', 'managedIdentity'/);

  const roles = template.resources.filter((r) => r.type === "Microsoft.Authorization/roleAssignments");
  assert.equal(roles.length, 2, "Key Vault Secrets User, and AcrPull when a registry is named");
  assert.equal(template.variables.keyVaultSecretsUserRole, "4633458b-17de-408a-b874-0445c86b69e6");
  assert.equal(template.variables.acrPullRole, "7f951dda-4ed3-4680-a7ca-43fe172d538d");
  assert.ok(!JSON.stringify(template.outputs).match(/listKeys|secret/i), "no output carries a key or secret");
});

test("Dockerfile: pinned base, non-root, and the same Node.js major as CI", async () => {
  const dockerfile = await read("Dockerfile");
  assert.match(dockerfile, /^ARG NODE_IMAGE=node:24\.\d+\.\d+-alpine[\d.]+@sha256:[0-9a-f]{64}\r?$/m, "the base image is pinned by version and digest");
  assert.match(dockerfile, /^USER node\r?$/m);
  assert.match(dockerfile, /^ENTRYPOINT \["node", "\/app\/dist\/cli.js"\]\r?$/m);
  const ci = await read(".github/workflows/ci.yml");
  assert.match(ci, /node: \['22', '24'\]/);
  const ignore = await read(".dockerignore");
  assert.match(ignore, /^\*\r?$/m, "the build context starts empty");
});

test("README: the Deploy to Azure button opens azuredeploy.json on main", async () => {
  const readme = await read("README.md");
  const raw = "https://raw.githubusercontent.com/Aaronjacobs000/sophos-fusion-export/main/deploy/azure/azuredeploy.json";
  assert.ok(readme.includes(`https://portal.azure.com/#create/Microsoft.Template/uri/${encodeURIComponent(raw)}`));
});
