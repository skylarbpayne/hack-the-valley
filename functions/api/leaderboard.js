import {
  getDb,
  handleErrors,
  listCommunityLeaderboard,
  methodNotAllowed
} from "../_lib/event-platform.js";
import { jsonResponse, optionsResponse } from "../_shared/submissions.js";

const SCORING = {
  htv_2026_attendance: 3,
  submitted_project: 5,
  hack_hours_checkin: 2,
  htv_2026_prize_winner: 10,
  htv_2026_overall_winner: 20
};

export function onRequestOptions() {
  return optionsResponse();
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    const url = new URL(context.request.url);
    const limit = url.searchParams.get("limit") || "50";
    const leaderboard = await listCommunityLeaderboard(getDb(context.env), { limit });
    return jsonResponse({
      ok: true,
      leaderboard,
      count: leaderboard.length,
      scoring: SCORING,
      privacy: "Public leaderboard fields intentionally omit email, phone, emergency contact, and private submission payload data."
    });
  });
}

export async function onRequest() {
  return methodNotAllowed(["GET", "OPTIONS"]);
}
