# Issue #32 Discovery: Scholarship Recipient Opportunities

Status: discovery draft; no recipient answers have been collected in this file.
Scope: explore whether HTV should help scholarship / credit recipients share apps, projects, links, hiring needs, collaboration asks, or other opportunities through the HTV website.
Non-goal: this is not an implementation spec and does not authorize publishing recipient information without consent.

## Goals

- Give organizers a repeatable outreach plan before building anything public.
- Identify what recipients actually want to promote: hosted project pages, external app links, hiring/internship asks, demos, socials, or no public listing.
- Choose a low-risk product direction that matches recipient consent, moderation capacity, and HTV brand standards.
- Turn the discovery into small implementation issues once the desired direction is confirmed.

## Outreach list draft

Use this as a working queue. Fill in real contacts from approved internal records only; do not infer or scrape personal contact details.

| Group | Source to verify | Why include | Suggested owner | Status |
| --- | --- | --- | --- | --- |
| Scholarship / subscription / AI-credit recipients | HTV signup, award, or follow-up records | Primary users whose apps/opportunities may be featured | Program lead | Not started |
| Demo Hours presenters who received support | Demo Hours RSVP/check-in/project records | Likely to have a project link and near-term ask | Event lead | Not started |
| Prize winners or finalists from HTV events | Event judging/project records | Public project showcase may overlap with this work | Event lead | Not started |
| Mentors / sponsors who offered opportunities | Sponsor/mentor commitments and approved partner contacts | Could supply internships, credits, office hours, or platform perks | Partnerships lead | Not started |
| Alumni/project owners already published on HTV | Existing `success-stories` and project pages | Reuse lessons from public-story consent and link freshness | Site owner | Not started |
| Moderators / admins | HTV organizers responsible for site content | Need moderation workflow before launch | Site owner | Not started |

## Outreach script

Subject: Optional HTV scholarship recipient feature / opportunity link

Hi {{first_name}},

We are exploring a lightweight way for Hack the Valley to help scholarship / credit recipients share what they are building and, if useful, link to opportunities like an app, project page, demo, waitlist, hiring ask, collaboration request, or portfolio.

This is optional. We will not publish your name, project, links, photo, or opportunity without your explicit approval.

Could you reply with the short form below, or tell us if you would rather not be listed?

1. What would you want people to see? Examples: app link, demo video, project page, GitHub, portfolio, waitlist, hiring/collaboration ask, or nothing public.
2. What name should we display, if any? Options: full name, team name, first name only, or anonymous/no listing.
3. What project/app/opportunity should HTV link to or describe?
4. Is the link public and safe for HTV to share? If not, what restrictions apply?
5. What audience are you hoping to reach? Examples: users, collaborators, mentors, employers, investors, sponsors, other students.
6. Is this time-sensitive? If yes, what date should the listing expire or be reviewed?
7. Do you give HTV permission to publish the submitted information on the HTV website and update/remove it on request?

Thank you — this will help us decide whether to build a small directory, hosted pages, external links, or defer until there is enough demand.

## Discovery questions

### Recipient needs

- Do recipients want promotion, feedback, collaborators, users, hiring, mentorship, or simply proof of recognition?
- Are they comfortable with public attribution, or do they prefer project/team-only listings?
- Do they already have a canonical link, or do they need HTV-hosted space?
- How often do their links or opportunities change?
- What is the minimum useful listing: name + project + link, or richer story/profile content?

### Organizer workflow

- Who approves new listings and edits?
- Who owns takedown requests and link maintenance?
- What is the expected SLA for updates/removals?
- Should listings expire automatically after a fixed window unless renewed?
- Should listings be tied to existing event/project records or live in a separate content file?

### Audience and success metrics

- Who is the intended reader: sponsors, employers, mentors, students, general public, or HTV organizers?
- What action should the reader take after viewing a listing?
- What would make this worth maintaining: number of recipients listed, outbound clicks, introductions made, sponsor engagement, demo signups, or qualitative feedback?

### Legal, privacy, and consent

- Are any recipients minors, and if so what guardian consent is required?
- Can recipient scholarship status be public, or should HTV only say “community project” / “recipient-submitted opportunity”?
- What information should never be collected: personal phone numbers, private addresses, school IDs, private Discord handles, sensitive financial need, or immigration/aid details?
- How do recipients revoke consent or request edits?

## Data capture template

Copy this table into an internal spreadsheet or issue comment during discovery. Keep private contact details out of the public repo.

| Field | Purpose | Public? | Notes |
| --- | --- | --- | --- |
| Internal contact owner | Follow-up accountability | No | Organizer responsible for outreach |
| Recipient/team display name | Listing attribution | Yes, with consent | Allow full name, team name, first name only, or anonymous/no listing |
| Contact email or preferred channel | Follow-up and approval | No | Store only in approved internal tool |
| Recipient category | Context for organizers | Usually no | Scholarship, AI-credit, demo presenter, finalist, etc. |
| Project/opportunity title | Listing title | Yes, with consent | Recipient-provided |
| Short description | Explains the app/opportunity | Yes, with consent | 1–2 sentences, reviewed by recipient |
| Primary link | Destination CTA | Yes, with consent | App, website, GitHub, Devpost, waitlist, portfolio, video, etc. |
| Link type | UI grouping/filtering | Yes | App, project, collaboration, hiring, mentorship, demo, other |
| Desired audience | Product direction | Optional | Users, collaborators, mentors, employers, sponsors, investors |
| CTA label | Makes action explicit | Yes | Try app, join waitlist, contact team, view demo, mentor us, etc. |
| Image/logo permission | Visual listing | Yes, if provided | Require rights/permission before publishing |
| Expiration/review date | Prevent stale opportunities | No or admin-only | Default to 90 days if recipient is unsure |
| Consent timestamp/source | Audit trail | No | Email/form timestamp and exact consent language |
| Approval status | Moderation state | No | Draft, awaiting recipient approval, approved, published, expired, removed |
| Removal/update notes | Maintenance | No | Track takedown requests and edits |

## Product direction options

### Option A: External-link directory

A simple `/opportunities` or `/community/opportunities` page with cards linking to recipient-approved destinations.

- Pros: fastest; low hosting liability; easiest to remove stale entries; enough for apps with existing URLs.
- Cons: less storytelling; link rot; limited SEO/content value; still needs moderation.
- Best when: most recipients already have public links and only need visibility.
- Implementation shape: static JSON or admin-managed records powering a directory with filters and expiration metadata.

### Option B: Hosted recipient/project pages

HTV hosts a page per recipient/project with description, media, links, updates, and contact CTA.

- Pros: best for recipients without websites; consistent HTV storytelling; strong sponsor/employer-facing artifact.
- Cons: higher consent/privacy burden; more moderation; requires editing workflow and stronger brand review.
- Best when: recipients want a polished public profile and HTV can maintain approvals.
- Implementation shape: extend project pages or add a `recipient-opportunities` content model with draft/approved/published states.

### Option C: Hybrid directory with optional hosted detail pages

A directory card always exists for approved entries; recipients can choose either an external link or an HTV-hosted detail page.

- Pros: flexible; supports both mature apps and early projects; clear migration path from small MVP to richer stories.
- Cons: more design states; requires careful data model to avoid overbuilding.
- Best when: outreach shows mixed needs across recipients.
- Implementation shape: start with directory fields and add hosted detail pages only when `hosted_page_enabled` is true.

### Option D: Add opportunities to existing project showcase only

Use current event/project pages as the surface and add CTA fields like “Looking for mentors” or “Try the app.”

- Pros: avoids another site section; keeps opportunities tied to event context; may reuse existing admin/project code.
- Cons: misses non-event scholarship recipients; could clutter project showcase; less clear for sponsors/employers.
- Best when: almost all opportunities are event projects already in the system.
- Implementation shape: add optional opportunity metadata to project records and render it on project cards/pages.

### Option E: Defer public product

Collect recipient preferences now but do not launch a public surface until there are enough approved listings and a maintenance owner.

- Pros: safest; avoids stale/empty page; respects uncertain demand.
- Cons: no immediate public value; may lose momentum.
- Best when: fewer than 3–5 recipients opt in, consent is unclear, or no owner can moderate.
- Implementation shape: keep an internal spreadsheet/form and revisit after the next Demo Hours or scholarship cohort.

## Preliminary recommendation

Start with Option A unless outreach shows strong demand for HTV-hosted storytelling. An external-link directory can be implemented as a small, consent-gated MVP with expiration dates and a clear removal process. If at least several recipients request hosted pages, evolve toward Option C.

Suggested launch criteria before implementation:

- At least 3 approved recipient/opportunity entries.
- One named organizer owns moderation and takedowns.
- Consent language is approved and captured for every public field.
- Each listing has a review/expiration date.
- HTV has a policy for minors, photos, logos, and sponsor-sensitive claims.

## Privacy, brand, and moderation concerns

- Consent must be explicit per field. Do not treat scholarship/credit acceptance as permission to publish.
- Scholarship status may reveal financial or program participation information; make public labeling optional.
- Avoid publishing minors' full names, photos, schools, or contact links without guardian/organizer-approved policy.
- Prefer recipient-owned public links over direct personal contact information.
- Avoid implying HTV endorsement, investment advice, employment screening, or guaranteed quality of listed apps.
- Add a disclaimer that listings are recipient-submitted and links lead to third-party sites unless hosted by HTV.
- Check links for malware/phishing, inappropriate content, login walls, broken pages, and major brand conflicts before publishing.
- Require recipient permission for logos, screenshots, photos, testimonials, and claims about sponsors, schools, employers, or awards.
- Define takedown workflow: who can request removal, who approves, target response time, and how removals are logged.
- Define staleness policy: default review after 90 days; expire or hide entries that cannot be re-confirmed.
- Keep private notes, contact details, and consent evidence out of public repository files.

## Concrete follow-up implementation issue stubs

### Stub 1: Build scholarship opportunity directory MVP

**Problem:** Approved scholarship/credit recipients need a lightweight public place to share app/opportunity links.

**Scope:**
- Add a public opportunities directory page.
- Render only entries marked approved/published.
- Use a small data source with title, display name, description, CTA, primary link, category, review date, and consent metadata stored privately/admin-only where appropriate.
- Include empty state and third-party-link disclaimer.

**Acceptance criteria:**
- No unapproved entry renders publicly.
- Listings can be hidden/expired without code changes beyond data update if using static content.
- Page works on mobile and matches HTV visual style.
- Link labels and external-link behavior are accessible.

### Stub 2: Add opportunity metadata to existing project/admin model

**Problem:** Some opportunities may already map to HTV project records, and organizers need one workflow for project CTAs.

**Scope:**
- Add optional opportunity fields to project records or content JSON.
- Support CTA label, link, audience/category, approval status, and review date.
- Render approved CTAs on project cards/details without disrupting normal project browsing.

**Acceptance criteria:**
- Existing projects without opportunity fields are unchanged.
- Draft/unapproved CTAs never appear publicly.
- Admin or data documentation explains required consent before enabling a CTA.

### Stub 3: Create recipient consent/update form

**Problem:** Email replies are hard to audit and update over time.

**Scope:**
- Create an internal or public form for recipients to submit listing details and consent.
- Include explicit consent checkboxes for name, project, links, images, and update/removal policy.
- Store private contact details outside public repo/content.

**Acceptance criteria:**
- Submission captures timestamped consent language.
- Required fields prevent publishing without a public display choice and approved link.
- Organizers can export/review submissions before publication.

### Stub 4: Hosted recipient/project detail page spike

**Problem:** Some recipients may not have a website but may benefit from an HTV-hosted page.

**Scope:**
- Prototype one non-public sample detail page using placeholder data only.
- Identify whether to reuse existing project page routes or create a new content type.
- Document image/media requirements, moderation states, and removal behavior.

**Acceptance criteria:**
- No real recipient data is used without consent.
- Spike recommends reuse vs new route with tradeoffs.
- Follow-up implementation issue includes exact fields and route design.

### Stub 5: Moderation and takedown policy for recipient opportunities

**Problem:** Public listings need clear ownership, review cadence, and removal process.

**Scope:**
- Draft policy for approval, rejection, update, expiration, and takedown.
- Define organizer roles and target response times.
- Add checklist for minors, images/logos, sponsor claims, and external links.

**Acceptance criteria:**
- Policy is linked from implementation docs/admin guidance.
- Every listing has an owner and review date.
- Removal requests can be completed without deployment if the chosen architecture supports it.

## Open decisions

- What public label should this use: “Opportunities,” “Community Projects,” “Recipient Projects,” “Alumni Builds,” or something else?
- Should the page be indexed by search engines?
- Should contact happen through recipient-provided links only, or should HTV broker introductions?
- Should listings be event-specific, cohort-specific, or global across HTV?
- What is the minimum number of opt-in recipients needed before launch?
- Who is the long-term owner after the first implementation?

## Next discovery steps

1. Confirm the internal source of truth for recipient/contact records.
2. Pick an outreach owner and send the script to a small initial cohort only after organizer approval.
3. Capture responses using the template above; do not commit private response data to the repo.
4. Summarize opt-in count, common requested link types, and moderation load.
5. Choose Option A, C, D, or E and open the relevant implementation issues.
