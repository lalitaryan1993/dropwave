@echo off
rem Builds dwkvm.exe (one mouse and keyboard for two PCs) into build\kvm (x64). Needs Visual Studio 2022 C++ build tools.
setlocal
set "ROOT=%~dp0"
set "OUT=%ROOT%..\..\build\kvm"
set "VCVARS="
for %%e in (BuildTools Community Professional Enterprise) do (
  if not defined VCVARS if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\%%e\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\%%e\VC\Auxiliary\Build\vcvars64.bat"
  if not defined VCVARS if exist "%ProgramFiles%\Microsoft Visual Studio\2022\%%e\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%ProgramFiles%\Microsoft Visual Studio\2022\%%e\VC\Auxiliary\Build\vcvars64.bat"
)
if not defined VCVARS (echo Visual Studio 2022 C++ build tools not found & exit /b 1)
call "%VCVARS%" >nul || exit /b 1
if not exist "%OUT%" mkdir "%OUT%"
cd /d "%ROOT%"
cl /nologo /O2 /EHsc /std:c++17 /W3 /DUNICODE /D_UNICODE /D_CRT_SECURE_NO_WARNINGS dwkvm.cpp /link /SUBSYSTEM:CONSOLE /OUT:"%OUT%\dwkvm.exe" user32.lib shell32.lib || exit /b 1
del /q *.obj 2>nul
echo built %OUT%
