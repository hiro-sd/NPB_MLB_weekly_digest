export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json({
    ok: true,
    configured: {
      lineChannelAccessToken: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
      lineChannelSecret: Boolean(process.env.LINE_CHANNEL_SECRET),
      redisRestUrl: Boolean(process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL),
      redisRestToken: Boolean(process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN),
      legacyLineGroupId: Boolean(process.env.LINE_GROUP_ID),
      mcpCapabilitySecret:
        Boolean(process.env.MCP_CAPABILITY_SECRET) &&
        (process.env.MCP_CAPABILITY_SECRET?.length ?? 0) >= 32,
    },
  });
}
