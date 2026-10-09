import assert from "node:assert/strict";
import { formatMeetingTime } from "./meetingTime";

/** Verify transcript offsets display as elapsed minutes and seconds. */
function verifyMeetingTimeFormatting(): void {
  assert.equal(formatMeetingTime(0), "00:00");
  assert.equal(formatMeetingTime(30_000), "00:30");
  assert.equal(formatMeetingTime(60_000), "01:00");
  assert.equal(formatMeetingTime(3_723_000), "62:03");
}

verifyMeetingTimeFormatting();
