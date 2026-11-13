import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const LINE_TEXT_LIMIT = 5_000;
export const LINE_MESSAGES_PER_REQUEST = 5;

type LinePushResult = {
  status: "sent" | "already_sent";
  requestId: string | null;
  messageCount: number;
};

function cleanText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function takeChunk(text: string, limit: number): [string, string] {
  if (text.length <= limit) return [text, ""];

  const candidate = text.slice(0, limit + 1);
  const paragraphBreak = candidate.lastIndexOf("\n\n");
  const lineBreak = candidate.lastIndexOf("\n");
  const breakAt = paragraphBreak >= Math.floor(limit * 0.55)
    ? paragraphBreak
    : lineBreak >= Math.floor(limit * 0.7)
      ? lineBreak
      : limit;

  return [text.slice(0, breakAt).trimEnd(), text.slice(breakAt).trimStart()];
}

export function splitLineMessages(text: string): string[] {
  let rest = cleanText(text);
  if (!rest) throw new Error("Digest text is empty.");

  const chunks: string[] = [];
  while (rest) {
    const [chunk, next] = takeChunk(rest, LINE_TEXT_LIMIT);
    chunks.push(chunk);
    rest = next;
  }

  if (chunks.length > LINE_MESSAGES_PER_REQUEST) {
    throw new Error(
      `Digest is too long for one LINE push (${chunks.length} messages; maximum ${LINE_MESSAGES_PER_REQUEST}).`,
    );
  }
  return chunks;
}

export function retryKeyForDigest(digestId: string, text: string, groupId = ""): string {
  const bytes = Buffer.from(
    createHash("sha256").update(`${digestId}\0${groupId}\0${cleanText(text)}`).digest().subarray(0, 16),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function verifyLineSignature(body: string, signature: string, channelSecret: string): boolean {
  if (!signature || !channelSecret) return false;
  const expected = createHmac("sha256", channelSecret).update(body).digest("base64");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

async function lineJson<T>(path: string, channelAccessToken: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  const response = await fetchImpl(`https://api.line.me/v2/bot/${path}`, {
    headers: { Authorization: `Bearer ${channelAccessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`LINE ${path} failed (${response.status}).`);
  return await response.json() as T;
}

export async function groupMemberCount(groupId: string, token: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const payload = await lineJson<{ count: number }>(`group/${encodeURIComponent(groupId)}/members/count`, token, fetchImpl);
  if (!Number.isSafeInteger(payload.count) || payload.count < 0) throw new Error("Invalid LINE group member count.");
  return payload.count;
}

export async function monthlyLineUsage(token: string, fetchImpl: typeof fetch = fetch): Promise<{ used: number; limit: number }> {
  const [quota, consumption] = await Promise.all([
    lineJson<{ type: "none" | "limited"; value?: number }>("message/quota", token, fetchImpl),
    lineJson<{ totalUsage: number }>("message/quota/consumption", token, fetchImpl),
  ]);
  if (!Number.isSafeInteger(consumption.totalUsage) || consumption.totalUsage < 0) {
    throw new Error("Invalid LINE monthly usage.");
  }
  if (quota.type === "limited" && (!Number.isSafeInteger(quota.value) || (quota.value ?? 0) < 0)) {
    throw new Error("Invalid LINE monthly quota.");
  }
  return { used: consumption.totalUsage, limit: quota.type === "limited" ? quota.value! : Number.MAX_SAFE_INTEGER };
}

export async function replyToJoin(replyToken: string, token: string, text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`LINE join reply failed (${response.status}).`);
}

export async function leaveGroup(groupId: string, token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(`https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/leave`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`LINE group leave failed (${response.status}).`);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function pushDigestToLine(params: {
  digestId: string;
  text: string;
  groupId: string;
  channelAccessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<LinePushResult> {
  const messages = splitLineMessages(params.text).map((text) => ({ type: "text", text }));
  const retryKey = retryKeyForDigest(params.digestId, params.text, params.groupId);
  const fetchImpl = params.fetchImpl ?? fetch;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetchImpl("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.channelAccessToken}`,
        "Content-Type": "application/json",
        "X-Line-Retry-Key": retryKey,
      },
      body: JSON.stringify({ to: params.groupId, messages }),
      signal: AbortSignal.timeout(15_000),
    });

    if (response.ok) {
      return {
        status: "sent",
        requestId: response.headers.get("x-line-request-id"),
        messageCount: messages.length,
      };
    }

    if (response.status === 409) {
      return {
        status: "already_sent",
        requestId: response.headers.get("x-line-request-id"),
        messageCount: messages.length,
      };
    }

    const body = await response.text();
    if (response.status < 500 || attempt === 2) {
      throw new Error(`LINE push failed (${response.status}): ${body.slice(0, 500)}`);
    }
    await wait(300 * 2 ** attempt);
  }

  throw new Error("LINE push failed after retries.");
}
