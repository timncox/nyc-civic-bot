# @nyc_civic Bot

MMP bot that creates district-scoped group chats for NYC residents and broadcasts civic updates.

**Landing page**: [nyc-civic-bot-production.up.railway.app](https://nyc-civic-bot-production.up.railway.app)

## How it works

1. DM `@nyc_civic` on [MMP](https://mmp.chat) with an NYC address
2. Bot resolves your districts via the [nyc-civic MCP server](https://nyc.mmp.chat)
3. Creates/joins council, assembly, and borough group chats
4. Broadcasts civic updates on a schedule

## Commands

| Command | Context | Description |
|---------|---------|-------------|
| `join <address>` | DM | Join district groups for your address |
| `my reps` | DM/Group | See your elected representatives |
| `my districts` | DM | Show your district assignments |
| `help` | DM/Group | Show available commands |

## Broadcasts

| Broadcast | Schedule | Target |
|-----------|----------|--------|
| 311 Digest | Monday 9am ET | Assembly groups |
| Attendance | Wednesday 10am ET | Council groups |
| Legislation | Friday 9am ET | Council groups |

## Architecture

```
src/
  server.ts      → Express server, webhook handler, inbox polling, cron
  mcp-client.ts  → Lightweight StreamableHTTP MCP client
  db.ts          → SQLite (user_districts, district_groups, broadcast_log)
  onboard.ts     → Address resolution + group creation logic
  broadcasts.ts  → 311 digest, attendance, legislation broadcast functions
public/
  index.html     → Landing page with API docs
```

## Setup

```bash
npm install
cp .env.example .env
# Fill in MMP_BOT_TOKEN and other values
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `MMP_URL` | MMP MCP endpoint (include token in URL) |
| `MMP_BOT_TOKEN` | Bot's MMP authentication token |
| `CIVIC_URL` | nyc-civic MCP server URL |
| `WEBHOOK_SECRET` | MMP webhook signature secret |
| `PORT` | Server port (default 3002) |
| `POLL_INTERVAL` | Inbox polling interval in ms (default 30000) |

## Running

```bash
# Development
npm run serve

# Production
npm run build
npm start
```

## Deployment

Deployed on Railway. Dockerfile included for container builds.

```bash
railway up
```
