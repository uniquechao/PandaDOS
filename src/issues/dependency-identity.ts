/** Installation inputs exclude only known Node tool outputs at the install root. */
export const DEPENDENCY_IDENTITY_PYTHON = String.raw`
def dependency_fingerprint(root):
    root_info = os.lstat(root)
    values = [['.', root_info.st_mode, os.readlink(root) if stat.S_ISLNK(root_info.st_mode) else None]]
    node = os.path.basename(os.fspath(root)) == 'node_modules'
    def walk(base, relative=''):
        for entry in sorted(os.scandir(base), key=lambda item: item.name):
            name = relative + entry.name
            if node and name.split('/')[0] in {'.vite', '.vite-temp'}:
                continue
            if node and name.startswith('.tmp/') and '/' not in name[5:] and name.endswith('.tsbuildinfo'):
                continue
            info = entry.stat(follow_symlinks=False)
            directory = stat.S_ISDIR(info.st_mode)
            if not (node and name == '.tmp' and directory):
                value = [name, info.st_mode]
                if not directory:
                    value += [info.st_size, info.st_mtime_ns, info.st_ctime_ns,
                              os.readlink(entry.path) if stat.S_ISLNK(info.st_mode) else None]
                values.append(value)
            if directory:
                walk(entry.path, name + '/')
    walk(root)
    return hashlib.sha256(json.dumps(values).encode()).hexdigest()
`;
