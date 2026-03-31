/**
 * Express server for nyc-civic-bot.
 * Receives MMP webhooks, handles DMs and group mentions,
 * exposes API endpoints for group info and manual joins.
 */

import express from "express";
import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient } from "./mcp-client.js";
import { onboardUser, isOnboarded } from "./onboard.js";
import {
  getUserDistrict,
  getDistrictGroup,
  getGroupsByTier,
} from "./db.js";

// --- Environment ---

const PORT = parseInt(process.env.PORT || "3002", 10);
const MMP_URL = process.env.MMP_URL || "https://mmp.chat/mcp";
const CIVIC_URL = process.env.CIVIC_URL || "http://localhost:3001/mcp";
const MMP_BOT_TOKEN = process.env.MMP_BOT_TOKEN || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// --- MCP clients ---

const mmpClient = new McpClient(MMP_URL);
const civicClient = new McpClient(CIVIC_URL);

// --- Express app ---

const app = express();
app.use(express.json());

// Serve landing page
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "..", "public")));

// --- Health endpoint ---

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "nyc-civic-bot", timestamp: new Date().toISOString() });
});

// --- Webhook signature verification ---

function verifyWebhook(body: string, signature: string | undefined): boolean {
  if (!WEBHOOK_SECRET) return true; // skip if not configured
  if (!signature) return false;
  const expected = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  return signature === expected;
}

// --- MMP Webhook handler ---

interface MmpWebhookPayload {
  event: string;
  thread_id?: string;
  message?: {
    id: string;
    from: string;
    from_handle: string;
    body: string;
    thread_id?: string;
    is_group?: boolean;
    mentions?: string[];
  };
}

app.post("/webhook/mmp", async (req, res) => {
  const rawBody = JSON.stringify(req.body);

  if (!verifyWebhook(rawBody, (req.headers["x-mmp-signature"] ?? req.headers["x-webhook-signature"]) as string | undefined)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const payload = req.body as MmpWebhookPayload;

  try {
    if (payload.event === "message" && payload.message) {
      const msg = payload.message;

      if (msg.is_group) {
        await handleGroupMessage(msg);
      } else {
        await handleDM(msg);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// --- DM handler (onboarding + commands) ---

async function handleDM(msg: MmpWebhookPayload["message"] & {}): Promise<void> {
  const body = msg.body.trim().toLowerCase();
  const fromId = msg.from;
  const fromHandle = msg.from_handle;

  // Join / onboard flow
  if (body.startsWith("join ") || body.startsWith("address ")) {
    const address = msg.body.trim().replace(/^(join|address)\s+/i, "");
    const result = await onboardUser(mmpClient, civicClient, fromId, fromHandle, address);
    await sendDM(fromHandle, result);
    return;
  }

  // "my reps" command
  if (body === "my reps" || body === "reps") {
    const user = getUserDistrict(fromId);
    if (!user) {
      await sendDM(fromHandle, `You haven't joined yet. Send me your NYC address to get started.\nExample: join 350 5th Ave, New York, NY`);
      return;
    }
    try {
      const reps = await civicClient.call<Record<string, unknown>>("get_reps", { address: user.address });
      await sendDM(fromHandle, `Your elected representatives:\n${formatReps(reps)}`);
    } catch (err) {
      await sendDM(fromHandle, `Error looking up reps: ${(err as Error).message}`);
    }
    return;
  }

  // "my districts" command
  if (body === "my districts" || body === "districts" || body === "status") {
    const user = getUserDistrict(fromId);
    if (!user) {
      await sendDM(fromHandle, `You haven't joined yet. Send me your NYC address to get started.\nExample: join 350 5th Ave, New York, NY`);
      return;
    }
    const lines = [
      `Address: ${user.address}`,
      user.council_district ? `City Council: District ${user.council_district}` : null,
      user.assembly_district ? `State Assembly: District ${user.assembly_district}` : null,
      user.borough ? `Borough: ${user.borough}` : null,
    ].filter(Boolean);
    await sendDM(fromHandle, lines.join("\n"));
    return;
  }

  // Help / default
  await sendDM(
    fromHandle,
    `NYC Civic Bot — Commands:\n` +
    `  join <address> — Join district groups for your address\n` +
    `  my reps — See your elected representatives\n` +
    `  my districts — See your district info\n` +
    `  help — Show this message\n\n` +
    `Send your NYC street address to get started!`,
  );
}

// --- Group message handler ---

async function handleGroupMessage(msg: MmpWebhookPayload["message"] & {}): Promise<void> {
  const body = msg.body.trim().toLowerCase();
  const threadId = msg.thread_id;
  if (!threadId) return;

  // Respond to "my reps" in group
  if (body === "my reps" || body === "reps") {
    const user = getUserDistrict(msg.from);
    if (!user) {
      await sendGroup(threadId, `@${msg.from_handle} — I don't have your address on file. DM me with: join <your NYC address>`);
      return;
    }
    try {
      const reps = await civicClient.call<Record<string, unknown>>("get_reps", { address: user.address });
      await sendGroup(threadId, `@${msg.from_handle}'s representatives:\n${formatReps(reps)}`);
    } catch (err) {
      await sendGroup(threadId, `Error looking up reps: ${(err as Error).message}`);
    }
    return;
  }

  // Respond to "help" in group
  if (body === "help") {
    await sendGroup(
      threadId,
      `NYC Civic Bot — Group Commands:\n` +
      `  my reps — See your elected representatives\n` +
      `  help — Show this message\n\n` +
      `DM me with "join <address>" to update your info.`,
    );
  }
}

// --- Send helpers ---

async function sendDM(handle: string, body: string): Promise<void> {
  try {
    await mmpClient.callTool("mmp-send", { to: `@${handle}`, body });
  } catch (err) {
    console.error(`Failed to send DM to ${handle}:`, err);
  }
}

async function sendGroup(threadId: string, body: string): Promise<void> {
  try {
    await mmpClient.callTool("mmp-send", { thread_id: threadId, body });
  } catch (err) {
    console.error(`Failed to send to group ${threadId}:`, err);
  }
}

// --- Format helpers ---

function formatReps(reps: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, val] of Object.entries(reps)) {
    if (val && typeof val === "object" && "name" in (val as Record<string, unknown>)) {
      const rep = val as Record<string, unknown>;
      lines.push(`  ${key}: ${rep.name}${rep.party ? ` (${rep.party})` : ""}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "  (no representatives found)";
}

// --- API endpoints ---

/** Get info about a district group */
app.get("/api/group/:key", (req, res) => {
  const group = getDistrictGroup(req.params.key);
  if (!group) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  res.json(group);
});

/** List all groups for a given tier */
app.get("/api/groups", (req, res) => {
  const tier = req.query.tier as string | undefined;
  if (!tier) {
    res.status(400).json({ error: "tier query parameter required" });
    return;
  }
  const groups = getGroupsByTier(tier);
  res.json(groups);
});

/** Manual join endpoint */
app.post("/api/join", async (req, res) => {
  const { mmp_user_id, mmp_handle, address } = req.body as {
    mmp_user_id?: string;
    mmp_handle?: string;
    address?: string;
  };

  if (!mmp_user_id || !mmp_handle || !address) {
    res.status(400).json({ error: "mmp_user_id, mmp_handle, and address are required" });
    return;
  }

  try {
    const result = await onboardUser(mmpClient, civicClient, mmp_user_id, mmp_handle, address);
    res.json({ ok: true, message: result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Export for broadcast module ---

export { mmpClient, civicClient, app, sendGroup };

// --- Cron scheduling ---

import cron from "node-cron";
import {
  broadcast311Digest,
  broadcastAttendance,
  broadcastNewLegislation,
} from "./broadcasts.js";

// 311 digest: every Monday at 9am ET
cron.schedule("0 9 * * 1", () => {
  console.log("Running 311 digest broadcast...");
  broadcast311Digest(mmpClient, civicClient).catch(console.error);
}, { timezone: "America/New_York" });

// Attendance: every Wednesday at 10am ET
cron.schedule("0 10 * * 3", () => {
  console.log("Running attendance broadcast...");
  broadcastAttendance(mmpClient, civicClient).catch(console.error);
}, { timezone: "America/New_York" });

// New legislation: every Friday at 9am ET
cron.schedule("0 9 * * 5", () => {
  console.log("Running legislation broadcast...");
  broadcastNewLegislation(mmpClient, civicClient).catch(console.error);
}, { timezone: "America/New_York" });

// --- Start server ---

app.listen(PORT, () => {
  console.log(`nyc-civic-bot listening on :${PORT}`);
});
