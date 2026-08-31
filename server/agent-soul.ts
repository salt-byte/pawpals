/**
 * 把 agent 人设（SOUL.md）从仓库模板铺到用户工作区。
 *
 * loadAgentSoul() 读的是 CAREER_DIR/workspaces/<agentId>/SOUL.md，而模板在
 * resources/openclaw-template/ 下。这两者之间原本由 bootstrap-pawpals-runtime.mjs
 * 搬运，但它的 npm 入口随 openclaw 一起被删掉后，就没有任何东西再调用它——
 * 于是 7 份人设一直没进用户工作区，所有 agent 跑的都是内联的一句话兜底 prompt。
 *
 * 只铺缺失的，永不覆盖：用户工作区里已有的内容可能被改过，冲掉是不可逆的。
 * 代价是模板更新后老用户拿不到——需要时由显式的迁移动作处理，而不是每次启动
 * 都悄悄重写。
 */

export type SoulSeedItem = { agentId: string };

export function planSoulSeed(
  agentIds: string[],
  fs: {
    /** 仓库模板里有没有这个 agent 的 SOUL.md */
    templateExists: (agentId: string) => boolean;
    /** 用户工作区里是不是已经有了 */
    destExists: (agentId: string) => boolean;
  }
): SoulSeedItem[] {
  return agentIds
    .filter((id) => fs.templateExists(id) && !fs.destExists(id))
    .map((agentId) => ({ agentId }));
}
