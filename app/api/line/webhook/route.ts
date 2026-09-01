import { verifyLineSignature } from "../../../../lib/line";

export const runtime = "nodejs";

type LineWebhook = {
  events?: Array<{
    type?: string;
    source?: { type?: string; groupId?: string; roomId?: string; userId?: string };
  }>;
};

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  const signature = request.headers.get("x-line-signature") ?? "";
  const channelSecret = process.env.LINE_CHANNEL_SECRET ?? "";

  if (!verifyLineSignature(body, signature, channelSecret)) {
    return Response.json({ ok: false }, { status: 401 });
  }

  let payload: LineWebhook;
  try {
    payload = JSON.parse(body) as LineWebhook;
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }

  for (const event of payload.events ?? []) {
    if (event.source?.type === "group" && event.source.groupId) {
      // Runtime logs are used once during setup to capture the fixed destination ID.
      console.info("LINE_GROUP_DISCOVERED", {
        groupId: event.source.groupId,
        eventType: event.type ?? "unknown",
      });
    }
  }

  return Response.json({ ok: true });
}
