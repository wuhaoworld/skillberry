"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Tabs } from "@base-ui/react/tabs";
import Image from "next/image";
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, Menu, Plus, SquarePen, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { Project, Workbench as WorkspaceData } from "@/lib/workbench";
import { Conversation } from "./conversation";
import { ProjectSkills } from "./project-skills";

type ProjectTab = "conversations" | "skills";
type View =
  | { id: string; projectId?: string; existing?: boolean; overview?: never }
  | { id?: never; projectId: string; existing?: never; overview: true; tab?: ProjectTab };
type ProjectForm = { id: string; name: string; pending: boolean; error?: string };

const initialData: WorkspaceData = { projects: [], tasks: [], models: [] };
const sandboxActivityInterval = 5 * 60_000;
const minSidebarWidth = 220;
const maxSidebarWidth = 500;
const sidebarItemBaseClassName = "font-normal active:not-aria-[haspopup]:translate-y-0";
const sidebarItemClassName = `${sidebarItemBaseClassName} hover:bg-foreground/4!`;

export function Workbench() {
  const [data, setData] = useState(initialData);
  const [view, setView] = useState<View>({ id: "" });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [projectForm, setProjectForm] = useState<ProjectForm>();
  const [mobileMenu, setMobileMenu] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(250);
  const sidebarDrag = useRef<{ x: number; width: number }>(null);
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
      const params = new URL(window.location.href).searchParams;
      const taskId = params.get("task");
      const projectId = params.get("project");
      if (!taskId && projectId) {
        setView({ projectId, overview: true, tab: params.get("tab") === "skills" ? "skills" : "conversations" });
      } else {
        setView({ id: taskId || crypto.randomUUID(), existing: Boolean(taskId) });
      }
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
    if (next.overview) url.searchParams.set("project", next.projectId);
    else url.searchParams.delete("project");
    if (next.overview && next.tab === "skills") url.searchParams.set("tab", "skills");
    else url.searchParams.delete("tab");
    window.history.replaceState(null, "", url);
    setMobileMenu(false);
  }

  function startDraft(projectId?: string) {
    navigate({ id: crypto.randomUUID(), projectId });
  }

  function resizeSidebar(width: number) {
    setSidebarWidth(Math.min(maxSidebarWidth, Math.max(minSidebarWidth, width)));
  }

  const task = data.tasks.find(item => item.id === view.id);
  const project = data.projects.find(item => item.id === (task?.projectId ?? view.projectId));
  const readyProjectId = project?.status === "ready" ? project.id : undefined;

  useEffect(() => {
    if (!readyProjectId) return;
    const endpoint = `/api/projects/${readyProjectId}/sandbox`;
    let lastRequest = -Infinity;
    let lastActivity = 0;
    let pendingActivity: number | undefined;

    function reportActivity() {
      pendingActivity = undefined;
      lastRequest = performance.now();
      // Measure idle time from the interaction, even if reporting it was delayed.
      const age = Math.floor(lastRequest - lastActivity);
      void fetch(`${endpoint}?activityAgeMs=${age}`, { method: "POST" }).catch(() => {});
    }

    function queueActivity() {
      if (document.hidden) return;
      lastActivity = performance.now();
      if (pendingActivity !== undefined) return;
      const wait = Math.max(0, lastRequest + sandboxActivityInterval - lastActivity);
      pendingActivity = window.setTimeout(reportActivity, wait);
    }

    queueActivity();
    document.addEventListener("visibilitychange", queueActivity);
    window.addEventListener("pointerdown", queueActivity);
    window.addEventListener("keydown", queueActivity);
    window.addEventListener("wheel", queueActivity, { passive: true });
    return () => {
      window.clearTimeout(pendingActivity);
      document.removeEventListener("visibilitychange", queueActivity);
      window.removeEventListener("pointerdown", queueActivity);
      window.removeEventListener("keydown", queueActivity);
      window.removeEventListener("wheel", queueActivity);
    };
  }, [readyProjectId]);

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
    <div className="grid h-dvh grid-cols-[var(--sidebar-width)_minmax(0,1fr)] overflow-hidden bg-background [@media(max-width:680px)]:grid-cols-1"
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      {mobileMenu && (
        <button className="fixed inset-0 z-19 hidden bg-foreground/25 [@media(max-width:680px)]:block"
          tabIndex={-1} aria-label="关闭侧栏遮罩" onClick={() => setMobileMenu(false)} />
      )}
      <aside
        className="relative flex min-h-0 flex-col border-e border-sidebar-border bg-sidebar px-4 py-5.5 text-sidebar-foreground [@media(max-width:680px)]:invisible [@media(max-width:680px)]:fixed [@media(max-width:680px)]:inset-y-0 [@media(max-width:680px)]:left-0 [@media(max-width:680px)]:z-20 [@media(max-width:680px)]:w-[min(280px,85vw)] [@media(max-width:680px)]:-translate-x-full [@media(max-width:680px)]:data-open:visible [@media(max-width:680px)]:data-open:translate-x-0"
        id="workbench-sidebar" data-open={mobileMenu ? "" : undefined} aria-label="项目和任务"
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
                <div className="group/project relative flex min-w-0 items-center rounded-lg hover:bg-foreground/4">
                  <Button variant="ghost"
                    className={`w-full min-w-0 justify-start gap-2 overflow-hidden hover:bg-transparent! aria-[current=page]:bg-foreground/9! aria-[current=page]:hover:bg-foreground/9! ${item.status === "failed" ? "pe-20" : "pe-9"} ${sidebarItemBaseClassName}`}
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
                  <div className="absolute inset-e-1 top-1 flex items-center gap-0.5">
                    {item.status === "failed" && (
                      <Button variant="ghost" size="xs" aria-label={`重试创建 ${item.name}`} onClick={() => showProjectForm(item)}>重试</Button>
                    )}
                    <Button variant="ghost" size="icon-xs" aria-label={`在 ${item.name} 中新建对话`} title="在此项目中新建对话"
                      className="pointer-events-none opacity-0 transition-none active:translate-none! group-hover/project:pointer-events-auto group-hover/project:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 hover:bg-foreground/9! [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
                      onClick={() => startDraft(item.id)}>
                      <Plus className="size-4" />
                    </Button>
                  </div>
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
        <div role="separator" tabIndex={0} aria-label="调整侧栏宽度" aria-controls="workbench-sidebar"
          aria-orientation="vertical" aria-valuemin={minSidebarWidth} aria-valuemax={maxSidebarWidth} aria-valuenow={sidebarWidth}
          className="absolute inset-y-0 -end-1 z-10 w-2 cursor-col-resize touch-none select-none outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-0.5 hover:before:bg-sidebar-ring focus-visible:before:bg-sidebar-ring active:before:bg-sidebar-ring [@media(max-width:680px)]:hidden"
          onPointerDown={event => {
            if (event.button !== 0 || !event.isPrimary) return;
            event.preventDefault();
            sidebarDrag.current = { x: event.clientX, width: sidebarWidth };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {
            const drag = sidebarDrag.current;
            if (drag && event.currentTarget.hasPointerCapture(event.pointerId)) {
              resizeSidebar(drag.width + event.clientX - drag.x);
            }
          }}
          onLostPointerCapture={() => { sidebarDrag.current = null; }}
          onKeyDown={event => {
            const width = {
              ArrowLeft: sidebarWidth - 10,
              ArrowRight: sidebarWidth + 10,
              Home: minSidebarWidth,
              End: maxSidebarWidth,
            }[event.key];
            if (width === undefined) return;
            event.preventDefault();
            resizeSidebar(width);
          }}
        />
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
          ) : view.overview && project ? (
            <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{project.name}</span>
            </div>
          ) : null}
        </header>
        {loadError && <div className="px-6.5 text-[13px] text-destructive" role="alert">{loadError} <Button variant="ghost" onClick={() => void refresh()}>重试</Button></div>}
        {view.overview ? project ? (
          <Tabs.Root key={project.id} value={view.tab ?? "conversations"} className="flex min-h-0 flex-1 flex-col"
            onValueChange={value => navigate({ projectId: project.id, overview: true, tab: value as ProjectTab })}>
            <Tabs.List aria-label="项目视图" className="flex shrink-0 gap-5 border-b px-6.5 [@media(max-width:680px)]:px-4">
              {([["conversations", "对话"], ["skills", "Skills"]] as const).map(([value, label]) => (
                <Tabs.Tab key={value} value={value} className="-mb-px border-b-2 border-transparent px-1 py-2.5 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:border-primary data-active:text-foreground">
                  {label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            <Tabs.Panel value="conversations" className="min-h-0 flex-1 overflow-auto px-6.5 py-6 [@media(max-width:680px)]:px-4">
              <div className="mx-auto grid max-w-5xl gap-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-heading text-xl font-semibold tracking-tight">项目对话</h2>
                  <Button type="button" onClick={() => startDraft(project.id)}><SquarePen data-icon="inline-start" />新建对话</Button>
                </div>
                {data.tasks.some(item => item.projectId === project.id) ? (
                  <ul className="divide-y rounded-xl border">
                    {data.tasks.filter(item => item.projectId === project.id).map(item => (
                      <li key={item.id}>
                        <Button variant="ghost" className="h-11 w-full justify-start gap-2 px-3 font-normal"
                          onClick={() => navigate({ id: item.id, projectId: project.id, existing: true })}>
                          <span className="truncate">{item.title}</span><ChevronRight className="ms-auto shrink-0 text-muted-foreground" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-muted-foreground">这个项目还没有对话。</p>}
              </div>
            </Tabs.Panel>
            <Tabs.Panel value="skills" className="min-h-0 flex-1 overflow-auto px-6.5 py-6 [@media(max-width:680px)]:px-4">
              <div className="mx-auto max-w-5xl">
                <ProjectSkills projectId={project.id} onChange={refresh} />
              </div>
            </Tabs.Panel>
          </Tabs.Root>
        ) : (
          <p className="px-6.5 text-sm text-muted-foreground">{loaded ? "项目不存在。" : "正在加载项目…"}</p>
        ) : (
          <Conversation key={view.id} id={view.id} existing={Boolean(view.existing || task)} loaded={loaded}
            modelOptions={data.models} projects={data.projects} project={project} task={task}
            busy={data.tasks.some(item => item.projectId === project?.id && item.id !== view.id && item.status === "running")}
            onProject={id => setView(previous => ({ ...previous, projectId: id }))}
            onNewProject={showProjectForm}
            onManageSkills={projectId => navigate({ projectId, overview: true, tab: "skills" })}
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
