"""只归档指定发行目录，拒绝覆盖；逐文件/整包SHA256与ZIP内容校验。"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

root = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
if not (root / 'sfs-package.json').is_file() or output.is_relative_to(root):
    raise ValueError('必须使用发行根与根外的新ZIP目标')
if output.exists():
    raise FileExistsError('拒绝覆盖发行ZIP')
def sha(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

files = sorted(p for p in root.rglob('*') if p.is_file() and p.name != 'SHA256SUMS.json')
sums = {p.relative_to(root).as_posix(): sha(p) for p in files}
(root / 'SHA256SUMS.json').write_text(json.dumps(sums, ensure_ascii=False, indent=2), encoding='utf-8')
with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for file in [*files, root / 'SHA256SUMS.json']:
        archive.write(file, root.name + '/' + file.relative_to(root).as_posix())
with zipfile.ZipFile(output) as archive:
    bad = archive.testzip()
    if bad is not None:
        raise ValueError('ZIP损坏: ' + bad)
summary = {'ok': True, 'root': str(root), 'archive': str(output), 'files': len(sums),
           'size_bytes': output.stat().st_size, 'sha256': sha(output), 'zip_crc_checked': True}
output.with_suffix(output.suffix + '.sha256').write_text(summary['sha256'] + '  ' + output.name + '\n', encoding='utf-8')
output.with_suffix(output.suffix + '.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False))
