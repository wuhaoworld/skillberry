"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, getToolName, type UIMessage } from "ai";
import { cn } from "cn";
import { ArrowUp, Check, ChevronDown, FilePenLine, FileText, Folder, Layers, LoaderCircle, Plus, Square } from "lucide-react";
import { Streamdown } from "streamdown";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "@/components/ui/input-group";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent,
  MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import type { Model, Project, Task, Workbench } from "@/lib/workbench";
import { SkillPicker } from "./skill-picker";

type Props = {
  id: string;
  existing: boolean;
  loaded: boolean;
  modelOptions: Model[];
  projects: Project[];
  project?: Project;
  task?: Task;
  busy: boolean;
  onProject: (id: string) => void;
  onNewProject: () => void;
  onManageSkills: (projectId: string) => void;
  onAccepted: (id: string, projectId: string) => void;
  refresh: () => Promise<void>;
};

const transport = new DefaultChatTransport({
  api: "/api/chat",
  prepareSendMessagesRequest: ({ body }) => ({ body: body ?? {} }),
});

const labels = {
  running: "执行中",
  completed: "已完成",
  stopped: "已停止",
  failed: "执行失败",
};

export function Conversation(props: Props) {
  const { id, existing, project, task, modelOptions, refresh } = props;
  const [draft, setDraft] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [stage, setStage] = useState("");
  const [pendingRun, setPendingRun] = useState("");
  const [stoppingRun, setStoppingRun] = useState("");
  const [actionError, setActionError] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(existing);
  const accepted = useRef(false);
  const requestKey = useRef<{ text: string; projectId: string; model: string; id: string }>(null);
  const form = useRef<HTMLFormElement>(null);
  const { messages, sendMessage, status, error, clearError, setMessages } = useChat({
    id,
    transport,
    onData(part) {
      if (part.type !== "data-stage" || typeof part.data !== "string") return;
      setStage(part.data);
      if (!accepted.current && requestKey.current) {
        accepted.current = true;
        props.onAccepted(id, requestKey.current.projectId);
      }
    },
  });

  const sending = status === "submitted" || status === "streaming" || Boolean(pendingRun);
  const running = sending || task?.status === "running";
  const runId = pendingRun || task?.runId;
  const stopping = Boolean(runId && (stoppingRun === runId || task?.stopping && task.runId === runId));
  const model = selectedModel || (modelOptions.some(item => item.id === task?.model) ? task?.model : modelOptions[0]?.id);
  const modelName = modelOptions.find(item => item.id === model)?.name;
  const canSend = Boolean(id && !loadingHistory && project?.status === "ready" && modelName && draft.trim() && !running && !props.busy && !task?.contextLost);
  const lastStatus = task?.status;
  const lastRun = task?.runId;

  useEffect(() => {
    if (!existing || sending) return;
    const controller = new AbortController();

    async function load() {
      try {
        const response = await fetch(`/api/workbench?task=${encodeURIComponent(id)}`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(response.status === 404 ? "任务不存在，请新建对话。" : "暂时无法读取任务历史。");
        const snapshot: Workbench = await response.json();
        if (controller.signal.aborted) return;
        if (snapshot.task) setMessages(snapshot.task.messages);
        setLoadingHistory(false);
      } catch (cause) {
        if (!controller.signal.aborted) setActionError(cause instanceof Error ? cause.message : "暂时无法读取任务历史。");
      }
    }

    void load();
    const interval = lastStatus === "running" ? setInterval(() => { void load(); }, 1_500) : undefined;
    return () => { controller.abort(); clearInterval(interval); };
  }, [id, existing, sending, lastStatus, lastRun, setMessages]);

  async function runPrompt(text: string, key: string, modelId: string, retry = false) {
    if (!project) return;
    requestKey.current = { id: key, text, projectId: project.id, model: modelId };
    setPendingRun(key);
    setStoppingRun("");
    setActionError("");
    setStage("正在准备工作区");
    clearError();
    if (!retry) setDraft("");
    accepted.current = false;
    try {
      await sendMessage(
        { id: key, messageId: retry ? key : undefined, role: "user", parts: [{ type: "text", text }] },
        { body: { id: key, taskId: id, projectId: project.id, model: modelId, text, retry } },
      );
    } catch {
      setActionError("提交失败，请刷新任务记录后重试。");
    } finally {
      if (!accepted.current && !retry) {
        setDraft(current => current || text);
        setMessages(current => current.filter(message => message.id !== key));
      } else {
        requestKey.current = null;
      }
      await refresh();
      setPendingRun("");
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend || !project || !model) return;
    const text = draft.trim();
    const previous = requestKey.current;
    const key = previous?.text === text && previous.projectId === project.id && previous.model === model
      ? previous.id : crypto.randomUUID();
    void runPrompt(text, key, model);
  }

  const retryMessage = task?.retryable && !running && !props.busy && project?.status === "ready"
    && modelOptions.some(item => item.id === task.model)
    ? messages.find(message => message.id === task.runId)?.parts.find(part => part.type === "text")
    : undefined;

  async function stop() {
    if (!runId || stopping) return;
    setStoppingRun(runId);
    setActionError("");
    try {
      const response = await fetch("/api/chat", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: runId, taskId: id }),
      });
      if (!response.ok) throw new Error();
      if (!(await response.json()).stopping) setStoppingRun("");
      await refresh();
    } catch {
      setStoppingRun("");
      setActionError("停止请求失败，请重试。");
    }
  }

  const notice = actionError || (props.busy ? "这个项目正在执行其他任务，请等当前轮次结束。"
    : task?.contextLost ? "原对话上下文已无法恢复。请在此项目中新建对话。"
    : project?.status === "unavailable" ? "项目文件工作区已无法恢复，历史对话仍可查看。"
    : project?.status === "preparing" ? "正在准备项目。"
    : props.loaded && !modelOptions.length ? "模型尚未配置，请设置服务端模型凭证。"
    : selectedModel && !modelName ? "该模型当前不可用，请重新选择。"
    : error?.message || task?.error || "");

  const isChat = existing || running;
  return (
    <section className="relative flex min-h-0 flex-1 flex-col" aria-label={isChat ? "任务对话" : "新建对话"}>
      {isChat ? (
        <MessageScrollerProvider autoScroll defaultScrollPosition="end">
          <MessageScroller className="flex-1">
            <MessageScrollerViewport aria-label="对话记录">
              <MessageScrollerContent className="mx-auto w-[calc(100%-52px)] max-w-3xl py-5.5 [@media(max-width:680px)]:w-[calc(100%-28px)]">
                {loadingHistory && !messages.length && <p className="text-[13px] text-muted-foreground">正在加载任务记录</p>}
                {messages.map((message, index) => (
                  <MessageScrollerItem key={message.id} messageId={message.id}>
                    <ChatMessage message={message} running={running && index === messages.length - 1} />
                  </MessageScrollerItem>
                ))}
                {(running || task?.status === "stopped" || task?.status === "failed") && (
                  <div className="flex items-center gap-2 text-[13px] text-muted-foreground" role="status">
                    {running && <LoaderCircle className="size-3.5 motion-safe:animate-spin" />}
                    {running ? (stopping ? "正在停止" : sending ? stage || "正在准备工作区" : "Agent 正在执行")
                      : task && labels[task.status]}
                  </div>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton aria-label="滚动到最新消息" />
          </MessageScroller>
        </MessageScrollerProvider>
      ) : (
        <h1 className="mx-4.5 grid flex-1 place-items-center text-center font-heading text-[clamp(24px,3vw,32px)]/[1.35] font-normal tracking-tight">
          有什么我能帮你的吗？
        </h1>
      )}
      <div className={cn(
        "mx-auto mt-auto w-[calc(100%-52px)] max-w-3xl flex-none text-foreground [@media(max-width:680px)]:w-[calc(100%-28px)]",
        isChat ? "mb-5.5" : "mb-[clamp(22px,5vh,52px)]",
      )}>
        {notice && <p className="mx-1 mb-2 text-[13px] text-destructive" role="status">{notice}</p>}
        <div className={isChat ? undefined : "rounded-3xl bg-[#FAFAFA]"}>
          {!isChat && (
            <div className="px-2.75 pt-1.5 pb-1.25">
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="secondary" size="sm" className="max-w-full rounded-full" />}>
                  <Folder data-icon="inline-start" /><span className="truncate">{project?.name ?? "选择项目"}</span><ChevronDown data-icon="inline-end" />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" aria-label="选择项目" className="min-w-[min(270px,calc(100vw-34px))] rounded-xl">
                  <DropdownMenuGroup>
                    {props.projects.map(item => (
                      <DropdownMenuItem key={item.id} disabled={item.status !== "ready"} onClick={() => props.onProject(item.id)}>
                        <Folder /><span className="truncate">{item.name}</span>
                        {item.id === project?.id && <Check className="ml-auto" />}
                        {item.status !== "ready" && <span className="ml-auto text-xs">未就绪</span>}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                  {props.projects.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuGroup><DropdownMenuItem onClick={props.onNewProject}><Plus />新建项目</DropdownMenuItem></DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
          <form ref={form} onSubmit={submit}>
            <InputGroup className="min-h-[117px] rounded-2xl bg-card text-card-foreground has-[[data-slot=input-group-control]:focus-visible]:border-input has-[[data-slot=input-group-control]:focus-visible]:ring-0 dark:bg-card">
              <InputGroupTextarea aria-label="任务描述"
                className="max-h-[min(26vh,210px)] min-h-[65px] px-4 pt-3.5 pb-1.5 text-[15px] md:text-[15px]"
                value={draft} maxLength={20_000}
                placeholder={isChat ? "继续这项任务…" : "描述你想完成的任务"}
                onChange={event => setDraft(event.target.value)}
                onKeyDown={event => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                    event.preventDefault();
                    form.current?.requestSubmit();
                  }
                }} />
              <InputGroupAddon align="block-end" className="flex-wrap justify-end px-2.75 pt-1.25 pb-2.75">
                {task && retryMessage && (
                  <Button type="button" variant="ghost" className="mr-auto"
                    onClick={() => void runPrompt(retryMessage.text, task.runId, task.model, true)}>重试本轮</Button>
                )}
                {project && (
                  <SkillPicker key={project.id} project={project} disabled={running}
                    onManage={() => props.onManageSkills(project.id)}
                    onSelect={name => {
                      const mention = `用 ${name} `;
                      setDraft(current => current.startsWith(mention) || current.length + mention.length > 20_000
                        ? current : mention + current);
                    }} />
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button type="button" variant="ghost" disabled={!modelOptions.length} />}>
                    {modelName || "选择模型"}<ChevronDown data-icon="inline-end" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="end" aria-label="选择模型" className="min-w-[190px]">
                    <DropdownMenuRadioGroup value={model ?? ""} onValueChange={setSelectedModel}>
                      {modelOptions.map(item => <DropdownMenuRadioItem key={item.id} value={item.id} closeOnClick>{item.name}</DropdownMenuRadioItem>)}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                {running ? (
                  <Button type="button" size="icon" className="rounded-full" aria-label="停止执行" disabled={stopping || !runId} onClick={stop}><Square /></Button>
                ) : (
                  <Button type="submit" size="icon" className="rounded-full" aria-label="发送任务" disabled={!canSend}><ArrowUp /></Button>
                )}
              </InputGroupAddon>
            </InputGroup>
          </form>
        </div>
      </div>
    </section>
  );
}

function ChatMessage({ message, running }: { message: UIMessage; running: boolean }) {
  const user = message.role === "user";
  const assistant = message.role === "assistant";
  return (
    <Message align={user ? "end" : "start"}>
      <MessageContent>
        {message.parts.map((part, index) => {
          if (part.type === "text") {
            return (
              <Bubble key={index} align={user ? "end" : "start"} variant={user ? "tinted" : "ghost"} className={user ? "max-w-[min(90%,620px)]" : undefined}>
                <BubbleContent className={cn("text-[15px]/[1.7] wrap-anywhere", !assistant && "whitespace-pre-wrap")}>
                  {assistant ? (
                    <Streamdown isAnimating={running && part.state === "streaming"}>
                      {part.text}
                    </Streamdown>
                  ) : part.text}
                </BubbleContent>
              </Bubble>
            );
          }
          if (part.type === "data-skill-used" && typeof part.data === "string") {
            return (
              <Trace key={index}>
                <TraceLine><TraceIcon><Layers /></TraceIcon><TraceTitle>已使用 {part.data}</TraceTitle></TraceLine>
              </Trace>
            );
          }
          if (!isToolUIPart(part)) return null;
          const toolName = getToolName(part);
          const writing = toolName === "writeProjectFile";
          const readingSkill = toolName === "readSkillFile";
          const finished = part.state === "output-available";
          const failed = part.state === "output-error";
          if (toolName === "Skill" && finished) return null;
          const input = part.input;
          const skillPath = readingSkill && input && typeof input === "object" &&
            "name" in input && typeof input.name === "string" && "path" in input && typeof input.path === "string"
            ? `${input.name}/${input.path}` : null;
          const description = failed ? "操作未完成" : finished ? "操作完成" : running ? "执行中" : "已中断";
          return (
            <Trace key={part.toolCallId}>
              <TraceLine status={failed ? "error" : finished ? undefined : running ? "running" : "pending"}>
                <TraceIcon>{writing ? <FilePenLine /> : <FileText />}</TraceIcon>
                <TraceTitle className={skillPath ? "wrap-anywhere whitespace-normal" : undefined}>
                  {writing ? "写入项目文件" : toolName === "readProjectFile" ? "读取项目文件" :
                    readingSkill ? "读取 Skill" : toolName === "Skill" ? "加载 Skill" : "项目操作"}
                  {skillPath && <> · <code>{skillPath}</code></>}
                </TraceTitle>
                {(!readingSkill || failed || (!finished && !running)) && <TraceDescription>{description}</TraceDescription>}
              </TraceLine>
            </Trace>
          );
        })}
      </MessageContent>
    </Message>
  );
}
