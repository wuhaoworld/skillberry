import { z } from "zod";
import { keepProjectAwake } from "@/lib/server/environment";
import { projectIsReady } from "@/lib/server/store";

const projectIdSchema = z.uuid();

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return new Response(null, { status: 403 });
  const { projectId } = await context.params;
  if (!projectIdSchema.safeParse(projectId).success || !projectIsReady(projectId)) {
    return new Response(null, { status: 404 });
  }

  try {
    await keepProjectAwake(projectId, AbortSignal.timeout(80_000));
    return new Response(null, { status: 204 });
  } catch (error) {
    console.warn("Sandbox prewarm failed", error instanceof Error ? error.name : "Unknown");
    return new Response(null, { status: 503 });
  }
}
