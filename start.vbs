' Launch KungWatch without a console window - paths are resolved from this file's location
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & root & "\app\node_modules\electron\dist\electron.exe"" """ & root & "\app""", 0, False
