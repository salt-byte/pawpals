import { describe, it, expect } from "vitest";
import { parseSizeLimit, pickResumeTarget, checkUploadFits } from "./upload-plan.ts";

/**
 * 简历上传的决策。
 *
 * 页面把限制写在文案里（「单个2MB以内 支持格式：pdf,docx,jpg,jpeg,png,bmp」），
 * 那是给人看的，但也够机器读。读出来的价值是：超限时能当场说清楚「你的文件
 * 2.05MB，这里只收 2MB」，而不是传上去被网站默默拒掉、用户以为传好了。
 *
 * 选错框比不传更糟——把简历传进「作品集」那个 500MB 的框，或者反过来，都是投
 * 出去才发现。所以定位必须有依据，拿不准就不传。
 */
describe("parseSizeLimit", () => {
  it("读得出 2MB", () => {
    expect(parseSizeLimit("拖拽或单击后粘贴文件，单个2MB以内 支持格式：pdf,docx")).toBe(2 * 1024 * 1024);
  });
  it("读得出 500MB", () => {
    expect(parseSizeLimit("选择 拖拽或单击后粘贴文件，单个500MB以内")).toBe(500 * 1024 * 1024);
  });
  it("读得出 KB 和小数", () => {
    expect(parseSizeLimit("最大 512KB")).toBe(512 * 1024);
    expect(parseSizeLimit("单个1.5MB以内")).toBe(Math.round(1.5 * 1024 * 1024));
  });
  it("没写限制就返回 0——不猜", () => {
    expect(parseSizeLimit("选择文件")).toBe(0);
    expect(parseSizeLimit("")).toBe(0);
  });
});

describe("pickResumeTarget", () => {
  const resume = { handle: "h1", type: "file", context: "简历附件 超过2M无法上传 单个2MB以内 支持格式：pdf,docx" };
  const works = { handle: "h2", type: "file", context: "作品集/项目材料 单个500MB以内" };

  it("按文案选中简历那个框", () => {
    expect(pickResumeTarget([works, resume])?.handle).toBe("h1");
  });
  it("只有一个文件框时就用它", () => {
    expect(pickResumeTarget([{ handle: "only", type: "file", context: "上传文件" }])?.handle).toBe("only");
  });
  it("多个文件框都看不出是简历时返回 null——传错框比不传更糟", () => {
    expect(pickResumeTarget([works, { handle: "h3", type: "file", context: "其他材料" }])).toBeNull();
  });
  it("没有文件框返回 null", () => {
    expect(pickResumeTarget([{ handle: "t", type: "text", context: "姓名" }])).toBeNull();
  });
});

describe("checkUploadFits", () => {
  it("在限制内就放行", () => {
    expect(checkUploadFits(1_000_000, 2 * 1024 * 1024).ok).toBe(true);
  });
  it("超限时说清楚差多少，不要传上去让网站默默拒掉", () => {
    const r = checkUploadFits(2_145_994, 2 * 1024 * 1024);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("2.05");
    expect(r.reason).toContain("2");
  });
  it("页面没写限制就放行——不拿臆想的限制卡用户", () => {
    expect(checkUploadFits(9_999_999, 0).ok).toBe(true);
  });
});
