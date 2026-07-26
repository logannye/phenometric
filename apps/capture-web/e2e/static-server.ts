import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(
  fileURLToPath(new URL("../dist", import.meta.url))
);
const mount = "/phenometrix/";
const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".task": "application/octet-stream",
  ".wasm": "application/wasm"
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? mount, "http://127.0.0.1:4173");
  if (!url.pathname.startsWith(mount)) {
    response.writeHead(404).end("Not found");
    return;
  }
  const relative = normalize(url.pathname.slice(mount.length)).replace(
    /^(\.\.[/\\])+/, ""
  );
  let target = join(dist, relative || "index.html");
  if (!target.startsWith(dist) || !existsSync(target)) {
    target = join(dist, "index.html");
  }
  if (statSync(target).isDirectory()) target = join(target, "index.html");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", contentTypes[extname(target)] ?? "application/octet-stream");
  createReadStream(target).pipe(response);
});

server.listen(4173, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
