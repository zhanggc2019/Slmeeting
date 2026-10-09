import type { MeetingMinutes } from "@/bindings";

type MinutesObject = Record<string, unknown>;
type Translate = (key: string) => string;

const sections = [
  "decisions",
  "action_items",
  "key_topics",
  "business_impact",
  "risks",
  "blockers",
  "open_questions",
  "requests_for_decision",
  "next_steps",
  "follow_up",
  "attendees",
] as const;

/** Convert unknown LLM fields to readable text while retaining names and dates. */
function readableText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (Array.isArray(value))
    return value.map(readableText).filter(Boolean).join("；");
  if (value && typeof value === "object") {
    return Object.values(value).map(readableText).filter(Boolean).join(" · ");
  }
  return "";
}

/** Encode text for safe insertion into HTML text and attribute positions. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

/** Render one structured action with its task, owner, and deadline together. */
function actionHtml(value: unknown, t: Translate): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return escapeHtml(readableText(value));
  }
  const action = value as MinutesObject;
  const task = readableText(
    action.task ?? action.action ?? action.content ?? action.description,
  );
  const owner = readableText(
    action.owner ?? action.assignee ?? action.responsible,
  );
  const due = readableText(action.due_date ?? action.deadline);
  const chips = [
    owner &&
      `<span class="chip">${escapeHtml(t("settings.meeting.minutesView.owner"))} · ${escapeHtml(owner)}</span>`,
    due &&
      `<span class="chip chip-date">${escapeHtml(t("settings.meeting.minutesView.due"))} · ${escapeHtml(due)}</span>`,
  ]
    .filter(Boolean)
    .join("");
  return `<span class="item-text">${escapeHtml(task || readableText(value))}</span>${chips ? `<span class="item-meta">${chips}</span>` : ""}`;
}

/** Build an offline, printable HTML meeting minutes document. */
export function createMeetingHtmlDocument(
  minutes: MeetingMinutes,
  t: Translate,
  language: string,
): string {
  let data: MinutesObject = {};
  try {
    const parsed: unknown = JSON.parse(minutes.content_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as MinutesObject;
    }
  } catch {
    // Older records retain their Markdown in the plain-text fallback.
  }

  const title = readableText(data.title) || t("settings.meeting.minutes");
  const summary = readableText(data.executive_summary ?? data.summary);
  const date = new Intl.DateTimeFormat(language, { dateStyle: "long" }).format(
    minutes.created_at,
  );
  const known = new Set<string>([
    "title",
    "executive_summary",
    "summary",
    ...sections,
  ]);

  const summaryHtml = summary
    ? `<section class="summary"><div class="eyebrow">${escapeHtml(t("settings.meeting.minutesView.overview"))}</div><p>${escapeHtml(summary)}</p></section>`
    : "";
  const sectionHtml = sections
    .map((key) => {
      const raw = data[key];
      const entries = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
      const rows = entries.filter((entry) => readableText(entry));
      if (!rows.length) return "";
      const content = rows
        .map((entry, index) => {
          const value =
            key === "action_items"
              ? actionHtml(entry, t)
              : `<span class="item-text">${escapeHtml(readableText(entry))}</span>`;
          return `<li><span class="item-index">${String(index + 1).padStart(2, "0")}</span><div class="item-body">${value}</div></li>`;
        })
        .join("");
      return `<section class="content-section"><div class="section-heading"><h2>${escapeHtml(t(`settings.meeting.minutesView.${key}`))}</h2><span class="count">${rows.length}</span></div><ol>${content}</ol></section>`;
    })
    .join("");
  const extras = Object.entries(data)
    .filter(([key, value]) => !known.has(key) && readableText(value))
    .map(
      ([key, value]) =>
        `<li><span class="item-index">·</span><div class="item-body"><strong>${escapeHtml(key)}</strong> ${escapeHtml(readableText(value))}</div></li>`,
    )
    .join("");
  const extrasHtml = extras
    ? `<section class="content-section"><div class="section-heading"><h2>${escapeHtml(t("settings.meeting.minutesView.other"))}</h2></div><ol>${extras}</ol></section>`
    : "";
  const fallback =
    !summaryHtml && !sectionHtml && !extrasHtml
      ? `<section class="content-section fallback">${escapeHtml(minutes.content_markdown)}</section>`
      : "";

  return `<!doctype html>
<html lang="${escapeHtml(language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light; font-family: "Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif; color: #17243d; background: #eef4fb; }
* { box-sizing: border-box; }
body { margin: 0; padding: 48px 20px 80px; }
.page { max-width: 920px; margin: auto; overflow: hidden; border: 1px solid #d9e6f5; border-radius: 20px; background: #fff; box-shadow: 0 28px 68px -42px #183f78; }
header { position: relative; padding: 42px 52px 34px; border-bottom: 1px solid #dce9f7; background: linear-gradient(125deg, #e9f4ff 0%, #f8fbff 68%, #fff 100%); }
header:before { content: ""; position: absolute; inset: 0 auto 0 0; width: 7px; background: linear-gradient(#20bbf8, #2358e8); }
.eyebrow { color: #245fc9; font-size: 12px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
h1 { margin: 12px 0 8px; font-size: clamp(26px, 3vw, 36px); line-height: 1.35; letter-spacing: -.02em; }
.date { margin: 0; color: #6a7c96; font-size: 13px; }
main { padding: 32px 52px 48px; }
.summary { margin-bottom: 30px; padding: 22px 26px; border: 1px solid #cfe3fc; border-left: 4px solid #2873ed; border-radius: 12px; background: #f4f9ff; }
.summary p { margin: 9px 0 0; line-height: 1.85; white-space: pre-wrap; }
.content-section { margin-top: 26px; break-inside: avoid-page; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 7px; padding-bottom: 10px; border-bottom: 1px solid #dce8f5; }
h2 { margin: 0; color: #184995; font-size: 18px; line-height: 1.4; }
.count { padding: 2px 8px; border-radius: 999px; background: #e9f2ff; color: #3165ad; font-size: 12px; font-weight: 700; }
ol { margin: 0; padding: 0; list-style: none; }
li { display: flex; align-items: flex-start; gap: 14px; padding: 13px 2px; border-bottom: 1px solid #edf2f8; break-inside: avoid; }
li:last-child { border-bottom: 0; }
.item-index { flex: 0 0 30px; padding-top: 2px; color: #3276db; font-size: 12px; font-weight: 800; font-variant-numeric: tabular-nums; }
.item-body { min-width: 0; flex: 1; line-height: 1.75; overflow-wrap: anywhere; }
.item-text { white-space: pre-wrap; }
.item-meta { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 8px; }
.chip { padding: 3px 9px; border-radius: 6px; background: #e9f3ff; color: #2459a5; font-size: 12px; line-height: 1.5; }
.chip-date { background: #edf8fb; color: #15718c; }
.fallback { white-space: pre-wrap; line-height: 1.8; }
@media (max-width: 640px) { body { padding: 0; } .page { border: 0; border-radius: 0; box-shadow: none; } header { padding: 32px 24px 26px; } main { padding: 26px 24px 42px; } }
@media print { :root { background: #fff; } body { padding: 0; } .page { max-width: none; border: 0; border-radius: 0; box-shadow: none; } header { print-color-adjust: exact; -webkit-print-color-adjust: exact; } .summary, .chip, .count { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
</style>
</head>
<body><article class="page"><header><div class="eyebrow">${escapeHtml(t("settings.meeting.minutes"))}</div><h1>${escapeHtml(title)}</h1><p class="date">${escapeHtml(date)}</p></header><main>${summaryHtml}${sectionHtml}${extrasHtml}${fallback}</main></article></body>
</html>`;
}
