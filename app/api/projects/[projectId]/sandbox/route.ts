import { z } from "zod";
import { keepProjectAwake, sandboxIdleTimeout } from "@/lib/server/environment";
import { projectIsReady } from "@/lib/server/store";

const projectIdSchema = z.uuid();
const activityAgeSchema = z.coerce.number().int().nonnegative();

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return new Response(null, { status: 403 });
  const activityAge = activityAgeSchema.safeParse(new URL(request.url).searchParams.get("activityAgeMs") ?? 0);
  if (!activityAge.success) return new Response(null, { status: 400 });
  const activityAt = Date.now() - activityAge.data;
  const { projectId } = await context.params;
  if (!projectIdSchema.safeParse(projectId).success || !projectIsReady(projectId)) {
    return new Response(null, { status: 404 });
  }
  if (activityAge.data >= sandboxIdleTimeout) return new Response(null, { status: 204 });

  try {
    await keepProjectAwake(projectId, AbortSignal.timeout(80_000), { activityAt });
    return new Response(null, { status: 204 });
  } catch (error) {
    console.warn("Sandbox prewarm failed", error instanceof Error ? error.name : "Unknown");
    return new Response(null, { status: 503 });
  }
}
