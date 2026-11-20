@echo off
rem Builds DropWaveCam.dll and dwcam.exe into build\vcam (x64). Needs Visual Studio 2022 C++ build tools.
setlocal
set "ROOT=%~dp0"
set "OUT=%ROOT%..\..\build\vcam"
set "VCVARS="
for %%e in (BuildTools Community Professional Enterprise) do (
  if not defined VCVARS if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\%%e\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\%%e\VC\Auxiliary\Build\vcvars64.bat"
  if not defined VCVARS if exist "%ProgramFiles%\Microsoft Visual Studio\2022\%%e\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%ProgramFiles%\Microsoft Visual Studio\2022\%%e\VC\Auxiliary\Build\vcvars64.bat"
)
if not defined VCVARS (echo Visual Studio 2022 C++ build tools not found & exit /b 1)
call "%VCVARS%" >nul || exit /b 1
if not exist "%OUT%" mkdir "%OUT%"
cd /d "%ROOT%"
cl /nologo /O2 /EHsc /std:c++17 /W3 /DUNICODE /D_UNICODE /LD source.cpp /link /DEF:source.def /OUT:"%OUT%\DropWaveCam.dll" mfplat.lib mfuuid.lib advapi32.lib ole32.lib || exit /b 1
cl /nologo /O2 /EHsc /std:c++17 /W3 /DUNICODE /D_UNICODE dwcam.cpp /link /OUT:"%OUT%\dwcam.exe" mfplat.lib mfsensorgroup.lib ole32.lib shell32.lib advapi32.lib || exit /b 1
del /q *.obj *.exp *.lib "%OUT%\*.exp" "%OUT%\*.lib" 2>nul
echo built %OUT%
