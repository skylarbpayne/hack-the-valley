#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { compatibilityFixtureSql, sponsorshipFixtureSql, demoLogoPng, DEMO_LOGO_KEY } from './sponsorship-fixtures.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prototypeRoot = join(repoRoot, '.wrangler', 'sponsorship-prototype');
const configPath = join(prototypeRoot, 'wrangler.json');
const persistPath = join(prototypeRoot, 'state');
const migrationsPath = join(prototypeRoot, 'migrations');
const wrangler = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');

export function parseCommand(args) {
  if (args.length !== 1 || !['setup','dev','reset'].includes(args[0])) {
    throw new Error('Local-only usage: node scripts/sponsorships-local.mjs setup|dev|reset. Remote targets and extra arguments are not accepted.');
  }
  return args[0];
}

export function localEnvironment(source = process.env) {
  // Deliberate allowlist: never forward Cloudflare, Resend, bootstrap tokens,
  // production bindings, dotenv overrides, proxy credentials, or NODE_OPTIONS.
  const result = {};
  for (const key of ['PATH','HOME','USER','TMPDIR','TMP','TEMP','LANG','LC_ALL','SHELL','SystemRoot']) {
    if (source[key]) result[key] = source[key];
  }
  return { ...result, CI:'1', NO_COLOR:'1', WRANGLER_SEND_METRICS:'false', WRANGLER_LOG_PATH:join(prototypeRoot,'logs') };
}

export function localConfig(root = repoRoot) {
  return {
    name: 'htv-sponsorship-prototype-local',
    main: join(root,'worker.js'),
    compatibility_date: '2026-02-17',
    assets: { directory:join(root,'public'),binding:'ASSETS',run_worker_first:['/api/*','/events/*'] },
    vars: { MAX_UPLOAD_MB:'5',HTV_AUTH_DEV_MODE:'local',HTV_AUTH_DEV_CODES:'1',HTV_PUBLIC_BASE_URL:'http://localhost:8788',SPONSORSHIP_REMINDERS_MODE:'preview' },
    d1_databases: [{ binding:'HTV_DB',database_name:'htv-sponsorship-prototype-local',database_id:'11111111-1111-4111-8111-111111111111',migrations_dir:join(root,'.wrangler','sponsorship-prototype','migrations'),remote:false }],
    r2_buckets: [{ binding:'SUBMISSIONS_MEDIA',bucket_name:'htv-sponsorship-prototype-media',remote:false }],
    triggers: { crons:['*/15 * * * *'] },
  };
}

function configure() {
  mkdirSync(migrationsPath,{recursive:true});
  writeFileSync(configPath,JSON.stringify(localConfig(),null,2)+'\n');
  // Config-local empty dotenv files keep a production root .dev.vars/.env out.
  writeFileSync(join(prototypeRoot,'.dev.vars'),'# Local settings are in wrangler.json; no secrets.\n');
  writeFileSync(join(prototypeRoot,'.env'),'# No external integrations in this prototype.\n');
}

function run(args, json = false) {
  const result = spawnSync(wrangler,[...args,'--config',configPath],{
    cwd:prototypeRoot,env:localEnvironment(),encoding:'utf8',maxBuffer:8*1024*1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Local Wrangler exited ${result.status}`);
  return json ? JSON.parse(result.stdout) : result.stdout;
}

const executeSql = (sql, filename = 'setup.sql') => {
  const path = join(prototypeRoot,filename);
  writeFileSync(path,sql);
  return run(['d1','execute','HTV_DB','--local','--persist-to',persistPath,'--file',path,'--json'],true);
};

function stageMigrations(through = null) {
  const source = join(repoRoot,'migrations');
  const names = readdirSync(source).filter(name => name.endsWith('.sql')).sort();
  for (const file of readdirSync(migrationsPath)) if (file.endsWith('.sql')) rmSync(join(migrationsPath,file));
  for (const name of names.filter(name => !through || name <= through)) {
    writeFileSync(join(migrationsPath,name),readFileSync(join(source,name)));
  }
}

function setup() {
  if (!existsSync(wrangler)) throw new Error('Install dependencies with npm ci before running local setup.');
  configure();
  executeSql('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);');
  const applied = run(['d1','execute','HTV_DB','--local','--persist-to',persistPath,'--command','SELECT name FROM d1_migrations','--json'],true).flatMap(result => result.results || []).map(row => row.name);
  // Historical data migration 0014 requires existing showcase rows. Wrangler
  // owns migration tracking/transactions; only un-applied source files run.
  if (!applied.includes('0014_htv_2026_showcase.sql') && !applied.some(name => name.startsWith('0014_'))) {
    stageMigrations('0013_event_project_awards.sql');
    run(['d1','migrations','apply','HTV_DB','--local','--persist-to',persistPath]);
    executeSql(compatibilityFixtureSql(),'compatibility.sql');
  }
  stageMigrations();
  run(['d1','migrations','apply','HTV_DB','--local','--persist-to',persistPath]);
  const logo = demoLogoPng();
  const logoPath = join(prototypeRoot,'demo-logo.png');
  writeFileSync(logoPath,logo);
  const logoMarker = join(prototypeRoot,'logo-seeded-v1');
  if (!existsSync(logoMarker)) {
    run(['r2','object','put',`htv-sponsorship-prototype-media/${DEMO_LOGO_KEY}`,'--local','--persist-to',persistPath,'--file',logoPath,'--content-type','image/png']);
    writeFileSync(logoMarker,'local demo logo seeded\n');
  }
  executeSql(sponsorshipFixtureSql(new Date(),logo.length),'fixtures.sql');
  console.log('Local sponsorship database ready. Existing edits and follow-up dates preserved.');
  console.log('Demo admins: danny@example.com and alex@example.com. Ordinary member: member@example.com.');
  console.log('Run npm run sponsorships:dev, then open http://localhost:8788/login/?next=/admin-sponsorships');
}

function dev() {
  if (!existsSync(configPath) || !existsSync(persistPath)) throw new Error('Run npm run sponsorships:setup:local first.');
  configure();
  const server = spawn(wrangler,['dev','--config',configPath,'--local','--ip','127.0.0.1','--port','8788','--persist-to',persistPath,'--test-scheduled'],{
    cwd:prototypeRoot,env:localEnvironment(),stdio:'inherit',
  });
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => server.kill(signal));
  server.on('error',error => { console.error(error.message); process.exitCode=1; });
  server.on('exit',code => { process.exitCode=code || 0; });
}

export function main(args = process.argv.slice(2)) {
  const command = parseCommand(args);
  if (command === 'reset') {
    // This path is fixed; neither user arguments nor environment can redirect it.
    rmSync(prototypeRoot,{recursive:true,force:true});
    console.log('Removed only .wrangler/sponsorship-prototype. Run setup for fresh fixtures.');
  } else if (command === 'setup') setup();
  else dev();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode=1; }
}
