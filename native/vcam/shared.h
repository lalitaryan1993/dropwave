// DropWave Camera: what the app (dwcam.exe) and the camera (DropWaveCam.dll, inside Windows'
// Frame Server) share. One fixed-size NV12 frame in a named shared memory block; the camera
// creates it (it runs as a service and may create Global\ objects), the app opens it and writes.
#pragma once
#include <stdint.h>

#define DWCAM_NAME L"DropWave Camera"
// {6B2C9E4A-3F1D-4C7B-9E2A-D70A5C1B8F31}
#define DWCAM_CLSID_STR L"{6B2C9E4A-3F1D-4C7B-9E2A-D70A5C1B8F31}"
static const GUID CLSID_DropWaveCam = { 0x6b2c9e4a, 0x3f1d, 0x4c7b, { 0x9e, 0x2a, 0xd7, 0x0a, 0x5c, 0x1b, 0x8f, 0x31 } };

#define DWCAM_MAP_NAME L"Global\\DropWaveCameraFrames"
#define DWCAM_W 1280
#define DWCAM_H 720
#define DWCAM_FPS 30
#define DWCAM_NV12_SIZE (DWCAM_W * DWCAM_H * 3 / 2)
#define DWCAM_MAGIC 0x4D434457u // "DWCM"

#pragma pack(push, 8)
struct DwCamShared {
    uint32_t magic;
    uint32_t width, height;
    volatile uint32_t seq;      // bumped by the app after each new frame
    volatile int64_t lastWrite; // GetTickCount64() of the last frame (old = show the "waiting" picture)
    uint8_t nv12[DWCAM_NV12_SIZE];
};
#pragma pack(pop)
