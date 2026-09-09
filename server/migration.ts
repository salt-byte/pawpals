/**
 * 单人版数据迁移到多用户布局。
 *
 * 首次以多用户模式启动时，把 workspace/career/ 整体搬到 users/local/career/。
 * 幂等：目标存在就不再搬。原目录改名为 career.migrated 而不是删除——出错可以
 * 手工回滚。
 *
 * 为什么要先拷进 targetDir + ".partial" 暂存目录，而不是直接拷进 targetDir：
 * 这个函数用「targetDir 是否存在」当作「迁移是否已经完成」的唯一标记。可是
 * cpSync 会在开始拷贝的那一刻就建出目标根目录，边拷边填内容——如果直接拷进
 * targetDir，中途崩溃会让 targetDir 提前存在、内容却只有一半，下一次启动看到
 * 它存在就判定「已迁移」，永远在半份数据上运行，还没人会再去看一眼原始目录。
 * 所以必须先拷进一个谁也不会去读的暂存目录，拷完之后再用一次原子 rename 把它
 * 变成 targetDir——「它存在」和「它拷完了」必须永远是同一件事。不要因为看着
 * 多了一步就把它"简化"回直接拷进 targetDir。
 */
import path from "node:path";

type MigrateFs = {
  existsSync(p: string): boolean;
  mkdirSync(p: string, o: { recursive: true }): void;
  cpSync(src: string, dest: string, o: { recursive: true }): void;
  renameSync(from: string, to: string): void;
  copyFileSync(from: string, to: string): void;
  /** 清掉上次崩溃留下的暂存目录；目标本就不存在也不算错误。 */
  rmSync(p: string, o: { recursive: true; force: true }): void;
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

  const stagingDir = targetDir + ".partial";
  // 上次崩在拷贝中途，可能留下一个内容不全的暂存目录——清掉它，否则接下来
  // 的 cpSync 会把新内容合并进旧的残留里，而不是得到一份干净的拷贝。
  fs.rmSync(stagingDir, { recursive: true, force: true });

  // extraFiles 先拷：每一份都是源→目标的原样复制，源和目标每次都相同，重跑
  // 无害。放在暂存目录 rename 之前，意味着只要 targetDir 还没出现，下一次
  // 启动就会把这些文件和 career 一起重新拷一遍，不会漏。缺了源文件就跳过，
  // 不让它拖垮整个迁移。
  for (const { from, to } of opts.extraFiles ?? []) {
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }

  fs.mkdirSync(path.dirname(stagingDir), { recursive: true });
  fs.cpSync(legacyDir, stagingDir, { recursive: true });
  // 原子 rename：targetDir 要么完整出现，要么根本不出现。
  fs.renameSync(stagingDir, targetDir);

  try {
    fs.renameSync(legacyDir, legacyDir + ".migrated");
  } catch (e: any) {
    // 数据已经安全落地在 targetDir 了，旧目录改名失败只是收尾没做完，
    // 不能因为这一步让整个服务器起不来。
    console.warn(
      `[migrate] 数据已成功迁移到 ${targetDir}，但旧目录 ${legacyDir} 改名为 ${legacyDir}.migrated 失败，` +
        `请手动重命名该目录：${e?.message ?? e}`
    );
  }
  return "migrated";
}
