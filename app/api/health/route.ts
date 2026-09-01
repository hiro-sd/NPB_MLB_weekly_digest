export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json({
    ok: true,
    configured: {
      lineChannelAccessToken: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
      lineChannelSecret: Boolean(process.env.LINE_CHANNEL_SECRET),
      lineGroupId: Boolean(process.env.LINE_GROUP_ID),
      mcpCapabilitySecret:
        Boolean(process.env.MCP_CAPABILITY_SECRET) &&
        (process.env.MCP_CAPABILITY_SECRET?.length ?? 0) >= 32,
    },
  });
}
