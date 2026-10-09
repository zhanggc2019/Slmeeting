import type { CSSProperties } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  CircleHelp,
  ClipboardList,
  FileText,
  Lightbulb,
  MessageSquareText,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import type { MeetingMinutes } from "@/bindings";

type MinutesData = Record<string, unknown>;
type SectionTone = "rose" | "blue" | "amber" | "neutral";

// Blend the brand accent with theme text so small labels remain legible in both themes.
const brandLabelColor =
  "color-mix(in srgb, var(--color-text) 45%, var(--color-background-ui))";

const sectionAccents: Record<SectionTone, string> = {
  rose: "#be185d",
  blue: "#0284c7",
  amber: "#d97706",
  neutral: "#808080",
};

/** Mix an accent with the active theme so section chips stay readable. */
function accentSurface(accent: string): CSSProperties {
  return {
    backgroundColor: `color-mix(in srgb, ${accent} 12%, var(--color-background))`,
    color: `color-mix(in srgb, ${accent} 60%, var(--color-text))`,
  };
}

const collectionSections = [
  { key: "decisions", icon: CheckCircle2, tone: "blue" },
  { key: "action_items", icon: ClipboardList, tone: "rose" },
  { key: "key_topics", icon: MessageSquareText, tone: "neutral" },
  { key: "business_impact", icon: Lightbulb, tone: "blue" },
  { key: "risks", icon: AlertTriangle, tone: "amber" },
  { key: "blockers", icon: AlertTriangle, tone: "amber" },
  { key: "open_questions", icon: CircleHelp, tone: "neutral" },
  { key: "requests_for_decision", icon: CircleHelp, tone: "blue" },
  { key: "next_steps", icon: ClipboardList, tone: "rose" },
  { key: "follow_up", icon: ClipboardList, tone: "rose" },
] as const;

/** Accept only JSON objects as structured meeting minutes. */
function parseMinutes(json: string): MinutesData | null {
  try {
    const value: unknown = JSON.parse(json);
    return asObject(value);
  } catch {
    return null;
  }
}

/** Narrow an unknown JSON value to a non-array object. */
function asObject(value: unknown): MinutesData | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as MinutesData)
    : null;
}

/** Render nested LLM values as human-readable text without raw JSON. */
function minutesText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "✓" : null;
  if (Array.isArray(value)) {
    const parts = value
      .map(minutesText)
      .filter((part): part is string => !!part);
    return parts.length ? parts.join("；") : null;
  }
  const object = asObject(value);
  if (!object) return null;
  const parts = Object.values(object)
    .map(minutesText)
    .filter((part): part is string => !!part);
  return parts.length ? parts.join(" · ") : null;
}

/** Normalize a section value into displayable entries. */
function sectionItems(value: unknown): unknown[] {
  const source = Array.isArray(value) ? value : [value];
  return source.filter((item) => minutesText(item) !== null);
}

/** Read the first usable text field from a structured action item. */
function actionField(item: MinutesData, keys: string[]): string | null {
  for (const key of keys) {
    const value = minutesText(item[key]);
    if (value) return value;
  }
  return null;
}

/** Show a readable fallback for saved minutes with an unexpected JSON shape. */
function MinutesMarkdownFallback({ markdown }: { markdown: string }) {
  return (
    <div className="space-y-2 text-sm leading-6 text-text/85">
      <ReactMarkdown
        skipHtml
        components={{
          h1: ({ children }) => (
            <h2 className="text-xl font-semibold text-text">{children}</h2>
          ),
          h2: ({ children }) => (
            <h3 className="mt-4 border-s-2 border-logo-primary ps-2 text-base font-semibold text-text">
              {children}
            </h3>
          ),
          p: ({ children }) => <p className="leading-6">{children}</p>,
          ul: ({ children }) => <ul className="space-y-1">{children}</ul>,
          li: ({ children }) => (
            <li className="border-b border-mid-gray/10 py-1 last:border-b-0">
              {children}
            </li>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

/** Display structured minutes as a scannable document with distinct section accents. */
export function MeetingMinutesView({ minutes }: { minutes: MeetingMinutes }) {
  const { t, i18n } = useTranslation();
  const data = parseMinutes(minutes.content_json);
  const title = data ? minutesText(data.title) : null;
  const summary = data
    ? (minutesText(data.executive_summary) ?? minutesText(data.summary))
    : null;
  const attendees = data ? sectionItems(data.attendees) : [];
  const knownKeys = new Set([
    "title",
    "executive_summary",
    "summary",
    "attendees",
    ...collectionSections.map((section) => section.key),
  ]);
  const extra = data
    ? Object.entries(data).filter(
        ([key, value]) => !knownKeys.has(key) && sectionItems(value).length > 0,
      )
    : [];

  return (
    <article className="overflow-hidden rounded-2xl border border-mid-gray/20 bg-background shadow-[0_12px_36px_-24px_rgba(20,30,50,0.45)]">
      <header className="relative overflow-hidden border-b border-mid-gray/15 bg-gradient-to-r from-logo-primary/10 via-logo-primary/5 to-transparent px-5 py-4 sm:px-6">
        <div className="absolute inset-y-0 start-0 w-1.5 bg-logo-primary" />
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-medium text-text/60">
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-logo-primary/15 px-3 py-1"
            style={{ color: brandLabelColor }}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t("settings.meeting.minutes")}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-background/65 px-3 py-1">
            <CalendarDays className="h-3.5 w-3.5" />
            {new Intl.DateTimeFormat(i18n.language, {
              year: "numeric",
              month: "short",
              day: "numeric",
            }).format(minutes.created_at)}
          </span>
        </div>
        <h2 className="max-w-3xl text-lg font-bold leading-snug tracking-tight text-text sm:text-xl">
          {title ?? t("settings.meeting.minutes")}
        </h2>
      </header>

      <div className="space-y-4 p-4 sm:px-6 sm:py-5">
        {summary && (
          <section className="rounded-lg border-s-[3px] border-logo-primary bg-logo-primary/5 px-3 py-2.5">
            <div className="mb-1.5 flex items-center gap-2">
              <span
                className="flex h-6 w-6 items-center justify-center rounded-md bg-logo-primary/10"
                style={{ color: brandLabelColor }}
              >
                <FileText className="h-4 w-4" />
              </span>
              <h3 className="text-sm font-semibold text-text">
                {t("settings.meeting.minutesView.overview")}
              </h3>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-6 text-text/85">
              {summary}
            </p>
          </section>
        )}

        {data ? (
          <>
            {collectionSections.map(({ key, icon: Icon, tone }) => {
              const items = sectionItems(data[key]);
              if (items.length === 0) return null;
              const accent = sectionAccents[tone];
              return (
                <section
                  key={key}
                  className="border-t border-mid-gray/15 pt-3"
                  style={{
                    borderColor: `color-mix(in srgb, ${accent} 20%, var(--color-background))`,
                  }}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className="flex h-6 w-6 items-center justify-center rounded-md"
                      style={accentSurface(accent)}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <h3 className="flex-1 text-sm font-semibold text-text">
                      {t(`settings.meeting.minutesView.${key}`)}
                    </h3>
                    <span className="text-xs tabular-nums text-text/45">
                      {items.length}
                    </span>
                  </div>
                  <div className="divide-y divide-mid-gray/10">
                    {items.map((item, index) => {
                      const action =
                        key === "action_items" ? asObject(item) : null;
                      const task = action
                        ? actionField(action, [
                            "task",
                            "action",
                            "content",
                            "description",
                          ])
                        : null;
                      const owner = action
                        ? actionField(action, [
                            "owner",
                            "assignee",
                            "responsible",
                          ])
                        : null;
                      const due = action
                        ? actionField(action, ["due_date", "deadline"])
                        : null;
                      const details = action
                        ? (["priority", "status", "evidence"] as const)
                            .map((field) => ({
                              field,
                              value: minutesText(action[field]),
                            }))
                            .filter(
                              (
                                entry,
                              ): entry is {
                                field: "priority" | "status" | "evidence";
                                value: string;
                              } => entry.value !== null,
                            )
                        : [];
                      return (
                        <div
                          key={`${key}-${index}`}
                          className="flex gap-2.5 py-2 first:pt-0 last:pb-0"
                        >
                          <span
                            className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-bold tabular-nums"
                            style={accentSurface(accent)}
                          >
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="whitespace-pre-wrap text-sm leading-5 text-text/90">
                              {task ?? minutesText(item)}
                            </p>
                            {action && (owner || due || details.length > 0) && (
                              <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                                {owner && (
                                  <span
                                    className="rounded-md px-2 py-0.5"
                                    style={accentSurface(sectionAccents.rose)}
                                  >
                                    {t("settings.meeting.minutesView.owner")}:{" "}
                                    {owner}
                                  </span>
                                )}
                                {due && (
                                  <span
                                    className="rounded-md px-2 py-0.5"
                                    style={accentSurface(sectionAccents.amber)}
                                  >
                                    {t("settings.meeting.minutesView.due")}:{" "}
                                    {due}
                                  </span>
                                )}
                                {details.map(({ field, value }) => (
                                  <span
                                    key={field}
                                    className="rounded-md bg-mid-gray/10 px-2 py-0.5 text-text/65"
                                  >
                                    {t(`settings.meeting.minutesView.${field}`)}
                                    : {value}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}

            {attendees.length > 0 && (
              <section className="border-t border-mid-gray/15 pt-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-mid-gray/10 text-text/70">
                    <UsersRound className="h-4 w-4" />
                  </span>
                  <h3 className="text-sm font-semibold text-text">
                    {t("settings.meeting.minutesView.attendees")}
                  </h3>
                </div>
                <div className="flex flex-wrap gap-2">
                  {attendees.map((person, index) => (
                    <span
                      key={index}
                      className="rounded-full border border-mid-gray/15 bg-mid-gray/5 px-3 py-1 text-xs text-text/80"
                    >
                      {minutesText(person)}
                    </span>
                  ))}
                </div>
              </section>
            )}

            {extra.length > 0 && (
              <section className="border-t border-mid-gray/15 pt-3">
                <h3 className="mb-2 text-sm font-semibold text-text">
                  {t("settings.meeting.minutesView.other")}
                </h3>
                <div className="space-y-2 text-sm leading-6 text-text/80">
                  {extra.map(([key, value]) => (
                    <p key={key}>
                      <span className="font-medium text-text">{key}: </span>
                      {minutesText(value)}
                    </p>
                  ))}
                </div>
              </section>
            )}
          </>
        ) : (
          <MinutesMarkdownFallback markdown={minutes.content_markdown} />
        )}
      </div>
    </article>
  );
}
