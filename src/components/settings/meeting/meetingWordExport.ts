import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import type { MeetingMinutes } from "@/bindings";

type MinutesObject = Record<string, unknown>;
type Translate = (key: string) => string;

const sectionKeys = [
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

/** Read an LLM value as plain text without leaking raw JSON into Word. */
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

/** Format structured actions with their owner and deadline kept beside the task. */
function itemText(value: unknown, key: string, t: Translate): string {
  if (
    key !== "action_items" ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return readableText(value);
  }
  const action = value as MinutesObject;
  const task = readableText(
    action.task ?? action.action ?? action.content ?? action.description,
  );
  const owner = readableText(
    action.owner ?? action.assignee ?? action.responsible,
  );
  const due = readableText(action.due_date ?? action.deadline);
  const metadata = [
    owner && `${t("settings.meeting.minutesView.owner")}：${owner}`,
    due && `${t("settings.meeting.minutesView.due")}：${due}`,
  ].filter(Boolean);
  return [
    task || readableText(value),
    metadata.length ? `（${metadata.join("；")}）` : "",
  ].join("");
}

/** Build a compact editable Word document from saved structured minutes. */
export async function createMeetingWordDocument(
  minutes: MeetingMinutes,
  t: Translate,
  language: string,
): Promise<Uint8Array> {
  let data: MinutesObject = {};
  try {
    const parsed: unknown = JSON.parse(minutes.content_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as MinutesObject;
    }
  } catch {
    // Saved legacy minutes still export as plain text below.
  }

  const title = readableText(data.title) || t("settings.meeting.minutes");
  const children: Paragraph[] = [
    new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE,
      spacing: { after: 130 },
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: new Intl.DateTimeFormat(language, { dateStyle: "long" }).format(
            minutes.created_at,
          ),
          color: "64748B",
          size: 19,
        }),
      ],
      spacing: { after: 190 },
    }),
  ];

  const summary = readableText(data.executive_summary ?? data.summary);
  if (summary) {
    children.push(
      new Paragraph({
        text: t("settings.meeting.minutesView.overview"),
        heading: HeadingLevel.HEADING_1,
      }),
      new Paragraph({
        text: summary,
        spacing: { after: 110 },
        keepLines: true,
      }),
    );
  }

  for (const key of sectionKeys) {
    const raw = data[key];
    const entries = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    const lines = entries
      .map((entry) => itemText(entry, key, t))
      .filter(Boolean);
    if (!lines.length) continue;
    children.push(
      new Paragraph({
        text: t(`settings.meeting.minutesView.${key}`),
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 190, after: 65 },
      }),
    );
    if (key === "attendees") {
      children.push(
        new Paragraph({ text: lines.join("、"), spacing: { after: 75 } }),
      );
      continue;
    }
    lines.forEach((line, index) => {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `${index + 1}.  `,
              bold: true,
              color: "2563EB",
            }),
            new TextRun({ text: line }),
          ],
          indent: { left: 220, hanging: 220 },
          spacing: { after: 75 },
          keepLines: true,
        }),
      );
    });
  }

  const knownKeys = new Set<string>([
    "title",
    "executive_summary",
    "summary",
    ...sectionKeys,
  ]);
  const extras = Object.entries(data)
    .filter(([key, value]) => !knownKeys.has(key) && readableText(value))
    .map(([key, value]) => `${key}：${readableText(value)}`);
  if (extras.length) {
    children.push(
      new Paragraph({
        text: t("settings.meeting.minutesView.other"),
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 190, after: 65 },
      }),
      ...extras.map(
        (entry) => new Paragraph({ text: entry, spacing: { after: 75 } }),
      ),
    );
  }

  if (children.length === 2) {
    children.push(
      new Paragraph({ text: minutes.content_markdown, spacing: { after: 80 } }),
    );
  }

  const document = new Document({
    styles: {
      default: {
        document: {
          run: { font: "Microsoft YaHei", size: 21, color: "263247" },
          paragraph: { spacing: { line: 330 } },
        },
      },
      paragraphStyles: [
        {
          id: "Title",
          name: "Title",
          basedOn: "Normal",
          next: "Normal",
          run: {
            font: "Microsoft YaHei",
            size: 35,
            bold: true,
            color: "182338",
          },
        },
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          run: {
            font: "Microsoft YaHei",
            size: 24,
            bold: true,
            color: "1D4ED8",
          },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 950, bottom: 850, left: 1000, right: 1000 } },
        },
        children: [
          ...children,
          new Paragraph({ text: "", alignment: AlignmentType.CENTER }),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toArrayBuffer(document));
}
