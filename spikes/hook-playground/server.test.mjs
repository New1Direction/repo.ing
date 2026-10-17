import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { once } from "node:events";
import { createPlaygroundServer } from "./server.mjs";

test("standalone server serves only public assets and refuses chain/API writes", async (t) => {
  const server = await createPlaygroundServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const get = (path, method = "GET", headers = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path,
          method,
          headers,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode, headers: res.headers, body }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  const home = await get("/");
  assert.equal(home.status, 200);
  assert.match(home.body, /Simulation · repo.ing/);
  assert.match(home.headers["content-security-policy"], /connect-src 'none'/);
  assert.match(home.headers["content-security-policy"], /script-src 'self';/);
  assert.equal(home.headers["x-content-type-options"], "nosniff");
  assert.equal((await get("/", "HEAD")).body, "");
  assert.equal(
    (await get("/", "GET", { "If-None-Match": home.headers.etag })).status,
    304,
  );
  for (const path of [
    "/app.mjs",
    "/model.mjs",
    "/draft.mjs",
    "/plain-draft.mjs",
    "/style.css",
    "/assets/brand-cat.webp",
  ])
    assert.equal((await get(path)).status, 200);
  for (const path of [
    "/../package.json",
    "/%2e%2e/.env",
    "/.git/config",
    "/server.mjs",
    "/README.md",
    "/model.test.mjs",
    "/assets/",
    "//app.mjs",
    "/api/hook-lab",
  ])
    assert.equal((await get(path)).status, 404, path);
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"])
    assert.equal((await get("/", method)).status, 405);
  assert.deepEqual(JSON.parse((await get("/healthz")).body), {
    status: "ok",
    simulationOnly: true,
  });
});
