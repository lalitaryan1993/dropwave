// dwcam.exe: DropWave's helper for the "DropWave Camera" virtual webcam (Windows 11).
//   dwcam status             -> prints "installed" / "not-installed" / "unsupported"
//   dwcam install <dll>      -> (as admin) copies the camera to Program Files and registers it
//   dwcam uninstall          -> (as admin) removes it
//   dwcam run                -> adds the camera for this user while it runs; reads frames on stdin:
//                               [u32 little-endian length][NV12 1280x720 bytes], repeated.
//                               Prints "ready" (or "error <code> <text>") once.
#include <windows.h>
#include <mfapi.h>
#include <mfvirtualcamera.h>
#include <shlobj.h>
#include <stdio.h>
#include <string>
#include <vector>
#include "shared.h"

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfsensorgroup.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "advapi32.lib")

static std::wstring installDir() {
    PWSTR pf = nullptr;
    std::wstring d;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_ProgramFiles, 0, nullptr, &pf))) { d = pf; CoTaskMemFree(pf); }
    return d + L"\\DropWave\\Camera";
}

static bool supported() {
    // Virtual cameras need Windows 11 (build 22000+).
    typedef LONG(WINAPI * RtlGetVersionFn)(PRTL_OSVERSIONINFOW);
    RTL_OSVERSIONINFOW v = { sizeof(v) };
    auto fn = (RtlGetVersionFn)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
    return fn && fn(&v) == 0 && v.dwBuildNumber >= 22000;
}

static bool installed() {
    wchar_t path[MAX_PATH]; DWORD n = sizeof(path);
    if (RegGetValueW(HKEY_LOCAL_MACHINE, L"Software\\Classes\\CLSID\\" DWCAM_CLSID_STR L"\\InprocServer32", nullptr, RRF_RT_REG_SZ, nullptr, path, &n) != ERROR_SUCCESS) return false;
    return GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
}

static int install(const wchar_t* src) {
    std::wstring dir = installDir();
    SHCreateDirectoryExW(nullptr, dir.c_str(), nullptr);
    std::wstring dst = dir + L"\\DropWaveCam.dll";
    if (!CopyFileW(src, dst.c_str(), FALSE)) {
        // In use by the camera service: put the new one beside it and swap at the next restart.
        std::wstring tmp = dst + L".new";
        if (!CopyFileW(src, tmp.c_str(), FALSE)) { printf("error copy %lu\n", GetLastError()); return 2; }
        MoveFileExW(tmp.c_str(), dst.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_DELAY_UNTIL_REBOOT);
    }
    HMODULE m = LoadLibraryW(dst.c_str());
    if (!m) { printf("error load %lu\n", GetLastError()); return 3; }
    auto reg = (HRESULT(STDAPICALLTYPE*)())GetProcAddress(m, "DllRegisterServer");
    HRESULT hr = reg ? reg() : E_FAIL;
    FreeLibrary(m);
    if (FAILED(hr)) { printf("error register 0x%08lx\n", (unsigned long)hr); return 4; }
    printf("installed\n");
    return 0;
}

static int uninstall() {
    RegDeleteTreeW(HKEY_LOCAL_MACHINE, L"Software\\Classes\\CLSID\\" DWCAM_CLSID_STR);
    std::wstring dst = installDir() + L"\\DropWaveCam.dll";
    if (!DeleteFileW(dst.c_str())) MoveFileExW(dst.c_str(), nullptr, MOVEFILE_DELAY_UNTIL_REBOOT);
    printf("uninstalled\n");
    return 0;
}

static bool readAll(HANDLE h, void* buf, DWORD n) {
    BYTE* p = (BYTE*)buf;
    while (n) {
        DWORD got = 0;
        if (!ReadFile(h, p, n, &got, nullptr) || !got) return false;
        p += got; n -= got;
    }
    return true;
}

static int run() {
    if (!supported()) { printf("error 0 unsupported\n"); fflush(stdout); return 5; }
    if (!installed()) { printf("error 0 not-installed\n"); fflush(stdout); return 6; }
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    MFStartup(MF_VERSION);
    IMFVirtualCamera* cam = nullptr;
    HRESULT hr = MFCreateVirtualCamera(MFVirtualCameraType_SoftwareCameraSource, MFVirtualCameraLifetime_Session,
        MFVirtualCameraAccess_CurrentUser, DWCAM_NAME, DWCAM_CLSID_STR, nullptr, 0, &cam);
    if (SUCCEEDED(hr)) hr = cam->Start(nullptr);
    if (FAILED(hr)) { printf("error 0x%08lx create\n", (unsigned long)hr); fflush(stdout); if (cam) cam->Release(); return 7; }
    printf("ready\n"); fflush(stdout);

    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    std::vector<BYTE> frame(DWCAM_NV12_SIZE);
    HANDLE map = nullptr;
    DwCamShared* shm = nullptr;
    ULONGLONG lastTry = 0;
    for (;;) {
        UINT32 len = 0;
        if (!readAll(in, &len, 4)) break;
        if (len != DWCAM_NV12_SIZE) {
            // Unknown size: skip it.
            std::vector<BYTE> skip(len < 64 * 1024 * 1024 ? len : 0);
            if (!len || !readAll(in, skip.data(), len)) break;
            continue;
        }
        if (!readAll(in, frame.data(), len)) break;
        // The camera creates the shared block when an app opens it.
        if (!shm && GetTickCount64() - lastTry > 500) {
            lastTry = GetTickCount64();
            map = OpenFileMappingW(FILE_MAP_WRITE | FILE_MAP_READ, FALSE, DWCAM_MAP_NAME);
            if (map) {
                shm = (DwCamShared*)MapViewOfFile(map, FILE_MAP_WRITE | FILE_MAP_READ, 0, 0, sizeof(DwCamShared));
                if (!shm) { CloseHandle(map); map = nullptr; }
            }
        }
        if (shm) {
            memcpy(shm->nv12, frame.data(), DWCAM_NV12_SIZE);
            shm->lastWrite = (int64_t)GetTickCount64();
            InterlockedIncrement((volatile LONG*)&shm->seq);
        }
    }
    if (shm) { shm->lastWrite = 0; UnmapViewOfFile(shm); }
    if (map) CloseHandle(map);
    cam->Remove();
    cam->Shutdown();
    cam->Release();
    MFShutdown();
    CoUninitialize();
    return 0;
}

int wmain(int argc, wchar_t** argv) {
    std::wstring cmd = argc > 1 ? argv[1] : L"";
    if (cmd == L"status") { printf("%s\n", !supported() ? "unsupported" : installed() ? "installed" : "not-installed"); return 0; }
    if (cmd == L"install" && argc > 2) return install(argv[2]);
    if (cmd == L"uninstall") return uninstall();
    if (cmd == L"run") return run();
    printf("usage: dwcam status | install <dll> | uninstall | run\n");
    return 1;
}
