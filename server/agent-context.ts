/**
 * Agent 启动时的自动上下文注入。
 *
 * 注入是按职责配置的，不靠关键词判断——每个 agent 一进来就带着自己该看的
 * 文件，而不是等它自己想起来去读。
 */

export type FileConf = {
  /** 相对于 career 工作区的路径 */
  path: string;
  /** 注入时的段落标签，如「用户档案」 */
  label: string;
  /** 只取文件末尾 N 行。协作日志这类只需要最近记录的文件用得上。 */
  lines?: number;
};

/**
 * 把配置里的文件读出来，包成注入用的段落。
 *
 * readFile 由调用方注入：返回 null 表示文件不存在。读不到的文件静默跳过——
 * 新用户的工作区里大部分文件都还没生成，这是正常状态而不是错误。
 */
export function buildFileInjections(
  files: FileConf[] | undefined,
  readFile: (relPath: string) => string | null
): string[] {
  const out: string[] = [];

  for (const conf of files ?? []) {
    const raw = readFile(conf.path);
    if (raw === null) continue;

    const content = conf.lines
      ? raw.split("\n").slice(-conf.lines).join("\n")
      : raw;

    if (!content.trim()) continue;
    out.push(`【${conf.label}】\n${content.trim()}`);
  }

  return out;
}
