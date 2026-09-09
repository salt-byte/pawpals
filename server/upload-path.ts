/**
 * 上传文件名 sanitize：去目录部分、换掉危险字符，再确认解析后仍在 dir 内。
 *
 * 多用户下 dir 是该用户自己的目录——这是安全边界第 4 条。上传文件名是攻击者
 * 可控的输入，`path.join` 本身挡不住 `..` 穿越（`path.join(dir, "../../evil")`
 * 会老老实实拼出 dir 外面的路径），所以必须显式 `path.resolve` 之后再核对
 * 前缀，确认落点确实还在 dir 里，不行就返回 null 让调用方 400，不能悄悄换个
 * 名字接着收。
 */
import path from "path";

export function safeUploadPath(dir: string, originalName: string): string | null {
  const base = path.basename(originalName).replace(/[^a-zA-Z0-9.\-_一-龥 ()]/g, "_");
  if (!base || base === "." || base === "..") return null;
  const resolvedDir = path.resolve(dir);
  const dest = path.resolve(resolvedDir, base);
  // 以今天的白名单和上面的 basename，dest 必然就是 resolvedDir + sep + base，
  // 这条 startsWith 检查现在永远不会真的拦下什么——它是防未来的：白名单正则
  // 一旦被放宽到允许 "/" 或 "\\"，这行才是唯一还能兜住路径穿越的东西。别因为
  // 它现在测不出反例，就当成死代码删掉。
  return dest.startsWith(resolvedDir + path.sep) ? dest : null;
}
