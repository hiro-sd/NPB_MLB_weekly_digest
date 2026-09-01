import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

import { pushDigestToLine } from "../../../../lib/line";

export const runtime = "nodejs";

const baseHandler = createMcpHandler((server) => {
  server.registerTool(
    "send_weekly_digest",
    {
      title: "Send weekly baseball digest to LINE",
      description:
        "Send the completed Japanese-language NPB and MLB weekly digest to the single LINE group configured by the server owner. Use only after the digest has been researched and finalized.",
      inputSchema: z.object({
        digestId: z.string().min(1).max(100).describe("Stable identifier for this edition, such as 2026-W36."),
        text: z.string().min(1).max(25_000).describe("The complete Japanese weekly digest text, without source links."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ digestId, text }) => {
      const groupId = process.env.LINE_GROUP_ID;
      const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
      if (!groupId || !channelAccessToken) {
        throw new Error("LINE_GROUP_ID or LINE_CHANNEL_ACCESS_TOKEN is not configured.");
      }

      const result = await pushDigestToLine({ digestId, text, groupId, channelAccessToken });
      const summary = result.status === "already_sent"
        ? "This digest was already accepted by LINE; no duplicate was sent."
        : `Sent ${result.messageCount} LINE message(s) to the configured group.`;

      return {
        content: [{ type: "text", text: summary }],
        structuredContent: result,
      };
    },
  );
});

function authorized(request: Request): boolean {
  const configured = process.env.MCP_CAPABILITY_SECRET;
  if (!configured || configured.length < 32) return false;
  const capability = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);
  if (!capability) return false;

  const actual = new TextEncoder().encode(capability);
  const expected = new TextEncoder().encode(configured);
  if (actual.length !== expected.length) return false;

  let mismatch = 0;
  for (let index = 0; index < actual.length; index += 1) mismatch |= actual[index] ^ expected[index];
  return mismatch === 0;
}

async function handler(request: Request): Promise<Response> {
  if (!authorized(request)) return new Response("Not found", { status: 404 });
  return baseHandler(request);
}

export { handler as GET, handler as POST };
