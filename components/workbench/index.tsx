"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Archive, ChevronDown, ChevronRight, FolderPlus, Menu, MessageSquare, Plus, SquarePen, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { Project, Workbench as WorkspaceData } from "@/lib/workbench";
import { Conversation } from "./conversation";

type View = { id: string; projectId?: string; existing?: boolean };
type ProjectForm = { id: string; name: string; pending: boolean; error?: string };

const initialData: WorkspaceData = { projects: [], tasks: [], models: [] };

export function Workbench() {
  const [data, setData] = useState(initialData);
  const [view, setView] = useState<View>({ id: "" });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [projectForm, setProjectForm] = useState<ProjectForm>();
  const [mobileMenu, setMobileMenu] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const refreshVersion = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const response = await fetch("/api/workbench", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const next: WorkspaceData = await response.json();
      if (version !== refreshVersion.current) return;
      setData(next);
      setLoaded(true);
      setLoadError("");
    } catch {
      if (version === refreshVersion.current) setLoadError("暂时无法加载工作台。");
    }
  }, []);

  useEffect(() => {
    const start = setTimeout(() => {
      const taskId = new URL(window.location.href).searchParams.get("task");
      setView({ id: taskId || crypto.randomUUID(), existing: Boolean(taskId) });
      void refresh();
    }, 0);
    const interval = setInterval(() => { if (!document.hidden) void refresh(); }, 2_000);
    return () => { clearTimeout(start); clearInterval(interval); };
  }, [refresh]);

  function navigate(next: View) {
    setView(next);
    const url = new URL(window.location.href);
    if (next.existing) url.searchParams.set("task", next.id);
    else url.searchParams.delete("task");
    window.history.replaceState(null, "", url);
    setMobileMenu(false);
  }

  function startDraft(projectId?: string) {
    navigate({ id: crypto.randomUUID(), projectId });
  }

  const task = data.tasks.find(item => item.id === view.id);
  const project = data.projects.find(item => item.id === (task?.projectId ?? view.projectId));

  function openProject(project: Project) {
    if (project.status === "failed") {
      showProjectForm(project);
      return;
    }
    const last = data.tasks.find(item => item.projectId === project.id);
    if (last) navigate({ id: last.id, projectId: project.id, existing: true });
    else startDraft(project.id);
    expandProject(project.id);
  }

  function expandProject(id: string) {
    setCollapsed(previous => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  }

  function showProjectForm(project?: Project) {
    setProjectForm({ id: project?.id || crypto.randomUUID(), name: project?.name || "", pending: false });
  }

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectForm || projectForm.pending || !projectForm.name.trim()) return;
    const { id, name } = projectForm;
    setProjectForm({ id, name, pending: true });
    try {
      const response = await fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name }),
      });
      if (!response.ok) throw new Error(await response.text());
      expandProject(id);
      if (view.existing) startDraft(id);
      else setView(previous => ({ ...previous, projectId: id }));
      setProjectForm(undefined);
      setMobileMenu(false);
    } catch (error) {
      setProjectForm({ id, name, pending: false, error: error instanceof Error ? error.message : "创建项目失败，请重试。" });
    } finally {
      void refresh();
    }
  }

  return (
    <div className="workbench">
      {mobileMenu && <button className="nav-overlay" tabIndex={-1} aria-label="关闭侧栏遮罩" onClick={() => setMobileMenu(false)} />}
      <aside className="workbench-nav" data-open={mobileMenu} aria-label="项目和任务">
        <div className="brand">
          <Image src="/skillberry.svg" width={34} height={34} alt="" />
          <span>Skillberry</span>
          <Button className="mobile-nav-close" variant="ghost" size="icon" aria-label="关闭侧栏" onClick={() => setMobileMenu(false)}><X /></Button>
        </div>
        <div className="nav-actions">
          <Button className="new-chat-button" onClick={() => startDraft(project?.id)}>
            <SquarePen data-icon="inline-start" />新建对话
          </Button>
          <Button variant="ghost" className="new-project-button" onClick={() => showProjectForm()}>
            <FolderPlus data-icon="inline-start" />新建项目
          </Button>
        </div>
        <nav className="project-nav" aria-label="任务">
          <h2>任务</h2>
          {loaded && !data.projects.length && <p className="nav-empty">创建项目后，任务会显示在这里。</p>}
          {data.projects.map(item => {
            const isCollapsed = collapsed.has(item.id);
            const projectTasks = data.tasks.filter(entry => entry.projectId === item.id);
            return (
              <div key={item.id} className="project-group">
                <div className="project-group-head" data-selected={project?.id === item.id}>
                  <Button variant="ghost" size="icon-xs" className="group-toggle" aria-expanded={!isCollapsed}
                    aria-label={`${isCollapsed ? "展开" : "折叠"} ${item.name}`}
                    onClick={() => setCollapsed(previous => {
                      const next = new Set(previous);
                      if (next.has(item.id)) next.delete(item.id);
                      else next.add(item.id);
                      return next;
                    })}>
                    {isCollapsed ? <ChevronRight /> : <ChevronDown />}
                  </Button>
                  <Button variant="ghost" className="project-link" onClick={() => openProject(item)}>
                    <Archive data-icon="inline-start" /><span className="truncate">{item.name}</span>
                    {item.status !== "ready" && <small>{item.status === "preparing" ? "准备中" : item.status === "failed" ? "重试" : "不可用"}</small>}
                  </Button>
                </div>
                {!isCollapsed && projectTasks.map(entry => (
                  <Button key={entry.id} variant="ghost" className="task-link" aria-current={view.id === entry.id ? "page" : undefined}
                    onClick={() => navigate({ id: entry.id, projectId: item.id, existing: true })}>
                    <MessageSquare data-icon="inline-start" /><span className="truncate">{entry.title}</span>
                    {entry.status === "running" && <span className="run-dot" aria-label="执行中" />}
                  </Button>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>
      <main className="workbench-main">
        <header className="workbench-header">
          <Button className="mobile-nav-open" variant="ghost" size="icon" aria-label="打开侧栏" onClick={() => setMobileMenu(true)}><Menu /></Button>
          {view.existing && task ? (
            <div className="breadcrumb"><Archive /><span>{project?.name}</span><ChevronRight /><strong>{task.title}</strong></div>
          ) : <span className="header-label">工作台</span>}
        </header>
        {loadError && <div className="load-error" role="alert">{loadError} <Button variant="ghost" onClick={() => void refresh()}>重试</Button></div>}
        <Conversation key={view.id} id={view.id} existing={Boolean(view.existing || task)} loaded={loaded}
          modelOptions={data.models} projects={data.projects} project={project} task={task}
          busy={data.tasks.some(item => item.projectId === project?.id && item.id !== view.id && item.status === "running")}
          onProject={id => setView(previous => ({ ...previous, projectId: id }))}
          onNewProject={showProjectForm}
          onAccepted={(id, projectId) => {
            setView(previous => {
              if (previous.id !== id) return previous;
              return { id, projectId, existing: true };
            });
            expandProject(projectId);
            void refresh();
          }}
          refresh={refresh}
        />
        {view.existing && task && <TaskLocation id={task.id} />}
      </main>
      <Dialog open={!!projectForm} onOpenChange={open => { if (!open && !projectForm?.pending) setProjectForm(undefined); }}>
        <DialogContent showCloseButton={!projectForm?.pending} className="project-dialog">
          <DialogHeader>
            <DialogTitle>新建项目</DialogTitle>
            <DialogDescription>项目中的任务共用一个文件工作区。</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={createProject}>
            <Field>
              <FieldLabel htmlFor="project-name">项目名称</FieldLabel>
              <Input id="project-name" autoFocus placeholder="输入项目名称" maxLength={80} value={projectForm?.name ?? ""}
                disabled={projectForm?.pending} aria-invalid={!!projectForm?.error}
                onChange={event => projectForm && setProjectForm({ id: projectForm.id, name: event.target.value, pending: false })} />
            </Field>
            {projectForm?.error && <p role="alert" className="form-error">{projectForm.error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={projectForm?.pending} onClick={() => setProjectForm(undefined)}>取消</Button>
              <Button type="submit" disabled={projectForm?.pending || !projectForm?.name.trim()}>
                {projectForm?.pending ? "正在准备项目" : projectForm?.error ? "重试" : <><Plus data-icon="inline-start" />创建项目</>}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TaskLocation({ id }: { id: string }) {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("task") === id) return;
    url.searchParams.set("task", id);
    window.history.replaceState(null, "", url);
  }, [id]);
  return null;
}
