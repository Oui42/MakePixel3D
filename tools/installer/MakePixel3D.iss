; MakePixel3D installer (Inno Setup 6). Built by tools\installer\build.ps1 (passes the version and repository).
; The installer is SMALL (script + icon + license) and ONLINE: all the work (downloading the latest release from GitHub,
; Python, PyTorch cpu/cu128 depending on the graphics card, libraries, TripoSR, AI models ~1.8 GB, WebView2) is done by
; tools\installer\install.ps1, run WITHOUT a console after the files are copied (ssPostInstall). Progress is shown on a
; wizard page (the script writes step and description to a status file, the wizard reads it every 300 ms). An error =
; a message box and an entry in logs\install.log; running the installer again completes the installation (steps skip
; what is already there).
; Always installed for all users (administrator), by default to C:\Program Files\MakePixel3D - the folder can be changed.
; User data (gallery, settings, logs, updates, cache) then lives in %LOCALAPPDATA%\MakePixel3D (server/paths.py) and the
; program installs updates with administrator rights (UAC prompt).
; Uninstalling removes the program, libraries and AI models; the uninstaller asks whether to delete the gallery,
; settings and cache too.
; Command-line parameter: /torch=cpu or /torch=cu128 forces the PyTorch variant (default: detected NVIDIA card).
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Repo
  #define Repo "Oui42/MakePixel3D"
#endif
#define AppName "MakePixel3D"
#define Root "..\.."

[Setup]
AppId={{7E2B7C1A-6C1F-4C6E-9C2D-9B1C3A7D2E4F}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=ouix42
AppPublisherURL=https://github.com/{#Repo}
AppSupportURL=https://github.com/{#Repo}/issues
AppUpdatesURL=https://github.com/{#Repo}/releases
; ALWAYS for all users (C:\Program Files). No "all users / me only" dialog: with that dialog Inno re-launches itself
; elevated, which failed on the author's computer ("must be logged in as administrator"). With PrivilegesRequired=admin
; and no overrides Windows shows the UAC prompt right when the file is started (requireAdministrator manifest).
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableDirPage=no
DisableProgramGroupPage=yes
DisableWelcomePage=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#Root}\dist
OutputBaseFilename={#AppName}-Setup
SetupIconFile={#Root}\assets\makepixel3d.ico
UninstallDisplayIcon={app}\assets\makepixel3d.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ExtraDiskSpaceRequired=6442450944

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"; LicenseFile: "{#Root}\LICENSE.txt"

[CustomMessages]
english.Intro=Setup will download the latest program version, Python, libraries (PyTorch) and AI models from the internet – about 4 GB in total. An internet connection is required; afterwards the program works offline.
english.ProgressTitle=Downloading and installing components
english.ProgressDesc=Program, Python, PyTorch, libraries and AI models (about 4 GB). This can take 10–20 minutes depending on your connection.
english.Starting=Starting installation…
english.Failed=Installation failed:%n%n%1%n%nDetails: %2%n%nRun the installer again – components already downloaded will not be downloaded twice.
english.ExitCode=the installation script exited with code %1
english.Done=MakePixel3D is ready to use.

[Files]
Source: "install.ps1"; DestDir: "{app}\tools\installer"; Flags: ignoreversion
Source: "{#Root}\assets\makepixel3d.ico"; DestDir: "{app}\assets"; Flags: ignoreversion
Source: "{#Root}\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\.venv\Scripts\pythonw.exe"; Parameters: "server\launch.py"; WorkingDir: "{app}"; IconFilename: "{app}\assets\makepixel3d.ico"; Comment: "MakePixel3D – photo to 3D pixel art"
Name: "{group}\{#AppName} (console)"; Filename: "{app}\start-debug.bat"; WorkingDir: "{app}"; IconFilename: "{app}\assets\makepixel3d.ico"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\.venv\Scripts\pythonw.exe"; Parameters: "server\launch.py"; WorkingDir: "{app}"; IconFilename: "{app}\assets\makepixel3d.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Run]
Filename: "{app}\.venv\Scripts\pythonw.exe"; Parameters: "server\launch.py"; WorkingDir: "{app}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent; Check: InstallSucceeded

; Uninstall: everything except library\ (user work) and config\ (settings); see CurUninstallStepChanged below.
[UninstallDelete]
Type: filesandordirs; Name: "{app}\.venv"
Type: filesandordirs; Name: "{app}\models"
Type: filesandordirs; Name: "{app}\server"
Type: filesandordirs; Name: "{app}\web"
Type: filesandordirs; Name: "{app}\tools"
Type: filesandordirs; Name: "{app}\assets"
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\updates"
Type: filesandordirs; Name: "{app}\cache"
Type: files; Name: "{app}\*.bat"
Type: files; Name: "{app}\*.md"
Type: files; Name: "{app}\*.json"
Type: files; Name: "{app}\*.txt"
Type: files; Name: "{app}\*.lnk"

[Code]
var
  ProgressPage: TOutputProgressWizardPage;
  InstallOK: Boolean;
  StatusFile, LastError: String;
  TimerId: LongWord;

function SetTimer(hWnd: LongWord; nIDEvent, uElapse: LongWord; lpTimerFunc: LongWord): LongWord;
  external 'SetTimer@user32.dll stdcall';
function KillTimer(hWnd: LongWord; nIDEvent: LongWord): Boolean;
  external 'KillTimer@user32.dll stdcall';

function InstallSucceeded: Boolean;
begin
  Result := InstallOK;
end;

// First field delimited by | - removes it from S
function NextField(var S: String): String;
var
  P: Integer;
begin
  P := Pos('|', S);
  if P = 0 then begin
    Result := S; S := '';
  end else begin
    Result := Copy(S, 1, P - 1); Delete(S, 1, P);
  end;
end;

// Every 300 ms: status file -> progress page. Format: step|total|title|detail, ERROR|description, DONE|
procedure TimerProc(H: LongWord; Msg: LongWord; IdEvent: LongWord; Time: LongWord);
var
  Raw: AnsiString;
  S, F1, F2, F3: String;
  Step, Total: Integer;
begin
  if not LoadStringFromFile(StatusFile, Raw) then exit;
  S := String(Raw);
  F1 := NextField(S);
  if F1 = 'ERROR' then begin
    LastError := S; exit;
  end;
  if F1 = 'DONE' then exit;
  Step := StrToIntDef(F1, 0);
  Total := StrToIntDef(NextField(S), 7);
  F2 := NextField(S);
  F3 := S;
  ProgressPage.SetText(F2, F3);
  ProgressPage.SetProgress(Step, Total);
end;

procedure InitializeWizard;
var
  P: TNewStaticText;
begin
  InstallOK := False;
  P := TNewStaticText.Create(WizardForm);
  P.Parent := WizardForm.SelectDirPage;
  P.Top := WizardForm.DirEdit.Top + WizardForm.DirEdit.Height + ScaleY(24);
  P.Left := WizardForm.DirEdit.Left;
  P.Width := WizardForm.SelectDirPage.Width - WizardForm.DirEdit.Left;
  P.AutoSize := False;
  P.WordWrap := True;
  P.Height := ScaleY(60);
  P.Caption := CustomMessage('Intro');
  ProgressPage := CreateOutputProgressPage(CustomMessage('ProgressTitle'), CustomMessage('ProgressDesc'));
end;

procedure RunInstallScript;
var
  Script, Params, Detail: String;
  Code: Integer;
begin
  Script := ExpandConstant('{app}\tools\installer\install.ps1');
  StatusFile := ExpandConstant('{app}\logs\setup-status.txt');
  ForceDirectories(ExpandConstant('{app}\logs'));
  DeleteFile(StatusFile);
  LastError := '';
  Params := '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + Script +
            '" -AppDir "' + ExpandConstant('{app}') + '" -Repo "{#Repo}" -NoDesktopShortcut -StatusFile "' + StatusFile + '"';
  if ExpandConstant('{param:torch|auto}') <> 'auto' then
    Params := Params + ' -Torch ' + ExpandConstant('{param:torch}');

  ProgressPage.SetText(CustomMessage('Starting'), '');
  ProgressPage.SetProgress(0, 7);
  ProgressPage.Show;
  TimerId := SetTimer(0, 0, 300, CreateCallback(@TimerProc));
  try
    if not Exec('powershell.exe', Params, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) then
    begin
      Code := -1;
      LastError := 'PowerShell: ' + SysErrorMessage(DLLGetLastError);
    end;
  finally
    KillTimer(0, TimerId);
    ProgressPage.Hide;
  end;
  DeleteFile(StatusFile);

  if Code = 0 then begin
    InstallOK := True;
    exit;
  end;
  Detail := ExpandConstant('{app}\logs\install.log');
  if LastError = '' then LastError := FmtMessage(CustomMessage('ExitCode'), [IntToStr(Code)]);
  MsgBox(FmtMessage(CustomMessage('Failed'), [LastError, Detail]), mbError, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    RunInstallScript;
end;

// Uninstall: program, libraries and AI models always; gallery/settings/cache only after asking.
// Data lives in %LOCALAPPDATA%\MakePixel3D (Program Files installation) or next to the program (writable folder).
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep <> usUninstall then exit;
  if UninstallSilent then exit;
  if MsgBox('Do you also want to delete your gallery of projects, settings and cached data?' + #13#10#13#10 +
            'Yes = remove everything related to MakePixel3D (gallery, settings, AI models, libraries).' + #13#10 +
            'No = remove the program, libraries and AI models, but keep the gallery and settings for a future installation.',
            mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
  begin
    DelTree(ExpandConstant('{localappdata}\MakePixel3D'), True, True, True);
    DelTree(ExpandConstant('{app}\library'), True, True, True);
    DelTree(ExpandConstant('{app}\config'), True, True, True);
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and InstallOK then
    WizardForm.FinishedLabel.Caption := CustomMessage('Done') + #13#10#13#10 + WizardForm.FinishedLabel.Caption;
end;
