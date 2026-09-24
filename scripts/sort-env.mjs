import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sortEnvFilesFromConfig } from "env-lane";

const SORT_TARGETS = [
  "server",
  "server-local",
  "railway-production",
  "railway-cron-production",
  "cloudrun-production",
];

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2);
const check = arguments_.includes("--check");
const requestedTargets = arguments_.filter((argument) => argument !== "--check");
const unknownTargets = requestedTargets.filter((target) => !SORT_TARGETS.includes(target));

if (unknownTargets.length > 0) {
  console.error(`Unknown env sort target(s): ${unknownTargets.join(", ")}`);
  console.error(`Available targets: ${SORT_TARGETS.join(", ")}`);
  process.exit(2);
}

const targets = requestedTargets.length > 0 ? [...new Set(requestedTargets)] : SORT_TARGETS;
let changed = false;

for (const target of targets) {
  // "configured" maps back to each target's explicit file. Using "all" would also infer every
  // selector build with the same template, which is incorrect for provider files.
  const result = await sortEnvFilesFromConfig(undefined, target, "configured", {
    cwd: repositoryRoot,
    check,
  });
  for (const file of result.results) {
    changed ||= file.changed;
    let status;
    if (!existsSync(file.filePath)) status = "ABSENT";
    else if (check) status = file.changed ? "DRIFT" : "OK";
    else status = file.applied ? "SORTED" : "SKIPPED";
    console.log(`${status.padEnd(7)} ${relative(repositoryRoot, file.filePath)}`);
  }
}

if (check && changed) process.exitCode = 1;
