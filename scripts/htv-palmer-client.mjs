import { pathToFileURL } from 'node:url';

const origin = 'https://palmer.hackthevalley.org';
export function parseArgs(args) {
  const [method, path, ...extra] = args;
  if (extra.length || !['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ||
      typeof path !== 'string' || !/^\/api\/(?!\/)[a-zA-Z0-9_/?=&.%-]+$/.test(path) ||
      path.includes('..') || path.includes('%2f') || path.includes('%2F') ||
      /^\/api\/(?:social-vault|auth)(?:\/|\?|$)/.test(path))
    throw new Error('Usage: METHOD /api/path (writes: JSON body on stdin).');
  return { method, path };
}
export async function runClient({ method, path }, body, env = process.env, fetcher = fetch) {
  parseArgs([method, path]);
  const id = env.CF_ACCESS_CLIENT_ID, secret = env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Inject the named Palmer Access credentials through an approved secret manager.');
  if (method !== 'GET' && (body === null || typeof body !== 'object' || Array.isArray(body))) throw new Error('JSON object required for writes.');
  const response = await fetcher(`${origin}${path}`, {
    method, redirect: 'error',
    headers: { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret,
      ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`HTV API HTTP ${response.status}; no success claimed.`);
  return response.json();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    let body;
    if (parsed.method !== 'GET') {
      let text = '';
      for await (const part of process.stdin) text += part;
      body = JSON.parse(text);
    }
    const result = await runClient(parsed, body);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
