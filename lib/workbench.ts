import type { UIMessage } from "ai";

export type Project = {
  id: string;
  name: string;
  status: "preparing" | "ready" | "failed" | "unavailable";
  updatedAt: number;
};

export type RunStatus = "running" | "completed" | "failed" | "stopped";

export type Task = {
  id: string;
  projectId: string;
  title: string;
  updatedAt: number;
  runId: string;
  model: string;
  status: RunStatus;
  error: string | null;
  stopping: boolean;
  retryable: boolean;
  contextLost: boolean;
};

export type TaskDetail = Task & { messages: UIMessage[] };
export type Model = { id: string; name: string };
export type Workbench = { projects: Project[]; tasks: Task[]; models: Model[]; task?: TaskDetail };
