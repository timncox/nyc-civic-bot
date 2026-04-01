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
  content_type?: string;
  call_id?: string;
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
    // Handle structured tool_call messages (Agent Protocol)
    if (payload.content_type === "tool_call" && payload.message) {
      const msg = payload.message;
      try {
        const { tool, call_id, input } = JSON.parse(msg.body);
        await handleToolCall(msg.from_handle, msg.from, call_id, tool, input || {});
      } catch (err) {
        console.error("Tool call error:", err);
        if (payload.call_id) {
          await mmpClient.callTool("mmp-send", {
            to: `@${msg.from_handle}`,
            body: JSON.stringify({ call_id: payload.call_id, output: null, error: (err as Error).message }),
            content_type: "tool_result",
            call_id: payload.call_id,
          }).catch(() => {});
        }
      }
      res.json({ ok: true });
      return;
    }

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

// --- Structured tool_call handler (Agent Protocol) ---

async function handleToolCall(
  fromHandle: string,
  fromId: string,
  callId: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<void> {
  let output: Record<string, unknown> = {};
  let error: string | null = null;

  try {
    switch (toolName) {
      case "join": {
        const address = input.address as string;
        if (!address) { error = "Missing required field: address"; break; }
        const result = await onboardUser(mmpClient, civicClient, fromId, fromHandle, address);
        output = { message: result };
        break;
      }
      case "my_reps": {
        const user = getUserDistrict(fromId);
        if (!user) { error = "Not registered. Use 'join' with an NYC address first."; break; }
        const reps = await civicClient.call<Record<string, unknown>>("get_reps", { address: user.address });
        output = reps;
        break;
      }
      case "my_districts": {
        const user = getUserDistrict(fromId);
        if (!user) { error = "Not registered. Use 'join' with an NYC address first."; break; }
        output = {
          address: user.address,
          council_district: user.council_district,
          assembly_district: user.assembly_district,
          borough: user.borough,
        };
        break;
      }
      case "get_reps": {
        const address = input.address as string;
        if (!address) { error = "Missing required field: address"; break; }
        const reps = await civicClient.call<Record<string, unknown>>("get_reps", { address });
        output = reps;
        break;
      }
      case "search_legislation": {
        const query = input.query as string;
        if (!query) { error = "Missing required field: query"; break; }
        const results = await civicClient.call<Record<string, unknown>>("search_legislation", { query });
        output = results;
        break;
      }
      case "get_votes": {
        const member = input.member as string;
        if (!member) { error = "Missing required field: member"; break; }
        const votes = await civicClient.call<Record<string, unknown>>("get_votes", { member });
        output = votes;
        break;
      }
      default:
        error = `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    error = (err as Error).message;
  }

  // Send tool_result back
  await mmpClient.callTool("mmp-send", {
    to: `@${fromHandle}`,
    body: JSON.stringify({ call_id: callId, output, error }),
    content_type: "tool_result",
    call_id: callId,
  });
}

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

// --- Inbox polling fallback (MMP webhooks may not deliver reliably) ---

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "30000", 10); // 30s default
let lastSeenMessageId: string | null = null;

async function pollInbox(): Promise<void> {
  try {
    const inbox = await mmpClient.call<{
      messages: Array<{
        id: string;
        thread_id: string;
        thread_type?: string;
        from_handle: string;
        to_handle?: string;
        body: string;
        content_type?: string;
        call_id?: string;
      }>;
    }>("mmp-inbox", {});

    for (const msg of inbox.messages || []) {
      if (msg.from_handle === "nyc_civic") continue; // skip own messages
      if (msg.id === lastSeenMessageId) break; // already seen — inbox is sorted newest first

      if (!lastSeenMessageId) {
        // First poll — just record the latest, don't process old messages
        lastSeenMessageId = msg.id;
        console.log(`[poll] Initial sync — latest message from @${msg.from_handle}`);
        break;
      }

      lastSeenMessageId = msg.id;
      console.log(`[poll] New message from @${msg.from_handle}: ${msg.body.slice(0, 80)}`);

      // Handle tool_call messages from polling
      if (msg.content_type === "tool_call") {
        try {
          const { tool, call_id, input } = JSON.parse(msg.body);
          await handleToolCall(msg.from_handle, `user:${msg.from_handle}`, call_id, tool, input || {});
        } catch (err) {
          console.error("[poll] Tool call error:", err);
        }
        continue;
      }

      const isDM = msg.thread_type === "dm" || !msg.thread_type;
      if (isDM) {
        await handleDM({
          id: msg.id,
          from: `user:${msg.from_handle}`,
          from_handle: msg.from_handle,
          body: msg.body,
          is_group: false,
          thread_id: msg.thread_id,
        });
      } else {
        await handleGroupMessage({
          id: msg.id,
          from: `user:${msg.from_handle}`,
          from_handle: msg.from_handle,
          body: msg.body,
          is_group: true,
          thread_id: msg.thread_id,
        });
      }
    }
  } catch (err) {
    console.error("[poll] Error:", (err as Error).message);
  }
}

// --- Start server ---

app.listen(PORT, () => {
  console.log(`nyc-civic-bot listening on :${PORT}`);
  console.log(`Polling inbox every ${POLL_INTERVAL / 1000}s`);
  setInterval(pollInbox, POLL_INTERVAL);
  // Initial poll after 5s
  setTimeout(pollInbox, 5000);

  // Advertise agent protocol capabilities
  (async () => {
    try {
      await mmpClient.callTool("mmp-set_profile", {
        type: "bot",
        capabilities: JSON.stringify([
          { name: "join", description: "Join NYC district group chats by providing a street address", input_schema: { address: { type: "string", required: true, description: "NYC street address e.g. '350 5th Ave, New York, NY'" } } },
          { name: "my_reps", description: "Get the elected representatives for a registered user" },
          { name: "my_districts", description: "Get a user's district info (council, assembly, borough)" },
          { name: "get_reps", description: "Look up elected representatives for any NYC address", input_schema: { address: { type: "string", required: true } } },
          { name: "search_legislation", description: "Search NYC Council legislation by keyword", input_schema: { query: { type: "string", required: true } } },
          { name: "get_votes", description: "Get voting records for a council member", input_schema: { member: { type: "string", required: true } } },
        ]),
      });
      console.log("Agent protocol capabilities advertised");
    } catch (err) {
      console.error("Failed to set bot profile:", err);
    }
  })();
});
