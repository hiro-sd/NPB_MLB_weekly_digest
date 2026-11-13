import { groupMemberCount, leaveGroup, monthlyLineUsage, replyToJoin, verifyLineSignature } from "../../../../lib/line";
import { listGroups, redisStore, registerGroup, removeGroup } from "../../../../lib/store";

export const runtime = "nodejs";

type LineWebhook = {
  events?: Array<{
    type?: string;
    replyToken?: string;
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

  if (!Array.isArray(payload.events)) return Response.json({ ok: false }, { status: 400 });
  const store = redisStore();
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return Response.json({ ok: false }, { status: 503 });

  try {
    for (const event of payload.events) {
      const groupId = event.source?.type === "group" ? event.source.groupId : undefined;
      if (!groupId) continue;
      if (event.type === "leave") {
        await removeGroup(store, groupId);
      } else if (event.type === "join") {
        const members = await groupMemberCount(groupId, token);
        const legacyId = process.env.LINE_GROUP_ID;
        const legacyActive = legacyId && legacyId !== groupId && (await listGroups(store, legacyId)).includes(legacyId);
        const legacy = legacyActive ? { groupId: legacyId, members: await groupMemberCount(legacyId, token) } : null;
        const quota = await monthlyLineUsage(token);
        const registered = await registerGroup(store, groupId, members, legacy, Math.floor(Math.min(200, quota.limit) / 5));
        if (event.replyToken) {
          const message = registered
            ? "週間NPB・MLBダイジェストの配信先に登録しました。毎週同じダイジェストをお届けします。配信を止める場合は、このアカウントをグループから削除してください。"
            : "無料配信の定員に達したため、このグループは登録できませんでした。アカウントはグループから退出します。";
          try { await replyToJoin(event.replyToken, token, message); }
          catch (error) { console.error("LINE join reply failed", error); }
        }
        if (!registered) await leaveGroup(groupId, token);
      }
    }
  } catch (error) {
    console.error("LINE webhook processing failed", error);
    return Response.json({ ok: false }, { status: 500 });
  }

  return Response.json({ ok: true });
}
