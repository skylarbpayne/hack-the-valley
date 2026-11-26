// Dedicated Access service principal. This is a named HTV user, not a session.
// All permissions still come from that user's live roles in D1.
const unauthorized = () => Object.assign(new Error('Unauthorized'), { status: 401 });
const clientPattern = /^[a-zA-Z0-9_-]{8,128}\.access$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function getAccessServiceUser(db, request, env = {}, mark = () => {}) {
  const url = new URL(request.url);
  mark('host');
  const host = env.HTV_ACCESS_HOST;
  if (typeof host !== 'string' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) || host !== url.hostname || url.protocol !== 'https:') {
    if (request.headers.has('Cf-Access-Jwt-Assertion')) throw unauthorized();
    return null;
  }
  const issuer = env.HTV_ACCESS_ISSUER;
  const audience = env.HTV_ACCESS_AUDIENCE;
  const clientId = env.HTV_ACCESS_CLIENT_ID;
  const email = env.HTV_ACCESS_PRINCIPAL_EMAIL;
  mark('config');
  if (env.HTV_SERVICE_ENABLED !== '1' || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer || '') ||
      typeof audience !== 'string' || !audience || !clientPattern.test(clientId || '') ||
      typeof email !== 'string' || !emailPattern.test(email) || email !== email.toLowerCase()) throw unauthorized();
  mark('session_header');
  if (request.headers.has('cookie') || request.headers.has('x-htv-session')) throw unauthorized();
  mark('missing_assertion');
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw unauthorized();
  mark('jwt_verification');
  let claims;
  try {
    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    ({ payload: claims } = await jwtVerify(token, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
      { issuer, audience, algorithms: ['RS256'] }));
  } catch { throw unauthorized(); }
  mark('service_claims');
  if (claims.type !== 'app' || claims.sub !== '' || claims.common_name !== clientId || claims.email ||
      !Number.isInteger(claims.iat) || claims.iat > Date.now() / 1000) throw unauthorized();
  mark('user_lookup');
  const user = await db.prepare('SELECT * FROM users WHERE lower(email)=? LIMIT 1').bind(email).first();
  mark('user_match');
  if (!user || user.email.toLowerCase() !== email) throw unauthorized();
  return { ...user, service_identity: clientId };
}
