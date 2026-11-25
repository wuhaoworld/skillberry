import { z } from "zod";
import { parseSkillUpload, skillName, SkillUploadError } from "@/lib/server/skill-package";
import { deleteProjectSkill, getProjectSkill, getProjectSkills, installProjectSkill, projectExists, setProjectSkillEnabled } from "@/lib/server/store";
import type { SkillPreview } from "@/lib/workbench";

type Context = { params: Promise<{ projectId: string }> };
const projectIdSchema = z.uuid();
const version = z.uuid();
const remove = z.object({ name: skillName, versionId: version });
const toggle = remove.extend({ enabled: z.boolean() });
const versionConflict = "这个 Skill 已更改，请刷新后再试。";

async function selectedProject(context: Context) {
  const { projectId } = await context.params;
  if (projectIdSchema.safeParse(projectId).success && projectExists(projectId)) return projectId;
}

function projectNotFound() {
  return new Response("项目不存在。", { status: 404 });
}

function uploadFailure(error: unknown) {
  if (error instanceof SkillUploadError) return new Response(error.message, { status: error.status });
  throw error;
}

export async function GET(_request: Request, context: Context) {
  const projectId = await selectedProject(context);
  if (!projectId) return projectNotFound();
  return Response.json(getProjectSkills(projectId), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, context: Context) {
  const projectId = await selectedProject(context);
  if (!projectId) return projectNotFound();
  try {
    const { name, description, files } = await parseSkillUpload(request);
    return Response.json({
      name, description, files: ["SKILL.md", ...files.map(file => file.path)],
      currentVersionId: getProjectSkill(projectId, name)?.versionId ?? null,
    } satisfies SkillPreview);
  } catch (error) {
    return uploadFailure(error);
  }
}

export async function PUT(request: Request, context: Context) {
  const projectId = await selectedProject(context);
  if (!projectId) return projectNotFound();
  const expected = z.union([version, z.literal("new")]).safeParse(request.headers.get("x-skill-version"));
  if (!expected.success) return new Response("请先预览上传的 Skill。", { status: 400 });
  try {
    const bundle = await parseSkillUpload(request);
    const skill = installProjectSkill(projectId, bundle, expected.data === "new" ? null : expected.data);
    return skill ? Response.json(skill) : new Response(versionConflict, { status: 409 });
  } catch (error) {
    return uploadFailure(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  const projectId = await selectedProject(context);
  if (!projectId) return projectNotFound();
  const input = toggle.safeParse(await request.json().catch(() => null));
  if (!input.success) return new Response("Skill 信息无效。", { status: 400 });
  const { name, versionId, enabled } = input.data;
  const skill = setProjectSkillEnabled(projectId, name, versionId, enabled);
  return skill ? Response.json(skill) : new Response(versionConflict, { status: 409 });
}

export async function DELETE(request: Request, context: Context) {
  const projectId = await selectedProject(context);
  if (!projectId) return projectNotFound();
  const input = remove.safeParse(await request.json().catch(() => null));
  if (!input.success) return new Response("Skill 信息无效。", { status: 400 });
  const { name, versionId } = input.data;
  return deleteProjectSkill(projectId, name, versionId)
    ? new Response(null, { status: 204 })
    : new Response(versionConflict, { status: 409 });
}
