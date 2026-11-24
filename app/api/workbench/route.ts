import { availableModels } from "@/lib/server/environment";
import { getProjects, getTask, getTasks } from "@/lib/server/store";
import type { Workbench } from "@/lib/workbench";

export function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("task");
  const task = id ? getTask(id) : undefined;
  if (id && !task) return new Response("任务不存在。", { status: 404 });
  return Response.json({
    projects: getProjects(), tasks: getTasks(), models: availableModels(), task,
  } satisfies Workbench, { headers: { "Cache-Control": "no-store" } });
}
