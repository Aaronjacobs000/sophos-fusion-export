// The read-only guard: only GETs on the exporter's own paths, the token
// request, and the exporter's own query documents, exactly as written, ever
// leave the process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertReadOnly, allowedDocument, createGuardedFetch, ReadOnlyViolationError, CallBudgetError, ALLOWED_GET_PATHS } from "../dist/sophos/guard.js";
import { DOCUMENTS, CASES_PAGE } from "../dist/sophos/documents.js";
import { RateLimiter } from "../dist/sophos/limiter.js";
import { createSophosCore } from "../dist/vendor/sophos-core/index.js";
import { SophosSession } from "../dist/sophos/session.js";
import { fakeSophos } from "./helpers/fake-sophos.mjs";

const REGION = "https://api-eu01.central.sophos.com";
const GQL = "https://api.taegis.sophos.com/graphql";
const post = (body) => ({ method: "POST", body: JSON.stringify(body) });
const blocked = (fn) => assert.throws(fn, ReadOnlyViolationError);

test("the token request is allowed as a plain POST only", () => {
  assertReadOnly("https://id.sophos.com/api/v2/oauth2/token", { method: "POST", body: "grant_type=client_credentials" });
  blocked(() => assertReadOnly("https://id.sophos.com/api/v2/oauth2/token"));
  blocked(() => assertReadOnly("https://id.sophos.com/api/v2/oauth2/token?x=1", { method: "POST" }));
  blocked(() => assertReadOnly("https://id.sophos.com/api/v2/other", { method: "POST" }));
});

test("GETs on the exporter's paths pass, on the global and regional hosts", () => {
  for (const path of ["/whoami/v1", "/licenses/v1/licenses", "/endpoint/v1/endpoints", "/common/v1/alerts", "/account-health-check/v1/health-check", "/cases/v1/cases"]) {
    assertReadOnly(`${REGION}${path}?pageSize=1`);
    assertReadOnly(`https://api.central.sophos.com${path}`);
  }
  assert.equal(ALLOWED_GET_PATHS.length, 6);
});

test("any other method or path on Sophos Central is refused", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    blocked(() => assertReadOnly(`${REGION}/endpoint/v1/endpoints`, { method }));
  }
  blocked(() => assertReadOnly(`${REGION}/endpoint/v1/endpoints/123/isolation`));
  blocked(() => assertReadOnly(`${REGION}/common/v1/alerts/1/actions`, { method: "POST", body: "{}" }));
  blocked(() => assertReadOnly(`${REGION}/xdr-query/v1/queries/runs`, { method: "POST", body: "{}" }));
  blocked(() => assertReadOnly(`${REGION}/endpoint/v1/endpoints`, { method: "GET", body: "{}" }));
  blocked(() => assertReadOnly(`https://api.central.sophos.com/partner/v1/tenants`));
});

test("hosts, schemes and URL tricks outside Sophos are refused", () => {
  blocked(() => assertReadOnly("http://api.central.sophos.com/whoami/v1"));
  blocked(() => assertReadOnly("https://api.central.sophos.com.evil.test/whoami/v1"));
  blocked(() => assertReadOnly("https://evil.test/whoami/v1"));
  blocked(() => assertReadOnly("https://user:pw@api.central.sophos.com/whoami/v1"));
  blocked(() => assertReadOnly("https://api.central.sophos.com:8443/whoami/v1"));
  blocked(() => assertReadOnly("not a url"));
});

test("every exporter document passes exactly as written", () => {
  for (const [name, document] of DOCUMENTS) {
    assert.equal(allowedDocument(JSON.stringify({ query: document, variables: {} })), name);
    assertReadOnly(GQL, post({ query: document, variables: {}, operationName: name }));
  }
});

test("a mutation, another query, or an edited document is refused", () => {
  blocked(() => assertReadOnly(GQL, post({ query: "mutation X { updateCase(input: {}) { id } }" })));
  blocked(() => assertReadOnly(GQL, post({ query: "query FusionListCases { cases(arguments: {}) { totalCount } }" })));
  blocked(() => assertReadOnly(GQL, post({ query: `${CASES_PAGE} ` })));
  blocked(() => assertReadOnly(GQL, post({ query: CASES_PAGE.replace("query ExportCasesPage", "mutation ExportCasesPage") })));
  blocked(() => assertReadOnly(GQL, post({ query: CASES_PAGE, extensions: {} })));
  blocked(() => assertReadOnly(GQL, post({ query: CASES_PAGE, operationName: "Other" })));
  blocked(() => assertReadOnly(GQL, post({ query: CASES_PAGE, variables: [] })));
  blocked(() => assertReadOnly(GQL, { method: "GET" }));
  blocked(() => assertReadOnly(`${GQL}?query=x`, post({ query: CASES_PAGE })));
  blocked(() => assertReadOnly("https://api.taegis.sophos.com/other", post({ query: CASES_PAGE })));
  blocked(() => assertReadOnly(GQL, { method: "POST", body: "not json" }));
});

test("the guarded fetch refuses before sending, counts calls, and stops at the call cap", async () => {
  const sent = [];
  const base = async (input, init) => {
    sent.push([input, init.redirect]);
    return new Response("{}", { status: 200 });
  };
  const limiter = new RateLimiter({ perMinute: 100 });
  const records = [];
  const fetch = createGuardedFetch({ limiter, baseFetch: base, maxCalls: 2, onCall: (r) => records.push(r) });
  await assert.rejects(fetch(`${REGION}/endpoint/v1/endpoints`, { method: "DELETE" }), ReadOnlyViolationError);
  assert.equal(sent.length, 0);
  await fetch(`${REGION}/whoami/v1`);
  await fetch(GQL, post({ query: CASES_PAGE, variables: {} }));
  assert.equal(fetch.calls(), 2);
  assert.deepEqual(sent.map((s) => s[1]), ["error", "error"]);
  assert.equal(records[1].operation, "ExportCasesPage");
  await assert.rejects(fetch(`${REGION}/whoami/v1`), CallBudgetError);
  assert.equal(sent.length, 2);
});

test("a redirect is refused, and a 429 backs the whole credential off", async () => {
  const limiter = new RateLimiter({ perMinute: 100 });
  let backoff = null;
  limiter.backoff = (s) => (backoff = s);
  const fetch = createGuardedFetch({
    limiter,
    baseFetch: async (input) =>
      input.endsWith("/whoami/v1") ? new Response(null, { status: 307, headers: { Location: "https://evil.test/" } }) : new Response("{}", { status: 429, headers: { "Retry-After": "7" } }),
  });
  await assert.rejects(fetch(`${REGION}/whoami/v1`), /redirect/);
  await fetch(`${REGION}/common/v1/alerts`);
  assert.equal(backoff, 7);
});

test("a 429 with a Retry-After date backs the credential off until that date", async () => {
  const limiter = new RateLimiter({ perMinute: 100 });
  let backoff = null;
  limiter.backoff = (s) => (backoff = s);
  const at = new Date(Math.ceil(Date.now() / 1000) * 1000 + 90_000).toUTCString();
  const fetch = createGuardedFetch({ limiter, baseFetch: async () => new Response("{}", { status: 429, headers: { "Retry-After": at } }) });
  await fetch(`${REGION}/common/v1/alerts`);
  assert.ok(backoff > 88 && backoff <= 91, `backed off ${backoff} s, not the 30 s default`);
});

test("the vendored clients send nothing through the global fetch", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("global fetch used");
  };
  try {
    const sophos = fakeSophos();
    const session = await SophosSession.open({ clientId: "id", clientSecret: "secret", baseFetch: sophos.fetch, perMinute: 100 });
    await session.rest("/endpoint/v1/endpoints", { pageSize: "1" });
    await session.global("/licenses/v1/licenses");
    await session.graphql(CASES_PAGE, { arguments: { query: "" } });
    assert.deepEqual(
      sophos.requests.map((r) => `${r.method} ${r.host}${r.path}`),
      [
        "POST id.sophos.com/api/v2/oauth2/token",
        "GET api.central.sophos.com/whoami/v1",
        "GET api-eu01.central.sophos.com/endpoint/v1/endpoints",
        "GET api.central.sophos.com/licenses/v1/licenses",
        "POST api.taegis.sophos.com/graphql",
      ]
    );
    // The secret goes only to the token endpoint.
    assert.ok(sophos.requests.slice(1).every((r) => !String(r.body ?? "").includes("secret")));
    const core = createSophosCore({ clientId: "a", clientSecret: "b", fetch: sophos.fetch });
    assert.equal(typeof core.fusion.query, "function");
  } finally {
    globalThis.fetch = original;
  }
});

test("a partner or organization credential is refused with a plain message", async () => {
  for (const idType of ["partner", "organization"]) {
    const sophos = fakeSophos({ overrides: { "/whoami/v1": () => ({ id: "11111111-2222-4333-8444-555555555555", idType, apiHosts: { global: "https://api.central.sophos.com" } }) } });
    await assert.rejects(SophosSession.open({ clientId: "id", clientSecret: "s", baseFetch: sophos.fetch }), new RegExp(`${idType} credential`));
  }
});
