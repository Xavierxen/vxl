// Vercel build entry. Checks the repo is complete before building, because pnpm
// silently builds nothing ("No projects matched the filters") when workspace files are missing.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const required = [
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "artifacts/api-server/package.json",
  "artifacts/api-server/build-vercel.mjs",
  "artifacts/api-server/src/vercel.ts",
  "artifacts/cooren-watch/package.json",
  "artifacts/cooren-watch/vite.config.ts",
  "lib/db/package.json",
  "lib/api-client-react/package.json",
  "lib/api-zod/package.json",
  "lib/api-spec/package.json",
];
const missing = required.filter((p) => !existsSync(p));
if (missing.length) {
  console.error("\n✖ These files are missing from the deployed repository:\n  - " + missing.join("\n  - "));
  console.error(
    "\nThe GitHub repo is incomplete. Upload the project with git (git add -A && git commit && git push) instead of\n" +
      "the web uploader (it silently drops files past 100 per upload), and make sure every folder is committed.\n",
  );
  process.exit(1);
}
execSync("pnpm --filter @workspace/api-server run build:vercel", { stdio: "inherit" });
