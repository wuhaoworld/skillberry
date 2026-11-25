import { consumeStream, createUIMessageStream, createUIMessageStreamResponse, readUIMessageStream, toUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import type { HarnessAgentResumeSessionState, HarnessAgentSession } from "@ai-sdk/harness/agent";
import { after } from "next/server";
import { z } from "zod";
import { availableModels, keepProjectAwake, networkSession, openProject, projectAgent, WorkspaceUnavailable } from "@/lib/server/environment";
import type { SkillBundle } from "@/lib/server/skill-package";
import { beginRun, endRun, heartbeat, requestStop, retryableStartupError, saveResponse } from "@/lib/server/store";
import type { RunStatus } from "@/lib/workbench";

const runKey = z.object({ taskId: z.uuid(), id: z.uuid() });
const send = runKey.extend({ projectId: z.uuid(), model: z.string(), text: z.string().trim().min(1).max(20_000), retry: z.boolean().optional() });
const skillCall = z.object({ skill: z.string() });
const skillFileCall = z.object({ name: z.string(), path: z.string() });

function redact(chunk: UIMessageChunk, skills: SkillBundle[]): UIMessageChunk | undefined {
  switch (chunk.type) {
    case "tool-input-start":
      return { type: chunk.type, toolCallId: chunk.toolCallId, toolName: chunk.toolName, dynamic: true };
    case "tool-input-available": {
      let input = null;
      if (chunk.toolName === "readSkillFile") {
        const call = skillFileCall.safeParse(chunk.input);
        if (call.success) {
          const { name, path } = call.data;
          const skill = skills.find(skill => skill.name === name);
          if (skill?.files.some(file => file.path === path)) input = { name, path };
        }
      }
      return { type: chunk.type, toolCallId: chunk.toolCallId, toolName: chunk.toolName, input, dynamic: true };
    }
    case "tool-output-available": {
      const value = chunk.output;
      if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true) {
        return { type: "tool-output-error", toolCallId: chunk.toolCallId, errorText: "操作未完成", dynamic: true };
      }
      return { type: chunk.type, toolCallId: chunk.toolCallId, output: "操作完成", dynamic: true };
    }
    case "tool-output-error":
      return { type: chunk.type, toolCallId: chunk.toolCallId, errorText: "操作未完成", dynamic: true };
    case "start":
      return { type: chunk.type, messageId: chunk.messageId };
    case "text-start":
    case "text-end":
      return { type: chunk.type, id: chunk.id };
    case "text-delta":
      return { type: chunk.type, id: chunk.id, delta: chunk.delta };
    case "finish":
      return { type: chunk.type, finishReason: chunk.finishReason };
    case "abort":
      return { type: chunk.type };
    case "error":
      return chunk;
  }
}

export async function DELETE(request: Request) {
  const input = runKey.safeParse(await request.json().catch(() => null));
  if (!input.success) return new Response("执行记录无效。", { status: 400 });
  return Response.json({ stopping: requestStop(input.data.taskId, input.data.id) });
}

export async function POST(request: Request) {
  const body = send.safeParse(await request.json().catch(() => null));
  if (!body.success) return new Response("请选择项目和模型，并输入有效任务描述。", { status: 400 });
  const input = body.data;
  if (!availableModels().some(model => model.id === input.model)) {
    return new Response("该模型当前不可用，请重新选择。", { status: 400 });
  }

  const accepted = beginRun(input);
  if (accepted.error !== undefined) return new Response(accepted.error, { status: 409 });

  const assistantId = `assistant-${input.id}`;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
  const timer = setInterval(() => {
    const state = heartbeat(input.id);
    if (!state || state.stopping) controller.abort();
  }, 500);
  const genericError = "Agent 执行失败。请检查模型配置与项目状态后再试。";

  const stream = createUIMessageStream({
    onError: () => genericError,
    execute: async ({ writer }) => {
      let status: RunStatus = "failed";
      let error: string | null = null;
      let workspaceLost = false;
      let contextLost = false;
      let session: HarnessAgentSession | undefined;
      let resume: HarnessAgentResumeSessionState | undefined;
      let latest: UIMessage | undefined;
      let workspaceOpened = false;
      let turnStarted = false;

      try {
        writer.write({ type: "data-stage", data: "正在准备工作区" });
        const sandbox = await openProject(input.projectId, signal);
        workspaceOpened = true;
        const agent = projectAgent(sandbox, signal, accepted.skills);
        // A turn can be cancelled while its bridge is still needed to save the session.
        const startup = new AbortController();
        const cancelStartup = () => startup.abort(signal.reason);
        signal.addEventListener("abort", cancelStartup, { once: true });
        if (signal.aborted) cancelStartup();
        try {
          session = await agent.createSession({
            sessionId: input.taskId, resumeFrom: accepted.resume,
            sandboxSession: networkSession(sandbox), abortSignal: startup.signal,
          });
        } finally {
          signal.removeEventListener("abort", cancelStartup);
        }
        signal.throwIfAborted();
        writer.write({ type: "data-stage", data: "Agent 正在执行" });
        turnStarted = true;
        const result = await agent.stream({ session, options: { model: input.model }, prompt: input.text, abortSignal: signal });

        let lastSave = 0;
        const skillCalls = new Map<string, string>();
        const activeSkills = new Set(accepted.skills.map(skill => skill.name));
        const [output, history] = toUIMessageStream({
          stream: result.stream,
          generateMessageId: () => assistantId,
          sendReasoning: false,
          onError: () => genericError,
          onEnd: ({ outcome }) => {
            if (outcome.status === "failed") error = genericError;
          },
        }).pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
          transform(chunk, streamController) {
            if (chunk.type === "tool-input-available" && chunk.toolName === "Skill") {
              const call = skillCall.safeParse(chunk.input);
              if (call.success && activeSkills.has(call.data.skill)) skillCalls.set(chunk.toolCallId, call.data.skill);
            }
            if (chunk.type === "tool-output-available") {
              const name = skillCalls.get(chunk.toolCallId);
              if (name) {
                streamController.enqueue({ type: chunk.type, toolCallId: chunk.toolCallId, output: "操作完成", dynamic: true });
                streamController.enqueue({ type: "data-skill-used", data: name });
                skillCalls.delete(chunk.toolCallId);
                return;
              }
            }
            const visible = redact(chunk, accepted.skills);
            if (visible) streamController.enqueue(visible);
          },
        })).tee();

        await Promise.all([
          output.pipeTo(new WritableStream({
            write(chunk) {
              if (chunk.type === "error" || (chunk.type === "finish" && chunk.finishReason === "error")) error = genericError;
              writer.write(chunk);
            },
          })),
          (async () => {
            for await (const message of readUIMessageStream({ stream: history })) {
              latest = message;
              const now = Date.now();
              if (now - lastSave >= 400 && message.parts.length) {
                saveResponse(input.id, message);
                lastSave = now;
              }
            }
          })(),
        ]);
        status = error ? "failed" : "completed";
      } catch (cause) {
        workspaceLost = cause instanceof WorkspaceUnavailable;
        contextLost = !signal.aborted && workspaceOpened && !session && Boolean(accepted.resume);
        console.error("Agent turn failed", input.id, cause instanceof Error ? cause.name : "Unknown");
        error = workspaceLost ? "项目文件工作区已无法恢复，历史对话仍可查看。"
          : contextLost ? "原对话上下文已无法恢复。请在此项目中新建对话。"
          : turnStarted ? genericError : retryableStartupError;
      } finally {
        if (session) {
          try {
            resume = await session.stop();
            contextLost = Boolean(resume.continueFrom);
          } catch (cause) {
            console.error("Agent session could not save", input.id, cause instanceof Error ? cause.name : "Unknown");
            contextLost = true;
          }
          if (contextLost) {
            status = "failed";
            error = "原对话上下文已无法恢复。请在此项目中新建对话。";
          }
        }

        if (controller.signal.aborted) {
          status = "stopped";
          error = null;
        } else if (signal.aborted) {
          status = "failed";
          error = "执行超时，请查看已有输出后重试。";
        }

        clearInterval(timer);
        if (latest?.parts.length) saveResponse(input.id, latest);
        endRun({ ...input, status, error, resume, contextLost, workspaceLost });
        if (workspaceOpened) {
          after(async () => {
            try {
              await keepProjectAwake(input.projectId, AbortSignal.timeout(10_000), false);
            } catch (cause) {
              console.warn("Could not renew sandbox after task", cause instanceof Error ? cause.name : "Unknown");
            }
          });
        }
        writer.write({ type: "data-stage", data: status === "stopped" ? "已停止" : error || "已完成" });
      }
    },
  });
  return createUIMessageStreamResponse({
    stream,
    // Keep consuming after a browser disconnect so history and the run lock settle.
    consumeSseStream: ({ stream }) => consumeStream({ stream }),
  });
}
