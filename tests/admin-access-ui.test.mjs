import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');

test('Access separates global roles from reveal-only social managers and limits admin choice to super-admin', () => {
  assert.match(html, /id="admin-role-form"[\s\S]*?<option value="organizer">Organizer<\/option>/);
  assert.match(html, /id="social-manager-form"[\s\S]*?Social manager/);
  assert.match(html, /id="social-manager-list"/);
  assert.match(html, /id="social-manager-seats"/);
  assert.match(html, /id="admin-role-form"[\s\S]*?<option value="admin"[^>]*>Admin<\/option>/);
  assert.match(html, /isCurrentSuperAdmin\(\)[\s\S]*?admin-role-form/);
  assert.match(html, /payload\.role === "admin" && !isCurrentSuperAdmin\(\)/);
  assert.match(html, /social manager[\s\S]*?reveal/i);
  assert.match(html, /implicit[\s\S]*?no separate revocation/i);
});

test('Access uses member-only vault grant and listed ID for revoke, never owner or roles for social managers', () => {
  assert.match(html, /api\("\/api\/social-vault",?\)/);
  assert.match(html, /api\("\/api\/social-vault\/members", \{ method: "POST", body: JSON\.stringify\(\{ email, role: "member" \}\) \}\)/);
  assert.match(html, /api\(`\/api\/social-vault\/members\/\$\{encodeURIComponent\(member\.user_id\)\}`/);
  assert.match(html, /member\.role === "member"/);
  assert.match(html, /Vault owner · manage credentials/);
  assert.match(html, /member\.role === "member" \? `<button/);
  assert.match(html, /rotationWarning/);
  assert.match(html, /window\.confirm\([\s\S]*?Rotate every shared password/);
  assert.match(html, /data-social-revoke/);
});
