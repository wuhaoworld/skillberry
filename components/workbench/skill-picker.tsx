"use client";

import { useEffect, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { ChevronRight, Plus, Puzzle, Search, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { InstalledSkill, Project } from "@/lib/workbench";

const rowClassName = "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none";

export function SkillPicker({ project, disabled, onManage, onSelect }: {
  project: Project;
  disabled: boolean;
  onManage: () => void;
  onSelect: (name: string) => void;
}) {
  const { id, enabledSkills } = project;
  const count = enabledSkills.length;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [descriptions, setDescriptions] = useState<Map<string, string>>();

  useEffect(() => {
    if (!open || !count) return;
    const controller = new AbortController();

    async function loadDescriptions() {
      try {
        const response = await fetch(`/api/projects/${id}/skills`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const skills: InstalledSkill[] = await response.json();
        if (!controller.signal.aborted) setDescriptions(new Map(skills.map(skill => [skill.name, skill.description])));
      } catch {
        // Names from the workbench remain available if descriptions can't be fetched.
      }
    }

    void loadDescriptions();
    return () => controller.abort();
  }, [open, id, count]);

  const query = search.trim().toLowerCase();
  const matches = enabledSkills.filter(name => name.toLowerCase().includes(query)
    || descriptions?.get(name)?.toLowerCase().includes(query));

  return (
    <Popover.Root open={open} onOpenChange={next => {
      setOpen(next);
      if (!next) setSearch("");
    }}>
      <Popover.Trigger render={<Button type="button" variant="ghost" disabled={disabled} />}
        aria-label={count ? `已启用 ${count} 个 Skills` : "技能"}>
        <Puzzle data-icon="inline-start" />{count ? `${count} 个 Skills` : "技能"}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={6} className="z-50">
          <Popover.Popup aria-label="技能选择器"
            className="flex max-h-(--available-height) w-[min(320px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-md outline-none">
            <div className="shrink-0 border-b px-1.5 py-1">
              <button type="button" className={`${rowClassName} h-9`} onClick={onManage}>
                <Plus className="size-4 shrink-0" aria-hidden="true" />添加技能
                <ChevronRight className="ml-auto size-4 shrink-0" aria-hidden="true" />
              </button>
              <button type="button" className={`${rowClassName} h-9`} onClick={onManage}>
                <SlidersHorizontal className="size-4 shrink-0" aria-hidden="true" />管理技能
              </button>
            </div>
            <div className="min-h-0 max-h-[312px] overflow-y-auto overscroll-contain px-1.5 py-1.5">
              {matches.length ? (
                <ul>
                  {matches.map(name => {
                    const description = descriptions?.get(name);
                    return (
                      <li key={name}>
                        <button type="button" className={`${rowClassName} min-h-12 items-start py-1.5`} onClick={() => {
                          setOpen(false);
                          setSearch("");
                          onSelect(name);
                        }}>
                          <Puzzle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                          <span className="min-w-0">
                            <span className="block truncate leading-5">{name}</span>
                            {description && <span className="block truncate text-xs/4 text-muted-foreground">{description}</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p role="status" className="px-2.5 py-2 text-sm text-muted-foreground">
                  {count ? "未找到匹配的技能" : "当前项目暂无已启用的技能"}
                </p>
              )}
            </div>
            <label className="flex shrink-0 items-center gap-2 border-t px-3.5 focus-within:bg-accent/50">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input type="search" aria-label="搜索技能" placeholder="搜索技能" value={search}
                onChange={event => setSearch(event.target.value)}
                className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
            </label>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
