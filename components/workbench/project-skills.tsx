"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Layers, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { skillZipLimit, type InstalledSkill, type SkillPreview } from "@/lib/workbench";

type UploadPreview = SkillPreview & { archive: File };

async function getSkills(url: string, signal?: AbortSignal): Promise<InstalledSkill[]> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error("暂时无法加载 Skills。");
  return response.json();
}

async function requestError(response: Response) {
  return new Error(response.status < 500 ? await response.text() : "操作失败，请稍后重试。");
}

export function ProjectSkills({ projectId, onChange }: {
  projectId: string;
  onChange: () => Promise<void>;
}) {
  const url = `/api/projects/${projectId}/skills`;
  const input = useRef<HTMLInputElement>(null);
  const [skills, setSkills] = useState<InstalledSkill[]>();
  const [preview, setPreview] = useState<UploadPreview>();
  const [remove, setRemove] = useState<InstalledSkill>();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [dragging, setDragging] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void getSkills(url, controller.signal).then(setSkills).catch(() => {
      if (!controller.signal.aborted) setError("暂时无法加载 Skills。");
    });
    return () => controller.abort();
  }, [url, loadAttempt]);

  async function previewArchive(archive?: File) {
    if (!archive || pending || !skills) return;
    setError("");
    setDialogError("");
    if (!/\.zip$/i.test(archive.name) || archive.size > skillZipLimit) {
      setError("请选择不超过 2 MB 的 ZIP 压缩包。");
      return;
    }
    setPending("preview");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/zip" }, body: archive });
      if (!response.ok) throw await requestError(response);
      const result: SkillPreview = await response.json();
      setPreview({ ...result, archive });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取 ZIP 压缩包。");
    } finally {
      setPending("");
    }
  }

  async function mutate(action: "install" | "toggle" | "delete", name: string, request: RequestInit) {
    if (pending) return;
    setPending(action);
    setError("");
    setDialogError("");
    try {
      const response = await fetch(url, request);
      if (response.status === 409) {
        setSkills(await getSkills(url));
        await onChange();
        setPreview(undefined);
        setRemove(undefined);
        setError("这个 Skill 已更改，请重新操作。");
        return;
      }
      if (!response.ok) throw await requestError(response);
      const skill: InstalledSkill | undefined = action === "delete" ? undefined : await response.json();
      setSkills(previous => {
        const remaining = (previous ?? []).filter(item => item.name !== name);
        return skill ? [...remaining, skill].sort((a, b) => a.name.localeCompare(b.name)) : remaining;
      });
      setAnnouncement(action === "delete" ? `已删除 ${name}` : skill?.enabled ? `已启用 ${name}` : `已停用 ${name}`);
      setPreview(undefined);
      setRemove(undefined);
      await onChange();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "操作失败，请稍后重试。";
      if (action === "toggle") setError(message);
      else setDialogError(message);
    } finally {
      setPending("");
    }
  }

  function changeSkill(skill: InstalledSkill, enabled?: boolean) {
    const { name, versionId } = skill;
    void mutate(enabled === undefined ? "delete" : "toggle", name, {
      method: enabled === undefined ? "DELETE" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, versionId, enabled }),
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <input ref={input} type="file" accept=".zip,application/zip" className="hidden"
        aria-label="选择 Skill ZIP 文件" onChange={event => {
          const archive = event.target.files?.[0];
          event.target.value = "";
          void previewArchive(archive);
        }} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-xl font-semibold tracking-tight">项目 Skills</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">已启用的 Skill 会在下一轮对话中可用。</p>
        </div>
        <Button type="button" disabled={Boolean(pending) || !skills} onClick={() => input.current?.click()}>
          <Upload data-icon="inline-start" />{pending === "preview" ? "正在检查 ZIP" : "上传 Skill"}
        </Button>
      </div>
      <p aria-live="polite" className="sr-only">{announcement}</p>
      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/25 px-3 py-2 text-sm text-destructive">
          {error}
          {!skills && <Button variant="ghost" size="sm" onClick={() => { setError(""); setLoadAttempt(attempt => attempt + 1); }}>重试</Button>}
        </div>
      )}
      {!skills && !error && <p role="status" className="text-sm text-muted-foreground">正在加载 Skills…</p>}
      {skills?.length === 0 && (
        <div
          className="grid min-h-52 place-items-center rounded-xl border border-dashed bg-muted/20 p-6 text-center data-dragging:border-primary data-dragging:bg-primary/5"
          data-dragging={dragging ? "" : undefined}
          onDragOver={event => { event.preventDefault(); setDragging(true); }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
          onDrop={event => {
            event.preventDefault();
            setDragging(false);
            if (event.dataTransfer.files.length === 1) void previewArchive(event.dataTransfer.files[0]);
            else setError("每次请选择一个 Skill ZIP 压缩包。");
          }}>
          <div className="grid justify-items-center gap-2">
            <span className="mb-1 rounded-lg border bg-background p-2.5"><Layers className="size-5 text-muted-foreground" /></span>
            <p className="text-sm font-medium">这个项目还没有 Skill</p>
            <p className="text-sm text-muted-foreground">拖入含有 SKILL.md 的 ZIP，或点击「上传 Skill」。</p>
          </div>
        </div>
      )}
      {!!skills?.length && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,250px),1fr))] gap-4">
          {skills.map(skill => (
            <li key={skill.name} className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground">
              <div className="flex min-w-0 items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="shrink-0 rounded-lg bg-muted p-2"><Layers className="size-4 text-muted-foreground" /></span>
                  <h3 className="min-w-0 text-sm font-semibold wrap-anywhere">{skill.name}</h3>
                </div>
                <Button type="button" variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`删除 ${skill.name}`} disabled={Boolean(pending)}
                  onClick={() => { setDialogError(""); setRemove(skill); }}><Trash2 className="size-4" /></Button>
              </div>
              <p className="flex-1 text-sm/relaxed text-muted-foreground wrap-anywhere">{skill.description}</p>
              <div className="flex items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5"><FileText className="size-3.5" />{skill.fileCount} 个文件</span>
                <span className="flex items-center gap-3">
                  {skill.enabled ? "已启用" : "已停用"}
                  <Switch aria-label={`启用 ${skill.name}`} checked={skill.enabled} disabled={Boolean(pending)}
                    onCheckedChange={enabled => changeSkill(skill, enabled)} />
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={Boolean(preview)} onOpenChange={open => { if (!open && !pending) setPreview(undefined); }}>
        <DialogContent showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>{preview?.currentVersionId ? "更新 Skill" : "安装 Skill"}</DialogTitle>
            <DialogDescription>确认后启用这个版本，下一轮对话即可使用。</DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="grid min-w-0 gap-2 text-sm">
              <p className="font-semibold wrap-anywhere">{preview.name}</p>
              <p className="text-muted-foreground wrap-anywhere">{preview.description}</p>
              <ul className="max-h-40 overflow-y-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-6 wrap-anywhere">
                {preview.files.map(path => <li key={path}>{path}</li>)}
              </ul>
            </div>
          )}
          {dialogError && preview && <p role="alert" className="text-sm text-destructive">{dialogError}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={Boolean(pending)} onClick={() => setPreview(undefined)}>取消</Button>
            <Button disabled={Boolean(pending) || !preview} onClick={() => preview && void mutate("install", preview.name, {
              method: "PUT",
              headers: { "Content-Type": "application/zip", "X-Skill-Version": preview.currentVersionId ?? "new" },
              body: preview.archive,
            })}>{pending === "install" ? "正在安装…" : preview?.currentVersionId ? "更新并启用" : "安装并启用"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(remove)} onOpenChange={open => { if (!open && !pending) setRemove(undefined); }}>
        <DialogContent showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>删除 Skill</DialogTitle>
            <DialogDescription>删除「{remove?.name}」后，后续对话将无法再调用它。你可以重新上传 ZIP 安装。</DialogDescription>
          </DialogHeader>
          {dialogError && remove && <p role="alert" className="text-sm text-destructive">{dialogError}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={Boolean(pending)} onClick={() => setRemove(undefined)}>取消</Button>
            <Button variant="destructive" disabled={Boolean(pending) || !remove} onClick={() => remove && changeSkill(remove)}>
              {pending === "delete" ? "正在删除…" : "删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
