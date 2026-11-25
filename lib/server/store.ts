import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { UIMessage } from "ai";
import type { HarnessAgentResumeSessionState } from "@ai-sdk/harness/agent";
import type { InstalledSkill, Project, RunStatus, Task, TaskDetail } from "@/lib/workbench";
import type { SkillBundle } from "./skill-package";

const directory = resolve(/* turbopackIgnore: true */ process.env.SKILLBERRY_DATA_DIR || ".skillberry");
const leaseDuration = 90_000;
export const retryableStartupError = "无法启动项目工作区，请重试本轮。";
const interrupted = "上次执行中断。可以查看已保存的输出，再发送一条消息。";

function openStore() {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolve(directory, "workbench.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
      updatedAt INTEGER NOT NULL, lease INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL, updatedAt INTEGER NOT NULL, resume TEXT,
      contextLost INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id),
      projectId TEXT NOT NULL REFERENCES projects(id), model TEXT NOT NULL,
      status TEXT NOT NULL, error TEXT, stopping INTEGER NOT NULL DEFAULT 0,
      lease INTEGER NOT NULL, prompt TEXT NOT NULL, response TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_run_per_project ON runs(projectId) WHERE status = 'running';
    CREATE INDEX IF NOT EXISTS task_runs ON runs(taskId);
    CREATE TABLE IF NOT EXISTS skill_versions (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
      digest TEXT NOT NULL, description TEXT NOT NULL, bundle TEXT NOT NULL, fileCount INTEGER NOT NULL,
      UNIQUE (projectId, name, digest)
    );
    CREATE TABLE IF NOT EXISTS skills (
      projectId TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
      versionId TEXT NOT NULL REFERENCES skill_versions(id), enabled INTEGER NOT NULL,
      PRIMARY KEY (projectId, name)
    );
    CREATE TABLE IF NOT EXISTS run_skills (
      runId TEXT NOT NULL REFERENCES runs(id), versionId TEXT NOT NULL REFERENCES skill_versions(id),
      PRIMARY KEY (runId, versionId)
    );
    CREATE INDEX IF NOT EXISTS run_skill_versions ON run_skills(versionId);
  `);
  return db;
}

let database: DatabaseSync | undefined;

function db() {
  return database ??= openStore();
}

function transaction<T>(operation: () => T): T {
  db().exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db().exec("COMMIT");
    return result;
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
}

function expireRuns() {
  db().prepare(`UPDATE runs SET status = 'failed', error = ? WHERE status = 'running' AND lease < ?`)
    .run(interrupted, Date.now());
}

export function getProjects() {
  db().prepare("UPDATE projects SET status = 'failed' WHERE status = 'preparing' AND lease < ?").run(Date.now());
  type ProjectRow = Omit<Project, "enabledSkills"> & { enabledSkills: string };
  const rows = db().prepare(`
    SELECT id, name, status, updatedAt, (
      SELECT json_group_array(s.name ORDER BY s.name) FROM skills s WHERE s.projectId = p.id AND s.enabled = 1
    ) AS enabledSkills
    FROM projects p ORDER BY updatedAt DESC
  `).all() as ProjectRow[];
  return rows.map(row => ({ ...row, enabledSkills: JSON.parse(row.enabledSkills) as string[] }));
}

export function projectExists(projectId: string) {
  return Boolean(db().prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId));
}

export function projectIsReady(projectId: string) {
  return Boolean(db().prepare("SELECT 1 FROM projects WHERE id = ? AND status = 'ready'").get(projectId));
}

const skillsQuery = `
  SELECT s.name, s.versionId, s.enabled, v.description, v.fileCount
  FROM skills s JOIN skill_versions v ON v.id = s.versionId WHERE s.projectId = ?
`;

function installedSkill(row: unknown): InstalledSkill {
  const skill = row as InstalledSkill;
  return { ...skill, enabled: Boolean(skill.enabled) };
}

export function getProjectSkills(projectId: string) {
  return db().prepare(skillsQuery + " ORDER BY s.name").all(projectId).map(installedSkill);
}

export function getProjectSkill(projectId: string, name: string) {
  const row = db().prepare(skillsQuery + " AND s.name = ?").get(projectId, name);
  return row && installedSkill(row);
}

export function installProjectSkill(projectId: string, bundle: SkillBundle, expectedVersion: string | null) {
  const { name, description, files } = bundle;
  const serialized = JSON.stringify(bundle);
  const digest = createHash("sha256").update(serialized).digest("hex");

  return transaction(() => {
    const current = getProjectSkill(projectId, name);
    const existing = db().prepare("SELECT id FROM skill_versions WHERE projectId = ? AND name = ? AND digest = ?")
      .get(projectId, name, digest);
    if (current && current.versionId === existing?.id && current.enabled) return current;
    if ((current?.versionId ?? null) !== expectedVersion) return;
    const versionId = existing ? String(existing.id) : randomUUID();
    if (!existing) {
      db().prepare(`
        INSERT INTO skill_versions (id, projectId, name, digest, description, bundle, fileCount)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(versionId, projectId, name, digest, description, serialized, files.length + 1);
    }
    db().prepare(`
      INSERT INTO skills (projectId, name, versionId, enabled) VALUES (?, ?, ?, 1)
      ON CONFLICT(projectId, name) DO UPDATE SET versionId = excluded.versionId, enabled = excluded.enabled
    `).run(projectId, name, versionId);
    return getProjectSkill(projectId, name);
  });
}

export function setProjectSkillEnabled(projectId: string, name: string, versionId: string, enabled: boolean) {
  return transaction(() => {
    const result = db().prepare("UPDATE skills SET enabled = ? WHERE projectId = ? AND name = ? AND versionId = ?")
      .run(Number(enabled), projectId, name, versionId);
    return result.changes ? getProjectSkill(projectId, name) : undefined;
  });
}

export function deleteProjectSkill(projectId: string, name: string, versionId: string) {
  return transaction(() => {
    const result = db().prepare("DELETE FROM skills WHERE projectId = ? AND name = ? AND versionId = ?")
      .run(projectId, name, versionId);
    if (!result.changes) return false;
    db().prepare(`
      DELETE FROM skill_versions WHERE projectId = ? AND name = ?
      AND NOT EXISTS (SELECT 1 FROM run_skills WHERE versionId = skill_versions.id)
    `).run(projectId, name);
    return true;
  });
}

export function beginProject(id: string, name: string) {
  return transaction(() => {
    const existing = db().prepare("SELECT * FROM projects WHERE id = ?").get(id);
    if (existing?.name !== undefined && existing.name !== name && existing.status !== "failed") return "conflict";
    if (existing?.status === "ready") return "ready";
    if (existing?.status === "unavailable") return "unavailable";
    const now = Date.now();
    if (existing?.status === "preparing" && Number(existing.lease) >= now) return "busy";
    db().prepare(`
      INSERT INTO projects (id, name, status, updatedAt, lease) VALUES (?, ?, 'preparing', ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = 'preparing', lease = excluded.lease
    `).run(id, name, now, now + leaseDuration);
    return now + leaseDuration;
  });
}

export function endProject(id: string, lease: number, status: Project["status"]) {
  db().prepare("UPDATE projects SET status = ?, updatedAt = ?, lease = 0 WHERE id = ? AND lease = ?")
    .run(status, Date.now(), id, lease);
}

const taskQuery = `
  SELECT t.id, t.projectId, t.title, t.updatedAt, r.id AS runId, r.model, r.status, r.error, r.stopping, t.contextLost
  FROM tasks t JOIN runs r ON r.rowid = (SELECT max(rowid) FROM runs WHERE taskId = t.id)
`;

function taskSummary(row: unknown): Task {
  const value = row as Task;
  return { ...value, stopping: Boolean(value.stopping), contextLost: Boolean(value.contextLost),
    retryable: value.status === "failed" && value.error === retryableStartupError };
}

export function getTasks() {
  expireRuns();
  return db().prepare(taskQuery + " ORDER BY t.updatedAt DESC").all().map(taskSummary);
}

export function getTask(id: string): TaskDetail | undefined {
  expireRuns();
  const row = db().prepare(taskQuery + " WHERE t.id = ?").get(id);
  if (!row) return;
  const messages = db().prepare("SELECT id, prompt, response FROM runs WHERE taskId = ? ORDER BY rowid")
    .all(id).flatMap((run): UIMessage[] => {
      const user: UIMessage = { id: String(run.id), role: "user", parts: [{ type: "text", text: String(run.prompt) }] };
      return run.response ? [user, JSON.parse(String(run.response)) as UIMessage] : [user];
    });
  return { ...taskSummary(row), messages };
}

export function beginRun(input: { id: string; taskId: string; projectId: string; model: string; text: string; retry?: boolean }) {
  return transaction(() => {
    expireRuns();
    const project = db().prepare("SELECT status FROM projects WHERE id = ?").get(input.projectId);
    if (project?.status !== "ready") return { error: "请选择一个已就绪的项目。" };
    const task = db().prepare("SELECT projectId, resume, contextLost FROM tasks WHERE id = ?").get(input.taskId);
    if (task && task.projectId !== input.projectId) return { error: "任务不属于这个项目。" };
    if (task?.contextLost) return { error: "原对话上下文已无法恢复。请在此项目中新建对话。" };
    const priorRun = db().prepare(`
      SELECT id, taskId, projectId, model, status, error, prompt FROM runs WHERE id = ?
    `).get(input.id);
    if (input.retry) {
      const latest = db().prepare("SELECT id FROM runs WHERE taskId = ? ORDER BY rowid DESC LIMIT 1").get(input.taskId);
      if (latest?.id !== input.id || priorRun?.taskId !== input.taskId || priorRun.projectId !== input.projectId ||
        priorRun.model !== input.model || priorRun.prompt !== input.text || priorRun.status !== "failed" ||
        priorRun.error !== retryableStartupError) {
        return { error: "此轮已执行或状态已变化，请刷新任务记录。" };
      }
    } else if (priorRun) {
      return { error: "这条消息已提交，请查看任务记录。" };
    }
    if (db().prepare("SELECT 1 FROM runs WHERE projectId = ? AND status = 'running'").get(input.projectId)) {
      return { error: "这个项目正在执行另一轮任务，请等它结束。" };
    }

    const now = Date.now();
    const text = input.text.replace(/\s+/g, " ");
    const characters = Array.from(text);
    const title = characters.length > 32 ? characters.slice(0, 32).join("") + "…" : text;
    db().prepare(`
      INSERT INTO tasks(id, projectId, title, updatedAt) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updatedAt = excluded.updatedAt
    `).run(input.taskId, input.projectId, title, now);
    db().prepare("UPDATE projects SET updatedAt = ? WHERE id = ?").run(now, input.projectId);
    if (input.retry) {
      db().prepare("UPDATE runs SET status = 'running', lease = ?, error = NULL, stopping = 0 WHERE id = ?")
        .run(now + leaseDuration, input.id);
    } else {
      db().prepare(`
        INSERT INTO runs (id, taskId, projectId, model, status, lease, prompt)
        VALUES (?, ?, ?, ?, 'running', ?, ?)
      `).run(input.id, input.taskId, input.projectId, input.model, now + leaseDuration, input.text);
      db().prepare(`
        INSERT INTO run_skills (runId, versionId)
        SELECT ?, versionId FROM skills WHERE projectId = ? AND enabled = 1
      `).run(input.id, input.projectId);
    }
    const skills = db().prepare(`
      SELECT v.bundle FROM run_skills r JOIN skill_versions v ON v.id = r.versionId
      WHERE r.runId = ? ORDER BY v.name
    `).all(input.id).map(row => JSON.parse(String(row.bundle)) as SkillBundle);
    return { skills, resume: task?.resume ? JSON.parse(String(task.resume)) as HarnessAgentResumeSessionState : undefined };
  });
}

export function heartbeat(id: string) {
  return db().prepare(`UPDATE runs SET lease = ? WHERE id = ? AND status = 'running' RETURNING stopping`)
    .get(Date.now() + leaseDuration, id);
}

export function requestStop(taskId: string, runId: string) {
  return db().prepare("UPDATE runs SET stopping = 1 WHERE id = ? AND taskId = ? AND status = 'running'")
    .run(runId, taskId).changes > 0;
}

export function saveResponse(id: string, message: UIMessage) {
  db().prepare("UPDATE runs SET response = ? WHERE id = ? AND status = 'running'")
    .run(JSON.stringify(message), id);
}

export function endRun(input: {
  id: string; taskId: string; projectId: string; status: RunStatus;
  error: string | null; resume?: HarnessAgentResumeSessionState;
  contextLost: boolean; workspaceLost: boolean;
}) {
  transaction(() => {
    const result = db().prepare("UPDATE runs SET status = ?, error = ? WHERE id = ? AND status = 'running'")
      .run(input.status, input.error, input.id);
    if (result.changes === 0) return;
    if (input.resume) {
      db().prepare("UPDATE tasks SET resume = ? WHERE id = ?").run(JSON.stringify(input.resume), input.taskId);
    }
    if (input.contextLost) db().prepare("UPDATE tasks SET contextLost = 1 WHERE id = ?").run(input.taskId);
    if (input.workspaceLost) db().prepare("UPDATE projects SET status = 'unavailable' WHERE id = ?").run(input.projectId);
  });
}
