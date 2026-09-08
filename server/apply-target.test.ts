import { describe, it, expect } from "vitest";
import { extractApplyTarget } from "./apply-target.ts";

/**
 * 「投哪个岗位」是从哪来的。
 *
 * 真机：用户发「帮我投递这个官网申请：https://…  公司：帆软  岗位：秋招」，投递
 * 管家只把要做的事复述了一遍，apply_job 一次都没被调用，服务端零条日志。
 *
 * 原因是目标 URL 只从三个地方找——扩展上报的当前页面、协作表、上次搜索结果——
 * **用户消息里自己贴的链接从来没被用过**。而那是任何人拿到内推链接后最自然的用法。
 */
describe("extractApplyTarget", () => {
  const board = [{ company: "字节跳动", role: "产品经理", jdUrl: "https://jobs.bytedance.com/x" }];
  const search = [{ company: "腾讯", role: "运营", jdUrl: "https://join.qq.com/y" }];

  it("消息里贴了链接就用它——这是最直接的意图", () => {
    const t = extractApplyTarget({
      message: "帮我投递这个官网申请：https://t6.jiandaoyun.com/f/abc  公司：帆软  岗位：秋招",
      board, searchResults: search, activePage: null,
    });
    expect(t?.jdUrl).toBe("https://t6.jiandaoyun.com/f/abc");
  });

  it("顺带认出消息里写的公司和岗位", () => {
    const t = extractApplyTarget({
      message: "投递 https://a.com/f/1 公司：帆软 岗位：2027届秋季校园招聘",
      board: [], searchResults: [], activePage: null,
    });
    expect(t?.company).toBe("帆软");
    expect(t?.role).toBe("2027届秋季校园招聘");
  });

  it("只认 https——http 的申请页不投", () => {
    expect(extractApplyTarget({
      message: "投递 http://insecure.com/f/1", board: [], searchResults: [], activePage: null,
    })).toBeNull();
  });

  it("消息里没链接时，用扩展上报的当前页面", () => {
    const t = extractApplyTarget({
      message: "帮我投递", board, searchResults: search,
      activePage: { url: "https://now.com/f/9", title: "算法岗" },
    });
    expect(t?.jdUrl).toBe("https://now.com/f/9");
  });

  it("再退回协作表里名字对得上的那条", () => {
    const t = extractApplyTarget({
      message: "帮我投字节跳动", board, searchResults: search, activePage: null,
    });
    expect(t?.jdUrl).toBe("https://jobs.bytedance.com/x");
  });

  it("最后才用上次搜索结果的第一条", () => {
    const t = extractApplyTarget({
      message: "帮我投", board: [], searchResults: search, activePage: null,
    });
    expect(t?.jdUrl).toBe("https://join.qq.com/y");
  });

  it("什么都找不到就返回 null，不瞎投", () => {
    expect(extractApplyTarget({
      message: "帮我投", board: [], searchResults: [], activePage: null,
    })).toBeNull();
  });

  it("URL 末尾的中文标点不算在链接里", () => {
    const t = extractApplyTarget({
      message: "投递 https://a.com/f/1，谢谢", board: [], searchResults: [], activePage: null,
    });
    expect(t?.jdUrl).toBe("https://a.com/f/1");
  });
});
