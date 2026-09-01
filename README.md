# LINE Weekly Digest

This personal MCP server exposes one write tool, `send_weekly_digest`, which posts a finalized NPB/MLB digest to one server-configured LINE group. The tool cannot choose another recipient and never accepts a LINE token as input.

## Security model

- `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, and `LINE_GROUP_ID` exist only as hosting environment variables.
- The MCP endpoint is protected by a high-entropy capability URL stored as `MCP_CAPABILITY_SECRET` (minimum 32 characters).
- The LINE destination is fixed server-side.
- A deterministic `X-Line-Retry-Key` reduces duplicate posts if the same edition is retried.
- This capability-URL design is appropriate for a single-user personal deployment. Use OAuth instead for shared or multi-user deployments.

## Deploy to Vercel

1. Import this directory into a Git repository (public or private) and connect it to a Vercel project.
2. Generate a secret locally, for example: `openssl rand -hex 32`.
3. In Vercel project settings, add these Production environment variables:
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `LINE_CHANNEL_SECRET`
   - `MCP_CAPABILITY_SECRET`
4. Deploy. Confirm `/api/health` reports the first, second, and fourth settings as `true`.
5. In LINE Developers, set the webhook URL to `https://YOUR-PROJECT.vercel.app/api/line/webhook` and enable webhooks.
6. Invite the LINE Official Account to the target group and send one ordinary message in that group.
7. Read the Vercel runtime log entry named `LINE_GROUP_DISCOVERED`, copy its `groupId`, add it to Vercel as `LINE_GROUP_ID`, and redeploy.
8. Copy `.mcp.example.json` to `.mcp.json`, then replace the placeholder URL in the local `.mcp.json` with `https://YOUR-PROJECT.vercel.app/api/mcp/YOUR-MCP-CAPABILITY-SECRET`. The local `.mcp.json` is ignored by Git.
9. Add that HTTPS MCP URL as a custom ChatGPT app/plugin and test `send_weekly_digest` with a short test message.

Never paste LINE credentials or the capability URL into a normal chat message or commit them to source control.

## Local checks

```sh
npm install
npm test
npm run typecheck
npm run build
```
