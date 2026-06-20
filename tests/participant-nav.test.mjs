import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const expectedOrder = ["events", "projects", "profile", "leaderboard"];
const expectedLabels = ["Events", "Projects", "Profile", "Leaderboard"];

const pages = [
  { name: "home", path: "../public/index.html", active: null, private: false },
  { name: "events", path: "../public/events/index.html", active: "events", private: false },
  { name: "event detail", path: "../public/events/hack-the-valley-2026/index.html", active: "events", private: false },
  { name: "projects", path: "../public/projects/index.html", active: "projects", private: false },
  { name: "profile", path: "../public/me/index.html", active: "profile", private: true },
  { name: "project workspace", path: "../public/me/projects/index.html", active: "projects", private: true },
  { name: "leaderboard", path: "../public/leaderboard/index.html", active: "leaderboard", private: false },
  { name: "login", path: "../public/login/index.html", active: "profile", private: false }
];

function pageHtml(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function participantNav(html) {
  const match = html.match(/<div[^>]*data-participant-nav[^>]*>[\s\S]*?<\/div>/);
  assert.ok(match, "expected a participant nav container");
  return match[0];
}

function navLinks(nav) {
  return [...nav.matchAll(/<a\b(?=[^>]*data-nav-link="([^"]+)")([^>]*)>([\s\S]*?)<\/a>/g)].map((match) => {
    const attrs = match[2];
    const href = attrs.match(/href="([^"]+)"/)?.[1] || "";
    return {
      key: match[1],
      href,
      label: match[3].replace(/<[^>]+>/g, "").trim(),
      current: /aria-current="page"/.test(attrs)
    };
  });
}

test("participant pages expose the same top nav labels in the same order", () => {
  for (const page of pages) {
    const links = navLinks(participantNav(pageHtml(page.path)));
    assert.deepEqual(links.map((link) => link.key), expectedOrder, `${page.name} nav key order`);
    assert.deepEqual(links.map((link) => link.label), expectedLabels, `${page.name} nav labels`);
  }
});

test("participant nav uses participant-safe destinations and does not leak admin links", () => {
  for (const page of pages) {
    const nav = participantNav(pageHtml(page.path));
    const links = navLinks(nav);

    assert.equal(links.find((link) => link.key === "events")?.href, "/events", `${page.name} events href`);
    assert.ok(["/projects/", "/me/projects/"].includes(links.find((link) => link.key === "projects")?.href), `${page.name} projects href`);
    assert.equal(links.find((link) => link.key === "leaderboard")?.href, "/leaderboard/", `${page.name} leaderboard href`);

    const profileHref = links.find((link) => link.key === "profile")?.href;
    if (page.private) {
      assert.equal(profileHref, "/me/", `${page.name} private profile href`);
    } else {
      assert.equal(profileHref, "/login/?next=/me/", `${page.name} public profile href preserves auth gate`);
    }

    assert.doesNotMatch(nav, /admin|organizer|submissions/i, `${page.name} nav should not expose admin-only links`);
  }
});

test("current participant section is visually identifiable when a page maps to a core section", () => {
  for (const page of pages.filter((entry) => entry.active)) {
    const currentLinks = navLinks(participantNav(pageHtml(page.path))).filter((link) => link.current);
    assert.equal(currentLinks.length, 1, `${page.name} should have exactly one current nav item`);
    assert.equal(currentLinks[0].key, page.active, `${page.name} current nav item`);
  }
});

test("generated event detail pages use the same participant nav contract", () => {
  const source = readFileSync(new URL("../functions/_lib/event-platform.js", import.meta.url), "utf8");
  const nav = participantNav(source);
  const links = navLinks(nav);
  assert.deepEqual(links.map((link) => link.key), expectedOrder);
  assert.deepEqual(links.map((link) => link.label), expectedLabels);
  assert.doesNotMatch(nav, /admin|organizer|submissions/i);
});
