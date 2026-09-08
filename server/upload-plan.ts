/**
 * 简历上传的决策：传哪个框、传得进去吗。
 *
 * 两件事必须机械判定，不能靠模型也不能靠乐观：
 *
 *   选错框  把简历塞进「作品集」那个 500MB 的框，或者反过来，都是投出去才发现。
 *           所以定位要有文案依据，拿不准就不传。
 *   超限    页面把限制写在文案里（「单个2MB以内」），那是给人看的，但也够机器读。
 *           读出来就能当场说「你的文件 2.05MB，这里只收 2MB」，而不是传上去被
 *           网站默默拒掉、用户以为传好了。
 */

type FileControl = { handle?: string; type?: string; context?: string; [k: string]: unknown };

const UNITS: Record<string, number> = { kb: 1024, k: 1024, mb: 1024 * 1024, m: 1024 * 1024, gb: 1024 ** 3, g: 1024 ** 3 };

/** 从文案里读出单文件大小上限，读不出返回 0（表示「页面没写」）。 */
export function parseSizeLimit(context: string): number {
  const match = String(context || "").match(/(\d+(?:\.\d+)?)\s*(KB|K|MB|M|GB|G)\b/i);
  if (!match) return 0;
  const unit = UNITS[match[2].toLowerCase()];
  return unit ? Math.round(Number(match[1]) * unit) : 0;
}

/** 「这是简历框」的文案特征。刻意不含「作品集/项目材料」那类。 */
const RESUME_HINT = /简历|resume|cv\b/i;

/**
 * 选出简历该传进哪个文件框。
 *
 * 只有一个文件框时就用它——没有别的候选，选错的余地也就不存在。多个的时候必须
 * 有文案依据，否则返回 null 让上层如实上报「需要你手动选简历」。
 */
export function pickResumeTarget(controls: FileControl[] = []): FileControl | null {
  const files = controls.filter((control) => String(control.type || "") === "file");
  if (files.length === 0) return null;
  if (files.length === 1) return files[0];
  const hits = files.filter((control) => RESUME_HINT.test(String(control.context || "")));
  return hits.length === 1 ? hits[0] : null;
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(2).replace(/\.?0+$/, "");

/** 文件塞得进去吗。limit 为 0 表示页面没写限制，一律放行——不拿臆想的限制卡用户。 */
export function checkUploadFits(bytes: number, limit: number): { ok: boolean; reason?: string } {
  if (!limit || bytes <= limit) return { ok: true };
  return { ok: false, reason: `文件 ${mb(bytes)}MB，超过页面允许的 ${mb(limit)}MB` };
}
