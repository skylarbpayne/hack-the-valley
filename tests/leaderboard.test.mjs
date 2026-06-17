import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { listCommunityLeaderboard } from "../functions/_lib/event-platform.js";
import worker from "../worker.js";

function leaderboardDb() {
  const queries = [];
  return {
    queries,
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) {
          this.args = args;
          queries.push({ sql, args });
          return this;
        },
        async all() {
          if (/WITH facts AS/.test(sql)) {
            assert.deepEqual(this.args, [50]);
            return { results: [
              {
                user_id: "usr_ada",
                display_name: "Ada Lovelace",
                project_count: 2,
                hack_hours_checkins: 3,
                attended_htv_2026: 0,
                prize_awards: 1,
                overall_winner: 1,
                score: 41
              },
              {
                user_id: "usr_grace",
                display_name: "Grace Hopper",
                project_count: 1,
                hack_hours_checkins: 0,
                attended_htv_2026: 1,
                prize_awards: 0,
                overall_winner: 0,
                score: 8
              }
            ] };
          }
          if (/FROM users u\s+JOIN project_members pm/.test(sql)) {
            assert.deepEqual(this.args, ["usr_ada", "usr_grace"]);
            return { results: [
              { user_id: "usr_ada", project_id: "prj_1", slug: "compiler-cat", title: "Compiler Cat", team_name: "Team Ada", event_slug: "hack-the-valley-2026", submitted_at: "2026-05-01T00:00:00.000Z" },
              { user_id: "usr_ada", project_id: "prj_2", slug: "logic-lamp", title: "Logic Lamp", team_name: "Team Ada", event_slug: "hack-the-valley-2026", submitted_at: "2026-05-02T00:00:00.000Z" },
              { user_id: "usr_grace", project_id: "prj_3", slug: "debug-duck", title: "Debug Duck", team_name: "Team Grace", event_slug: "hack-the-valley-2026", submitted_at: "2026-05-03T00:00:00.000Z" }
            ] };
          }
          throw new Error(`Unexpected leaderboard query: ${sql}`);
        }
      };
      return statement;
    }
  };
}

test("community leaderboard returns scored, privacy-safe public entries", async () => {
  const leaderboard = await listCommunityLeaderboard(leaderboardDb(), { limit: 50 });

  assert.equal(leaderboard.length, 2);
  assert.equal(leaderboard[0].rank, 1);
  assert.equal(leaderboard[0].display_name, "Ada Lovelace");
  assert.equal(leaderboard[0].score, 41);
  assert.equal(leaderboard[0].metrics.projects, 2);
  assert.equal(leaderboard[0].metrics.hack_hours_checkins, 3);
  assert.equal(leaderboard[0].metrics.htv_2026_overall_winner, true);
  assert.deepEqual(leaderboard[0].badges.map((badge) => badge.slug), [
    "attended-hack-hours",
    "submitted-project",
    "won-prize-htv-2026",
    "won-overall-htv-2026"
  ]);
  assert.equal(leaderboard[0].projects.length, 2);

  assert.equal(leaderboard[1].display_name, "Grace Hopper");
  assert.equal(leaderboard[1].metrics.attended_htv_2026, true);
  assert.ok(leaderboard[1].badges.some((badge) => badge.slug === "attended-htv-2026"));
  assert.equal(leaderboard[1].badges.some((badge) => badge.slug === "helped-mentor"), false);

  const serialized = JSON.stringify(leaderboard);
  assert.doesNotMatch(serialized, /email|phone|emergency|payload_json|uploads_json|awarded_by|source/i);
});

test("worker exposes public leaderboard API without an organizer session", async () => {
  const response = await worker.fetch(
    new Request("https://hackthevalley.org/api/leaderboard", { method: "GET" }),
    { HTV_DB: leaderboardDb(), ASSETS: { fetch: () => new Response("static miss", { status: 404 }) } },
    {}
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.leaderboard[0].display_name, "Ada Lovelace");
  assert.equal(body.scoring.hack_hours_checkin, 2);
  assert.match(body.privacy, /omit/i);
  assert.doesNotMatch(JSON.stringify(body), /ada@example\.com|661-555|payload_json|uploads_json/i);
});

test("leaderboard page loads the leaderboard API and documents privacy/scoring", () => {
  const html = readFileSync(new URL("../public/leaderboard/index.html", import.meta.url), "utf8");
  assert.match(html, /Community Leaderboard/);
  assert.match(html, /fetch\('\/api\/leaderboard\?limit=50'/);
  assert.match(html, /Hack Hours check-in/);
  assert.match(html, /Private participant details stay private/);
  assert.doesNotMatch(html, /mailto:/i);
});
