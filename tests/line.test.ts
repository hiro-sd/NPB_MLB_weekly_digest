import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  groupMemberCount,
  monthlyLineUsage,
  retryKeyForDigest,
  splitLineMessages,
  verifyLineSignature,
} from "../lib/line";
import { lineMonth } from "../lib/store";

test("short digest remains one message", () => {
  assert.deepEqual(splitLineMessages("  NPB\n\nMLB  "), ["NPB\n\nMLB"]);
});

test("long digest splits on paragraph boundaries", () => {
  const text = `${"a".repeat(3_000)}\n\n${"b".repeat(3_000)}`;
  const chunks = splitLineMessages(text);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 5_000));
  assert.equal(chunks.join("\n\n"), text);
});

test("digest retry key is stable and UUID-shaped", () => {
  const first = retryKeyForDigest("2026-W36", "digest");
  const second = retryKeyForDigest("2026-W36", "digest");
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(retryKeyForDigest("2026-W36", "digest", "group-A"), retryKeyForDigest("2026-W36", "digest", "group-B"));
});

test("LINE group count excludes bot and quota is read from LINE", async () => {
  const requested: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/members/count")) return Response.json({ count: 9 });
    if (url.endsWith("/quota/consumption")) return Response.json({ totalUsage: 87 });
    if (url.endsWith("/quota")) return Response.json({ type: "limited", value: 200 });
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  assert.equal(await groupMemberCount("C123", "token", fakeFetch), 9);
  assert.deepEqual(await monthlyLineUsage("token", fakeFetch), { used: 87, limit: 200 });
  assert.equal(requested.length, 3);
});

test("LINE month rolls over at midnight in Japan", () => {
  assert.equal(lineMonth(new Date("2026-10-31T14:59:59Z")), "2026-10");
  assert.equal(lineMonth(new Date("2026-10-31T15:00:00Z")), "2026-11");
});

test("LINE webhook signature is verified", () => {
  const body = JSON.stringify({ events: [] });
  const secret = "test-secret";
  const signature = createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(verifyLineSignature(body, signature, secret), true);
  assert.equal(verifyLineSignature(body, "bad", secret), false);
});
