import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateLegacyWorkspace } from "./migration.ts";

function scratch() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pawpals-migrate-"));
  const legacy = path.join(root, "workspace", "career");
  mkdirSync(path.join(legacy, "workspaces", "career-planner"), { recursive: true });
  writeFileSync(path.join(legacy, "profile.md"), "# 我");
  writeFileSync(path.join(legacy, "workspaces", "career-planner", "SOUL.md"), "soul");
  writeFileSync(path.join(root, "pet.json"), '{"name":"团团"}');
  return { root, legacy, target: path.join(root, "users", "local", "career") };
}

describe("migrateLegacyWorkspace", () => {
  it("整体搬到 users/local/career，原目录改名为 career.migrated 而非删除", () => {
    const { root, legacy, target } = scratch();
    const r = migrateLegacyWorkspace({
      legacyDir: legacy, targetDir: target, fs,
      extraFiles: [{ from: path.join(root, "pet.json"), to: path.join(root, "users", "local", "pet.json") }],
    });
    expect(r).toBe("migrated");
    expect(readFileSync(path.join(target, "profile.md"), "utf-8")).toBe("# 我");
    expect(readFileSync(path.join(target, "workspaces", "career-planner", "SOUL.md"), "utf-8")).toBe("soul");
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(path.join(root, "workspace", "career.migrated"))).toBe(true);
    expect(readFileSync(path.join(root, "users", "local", "pet.json"), "utf-8")).toContain("团团");
  });

  it("幂等：目标已存在就跳过，什么都不动", () => {
    const { legacy, target } = scratch();
    migrateLegacyWorkspace({ legacyDir: legacy, targetDir: target, fs });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "profile.md"), "新的");
    expect(migrateLegacyWorkspace({ legacyDir: legacy, targetDir: target, fs })).toBe("skipped-target-exists");
    expect(readFileSync(path.join(target, "profile.md"), "utf-8")).toBe("# 我");
    expect(existsSync(legacy)).toBe(true);
  });

  it("没有旧数据（全新部署）就跳过", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pawpals-migrate-"));
    expect(migrateLegacyWorkspace({ legacyDir: path.join(root, "nope"), targetDir: path.join(root, "users", "local", "career"), fs })).toBe("skipped-no-legacy");
  });

  it("extraFiles 里不存在的文件跳过，不影响主迁移", () => {
    const { root, legacy, target } = scratch();
    const r = migrateLegacyWorkspace({ legacyDir: legacy, targetDir: target, fs, extraFiles: [{ from: path.join(root, "missing.json"), to: path.join(root, "users", "local", "missing.json") }] });
    expect(r).toBe("migrated");
  });

  it("上次崩溃留下的暂存目录被丢弃，而不是合并进新拷贝", () => {
    const { legacy, target } = scratch();
    const staging = target + ".partial";
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "leftover-from-crash.txt"), "垃圾");

    const r = migrateLegacyWorkspace({ legacyDir: legacy, targetDir: target, fs });

    expect(r).toBe("migrated");
    expect(existsSync(path.join(target, "leftover-from-crash.txt"))).toBe(false);
    expect(readFileSync(path.join(target, "profile.md"), "utf-8")).toBe("# 我");
    expect(readFileSync(path.join(target, "workspaces", "career-planner", "SOUL.md"), "utf-8")).toBe("soul");
  });

  it("迁移成功后暂存目录不会留下来", () => {
    const { legacy, target } = scratch();
    migrateLegacyWorkspace({ legacyDir: legacy, targetDir: target, fs });
    expect(existsSync(target + ".partial")).toBe(false);
  });

  it("extraFiles 提前拷贝也照样落地，缺失的仍然只是跳过而不报错", () => {
    const { root, legacy, target } = scratch();
    const petDest = path.join(root, "users", "local", "pet.json");
    const r = migrateLegacyWorkspace({
      legacyDir: legacy,
      targetDir: target,
      fs,
      extraFiles: [
        { from: path.join(root, "pet.json"), to: petDest },
        { from: path.join(root, "missing.json"), to: path.join(root, "users", "local", "missing.json") },
      ],
    });
    expect(r).toBe("migrated");
    expect(readFileSync(petDest, "utf-8")).toContain("团团");
    expect(existsSync(path.join(root, "users", "local", "missing.json"))).toBe(false);
  });

  it("旧目录改名失败不会中止迁移——数据已经安全落地在 targetDir", () => {
    const { legacy, target } = scratch();
    const flakyFs: typeof fs = {
      ...fs,
      renameSync: (from: fs.PathLike, to: fs.PathLike) => {
        if (from === legacy) throw new Error("模拟旧目录改名失败");
        return fs.renameSync(from, to);
      },
    };

    const r = migrateLegacyWorkspace({ legacyDir: legacy, targetDir: target, fs: flakyFs });

    expect(r).toBe("migrated");
    expect(readFileSync(path.join(target, "profile.md"), "utf-8")).toBe("# 我");
    expect(readFileSync(path.join(target, "workspaces", "career-planner", "SOUL.md"), "utf-8")).toBe("soul");
    // 旧目录还在原地（改名失败），既没被删除也没被覆盖。
    expect(existsSync(legacy)).toBe(true);
  });
});
