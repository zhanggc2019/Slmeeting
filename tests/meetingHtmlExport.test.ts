import { describe, expect, test } from "bun:test";
import type { MeetingMinutes } from "@/bindings";
import { createMeetingHtmlDocument } from "../src/components/settings/meeting/meetingHtmlExport";

/** Create a representative meeting record for document export checks. */
function sampleMinutes(content: Record<string, unknown>): MeetingMinutes {
  return {
    id: 1,
    meeting_id: "meeting-1",
    template_id: "standard",
    provider_id: "deepseek",
    model: "deepseek-flash",
    content_json: JSON.stringify(content),
    content_markdown: "",
    created_at: Date.UTC(2026, 9, 9),
  };
}

describe("meeting HTML export", () => {
  test("renders actions with owner and deadline in a printable document", () => {
    const html = createMeetingHtmlDocument(
      sampleMinutes({
        title: "项目例会",
        summary: "确认下周发布。",
        action_items: [
          { task: "完成验收", owner: "张三", due_date: "10月12日" },
        ],
      }),
      (key) => key.split(".").slice(-1)[0] ?? key,
      "zh-CN",
    );
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("@media print");
    expect(html).toContain("完成验收");
    expect(html).toContain("张三");
    expect(html).toContain("10月12日");
  });

  test("escapes untrusted meeting content instead of executing HTML", () => {
    const html = createMeetingHtmlDocument(
      sampleMinutes({
        title: '<script>alert("x")</script>',
        action_items: [{ task: "<img src=x onerror=alert(1)>" }],
      }),
      (key) => key,
      "zh-CN",
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
