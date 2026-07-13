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

function spawnWrangler(wranglerBin, args, options) {
  if (process.platform === "win32" && /\.cmd$/i.test(wranglerBin)) {
    // npm's Windows shim is not directly spawnable, and `shell: true` corrupts
    // multiline SQL passed through --command. Invoke Wrangler's JS entrypoint.
    return spawnSync(process.execPath, [join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js"), ...args], options);
  }
  return spawnSync(wranglerBin, args, options);
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

    verifyDataIntegrityFixtures(wranglerBin, options, persistTo);

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
    ["prj_continuum", "continuum", "Continuum"],
    ["prj_fixture_uncanonical", "fixture-uncanonical", "Fixture Uncanonical Project"]
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

    INSERT OR IGNORE INTO submissions (id, created_at, team_name, project_title, contact_email, track, payload_json, uploads_json, status)
    VALUES
      ('htv_fixture_decode_it', CURRENT_TIMESTAMP, 'Decode It', 'Decode It', 'decode-it@example.com', 'education', '{}', '[]', 'submitted'),
      ('htv_fixture_uncanonical', CURRENT_TIMESTAMP, 'Fixture Team', 'Fixture Uncanonical Project', 'fixture@example.com', 'community', '{}', '[]', 'submitted');

    INSERT OR IGNORE INTO event_project_submissions (
      id, event_slug, event_instance_id, project_id, submission_id, status, source, created_at, updated_at
    ) VALUES
      ('eps_fixture_decode_it', 'hack-the-valley-2026', NULL, 'prj_decode_it', 'htv_fixture_decode_it', 'submitted', 'compatibility_fixture', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('eps_fixture_uncanonical', 'hack-the-valley-2026', NULL, 'prj_fixture_uncanonical', 'htv_fixture_uncanonical', 'submitted', 'compatibility_fixture', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  `;
}

function verifyDataIntegrityFixtures(wranglerBin, options, persistTo) {
  const checks = [
    [
      "archived HTV 2026 instance backfilled",
      "SELECT COUNT(*) AS count FROM event_instances WHERE id = 'inst_hack_the_valley_2026' AND event_slug = 'hack-the-valley-2026' AND status = 'archived'"
    ],
    [
      "HTV 2026 project links point at the archived instance",
      "SELECT COUNT(*) AS count FROM event_project_submissions WHERE event_slug = 'hack-the-valley-2026' AND event_instance_id IS NULL"
    ],
    [
      "linked legacy submissions have canonical projects when possible",
      `SELECT COUNT(*) AS count
       FROM projects p
       WHERE p.canonical_submission_id IS NULL
         AND EXISTS (
           SELECT 1 FROM event_project_submissions eps
           WHERE eps.project_id = p.id AND eps.submission_id IS NOT NULL
         )`
    ]
  ];

  for (const [label, sql] of checks) {
    const [{ results }] = runWranglerJson(wranglerBin, options, persistTo, ["--command", sql], label);
    const count = Number(results?.[0]?.count ?? 0);
    if (label === "archived HTV 2026 instance backfilled") {
      if (count !== 1) throw new Error(`${label}: expected 1, got ${count}`);
    } else if (count !== 0) {
      throw new Error(`${label}: expected 0, got ${count}`);
    }
  }
  console.log("✓ data integrity backfill fixtures");
}

function runWranglerJson(wranglerBin, options, persistTo, executionArgs, label) {
  const result = spawnWrangler(wranglerBin, [
    "d1",
    "execute",
    options.database,
    "--local",
    "--persist-to",
    persistTo,
    "--json",
    ...executionArgs
  ], {
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
    throw new Error(`wrangler failed while checking ${label}`);
  }
  return JSON.parse(result.stdout);
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
  const result = spawnWrangler(wranglerBin, args, {
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
