import type { ExecutorDriver } from '../executor/driver';

export class DependencyPreparationError extends Error {}

// 在执行机上探测和安装，避免把控制机的文件系统、缓存或 node_modules 带进工作区。
// 回执和锁属于物理 cwd；重启或连接中断后的重试仍等待同一把执行机锁。
export const DEPENDENCY_PREPARATION_SCRIPT = String.raw`
import os, sys, json, hashlib, subprocess, fcntl, time, signal
from pathlib import Path
root = Path.cwd()
if not (root / 'package.json').is_file():
    print('无需准备 Node 依赖')
    sys.exit(0)
state = root / '.panda/tmp/dependencies'
state.mkdir(parents=True, exist_ok=True)
lock = open(state / 'install.lock', 'a+')
end = time.monotonic() + 30
while True:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() >= end:
            raise RuntimeError('依赖准备仍在执行，保留现场后重试')
        time.sleep(0.2)
receipt = state / 'receipt.json'
def save(value):
    temp = state / ('receipt-' + str(os.getpid()) + '.json')
    temp.write_text(json.dumps(value, ensure_ascii=False))
    os.replace(temp, receipt)
def inputs():
    # 工作区子包的清单也属于安装输入；不读取依赖目录或 Git/运行缓存。
    files = []
    for base, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in ('node_modules', '.git', '.panda', '.private', '.worktrees', '.release-work'))
        for name in sorted(names):
            if name in ('package.json', 'bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', '.npmrc', '.yarnrc.yml', 'bunfig.toml'):
                p = Path(base) / name
                files.append((str(p.relative_to(root)), hashlib.sha256(p.read_bytes()).hexdigest()))
    return hashlib.sha256(json.dumps(files).encode()).hexdigest()
try:
    package = json.loads((root / 'package.json').read_text())
    managers = {'bun': ['bun.lock', 'bun.lockb'], 'npm': ['npm-shrinkwrap.json', 'package-lock.json'], 'pnpm': ['pnpm-lock.yaml'], 'yarn': ['yarn.lock']}
    found = [m for m, names in managers.items() if any((root / n).is_file() for n in names)]
    if not found and not any(package.get(k) for k in ('dependencies', 'devDependencies', 'optionalDependencies', 'workspaces')):
        print('无需安装依赖')
        sys.exit(0)
    declared = package.get('packageManager', '').split('@')[0]
    if len(found) != 1 or (declared and declared != found[0]):
        raise RuntimeError('包管理器或锁文件不明确，需保留唯一且一致的锁文件')
    manager = found[0]
    version = subprocess.check_output([manager, '--version'], text=True, timeout=15).strip()
    fingerprint = inputs() + ':' + manager + ':' + version
    modules = root / 'node_modules'
    if modules.is_symlink():
        raise RuntimeError('node_modules 是共享软链，禁止自动使用或覆盖')
    def installed():
        result = []
        for base, dirs, names in os.walk(modules):
            dirs.sort()
            for name in sorted(dirs + names):
                p = Path(base) / name
                st = p.lstat()
                result.append((str(p.relative_to(modules)), st.st_size, st.st_mtime_ns, st.st_ctime_ns, os.readlink(p) if p.is_symlink() else ''))
        return hashlib.sha256(json.dumps(result).encode()).hexdigest()
    old = json.loads(receipt.read_text()) if receipt.is_file() else {}
    if old.get('phase') == 'ready' and old.get('fingerprint') == fingerprint and modules.is_dir() and old.get('installed') == installed():
        print('依赖准备已确认：' + manager)
        sys.exit(0)
    command = {'bun': ['bun', 'install', '--frozen-lockfile'], 'npm': ['npm', 'ci', '--include=dev'], 'pnpm': ['pnpm', 'install', '--frozen-lockfile', '--prod=false'], 'yarn': ['yarn', 'install', '--frozen-lockfile'] if version.startswith('1.') else ['yarn', 'install', '--immutable']}[manager]
    save({'phase': 'preparing', 'fingerprint': fingerprint, 'command': command})
    env = dict(os.environ, NODE_ENV='development', CI='1')
    child = subprocess.Popen(command, env=env, start_new_session=True, pass_fds=(lock.fileno(),))
    try:
        code = child.wait(timeout=600)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
        raise RuntimeError('依赖安装超时，已终止安装进程组，恢复后重试')
    if code:
        raise RuntimeError('依赖安装失败，退出码 ' + str(code) + '；请检查网络、包源与执行机工具')
    if inputs() + ':' + manager + ':' + version != fingerprint:
        raise RuntimeError('安装期间清单或锁文件发生变化，禁止使用旧准备回执')
    save({'phase': 'ready', 'fingerprint': fingerprint, 'command': command, 'installed': installed()})
    print('依赖准备完成：' + manager)
except Exception as error:
    save({'phase': 'failed', 'diagnostic': str(error)})
    print('环境准备失败：' + str(error), file=sys.stderr)
    sys.exit(1)
`;

export async function prepareDependencies(
  driver: Pick<ExecutorDriver, 'runCommand'>,
  cwd: string,
  env?: Record<string, string>,
): Promise<void> {
  try {
    const result = await driver.runCommand(cwd, ['python3', '-c', DEPENDENCY_PREPARATION_SCRIPT], 660_000, env);
    if (result.code !== 0 || result.timedOut) {
      throw new Error((result.err || result.out || '执行机未返回准备结果').slice(-1800));
    }
  } catch (error) {
    throw new DependencyPreparationError(`依赖环境准备失败，保留工作区并在恢复后重试：${String(error)}`);
  }
}
