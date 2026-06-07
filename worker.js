import * as eventSignups from './functions/api/events/[slug]/signups/index.js';
import * as eventImage from './functions/api/events/[slug]/image.js';
import * as eventSlug from './functions/api/events/[slug].js';
import * as eventsIndex from './functions/api/events/index.js';
import * as media from './functions/api/media.js';
import * as register from './functions/api/register.js';
import * as submissions from './functions/api/submissions.js';
import * as subscribe from './functions/api/subscribe.js';
import { getDb, getEvent, handleErrors, renderEventPageHtml } from './functions/_lib/event-platform.js';
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

async function routeApiRequest(request, env, ctx, routeModule, params = {}) {
  const handler = routeModule[methodHandlerName(request.method)];
  if (!handler) return methodNotAllowed(routeModule);

  return handler({
    request,
    env,
    params,
    waitUntil: ctx?.waitUntil?.bind(ctx),
    passThroughOnException: ctx?.passThroughOnException?.bind(ctx),
    next: () => env?.ASSETS?.fetch(request),
    data: {},
  });
}

function matchApiRoute(pathname) {
  if (pathname === '/api/events') {
    return { routeModule: eventsIndex, params: {} };
  }

  const signupMatch = pathname.match(/^\/api\/events\/([^/]+)\/signups\/?$/);
  if (signupMatch) {
    return { routeModule: eventSignups, params: { slug: decodeURIComponent(signupMatch[1]) } };
  }

  const imageMatch = pathname.match(/^\/api\/events\/([^/]+)\/image\/?$/);
  if (imageMatch) {
    return { routeModule: eventImage, params: { slug: decodeURIComponent(imageMatch[1]) } };
  }

  const eventMatch = pathname.match(/^\/api\/events\/([^/]+)\/?$/);
  if (eventMatch) {
    return { routeModule: eventSlug, params: { slug: decodeURIComponent(eventMatch[1]) } };
  }

  const routeModule = API_ROUTES[pathname];
  return routeModule ? { routeModule, params: {} } : null;
}

function isEventPagePath(pathname) {
  return /^\/events\/[^/.][^/]*\/?$/.test(pathname);
}

async function renderEventPage(request, env) {
  return handleErrors(async () => {
    const url = new URL(request.url);
    const slug = decodeURIComponent(url.pathname.match(/^\/events\/([^/]+)\/?$/)?.[1] || "");
    const event = await getEvent(getDb(env), slug);
    if (!event || event.status === "archived") {
      return new Response("Event not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return new Response(renderEventPageHtml(event), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
    });
  });
}

export default {
  async fetch(request, env = {}, ctx = {}) {
    const url = new URL(request.url);
    const route = matchApiRoute(url.pathname);

    if (route) {
      return routeApiRequest(request, env, ctx, route.routeModule, route.params);
    }

    if (isEventPagePath(url.pathname)) {
      return renderEventPage(request, env);
    }

    if (env.ASSETS?.fetch) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
