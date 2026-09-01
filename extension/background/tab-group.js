/**
 * 把扩展自己开的标签页归进一个带名字的分组。
 *
 * 自主开页之后，用户看到浏览器里多出几个标签页，却无从判断是谁开的。Chrome
 * 的标签分组能给它们一个带颜色的标题，一眼可辨——Claude in Chrome 用的也是
 * 这个 API。
 *
 * 归组纯粹是可视化，失败了绝不能影响投递本身，所以所有异常都吞掉，返回 null。
 */
export const GROUP_TITLE = 'PawPals 投递';
const GROUP_COLOR = 'orange';

export function createTabGrouper({ groupTabs, updateGroup, queryGroups }) {
  /** 缓存分组 id。service worker 被回收时会丢，靠 queryGroups 按标题找回。 */
  let groupId = null;

  async function resolveExistingGroup() {
    if (groupId !== null) return groupId;
    try {
      const groups = await queryGroups({ title: GROUP_TITLE });
      const found = (groups ?? []).find((group) => group.title === GROUP_TITLE);
      if (found) {
        groupId = found.id;
        return groupId;
      }
    } catch {
      // 查不了就当没有，下面新建
    }
    return null;
  }

  /** 新建分组并命名。返回新分组 id，失败返回 null。 */
  async function createGroup(tabId) {
    const created = await groupTabs({ tabIds: [tabId] });
    groupId = created;
    try {
      await updateGroup(created, { title: GROUP_TITLE, color: GROUP_COLOR });
    } catch {
      // 建出来了但没能改标题，不影响使用
    }
    return created;
  }

  return {
    /** 把一个标签页放进分组，返回分组 id；归不了组返回 null。 */
    async add(tabId) {
      try {
        const existing = await resolveExistingGroup();
        if (existing === null) return await createGroup(tabId);

        try {
          await groupTabs({ tabIds: [tabId], groupId: existing });
          return existing;
        } catch {
          // 分组被用户关掉了，重建一个
          groupId = null;
          return await createGroup(tabId);
        }
      } catch {
        return null; // 分组 API 整个不可用：归不了组不该让投递失败
      }
    },
  };
}
