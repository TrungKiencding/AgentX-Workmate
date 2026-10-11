"""Compare real old plugin code against source and bundled Python, in isolated homes."""
import concurrent.futures
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

DESKTOP = Path(__file__).resolve().parents[1]
REPO = DESKTOP.parents[1]
RELEASE = DESKTOP / 'release/runtime-preview'
RUNTIME = RELEASE / 'mac-arm64/AgentX Workmate Runtime Preview.app/Contents/Resources/runtime-preview'
OLD = Path.home() / '.agentx/agentx-agent/plugins'
WORK = Path(tempfile.mkdtemp(prefix='workmate-plugin-audit-'))
PROBE = r'''
import json, sys, traceback
from pathlib import Path
from hermes_cli.plugins import PluginManager, PluginContext
directory, key = Path(sys.argv[1]), sys.argv[2]
manager = PluginManager()
manifest = manager._parse_manifest(directory / 'plugin.yaml', directory, 'user', key.rpartition('/')[0])
if manifest is None:
    print('AUDIT:' + json.dumps({'status': 'failed', 'error': 'invalid manifest'})); sys.exit(0)
try:
    if key.startswith('cron_providers/'):
        from plugins.cron_providers import _load_provider_from_dir
        provider = _load_provider_from_dir(directory)
        assert provider is not None, 'cron provider did not instantiate'
        result = {'status': 'loaded-cron-provider', 'provider': provider.name}
    elif manifest.kind == 'exclusive' and key.startswith('memory/'):
        from plugins.memory import _load_provider_from_dir
        provider = _load_provider_from_dir(directory)
        assert provider is not None, 'memory provider did not instantiate (check optional dependencies/configuration)'
        result = {'status': 'loaded-memory-provider', 'provider_class': type(provider).__name__}
    elif manifest.kind == 'model-provider':
        module = manager._load_directory_module(manifest)
        register = getattr(module, 'register', None)
        if callable(register): register(PluginContext(manifest, manager))
        result = {'status': 'registered-model-provider'}
    else:
        manager._load_plugin(manifest)
        loaded = manager._plugins[manifest.key or manifest.name]
        result = {'status': 'failed' if loaded.error else 'registered', 'error': loaded.error,
                  'tools': loaded.tools_registered, 'hooks': loaded.hooks_registered,
                  'commands': loaded.commands_registered}
except Exception as error:
    result = {'status': 'failed', 'error': type(error).__name__ + ': ' + str(error)}
result['kind'] = manifest.kind
print('AUDIT:' + json.dumps(result, ensure_ascii=False))
'''

def copy_plugins(source, destination):
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns('.env', '.env.*', '__pycache__', '.git', 'node_modules', '.venv', 'venv'), symlinks=True)

copy_plugins(OLD, WORK / 'old-plugins')
copy_plugins(REPO / 'plugins', WORK / 'current-plugins')
jobs = []
for group in ['old', 'current']:
    root = WORK / f'{group}-plugins'
    for manifest in sorted(root.rglob('plugin.yaml')):
        key = manifest.parent.relative_to(root).as_posix()
        for runtime in ['source', 'bundled']:
            jobs.append((group, key, manifest.parent, runtime))

def run(job):
    group, key, directory, runtime = job
    home = WORK / 'homes' / group / key.replace('/', '__') / runtime
    home.mkdir(parents=True)
    (home / 'config.yaml').write_text('security:\n  allow_lazy_installs: false\nplugins:\n  enabled: []\n')
    env = {'HOME': str(home), 'AGENTX_HOME': str(home), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
           'LANG': 'en_US.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1',
           'AGENTX_DISABLE_LAZY_INSTALLS': '1'}
    if runtime == 'bundled':
        python = RUNTIME / 'python/bin/python3.11'
        env.update(PYTHONHOME=str(RUNTIME / 'python'), PYTHONPATH=str(RUNTIME / 'source'))
    else:
        python = REPO / 'venv/bin/python'
        env['PYTHONPATH'] = str(REPO)
    try:
        result = subprocess.run([str(python), '-c', PROBE, str(directory), key], cwd=home, env=env,
                                capture_output=True, text=True, timeout=25)
        lines = [line[6:] for line in result.stdout.splitlines() if line.startswith('AUDIT:')]
        data = json.loads(lines[-1]) if lines else {'status': 'failed', 'error': (result.stderr or result.stdout)[-1600:]}
    except subprocess.TimeoutExpired:
        data = {'status': 'failed', 'error': 'registration timed out after 25 seconds'}
    return {'group': group, 'key': key, 'runtime': runtime, **data}

try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(run, jobs))
    comparisons = []
    for group in ['old', 'current']:
        keys = sorted({r['key'] for r in results if r['group'] == group})
        for key in keys:
            pair = {r['runtime']: r for r in results if r['group'] == group and r['key'] == key}
            comparisons.append({'group': group, 'key': key, 'source': pair['source'], 'bundled': pair['bundled'],
                                'regression': pair['source']['status'] != 'failed' and pair['bundled']['status'] == 'failed'})
    report = {'scope': 'All old managed and current repository manifests. Real import/register and category loader instantiation; no external service calls or credentials.',
              'old_count': len(list((WORK/'old-plugins').rglob('plugin.yaml'))),
              'current_count': len(list((WORK/'current-plugins').rglob('plugin.yaml'))),
              'regressions': [r for r in comparisons if r['regression']], 'plugins': comparisons}
    (RELEASE / 'plugin-compatibility.json').write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(json.dumps({'old': report['old_count'], 'current': report['current_count'],
                      'bundled_pass': sum(r['bundled']['status'] != 'failed' for r in comparisons),
                      'bundled_failed': sum(r['bundled']['status'] == 'failed' for r in comparisons),
                      'regressions': [(r['group'],r['key'],r['bundled'].get('error')) for r in report['regressions']]}, indent=2))
finally:
    shutil.rmtree(WORK)
