@echo off
rem Builds DropWaveCam.dll and dwcam.exe into build\vcam (x64). Needs Visual Studio 2022 or later with the C++ build tools.
setlocal
set "ROOT=%~dp0"
set "OUT=%ROOT%..\..\build\vcam"
call "%ROOT%..\vs-env.cmd" || exit /b 1
if not exist "%OUT%" mkdir "%OUT%"
cd /d "%ROOT%"
cl /nologo /O2 /EHsc /std:c++17 /W3 /DUNICODE /D_UNICODE /LD source.cpp /link /DEF:source.def /OUT:"%OUT%\DropWaveCam.dll" mfplat.lib mfuuid.lib advapi32.lib ole32.lib || exit /b 1
cl /nologo /O2 /EHsc /std:c++17 /W3 /DUNICODE /D_UNICODE dwcam.cpp /link /OUT:"%OUT%\dwcam.exe" mfplat.lib mfsensorgroup.lib ole32.lib shell32.lib advapi32.lib || exit /b 1
del /q *.obj *.exp *.lib "%OUT%\*.exp" "%OUT%\*.lib" 2>nul
echo built %OUT%
