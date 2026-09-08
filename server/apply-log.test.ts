import { describe, it, expect } from "vitest";
import { createRunLog } from "./apply-log.ts";

/**
 * 投递运行日志。
 *
 * 这个项目反复栽在同一类事上：**所有指标都说成功，只有结果是错的**。
 *   filled=8      是任务自报的条数，不是页面上真有值
 *   ok=true       只说明赋值语句没抛错
 *   probed 有数字 partial 被当成「探完了」
 *   面板打开了、选项点了、显示也变了，可页面内部状态没提交
 *
 * 所以日志要记的不是「做了什么」，而是**每一步声称的结果和页面实际状态的差**。
 * 差对不上就是一条线索，不用等真机跑十分钟去撞。
 */
describe("createRunLog", () => {
  it("记下每一步，按顺序", () => {
    const log = createRunLog("job-1");
    log.step("inspect", { fields: 40 });
    log.step("probe", { probed: 9, wanted: 15 });
    expect(log.snapshot().steps.map((s) => s.name)).toEqual(["inspect", "probe"]);
  });

  it("自报和实际对不上时标成可疑——这正是要抓的东西", () => {
    const log = createRunLog("job-1");
    log.claim("fill", { claimed: 16, actual: 0 });
    const [entry] = log.snapshot().suspicious;
    expect(entry).toMatchObject({ name: "fill", claimed: 16, actual: 0 });
  });

  it("自报和实际一致就不标", () => {
    const log = createRunLog("job-1");
    log.claim("fill", { claimed: 8, actual: 8 });
    expect(log.snapshot().suspicious).toEqual([]);
  });

  it("实际比自报还多也算可疑——那说明我们漏数了", () => {
    const log = createRunLog("job-1");
    log.claim("fill", { claimed: 0, actual: 10 });
    expect(log.snapshot().suspicious).toHaveLength(1);
  });

  it("一行摘要能直接打到控制台", () => {
    const log = createRunLog("job-1");
    log.step("inspect", { fields: 40 });
    log.claim("fill", { claimed: 16, actual: 3 });
    const line = log.summary();
    expect(line).toContain("job-1");
    expect(line).toContain("自报16");
    expect(line).toContain("实际3");
  });

  it("没有可疑项时摘要说清楚，不留白", () => {
    const log = createRunLog("job-2");
    log.step("inspect", { fields: 40 });
    expect(log.summary()).toContain("无异常");
  });

  it("步骤数有上限，长流程不会把内存吃掉", () => {
    const log = createRunLog("job-3");
    for (let i = 0; i < 500; i += 1) log.step(`s${i}`, {});
    expect(log.snapshot().steps.length).toBeLessThanOrEqual(200);
  });
});
