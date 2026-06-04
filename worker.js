import * as media from './functions/api/media.js';
import * as register from './functions/api/register.js';
import * as submissions from './functions/api/submissions.js';
import * as subscribe from './functions/api/subscribe.js';
import * as upload from './functions/api/upload.js';
import { corsHeaders } from './functions/_shared/submissions.js';

const API_ROUTES = {
  '/api/media': media,
  '/api/register': register,
  '/api/submissions': submissions,
  '/api/subscribe': subscribe,
  '/api/upload': upload,
};

function methodHandlerName(method) {
  const normalized = String(method || '').toLowerCase();
  return `onRequest${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function methodNotAllowed(routeModule) {
  const methods = Object.keys(routeModule)
    .filter((key) => key.startsWith('onRequest'))
    .map((key) => key.replace('onRequest', '').toUpperCase())
    .filter((method) => method !== 'OPTIONS')
    .sort();

  const headers = new Headers(corsHeaders());
  headers.set('content-type', 'application/json; charset=utf-8');
  if (methods.length) headers.set('allow', methods.join(', '));
  return new Response(JSON.stringify({ ok: false, error: 'Method not allowed.' }), {
    status: 405,
    headers,
  });
}

async function routeApiRequest(request, env, ctx, routeModule) {
  const handler = routeModule[methodHandlerName(request.method)];
  if (!handler) return methodNotAllowed(routeModule);

  return handler({
    request,
    env,
    params: {},
    waitUntil: ctx?.waitUntil?.bind(ctx),
    passThroughOnException: ctx?.passThroughOnException?.bind(ctx),
    next: () => env?.ASSETS?.fetch(request),
    data: {},
  });
}

export default {
  async fetch(request, env = {}, ctx = {}) {
    const url = new URL(request.url);
    const routeModule = API_ROUTES[url.pathname];

    if (routeModule) {
      return routeApiRequest(request, env, ctx, routeModule);
    }

    if (env.ASSETS?.fetch) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
