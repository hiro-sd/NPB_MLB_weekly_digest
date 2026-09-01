import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  retryKeyForDigest,
  splitLineMessages,
  verifyLineSignature,
} from "../lib/line";

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
});

test("LINE webhook signature is verified", () => {
  const body = JSON.stringify({ events: [] });
  const secret = "test-secret";
  const signature = createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(verifyLineSignature(body, signature, secret), true);
  assert.equal(verifyLineSignature(body, "bad", secret), false);
});
