import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

// Serve only the client bundle. Never expose tests, source maps, config, or the
// parent repo; URL input is never passed to the filesystem.
const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/app.mjs": ["app.mjs", "text/javascript; charset=utf-8"],
  "/model.mjs": ["model.mjs", "text/javascript; charset=utf-8"],
  "/draft.mjs": ["draft.mjs", "text/javascript; charset=utf-8"],
  "/plain-draft.mjs": ["plain-draft.mjs", "text/javascript; charset=utf-8"],
  "/assets/brand-cat.webp": ["assets/brand-cat.webp", "image/webp"],
};
export async function createPlaygroundServer() {
  const assets = new Map(
    await Promise.all(
      Object.entries(files).map(async ([path, [file, type]]) => {
        const body = await readFile(new URL(file, import.meta.url));
        return [
          path,
          {
            body,
            type,
            etag: `"${createHash("sha256").update(body).digest("hex")}"`,
          },
        ];
      }),
    ),
  );
  return createServer(
    {
      maxHeaderSize: 8192,
      requestTimeout: 10000,
      headersTimeout: 10000,
      keepAliveTimeout: 5000,
    },
    (req, res) => {
      const headers = {
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' https://ampcode.com",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy":
          "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cache-Control": "no-cache",
        // The educational sandbox has no third-party scripts, including review injection.
        "X-Amp-Review-Widget": "off",
      };
      const send = (status, body, extra = {}) => {
        res.writeHead(status, {
          ...headers,
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          ...extra,
        });
        res.end(req.method === "HEAD" ? undefined : body);
      };
      if (!["GET", "HEAD"].includes(req.method))
        return send(405, "Method not allowed\n", { Allow: "GET, HEAD" });
      // Exact route matching also rejects encoded traversal, double slashes and dot paths.
      const path = req.url.split("?", 1)[0];
      if (path === "/healthz")
        return send(200, '{"status":"ok","simulationOnly":true}\n', {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
      const asset = assets.get(path);
      if (!asset)
        return send(404, "Not found. Open / for Hook Playground.\n", {
          "Cache-Control": "no-store",
        });
      if (req.headers["if-none-match"] === asset.etag) {
        res.writeHead(304, { ...headers, ETag: asset.etag });
        return res.end();
      }
      send(200, asset.body, { "Content-Type": asset.type, ETag: asset.etag });
    },
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer from 1 to 65535");
  const server = await createPlaygroundServer();
  server.listen(port, "0.0.0.0", () =>
    console.log(`Hook Playground simulation listening on port ${port}`),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      server.close();
      server.closeIdleConnections();
    });
}
