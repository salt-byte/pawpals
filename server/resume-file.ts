/**
 * 找出简历原件在哪。
 *
 * 之前只存了从 PDF 抽出来的 markdown，原件没留——所以「自动上传简历」缺的从来
 * 不是能力（DataTransfer 那条路真机验证过），是**文件本身**。
 *
 * 找的顺序从明确到模糊。找不到就返回 null，让上层如实说「我没有你的简历原件，
 * 给我个路径」，绝不拿一个碰巧同名的文件顶上——投出去的要是别人的简历，或者是
 * 一篇论文，那是不可撤销的。同理，多个候选都像简历时也返回 null：宁可问一句。
 */
const RESUME_NAME = /简历|resume|cv[-_. ]/i;
const RESUME_EXT = /\.(pdf|docx?|jpe?g|png)$/i;

export function pickResumeFile(input: {
  envPath?: string;
  dirs: string[];
  exists: (path: string) => boolean;
  list: (dir: string) => string[];
}): string | null {
  const { envPath, dirs, exists, list } = input;
  // 用户明说了就听他的；指了个不存在的文件当作没指，继续往下找
  if (envPath && exists(envPath)) return envPath;

  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = list(dir) ?? [];
    } catch {
      continue;
    }
    const hits = names.filter((name) => RESUME_EXT.test(name) && RESUME_NAME.test(name));
    // 恰好一个才算数。多个的话我们分不出哪份是最新/最对的，问一句比赌一把好。
    if (hits.length === 1) return `${dir}/${hits[0]}`;
    if (hits.length > 1) return null;
  }
  return null;
}
