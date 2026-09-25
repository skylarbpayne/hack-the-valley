export async function switchAdminAccount(returnTo = '/admin', {
  fetcher = (...args) => fetch(...args),
  navigate = url => window.location.assign(url),
} = {}) {
  const response = await fetcher('/api/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error('Could not sign out. Please try switching accounts again.');
  navigate(`/login/?next=${encodeURIComponent(returnTo)}`);
}
