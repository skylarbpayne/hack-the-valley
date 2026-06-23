#!/usr/bin/env node
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseWithSchema, schema } from "../functions/_lib/domain/shared.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const OptionsSchema = schema.object({
  database: schema.pipe(schema.string(), schema.minLength(1)),
  persistTo: schema.optional(schema.nullish(schema.string()), null),
  keepPersist: schema.optional(schema.boolean(), false),
  wranglerBin: schema.optional(schema.nullish(schema.string()), null),
  help: schema.optional(schema.boolean(), false)
});

function parseArgs(argv) {
  const options = {
    database: "HTV_DB",
    persistTo: null,
    keepPersist: false,
    wranglerBin: null,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--database") {
      options.database = requireValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--database=")) {
      options.database = arg.slice("--database=".length);
    } else if (arg === "--persist-to") {
      options.persistTo = requireValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--persist-to=")) {
      options.persistTo = arg.slice("--persist-to=".length);
    } else if (arg === "--wrangler-bin") {
      options.wranglerBin = requireValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--wrangler-bin=")) {
      options.wranglerBin = arg.slice("--wrangler-bin=".length);
    } else if (arg === "--keep-persist") {
      options.keepPersist = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return parseWithSchema(OptionsSchema, options);
}

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/check-migrations.mjs [options]\n\nSmoke-check D1 migrations against a throwaway local Wrangler D1 store.\n\nOptions:\n  --database <binding>     D1 binding/database name to migrate (default: HTV_DB)\n  --persist-to <dir>       Use a specific local persistence directory\n  --wrangler-bin <path>    Wrangler executable to run (default: local node_modules/.bin/wrangler)\n  --keep-persist           Keep the generated temporary persistence directory\n  -h, --help               Show this help text`);
}

function defaultWranglerBin() {
  const executable = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
  const localWrangler = join(repoRoot, "node_modules", ".bin", executable);
  return existsSync(localWrangler) ? localWrangler : executable;
}

function runMigrations(options) {
  const createdTempDir = !options.persistTo;
  const persistTo = options.persistTo
    ? resolve(process.cwd(), options.persistTo)
    : mkdtempSync(join(tmpdir(), "htv-d1-migrations-"));
  const wranglerBin = options.wranglerBin || defaultWranglerBin();
  const migrations = migrationFiles();

  try {
    console.log(`Checking D1 migrations locally for ${options.database}...`);
    console.log(`Local D1 persistence: ${persistTo}`);

    for (const migration of migrations) {
      runWrangler(wranglerBin, options, persistTo, ["--file", migration.path], migration.name);
      console.log(`✓ ${migration.name}`);

      if (migration.name === "0013_event_project_awards.sql") {
        seedCompatibilityFixtures(wranglerBin, options, persistTo);
      }
    }

    console.log(`D1 migration smoke check applied ${migrations.length} migrations successfully.`);
  } finally {
    if (createdTempDir && !options.keepPersist) {
      rmSync(persistTo, { recursive: true, force: true });
    }
  }
}

function migrationFiles() {
  const migrationsDir = join(repoRoot, "migrations");
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, path: join(migrationsDir, name) }));
}

function seedCompatibilityFixtures(wranglerBin, options, persistTo) {
  runWrangler(wranglerBin, options, persistTo, ["--command", compatibilityFixtureSql()], "compatibility fixtures");
  console.log("✓ compatibility fixtures for data migrations");
}

function compatibilityFixtureSql() {
  const awardedProjects = [
    ["prj_decode_it", "decode-it", "Decode It"],
    ["prj_valley_sat_prep", "valley-sat-prep", "Valley SAT Prep"],
    ["prj_techpath_kern", "techpath-kern", "TechPath Kern"],
    ["prj_continuum", "continuum", "Continuum"]
  ];
  const projectValues = awardedProjects
    .map(([id, slug, title]) => `('${id}', '${slug}', '${title}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
    .join(",\n      ");

  return `
    INSERT OR IGNORE INTO events (slug, title, status, created_at, updated_at)
    VALUES ('hack-the-valley-2026', 'Hack the Valley 2026', 'archived', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

    INSERT OR IGNORE INTO projects (id, slug, title, created_at, updated_at)
    VALUES
      ${projectValues};
  `;
}

function runWrangler(wranglerBin, options, persistTo, executionArgs, label) {
  const args = [
    "d1",
    "execute",
    options.database,
    "--local",
    "--persist-to",
    persistTo,
    "--json",
    ...executionArgs
  ];
  const result = spawnSync(wranglerBin, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      CI: process.env.CI || "1",
      NO_COLOR: process.env.NO_COLOR || "1",
      HTV_D1_DATABASE_ID: process.env.HTV_D1_DATABASE_ID || "00000000-0000-0000-0000-000000000000"
    },
    encoding: "utf8"
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`wrangler failed while applying ${label}`);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
  } else {
    runMigrations(options);
  }
} catch (error) {
  console.error(error?.message || error);
  process.exitCode = 1;
}
