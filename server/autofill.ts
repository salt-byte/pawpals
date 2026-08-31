/**
 * 网申表单自动填写的取值逻辑。
 *
 * 字段分类由扩展侧的 schema.js:fieldKind 在页面上算好（它看得见 label、
 * placeholder、aria-label 这些 DOM 信息），服务端这里只按 kind 取值——
 * 不再用另一套正则重新猜一遍。
 *
 * 此前两侧各猜各的：扩展分出了 first_name / last_name，服务端却用
 * /full name|your name|姓名|名字|name/ 一网打尽，"First Name" 和
 * "Last Name" 都会被填成全名。Greenhouse、Lever 的表单基本都是拆开的。
 */

export type AutofillProfile = {
  name: string;
  email: string;
  phone: string;
  linkedin: string;
  portfolio: string;
};

export type AutofillContext = { title?: string; company?: string };

/** 常见复姓。列表之外一律按单字姓处理。 */
const COMPOUND_SURNAMES = [
  "欧阳", "司马", "上官", "诸葛", "东方", "独孤", "慕容", "皇甫",
  "尉迟", "南宫", "长孙", "宇文", "夏侯", "澹台", "公孙", "令狐",
];

const CJK_ONLY = /^[一-龥]+$/;

/**
 * 拆出名与姓。
 *
 * 中文按「姓在前」，英文按「姓在最后」——这也是中文名填英文表单时的通行
 * 做法（First Name 填名，Last Name 填姓）。只有一个词时不臆造姓，宁可留空。
 */
export function splitName(full: string): { first: string; last: string } {
  const name = String(full || "").trim();
  if (!name) return { first: "", last: "" };

  if (CJK_ONLY.test(name)) {
    const compound = COMPOUND_SURNAMES.find((s) => name.startsWith(s) && name.length > s.length);
    const surnameLen = compound ? compound.length : 1;
    if (name.length <= surnameLen) return { first: name, last: "" };
    return { first: name.slice(surnameLen), last: name.slice(0, surnameLen) };
  }

  const parts = name.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

/**
 * 按字段类别取要填的值。取不到就返回空串——空字段好过填错内容。
 *
 * resume / verification / sensitive_demographic 永远返回空：简历附件浏览器
 * 不允许脚本设置，验证码和性别种族这类问题必须由用户本人回答。
 */
export function pickAutofillValue(
  field: { kind: string },
  profile: AutofillProfile,
  ctx: AutofillContext = {}
): string {
  const { first, last } = splitName(profile.name);

  switch (field.kind) {
    case "full_name":  return profile.name || "";
    case "first_name": return first;
    case "last_name":  return last;
    case "email":      return profile.email || "";
    case "phone":      return profile.phone || "";
    case "linkedin":   return profile.linkedin || "";
    case "portfolio":  return profile.portfolio || "";
    case "cover_letter":
      return `您好，我对 ${ctx.company || "贵司"} 的「${ctx.title || "该岗位"}」很感兴趣，相关经历与岗位方向匹配，期待进一步沟通。`;
    default:
      return "";
  }
}
