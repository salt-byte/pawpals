/**
 * 等表单渲染完再动手。
 *
 * 扩展自主开页之后，content script 在 document_idle 就发 PAGE_READY，而简道云
 * 这类 SPA 那时还没把表单控件渲染出来。真机上因此出过一次很难查的假成功：
 * probe 任务 ok=true、队列清空、耗时 2.1 秒，但 probed=0——什么都没做，
 * 看起来却一切正常。
 *
 * 判据是「字段数连续两次采样相同且大于 0」。不用 DOMContentLoaded、也不用
 * MutationObserver 静默期：前者对 SPA 没意义，后者在有轮播、计时器的页面上
 * 永远等不到静默。字段数稳定是这件事本身的直接信号。
 *
 * 等不到就如实返回 ready:false，由调用方决定是继续还是报错——宁可带着「表单
 * 可能没渲染完」的标记去做，也不要假装一切正常。
 */
export async function waitForFormReady({
  countFields,
  now = () => Date.now(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 8000,
  intervalMs = 300,
} = {}) {
  const sample = () => {
    try {
      return countFields();
    } catch {
      return 0; // DOM 还没准备好，当作 0 继续等
    }
  };

  const startedAt = now();
  let previous = sample();

  while (now() - startedAt < timeoutMs) {
    await wait(intervalMs);
    const current = sample();
    if (current > 0 && current === previous) return { ready: true, count: current };
    previous = current;
  }
  return { ready: false, count: previous };
}
