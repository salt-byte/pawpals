import { describe, it, expect } from "vitest";
import path from "path";
import { safeUploadPath } from "./upload-path.ts";

/**
 * safeUploadPath 是安全边界第 4 条：多用户下 dir 是上传者自己的目录，文件名
 * 是攻击者可控的输入。`path.basename` 会先吃掉目录部分，所以像
 * "../../evil.txt" 这种输入在 basename 之后只剩 "evil.txt"——traversal 被
 * 天然拆解，落点仍在 dir 内，这是正确行为，不是"应该被拒绝"。
 *
 * 真正应该返回 null 的，是 basename+替换之后整个名字退化成空、"."或".."的
 * 情况——这时候没有安全的文件名可用，必须让调用方 400，不能编个名字兜底。
 *
 * resolve 再核对前缀这一步是纵深防御：只要 base 不含路径分隔符、不等于".."，
 * 结果就必然落在 dir 内；这条断言保证了这一点，即使未来正则字符集改动也不会
 * 悄悄放过一个能跳出 dir 的名字。
 */
describe("safeUploadPath", () => {
  const dir = "/tmp/pawpals-test-user/uploads";
  const resolvedDir = path.resolve(dir);

  it("目录穿越被 basename 拆解，落点仍在 dir 内——不是逃逸而是被收编", () => {
    expect(safeUploadPath(dir, "../../evil.txt")).toBe(path.join(resolvedDir, "evil.txt"));
    expect(safeUploadPath(dir, "../../../etc/passwd")).toBe(path.join(resolvedDir, "passwd"));
    expect(safeUploadPath(dir, "/etc/passwd")).toBe(path.join(resolvedDir, "passwd"));
    expect(safeUploadPath(dir, "a/../../b")).toBe(path.join(resolvedDir, "b"));
  });

  it("退化成空、'.'或'..'的名字被拒绝，返回 null", () => {
    expect(safeUploadPath(dir, "")).toBeNull();
    expect(safeUploadPath(dir, ".")).toBeNull();
    expect(safeUploadPath(dir, "..")).toBeNull();
    expect(safeUploadPath(dir, "///")).toBeNull(); // basename("///") === "" -> 退化成空
  });

  it("非法字符被替换成下划线，不等于 '..' 的相似名字仍然放行", () => {
    // 字面反斜杠不是 POSIX 路径分隔符，basename 不认识它；替换后变成 ".._evil"，
    // 不等于 ".."，是一个合法（虽然丑）的文件名，落点仍在 dir 内。
    const dest = safeUploadPath(dir, "..\\evil");
    expect(dest).toBe(path.join(resolvedDir, ".._evil"));
  });

  it("中文等 unicode 文件名原样保留", () => {
    const dest = safeUploadPath(dir, "简历(最终版) v2.pdf");
    expect(dest).toBe(path.join(resolvedDir, "简历(最终版) v2.pdf"));
  });

  it("已经安全的名字原样落在 dir 内", () => {
    const dest = safeUploadPath(dir, "resume.pdf");
    expect(dest).toBe(path.join(resolvedDir, "resume.pdf"));
  });

  it("shell 元字符等危险字符被替换成下划线", () => {
    const dest = safeUploadPath(dir, "resume;rm -rf.pdf");
    expect(dest).toBe(path.join(resolvedDir, "resume_rm -rf.pdf"));
  });

  it("文件名里带空字节，被白名单当成非法字符换掉，落点仍在 dir 内", () => {
    const dest = safeUploadPath(dir, "resume\0.pdf");
    expect(dest).not.toBeNull();
    expect(dest!.includes("\0")).toBe(false);
    expect(dest!.startsWith(resolvedDir + path.sep)).toBe(true);
  });

  it("穷举一批常见绕过手法：结果要么是 null，要么必须落在 dir 内——绝不允许跳出去", () => {
    const attempts = [
      "../../evil.txt", "../../../etc/passwd", "/etc/passwd", "", ".", "..",
      "///", "..\\evil", "a/../../b", "....//....//etc/passwd",
      "resume;rm -rf.pdf", "简历(最终版) v2.pdf", "resume.pdf", "~/.ssh/id_rsa",
    ];
    for (const name of attempts) {
      const dest = safeUploadPath(dir, name);
      if (dest !== null) {
        expect(dest.startsWith(resolvedDir + path.sep)).toBe(true);
      }
    }
  });
});
