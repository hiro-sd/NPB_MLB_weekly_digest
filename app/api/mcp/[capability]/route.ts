import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

import { groupMemberCount, monthlyLineUsage, pushDigestToLine, splitLineMessages } from "../../../../lib/line";
import {
  bindEdition, claimGroup, lineMonth, listGroups, markSent,
  redisStore, releaseGroup, reserveMessages, wasSent,
} from "../../../../lib/store";

export const runtime = "nodejs";
export const maxDuration = 300;

const baseHandler = createMcpHandler((server) => {
  server.registerTool(
    "send_weekly_digest",
    {
      title: "Send weekly baseball digest to registered LINE groups",
      description:
        "Send the completed Japanese-language NPB and MLB weekly digest to all registered LINE groups. Use only after the digest has been researched and finalized. Retry with the same digestId and identical text to send only to groups that still need it.",
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
      const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
      if (!channelAccessToken) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured.");
      splitLineMessages(text); // Reject invalid digests before storing the edition.
      const store = redisStore();
      await bindEdition(store, digestId, text);
      const groupIds = await listGroups(store, process.env.LINE_GROUP_ID);
      const result = { groups: groupIds.length, sent: 0, alreadySent: 0, inProgress: 0, quotaSkipped: 0, failed: [] as string[] };

      for (const groupId of groupIds) {
        if (await wasSent(store, digestId, groupId)) { result.alreadySent += 1; continue; }
        const claim = await claimGroup(store, digestId, groupId);
        if (!claim) { result.inProgress += 1; continue; }
        try {
          if (await wasSent(store, digestId, groupId)) { result.alreadySent += 1; continue; }
          const members = await groupMemberCount(groupId, channelAccessToken);
          const usage = await monthlyLineUsage(channelAccessToken);
          const cap = Math.min(200, usage.limit);
          const reserved = await reserveMessages(store, lineMonth(), digestId, groupId, members, usage.used, cap);
          if (!reserved) { result.quotaSkipped += 1; continue; }
          await pushDigestToLine({ digestId, text, groupId, channelAccessToken });
          await markSent(store, digestId, groupId);
          result.sent += 1;
        } catch (error) {
          console.error("LINE group delivery failed", { groupId, error });
          result.failed.push(groupId);
        } finally {
          await releaseGroup(store, digestId, groupId, claim);
        }
      }
      const summary = `LINE groups: ${result.sent} sent, ${result.alreadySent} already sent, ${result.inProgress} in progress, ${result.quotaSkipped} skipped for monthly quota, ${result.failed.length} failed. Retry this digestId with identical text for groups not yet sent.`;

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
