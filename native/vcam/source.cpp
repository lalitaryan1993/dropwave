// DropWaveCam.dll: a Media Foundation camera source for Windows 11 virtual cameras.
// Windows' Frame Server loads it when an app (Zoom, Meet, Teams, Camera...) opens
// "DropWave Camera". Pictures come from shared memory written by dwcam.exe (the DropWave app);
// with no picture for a few seconds it shows a plain "waiting" frame instead.
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mferror.h>
#include <ks.h>
#include <ksproxy.h>
#include <ksmedia.h>
#include <sddl.h>
#include <wrl.h>
#include <string.h>
#include "shared.h"

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "advapi32.lib")

using namespace Microsoft::WRL;

static HMODULE g_module = nullptr;

// ---------- shared memory (created here: the Frame Server may create Global\ objects) ----------

struct Shm {
    HANDLE map = nullptr;
    DwCamShared* p = nullptr;
    void open() {
        if (p) return;
        SECURITY_ATTRIBUTES sa = { sizeof(sa), nullptr, FALSE };
        PSECURITY_DESCRIPTOR sd = nullptr;
        // Everyone may read/write; low integrity allowed too.
        if (ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:(A;;GA;;;WD)(A;;GA;;;SY)S:(ML;;NW;;;LW)", SDDL_REVISION_1, &sd, nullptr)) sa.lpSecurityDescriptor = sd;
        map = CreateFileMappingW(INVALID_HANDLE_VALUE, &sa, PAGE_READWRITE, 0, sizeof(DwCamShared), DWCAM_MAP_NAME);
        bool fresh = map && GetLastError() != ERROR_ALREADY_EXISTS;
        if (sd) LocalFree(sd);
        if (!map) return;
        p = (DwCamShared*)MapViewOfFile(map, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(DwCamShared));
        if (p && fresh) { p->magic = DWCAM_MAGIC; p->width = DWCAM_W; p->height = DWCAM_H; p->seq = 0; p->lastWrite = 0; }
    }
    void close() {
        if (p) UnmapViewOfFile(p);
        if (map) CloseHandle(map);
        p = nullptr; map = nullptr;
    }
};

static void placeholder(BYTE* d) {
    // Dark blue-violet with a softer box in the middle (no app sending pictures yet).
    memset(d, 28, DWCAM_W * DWCAM_H);
    for (int y = DWCAM_H / 3; y < DWCAM_H * 2 / 3; y++) memset(d + y * DWCAM_W + DWCAM_W / 3, 52, DWCAM_W / 3);
    BYTE* uv = d + DWCAM_W * DWCAM_H;
    for (int i = 0; i < DWCAM_W * DWCAM_H / 2; i += 2) { uv[i] = 150; uv[i + 1] = 136; }
}

static HRESULT makeType(IMFMediaType** out) {
    ComPtr<IMFMediaType> t;
    HRESULT hr = MFCreateMediaType(&t);
    if (FAILED(hr)) return hr;
    t->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    t->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
    MFSetAttributeSize(t.Get(), MF_MT_FRAME_SIZE, DWCAM_W, DWCAM_H);
    MFSetAttributeRatio(t.Get(), MF_MT_FRAME_RATE, DWCAM_FPS, 1);
    MFSetAttributeRatio(t.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    t->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    t->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
    t->SetUINT32(MF_MT_FIXED_SIZE_SAMPLES, TRUE);
    t->SetUINT32(MF_MT_SAMPLE_SIZE, DWCAM_NV12_SIZE);
    t->SetUINT32(MF_MT_DEFAULT_STRIDE, DWCAM_W);
    t->SetUINT32(MF_MT_AVG_BITRATE, DWCAM_NV12_SIZE * 8 * DWCAM_FPS);
    *out = t.Detach();
    return S_OK;
}

static HRESULT notFound() { return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND); }

class Source;

// ---------- the one video stream ----------

class Stream : public RuntimeClass<RuntimeClassFlags<ClassicCom>, ChainInterfaces<IMFMediaStream2, IMFMediaStream, IMFMediaEventGenerator>, IKsControl> {
public:
    HRESULT Init(IMFMediaSource* src, IMFStreamDescriptor* sd) {
        source = src; // the source owns us; a raw pointer avoids a reference cycle
        desc = sd;
        HRESULT hr = MFCreateEventQueue(&queue);
        if (FAILED(hr)) return hr;
        return MFCreateAttributes(&attrs, 8);
    }
    IMFAttributes* Attributes() { return attrs.Get(); }

    void Start() {
        AcquireSRWLockExclusive(&lock);
        state = MF_STREAM_STATE_RUNNING;
        shm.open();
        nextDue = 0;
        ReleaseSRWLockExclusive(&lock);
        PROPVARIANT t; PropVariantInit(&t); t.vt = VT_I8; t.hVal.QuadPart = MFGetSystemTime();
        queue->QueueEventParamVar(MEStreamStarted, GUID_NULL, S_OK, &t);
    }
    void Stop() {
        AcquireSRWLockExclusive(&lock);
        state = MF_STREAM_STATE_STOPPED;
        ReleaseSRWLockExclusive(&lock);
        queue->QueueEventParamVar(MEStreamStopped, GUID_NULL, S_OK, nullptr);
    }
    void Shutdown() {
        AcquireSRWLockExclusive(&lock);
        state = MF_STREAM_STATE_STOPPED;
        shm.close();
        ReleaseSRWLockExclusive(&lock);
        if (queue) queue->Shutdown();
        source = nullptr;
    }

    // IMFMediaEventGenerator
    STDMETHODIMP GetEvent(DWORD f, IMFMediaEvent** e) override { return queue->GetEvent(f, e); }
    STDMETHODIMP BeginGetEvent(IMFAsyncCallback* cb, IUnknown* s) override { return queue->BeginGetEvent(cb, s); }
    STDMETHODIMP EndGetEvent(IMFAsyncResult* r, IMFMediaEvent** e) override { return queue->EndGetEvent(r, e); }
    STDMETHODIMP QueueEvent(MediaEventType t, REFGUID g, HRESULT s, const PROPVARIANT* v) override { return queue->QueueEventParamVar(t, g, s, v); }

    // IMFMediaStream
    STDMETHODIMP GetMediaSource(IMFMediaSource** s) override {
        if (!s) return E_POINTER;
        if (!source) return MF_E_SHUTDOWN;
        *s = source; source->AddRef();
        return S_OK;
    }
    STDMETHODIMP GetStreamDescriptor(IMFStreamDescriptor** d) override {
        if (!d) return E_POINTER;
        return desc.CopyTo(d);
    }
    STDMETHODIMP RequestSample(IUnknown* token) override {
        if (!source) return MF_E_SHUTDOWN;
        // Keep to ~30 frames a second.
        LONGLONG now = MFGetSystemTime();
        const LONGLONG step = 10000000LL / DWCAM_FPS;
        if (nextDue && now < nextDue) { DWORD ms = (DWORD)((nextDue - now) / 10000); if (ms > 0 && ms < 100) Sleep(ms); }
        nextDue = (nextDue && MFGetSystemTime() - nextDue < step) ? nextDue + step : MFGetSystemTime() + step;

        ComPtr<IMFSample> sample;
        ComPtr<IMFMediaBuffer> buf;
        HRESULT hr = MFCreateSample(&sample);
        if (SUCCEEDED(hr)) hr = MFCreateMemoryBuffer(DWCAM_NV12_SIZE, &buf);
        if (FAILED(hr)) return hr;
        BYTE* d = nullptr;
        if (SUCCEEDED(buf->Lock(&d, nullptr, nullptr))) {
            AcquireSRWLockShared(&lock);
            if (!shm.p) { ReleaseSRWLockShared(&lock); AcquireSRWLockExclusive(&lock); shm.open(); ReleaseSRWLockExclusive(&lock); AcquireSRWLockShared(&lock); }
            bool live = shm.p && shm.p->magic == DWCAM_MAGIC && shm.p->lastWrite && (int64_t)GetTickCount64() - shm.p->lastWrite < 3000;
            if (live) memcpy(d, shm.p->nv12, DWCAM_NV12_SIZE); else placeholder(d);
            ReleaseSRWLockShared(&lock);
            buf->Unlock();
        }
        buf->SetCurrentLength(DWCAM_NV12_SIZE);
        sample->AddBuffer(buf.Get());
        sample->SetSampleTime(MFGetSystemTime());
        sample->SetSampleDuration(step);
        if (token) sample->SetUnknown(MFSampleExtension_Token, token);
        return queue->QueueEventParamUnk(MEMediaSample, GUID_NULL, S_OK, sample.Get());
    }

    // IMFMediaStream2
    STDMETHODIMP SetStreamState(MF_STREAM_STATE v) override {
        if (v == MF_STREAM_STATE_RUNNING) Start(); else if (v == MF_STREAM_STATE_STOPPED) Stop(); else state = v;
        return S_OK;
    }
    STDMETHODIMP GetStreamState(MF_STREAM_STATE* v) override { if (!v) return E_POINTER; *v = state; return S_OK; }

    // IKsControl
    STDMETHODIMP KsProperty(PKSPROPERTY, ULONG, LPVOID, ULONG, ULONG*) override { return notFound(); }
    STDMETHODIMP KsMethod(PKSMETHOD, ULONG, LPVOID, ULONG, ULONG*) override { return notFound(); }
    STDMETHODIMP KsEvent(PKSEVENT, ULONG, LPVOID, ULONG, ULONG*) override { return notFound(); }

private:
    IMFMediaSource* source = nullptr;
    ComPtr<IMFStreamDescriptor> desc;
    ComPtr<IMFMediaEventQueue> queue;
    ComPtr<IMFAttributes> attrs;
    MF_STREAM_STATE state = MF_STREAM_STATE_STOPPED;
    SRWLOCK lock = SRWLOCK_INIT;
    Shm shm;
    LONGLONG nextDue = 0;
};

// ---------- the camera source ----------

class Source : public RuntimeClass<RuntimeClassFlags<ClassicCom>, ChainInterfaces<IMFMediaSourceEx, IMFMediaSource, IMFMediaEventGenerator>, IMFGetService, IKsControl> {
public:
    HRESULT Init() {
        HRESULT hr = MFCreateAttributes(&attrs, 4);
        if (SUCCEEDED(hr)) hr = MFCreateEventQueue(&queue);
        ComPtr<IMFMediaType> type;
        if (SUCCEEDED(hr)) hr = makeType(&type);
        ComPtr<IMFStreamDescriptor> sd;
        IMFMediaType* types[] = { type.Get() };
        if (SUCCEEDED(hr)) hr = MFCreateStreamDescriptor(0, 1, types, &sd);
        ComPtr<IMFMediaTypeHandler> h;
        if (SUCCEEDED(hr)) hr = sd->GetMediaTypeHandler(&h);
        if (SUCCEEDED(hr)) hr = h->SetCurrentMediaType(type.Get());
        if (FAILED(hr)) return hr;
        sd->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE);
        sd->SetUINT32(MF_DEVICESTREAM_STREAM_ID, 0);
        sd->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1);
        sd->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES, MFFrameSourceTypes_Color);
        IMFStreamDescriptor* sds[] = { sd.Get() };
        hr = MFCreatePresentationDescriptor(1, sds, &pd);
        if (FAILED(hr)) return hr;
        pd->SelectStream(0);
        stream = Make<Stream>();
        if (!stream) return E_OUTOFMEMORY;
        hr = stream->Init(this, sd.Get());
        if (FAILED(hr)) return hr;
        // Stream attributes the Frame Server reads.
        IMFAttributes* sa = stream->Attributes();
        sa->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE);
        sa->SetUINT32(MF_DEVICESTREAM_STREAM_ID, 0);
        sa->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1);
        sa->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES, MFFrameSourceTypes_Color);
        return S_OK;
    }

    // IMFMediaEventGenerator
    STDMETHODIMP GetEvent(DWORD f, IMFMediaEvent** e) override { return queue->GetEvent(f, e); }
    STDMETHODIMP BeginGetEvent(IMFAsyncCallback* cb, IUnknown* s) override { return queue->BeginGetEvent(cb, s); }
    STDMETHODIMP EndGetEvent(IMFAsyncResult* r, IMFMediaEvent** e) override { return queue->EndGetEvent(r, e); }
    STDMETHODIMP QueueEvent(MediaEventType t, REFGUID g, HRESULT s, const PROPVARIANT* v) override { return queue->QueueEventParamVar(t, g, s, v); }

    // IMFMediaSource
    STDMETHODIMP GetCharacteristics(DWORD* c) override { if (!c) return E_POINTER; *c = MFMEDIASOURCE_IS_LIVE; return S_OK; }
    STDMETHODIMP CreatePresentationDescriptor(IMFPresentationDescriptor** p) override {
        if (!p) return E_POINTER;
        if (!pd) return MF_E_SHUTDOWN;
        return pd->Clone(p);
    }
    STDMETHODIMP Start(IMFPresentationDescriptor* p, const GUID*, const PROPVARIANT*) override {
        if (!p) return E_INVALIDARG;
        if (!stream) return MF_E_SHUTDOWN;
        BOOL selected = FALSE;
        ComPtr<IMFStreamDescriptor> sd;
        if (SUCCEEDED(p->GetStreamDescriptorByIndex(0, &selected, &sd)) && selected) {
            stream->Start();
            ComPtr<IUnknown> u;
            stream.As(&u);
            queue->QueueEventParamUnk(started ? MEUpdatedStream : MENewStream, GUID_NULL, S_OK, u.Get());
        }
        started = true;
        PROPVARIANT t; PropVariantInit(&t); t.vt = VT_I8; t.hVal.QuadPart = MFGetSystemTime();
        return queue->QueueEventParamVar(MESourceStarted, GUID_NULL, S_OK, &t);
    }
    STDMETHODIMP Stop() override {
        if (stream) stream->Stop();
        return queue->QueueEventParamVar(MESourceStopped, GUID_NULL, S_OK, nullptr);
    }
    STDMETHODIMP Pause() override { return MF_E_INVALID_STATE_TRANSITION; }
    STDMETHODIMP Shutdown() override {
        if (stream) { stream->Shutdown(); stream = nullptr; }
        if (queue) queue->Shutdown();
        pd = nullptr;
        return S_OK;
    }

    // IMFMediaSourceEx
    STDMETHODIMP GetSourceAttributes(IMFAttributes** a) override { if (!a) return E_POINTER; return attrs.CopyTo(a); }
    STDMETHODIMP GetStreamAttributes(DWORD id, IMFAttributes** a) override {
        if (!a) return E_POINTER;
        if (id != 0 || !stream) return MF_E_INVALIDSTREAMNUMBER;
        *a = stream->Attributes(); (*a)->AddRef();
        return S_OK;
    }
    STDMETHODIMP SetD3DManager(IUnknown*) override { return S_OK; }

    // IMFGetService
    STDMETHODIMP GetService(REFGUID, REFIID, LPVOID*) override { return MF_E_UNSUPPORTED_SERVICE; }

    // IKsControl
    STDMETHODIMP KsProperty(PKSPROPERTY, ULONG, LPVOID, ULONG, ULONG*) override { return notFound(); }
    STDMETHODIMP KsMethod(PKSMETHOD, ULONG, LPVOID, ULONG, ULONG*) override { return notFound(); }
    STDMETHODIMP KsEvent(PKSEVENT, ULONG, LPVOID, ULONG, ULONG*) override { return notFound(); }

private:
    ComPtr<IMFAttributes> attrs;
    ComPtr<IMFMediaEventQueue> queue;
    ComPtr<IMFPresentationDescriptor> pd;
    ComPtr<Stream> stream;
    bool started = false;
};

// ---------- the activator Windows creates first (an IMFAttributes store plus ActivateObject) ----------

class Activator : public RuntimeClass<RuntimeClassFlags<ClassicCom>, ChainInterfaces<IMFActivate, IMFAttributes>> {
public:
    HRESULT Init() { return MFCreateAttributes(&a, 4); }

    STDMETHODIMP ActivateObject(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        *ppv = nullptr;
        if (!source) {
            auto s = Make<Source>();
            if (!s) return E_OUTOFMEMORY;
            HRESULT hr = s->Init();
            if (FAILED(hr)) return hr;
            source = s;
        }
        return source.CopyTo(riid, ppv);
    }
    STDMETHODIMP ShutdownObject() override { if (source) { source->Shutdown(); source = nullptr; } return S_OK; }
    STDMETHODIMP DetachObject() override { source = nullptr; return S_OK; }

    // IMFAttributes: all passed to the inner store.
    STDMETHODIMP GetItem(REFGUID k, PROPVARIANT* v) override { return a->GetItem(k, v); }
    STDMETHODIMP GetItemType(REFGUID k, MF_ATTRIBUTE_TYPE* t) override { return a->GetItemType(k, t); }
    STDMETHODIMP CompareItem(REFGUID k, REFPROPVARIANT v, BOOL* r) override { return a->CompareItem(k, v, r); }
    STDMETHODIMP Compare(IMFAttributes* t, MF_ATTRIBUTES_MATCH_TYPE m, BOOL* r) override { return a->Compare(t, m, r); }
    STDMETHODIMP GetUINT32(REFGUID k, UINT32* v) override { return a->GetUINT32(k, v); }
    STDMETHODIMP GetUINT64(REFGUID k, UINT64* v) override { return a->GetUINT64(k, v); }
    STDMETHODIMP GetDouble(REFGUID k, double* v) override { return a->GetDouble(k, v); }
    STDMETHODIMP GetGUID(REFGUID k, GUID* v) override { return a->GetGUID(k, v); }
    STDMETHODIMP GetStringLength(REFGUID k, UINT32* v) override { return a->GetStringLength(k, v); }
    STDMETHODIMP GetString(REFGUID k, LPWSTR v, UINT32 n, UINT32* l) override { return a->GetString(k, v, n, l); }
    STDMETHODIMP GetAllocatedString(REFGUID k, LPWSTR* v, UINT32* l) override { return a->GetAllocatedString(k, v, l); }
    STDMETHODIMP GetBlobSize(REFGUID k, UINT32* v) override { return a->GetBlobSize(k, v); }
    STDMETHODIMP GetBlob(REFGUID k, UINT8* v, UINT32 n, UINT32* l) override { return a->GetBlob(k, v, n, l); }
    STDMETHODIMP GetAllocatedBlob(REFGUID k, UINT8** v, UINT32* l) override { return a->GetAllocatedBlob(k, v, l); }
    STDMETHODIMP GetUnknown(REFGUID k, REFIID r, LPVOID* v) override { return a->GetUnknown(k, r, v); }
    STDMETHODIMP SetItem(REFGUID k, REFPROPVARIANT v) override { return a->SetItem(k, v); }
    STDMETHODIMP DeleteItem(REFGUID k) override { return a->DeleteItem(k); }
    STDMETHODIMP DeleteAllItems() override { return a->DeleteAllItems(); }
    STDMETHODIMP SetUINT32(REFGUID k, UINT32 v) override { return a->SetUINT32(k, v); }
    STDMETHODIMP SetUINT64(REFGUID k, UINT64 v) override { return a->SetUINT64(k, v); }
    STDMETHODIMP SetDouble(REFGUID k, double v) override { return a->SetDouble(k, v); }
    STDMETHODIMP SetGUID(REFGUID k, REFGUID v) override { return a->SetGUID(k, v); }
    STDMETHODIMP SetString(REFGUID k, LPCWSTR v) override { return a->SetString(k, v); }
    STDMETHODIMP SetBlob(REFGUID k, const UINT8* v, UINT32 n) override { return a->SetBlob(k, v, n); }
    STDMETHODIMP SetUnknown(REFGUID k, IUnknown* v) override { return a->SetUnknown(k, v); }
    STDMETHODIMP LockStore() override { return a->LockStore(); }
    STDMETHODIMP UnlockStore() override { return a->UnlockStore(); }
    STDMETHODIMP GetCount(UINT32* n) override { return a->GetCount(n); }
    STDMETHODIMP GetItemByIndex(UINT32 i, GUID* k, PROPVARIANT* v) override { return a->GetItemByIndex(i, k, v); }
    STDMETHODIMP CopyAllItems(IMFAttributes* d) override { return a->CopyAllItems(d); }

private:
    ComPtr<IMFAttributes> a;
    ComPtr<Source> source;
};

// ---------- COM plumbing ----------

static volatile LONG g_locks = 0;

class Factory : public RuntimeClass<RuntimeClassFlags<ClassicCom>, IClassFactory> {
public:
    STDMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        *ppv = nullptr;
        if (outer) return CLASS_E_NOAGGREGATION;
        auto act = Make<Activator>();
        if (!act) return E_OUTOFMEMORY;
        HRESULT hr = act->Init();
        if (FAILED(hr)) return hr;
        return act.CopyTo(riid, ppv);
    }
    STDMETHODIMP LockServer(BOOL lock) override { if (lock) InterlockedIncrement(&g_locks); else InterlockedDecrement(&g_locks); return S_OK; }
};

BOOL APIENTRY DllMain(HMODULE m, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) { g_module = m; DisableThreadLibraryCalls(m); }
    return TRUE;
}

STDAPI DllGetClassObject(REFCLSID clsid, REFIID riid, LPVOID* ppv) {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (clsid != CLSID_DropWaveCam) return CLASS_E_CLASSNOTAVAILABLE;
    auto f = Make<Factory>();
    if (!f) return E_OUTOFMEMORY;
    return f.CopyTo(riid, ppv);
}

STDAPI DllCanUnloadNow() { return g_locks == 0 ? S_OK : S_FALSE; }

// Registered for the whole machine (the Frame Server runs as a service and reads HKLM only).
STDAPI DllRegisterServer() {
    wchar_t path[MAX_PATH];
    if (!GetModuleFileNameW(g_module, path, MAX_PATH)) return HRESULT_FROM_WIN32(GetLastError());
    const wchar_t* key = L"Software\\Classes\\CLSID\\" DWCAM_CLSID_STR L"\\InprocServer32";
    LSTATUS r = RegSetKeyValueW(HKEY_LOCAL_MACHINE, key, nullptr, REG_SZ, path, (DWORD)((wcslen(path) + 1) * sizeof(wchar_t)));
    if (r == ERROR_SUCCESS) r = RegSetKeyValueW(HKEY_LOCAL_MACHINE, key, L"ThreadingModel", REG_SZ, L"Both", 10);
    if (r == ERROR_SUCCESS) r = RegSetKeyValueW(HKEY_LOCAL_MACHINE, L"Software\\Classes\\CLSID\\" DWCAM_CLSID_STR, nullptr, REG_SZ, DWCAM_NAME, (DWORD)(sizeof(DWCAM_NAME)));
    return HRESULT_FROM_WIN32(r);
}

STDAPI DllUnregisterServer() {
    LSTATUS r = RegDeleteTreeW(HKEY_LOCAL_MACHINE, L"Software\\Classes\\CLSID\\" DWCAM_CLSID_STR);
    return r == ERROR_FILE_NOT_FOUND ? S_OK : HRESULT_FROM_WIN32(r);
}
