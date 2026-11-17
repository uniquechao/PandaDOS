import type { ExecutorDriver } from '../executor/driver';
import { DEPENDENCY_IDENTITY_PYTHON } from './dependency-identity';

export class DependencyPreparationError extends Error {
  constructor(message:string,readonly uncertain=false) { super(message); }
}

/** A successful probe proves the installer and its inherited lock have ended; it never installs. */
export async function confirmDependencyPreparationStopped(driver:Pick<ExecutorDriver,'runCommand'>,cwd:string):Promise<void> {
  const script=String.raw`
import os,fcntl
p='.panda/tmp/dependencies/install.lock'
try:
    fd=os.open(p,os.O_RDWR|os.O_NOFOLLOW)
except FileNotFoundError:
    print('no installer lock')
else:
    try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError: raise RuntimeError('依赖准备仍在执行，不能恢复 issue')
    finally: os.close(fd)
`;
  try {
    const result=await driver.runCommand(cwd,['python3','-c',script],10_000);
    if(result.code!==0 || result.timedOut)throw new Error(result.err||'依赖准备结束状态未确认');
  }catch(error){throw new DependencyPreparationError(String(error),true);}
}

// 在执行机上探测和安装，避免把控制机的文件系统、缓存或 node_modules 带进工作区。
// 回执和锁属于物理 cwd；重启或连接中断后的重试仍等待同一把执行机锁。
export const DEPENDENCY_PREPARATION_SCRIPT = String.raw`
import os, sys, json, hashlib, subprocess, fcntl, time, signal, stat
from pathlib import Path
${DEPENDENCY_IDENTITY_PYTHON}
root = Path.cwd()
kind = os.environ.get('PANDA_DEPENDENCY_PREPARE_KIND', 'node')
if kind == 'node' and not (root / 'package.json').is_file():
    if 'PANDA_DEPENDENCY_PREPARE_KIND' in os.environ:
        print('Node preparation requires package.json', file=sys.stderr)
        sys.exit(1)
    print('无需准备 Node 依赖')
    sys.exit(0)
install_root = Path(os.environ.get('PANDA_DEPENDENCY_INSTALL_ROOT', str(root))).resolve()
relative = root.relative_to(install_root)
state = install_root / '.panda/tmp/dependencies'
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
suffix = '' if str(relative) == '.' else '-' + hashlib.sha256(os.fsencode(relative)).hexdigest()[:24]
receipt = state / ('receipt' + suffix + '.json')
def save(value):
    temp = state / ('receipt-' + str(os.getpid()) + '.json')
    temp.write_text(json.dumps(value, ensure_ascii=False))
    os.replace(temp, receipt)
def inputs():
    # 工作区子包的清单也属于安装输入；不读取依赖目录或 Git/运行缓存。
    if kind == 'uv':
        return hashlib.sha256((root / 'pyproject.toml').read_bytes() + b'\x00' + (root / 'uv.lock').read_bytes()).hexdigest()
    files = []
    for base, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in ('node_modules', '.venv', '.git', '.panda', '.private', '.worktrees', '.release-work'))
        for name in sorted(names):
            if name in ('package.json', 'bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', '.npmrc', '.yarnrc.yml', 'bunfig.toml'):
                p = Path(base) / name
                files.append((str(p.relative_to(root)), hashlib.sha256(p.read_bytes()).hexdigest()))
    return hashlib.sha256(json.dumps(files).encode()).hexdigest()
try:
    if kind == 'uv':
        if not all((root / f).is_file() and not (root / f).is_symlink() for f in ('pyproject.toml', 'uv.lock')):
            raise RuntimeError('uv requires pyproject.toml and uv.lock')
        manager = 'uv'
        modules = root / '.venv'
    elif kind == 'node':
        modules = root / 'node_modules'
        package = json.loads((root / 'package.json').read_text())
    else:
        raise RuntimeError('invalid dependency preparation kind')
    managers = {'bun': ['bun.lock', 'bun.lockb'], 'npm': ['npm-shrinkwrap.json', 'package-lock.json'], 'pnpm': ['pnpm-lock.yaml'], 'yarn': ['yarn.lock']}
    if kind == 'node':
        found = [m for m, names in managers.items() if any((root / n).is_file() for n in names)]
        if not found and not any(package.get(k) for k in ('dependencies', 'devDependencies', 'optionalDependencies', 'workspaces')):
            print('无需安装依赖')
            sys.exit(0)
        declared = package.get('packageManager', '').split('@')[0]
        if len(found) != 1 or (declared and declared != found[0]):
            raise RuntimeError('包管理器或锁文件不明确，需保留唯一且一致的锁文件')
        manager = found[0]
    command = {'uv': ['uv', 'sync', '--locked'], 'bun': ['bun', 'install', '--frozen-lockfile'], 'npm': ['npm', 'ci', '--include=dev'], 'pnpm': ['pnpm', 'install', '--frozen-lockfile', '--prod=false'], 'yarn': ['yarn', 'install', '--frozen-lockfile']}[manager]
    override = os.environ.get('PANDA_DEPENDENCY_COMMAND_JSON')
    if override:
        command = json.loads(override)
        if not isinstance(command, list) or not command or any(not isinstance(arg, str) or not arg for arg in command) or os.path.basename(command[0]) != manager:
            raise RuntimeError('invalid dependency preparation command')
    version = subprocess.check_output([command[0], '--version'], text=True, timeout=15).strip()
    if not override and manager == 'yarn' and not version.startswith('1.'):
        command = ['yarn', 'install', '--immutable']
    def installation_inputs():
        return inputs() + ':' + manager + ':' + version + ':' + json.dumps(command)
    fingerprint = installation_inputs()
    if modules.is_symlink():
        raise RuntimeError('依赖目录是共享软链，禁止自动使用或覆盖')
    def installed():
        return dependency_fingerprint(modules)
    old = json.loads(receipt.read_text()) if receipt.is_file() else {}
    if old.get('phase') == 'ready' and old.get('fingerprint') == fingerprint and modules.is_dir() and old.get('installed') == installed():
        print('依赖准备已确认：' + manager)
        sys.exit(0)
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
    if installation_inputs() != fingerprint:
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
  let result;
  try {
    result = await driver.runCommand(cwd, ['python3', '-c', DEPENDENCY_PREPARATION_SCRIPT], 660_000, env);
  } catch (error) {
    throw new DependencyPreparationError(`依赖环境准备结果未确认，保留工作区：${String(error)}`,true);
  }
  if (result.code !== 0 || result.timedOut) {
    const reason=(result.err || result.out || '执行机未返回准备结果').slice(-1800);
    throw new DependencyPreparationError(`依赖环境准备失败，保留工作区并在恢复后重试：${reason}`,result.timedOut || reason.includes('依赖准备仍在执行'));
  }
}
