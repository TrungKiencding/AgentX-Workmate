"""Exercise optional SDK installation outside the immutable Windows bundle."""
import hashlib
import json
import os
from pathlib import Path
import sys

assert sys.platform == 'win32' and os.environ.get('CI') == 'true'
runtime, target, output = map(Path, sys.argv[1:])
assert target.resolve().is_relative_to(Path(os.environ['RUNNER_TEMP']).resolve())

def inventory():
    return {str(p.relative_to(runtime)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in runtime.rglob('*') if p.is_file()}

before = inventory()
from tools.lazy_deps import ensure
ensure('image.fal', prompt=False)
import fal_client
assert Path(fal_client.__file__).resolve().is_relative_to(target.resolve()), fal_client.__file__
assert inventory() == before, 'Optional dependency modified packaged runtime'
output.write_text(json.dumps({'ok': True, 'feature': 'image.fal', 'moduleInUserDirectory': True,
                             'runtimeFilesUnchanged': len(before)}, indent=2), encoding='utf-8')
print('Optional FAL SDK installed outside app; bundled files unchanged')
