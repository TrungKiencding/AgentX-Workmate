"""
AgentX Workmate Uninstaller.

Provides options for:
- Full uninstall: Remove everything including configs and data
- Keep data: Remove code but keep ~/.agentx/ (configs, sessions, logs)
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

from hermes_constants import get_hermes_home

from hermes_cli.colors import Colors, color

def log_info(msg: str):
    print(f"{color('→', Colors.CYAN)} {msg}")

def log_success(msg: str):
    print(f"{color('✓', Colors.GREEN)} {msg}")

def log_warn(msg: str):
    print(f"{color('⚠', Colors.YELLOW)} {msg}")

def get_project_root() -> Path:
    """Get the project installation directory."""
    return Path(__file__).parent.parent.resolve()


def find_shell_configs() -> list:
    """Find shell configuration files that might have PATH entries."""
    home = Path.home()
    configs = []
    
    candidates = [
        home / ".bashrc",
        home / ".bash_profile",
        home / ".profile",
        home / ".zshrc",
        home / ".zprofile",
    ]
    
    for config in candidates:
        if config.exists():
            configs.append(config)
    
    return configs


def remove_path_from_shell_configs():
    """Remove AgentX PATH entries from shell configuration files."""
    configs = find_shell_configs()
    removed_from = []
    
    for config_path in configs:
        try:
            content = config_path.read_text(encoding="utf-8")
            original_content = content
            
            # Remove lines containing agentx-agent or agentx PATH entries
            new_lines = []
            skip_next = False
            
            for line in content.split('\n'):
                # Skip the "# AgentX Workmate" comment and following line
                if '# AgentX Workmate' in line or '# agentx-agent' in line:
                    skip_next = True
                    continue
                if skip_next and ('agentx' in line.lower() and 'PATH' in line):
                    skip_next = False
                    continue
                skip_next = False
                
                # Remove any PATH line containing agentx
                if 'agentx' in line.lower() and ('PATH=' in line or 'path=' in line.lower()):
                    continue
                    
                new_lines.append(line)
            
            new_content = '\n'.join(new_lines)
            
            # Clean up multiple blank lines
            while '\n\n\n' in new_content:
                new_content = new_content.replace('\n\n\n', '\n\n')
            
            if new_content != original_content:
                config_path.write_text(new_content, encoding="utf-8")
                removed_from.append(config_path)
                
        except Exception as e:
            log_warn(f"Could not update {config_path}: {e}")
    
    return removed_from


def remove_wrapper_script():
    """Remove the agentx wrapper script if it exists."""
    wrapper_paths = [
        Path.home() / ".local" / "bin" / "agentx",
        Path.home() / ".local" / "bin" / "agentx-acp",
        Path.home() / ".local" / "bin" / "agentx-agent",
        Path("/usr/local/bin/agentx"),
        Path("/usr/local/bin/agentx-acp"),
        Path("/usr/local/bin/agentx-agent"),
    ]

    removed = []
    for wrapper in wrapper_paths:
        if wrapper.exists():
            try:
                # Check if it's our wrapper (contains hermes_cli reference)
                content = wrapper.read_text(encoding="utf-8")
                if 'hermes_cli' in content or 'agentx-agent' in content:
                    wrapper.unlink()
                    removed.append(wrapper)
            except Exception as e:
                log_warn(f"Could not remove {wrapper}: {e}")

    return removed


# ============================================================================
# Everything the app leaves OUTSIDE the checkout and AGENTX_HOME
# ============================================================================
#
# Uninstalling used to mean "delete the code, maybe delete AGENTX_HOME", and
# that left a surprising amount behind: the Start Menu and Desktop shortcuts
# both installers create, and the per-user directories Chromium/Electron open
# on first launch under names keyed on the product name and the bundle id.
#
# None of these are large. They matter because a reinstall inherits them, and
# because a user who has just uninstalled reasonably expects the shortcut on
# their desktop to be gone.


def desktop_shortcut_paths() -> "list[Path]":
    """Shortcuts the installers create, on every platform that has them.

    Two names because two installers: ``scripts/install.ps1`` writes
    ``AgentX.lnk`` and the NSIS installer writes one named after
    ``build.nsis.shortcutName`` (``AgentX Workmate``). A machine that has seen
    both — which is how the "I uninstalled it and it is still there" reports
    start — has both.
    """
    if sys.platform != "win32":
        # macOS has no shortcut concept for this, and the Linux .desktop entry
        # is already handled by ``gui_uninstall.packaged_gui_app_paths``.
        return []

    from branding import DESKTOP_APP_NAME, SHORT_NAME

    home = Path.home()
    appdata = os.environ.get("APPDATA")
    roaming = Path(appdata) if appdata else (home / "AppData" / "Roaming")
    start_menu = roaming / "Microsoft" / "Windows" / "Start Menu" / "Programs"

    paths: list[Path] = []
    for folder in (home / "Desktop", start_menu):
        for name in (SHORT_NAME, DESKTOP_APP_NAME):
            paths.append(folder / f"{name}.lnk")
    # electron-builder puts the uninstaller's Start Menu entry in a folder when
    # a menuCategory is configured; sweep the folder too so an older install
    # that used one does not leave an empty shell behind.
    paths.append(start_menu / DESKTOP_APP_NAME)
    return paths


def desktop_runtime_data_paths() -> "list[Path]":
    """Per-user directories Electron/Chromium create for the desktop app.

    ``gui_uninstall.desktop_userdata_dir()`` already covers the ``userData``
    directory that holds connection.json and the encrypted token store. These
    are the OTHER ones — caches, logs, crash dumps, window state — which the
    OS keys on the product name or the bundle id rather than on AGENTX_HOME,
    and which therefore survive every wipe of it.
    """
    from branding import APP_ID, DESKTOP_APP_NAME

    home = Path.home()

    if sys.platform == "darwin":
        library = home / "Library"
        return [
            library / "Caches" / DESKTOP_APP_NAME,
            library / "Caches" / APP_ID,
            library / "Logs" / DESKTOP_APP_NAME,
            library / "Preferences" / f"{APP_ID}.plist",
            library / "HTTPStorages" / APP_ID,
            library / "WebKit" / APP_ID,
            library / "Saved Application State" / f"{APP_ID}.savedState",
        ]

    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA")
        local_base = Path(local) if local else (home / "AppData" / "Local")
        return [local_base / DESKTOP_APP_NAME]

    xdg_cache = os.environ.get("XDG_CACHE_HOME")
    cache_base = Path(xdg_cache) if xdg_cache else (home / ".cache")
    return [cache_base / DESKTOP_APP_NAME]


def remove_desktop_leftovers() -> "list[Path]":
    """Delete the shortcuts and per-user runtime dirs. Returns what went."""
    removed: list[Path] = []

    for path in [*desktop_shortcut_paths(), *desktop_runtime_data_paths()]:
        try:
            if path.is_symlink() or path.is_file():
                path.unlink()
            elif path.is_dir():
                shutil.rmtree(path)
            else:
                continue
            removed.append(path)
        except Exception as e:
            log_warn(f"Could not remove {path}: {e}")

    return removed


def _node_symlink_candidate_dirs() -> "list[Path]":
    """Directories where the installer may have placed node/npm/npx symlinks."""
    dirs: list[Path] = [Path.home() / ".local" / "bin"]
    # Root FHS installs put links in /usr/local/bin.
    if sys.platform == "linux":
        dirs.append(Path("/usr/local/bin"))
    # Termux installs put links in $PREFIX/bin.
    prefix = os.environ.get("PREFIX", "")
    if prefix and "com.termux" in prefix:
        dirs.append(Path(prefix) / "bin")
    return dirs


def remove_node_symlinks(hermes_home: Path) -> list:
    """Remove the node/npm/npx symlinks the installer placed on PATH.

    The POSIX installer (``scripts/install.sh`` / ``scripts/lib/node-bootstrap.sh``)
    symlinks node/npm/npx into the same directory as the ``agentx`` command:

    - ``/usr/local/bin/`` on root FHS installs (Linux, uid 0)
    - ``$PREFIX/bin/`` on Termux
    - ``~/.local/bin/`` otherwise (the common non-root case)

    We check all candidate directories so that uninstall works regardless of
    how the install was done (e.g. a root FHS install that placed links in
    ``/usr/local/bin``, or an older install that used ``~/.local/bin`` before
    the FHS fix).  Only symlinks that resolve into this AgentX home's ``node``
    directory are removed — links the user has repointed elsewhere (nvm, fnm,
    etc.) are left untouched.
    """
    node_dir = (hermes_home / "node").resolve()
    removed = []

    for name in ("node", "npm", "npx"):
        for bin_dir in _node_symlink_candidate_dirs():
            link = bin_dir / name
            try:
                # Only act on symlinks — never delete a real binary the user put here.
                if not link.is_symlink():
                    continue

                # Resolve the link target and confirm it points into our node dir.
                # os.readlink + manual join handles broken (dangling) links too;
                # Path.resolve() on a dangling link still returns the target path.
                target = Path(os.readlink(link))
                if not target.is_absolute():
                    target = (link.parent / target)
                target = target.resolve()

                if target == node_dir or node_dir in target.parents:
                    link.unlink()
                    removed.append(link)
            except Exception as e:
                log_warn(f"Could not remove {link}: {e}")

    return removed


def uninstall_gateway_service():
    """Stop and uninstall the gateway service (systemd, launchd, Windows
    Scheduled Task / Startup folder) and kill any standalone gateway processes.

    Delegates to the gateway module which handles:
    - Linux: user + system systemd services (with proper DBUS env setup)
    - macOS: launchd plists
    - Windows: Scheduled Task + Startup-folder fallback, via ``gateway_windows``
    - All platforms: standalone ``agentx gateway run`` processes
    - Termux/Android: skips systemd (no systemd on Android), still kills standalone processes
    """
    import platform
    stopped_something = False

    # 1. Kill any standalone gateway processes (all platforms, including Termux)
    try:
        from hermes_cli.gateway import kill_gateway_processes, find_gateway_pids
        pids = find_gateway_pids()
        if pids:
            killed = kill_gateway_processes()
            if killed:
                log_success(f"Killed {killed} running gateway process(es)")
                stopped_something = True
    except Exception as e:
        log_warn(f"Could not check for gateway processes: {e}")

    system = platform.system()

    # Termux/Android has no systemd and no launchd — nothing left to do.
    prefix = os.getenv("PREFIX", "")
    is_termux = bool(os.getenv("TERMUX_VERSION") or "com.termux/files/usr" in prefix)
    if is_termux:
        return stopped_something

    # 2. Linux: uninstall systemd services (both user and system scopes)
    if system == "Linux":
        try:
            from hermes_cli.gateway import (
                get_systemd_unit_path,
                get_service_name,
                _systemctl_cmd,
            )
            svc_name = get_service_name()

            for is_system in (False, True):
                unit_path = get_systemd_unit_path(system=is_system)
                if not unit_path.exists():
                    continue

                scope = "system" if is_system else "user"
                try:
                    if is_system and os.geteuid() != 0:  # windows-footgun: ok — Linux systemd uninstall path, guarded by `if system == "Linux"` above
                        log_warn(f"System gateway service exists at {unit_path} "
                                 f"but needs sudo to remove")
                        continue

                    cmd = _systemctl_cmd(is_system)
                    subprocess.run(cmd + ["stop", svc_name],
                                   capture_output=True, check=False)
                    subprocess.run(cmd + ["disable", svc_name],
                                   capture_output=True, check=False)
                    unit_path.unlink()
                    subprocess.run(cmd + ["daemon-reload"],
                                   capture_output=True, check=False)
                    log_success(f"Removed {scope} gateway service ({unit_path})")
                    stopped_something = True
                except Exception as e:
                    log_warn(f"Could not remove {scope} gateway service: {e}")
        except Exception as e:
            log_warn(f"Could not check systemd gateway services: {e}")

    # 3. macOS: uninstall launchd plist
    elif system == "Darwin":
        try:
            from hermes_cli.gateway import get_launchd_plist_path
            plist_path = get_launchd_plist_path()
            if plist_path.exists():
                subprocess.run(["launchctl", "unload", str(plist_path)],
                               capture_output=True, check=False)
                plist_path.unlink()
                log_success(f"Removed macOS gateway service ({plist_path})")
                stopped_something = True
        except Exception as e:
            log_warn(f"Could not remove launchd gateway service: {e}")

    # 4. Windows: uninstall Scheduled Task + Startup-folder entry.  The
    #    gateway_windows module already knows how to locate and remove both
    #    code paths (schtasks /Delete + .cmd unlink) and how to stop any
    #    running detached pythonw gateway process.  We call into it so the
    #    uninstall logic stays in exactly one place.
    elif system == "Windows":
        try:
            from hermes_cli import gateway_windows
            if gateway_windows.is_installed() or gateway_windows.is_task_registered() \
                    or gateway_windows.is_startup_entry_installed():
                try:
                    gateway_windows.stop()
                except Exception as e:
                    log_warn(f"Could not stop Windows gateway cleanly: {e}")
                try:
                    gateway_windows.uninstall()
                    log_success("Removed Windows gateway (Scheduled Task + Startup entry)")
                    stopped_something = True
                except Exception as e:
                    log_warn(f"Could not fully uninstall Windows gateway: {e}")
        except Exception as e:
            log_warn(f"Could not check Windows gateway service: {e}")

    return stopped_something


# ============================================================================
# Windows-specific uninstall helpers
# ============================================================================
#
# The installer (``scripts/install.ps1``) does four Windows-only things that
# ``remove_path_from_shell_configs`` / ``remove_wrapper_script`` don't cover:
#
#   1. Sets User-scope env vars ``AGENTX_HOME`` and ``AGENTX_GIT_BASH_PATH``
#      via ``[Environment]::SetEnvironmentVariable(..., "User")``.  These
#      don't live in ~/.bashrc — they're in the Windows registry at
#      HKCU\Environment.
#   2. Prepends to User-scope ``PATH`` (same registry location) entries
#      like ``%LOCALAPPDATA%\agentx\git\cmd``, ``%LOCALAPPDATA%\agentx\git\bin``,
#      ``%LOCALAPPDATA%\agentx\git\usr\bin``, ``%LOCALAPPDATA%\agentx\node``.
#      Again not in any rc file — only accessible via the registry or the
#      .NET [Environment] API.
#   3. Downloads PortableGit to ``%LOCALAPPDATA%\agentx\git\`` and Node to
#      ``%LOCALAPPDATA%\agentx\node\`` as user-scoped, isolated copies.
#      These are ~200MB combined and serve no purpose after uninstall.
#   4. On the ``agentx dashboard`` + gateway paths, drops files into
#      ``%LOCALAPPDATA%\agentx\gateway-service\`` and sometimes
#      ``%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`` — the
#      latter is handled by ``gateway_windows.uninstall()`` already.
#
# Running a PowerShell one-liner per operation is overkill and fragile on
# locked-down machines (Constrained Language Mode, restricted ExecutionPolicy).
# Direct registry writes via ``winreg`` work without spawning any subprocess
# and apply immediately for new shells (SendMessage WM_SETTINGCHANGE would
# be nicer but requires ctypes and buys us nothing — the user will log out
# or open a new terminal anyway).


def _hermes_path_markers(hermes_home: Path) -> list[str]:
    """Path-entry substrings that identify AgentX-owned User-PATH entries."""
    root = str(hermes_home).rstrip("\\/")
    # Match on prefix so sub-entries (git\cmd, git\bin, git\usr\bin, node, etc.)
    # all get swept.  Also match the bare agentx-agent install dir.
    markers = [root + "\\agentx-agent", root + "\\git", root + "\\node", root + "\\venv"]
    # Also match if AGENTX_HOME was customised to somewhere else — find-and-nuke
    # any entry whose path component contains "agentx".  We don't want to catch
    # unrelated entries like "chermes-foo" or "ephermeral", so we look for
    # backslash-agentx as a word-ish boundary.
    return markers


def remove_path_from_windows_registry(hermes_home: Path) -> list[str]:
    """Strip AgentX-owned entries from User-scope PATH in the registry.

    Returns the list of removed path entries.  Operates on HKCU\\Environment,
    same key the installer wrote to via ``[Environment]::SetEnvironmentVariable``.
    """
    try:
        import winreg
    except ImportError:
        return []  # not on Windows, nothing to do

    removed: list[str] = []
    key_path = "Environment"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0,
                            winreg.KEY_READ | winreg.KEY_WRITE) as key:
            try:
                path_value, path_type = winreg.QueryValueEx(key, "Path")
            except FileNotFoundError:
                return []
            # Preserve REG_EXPAND_SZ vs REG_SZ so unexpanded %VARS% survive.
            entries = [e for e in path_value.split(";") if e]
            markers = _hermes_path_markers(hermes_home)
            kept: list[str] = []
            for entry in entries:
                entry_norm = entry.rstrip("\\/")
                matched = any(entry_norm.lower().startswith(m.lower()) for m in markers)
                if matched:
                    removed.append(entry)
                else:
                    kept.append(entry)
            if removed:
                new_value = ";".join(kept)
                winreg.SetValueEx(key, "Path", 0, path_type, new_value)
    except OSError as e:
        log_warn(f"Could not edit User PATH in registry: {e}")
    return removed


def remove_hermes_env_vars_windows() -> list[str]:
    """Delete AGENTX_HOME and AGENTX_GIT_BASH_PATH from User-scope env vars."""
    try:
        import winreg
    except ImportError:
        return []

    removed: list[str] = []
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0,
                            winreg.KEY_READ | winreg.KEY_WRITE) as key:
            for name in ("AGENTX_HOME", "AGENTX_GIT_BASH_PATH"):
                try:
                    winreg.QueryValueEx(key, name)
                except FileNotFoundError:
                    continue
                try:
                    winreg.DeleteValue(key, name)
                    removed.append(name)
                except OSError as e:
                    log_warn(f"Could not delete {name} from User env: {e}")
    except OSError as e:
        log_warn(f"Could not open User Environment key: {e}")
    return removed


def remove_portable_tooling_windows(hermes_home: Path) -> list[Path]:
    """Delete PortableGit and Node installs the Windows installer created under
    ``%LOCALAPPDATA%\\agentx\\``.  Only called on full uninstall; they're
    isolated from any system Git / Node so they cannot break other tools."""
    removed: list[Path] = []
    for sub in ("git", "node", "gateway-service"):
        target = hermes_home / sub
        if target.exists():
            try:
                shutil.rmtree(target, ignore_errors=False)
                removed.append(target)
            except Exception as e:
                log_warn(f"Could not remove {target}: {e}")
    return removed


def _is_windows() -> bool:
    import sys
    return sys.platform == "win32"


# ============================================================================
# Deleting the tree we are running from
# ============================================================================
#
# THE BUG THIS EXISTS FOR
# -----------------------
# ``agentx`` on Windows is ``<AGENTX_HOME>\agentx-agent\venv\Scripts\agentx.exe``
# — inside the very tree ``agentx uninstall`` is asked to delete. Windows takes
# a mandatory lock on a running image and on every DLL it has loaded, so the
# rmtree hits the venv, raises PermissionError partway through, and stops. What
# is left is a half-deleted checkout that still contains agentx.exe, with the
# User PATH entry still pointing at it — so the command is still there, running
# it again fails the same way, and running it a third time finds a tree too
# broken to import from. That is "I ran agentx uninstall many times and it is
# still in my terminal", exactly.
#
# POSIX has no such problem: unlinking a running executable is legal, and the
# process keeps its open inode until it exits. So this is Windows-only, and the
# spawn is gated accordingly rather than being written as a cross-platform
# ritual nobody can test.
#
# The desktop app already solved this shape for its own uninstall button, by
# handing the work to a detached child that waits for the app to exit
# (apps/desktop/electron/desktop-uninstall.ts). The CLI needs the same thing
# and did not have it.


def running_inside(path: Path) -> bool:
    """True when the interpreter executing us lives under ``path``.

    That is the condition under which Windows cannot complete the delete —
    and, on any platform, the reason to double-check before assuming an
    ordinary rmtree failure was transient.
    """
    try:
        executable = Path(sys.executable).resolve()
    except (OSError, ValueError):
        return False

    try:
        target = path.resolve()
    except OSError:
        return False

    return target == executable or target in executable.parents


def build_windows_cleanup_script(pid: int, targets: "list[Path]") -> str:
    """A cmd script that deletes ``targets`` once process ``pid`` is gone.

    Bounded everywhere. The wait is capped so a mismatched or never-exiting
    PID cannot wedge the cleanup forever, and each delete is retried because
    Windows releases directory handles lazily — a single ``rmdir /s /q``
    straight after the process exits routinely half-fails.

    ``/FI "PID eq N"`` is an exact filter, and the ``findstr`` matches the
    number as a whole space-delimited token, so PID 99 cannot match PID 990.

    Finally the script deletes itself, so a machine that reboots mid-wait is
    left with one stray file in TEMP at worst.
    """
    quoted = lambda value: '"{}"'.format(str(value).replace('"', ""))

    lines = [
        "@echo off",
        "setlocal enableextensions",
        f'set "PID={int(pid)}"',
        "set /a waited=0",
        ":waitloop",
        'tasklist /NH /FI "PID eq %PID%" 2>nul | findstr /r /c:" %PID% " >nul',
        "if %ERRORLEVEL% neq 0 goto gone",
        "set /a waited+=1",
        "if %waited% geq 60 goto gone",
        "timeout /t 1 /nobreak >nul",
        "goto waitloop",
        ":gone",
    ]

    for index, target in enumerate(targets):
        path = quoted(target)
        lines += [
            f"set /a tries{index}=0",
            f":rm{index}",
            f"if not exist {path} goto done{index}",
            f"rmdir /s /q {path} >nul 2>&1",
            f"del /f /q {path} >nul 2>&1",
            f"if not exist {path} goto done{index}",
            f"set /a tries{index}+=1",
            f"if %tries{index}% geq 10 goto done{index}",
            "timeout /t 1 /nobreak >nul",
            f"goto rm{index}",
            f":done{index}",
        ]

    lines += ['del /f /q "%~f0" >nul 2>&1', ""]

    return "\r\n".join(lines)


def spawn_detached_cleanup(targets: "list[Path]") -> "Path | None":
    """Hand ``targets`` to a detached child that finishes after we exit.

    Returns the script path, or ``None`` when nothing was scheduled — this is
    not the platform that needs it, there is nothing left to delete, or the
    spawn failed. A failure here is reported by the caller as "these paths are
    still on disk", never as a silent success: telling somebody the uninstall
    finished while their venv is still there is how this defect stayed hidden.
    """
    remaining = [t for t in targets if t.exists()]
    if not remaining or not _is_windows():
        return None

    import tempfile

    try:
        script = Path(tempfile.gettempdir()) / f"agentx-uninstall-{os.getpid()}.cmd"
        script.write_text(
            build_windows_cleanup_script(os.getpid(), remaining), encoding="utf-8"
        )
    except OSError as e:
        log_warn(f"Could not write the deferred cleanup script: {e}")
        return None

    # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: the child must outlive this
    # process and must not die with the console it was launched from.
    creationflags = getattr(subprocess, "DETACHED_PROCESS", 0x00000008) | getattr(
        subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200
    )

    try:
        subprocess.Popen(  # noqa: S603 - fixed argv, path written by us above
            ["cmd.exe", "/c", str(script)],
            creationflags=creationflags,
            close_fds=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as e:
        log_warn(f"Could not start the deferred cleanup: {e}")
        return None

    return script


def _remove_tree(path: Path) -> bool:
    """Delete ``path``. Returns False when anything survived.

    ``shutil.rmtree`` stops at the first error, which on Windows means the
    locked venv aborts the walk and leaves most of the tree in place. Passing
    ``onerror`` lets it get through everything it CAN delete, so the deferred
    cleanup is left with the locked remainder rather than the whole checkout —
    and so a machine that never runs the deferred pass is still mostly clean.
    """
    if not path.exists():
        return True

    failures: list[str] = []

    # ``onexc`` replaced ``onerror`` in 3.12 and the old name warns there; both
    # spellings do the same job for us, which is "keep going and tell me".
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=lambda _func, target, _exc: failures.append(str(target)))
    else:
        shutil.rmtree(path, onerror=lambda _func, target, _info: failures.append(str(target)))

    return not (path.exists() or failures)


def _is_default_hermes_home(hermes_home: Path) -> bool:
    """Return True when ``hermes_home`` points at the default (non-profile) root."""
    try:
        from hermes_constants import get_default_hermes_root
        return hermes_home.resolve() == get_default_hermes_root().resolve()
    except Exception:
        return False


def _discover_named_profiles():
    """Return a list of ``ProfileInfo`` for every non-default profile, or ``[]``
    if profile support is unavailable or nothing is installed beyond the
    default root."""
    try:
        from hermes_cli.profiles import list_profiles
    except Exception:
        return []
    try:
        return [p for p in list_profiles() if not getattr(p, "is_default", False)]
    except Exception as e:
        log_warn(f"Could not enumerate profiles: {e}")
        return []


def _uninstall_profile(profile) -> None:
    """Fully uninstall a single named profile: stop its gateway service,
    remove its alias wrapper, and wipe its AGENTX_HOME directory.

    We shell out to ``agentx -p <name> gateway stop|uninstall`` because
    service names, unit paths, and plist paths are all derived from the
    current AGENTX_HOME and can't be easily switched in-process.
    """
    import sys as _sys
    name = profile.name
    profile_home = profile.path

    log_info(f"Uninstalling profile '{name}'...")

    # 1. Stop and remove this profile's gateway service.
    #    Use `python -m hermes_cli.main` so we don't depend on a `agentx`
    #    wrapper that may be half-removed mid-uninstall.
    hermes_invocation = [_sys.executable, "-m", "hermes_cli.main", "--profile", name]
    for subcmd in ("stop", "uninstall"):
        try:
            subprocess.run(
                hermes_invocation + ["gateway", subcmd],
                capture_output=True,
                text=True, encoding='utf-8', errors='replace',
                timeout=60,
                check=False,
            )
        except subprocess.TimeoutExpired:
            log_warn(f"  Gateway {subcmd} timed out for '{name}'")
        except Exception as e:
            log_warn(f"  Could not run gateway {subcmd} for '{name}': {e}")

    # 2. Remove the wrapper alias script at ~/.local/bin/<name> (if any).
    alias_path = getattr(profile, "alias_path", None)
    if alias_path and alias_path.exists():
        try:
            alias_path.unlink()
            log_success(f"  Removed alias {alias_path}")
        except Exception as e:
            log_warn(f"  Could not remove alias {alias_path}: {e}")

    # 3. Wipe the profile's AGENTX_HOME directory.
    try:
        if profile_home.exists():
            shutil.rmtree(profile_home)
            log_success(f"  Removed {profile_home}")
    except Exception as e:
        log_warn(f"  Could not remove {profile_home}: {e}")


def run_gui_uninstall(args):
    """GUI-only uninstall: remove the Chat GUI, leave the agent + data intact.

    Mirrors ``agentx uninstall --gui``. Removes the desktop app's built
    artifacts, the packaged app bundle (best-effort), and the Electron
    userData dir — nothing under ``$AGENTX_HOME`` config/sessions/.env, and
    never the Python agent or its venv.
    """
    from hermes_cli.gui_uninstall import (
        agent_is_installed,
        gui_install_summary,
        uninstall_gui,
    )

    hermes_home = get_hermes_home()
    summary = gui_install_summary(hermes_home)
    skip_confirm = bool(getattr(args, "yes", False))

    print()
    print(color("┌─────────────────────────────────────────────────────────┐", Colors.MAGENTA, Colors.BOLD))
    print(color("│         ⬡ AgentX Chat GUI Uninstaller                  │", Colors.MAGENTA, Colors.BOLD))
    print(color("└─────────────────────────────────────────────────────────┘", Colors.MAGENTA, Colors.BOLD))
    print()

    if not summary["gui_installed"]:
        print("No AgentX Chat GUI installation was found.")
        print(f"  Checked: {hermes_home}, and the standard app locations for this OS.")
        return

    print(color("This removes the Chat GUI only. The AgentX agent stays installed.", Colors.CYAN))
    print()
    print(color("Will remove:", Colors.YELLOW, Colors.BOLD))
    for p in summary["source_built_artifacts"]:
        print(f"  • {p}")
    for p in summary["packaged_app_paths"]:
        print(f"  • {p}")
    if summary["userdata_exists"]:
        print(f"  • {summary['userdata_dir']}  (desktop app data)")
    print()
    if agent_is_installed(hermes_home):
        print(color("Kept intact:", Colors.GREEN, Colors.BOLD))
        print(f"  • The AgentX agent at {hermes_home / 'agentx-agent'}")
        print(f"  • Your config, sessions, and secrets under {hermes_home}")
        print()

    if not skip_confirm:
        try:
            confirm = input(f"Type '{color('yes', Colors.YELLOW)}' to remove the Chat GUI: ").strip().lower()
        except (KeyboardInterrupt, EOFError):
            print()
            print("Cancelled.")
            return
        if confirm != "yes":
            print()
            print("Uninstall cancelled.")
            return

    print()
    print(color("Uninstalling Chat GUI...", Colors.CYAN, Colors.BOLD))
    print()
    uninstall_gui(hermes_home)

    print()
    print(color("┌─────────────────────────────────────────────────────────┐", Colors.GREEN, Colors.BOLD))
    print(color("│            ✓ Chat GUI Uninstalled!                      │", Colors.GREEN, Colors.BOLD))
    print(color("└─────────────────────────────────────────────────────────┘", Colors.GREEN, Colors.BOLD))
    print()
    print("The AgentX agent is still installed. Run 'agentx' to use the CLI,")
    print("or 'agentx uninstall' to remove the agent too.")
    print()


def wants_full_uninstall(args) -> bool:
    """Resolve the two flags into one answer: wipe everything, or keep data?

    Uninstall removes everything unless ``--keep-data`` says otherwise. It did
    not always: the default was keep-data, chosen so a reinstall could pick up
    where you left off. In practice that is what made "I uninstalled it" and
    "it is gone" two different states — the old config, the old .env, and the
    old model key all survived, and the next install silently adopted them
    instead of provisioning fresh. Somebody uninstalling wants it gone; keeping
    a copy of their secrets is the surprising half, so it is the half that now
    has to be asked for.

    ``--full`` predates this and used to be how you asked for a wipe. It is
    still accepted, and now means what it always said, because scripts and
    docs carrying it should not quietly start doing the opposite of a wipe.
    """
    return not bool(getattr(args, "keep_data", False))


def run_uninstall(args):
    """
    Run the uninstall process.

    Options:
    - Full uninstall (the default): removes code + ~/.agentx/ (configs, data,
      logs), the agentx command, shortcuts, and the desktop app's own state
    - Keep data (``--keep-data``): removes code but keeps ~/.agentx/ for a
      future reinstall
    """
    project_root = get_project_root()
    hermes_home = get_hermes_home()

    if bool(getattr(args, "dry_run", False)):
        _print_uninstall_dry_run(
            project_root=project_root,
            hermes_home=hermes_home,
            full_uninstall=wants_full_uninstall(args),
        )
        return

    # Detect named profiles when uninstalling from the default root —
    # offer to clean them up too instead of leaving zombie AGENTX_HOMEs
    # and systemd units behind.
    is_default_profile = _is_default_hermes_home(hermes_home)
    named_profiles = _discover_named_profiles() if is_default_profile else []

    # Non-interactive fast path (``--yes``): no prompts. A full wipe unless
    # ``--keep-data`` was passed. Named profiles are NOT auto-removed here —
    # that's a destructive, surprising default for an unattended run, so it
    # stays opt-in to the interactive flow. This is the path the desktop app's
    # detached cleanup script uses for its lite/full modes.
    skip_confirm = bool(getattr(args, "yes", False))
    if skip_confirm:
        full_uninstall = wants_full_uninstall(args)
        _perform_uninstall(
            project_root=project_root,
            hermes_home=hermes_home,
            full_uninstall=full_uninstall,
            remove_profiles=False,
            named_profiles=named_profiles,
        )
        return

    print()
    print(color("┌─────────────────────────────────────────────────────────┐", Colors.MAGENTA, Colors.BOLD))
    print(color("│            ⬡ AgentX Workmate Uninstaller                  │", Colors.MAGENTA, Colors.BOLD))
    print(color("└─────────────────────────────────────────────────────────┘", Colors.MAGENTA, Colors.BOLD))
    print()
    
    # Show what will be affected
    print(color("Current Installation:", Colors.CYAN, Colors.BOLD))
    print(f"  Code:    {project_root}")
    print(f"  Config:  {hermes_home / 'config.yaml'}")
    print(f"  Secrets: {hermes_home / '.env'}")
    print(f"  Data:    {hermes_home / 'cron/'}, {hermes_home / 'sessions/'}, {hermes_home / 'logs/'}")
    print()

    if named_profiles:
        print(color("Other profiles detected:", Colors.CYAN, Colors.BOLD))
        for p in named_profiles:
            running = " (gateway running)" if getattr(p, "gateway_running", False) else ""
            print(f"  • {p.name}{running}: {p.path}")
        print()
    
    # Ask for confirmation. Option 1 is the full wipe and bare Enter picks it:
    # somebody who typed `agentx uninstall` wants it gone, and leaving their
    # config, .env and model key behind is the choice that needs asking for.
    print(color("Uninstall Options:", Colors.YELLOW, Colors.BOLD))
    print()
    print("  1) " + color("Remove everything", Colors.RED) + " - code, the agentx command, shortcuts,")
    print("     configs, sessions, logs, and the desktop app's data")
    print("     (Recommended - this is what 'uninstall' should mean)")
    print()
    print("  2) " + color("Keep my data", Colors.GREEN) + " - remove the code but keep configs/sessions/logs")
    print(f"     (Leaves {hermes_home} in place for a future reinstall)")
    print()
    print("  3) " + color("Cancel", Colors.CYAN) + " - Don't uninstall")
    print()

    try:
        choice = input(color("Select option [1/2/3] (default 1): ", Colors.BOLD)).strip()
    except (KeyboardInterrupt, EOFError):
        print()
        print("Cancelled.")
        return

    if choice == "3" or choice.lower() in {"c", "cancel", "q", "quit", "n", "no"}:
        print()
        print("Uninstall cancelled.")
        return

    full_uninstall = choice != "2"

    # When doing a full uninstall from the default profile, also offer to
    # remove any named profiles — stopping their gateway services, unlinking
    # their alias wrappers, and wiping their AGENTX_HOME dirs. Otherwise
    # those leave zombie services and data behind.
    remove_profiles = False
    if full_uninstall and named_profiles:
        print()
        print(color("Other profiles will NOT be removed by default.", Colors.YELLOW))
        print(f"Found {len(named_profiles)} named profile(s): " +
              ", ".join(p.name for p in named_profiles))
        print()
        try:
            resp = input(color(
                f"Also stop and remove these {len(named_profiles)} profile(s)? [y/N]: ",
                Colors.BOLD
            )).strip().lower()
        except (KeyboardInterrupt, EOFError):
            print()
            print("Cancelled.")
            return
        remove_profiles = resp in {"y", "yes"}

    # Final confirmation
    print()
    if full_uninstall:
        print(color("⚠️  WARNING: This will permanently delete ALL AgentX data!", Colors.RED, Colors.BOLD))
        print(color("   Including: configs, API keys, sessions, scheduled jobs, logs", Colors.RED))
        if remove_profiles:
            print(color(
                f"   Plus {len(named_profiles)} profile(s): " +
                ", ".join(p.name for p in named_profiles),
                Colors.RED
            ))
    else:
        print("This will remove the AgentX code but keep your configuration and data.")
    
    print()
    try:
        confirm = input(f"Type '{color('yes', Colors.YELLOW)}' to confirm: ").strip().lower()
    except (KeyboardInterrupt, EOFError):
        print()
        print("Cancelled.")
        return
    
    if confirm != "yes":
        print()
        print("Uninstall cancelled.")
        return

    _perform_uninstall(
        project_root=project_root,
        hermes_home=hermes_home,
        full_uninstall=full_uninstall,
        remove_profiles=remove_profiles,
        named_profiles=named_profiles,
    )


def _print_uninstall_dry_run(*, project_root: Path, hermes_home: Path, full_uninstall: bool) -> None:
    """Print the uninstall plan without stopping services or deleting files."""
    print()
    print(color("Dry run: no files, services, or environment entries will be changed.", Colors.CYAN, Colors.BOLD))
    print()
    print(color("Would inspect/remove:", Colors.YELLOW, Colors.BOLD))
    print("  • Gateway services and standalone gateway processes")
    print("  • AgentX PATH entries from shell configs / Windows User PATH")
    print("  • AgentX wrapper scripts and AgentX-managed node/npm/npx symlinks")
    print("  • Desktop Chat GUI artifacts")
    for path in desktop_shortcut_paths():
        print(f"  • Shortcut: {path}")
    for path in desktop_runtime_data_paths():
        print(f"  • Desktop app data: {path}")
    print(f"  • Code checkout: {project_root}")
    if full_uninstall:
        print(f"  • AgentX config/data: {hermes_home}")
        if _is_default_hermes_home(hermes_home):
            profiles = _discover_named_profiles()
            if profiles:
                print("  • Named profiles (interactive uninstall asks before removing):")
                for prof in profiles:
                    print(f"    - {prof.name}: {prof.path}")
    else:
        print(f"  • Keep AgentX config/data: {hermes_home}")
    print()


def _perform_uninstall(
    *,
    project_root: Path,
    hermes_home: Path,
    full_uninstall: bool,
    remove_profiles: bool,
    named_profiles: list,
) -> None:
    """Execute the uninstall steps. Shared by the interactive and ``--yes``
    paths so the destructive sequence lives in exactly one place.

    Steps: stop gateway → strip PATH (rc files + Windows registry) → remove the
    ``agentx`` wrapper + node symlinks → remove the desktop Chat GUI artifacts →
    delete the code checkout → (Windows) remove PortableGit/Node → optionally
    wipe ``$AGENTX_HOME`` data and named profiles on full uninstall.
    """
    print()
    print(color("Uninstalling...", Colors.CYAN, Colors.BOLD))
    print()
    
    # 1. Stop and uninstall gateway service + kill standalone processes
    log_info("Checking for running gateway...")
    if not uninstall_gateway_service():
        log_info("No gateway service or processes found")
    
    # 2. Remove PATH entries from shell configs (POSIX) AND from the Windows
    #    User-scope registry.  Both helpers no-op on the wrong platform so we
    #    can safely call them unconditionally.
    log_info("Removing PATH entries from shell configs...")
    removed_configs = remove_path_from_shell_configs()
    if removed_configs:
        for config in removed_configs:
            log_success(f"Updated {config}")
    else:
        log_info("No PATH entries found to remove in shell rc files")

    if _is_windows():
        log_info("Removing PATH entries from Windows User environment...")
        # Expand %LOCALAPPDATA% etc. in hermes_home so the marker matching is
        # against fully resolved paths — installer writes literal strings
        # like C:\Users\<u>\AppData\Local\agentx\git\cmd, not %LOCALAPPDATA%.
        removed_path_entries = remove_path_from_windows_registry(Path(os.path.expandvars(str(hermes_home))))
        if removed_path_entries:
            for entry in removed_path_entries:
                log_success(f"Removed from User PATH: {entry}")
        else:
            log_info("No AgentX-owned PATH entries in User environment")

        log_info("Removing AGENTX_HOME / AGENTX_GIT_BASH_PATH User env vars...")
        removed_env = remove_hermes_env_vars_windows()
        if removed_env:
            for name in removed_env:
                log_success(f"Removed User env var: {name}")
        else:
            log_info("No AgentX-set User env vars to remove")
    
    # 3. Remove wrapper script
    log_info("Removing agentx command...")
    removed_wrappers = remove_wrapper_script()
    if removed_wrappers:
        for wrapper in removed_wrappers:
            log_success(f"Removed {wrapper}")
    else:
        log_info("No wrapper script found")

    # 3b. Remove node/npm/npx symlinks the installer left in ~/.local/bin
    #     (only when they still point into this AgentX home's node dir, so we
    #     never clobber an existing nvm / user-managed Node).
    log_info("Removing AgentX-managed node/npm/npx symlinks...")
    removed_node_links = remove_node_symlinks(hermes_home)
    if removed_node_links:
        for link in removed_node_links:
            log_success(f"Removed {link}")
    else:
        log_info("No AgentX-managed node/npm/npx symlinks found")

    # 3c. Remove the desktop Chat GUI's artifacts too (built renderer/release,
    #     node_modules, the packaged app bundle, and the Electron userData
    #     dir). Both the "keep data" and "full" CLI flows remove the agent
    #     code, so the GUI — which is just another consumer of the same
    #     checkout — should go with it. uninstall_gui() never touches config /
    #     sessions / .env, so it's safe in keep-data mode; on full uninstall the
    #     step-5 rmtree(hermes_home) would sweep the in-tree artifacts anyway,
    #     but the packaged app + Electron userData live OUTSIDE AGENTX_HOME and
    #     must be cleaned explicitly here.
    log_info("Removing desktop Chat GUI artifacts...")
    try:
        from hermes_cli.gui_uninstall import uninstall_gui
        gui_removed = uninstall_gui(hermes_home)
        if not gui_removed:
            log_info("No desktop GUI artifacts found")
    except Exception as e:
        log_warn(f"Could not remove desktop GUI artifacts: {e}")

    # 3d. Shortcuts and the per-user Electron/Chromium directories. Both live
    #     outside the checkout and outside AGENTX_HOME, so neither of the
    #     rmtrees below would ever reach them — which is why a "finished"
    #     uninstall used to leave the icon sitting on the desktop.
    log_info("Removing shortcuts and desktop app data...")
    removed_leftovers = remove_desktop_leftovers()
    if removed_leftovers:
        for path in removed_leftovers:
            log_success(f"Removed {path}")
    else:
        log_info("No shortcuts or desktop app data found")

    # Paths a locked file stopped us from deleting. Handed to a detached child
    # at the end, which finishes once this process is gone.
    pending: list[Path] = []

    # 4. Remove installation directory (code)
    log_info("Removing installation directory...")

    if project_root.exists():
        if _remove_tree(project_root):
            log_success(f"Removed {project_root}")
        else:
            pending.append(project_root)

    # 4b. Remove Windows-only installer artifacts that are NOT user data:
    #     PortableGit, bundled Node, gateway-service dir.  Installer put them
    #     under AGENTX_HOME but they're install tooling, not config — safe to
    #     remove even in "keep data" mode.  If we're doing a full uninstall
    #     the step-5 rmtree(hermes_home) would sweep them anyway; calling
    #     this helper there is a no-op since they'll already be gone.
    if _is_windows():
        log_info("Removing Windows installer artifacts (PortableGit, Node, gateway-service)...")
        removed_artifacts = remove_portable_tooling_windows(hermes_home)
        if removed_artifacts:
            for path in removed_artifacts:
                log_success(f"Removed {path}")
        else:
            log_info("No Windows installer artifacts to remove")
    
    # 5. Optionally remove ~/.agentx/ data directory (and named profiles)
    if full_uninstall:
        # 5a. Stop and remove each named profile's gateway service and
        #     alias wrapper. The profile AGENTX_HOME dirs live under
        #     ``<default>/profiles/<name>/`` and will be swept away by the
        #     rmtree below, but services + alias scripts live OUTSIDE the
        #     default root and have to be cleaned up explicitly.
        if remove_profiles and named_profiles:
            for prof in named_profiles:
                _uninstall_profile(prof)

        log_info("Removing configuration and data...")
        if hermes_home.exists():
            if _remove_tree(hermes_home):
                log_success(f"Removed {hermes_home}")
            else:
                pending.append(hermes_home)
    else:
        log_info(f"Keeping configuration and data in {hermes_home}")

    # 6. Whatever a lock stopped us from deleting. On Windows that is normally
    #    the venv holding this very python.exe, and it is the difference
    #    between an uninstall that works and one the user runs five times.
    if pending:
        script = spawn_detached_cleanup(pending)
        if script:
            log_info(
                "Some files are locked by this running process; a background "
                "cleanup will remove them the moment it exits:"
            )
            for path in pending:
                log_info(f"  • {path}")
        else:
            log_warn("These could not be removed and are still on disk:")
            for path in pending:
                log_warn(f"  • {path}")
            log_info("Close any AgentX process and delete them by hand.")


    # Done
    print()
    print(color("┌─────────────────────────────────────────────────────────┐", Colors.GREEN, Colors.BOLD))
    print(color("│              ✓ Uninstall Complete!                      │", Colors.GREEN, Colors.BOLD))
    print(color("└─────────────────────────────────────────────────────────┘", Colors.GREEN, Colors.BOLD))
    print()
    
    if not full_uninstall:
        print(color("Your configuration and data have been preserved:", Colors.CYAN))
        print(f"  {hermes_home}/")
        print()
        print("To reinstall later with your existing settings:")
        if _is_windows():
            print(color("  iex (irm https://raw.githubusercontent.com/TrungKiencding/AgentX-Workmate/main/scripts/install.ps1)", Colors.DIM))
        else:
            print(color("  curl -fsSL https://raw.githubusercontent.com/TrungKiencding/AgentX-Workmate/main/scripts/install.sh | bash", Colors.DIM))
        print()

    if _is_windows():
        print(color("Open a new terminal (PowerShell / Windows Terminal) to pick up", Colors.YELLOW))
        print(color("the updated User PATH and environment variables.", Colors.YELLOW))
    else:
        print(color("Reload your shell to complete the process:", Colors.YELLOW))
        print("  source ~/.bashrc  # or ~/.zshrc")
    print()
    print("Thank you for using AgentX Workmate! ⬡")
    print()


class _UninstallArgs:
    """Lightweight args namespace for the module entrypoint below."""

    def __init__(self, *, mode: str):
        self.gui = mode == "gui"
        self.gui_summary = False
        self.full = mode == "full"
        # ``lite`` is the desktop's name for "remove the agent, keep my data",
        # which is exactly what --keep-data means on the command line.
        self.keep_data = mode == "lite"
        self.yes = True  # the module entrypoint is always non-interactive


def main(argv=None) -> int:
    """Module entrypoint: ``python -m hermes_cli.uninstall --mode <gui|lite|full>``.

    Exists so the desktop app can run the uninstall under a Python interpreter
    OUTSIDE the venv being deleted. On Windows, ``lite``/``full`` rmtree the
    venv that contains the running ``python.exe`` — and a running .exe is
    mandatory-locked, so doing that from the venv's own interpreter half-fails.
    The desktop launches this with the system Python + ``PYTHONPATH=<agentRoot>``
    so ``import hermes_cli`` resolves from source while the venv is torn down.

    This module imports only stdlib + ``hermes_constants`` + ``hermes_cli.colors``
    (and lazily ``hermes_cli.gui_uninstall``), so it runs fine under a bare
    system Python with no site-packages from the venv.
    """
    import argparse

    parser = argparse.ArgumentParser(prog="python -m hermes_cli.uninstall")
    parser.add_argument(
        "--mode",
        choices=["gui", "lite", "full"],
        required=True,
        help="gui = Chat GUI only; lite = GUI + agent, keep data; full = everything",
    )
    ns = parser.parse_args(argv)
    args = _UninstallArgs(mode=ns.mode)

    if args.gui:
        run_gui_uninstall(args)
    else:
        run_uninstall(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
