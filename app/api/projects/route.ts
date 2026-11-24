import { z } from "zod";
import { provisionProject } from "@/lib/server/environment";
import { beginProject, endProject } from "@/lib/server/store";

const form = z.object({ id: z.uuid(), name: z.string().trim().min(1).max(80) });

export async function POST(request: Request) {
  const input = form.safeParse(await request.json().catch(() => null));
  if (!input.success) return new Response("请输入 1–80 个字符的项目名称。", { status: 400 });
  const { id, name } = input.data;
  const lease = beginProject(id, name);
  if (lease === "ready") return Response.json({ id });
  if (lease === "unavailable") return new Response("原项目工作区已无法恢复，请新建项目。", { status: 410 });
  if (lease === "busy") return new Response("正在准备项目，请稍后重试。", { status: 409 });
  if (lease === "conflict") return new Response("项目名称与原请求不一致。", { status: 409 });
  try {
    await provisionProject(id);
    endProject(id, lease, "ready");
    return Response.json({ id });
  } catch (error) {
    console.error("Project initialization failed", id, error instanceof Error ? error.name : "Unknown");
    endProject(id, lease, "failed");
    return new Response("项目工作区准备失败，请重试。", { status: 503 });
  }
}
