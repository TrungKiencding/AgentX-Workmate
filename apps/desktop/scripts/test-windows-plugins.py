"""Load every historical plugin with the upgraded Windows managed Python."""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

PROBE = "\nimport json, sys, traceback\nfrom pathlib import Path\nfrom hermes_cli.plugins import PluginManager, PluginContext\ndirectory, key = Path(sys.argv[1]), sys.argv[2]\nmanager = PluginManager()\nmanifest = manager._parse_manifest(directory / 'plugin.yaml', directory, 'user', key.rpartition('/')[0])\nif manifest is None:\n    print('AUDIT:' + json.dumps({'status': 'failed', 'error': 'invalid manifest'})); sys.exit(0)\ntry:\n    if key.startswith('cron_providers/'):\n        from plugins.cron_providers import _load_provider_from_dir\n        provider = _load_provider_from_dir(directory)\n        assert provider is not None, 'cron provider did not instantiate'\n        result = {'status': 'loaded-cron-provider', 'provider': provider.name}\n    elif manifest.kind == 'exclusive' and key.startswith('memory/'):\n        from plugins.memory import _load_provider_from_dir\n        provider = _load_provider_from_dir(directory)\n        assert provider is not None, 'memory provider did not instantiate (check optional dependencies/configuration)'\n        result = {'status': 'loaded-memory-provider', 'provider_class': type(provider).__name__}\n    elif manifest.kind == 'model-provider':\n        module = manager._load_directory_module(manifest)\n        register = getattr(module, 'register', None)\n        if callable(register): register(PluginContext(manifest, manager))\n        result = {'status': 'registered-model-provider'}\n    else:\n        manager._load_plugin(manifest)\n        loaded = manager._plugins[manifest.key or manifest.name]\n        result = {'status': 'failed' if loaded.error else 'registered', 'error': loaded.error,\n                  'tools': loaded.tools_registered, 'hooks': loaded.hooks_registered,\n                  'commands': loaded.commands_registered}\nexcept Exception as error:\n    result = {'status': 'failed', 'error': type(error).__name__ + ': ' + str(error)}\nresult['kind'] = manifest.kind\nprint('AUDIT:' + json.dumps(result, ensure_ascii=False))\n"

def main():
    source, plugins, output = map(Path, sys.argv[1:])
    assert sys.platform == 'win32', 'Native Windows required'
    manifests = sorted(plugins.rglob('plugin.yaml'))
    assert manifests, 'No historical plugin manifests found'
    with tempfile.TemporaryDirectory(prefix='workmate-windows-plugin-') as temporary:
        def run(manifest):
            key = manifest.parent.relative_to(plugins).as_posix()
            home = Path(temporary) / key.replace('/', '__')
            home.mkdir(parents=True)
            (home / 'config.yaml').write_text('security:\n  allow_lazy_installs: false\nplugins:\n  enabled: []\n')
            env = {k:v for k,v in os.environ.items() if k.upper() in {'SYSTEMROOT','WINDIR','COMSPEC','PATH','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE'}}
            env.update(AGENTX_HOME=str(home), PYTHONPATH=str(source), PYTHONDONTWRITEBYTECODE='1', PYTHONNOUSERSITE='1', AGENTX_DISABLE_LAZY_INSTALLS='1', PYTHONIOENCODING='utf-8')
            try:
                child = subprocess.run([sys.executable, '-c', PROBE, str(manifest.parent), key], env=env, cwd=home, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
                lines = [line[6:] for line in child.stdout.splitlines() if line.startswith('AUDIT:')]
                result = json.loads(lines[-1]) if lines else {'status':'failed','error':(child.stderr or child.stdout)[-1200:]}
            except subprocess.TimeoutExpired:
                result = {'status':'failed','error':'Plugin load timed out'}
            return {'key':key, **result}
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(run, manifests))
    report = {'scope':'All historical plugin manifests loaded by the upgraded managed Windows Python; no external API calls or real credentials', 'count':len(results), 'passed':sum(r['status']!='failed' for r in results), 'results':results}
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'count': report['count'], 'passed': report['passed']}))
    # Capture optional-dependency failures for review; installation assertions are separate.

if __name__ == '__main__':
    main()
