import test from "node:test";
import assert from "node:assert/strict";

import {
  addProjectMember,
  claimProjectForUser,
  createProject,
  normalizeProjectInput,
  updateProject
} from "../functions/_lib/domain/projects.js";

function createProjectDomainDb() {
  const statements = [];
  const users = new Map([
    ["usr_maya", { id: "usr_maya", email: "maya@example.com", name: "Maya Rivera" }],
    ["usr_eli", { id: "usr_eli", email: "eli@example.com", name: "Eli Chen" }]
  ]);
  const projects = new Map();
  const members = [];

  return {
    statements,
    projects,
    members,
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) {
          this.args = args;
          statements.push(this);
          return this;
        },
        async run() {
          if (/INSERT INTO projects/.test(sql)) {
            const [id, slug, title, teamName, description, repoUrl, demoUrl, tracksJson, canonicalSubmissionId, createdAt, updatedAt] = this.args;
            const existing = [...projects.values()].find((project) => project.slug === slug);
            const project = existing || { id, slug, created_at: createdAt };
            Object.assign(project, { slug, title, team_name: teamName, description, repo_url: repoUrl, demo_url: demoUrl, tracks_json: tracksJson, canonical_submission_id: canonicalSubmissionId, updated_at: updatedAt });
            projects.set(project.id, project);
            return { success: true };
          }
          if (/INSERT INTO project_members/.test(sql)) {
            const [id, projectId, userId, name, email, role, source, createdAt] = this.args;
            let member = members.find((row) => row.project_id === projectId && ((userId && row.user_id === userId) || (email && row.email === email)));
            if (!member) {
              member = { id, project_id: projectId, user_id: userId, created_at: createdAt };
              members.push(member);
            }
            Object.assign(member, { name, email, role: member.role === "owner" ? member.role : role, source });
            return { success: true };
          }
          if (/UPDATE projects/.test(sql)) {
            const [slug, title, teamName, description, repoUrl, demoUrl, tracksJson, canonicalSubmissionId, updatedAt, projectId] = this.args;
            const project = projects.get(projectId);
            Object.assign(project, { slug, title, team_name: teamName, description, repo_url: repoUrl, demo_url: demoUrl, tracks_json: tracksJson, canonical_submission_id: canonicalSubmissionId, updated_at: updatedAt });
            return { success: true };
          }
          if (/UPDATE project_members/.test(sql)) return { success: true };
          throw new Error(`Unexpected run query: ${sql}`);
        },
        async first() {
          if (/SELECT \* FROM users WHERE id/.test(sql)) return users.get(this.args[0]) || null;
          if (/SELECT \* FROM projects WHERE slug/.test(sql)) return [...projects.values()].find((project) => project.slug === this.args[0]) || null;
          if (/SELECT \* FROM projects WHERE id/.test(sql)) return projects.get(this.args[0]) || null;
          if (/SELECT \* FROM project_members WHERE project_id = \? AND user_id/.test(sql)) return members.find((row) => row.project_id === this.args[0] && row.user_id === this.args[1]) || null;
          if (/SELECT \* FROM project_members WHERE project_id = \? AND lower\(email\)/.test(sql)) return members.find((row) => row.project_id === this.args[0] && row.email?.toLowerCase() === String(this.args[1]).toLowerCase()) || null;
          if (/FROM project_members\s+WHERE project_id = \? AND \(user_id = \? OR lower\(email\)/.test(sql)) {
            const [projectId, userId, email] = this.args;
            return members.find((row) => row.project_id === projectId && (row.user_id === userId || row.email?.toLowerCase() === String(email).toLowerCase())) || null;
          }
          if (/FROM projects p\s+JOIN project_members pm/.test(sql)) {
            const [projectId, userId, email] = this.args;
            const member = members.find((row) => row.project_id === projectId && (row.user_id === userId || row.email?.toLowerCase() === String(email).toLowerCase()));
            return member ? projects.get(projectId) : null;
          }
          throw new Error(`Unexpected first query: ${sql}`);
        }
      };
      return statement;
    }
  };
}

test("normalizeProjectInput accepts links without creating event-scoped state", () => {
  const { project, errors } = normalizeProjectInput({
    title: "Valley SAT Prep",
    teamName: "Sequoia Sasquatches",
    links: { repo_url: "https://github.com/example/sat", demo_url: "https://sat.example.com" }
  });
  assert.deepEqual(errors, []);
  assert.equal(project.slug, "valley-sat-prep");
  assert.equal(project.repo_url, "https://github.com/example/sat");
  assert.equal(project.demo_url, "https://sat.example.com");
});

test("createProject creates a durable project and owner membership", async () => {
  const db = createProjectDomainDb();
  const result = await createProject(db, {
    ownerPerson: { id: "usr_maya", email: "maya@example.com", name: "Maya Rivera" },
    title: "Valley SAT Prep",
    teamName: "Sequoia Sasquatches",
    description: "SAT practice for Central Valley students"
  });

  assert.equal(result.project.id, "prj_valley_sat_prep");
  assert.equal(result.membership.role, "owner");
  const sql = db.statements.map((statement) => statement.sql).join("\n");
  assert.match(sql, /INSERT INTO projects/);
  assert.match(sql, /INSERT INTO project_members/);
  assert.doesNotMatch(sql, /event_project_submissions/);
});

test("updateProject requires project membership and only edits durable project fields", async () => {
  const db = createProjectDomainDb();
  await createProject(db, { ownerPerson: { id: "usr_maya" }, title: "Old Project", teamName: "Old Team" });

  const updated = await updateProject(db, {
    projectId: "prj_old_project",
    actorPerson: { id: "usr_maya", email: "maya@example.com" },
    patch: { title: "Edited Project", team_name: "New Team" }
  });

  assert.equal(updated.project.title, "Edited Project");
  assert.equal(updated.project.team_name, "New Team");
  await assert.rejects(
    () => updateProject(db, { projectId: "prj_old_project", actorPerson: { id: "usr_intruder", email: "intruder@example.com" }, patch: { title: "Nope" } }),
    /Project not found/
  );
});

test("addProjectMember can add an invited email member without event submission side effects", async () => {
  const db = createProjectDomainDb();
  await createProject(db, { ownerPerson: { id: "usr_maya" }, title: "Community Map" });
  const member = await addProjectMember(db, { projectId: "prj_community_map", email: "teammate@example.com", role: "member" });

  assert.equal(member.email, "teammate@example.com");
  assert.equal(member.role, "member");
  assert.doesNotMatch(db.statements.map((statement) => statement.sql).join("\n"), /event_project_submissions/);
});

test("createProject and claimProjectForUser reject slug collisions from non-members", async () => {
  const db = createProjectDomainDb();
  await createProject(db, { ownerPerson: { id: "usr_maya", email: "maya@example.com" }, title: "Community Map" });

  await assert.rejects(
    () => createProject(db, { ownerPerson: { id: "usr_eli", email: "eli@example.com" }, title: "Community Map", description: "Takeover" }),
    /Project slug already exists/
  );
  await assert.rejects(
    () => claimProjectForUser(db, "usr_eli", { title: "Community Map", description: "Takeover" }),
    /Project slug already exists/
  );
  assert.equal(db.projects.get("prj_community_map").description, null);
  assert.equal(db.members.some((member) => member.project_id === "prj_community_map" && member.user_id === "usr_eli"), false);
});
