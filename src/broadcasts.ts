/**
 * Broadcast functions for civic updates to district groups.
 * Each function fetches data from the nyc-civic MCP server
 * and sends digests to the relevant MMP group chats.
 */

import { createHash } from "node:crypto";
import { McpClient } from "./mcp-client.js";
import {
  getGroupsByTier,
  hasBroadcast,
  logBroadcast,
  type DistrictGroup,
} from "./db.js";

// --- Helpers ---

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function sendToGroup(mmpClient: McpClient, threadId: string, body: string): Promise<void> {
  try {
    await mmpClient.callTool("mmp-send", { thread_id: threadId, body });
  } catch (err) {
    console.error(`Broadcast send failed for thread ${threadId}:`, err);
  }
}

// --- 311 Digest ---

interface ThreeOneOneItem {
  complaint_type: string;
  count: number;
  descriptor?: string;
}

/**
 * Broadcast 311 complaint digests to council district groups.
 * Fetches recent 311 data from the civic server and sends a summary.
 */
export async function broadcast311Digest(
  mmpClient: McpClient,
  civicClient: McpClient,
): Promise<void> {
  const groups = getGroupsByTier("council");
  if (groups.length === 0) return;

  console.log(`Broadcasting 311 digest to ${groups.length} council groups...`);

  for (const group of groups) {
    if (!group.district_number) continue;

    try {
      const data = await civicClient.call<{ complaints?: ThreeOneOneItem[] }>(
        "get_community_board",
        { district: group.district_number },
      );

      if (!data.complaints || data.complaints.length === 0) continue;

      const top5 = data.complaints.slice(0, 5);
      const lines = top5.map(
        (c, i) => `  ${i + 1}. ${c.complaint_type}: ${c.count} complaints`,
      );
      const body =
        `📋 311 Digest — Council District ${group.district_number}\n` +
        `Top complaints this week:\n${lines.join("\n")}`;

      const hash = contentHash(body);
      if (hasBroadcast(group.district_key, hash)) continue;

      await sendToGroup(mmpClient, group.mmp_thread_id, body);
      logBroadcast(group.district_key, "311-digest", hash);
    } catch (err) {
      console.error(`311 digest failed for district ${group.district_number}:`, err);
    }
  }
}

// --- Attendance ---

interface AttendanceRecord {
  name: string;
  present: number;
  absent: number;
  rate: string;
}

/**
 * Broadcast council member attendance updates to district groups.
 */
export async function broadcastAttendance(
  mmpClient: McpClient,
  civicClient: McpClient,
): Promise<void> {
  const groups = getGroupsByTier("council");
  if (groups.length === 0) return;

  console.log(`Broadcasting attendance to ${groups.length} council groups...`);

  for (const group of groups) {
    if (!group.district_number) continue;

    try {
      const data = await civicClient.call<{ member?: AttendanceRecord }>(
        "get_attendance",
        { district: group.district_number },
      );

      if (!data.member) continue;

      const m = data.member;
      const body =
        `🏛️ Attendance Update — Council District ${group.district_number}\n` +
        `${m.name}: ${m.rate} attendance (${m.present} present, ${m.absent} absent)`;

      const hash = contentHash(body);
      if (hasBroadcast(group.district_key, hash)) continue;

      await sendToGroup(mmpClient, group.mmp_thread_id, body);
      logBroadcast(group.district_key, "attendance", hash);
    } catch (err) {
      console.error(`Attendance broadcast failed for district ${group.district_number}:`, err);
    }
  }
}

// --- New Legislation ---

interface LegislationItem {
  id: string;
  title: string;
  status: string;
  sponsor?: string;
  intro_date?: string;
}

/**
 * Broadcast new legislation to all council district groups.
 */
export async function broadcastNewLegislation(
  mmpClient: McpClient,
  civicClient: McpClient,
): Promise<void> {
  const groups = getGroupsByTier("council");
  if (groups.length === 0) return;

  console.log(`Broadcasting legislation updates to ${groups.length} council groups...`);

  try {
    const data = await civicClient.call<{ bills?: LegislationItem[] }>(
      "search_legislation",
      { query: "recent", limit: 5 },
    );

    if (!data.bills || data.bills.length === 0) return;

    const lines = data.bills.map(
      (b) => `  • ${b.id}: ${b.title}${b.sponsor ? ` (by ${b.sponsor})` : ""}`,
    );
    const body =
      `📜 New Legislation\n` +
      `Recent bills introduced in the NYC Council:\n${lines.join("\n")}`;

    const hash = contentHash(body);

    // Send to all council groups (dedup per group)
    for (const group of groups) {
      if (hasBroadcast(group.district_key, hash)) continue;
      await sendToGroup(mmpClient, group.mmp_thread_id, body);
      logBroadcast(group.district_key, "legislation", hash);
    }
  } catch (err) {
    console.error("Legislation broadcast failed:", err);
  }
}
