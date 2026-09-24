import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RAILWAY_IAC_SDK_VERSION = "3.11.0";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = resolve(repositoryRoot, ".cache", "railway-iac-sdk", RAILWAY_IAC_SDK_VERSION);
const cachedPackage = resolve(cacheRoot, "node_modules", "railway");
const packageLink = resolve(repositoryRoot, ".railway", "node_modules", "railway");

const [command, ...rawCommandArguments] = process.argv.slice(2);
const commandArguments = rawCommandArguments[0] === "--" ? rawCommandArguments.slice(1) : rawCommandArguments;
if (command !== "plan" && command !== "apply") {
  console.error("Usage: node scripts/railway-config.mjs <plan|apply> [...arguments]");
  process.exit(2);
}

function installedVersion(packageDirectory) {
  try {
    return JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function installSdk() {
  if (installedVersion(cachedPackage) === RAILWAY_IAC_SDK_VERSION) return;

  mkdirSync(cacheRoot, { recursive: true });
  console.error(`Installing Railway IaC SDK ${RAILWAY_IAC_SDK_VERSION} in the local tool cache...`);
  const installation = spawnSync(
    "pnpm",
    [
      "--dir",
      cacheRoot,
      "add",
      "--ignore-workspace",
      "--save-exact",
      "--ignore-scripts",
      `railway@${RAILWAY_IAC_SDK_VERSION}`,
    ],
    { cwd: repositoryRoot, stdio: "inherit" },
  );

  if (installation.error) throw installation.error;
  if (installation.status !== 0 || installedVersion(cachedPackage) !== RAILWAY_IAC_SDK_VERSION) {
    process.exit(installation.status ?? 1);
  }
}

function linkSdk() {
  if (installedVersion(packageLink) === RAILWAY_IAC_SDK_VERSION) return;

  mkdirSync(dirname(packageLink), { recursive: true });
  if (pathExists(packageLink)) rmSync(packageLink, { force: true, recursive: true });
  symlinkSync(relative(dirname(packageLink), cachedPackage), packageLink, "junction");
}

installSdk();
linkSdk();

const railway = spawnSync("railway", ["config", command, ...commandArguments], {
  cwd: repositoryRoot,
  // The SDK verifies the native evaluator through this shell convention.
  env: { ...process.env, _: "railway" },
  stdio: "inherit",
});

if (railway.error) throw railway.error;
process.exit(railway.status ?? 1);
