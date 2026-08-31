/**
 * 官网申请的推进决策。
 *
 * 关键是顺序：很多招聘站会解析上传的简历并把结果**覆盖**到表单里。先填字段
 * 再让用户传简历，填进去的姓名邮箱电话会被解析结果冲掉，而我们已经告诉用户
 * 「已填写 N 个字段」了。
 *
 * 所以页面上还有没选文件的简历附件字段时，先停下来等用户上传，之后再填——
 * 那时填的是「修正解析错误」，不会被覆盖。
 */

export type InspectionField = { kind?: string; signature?: string; [k: string]: unknown };

export type Inspection = {
  ok?: boolean;
  error?: string;
  warnings?: string[];
  fields?: InspectionField[];
} | null | undefined;

export type ApplicationPlan =
  | { action: "abort"; reason: string }
  | { action: "await_resume_upload"; fields: InspectionField[] }
  | { action: "fill"; fields: InspectionField[] };

export function planApplicationStep(inspection: Inspection): ApplicationPlan {
  if (!inspection || !inspection.ok) {
    return { action: "abort", reason: inspection?.error || "未知错误" };
  }

  const fields = Array.isArray(inspection.fields) ? inspection.fields : [];
  const warnings = Array.isArray(inspection.warnings) ? inspection.warnings : [];

  if (warnings.includes("resume_requires_user_file_selection")) {
    return { action: "await_resume_upload", fields };
  }

  return { action: "fill", fields };
}
