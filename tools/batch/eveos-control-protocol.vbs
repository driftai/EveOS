Option Explicit

Dim shell, fso, scriptDir, launcher, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = fso.BuildPath(scriptDir, "eveos-control-protocol.bat")

' This wrapper is intentionally windowless. The protocol bootstrap itself is not
' a service; it only asks the real EveOS Local Control launcher to ensure port
' 9082 is available. If Local Control needs to start, its own titled console is
' allowed to remain visible and prints the service purpose/status.
command = Chr(34) & shell.ExpandEnvironmentStrings("%ComSpec%") & Chr(34) _
    & " /d /c " & Chr(34) & Chr(34) & launcher & Chr(34) & Chr(34)

shell.Run command, 0, False
