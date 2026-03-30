/**
 * Lightweight MCP client for calling tools on remote MCP servers.
 * Maintains a session via StreamableHTTP (initialize once, reuse).
 */

const TIMEOUT = 30_000;

interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export class McpClient {
  private baseUrl: string;
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        params: params ?? {},
        id: this.nextId++,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    // Capture session ID from response headers
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (!res.ok) {
      throw new Error(`MCP ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    if (data.error) {
      throw new Error(`MCP error: ${data.error.message}`);
    }
    return data.result;
  }

  async connect(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "nyc-civic-bot", version: "1.0.0" },
    });
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    if (!this.sessionId) await this.connect();
    const result = (await this.request("tools/call", { name, arguments: args })) as McpToolResult;
    return result;
  }

  /** Call a tool and parse the JSON text response */
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.callTool(name, args);
    if (result.isError) {
      const msg = result.content?.[0]?.text ?? "Tool error";
      throw new Error(msg);
    }
    const text = result.content?.[0]?.text ?? "{}";
    return JSON.parse(text) as T;
  }
}
