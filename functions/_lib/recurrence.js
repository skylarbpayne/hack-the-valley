const DAY_INDEX = new Map([
  ["sunday", 0],
  ["monday", 1],
  ["tuesday", 2],
  ["wednesday", 3],
  ["thursday", 4],
  ["friday", 5],
  ["saturday", 6]
]);

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function dateString(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function parseDateOnly(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function parseTime(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

function formatPartsInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function zonedTimeToUtc(dateOnly, time, timeZone) {
  const [year, month, day] = dateOnly.split("-").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, time.hours, time.minutes, 0));
  const rendered = formatPartsInZone(guess, timeZone);
  const renderedAsUtc = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute, rendered.second);
  const desiredAsUtc = Date.UTC(year, month - 1, day, time.hours, time.minutes, 0);
  return new Date(guess.getTime() + (desiredAsUtc - renderedAsUtc));
}

function instanceIdFor(eventSlug, instanceKey) {
  return `inst_${String(eventSlug).replaceAll("-", "_")}_${String(instanceKey).replaceAll("-", "_")}`;
}

export function validateRecurrenceRule(value) {
  const rule = parseJsonObject(value);
  const errors = [];
  const frequency = String(rule.frequency || "").toLowerCase();
  const interval = Number(rule.interval || 1);
  const timeZone = String(rule.timezone || rule.time_zone || "America/Los_Angeles");
  const dayOfWeek = String(rule.day_of_week || "").toLowerCase();
  const startTime = parseTime(rule.start_time);
  const startsOn = parseDateOnly(rule.starts_on);
  const durationMinutes = Number(rule.duration_minutes || 120);
  const generateWeeksAhead = Number(rule.generate_weeks_ahead || 8);

  if (frequency !== "weekly") errors.push("recurrence frequency must be weekly");
  if (!Number.isInteger(interval) || interval < 1) errors.push("recurrence interval must be a positive integer");
  if (!DAY_INDEX.has(dayOfWeek)) errors.push("recurrence day_of_week must be a weekday name");
  if (!startTime) errors.push("recurrence start_time must be HH:mm");
  if (!startsOn) errors.push("recurrence starts_on must be YYYY-MM-DD");
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1) errors.push("recurrence duration_minutes must be a positive integer");
  if (!Number.isInteger(generateWeeksAhead) || generateWeeksAhead < 1) errors.push("recurrence generate_weeks_ahead must be a positive integer");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    errors.push("recurrence timezone must be a valid IANA timezone");
  }

  return {
    rule: {
      frequency,
      interval,
      timezone: timeZone,
      day_of_week: dayOfWeek,
      start_time: rule.start_time,
      duration_minutes: durationMinutes,
      starts_on: rule.starts_on,
      generate_weeks_ahead: generateWeeksAhead
    },
    errors
  };
}

export function generateEventInstanceCandidates(eventSeries, options = {}) {
  const { rule, errors } = validateRecurrenceRule(eventSeries?.recurrence_rule_json || eventSeries?.recurrence_rule);
  if (errors.length) {
    throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
  }

  const dayIndex = DAY_INDEX.get(rule.day_of_week);
  const startTime = parseTime(rule.start_time);
  const firstDate = parseDateOnly(rule.starts_on);
  const now = options.now ? new Date(options.now) : new Date();
  const horizonWeeks = Number(options.generateWeeksAhead || rule.generate_weeks_ahead);
  const includePast = Boolean(options.includePast);
  const windowEnd = addDays(now, horizonWeeks * 7);
  const defaultStatus = options.defaultStatus || "draft";
  const candidates = [];

  let current = firstDate;
  while (current.getUTCDay() !== dayIndex) {
    current = addDays(current, 1);
  }

  while (current <= windowEnd) {
    const localDate = dateString(current);
    const startsAt = zonedTimeToUtc(localDate, startTime, rule.timezone);
    const endsAt = new Date(startsAt.getTime() + rule.duration_minutes * 60_000);
    if (includePast || endsAt >= now) {
      const instanceKey = `${localDate}-${pad(startTime.hours)}${pad(startTime.minutes)}`;
      candidates.push({
        id: instanceIdFor(eventSeries.slug, instanceKey),
        event_slug: eventSeries.slug,
        instance_key: instanceKey,
        title: eventSeries.title,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        venue_name: eventSeries.venue_name || null,
        venue_address: eventSeries.venue_address || null,
        capacity: eventSeries.capacity ?? null,
        status: defaultStatus,
        metadata_json: JSON.stringify({ generated_from_recurrence: true, timezone: rule.timezone })
      });
    }
    current = addDays(current, rule.interval * 7);
  }

  return candidates;
}

export async function ensureEventInstances(db, eventSeries, options = {}) {
  const candidates = generateEventInstanceCandidates(eventSeries, options);
  const existingResult = await db.prepare("SELECT * FROM event_instances WHERE event_slug = ?").bind(eventSeries.slug).all();
  const existingRows = existingResult.results || [];
  const existingByKey = new Map(existingRows.map((row) => [row.instance_key, row]));
  const missing = candidates.filter((candidate) => !existingByKey.has(candidate.instance_key));
  const created = [];

  if (!options.dryRun) {
    const now = new Date().toISOString();
    for (const candidate of missing) {
      await db.prepare(`
        INSERT INTO event_instances (
          id, event_slug, instance_key, title, starts_at, ends_at, venue_name, venue_address,
          capacity, status, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        candidate.id,
        candidate.event_slug,
        candidate.instance_key,
        candidate.title,
        candidate.starts_at,
        candidate.ends_at,
        candidate.venue_name,
        candidate.venue_address,
        candidate.capacity,
        candidate.status,
        candidate.metadata_json,
        now,
        now
      ).run();
      created.push(candidate);
    }
  }

  return {
    candidates,
    existing: candidates.filter((candidate) => existingByKey.has(candidate.instance_key)),
    missing,
    created
  };
}
