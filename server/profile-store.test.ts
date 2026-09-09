import { describe, it, expect } from "vitest";
import { parseProfile, lookupField, missingFields } from "./profile-store.ts";

/**
 * 用户信息的结构化知识库。
 *
 * 之前信息散在三处：全局 CLAUDE.md（学历/专业/经历）、resume_master.md（手写摘录）、
 * 用户脑子里（民族/学号/出差意向）。而填表只读第二处——真机实测 resume_master.md
 * 里「学位」「毕业时间」「出生年月」「民族」「学号」「籍贯」的出现次数**全是 0**。
 *
 * 后果是这些字段模型从头到尾都在猜：同一个「学位」在不同轮次里填成过工学、管理学、
 * 文学。而候选人读的是传播/数据科学，三个都不对。
 *
 * 所以知识库的价值不在「检索」，在**「已知的字段永远不经过模型」**——查得到就直接
 * 填，连猜的机会都不给；查不到就如实说不知道，去问用户。
 */
const SAMPLE = `# 用户档案

## 基本信息
- 姓名: 邓雨蝶
- 邮箱: yudieden@usc.edu
- 手机: 13800138000
- 民族: 汉族

## 教育背景
### 本科 · 北京电影学院
- 专业: 文化产业管理
- 毕业时间: 2024-06
- 成绩排名: 前5%

### 硕士 · 清华大学
- 专业: 数据传播
- 学位: 文学
- 毕业时间: 2027-06

## 求职偏好
- 出差意向: 低频率短时间
`;

describe("parseProfile", () => {
  it("读出扁平的键值", () => {
    const p = parseProfile(SAMPLE);
    expect(p["姓名"]).toBe("邓雨蝶");
    expect(p["民族"]).toBe("汉族");
    expect(p["出差意向"]).toBe("低频率短时间");
  });

  it("带小节前缀，避免同名字段互相覆盖", () => {
    const p = parseProfile(SAMPLE);
    // 本科和硕士都有「专业」和「毕业时间」，不能互相盖掉
    expect(p["本科·专业"]).toBe("文化产业管理");
    expect(p["硕士·专业"]).toBe("数据传播");
    expect(p["本科·毕业时间"]).toBe("2024-06");
    expect(p["硕士·毕业时间"]).toBe("2027-06");
  });

  it("空档案返回空对象，不炸", () => {
    expect(parseProfile("")).toEqual({});
  });
});

describe("lookupField", () => {
  const p = parseProfile(SAMPLE);

  it("表单字段名直接命中", () => {
    expect(lookupField(p, "民族")?.value).toBe("汉族");
  });

  it("认得出「本科专业」指的是本科那一节的专业", () => {
    expect(lookupField(p, "本科专业")?.value).toBe("文化产业管理");
    expect(lookupField(p, "研究生专业")?.value).toBe("数据传播");
  });

  it("认得出毕业时间分本科和研究生", () => {
    expect(lookupField(p, "本科毕业时间")?.value).toBe("2024-06");
    expect(lookupField(p, "研究生毕业时间")?.value).toBe("2027-06");
  });

  it("学位来自档案，不再靠猜——真机上它猜成过工学/管理学/文学三种", () => {
    expect(lookupField(p, "学位")?.value).toBe("文学");
  });

  it("带上出处，供反编造闸门核验", () => {
    const hit = lookupField(p, "民族");
    expect(hit?.source).toContain("民族");
    expect(hit?.source).toContain("汉族");
  });

  it("查不到就返回 null——不猜、不近似", () => {
    expect(lookupField(p, "学号")).toBeNull();
    expect(lookupField(p, "血型")).toBeNull();
  });
});

describe("missingFields", () => {
  it("列出档案里没有的那些", () => {
    const p = parseProfile(SAMPLE);
    expect(missingFields(p, ["民族", "学号", "籍贯", "出差意向"])).toEqual(["学号", "籍贯"]);
  });

  it("全都有时返回空", () => {
    expect(missingFields(parseProfile(SAMPLE), ["民族"])).toEqual([]);
  });
});

/**
 * 占位符不是答案。
 *
 * 档案里用「待确认」标记还没问到的字段。要是把它当成有效值返回，就会在雇主的
 * 表单里出现「民族：待确认」——比空着糟得多，空着人家会问，填了这个是当场露怯。
 */
describe("待确认不算答案", () => {
  const p = parseProfile("## 基本信息\n- 民族: 待确认\n- 姓名: 邓雨蝶\n- 籍贯: 待补充\n- 学号: TBD\n");

  it("待确认 / 待补充 / TBD 一律当作查不到", () => {
    expect(lookupField(p, "民族")).toBeNull();
    expect(lookupField(p, "籍贯")).toBeNull();
    expect(lookupField(p, "学号")).toBeNull();
  });

  it("带括号说明的占位符也认得出", () => {
    const q = parseProfile("- 学位: 待确认（文学 / 理学？）\n");
    expect(lookupField(q, "学位")).toBeNull();
  });

  it("真答案不受影响", () => {
    expect(lookupField(p, "姓名")?.value).toBe("邓雨蝶");
  });

  it("missingFields 把占位符算成缺失", () => {
    expect(missingFields(p, ["姓名", "民族"])).toEqual(["民族"]);
  });
});

/**
 * 同名小节不能互相覆盖。
 *
 * 用户有两个硕士（清华 · 数据传播、USC · Communication Data Science）。后写的
 * 把先写的盖掉之后，「研究生学校」查出来是 USC——而帆软那张表的下拉里只有国内
 * 高校，正确答案是清华。
 *
 * 取第一个：档案里把主修/国内那个写在前面，这个约定比「按学校名去猜哪个对」可靠。
 */
describe("同名小节取第一个", () => {
  const p = parseProfile(`## 教育背景
### 硕士 · 清华大学
- 学校: 清华大学
- 专业: 数据传播

### 硕士 · USC
- 学校: University of Southern California
- 专业: Communication Data Science
`);

  it("研究生学校取写在前面的那个", () => {
    expect(lookupField(p, "研究生学校")?.value).toBe("清华大学");
    expect(lookupField(p, "研究生专业")?.value).toBe("数据传播");
  });
});
