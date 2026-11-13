import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { POST } from "../app/api/line/webhook/route";

test("signed group join registers; leave removes; ordinary messages do nothing", async () => {
  const savedFetch = globalThis.fetch;
  const saved = {
    secret: process.env.LINE_CHANNEL_SECRET,
    token: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    url: process.env.UPSTASH_REDIS_REST_URL,
    redisToken: process.env.UPSTASH_REDIS_REST_TOKEN,
    legacy: process.env.LINE_GROUP_ID,
  };
  process.env.LINE_CHANNEL_SECRET = "test-secret";
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
  delete process.env.LINE_GROUP_ID;

  const commands: unknown[][] = [];
  const lineCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://redis.example.test") {
      commands.push(JSON.parse(String(init?.body)) as unknown[]);
      return Response.json({ result: 1 });
    }
    lineCalls.push(url);
    if (url.endsWith("/members/count")) return Response.json({ count: 4 });
    if (url.endsWith("/message/quota/consumption")) return Response.json({ totalUsage: 0 });
    if (url.endsWith("/message/quota")) return Response.json({ type: "limited", value: 200 });
    if (url.endsWith("/message/reply")) return Response.json({});
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  const webhook = async (event: object, signature?: string): Promise<Response> => {
    const body = JSON.stringify({ events: [event] });
    return POST(new Request("https://example.test/api/line/webhook", {
      method: "POST",
      headers: { "x-line-signature": signature ?? createHmac("sha256", "test-secret").update(body).digest("base64") },
      body,
    }));
  };
  try {
    assert.equal((await webhook({ type: "join", source: { type: "group", groupId: "C123" } }, "wrong")).status, 401);
    assert.equal(commands.length, 0);
    assert.equal((await webhook({ type: "join", replyToken: "reply-token", source: { type: "group", groupId: "C123" } })).status, 200);
    assert.equal(commands.length, 1);
    assert.equal(commands[0][0], "EVAL");
    assert.ok(lineCalls.some((url) => url.endsWith("/message/reply")));
    assert.equal((await webhook({ type: "message", source: { type: "group", groupId: "C123" } })).status, 200);
    assert.equal(commands.length, 1);
    assert.equal((await webhook({ type: "leave", source: { type: "group", groupId: "C123" } })).status, 200);
    assert.equal(commands.length, 2);
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries({
      LINE_CHANNEL_SECRET: saved.secret,
      LINE_CHANNEL_ACCESS_TOKEN: saved.token,
      UPSTASH_REDIS_REST_URL: saved.url,
      UPSTASH_REDIS_REST_TOKEN: saved.redisToken,
      LINE_GROUP_ID: saved.legacy,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
