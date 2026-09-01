import { describe, expect, it, vi } from 'vitest';
import { createTabGrouper, GROUP_TITLE } from './tab-group.js';

function harness({ existingGroups = [], groupTabs } = {}) {
  const calls = [];
  const deps = {
    groupTabs: groupTabs ?? vi.fn(async ({ tabIds, groupId }) => {
      calls.push(`group:${tabIds.join(',')}→${groupId ?? 'new'}`);
      return groupId ?? 100;
    }),
    updateGroup: vi.fn(async (groupId, props) => { calls.push(`update:${groupId}:${props.title}`); }),
    queryGroups: vi.fn(async () => existingGroups),
  };
  return { deps, grouper: createTabGrouper(deps), calls };
}

describe('createTabGrouper', () => {
  it('第一次归组时新建分组，并设上标题和颜色', async () => {
    const { deps, grouper } = harness();
    await grouper.add(7);

    expect(deps.groupTabs).toHaveBeenCalledWith({ tabIds: [7] });
    expect(deps.updateGroup).toHaveBeenCalledWith(100, expect.objectContaining({ title: GROUP_TITLE }));
    expect(deps.updateGroup.mock.calls[0][1].color).toBeTruthy();
  });

  it('第二次复用同一个分组，不重复新建也不重复改标题', async () => {
    const { deps, grouper } = harness();
    await grouper.add(7);
    await grouper.add(8);

    expect(deps.groupTabs).toHaveBeenLastCalledWith({ tabIds: [8], groupId: 100 });
    expect(deps.updateGroup).toHaveBeenCalledTimes(1);
  });

  it('service worker 重启后缓存丢了，先按标题找回已存在的分组', async () => {
    const { deps, grouper } = harness({ existingGroups: [{ id: 55, title: GROUP_TITLE }] });
    await grouper.add(7);

    expect(deps.queryGroups).toHaveBeenCalled();
    expect(deps.groupTabs).toHaveBeenCalledWith({ tabIds: [7], groupId: 55 });
    expect(deps.updateGroup).not.toHaveBeenCalled();
  });

  it('用户把分组关掉之后归组会失败，这时新建一个而不是报错', async () => {
    const groupTabs = vi.fn()
      .mockRejectedValueOnce(new Error('No group with id: 100'))
      .mockResolvedValueOnce(101);
    const { deps, grouper } = harness({ existingGroups: [{ id: 100, title: GROUP_TITLE }], groupTabs });

    await expect(grouper.add(7)).resolves.toBe(101);
    expect(groupTabs).toHaveBeenNthCalledWith(1, { tabIds: [7], groupId: 100 });
    expect(groupTabs).toHaveBeenNthCalledWith(2, { tabIds: [7] });
    expect(deps.updateGroup).toHaveBeenCalledWith(101, expect.objectContaining({ title: GROUP_TITLE }));
  });

  it('分组 API 整个不可用时不抛错——归不了组不该让投递失败', async () => {
    const groupTabs = vi.fn().mockRejectedValue(new Error('tabGroups unavailable'));
    const { grouper } = harness({ groupTabs });
    await expect(grouper.add(7)).resolves.toBe(null);
  });

  it('标题不匹配的已有分组不会被占用', async () => {
    const { deps, grouper } = harness({ existingGroups: [{ id: 55, title: '别的分组' }] });
    await grouper.add(7);
    expect(deps.groupTabs).toHaveBeenCalledWith({ tabIds: [7] });
  });
});
