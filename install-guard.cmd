@echo off
rem Registers the 5-minute guard task for the DeepSeek Browser Bridge.
schtasks /create /tn "DeepSeekBridge-Guard" /tr "wscript.exe \"%~dp0run-guard.vbs\"" /sc minute /mo 5 /f
schtasks /run /tn "DeepSeekBridge-Guard"
