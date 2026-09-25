import test from 'node:test';
import assert from 'node:assert/strict';
import { switchAdminAccount } from '../public/admin-session.js';

test('switching accounts revokes the current session before navigating to login', async () => {
  const events = [];
  await switchAdminAccount('/admin-sponsorships?motion=one', {
    fetcher: async (url, options) => {
      events.push(['logout', url, options.method, options.credentials]);
      return new Response(null, { status: 200 });
    },
    navigate: url => events.push(['navigate', url]),
  });
  assert.deepEqual(events, [
    ['logout', '/api/auth/logout', 'POST', 'same-origin'],
    ['navigate', '/login/?next=%2Fadmin-sponsorships%3Fmotion%3Done'],
  ]);
});

test('failed logout stays on the page so a signed-in login redirect cannot loop', async () => {
  let navigated = false;
  await assert.rejects(switchAdminAccount('/admin', {
    fetcher: async () => new Response(null, { status: 503 }),
    navigate: () => { navigated = true; },
  }), /sign out/i);
  assert.equal(navigated, false);
});
