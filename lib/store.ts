import { createHash, randomUUID } from "node:crypto";

const PREFIX = "weekly-digest:v1";
const GROUPS = `${PREFIX}:groups`;
const COUNTS = `${PREFIX}:member-counts`;
const DISABLED = `${PREFIX}:disabled`;

export type Store = {
  command<T>(...args: Array<string | number>): Promise<T>;
};

export function redisStore(fetchImpl: typeof fetch = fetch): Store {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash Redis is not configured.");
  return {
    async command<T>(...args: Array<string | number>): Promise<T> {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await response.json() as { result?: T; error?: string };
      if (!response.ok || payload.error) {
        throw new Error(`Redis command failed: ${payload.error ?? response.status}`);
      }
      return payload.result as T;
    },
  };
}

export async function registerGroup(
  store: Store,
  groupId: string,
  members: number,
  legacy: { groupId: string; members: number } | null,
  maxAudience = 40,
): Promise<boolean> {
  const script = `
    if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
      redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
      redis.call('SREM', KEYS[3], ARGV[1])
      return 1
    end
    local total = tonumber(ARGV[2])
    for _, n in ipairs(redis.call('HVALS', KEYS[2])) do total = total + tonumber(n) end
    if ARGV[3] ~= '' and ARGV[3] ~= ARGV[1]
       and redis.call('SISMEMBER', KEYS[1], ARGV[3]) == 0
       and redis.call('SISMEMBER', KEYS[3], ARGV[3]) == 0 then
      total = total + tonumber(ARGV[4])
    end
    if total > tonumber(ARGV[5]) then return 0 end
    redis.call('SADD', KEYS[1], ARGV[1])
    redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
    redis.call('SREM', KEYS[3], ARGV[1])
    return 1`;
  const result = await store.command<number>(
    "EVAL", script, 3, GROUPS, COUNTS, DISABLED,
    groupId, members, legacy?.groupId ?? "", legacy?.members ?? 0, maxAudience,
  );
  return result === 1;
}

export async function removeGroup(store: Store, groupId: string): Promise<void> {
  // A legacy LINE_GROUP_ID must not resurrect a group after the bot leaves it.
  const script = "redis.call('SREM', KEYS[1], ARGV[1]); redis.call('HDEL', KEYS[2], ARGV[1]); return redis.call('SADD', KEYS[3], ARGV[1])";
  await store.command<number>("EVAL", script, 3, GROUPS, COUNTS, DISABLED, groupId);
}

export async function listGroups(store: Store, legacyGroupId?: string): Promise<string[]> {
  const groups = await store.command<string[]>("SMEMBERS", GROUPS);
  if (legacyGroupId && await store.command<number>("SISMEMBER", DISABLED, legacyGroupId) === 0) {
    groups.push(legacyGroupId);
  }
  return [...new Set(groups)].sort();
}

function editionKey(digestId: string): string {
  return `${PREFIX}:edition:${createHash("sha256").update(digestId).digest("hex")}`;
}

export async function bindEdition(store: Store, digestId: string, text: string): Promise<void> {
  const key = editionKey(digestId);
  const hash = createHash("sha256").update(text.replace(/\r\n/g, "\n").trim()).digest("hex");
  const accepted = await store.command<string | null>("SET", key, hash, "NX");
  if (accepted === null && await store.command<string>("GET", key) !== hash) {
    throw new Error("This digestId was already used with different text.");
  }
}

function groupKey(digestId: string, groupId: string): string {
  return `${editionKey(digestId)}:${groupId}`;
}

export async function wasSent(store: Store, digestId: string, groupId: string): Promise<boolean> {
  return await store.command<number>("SISMEMBER", `${PREFIX}:sent:${editionKey(digestId)}`, groupId) === 1;
}

export async function markSent(store: Store, digestId: string, groupId: string): Promise<void> {
  await store.command<number>("SADD", `${PREFIX}:sent:${editionKey(digestId)}`, groupId);
}

export async function claimGroup(store: Store, digestId: string, groupId: string): Promise<string | null> {
  const token = randomUUID();
  const claimed = await store.command<string | null>("SET", `${groupKey(digestId, groupId)}:lock`, token, "NX", "EX", 120);
  return claimed === "OK" ? token : null;
}

export async function releaseGroup(store: Store, digestId: string, groupId: string, token: string): Promise<void> {
  const script = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
  await store.command<number>("EVAL", script, 1, `${groupKey(digestId, groupId)}:lock`, token);
}

export function lineMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).formatToParts(now);
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}`;
}

export async function reserveMessages(
  store: Store, month: string, digestId: string, groupId: string,
  members: number, observedUsage: number, cap: number,
): Promise<boolean> {
  const script = `
    local used = math.max(tonumber(redis.call('GET', KEYS[1]) or '0'), tonumber(ARGV[2]))
    local prior = tonumber(redis.call('GET', KEYS[2]) or '0')
    local extra = math.max(0, tonumber(ARGV[1]) - prior)
    if used + extra > tonumber(ARGV[3]) then return 0 end
    redis.call('SET', KEYS[1], used + extra, 'EX', 3888000)
    redis.call('SET', KEYS[2], math.max(prior, tonumber(ARGV[1])), 'EX', 3888000)
    return 1`;
  return await store.command<number>(
    "EVAL", script, 2,
    `${PREFIX}:budget:${month}`, `${groupKey(digestId, groupId)}:reservation:${month}`,
    members, observedUsage, cap,
  ) === 1;
}
