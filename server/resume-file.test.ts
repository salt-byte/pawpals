import { describe, it, expect } from "vitest";
import { pickResumeFile } from "./resume-file.ts";

/**
 * 简历原件在哪。
 *
 * 之前只存了从 PDF 抽出来的 markdown，原件没留——所以「自动上传简历」缺的不是
 * 能力（DataTransfer 那条路真机验证过），是**文件本身**。
 *
 * 找的顺序从明确到模糊，找不到就返回 null 让上层如实说「我没有你的简历原件」，
 * 绝不拿一个碰巧同名的文件顶上——投出去的要是别人的简历，那是不可撤销的。
 */
describe("pickResumeFile", () => {
  const files = (list: string[]) => (dir: string) => list.filter((f) => f.startsWith(dir)).map((f) => f.slice(dir.length + 1));

  it("环境变量指定的优先", () => {
    const hit = pickResumeFile({
      envPath: "/x/我的简历.pdf",
      dirs: ["/career", "/downloads"],
      exists: (p) => p === "/x/我的简历.pdf",
      list: files([]),
    });
    expect(hit).toBe("/x/我的简历.pdf");
  });

  it("环境变量指了个不存在的文件就当没指，继续往下找", () => {
    const hit = pickResumeFile({
      envPath: "/x/没有.pdf",
      dirs: ["/career"],
      exists: (p) => p === "/career/resume.pdf",
      list: files(["/career/resume.pdf"]),
    });
    expect(hit).toBe("/career/resume.pdf");
  });

  it("按文件名认简历", () => {
    const hit = pickResumeFile({
      dirs: ["/downloads"],
      exists: () => true,
      list: files(["/downloads/年度总结.pdf", "/downloads/张小明简历.pdf", "/downloads/论文.pdf"]),
    });
    expect(hit).toBe("/downloads/张小明简历.pdf");
  });

  it("只认简历相关的扩展名", () => {
    const hit = pickResumeFile({
      dirs: ["/downloads"],
      exists: () => true,
      list: files(["/downloads/简历.txt", "/downloads/简历.pdf"]),
    });
    expect(hit).toBe("/downloads/简历.pdf");
  });

  it("多个都像简历时返回 null——传错了是不可撤销的", () => {
    const hit = pickResumeFile({
      dirs: ["/downloads"],
      exists: () => true,
      list: files(["/downloads/简历2024.pdf", "/downloads/简历2025.pdf"]),
    });
    expect(hit).toBeNull();
  });

  it("一个都没有就返回 null，不拿同名文件顶上", () => {
    const hit = pickResumeFile({ dirs: ["/downloads"], exists: () => true, list: files(["/downloads/照片.jpg"]) });
    expect(hit).toBeNull();
  });

  it("前面的目录优先——career 目录里的比下载目录里的可信", () => {
    const hit = pickResumeFile({
      dirs: ["/career", "/downloads"],
      exists: () => true,
      list: files(["/career/resume.pdf", "/downloads/我的简历.pdf"]),
    });
    expect(hit).toBe("/career/resume.pdf");
  });
});
