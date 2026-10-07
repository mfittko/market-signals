#!/usr/bin/env node
// Full local verification: packaging check, then the unit tests. Off CI it also
// type-checks the console and runs the Go tests when their toolchains are present;
// CI runs those in their own jobs. Exits non-zero on the first failure.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const testEnv = { ...process.env, MS_NO_NOTIFY: "1" };
delete testEnv.MS_CONTROL_PLANE_URL;
delete testEnv.MS_INGEST_TOKEN;
const testFiles = readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.mjs")).map((f) => join("test", f));

const steps = [
  ["packaging", process.execPath, ["scripts/verify-packaging.mjs"], root, process.env],
  ["unit tests", process.execPath, ["--test", ...testFiles], root, testEnv],
];
const hasCmd = (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
if (!process.env.CI) {
  if (existsSync(join(root, "platform/web/node_modules")) && hasCmd("npx")) steps.push(["console typecheck", "npx", ["tsc", "--noEmit"], join(root, "platform/web"), process.env]);
  else console.log("skip console typecheck: platform/web dependencies not installed");
  // ponytail: DB-backed Go tests skip without MS_TEST_DATABASE_URL; CI runs them against Postgres.
  if (hasCmd("go")) steps.push(["go tests", "go", ["test", "-p", "1", "./..."], join(root, "platform"), process.env]);
  else console.log("skip go tests: go not installed");
}

for (const [name, cmd, args, cwd, env] of steps) {
  console.log(`\n== ${name}`);
  const { status } = spawnSync(cmd, args, { cwd, env, stdio: "inherit" });
  if (status !== 0) {
    console.error(`verify failed: ${name} (exit ${status})`);
    process.exit(status || 1);
  }
}
console.log("\nverify: all checks passed");
