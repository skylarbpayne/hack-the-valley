import * as eventSignups from './functions/api/events/[slug]/signups/index.js';
import * as adminMe from './functions/api/admin/me.js';
import * as adminRoles from './functions/api/admin/roles.js';
import * as authRequestCode from './functions/api/auth/request-code.js';
import * as authVerifyCode from './functions/api/auth/verify-code.js';
import * as authMagicLogin from './functions/api/auth/magic-login.js';
import * as me from './functions/api/me.js';
import * as meProjects from './functions/api/me/projects.js';
import * as eventCheckins from './functions/api/events/[slug]/checkins/index.js';
import * as eventCockpit from './functions/api/events/[slug]/instances/[instanceId]/cockpit/index.js';
import * as eventFollowup from './functions/api/events/[slug]/instances/[instanceId]/followup/index.js';
import * as eventProjects from './functions/api/events/[slug]/instances/[instanceId]/projects/index.js';
import * as eventProjectsIndex from './functions/api/events/[slug]/projects/index.js';
import * as eventProjectStatus from './functions/api/events/[slug]/projects/[projectId].js';
import * as eventPhotos from './functions/api/events/[slug]/instances/[instanceId]/photos/index.js';
import * as eventImage from './functions/api/events/[slug]/image.js';
import * as eventSlug from './functions/api/events/[slug].js';
import * as eventsIndex from './functions/api/events/index.js';
import * as media from './functions/api/media.js';
import * as register from './functions/api/register.js';
import * as submissions from './functions/api/submissions.js';
import * as subscribe from './functions/api/subscribe.js';
import { getDb, getEvent, handleErrors, renderEventPageHtml } from './functions/_lib/event-platform.js';
import * as upload from './functions/api/upload.js';
import * as users from './functions/api/users/index.js';
import * as userBadges from './functions/api/users/[id]/badges.js';
import * as userState from './functions/api/users/[id]/state.js';
import { corsHeaders } from './functions/_shared/submissions.js';

const API_ROUTES = {
  '/api/media': media,
  '/api/me': me,
  '/api/me/projects': meProjects,
  '/api/register': register,
  '/api/submissions': submissions,
  '/api/subscribe': subscribe,
  '/api/upload': upload,
  '/api/users': users,
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

  if (pathname === '/api/admin/me') {
    return { routeModule: adminMe, params: {} };
  }

  if (pathname === '/api/admin/roles') {
    return { routeModule: adminRoles, params: {} };
  }

  if (pathname === '/api/auth/request-code') {
    return { routeModule: authRequestCode, params: {} };
  }

  if (pathname === '/api/auth/verify-code') {
    return { routeModule: authVerifyCode, params: {} };
  }

  if (pathname === '/api/auth/magic-login') {
    return { routeModule: authMagicLogin, params: {} };
  }

  const meProjectMaterialsMatch = pathname.match(/^\/api\/me\/projects\/([^/]+)\/materials\/?$/);
  if (meProjectMaterialsMatch) {
    return { routeModule: meProjects, params: { projectId: decodeURIComponent(meProjectMaterialsMatch[1]), action: 'materials' } };
  }

  const meProjectSubmissionMatch = pathname.match(/^\/api\/me\/projects\/([^/]+)\/submissions\/?$/);
  if (meProjectSubmissionMatch) {
    return { routeModule: meProjects, params: { projectId: decodeURIComponent(meProjectSubmissionMatch[1]), action: 'submissions' } };
  }

  const meProjectMatch = pathname.match(/^\/api\/me\/projects\/([^/]+)\/?$/);
  if (meProjectMatch) {
    return { routeModule: meProjects, params: { projectId: decodeURIComponent(meProjectMatch[1]) } };
  }

  const signupMatch = pathname.match(/^\/api\/events\/([^/]+)\/signups\/?$/);
  if (signupMatch) {
    return { routeModule: eventSignups, params: { slug: decodeURIComponent(signupMatch[1]) } };
  }

  const checkinMatch = pathname.match(/^\/api\/events\/([^/]+)\/checkins\/?$/);
  if (checkinMatch) {
    return { routeModule: eventCheckins, params: { slug: decodeURIComponent(checkinMatch[1]) } };
  }

  const cockpitMatch = pathname.match(/^\/api\/events\/([^/]+)\/instances\/([^/]+)\/cockpit\/?$/);
  if (cockpitMatch) {
    return { routeModule: eventCockpit, params: { slug: decodeURIComponent(cockpitMatch[1]), instanceId: decodeURIComponent(cockpitMatch[2]) } };
  }

  const followupMatch = pathname.match(/^\/api\/events\/([^/]+)\/instances\/([^/]+)\/followup\/?$/);
  if (followupMatch) {
    return { routeModule: eventFollowup, params: { slug: decodeURIComponent(followupMatch[1]), instanceId: decodeURIComponent(followupMatch[2]) } };
  }

  const projectsMatch = pathname.match(/^\/api\/events\/([^/]+)\/instances\/([^/]+)\/projects\/?$/);
  if (projectsMatch) {
    return { routeModule: eventProjects, params: { slug: decodeURIComponent(projectsMatch[1]), instanceId: decodeURIComponent(projectsMatch[2]) } };
  }

  const eventProjectsIndexMatch = pathname.match(/^\/api\/events\/([^/]+)\/projects\/?$/);
  if (eventProjectsIndexMatch) {
    return { routeModule: eventProjectsIndex, params: { slug: decodeURIComponent(eventProjectsIndexMatch[1]) } };
  }

  const eventProjectStatusMatch = pathname.match(/^\/api\/events\/([^/]+)\/projects\/([^/]+)\/?$/);
  if (eventProjectStatusMatch) {
    return { routeModule: eventProjectStatus, params: { slug: decodeURIComponent(eventProjectStatusMatch[1]), projectId: decodeURIComponent(eventProjectStatusMatch[2]) } };
  }

  const photosMatch = pathname.match(/^\/api\/events\/([^/]+)\/instances\/([^/]+)\/photos\/?$/);
  if (photosMatch) {
    return { routeModule: eventPhotos, params: { slug: decodeURIComponent(photosMatch[1]), instanceId: decodeURIComponent(photosMatch[2]) } };
  }

  const imageMatch = pathname.match(/^\/api\/events\/([^/]+)\/image\/?$/);
  if (imageMatch) {
    return { routeModule: eventImage, params: { slug: decodeURIComponent(imageMatch[1]) } };
  }

  const userStateMatch = pathname.match(/^\/api\/users\/([^/]+)\/state\/?$/);
  if (userStateMatch) {
    return { routeModule: userState, params: { id: decodeURIComponent(userStateMatch[1]) } };
  }

  const userBadgesMatch = pathname.match(/^\/api\/users\/([^/]+)\/badges\/?$/);
  if (userBadgesMatch) {
    return { routeModule: userBadges, params: { id: decodeURIComponent(userBadgesMatch[1]) } };
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

    if (url.pathname === '/submit' || url.pathname === '/submit/') {
      return Response.redirect(new URL('/projects/', url), 302);
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
