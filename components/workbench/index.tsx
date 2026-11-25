"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, Menu, Plus, SquarePen, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { Project, Workbench as WorkspaceData } from "@/lib/workbench";
import { Conversation } from "./conversation";

type View =
  | { id: string; projectId?: string; existing?: boolean; overview?: never }
  | { id?: never; projectId: string; existing?: never; overview: true };
type ProjectForm = { id: string; name: string; pending: boolean; error?: string };

const initialData: WorkspaceData = { projects: [], tasks: [], models: [] };
const sidebarItemBaseClassName = "font-normal active:not-aria-[haspopup]:translate-y-0";
const sidebarItemClassName = `${sidebarItemBaseClassName} hover:bg-foreground/4!`;

export function Workbench() {
  const [data, setData] = useState(initialData);
  const [view, setView] = useState<View>({ id: "" });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [projectForm, setProjectForm] = useState<ProjectForm>();
  const [mobileMenu, setMobileMenu] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const refreshVersion = useRef(0);
  const hasActiveWork = data.tasks.some(task => task.status === "running")
    || data.projects.some(project => project.status === "preparing");

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
    function refreshWhenVisible() {
      if (!document.hidden) void refresh();
    }

    const start = setTimeout(() => {
      const taskId = new URL(window.location.href).searchParams.get("task");
      setView({ id: taskId || crypto.randomUUID(), existing: Boolean(taskId) });
      void refresh();
    }, 0);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      clearTimeout(start);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh]);

  useEffect(() => {
    if (!hasActiveWork) return;
    const interval = setInterval(() => { if (!document.hidden) void refresh(); }, 2_000);
    return () => clearInterval(interval);
  }, [hasActiveWork, refresh]);

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

  function toggleProject(id: string) {
    setCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
      if (view.existing || view.overview) startDraft(id);
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
    <div className="grid h-dvh grid-cols-[250px_minmax(0,1fr)] overflow-hidden bg-background [@media(max-width:680px)]:grid-cols-1">
      {mobileMenu && (
        <button className="fixed inset-0 z-19 hidden bg-foreground/25 [@media(max-width:680px)]:block"
          tabIndex={-1} aria-label="关闭侧栏遮罩" onClick={() => setMobileMenu(false)} />
      )}
      <aside
        className="flex min-h-0 flex-col border-e border-sidebar-border bg-sidebar px-4 py-5.5 text-sidebar-foreground [@media(max-width:680px)]:invisible [@media(max-width:680px)]:fixed [@media(max-width:680px)]:inset-y-0 [@media(max-width:680px)]:left-0 [@media(max-width:680px)]:z-20 [@media(max-width:680px)]:w-[min(280px,85vw)] [@media(max-width:680px)]:-translate-x-full [@media(max-width:680px)]:data-open:visible [@media(max-width:680px)]:data-open:translate-x-0"
        data-open={mobileMenu ? "" : undefined} aria-label="项目和任务"
      >
        <div className="mx-1.5 mb-7 flex items-center gap-2.5 text-xl/[1.5] font-[650] tracking-[-0.045em]">
          <Image src="/skillberry.svg" width={34} height={34} alt="" />
          <span>Skillberry</span>
          <Button className="ml-auto hidden [@media(max-width:680px)]:inline-flex" variant="ghost" size="icon" aria-label="关闭侧栏" onClick={() => setMobileMenu(false)}><X /></Button>
        </div>
        <div className="grid gap-1.5">
          <Button className={`justify-start ${sidebarItemClassName}`} variant="ghost" size="lg" onClick={() => startDraft(project?.id)}>
            <SquarePen data-icon="inline-start" />新建对话
          </Button>
          <Button className={`justify-start ${sidebarItemClassName}`} variant="ghost" size="lg" onClick={() => showProjectForm()}>
            <FolderPlus data-icon="inline-start" />新建项目
          </Button>
        </div>
        <nav className="mt-[27px] overflow-auto [scrollbar-gutter:stable]" aria-label="任务">
          <h2 className="mx-2.25 mb-2.25 text-xs/[1.5] font-[550] text-muted-foreground">任务</h2>
          {loaded && !data.projects.length && <p className="mx-2.25 text-xs/[1.65] text-muted-foreground">创建项目后，任务会显示在这里。</p>}
          {data.projects.map(item => {
            const isCollapsed = collapsed.has(item.id);
            const projectTasks = data.tasks.filter(entry => entry.projectId === item.id);
            return (
              <div key={item.id} className="py-0.5">
                <div className="flex min-w-0 items-center">
                  <div className="group/project relative min-w-0 flex-1 rounded-lg hover:bg-foreground/4">
                    <Button variant="ghost"
                      className={`w-full justify-start gap-2 overflow-hidden hover:bg-transparent! aria-[current=page]:bg-foreground/9! aria-[current=page]:hover:bg-foreground/9! ${sidebarItemBaseClassName}`}
                      aria-current={view.overview && view.projectId === item.id ? "page" : undefined}
                      onClick={() => navigate({ projectId: item.id, overview: true })}>
                      <span className="flex-none group-hover/project:opacity-0 group-has-[:focus-visible]/project:opacity-0 [@media(hover:none)]:opacity-0" aria-hidden="true">
                        {isCollapsed ? <Folder /> : <FolderOpen />}
                      </span>
                      <span className="truncate">{item.name}</span>
                      {item.status === "preparing" && <small className="ms-auto text-muted-foreground">准备中</small>}
                      {item.status === "unavailable" && <small className="ms-auto text-muted-foreground">不可用</small>}
                    </Button>
                    <Button variant="ghost" size="icon-xs"
                      className="absolute inset-s-1.75 top-1 opacity-0 transition-none active:translate-none! aria-expanded:bg-transparent group-hover/project:opacity-100 group-has-[:focus-visible]/project:opacity-100 hover:bg-foreground/9! [@media(hover:none)]:opacity-100"
                      aria-label={`${isCollapsed ? "展开" : "收起"} ${item.name}`}
                      aria-expanded={!isCollapsed} aria-controls={`project-tasks-${item.id}`}
                      onClick={() => toggleProject(item.id)}>
                      {isCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                    </Button>
                  </div>
                  {item.status === "failed" && (
                    <Button variant="ghost" size="xs" aria-label={`重试创建 ${item.name}`} onClick={() => showProjectForm(item)}>重试</Button>
                  )}
                </div>
                <div id={`project-tasks-${item.id}`} inert={isCollapsed}
                  className={`grid transition-[grid-template-rows] duration-200 ease-in-out motion-reduce:transition-none ${isCollapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"}`}>
                  <div className="min-h-0 overflow-hidden">
                    {projectTasks.map(entry => (
                      <Button key={entry.id} variant="ghost"
                        className={`mt-0.5 flex w-full justify-start overflow-hidden ps-8.5 aria-[current=page]:bg-foreground/9! aria-[current=page]:hover:bg-foreground/9! ${sidebarItemClassName}`}
                        aria-current={view.id === entry.id ? "page" : undefined}
                        onClick={() => navigate({ id: entry.id, projectId: item.id, existing: true })}>
                        <span className="truncate">{entry.title}</span>
                        {entry.status === "running" && <span className="ms-auto size-1.5 flex-none rounded-full bg-sidebar-primary" aria-label="执行中" />}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </nav>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-col">
        <header className={`flex flex-none items-center gap-2.5 px-6.5 [@media(max-width:680px)]:px-3 ${view.existing ? "h-[46px]" : "h-15.5 [@media(max-width:680px)]:h-13"}`}>
          <Button className="hidden [@media(max-width:680px)]:inline-flex" variant="ghost" size="icon" aria-label="打开侧栏" onClick={() => setMobileMenu(true)}><Menu /></Button>
          {view.existing && task ? (
            <div className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
              {project && (
                <>
                  <Button type="button" variant="ghost" size="sm" title="在此项目中新建对话"
                    className="min-w-0 shrink gap-2.25 font-normal hover:bg-accent dark:hover:bg-accent"
                    onClick={() => startDraft(project.id)}>
                    <Folder data-icon="inline-start" /><span className="truncate">{project.name}</span>
                  </Button>
                  <ChevronRight className="size-3.5 flex-none" />
                </>
              )}
              <strong className="truncate font-[550] text-foreground">{task.title}</strong>
            </div>
          ) : null}
        </header>
        {loadError && <div className="px-6.5 text-[13px] text-destructive" role="alert">{loadError} <Button variant="ghost" onClick={() => void refresh()}>重试</Button></div>}
        {view.overview ? (
          <section className="flex-1" aria-label={`${project?.name ?? "项目"}概览`} />
        ) : (
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
              void refresh();
            }}
            refresh={refresh}
          />
        )}
        {view.existing && task && <TaskLocation id={task.id} />}
      </main>
      <Dialog open={!!projectForm} onOpenChange={open => { if (!open && !projectForm?.pending) setProjectForm(undefined); }}>
        <DialogContent showCloseButton={!projectForm?.pending}>
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
            {projectForm?.error && <p role="alert" className="text-[13px] text-destructive">{projectForm.error}</p>}
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
