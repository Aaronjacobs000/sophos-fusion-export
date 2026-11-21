// Fixes to the vendored sophos-core, each with the failure it fixes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenManager, TenantResolver, SophosClient, SophosApiRequestError } from "../dist/vendor/sophos-core/index.js";

function client(handler) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    calls.push(String(input));
    if (String(input).includes("oauth2")) return Response.json({ access_token: "t", token_type: "bearer", expires_in: 3600 });
    if (String(input).endsWith("/whoami/v1")) return Response.json({ id: "t1", idType: "tenant", apiHosts: { global: "https://api.central.sophos.com", dataRegion: "https://api-eu01.central.sophos.com" } });
    return handler(String(input), init);
  };
  const tokens = new TokenManager("id", "secret", fetch);
  const tenants = new TenantResolver(tokens, fetch);
  return { rest: new SophosClient(tokens, tenants, { fetch, retries: 2 }), tenants, calls };
}

test("a 4xx whose body is not JSON is not retried", async () => {
  const { rest, tenants, calls } = client(() => new Response("<html>Not Found</html>", { status: 404 }));
  await tenants.init();
  await assert.rejects(rest.tenantRequest("t1", "/endpoint/v1/endpoints"), (error) => error instanceof SophosApiRequestError && error.status === 404);
  assert.equal(calls.filter((c) => c.includes("/endpoint/")).length, 1, "one attempt, not three");
});

test("a 4xx with a JSON body is still not retried, and a 5xx still is", async () => {
  const json = client(() => Response.json({ error: "BadRequest", message: "no" }, { status: 400 }));
  await json.tenants.init();
  await assert.rejects(json.rest.tenantRequest("t1", "/common/v1/alerts"), /Sophos API error 400: BadRequest/);
  assert.equal(json.calls.filter((c) => c.includes("/alerts")).length, 1);

  let n = 0;
  const flaky = client(() => (++n < 2 ? new Response("upstream", { status: 502 }) : Response.json({ items: [] })));
  await flaky.tenants.init();
  assert.deepEqual(await flaky.rest.tenantRequest("t1", "/common/v1/alerts"), { items: [] });
  assert.equal(n, 2);
});
