/**
 * 单人版数据迁移到多用户布局。
 *
 * 首次以多用户模式启动时，把 workspace/career/ 整体搬到 users/local/career/。
 * 幂等：目标存在就不再搬。原目录改名为 career.migrated 而不是删除——出错可以
 * 手工回滚。先复制再改名，中途崩了也不会丢数据。
 */
import path from "node:path";

type MigrateFs = {
  existsSync(p: string): boolean;
  mkdirSync(p: string, o: { recursive: true }): void;
  cpSync(src: string, dest: string, o: { recursive: true }): void;
  renameSync(from: string, to: string): void;
  copyFileSync(from: string, to: string): void;
};

export function migrateLegacyWorkspace(opts: {
  legacyDir: string;
  targetDir: string;
  /** career 之外的用户级文件，比如 pet.json。缺了就跳过。 */
  extraFiles?: { from: string; to: string }[];
  fs: MigrateFs;
}): "migrated" | "skipped-target-exists" | "skipped-no-legacy" {
  const { legacyDir, targetDir, fs } = opts;
  if (fs.existsSync(targetDir)) return "skipped-target-exists";
  if (!fs.existsSync(legacyDir)) return "skipped-no-legacy";

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(legacyDir, targetDir, { recursive: true });
  for (const { from, to } of opts.extraFiles ?? []) {
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  fs.renameSync(legacyDir, legacyDir + ".migrated");
  return "migrated";
}
