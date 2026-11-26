# Admin > Access: named global super-admin provisioning

This PR adds a separate, human-session-only flow. It does not grant any production account or deploy the feature.

## Phone path after approved release

1. Sign in as an existing human **global super-admin**; open `/admin#access` (on a phone: **Admin → ☰ → Access**).
2. Under **Provision a named super-admin**, enter the **exact HTV account email** and a name if it is a new account. Tap **Review account & privilege**.
3. Check whether the preview says **New account** or **Existing account**, check the exact email/identity, and read the global `super_admin` / shared social-login vault credential-access warning. Type the exact displayed email; tap **Confirm & grant global super_admin**.
4. Read the green **Verified active grant** readback (email, user ID, global role, actor, timestamp). Refresh Access or reload; the role table should still show the target and the original owner. A newly created account has not verified its inbox or signed in. The named person must use normal sign-in independently; this flow sends no email.

## Local proof (synthetic fixture, not production)

At a **390×844** browser viewport, `node tests/helpers/admin-provision-browser.mjs` served the actual `public/admin.html`, Worker API, and migrated in-memory SQLite fixture on `127.0.0.1:8799`. The visible phone form was used to review and confirm a new fixture account and an existing fixture account; both returned active global `super_admin` readback. After a full `location.reload()`, the role table contained both targets and the fixture original owner. `document.documentElement.scrollWidth === innerWidth === 390`.

- [Existing-account exact-email confirmation](admin-access-existing-confirm-mobile.png)
- [Authoritative role readback after confirmation](admin-access-readback-mobile.png)
- [Reloaded roles, original owner retained](admin-access-reload-mobile.png)

The endpoint requires a live human global super-admin session, same-origin POST, exact-email confirmation, and a matching previewed user ID; service assertions and bootstrap access cannot use it. One D1 batch commits the optional user insert, role grant, and audit event. The existing 15-effective-person social vault trigger remains authoritative. No inbox verification, login code/session, impersonation, vault-owner grant, notification, or service self-grant occurs.
