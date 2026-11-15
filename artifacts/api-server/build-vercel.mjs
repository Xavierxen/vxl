// Builds the whole site into Vercel's Build Output API layout (.vercel/output):
//   static/                    -> the Vite frontend
//   functions/api.func/        -> the Elysia API, bundled into one file
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const apiDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(apiDir, "../..");
const out = path.join(root, ".vercel", "output");
const fn = path.join(out, "functions", "api.func");
// Optional: keep the API on another host (e.g. your Replit deployment, where the anime sources work)
// and let Vercel serve only the website. Requests to /api/* are proxied there.
const API_ORIGIN = (process.env.API_ORIGIN || "").trim().replace(/\/+$/, "");

await rm(out, { recursive: true, force: true });

console.log("▸ Building frontend");
execSync("pnpm --filter @workspace/cooren-watch run build", {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PORT: "3000", BASE_PATH: "/", NODE_ENV: "production" },
});
await cp(path.join(root, "artifacts/cooren-watch/dist/public"), path.join(out, "static"), { recursive: true });

async function bundleApi() {
console.log("▸ Bundling API");
globalThis.require = createRequire(import.meta.url);
await build({
  entryPoints: [path.join(apiDir, "src/vercel.ts")],
  outfile: path.join(fn, "index.mjs"),
  platform: "node",
  target: "node22",
  format: "esm",
  bundle: true,
  sourcemap: false,
  logLevel: "info",
  // Never bundled: native code / headless browsers (loaded lazily, only by a few providers).
  external: ["*.node", "wreq-js", "puppeteer-real-browser", "puppeteer", "puppeteer-core", "pg-native", "bun"],
  banner: {
    js: `import { createRequire as __cr } from 'node:module';
import __p from 'node:path';
import __u from 'node:url';
globalThis.require = __cr(import.meta.url);
globalThis.__filename = __u.fileURLToPath(import.meta.url);
globalThis.__dirname = __p.dirname(globalThis.__filename);`,
  },
});

// wreq-js (browser-like TLS fingerprinting) ships a native binding: copy it next to the bundle.
// Best effort: if it is missing, the code that uses it falls back to plain fetch.
try {
  const real = await realpath(path.join(apiDir, "node_modules", "wreq-js"));
  await cp(real, path.join(fn, "node_modules", "wreq-js"), { recursive: true, dereference: true });
  const pkg = JSON.parse(await readFile(path.join(real, "package.json"), "utf8"));
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    try {
      const depReal = await realpath(path.join(path.dirname(real), dep));
      await cp(depReal, path.join(fn, "node_modules", dep), { recursive: true, dereference: true });
    } catch {} // bindings for other platforms are not installed
  }
  console.log("▸ Included wreq-js native binding");
} catch (err) {
  console.warn("▸ wreq-js not bundled (falling back to plain fetch):", err.message);
}

await writeFile(
  path.join(fn, ".vc-config.json"),
  JSON.stringify({
    runtime: "nodejs22.x",
    handler: "index.mjs",
    launcherType: "Nodejs",
    maxDuration: 60,
    supportsResponseStreaming: true,
  }),
);
}
if (API_ORIGIN) console.log(`▸ API_ORIGIN set: /api/* will be proxied to ${API_ORIGIN}`);
else await bundleApi();

await mkdir(out, { recursive: true });
await writeFile(
  path.join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        {
          src: "/(.*)",
          headers: {
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
            "referrer-policy": "strict-origin-when-cross-origin",
            "permissions-policy": "camera=(), microphone=(), geolocation=()",
            "strict-transport-security": "max-age=63072000; includeSubDomains",
          },
          continue: true,
        },
        API_ORIGIN
          ? { src: "/api/(.*)", dest: `${API_ORIGIN}/api/$1` }
          : { src: "/api(?:/(.*))?", dest: "/api" },
        { src: "/assets/(.*)", headers: { "cache-control": "public, max-age=31536000, immutable" }, continue: true },
        { handle: "filesystem" },
        { src: "/(.*)", dest: "/index.html" },
      ],
    },
    null,
    2,
  ),
);
console.log("✔ Vercel output ready in .vercel/output");
