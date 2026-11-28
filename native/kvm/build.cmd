@echo off
rem Builds dwkvm.exe (one mouse and keyboard for two PCs) into build\kvm (x64). Needs Visual Studio 2022 or later with the C++ build tools.
setlocal
set "ROOT=%~dp0"
set "OUT=%ROOT%..\..\build\kvm"
call "%ROOT%..\vs-env.cmd" || exit /b 1
if not exist "%OUT%" mkdir "%OUT%"
cd /d "%ROOT%"
cl /nologo /O2 /EHsc /std:c++17 /W3 /DUNICODE /D_UNICODE /D_CRT_SECURE_NO_WARNINGS dwkvm.cpp /link /SUBSYSTEM:CONSOLE /OUT:"%OUT%\dwkvm.exe" user32.lib shell32.lib || exit /b 1
del /q *.obj 2>nul
echo built %OUT%
