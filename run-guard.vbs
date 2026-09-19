' Runs guard-bridge.cmd with a hidden window (schtasks fires this every 5 min).
' Resolves its own folder so the task works from any install location.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.Run """" & fso.GetParentFolderName(WScript.ScriptFullName) & "\guard-bridge.cmd""", 0, False
