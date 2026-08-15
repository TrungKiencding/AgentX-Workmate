; installer.nsh — AgentX Workmate NSIS customisation.
;
; WHY THIS EXISTS
; ---------------
; A stock electron-builder uninstaller removes exactly what it installed:
; %LOCALAPPDATA%\Programs\AgentX Workmate and its own shortcuts. For most
; Electron apps that is the whole app. For this one it is the front half.
;
; The desktop app bootstraps a Python agent on first launch, and that agent
; lives somewhere the uninstaller has never heard of:
;
;   %LOCALAPPDATA%\agentx\agentx-agent   the checkout and its venv
;   %LOCALAPPDATA%\agentx\git|node       PortableGit and Node, ~200MB
;   HKCU\Environment                     AGENTX_HOME, and a PATH entry pointing
;                                        at ...\agentx-agent\venv\Scripts
;   %APPDATA%\AgentX Workmate            the desktop's own state and token store
;
; So "uninstall" from Programs and Features used to leave `agentx` on the PATH
; of every new terminal, along with the config, the .env, and the LiteLLM key
; inside it — which is how a later reinstall came to silently adopt an old key
; instead of collecting the current one from the second brain.
;
; This file closes that. The uninstall welcome page carries a checkbox, ticked
; by default, that hands the rest of the job to the agent's own uninstaller
; (`python -m hermes_cli.uninstall --mode full`). That module already knows how
; to stop the gateway, strip the registry PATH entry, and delete the venv it is
; itself running from — including the deferred cleanup that finishes after this
; process exits, which is the only way a running python.exe ever gets deleted
; on Windows.

!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"

Var AgentXPurgeCheckbox
Var AgentXPurgeState

; The uninstall welcome page, replaced with one that asks the question. A
; MessageBox would have been fewer lines, but this is the page a user is
; already reading, and a checkbox they can see beats a dialog they dismiss.
!macro customUnWelcomePage
  UninstPage custom un.AgentXPurgePageCreate un.AgentXPurgePageLeave
!macroend

Function un.AgentXPurgePageCreate
  ; No MUI_HEADER_TEXT here: electron-builder inserts this file before MUI2 is
  ; included, so the macro does not exist yet and referencing it fails the NSIS
  ; compile outright. The page keeps the standard uninstaller header, which
  ; already names the app.
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "AgentX Workmate will be removed from this computer."
  Pop $0

  ${NSD_CreateCheckbox} 0 30u 100% 12u "Also remove the AgentX agent, the agentx command, and all AgentX data (recommended)"
  Pop $AgentXPurgeCheckbox
  ${NSD_Check} $AgentXPurgeCheckbox

  ${NSD_CreateLabel} 14u 46u 100% 48u "This removes the agent installed under %LOCALAPPDATA%\agentx, takes the agentx command off your PATH, and deletes your AgentX settings, sessions, and saved model key.$\r$\n$\r$\nLeave it unticked to keep those for a future reinstall. The agentx command will stay available in your terminal."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function un.AgentXPurgePageLeave
  ${NSD_GetState} $AgentXPurgeCheckbox $AgentXPurgeState
FunctionEnd

; Runs before the app directory is deleted.
!macro customUnInstall
  ; An update uninstalls the old version to install the new one over it.
  ; Purging there would delete the agent, the settings, and the model key of an
  ; install that is not going away — so this only ever runs on a real uninstall.
  ${ifNot} ${isUpdated}

    ; Shortcuts scripts/install.ps1 wrote. NSIS only removes the ones it made
    ; itself, and both point at the executable being deleted either way, so
    ; these go regardless of the checkbox.
    Delete "$DESKTOP\AgentX.lnk"
    Delete "$SMPROGRAMS\AgentX.lnk"

    ${If} $AgentXPurgeState == ${BST_CHECKED}
      DetailPrint "Removing the AgentX agent, the agentx command, and AgentX data..."

      ; AGENTX_HOME wins when set (install.ps1 sets it, and an operator may
      ; have pointed it elsewhere); otherwise the installer's own default.
      ReadEnvStr $0 "AGENTX_HOME"
      ${If} $0 == ""
        ReadEnvStr $1 "LOCALAPPDATA"
        StrCpy $0 "$1\agentx"
      ${EndIf}

      StrCpy $1 "$0\agentx-agent"
      StrCpy $2 "$1\venv\Scripts\python.exe"

      ${If} ${FileExists} "$2"
        ; PYTHONPATH so `import hermes_cli` resolves from the checkout even
        ; when the editable install in the venv is half-broken — which is
        ; exactly the state a machine gets into after a failed update, and
        ; precisely when somebody reaches for Uninstall.
        System::Call 'Kernel32::SetEnvironmentVariable(t "PYTHONPATH", t "$1")i.r3'
        ; --mode full is non-interactive and never prompts. The module detects
        ; that it is running from inside the tree it must delete and hands the
        ; locked remainder to a detached cleanup that runs once this python
        ; exits; nothing here has to wait for that.
        nsExec::ExecToLog '"$2" -m hermes_cli.uninstall --mode full'
        Pop $4
        ${If} $4 != 0
          DetailPrint "The agent uninstaller returned $4; some AgentX files may remain in $0"
        ${EndIf}
      ${Else}
        DetailPrint "No AgentX agent found at $1 - nothing else to remove"
      ${EndIf}
    ${Else}
      DetailPrint "Keeping the AgentX agent and your data (the agentx command stays on your PATH)"
    ${EndIf}

  ${endif}
!macroend
