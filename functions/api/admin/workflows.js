import {
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  requireAdmin
} from "../../_lib/event-platform.js";

const ADMIN_SESSION_CAPABILITY = "admin.session";

function command({
  id,
  label,
  method,
  pathTemplate,
  domain,
  readOnly = false,
  danger = false,
  approvalRequired = false,
  capability = ADMIN_SESSION_CAPABILITY,
  description
}) {
  return {
    id,
    label,
    method,
    pathTemplate,
    domain,
    readOnly,
    danger,
    approvalRequired,
    capability,
    description
  };
}

const sections = [
  {
    id: "events",
    label: "Events",
    description: "Event setup, recurrence planning, image assets, and participant-facing signup fields.",
    commands: [
      command({
        id: "events.list",
        label: "List events and instances",
        method: "GET",
        pathTemplate: "/api/events?include_archived=1",
        domain: "events",
        readOnly: true,
        capability: "events.read",
        description: "Load event and instance context for admin navigation."
      }),
      command({
        id: "events.create-update",
        label: "Create or update event",
        method: "POST",
        pathTemplate: "/api/events",
        domain: "events",
        approvalRequired: true,
        capability: "events.write",
        description: "Save event metadata only after an admin reviews title, status, capacity, venue, and public page fields."
      }),
      command({
        id: "events.recurrence-preview",
        label: "Preview recurrence candidates",
        method: "PREVIEW",
        pathTemplate: "recurrence:{eventSlug}:preview",
        domain: "events",
        readOnly: true,
        capability: "events.recurrence.preview",
        description: "Compute proposed instances without inserting or publishing anything."
      }),
      command({
        id: "events.recurrence-apply",
        label: "Apply recurrence after review",
        method: "GATED",
        pathTemplate: "recurrence:{eventSlug}:apply",
        domain: "events",
        danger: true,
        approvalRequired: true,
        capability: "events.recurrence.apply",
        description: "Command placeholder for a future explicitly gated insert-missing flow; this endpoint does not auto-generate instances."
      }),
      command({
        id: "events.image",
        label: "Upload event image",
        method: "POST",
        pathTemplate: "/api/events/{slug}/image",
        domain: "events",
        approvalRequired: true,
        capability: "events.image.write",
        description: "Attach a reviewed image asset to an event record."
      }),
      command({
        id: "events.signup-fields",
        label: "Update signup fields",
        method: "POST",
        pathTemplate: "/api/events",
        domain: "events",
        approvalRequired: true,
        capability: "events.signup_fields.write",
        description: "Review and save participant role field configuration for the public event signup form."
      })
    ]
  },
  {
    id: "participation",
    label: "Participation",
    description: "Roster visibility, readiness blockers, attendance facts, and role-based roster filtering.",
    commands: [
      command({
        id: "participation.roster",
        label: "View roster",
        method: "GET",
        pathTemplate: "/api/events/{slug}/instances/{instanceId}/cockpit",
        domain: "participation",
        readOnly: true,
        capability: "participation.roster.read",
        description: "Read signed-up attendees, check-in state, repeat status, and safety readiness."
      }),
      command({
        id: "participation.readiness-blockers",
        label: "Review readiness blockers",
        method: "GET",
        pathTemplate: "/api/events/{slug}/instances/{instanceId}/cockpit",
        domain: "participation",
        readOnly: true,
        capability: "participation.readiness.read",
        description: "Highlight missing emergency contact details and other blocker metadata without changing participant state."
      }),
      command({
        id: "participation.check-in",
        label: "Check in attendee",
        method: "POST",
        pathTemplate: "/api/events/{slug}/checkins",
        domain: "participation",
        approvalRequired: true,
        capability: "participation.check_in.write",
        description: "Record an admin-reviewed check-in for an existing signup or selected user."
      }),
      command({
        id: "participation.manual-check-in",
        label: "Manual walk-up check-in",
        method: "POST",
        pathTemplate: "/api/events/{slug}/checkins",
        domain: "participation",
        approvalRequired: true,
        capability: "participation.manual_check_in.write",
        description: "Create or reuse a user, register them for the selected instance, and then check them in only after form review."
      }),
      command({
        id: "participation.no-show",
        label: "Mark no-show after event",
        method: "GATED",
        pathTemplate: "participation:{eventInstanceId}:{userId}:no-show",
        domain: "participation",
        danger: true,
        approvalRequired: true,
        capability: "participation.no_show.write",
        description: "Command placeholder for a future reviewed attendance fact; no no-show route is exposed here."
      }),
      command({
        id: "participation.cancel",
        label: "Cancel participation",
        method: "GATED",
        pathTemplate: "participation:{eventInstanceId}:{userId}:cancel",
        domain: "participation",
        danger: true,
        approvalRequired: true,
        capability: "participation.cancel.write",
        description: "Command placeholder for a future reviewed cancellation fact; no cancellation route is exposed here."
      }),
      command({
        id: "participation.role-filters",
        label: "Filter by signup role",
        method: "GET",
        pathTemplate: "/api/events/{slug}/signups?instance_id={instanceId}",
        domain: "participation",
        readOnly: true,
        capability: "participation.roles.read",
        description: "Review participant roles such as attendee, demo sharer, mentor, or organizer helper."
      })
    ]
  },
  {
    id: "projects",
    label: "Projects",
    description: "Project showcase review, event-linked submissions, members, and organizer status updates.",
    commands: [
      command({
        id: "projects.showcase-status",
        label: "Review showcase status",
        method: "GET",
        pathTemplate: "/api/events/{slug}/instances/{instanceId}/projects",
        domain: "projects",
        readOnly: true,
        capability: "projects.showcase.read",
        description: "See which projects are linked to an event instance and visible to organizers."
      }),
      command({
        id: "projects.event-submissions",
        label: "List event project submissions",
        method: "GET",
        pathTemplate: "/api/events/{slug}/instances/{instanceId}/projects",
        domain: "projects",
        readOnly: true,
        capability: "projects.submissions.read",
        description: "Read submitted project cards for the selected event instance."
      }),
      command({
        id: "projects.members",
        label: "Review project members",
        method: "GET",
        pathTemplate: "/api/users/{id}/state",
        domain: "projects",
        readOnly: true,
        capability: "projects.members.read",
        description: "Inspect project memberships through the participant state view."
      }),
      command({
        id: "projects.organizer-status",
        label: "Organizer status update",
        method: "GATED",
        pathTemplate: "projects:{eventSlug}:{projectId}:status",
        domain: "projects",
        danger: true,
        approvalRequired: true,
        capability: "projects.status.write",
        description: "Command placeholder for reviewed showcase status changes; this surface does not add an auto-hide or auto-approve action."
      })
    ]
  },
  {
    id: "badges",
    label: "Badges",
    description: "Badge catalog review, explicit awards, revocations, and derived badge previews.",
    commands: [
      command({
        id: "badges.catalog",
        label: "View badge catalog",
        method: "GET",
        pathTemplate: "/api/users/{id}/badges",
        domain: "badges",
        readOnly: true,
        capability: "badges.catalog.read",
        description: "Inspect awarded badges and catalog-backed badge metadata for a selected participant."
      }),
      command({
        id: "badges.award",
        label: "Award badge",
        method: "POST",
        pathTemplate: "/api/users/{id}/badges",
        domain: "badges",
        approvalRequired: true,
        capability: "badges.award.write",
        description: "Award a reviewed badge with actor attribution and audit trail."
      }),
      command({
        id: "badges.revoke",
        label: "Revoke badge award",
        method: "GATED",
        pathTemplate: "badges:{userId}:{awardId}:revoke",
        domain: "badges",
        danger: true,
        approvalRequired: true,
        capability: "badges.revoke.write",
        description: "Revoke a badge only with an explicit award id, reason, and admin review."
      }),
      command({
        id: "badges.derived-preview",
        label: "Preview derived badges",
        method: "GET",
        pathTemplate: "/api/users/{id}/state",
        domain: "badges",
        readOnly: true,
        capability: "badges.derived.preview",
        description: "Read participant facts that would justify derived badges before any award action."
      })
    ]
  },
  {
    id: "audit",
    label: "Audit",
    description: "Recent admin action history and filter metadata.",
    commands: [
      command({
        id: "audit.recent",
        label: "Recent admin actions",
        method: "GET",
        pathTemplate: "/api/admin/audit?limit={limit}&action={action}&scope_type={scopeType}",
        domain: "audit",
        readOnly: true,
        capability: "audit.read",
        description: "Read recent admin audit rows with safe filters and no state changes."
      }),
      command({
        id: "audit.filter-metadata",
        label: "Audit filter metadata",
        method: "GET",
        pathTemplate: "/api/admin/workflows",
        domain: "audit",
        readOnly: true,
        capability: "audit.filters.read",
        description: "Expose available non-editorial domains and command ids for audit filter UIs."
      })
    ]
  }
];

export function adminWorkflowSurface() {
  return {
    ok: true,
    scope: "non-editorial-admin-workflows",
    note: "Editorial and outbound messaging workflows are owned separately and are not shown here.",
    sections,
    domains: sections.map((section) => section.id)
  };
}

async function requireSessionAdmin(request, env) {
  const access = await requireAdmin(request, env);
  if (access.bootstrap) {
    throw Object.assign(new Error("Admin session role required"), { status: 403 });
  }
  return access;
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireSessionAdmin(context.request, context.env);
    return jsonResponse(adminWorkflowSurface());
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET"]);
}
