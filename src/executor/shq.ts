/**
 * executor/shq —— POSIX shell 单引号转义。
 * SshDriver 的一切 exec 都是「拼一条 shell 命令行」发到远端，参数必须经它包裹，
 * 否则空格/引号/换行/$ 展开都是注入口（评审 5.1#2：严格转义是硬要求）。
 */

/**
 * 把任意字符串安全变成远端 shell 的单个参数。
 * 规则：整体套单引号；内部的单引号用 `'\''`（关引号 + 反斜杠引号 + 开引号）接续。
 * 单引号内 POSIX shell 不做任何解释，空格/双引号/中文/换行/$/反引号/反斜杠原样保留。
 */
export function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
