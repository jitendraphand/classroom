/*
 * Win32 helper for the Electron teacher app.
 *
 *   affinity-helper probe
 *   affinity-helper clickthrough <hwnd-decimal> <0|1>
 *   affinity-helper settle
 *   affinity-helper capture-monitor <left> <top> <right> <bottom> <maxW> <maxH> <fps>
 *   affinity-helper capture-window <hwnd-decimal> <maxW> <maxH> <fps>
 *
 * capture-window resolves the monitor that contains the HWND
 * (MonitorFromWindow) and then calls CreateForMonitor. CreateForWindow is not
 * used: a window item does not include the separate annotation HWND.
 *
 * This process must not call SetWindowDisplayAffinity. That API only succeeds
 * for an HWND owned by the calling process, and these windows belong to
 * Electron. The control panel is excluded with BrowserWindow.setContentProtection
 * in the Electron process. probe writes one JSON object on stdout.
 * settle calls DwmFlush and waits so the next capture sees that composition.
 * capture-* runs a Windows.Graphics.Capture session. stderr is JSON lines.
 * stdout is binary frames: magic WGC1, width, height, stride, byte count,
 * then tightly packed RGBA. The parent stops the process by closing the pipe.
 *
 * Chromium's desktopCapturer uses DXGI Desktop Duplication unless
 * AllowWgcScreenCapturer is actually selected, and DXGI paints
 * WDA_EXCLUDEFROMCAPTURE windows black. This process is the capturer the
 * app publishes, so exclusion does not depend on that fallback.
 *
 * Build (Linux):
 *   x86_64-w64-mingw32-windres -O coff -o helper-res.o helper.rc
 *   x86_64-w64-mingw32-gcc -O2 -s -static-libgcc -o affinity-helper.exe affinity-helper.c helper-res.o -ld3d11 -ldxgi -lole32 -luser32 -lgdi32
 */

#define COBJMACROS
#define WINVER 0x0A00
#define _WIN32_WINNT 0x0A00

#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <io.h>
#include <fcntl.h>

#ifndef GA_ROOT
#define GA_ROOT 2
#endif

#define WIN10_2004_BUILD 19041
#define WGC_MAGIC 0x31434757u /* 'W','G','C','1' little-endian */
#define PIX_BGRA8 87          /* DirectXPixelFormat.B8G8R8A8UIntNormalized */

typedef LONG(WINAPI *RtlGetVersionFn)(OSVERSIONINFOW *);
typedef HRESULT(WINAPI *RoInitializeFn)(int);
typedef HRESULT(WINAPI *RoGetActivationFactoryFn)(void *className, const GUID *iid, void **factory);
typedef HRESULT(WINAPI *WindowsCreateStringFn)(const WCHAR *src, UINT32 length, void **out);
typedef HRESULT(WINAPI *WindowsDeleteStringFn)(void *hs);
typedef HRESULT(WINAPI *GetDpiForMonitorFn)(HMONITOR, int, UINT *, UINT *);
typedef HRESULT(WINAPI *CreateDeviceFromDxgiFn)(IDXGIDevice *dxgi, void **graphicsDevice);

/* IInspectable methods start at slot 6. IUnknown is 0..2. */
static const GUID IID_IInspectable = {
    0xAF86E2E0, 0xB12D, 0x4c6a, {0x9C, 0x5A, 0xD7, 0xAA, 0x65, 0x10, 0x1E, 0x90}};
/* IGraphicsCaptureItem — windows.graphics.capture.h */
static const GUID IID_IGraphicsCaptureItem = {
    0x79c3f95b, 0x31f7, 0x4ec2, {0xa4, 0x64, 0x63, 0x2e, 0xf5, 0xd3, 0x07, 0x60}};
/* IGraphicsCaptureItemInterop — windows.graphics.capture.interop.h (IUnknown). */
static const GUID IID_IGraphicsCaptureItemInterop = {
    0x3628E81B, 0x3CAC, 0x4C60, {0xB7, 0xF4, 0x23, 0xCE, 0x0E, 0x0C, 0x33, 0x56}};
static const GUID IID_IFramePoolStatics2 = {
    0x589b103f, 0x6bbc, 0x5df5, {0xa9, 0x91, 0x02, 0xe2, 0x8b, 0x3b, 0x66, 0xd5}};
static const GUID IID_IGraphicsCaptureSession2 = {
    0x2c39ae40, 0x7d2e, 0x5044, {0x80, 0x4e, 0x8b, 0x67, 0x99, 0xd4, 0xcf, 0x9e}};
static const GUID IID_IGraphicsCaptureSession3 = {
    0xf2cdd966, 0x22ae, 0x5ea1, {0x95, 0x96, 0x3a, 0x28, 0x93, 0x44, 0xc3, 0xbe}};
static const GUID IID_IGraphicsCaptureSessionStatics = {
    0x2224a540, 0x5974, 0x49aa, {0xb2, 0x32, 0x08, 0x82, 0x53, 0x6f, 0x4c, 0xb5}};
/* Windows.Graphics.DirectX.Direct3D11.IDirect3DDevice */
static const GUID IID_IDirect3DDevice = {
    0xA37624AB, 0x8D5F, 0x4650, {0x9D, 0x3E, 0x9E, 0xAE, 0x3D, 0x9B, 0xC6, 0x70}};
/* IDirect3DDxgiInterfaceAccess::GetInterface is slot 3. */
static const GUID IID_IDirect3DDxgiInterfaceAccess = {
    0xA9B3D012, 0x3DF2, 0x4EE3, {0xB8, 0xD1, 0x86, 0x95, 0xF4, 0x57, 0xD3, 0xC1}};
static const GUID IID_ID3D11Texture2D_local = {
    0x6f15aaf2, 0xd208, 0x4e89, {0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c}};
static const GUID IID_IDXGIDevice_local = {
    0x54ec77fa, 0x1377, 0x44e6, {0x8c, 0x32, 0x88, 0xfd, 0x5f, 0x44, 0xc8, 0x4c}};
static const GUID IID_ID3D11VideoDevice_local = {
    0x10ec4d5b, 0x975a, 0x4689, {0xb9, 0xe4, 0xd0, 0xaa, 0xc3, 0x0f, 0xe3, 0x33}};
static const GUID IID_ID3D11VideoContext_local = {
    0x61f21c45, 0x3c0e, 0x4a74, {0x9c, 0xea, 0x67, 0x10, 0x0d, 0x9a, 0xd5, 0xe4}};

typedef struct WgcSize {
  INT32 Width;
  INT32 Height;
} WgcSize;

typedef struct WinrtApi {
  RoInitializeFn RoInitialize;
  RoGetActivationFactoryFn RoGetActivationFactory;
  WindowsCreateStringFn WindowsCreateString;
  WindowsDeleteStringFn WindowsDeleteString;
  int ready;
} WinrtApi;

static WinrtApi wrt;

static void set_per_monitor_dpi(void) {
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  typedef BOOL(WINAPI *SetDpiFn)(HANDLE);
  SetDpiFn fn = user32 ? (SetDpiFn)GetProcAddress(user32, "SetProcessDpiAwarenessContext") : NULL;
  /* DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = (HANDLE)-4. Physical monitor
   * rects then match Electron's screen.dipToScreenRect. */
  if (fn) fn((HANDLE)(intptr_t)-4);
}

static DWORD WINAPI dwm_flush_thread(LPVOID p) {
  typedef HRESULT(WINAPI *DwmFlushFn)(void);
  ((DwmFlushFn)p)();
  return 0;
}

/* Wait until DWM has composed the frame that includes content protection. */
static void compose_flush(void) {
  typedef HRESULT(WINAPI *DwmFlushFn)(void);
  HMODULE dwm = LoadLibraryW(L"dwmapi.dll");
  DwmFlushFn fn = dwm ? (DwmFlushFn)GetProcAddress(dwm, "DwmFlush") : NULL;
  /* DwmFlush can block for a long time (seen at 150 % scaling on a basic display
   * adapter, where the helper then never reported "ready"). Bound it. */
  if (fn) {
    HANDLE th = CreateThread(NULL, 0, dwm_flush_thread, (LPVOID)fn, 0, NULL);
    if (th) {
      WaitForSingleObject(th, 400);
      CloseHandle(th);
    }
  }
  Sleep(100);
}

static unsigned long os_build(void) {
  OSVERSIONINFOW vi;
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  RtlGetVersionFn fn = ntdll ? (RtlGetVersionFn)GetProcAddress(ntdll, "RtlGetVersion") : NULL;
  ZeroMemory(&vi, sizeof(vi));
  vi.dwOSVersionInfoSize = sizeof(vi);
  if (fn && fn(&vi) == 0) return vi.dwBuildNumber;
  return 0;
}

static void *vtbl_fn(void *obj, int slot) {
  void **vt = *(void ***)obj;
  return vt[slot];
}

static ULONG release_obj(void *obj) {
  typedef ULONG(STDMETHODCALLTYPE *Fn)(void *);
  if (!obj) return 0;
  return ((Fn)vtbl_fn(obj, 2))(obj);
}

static HRESULT qi_obj(void *obj, const GUID *iid, void **out) {
  typedef HRESULT(STDMETHODCALLTYPE *Fn)(void *, const GUID *, void **);
  *out = NULL;
  if (!obj) return E_POINTER;
  return ((Fn)vtbl_fn(obj, 0))(obj, iid, out);
}

static int winrt_load(void) {
  HRESULT hr;
  HMODULE combase;
  if (wrt.ready) return 1;
  combase = LoadLibraryW(L"combase.dll");
  if (!combase) return 0;
  wrt.RoInitialize = (RoInitializeFn)GetProcAddress(combase, "RoInitialize");
  wrt.RoGetActivationFactory = (RoGetActivationFactoryFn)GetProcAddress(combase, "RoGetActivationFactory");
  wrt.WindowsCreateString = (WindowsCreateStringFn)GetProcAddress(combase, "WindowsCreateString");
  wrt.WindowsDeleteString = (WindowsDeleteStringFn)GetProcAddress(combase, "WindowsDeleteString");
  if (!wrt.RoInitialize || !wrt.RoGetActivationFactory || !wrt.WindowsCreateString) return 0;
  hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
  if (FAILED(hr) && hr != (HRESULT)0x80010106L) return 0;
  hr = wrt.RoInitialize(1); /* RO_INIT_MULTITHREADED */
  if (FAILED(hr) && hr != (HRESULT)0x80010106L) return 0;
  wrt.ready = 1;
  return 1;
}

static void *activate(const WCHAR *name, const GUID *iid) {
  void *hs = NULL;
  void *factory = NULL;
  UINT32 len = 0;
  HRESULT hr;
  if (!winrt_load()) return NULL;
  while (name[len]) len++;
  if (FAILED(wrt.WindowsCreateString(name, len, &hs))) return NULL;
  hr = wrt.RoGetActivationFactory(hs, iid, &factory);
  if (wrt.WindowsDeleteString && hs) wrt.WindowsDeleteString(hs);
  if (FAILED(hr)) return NULL;
  return factory;
}

/* 1 supported, 0 explicitly unsupported, -1 factory missing. */
static int wgc_session_supported(void) {
  void *fac;
  unsigned char supported = 0;
  HRESULT hr;
  typedef HRESULT(STDMETHODCALLTYPE *IsSupportedFn)(void *, unsigned char *);
  fac = activate(L"Windows.Graphics.Capture.GraphicsCaptureSession", &IID_IGraphicsCaptureSessionStatics);
  if (!fac) return -1;
  hr = ((IsSupportedFn)vtbl_fn(fac, 6))(fac, &supported);
  release_obj(fac);
  if (FAILED(hr)) return -1;
  return supported ? 1 : 0;
}

static int wgc_item_activates(void) {
  void *fac = activate(L"Windows.Graphics.Capture.GraphicsCaptureItem", &IID_IInspectable);
  if (!fac) return 0;
  release_obj(fac);
  return 1;
}

typedef struct MonList {
  char *buf;
  size_t len;
  size_t cap;
  int count;
  GetDpiForMonitorFn dpiFn;
} MonList;

static void mon_append(MonList *m, const char *s) {
  size_t n = strlen(s);
  if (m->len + n + 1 > m->cap) {
    size_t cap = m->cap ? m->cap * 2 : 1024;
    while (cap < m->len + n + 1) cap *= 2;
    char *next = (char *)realloc(m->buf, cap);
    if (!next) return;
    m->buf = next;
    m->cap = cap;
  }
  memcpy(m->buf + m->len, s, n + 1);
  m->len += n;
}

static BOOL CALLBACK enum_mon(HMONITOR hmon, HDC hdc, LPRECT rc, LPARAM lp) {
  MonList *m = (MonList *)lp;
  MONITORINFOEXW info;
  (void)hdc;
  (void)rc;
  ZeroMemory(&info, sizeof(info));
  info.cbSize = sizeof(info);
  if (!GetMonitorInfoW(hmon, (LPMONITORINFO)&info)) return TRUE;
  {
    UINT dx = 96, dy = 96;
    char line[256];
    if (m->dpiFn) m->dpiFn(hmon, 0, &dx, &dy);
    snprintf(line, sizeof(line),
             "%s{\"left\":%ld,\"top\":%ld,\"width\":%ld,\"height\":%ld,\"primary\":%s,\"dpi\":%u}",
             m->count ? "," : "", (long)info.rcMonitor.left, (long)info.rcMonitor.top,
             (long)(info.rcMonitor.right - info.rcMonitor.left),
             (long)(info.rcMonitor.bottom - info.rcMonitor.top),
             (info.dwFlags & MONITORINFOF_PRIMARY) ? "true" : "false", (unsigned)dx);
    mon_append(m, line);
    m->count++;
  }
  return TRUE;
}

static int cmd_probe(void) {
  unsigned long build = os_build();
  int session = wgc_session_supported();
  int item = wgc_item_activates();
  /* IsSupported is the runtime's own answer. If that factory will not
   * activate, fall back to the item class so a probe glitch does not hide a
   * working capturer. An explicit false stays false. */
  int wgc = session == 1 || (session < 0 && item);
  int exclude = build >= WIN10_2004_BUILD && wgc;
  MonList mons;
  HMODULE shcore;
  ZeroMemory(&mons, sizeof(mons));
  shcore = LoadLibraryW(L"shcore.dll");
  if (shcore) mons.dpiFn = (GetDpiForMonitorFn)GetProcAddress(shcore, "GetDpiForMonitor");
  EnumDisplayMonitors(NULL, NULL, enum_mon, (LPARAM)&mons);
  printf("{\"build\":%lu,\"excludeSupported\":%s,\"wgc\":%s,\"wgcSession\":%d,\"wgcItem\":%s,\"monitors\":[%s]}\n",
         build, exclude ? "true" : "false", wgc ? "true" : "false", session, item ? "true" : "false",
         mons.buf ? mons.buf : "");
  free(mons.buf);
  return 0;
}

static HWND root_window(HWND hwnd) {
  HWND root = GetAncestor(hwnd, GA_ROOT);
  return root ? root : hwnd;
}

/* Click-through uses WS_EX_TRANSPARENT so hit tests fall through to the desktop. */
static int cmd_clickthrough(const char *hwndDec, const char *onS) {
  unsigned long long hv = strtoull(hwndDec, NULL, 10);
  HWND hwnd = (HWND)(uintptr_t)hv;
  HWND root;
  LONG_PTR ex;
  int on = atoi(onS) != 0;
  if (!hwnd || !IsWindow(hwnd)) {
    printf("{\"ok\":false,\"error\":\"not a window\"}\n");
    return 2;
  }
  root = root_window(hwnd);
  /* GWLP_EXSTYLE and GWL_EXSTYLE are the same index. MinGW's headers expose GWL_. */
  ex = GetWindowLongPtrW(root, GWL_EXSTYLE);
  if (on) ex |= WS_EX_TRANSPARENT | WS_EX_LAYERED;
  else ex &= ~WS_EX_TRANSPARENT;
  SetWindowLongPtrW(root, GWL_EXSTYLE, ex);
  SetWindowPos(root, NULL, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  printf("{\"ok\":true,\"clickThrough\":%s,\"hwnd\":\"%llu\"}\n", on ? "true" : "false",
         (unsigned long long)(uintptr_t)root);
  return 0;
}

static int cmd_settle(void) {
  compose_flush();
  printf("{\"ok\":true}\n");
  return 0;
}

static void log_err(const char *step, HRESULT hr) {
  fprintf(stderr, "{\"event\":\"error\",\"step\":\"%s\",\"hr\":\"0x%08lX\"}\n", step, (unsigned long)hr);
  fflush(stderr);
}

static void log_note(const char *step) {
  fprintf(stderr, "{\"event\":\"note\",\"step\":\"%s\"}\n", step);
  fflush(stderr);
}

static void log_ready(int width, int height, int cursor, int border, const char *source, const RECT *monitor) {
  LONG left = 0, top = 0, right = 0, bottom = 0;
  if (monitor) {
    left = monitor->left;
    top = monitor->top;
    right = monitor->right;
    bottom = monitor->bottom;
  }
  fprintf(stderr,
          "{\"event\":\"ready\",\"api\":\"Windows.Graphics.Capture\",\"width\":%d,\"height\":%d,\"cursor\":%s,\"borderOff\":%s,\"source\":\"%s\",\"monL\":%ld,\"monT\":%ld,\"monR\":%ld,\"monB\":%ld}\n",
          width, height, cursor ? "true" : "false", border ? "true" : "false", source, (long)left, (long)top, (long)right,
          (long)bottom);
  fflush(stderr);
}

static void fit_even(int srcW, int srcH, int maxW, int maxH, int *outW, int *outH) {
  double s = 1.0;
  int w, h;
  if (srcW < 2) srcW = 2;
  if (srcH < 2) srcH = 2;
  if (maxW < 2) maxW = 2;
  if (maxH < 2) maxH = 2;
  if (srcW > maxW) s = (double)maxW / (double)srcW;
  if ((double)srcH * s > (double)maxH) s = (double)maxH / (double)srcH;
  w = (int)((double)srcW * s);
  h = (int)((double)srcH * s);
  if (w < 2) w = 2;
  if (h < 2) h = 2;
  w &= ~1;
  h &= ~1;
  if (w < 2) w = 2;
  if (h < 2) h = 2;
  *outW = w;
  *outH = h;
}

static int write_all(const void *data, size_t n) {
  const unsigned char *p = (const unsigned char *)data;
  size_t off = 0;
  while (off < n) {
    size_t w = fwrite(p + off, 1, n - off, stdout);
    if (w == 0) return 0;
    off += w;
  }
  return 1;
}

static int write_frame(int width, int height, const uint8_t *rgba) {
  uint32_t hdr[5];
  uint32_t bytes = (uint32_t)width * (uint32_t)height * 4u;
  hdr[0] = WGC_MAGIC;
  hdr[1] = (uint32_t)width;
  hdr[2] = (uint32_t)height;
  hdr[3] = (uint32_t)width * 4u;
  hdr[4] = bytes;
  if (!write_all(hdr, sizeof(hdr))) return 0;
  if (!write_all(rgba, bytes)) return 0;
  if (fflush(stdout) != 0) return 0;
  return 1;
}

/* Header-only frame: the picture has not changed since the last one sent. */
#define STATIC_PRIO_MS 3000

static int write_same(int width, int height) {
  uint32_t hdr[5];
  hdr[0] = WGC_MAGIC;
  hdr[1] = (uint32_t)width;
  hdr[2] = (uint32_t)height;
  hdr[3] = 0;
  hdr[4] = 0;
  if (!write_all(hdr, sizeof(hdr))) return 0;
  if (fflush(stdout) != 0) return 0;
  return 1;
}

/* FNV-1a over 64-bit words (+ size): detects an unchanged picture so static
 * screens send nothing but a 20-byte heartbeat. */
static uint64_t frame_hash(const uint8_t *p, size_t n, int w, int h) {
  uint64_t x = 1469598103934665603ULL ^ ((uint64_t)w << 32) ^ (uint64_t)h;
  size_t i = 0;
  for (; i + 8 <= n; i += 8) {
    uint64_t v;
    memcpy(&v, p + i, 8);
    x ^= v;
    x *= 1099511628211ULL;
  }
  for (; i < n; i++) {
    x ^= p[i];
    x *= 1099511628211ULL;
  }
  return x;
}

/* BGRA (possibly strided, possibly a different size) → tightly packed RGBA. */
static void blit_rgba(const uint8_t *src, int srcW, int srcH, int srcStride, uint8_t *dst, int dstW, int dstH) {
  int y, x;
  if (srcW == dstW && srcH == dstH) {
    for (y = 0; y < srcH; y++) {
      const uint8_t *s = src + (size_t)y * (size_t)srcStride;
      uint8_t *d = dst + (size_t)y * (size_t)dstW * 4u;
      for (x = 0; x < srcW; x++) {
        d[0] = s[2];
        d[1] = s[1];
        d[2] = s[0];
        d[3] = 255;
        s += 4;
        d += 4;
      }
    }
    return;
  }
  for (y = 0; y < dstH; y++) {
    int sy = (int)(((long long)y * srcH) / dstH);
    const uint8_t *row = src + (size_t)sy * (size_t)srcStride;
    uint8_t *d = dst + (size_t)y * (size_t)dstW * 4u;
    if (sy < 0) sy = 0;
    if (sy >= srcH) sy = srcH - 1;
    row = src + (size_t)sy * (size_t)srcStride;
    for (x = 0; x < dstW; x++) {
      int sx = (int)(((long long)x * srcW) / dstW);
      const uint8_t *s;
      if (sx < 0) sx = 0;
      if (sx >= srcW) sx = srcW - 1;
      s = row + (size_t)sx * 4u;
      d[0] = s[2];
      d[1] = s[1];
      d[2] = s[0];
      d[3] = 255;
      d += 4;
    }
  }
}

typedef struct {
  LONG left, top, right, bottom;
  HMONITOR found;
  /* Fallback at high DPI scaling: the monitor overlapping the requested rect most. */
  HMONITOR best;
  LONGLONG bestArea;
} MonMatch;

static BOOL CALLBACK match_mon(HMONITOR hmon, HDC hdc, LPRECT rc, LPARAM lp) {
  MonMatch *m = (MonMatch *)lp;
  MONITORINFO info;
  LONG dl, dt, dr, db;
  (void)hdc;
  (void)rc;
  ZeroMemory(&info, sizeof(info));
  info.cbSize = sizeof(info);
  if (!GetMonitorInfo(hmon, &info)) return TRUE;
  dl = info.rcMonitor.left - m->left;
  dt = info.rcMonitor.top - m->top;
  dr = info.rcMonitor.right - m->right;
  db = info.rcMonitor.bottom - m->bottom;
  if (dl < 0) dl = -dl;
  if (dt < 0) dt = -dt;
  if (dr < 0) dr = -dr;
  if (db < 0) db = -db;
  if (dl <= 8 && dt <= 8 && dr <= 8 && db <= 8) {
    m->found = hmon;
    return FALSE;
  }
  {
    LONG ow = (info.rcMonitor.right < m->right ? info.rcMonitor.right : m->right) - (info.rcMonitor.left > m->left ? info.rcMonitor.left : m->left);
    LONG oh = (info.rcMonitor.bottom < m->bottom ? info.rcMonitor.bottom : m->bottom) - (info.rcMonitor.top > m->top ? info.rcMonitor.top : m->top);
    LONGLONG area = (ow > 0 && oh > 0) ? (LONGLONG)ow * (LONGLONG)oh : 0;
    if (area > m->bestArea) {
      m->bestArea = area;
      m->best = hmon;
    }
  }
  return TRUE;
}

static int create_d3d(ID3D11Device **device, ID3D11DeviceContext **context, void **winrtDevice) {
  D3D_FEATURE_LEVEL levels[3];
  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  HRESULT hr;
  IDXGIDevice *dxgi = NULL;
  void *inspect = NULL;
  HMODULE d3d = NULL;
  CreateDeviceFromDxgiFn fromDxgi;
  levels[0] = D3D_FEATURE_LEVEL_11_0;
  levels[1] = D3D_FEATURE_LEVEL_10_1;
  levels[2] = D3D_FEATURE_LEVEL_10_0;
  *device = NULL;
  *context = NULL;
  *winrtDevice = NULL;
  hr = D3D11CreateDevice(NULL, D3D_DRIVER_TYPE_HARDWARE, NULL, flags, levels, 3, D3D11_SDK_VERSION, device, NULL, context);
  if (FAILED(hr)) {
    hr = D3D11CreateDevice(NULL, D3D_DRIVER_TYPE_WARP, NULL, flags, levels, 3, D3D11_SDK_VERSION, device, NULL, context);
  }
  if (FAILED(hr) || !*device) {
    log_err("d3d11-device", hr);
    return 0;
  }
  hr = ID3D11Device_QueryInterface(*device, &IID_IDXGIDevice_local, (void **)&dxgi);
  if (FAILED(hr) || !dxgi) {
    log_err("dxgi-device", hr);
    return 0;
  }
  d3d = GetModuleHandleW(L"d3d11.dll");
  fromDxgi = d3d ? (CreateDeviceFromDxgiFn)GetProcAddress(d3d, "CreateDirect3D11DeviceFromDXGIDevice") : NULL;
  if (!fromDxgi) {
    IDXGIDevice_Release(dxgi);
    log_err("d3d11-winrt-export", E_FAIL);
    return 0;
  }
  hr = fromDxgi(dxgi, &inspect);
  IDXGIDevice_Release(dxgi);
  if (FAILED(hr) || !inspect) {
    log_err("CreateDirect3D11DeviceFromDXGIDevice", hr);
    return 0;
  }
  hr = qi_obj(inspect, &IID_IDirect3DDevice, winrtDevice);
  release_obj(inspect);
  if (FAILED(hr) || !*winrtDevice) {
    log_err("IDirect3DDevice", hr);
    return 0;
  }
  return 1;
}

static int ensure_staging(ID3D11Device *device, ID3D11Texture2D **staging, int w, int h) {
  D3D11_TEXTURE2D_DESC desc;
  D3D11_TEXTURE2D_DESC cur;
  HRESULT hr;
  if (*staging) {
    ID3D11Texture2D_GetDesc(*staging, &cur);
    if ((int)cur.Width == w && (int)cur.Height == h) return 1;
    ID3D11Texture2D_Release(*staging);
    *staging = NULL;
  }
  ZeroMemory(&desc, sizeof(desc));
  desc.Width = (UINT)w;
  desc.Height = (UINT)h;
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_STAGING;
  desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  hr = ID3D11Device_CreateTexture2D(device, &desc, NULL, staging);
  if (FAILED(hr) || !*staging) {
    log_err("staging-texture", hr);
    return 0;
  }
  return 1;
}

/*
 * Scales a BGRA capture texture on the GPU when its size is not the size we
 * publish. The common path does not use this: the frame pool is already
 * created at the fitted size, so Windows.Graphics.Capture scales there.
 * A failure falls back to blit_rgba. Strokes are not drawn into this texture.
 */
typedef struct GpuScale {
  ID3D11VideoDevice *video;
  ID3D11VideoContext *vctx;
  ID3D11VideoProcessorEnumerator *enu;
  ID3D11VideoProcessor *proc;
  ID3D11Texture2D *output;
  ID3D11VideoProcessorOutputView *outView;
  int inW, inH, outW, outH;
  int dead;
} GpuScale;

static void gpu_scale_release(GpuScale *g) {
  if (g->outView) ID3D11VideoProcessorOutputView_Release(g->outView);
  if (g->output) ID3D11Texture2D_Release(g->output);
  if (g->proc) ID3D11VideoProcessor_Release(g->proc);
  if (g->enu) ID3D11VideoProcessorEnumerator_Release(g->enu);
  g->outView = NULL;
  g->output = NULL;
  g->proc = NULL;
  g->enu = NULL;
  g->inW = g->inH = g->outW = g->outH = 0;
}

static void gpu_scale_free(GpuScale *g) {
  gpu_scale_release(g);
  if (g->vctx) ID3D11VideoContext_Release(g->vctx);
  if (g->video) ID3D11VideoDevice_Release(g->video);
  g->vctx = NULL;
  g->video = NULL;
  g->dead = 0;
}

static int gpu_scale_ensure(GpuScale *g, ID3D11Device *device, ID3D11DeviceContext *context, int inW, int inH, int outW, int outH) {
  D3D11_VIDEO_PROCESSOR_CONTENT_DESC cd;
  D3D11_TEXTURE2D_DESC td;
  D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC ovd;
  D3D11_VIDEO_PROCESSOR_COLOR_SPACE cs;
  RECT src, dst;
  UINT flags = 0;
  HRESULT hr;
  if (g->dead && g->inW == inW && g->inH == inH && g->outW == outW && g->outH == outH) return 0;
  if (g->proc && g->outView && g->inW == inW && g->inH == inH && g->outW == outW && g->outH == outH) return 1;
  gpu_scale_release(g);
  g->dead = 0;
  g->inW = inW;
  g->inH = inH;
  g->outW = outW;
  g->outH = outH;
  if (!g->video) {
    hr = ID3D11Device_QueryInterface(device, &IID_ID3D11VideoDevice_local, (void **)&g->video);
    if (FAILED(hr) || !g->video) {
      g->dead = 1;
      log_note("video-device");
      return 0;
    }
  }
  if (!g->vctx) {
    hr = ID3D11DeviceContext_QueryInterface(context, &IID_ID3D11VideoContext_local, (void **)&g->vctx);
    if (FAILED(hr) || !g->vctx) {
      g->dead = 1;
      log_note("video-context");
      return 0;
    }
  }
  ZeroMemory(&cd, sizeof(cd));
  cd.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
  cd.InputFrameRate.Numerator = 15;
  cd.InputFrameRate.Denominator = 1;
  cd.InputWidth = (UINT)inW;
  cd.InputHeight = (UINT)inH;
  cd.OutputFrameRate.Numerator = 15;
  cd.OutputFrameRate.Denominator = 1;
  cd.OutputWidth = (UINT)outW;
  cd.OutputHeight = (UINT)outH;
  cd.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
  hr = ID3D11VideoDevice_CreateVideoProcessorEnumerator(g->video, &cd, &g->enu);
  if (FAILED(hr) || !g->enu) {
    g->dead = 1;
    log_note("video-enumerator");
    return 0;
  }
  flags = 0;
  hr = ID3D11VideoProcessorEnumerator_CheckVideoProcessorFormat(g->enu, DXGI_FORMAT_B8G8R8A8_UNORM, &flags);
  if (FAILED(hr) || (flags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT) == 0 ||
      (flags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT) == 0) {
    g->dead = 1;
    log_note("video-format");
    return 0;
  }
  hr = ID3D11VideoDevice_CreateVideoProcessor(g->video, g->enu, 0, &g->proc);
  if (FAILED(hr) || !g->proc) {
    g->dead = 1;
    log_note("video-processor");
    return 0;
  }
  ZeroMemory(&td, sizeof(td));
  td.Width = (UINT)outW;
  td.Height = (UINT)outH;
  td.MipLevels = 1;
  td.ArraySize = 1;
  td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  td.SampleDesc.Count = 1;
  td.Usage = D3D11_USAGE_DEFAULT;
  td.BindFlags = D3D11_BIND_RENDER_TARGET;
  hr = ID3D11Device_CreateTexture2D(device, &td, NULL, &g->output);
  if (FAILED(hr) || !g->output) {
    g->dead = 1;
    log_note("video-output");
    return 0;
  }
  ZeroMemory(&ovd, sizeof(ovd));
  ovd.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
  ovd.Texture2D.MipSlice = 0;
  hr = ID3D11VideoDevice_CreateVideoProcessorOutputView(g->video, (ID3D11Resource *)g->output, g->enu, &ovd, &g->outView);
  if (FAILED(hr) || !g->outView) {
    g->dead = 1;
    log_note("video-output-view");
    return 0;
  }
  ZeroMemory(&cs, sizeof(cs));
  cs.Usage = 0;
  cs.RGB_Range = 0;
  cs.Nominal_Range = 2;
  ID3D11VideoContext_VideoProcessorSetStreamColorSpace(g->vctx, g->proc, 0, &cs);
  ID3D11VideoContext_VideoProcessorSetOutputColorSpace(g->vctx, g->proc, &cs);
  ID3D11VideoContext_VideoProcessorSetStreamAutoProcessingMode(g->vctx, g->proc, 0, 0);
  src.left = 0;
  src.top = 0;
  src.right = inW;
  src.bottom = inH;
  dst.left = 0;
  dst.top = 0;
  dst.right = outW;
  dst.bottom = outH;
  ID3D11VideoContext_VideoProcessorSetStreamSourceRect(g->vctx, g->proc, 0, 1, &src);
  ID3D11VideoContext_VideoProcessorSetStreamDestRect(g->vctx, g->proc, 0, 1, &dst);
  ID3D11VideoContext_VideoProcessorSetOutputTargetRect(g->vctx, g->proc, 1, &dst);
  return 1;
}

static ID3D11Texture2D *gpu_scale_blt(GpuScale *g, ID3D11Texture2D *src) {
  D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC ivd;
  ID3D11VideoProcessorInputView *inView = NULL;
  D3D11_VIDEO_PROCESSOR_STREAM stream;
  HRESULT hr;
  if (!g->video || !g->vctx || !g->proc || !g->enu || !g->outView) return NULL;
  ZeroMemory(&ivd, sizeof(ivd));
  ivd.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
  hr = ID3D11VideoDevice_CreateVideoProcessorInputView(g->video, (ID3D11Resource *)src, g->enu, &ivd, &inView);
  if (FAILED(hr) || !inView) return NULL;
  ZeroMemory(&stream, sizeof(stream));
  stream.Enable = 1;
  stream.pInputSurface = inView;
  hr = ID3D11VideoContext_VideoProcessorBlt(g->vctx, g->proc, g->outView, 0, 1, &stream);
  ID3D11VideoProcessorInputView_Release(inView);
  if (FAILED(hr)) return NULL;
  return g->output;
}

/* One staging read of `tex`, then BGRA to tightly packed RGBA. Scales on the CPU only when the sizes differ. */
static int readback_rgba(ID3D11Device *device, ID3D11DeviceContext *context, ID3D11Texture2D **staging, ID3D11Texture2D *tex,
                         int dstW, int dstH, uint8_t **rgba, size_t *rgbaCap) {
  D3D11_TEXTURE2D_DESC td;
  D3D11_MAPPED_SUBRESOURCE mapped;
  HRESULT hr;
  size_t need;
  ID3D11Texture2D_GetDesc(tex, &td);
  if (td.Width < 2 || td.Height < 2 || td.Width > 8192 || td.Height > 8192) return 0;
  if (!ensure_staging(device, staging, (int)td.Width, (int)td.Height)) return 0;
  ID3D11DeviceContext_CopyResource(context, (ID3D11Resource *)*staging, (ID3D11Resource *)tex);
  ZeroMemory(&mapped, sizeof(mapped));
  hr = ID3D11DeviceContext_Map(context, (ID3D11Resource *)*staging, 0, D3D11_MAP_READ, 0, &mapped);
  if (FAILED(hr) || !mapped.pData || mapped.RowPitch < td.Width * 4) return 0;
  need = (size_t)dstW * (size_t)dstH * 4u;
  if (need > *rgbaCap) {
    uint8_t *next = (uint8_t *)realloc(*rgba, need);
    if (!next) {
      ID3D11DeviceContext_Unmap(context, (ID3D11Resource *)*staging, 0);
      log_note("frame-alloc");
      return 0;
    }
    *rgba = next;
    *rgbaCap = need;
  }
  blit_rgba((const uint8_t *)mapped.pData, (int)td.Width, (int)td.Height, (int)mapped.RowPitch, *rgba, dstW, dstH);
  ID3D11DeviceContext_Unmap(context, (ID3D11Resource *)*staging, 0);
  return 1;
}

/* ---- Stale capture watch -------------------------------------------------
 * E2E 2026-10-09: after a Remote Desktop reconnect / detach the WGC session
 * kept running but never produced another frame, and this loop kept re-sending
 * the last texture as a keep-alive: students saw a frozen screen. The watch
 * below reports {"event":"stale","why":...} and the capture exits with code 3;
 * the app restarts a fresh capture (src/main/captureSupervisor.ts).
 *   device-lost      D3D device removed (driver reset, GPU/adapter change)
 *   display-changed  the captured monitor moved, resized or disappeared
 *   session-changed  remote <-> console session, or the session was moved
 *   unlocked         the input desktop came back to Default after lock / UAC
 *   frozen           GDI sees the screen change by > 10% twice in a row while
 *                    WGC delivered no frame at all
 */
#define STALE_EXIT 3
#define PROBE_W 64
#define PROBE_H 36
#define PROBE_IDLE_MS 3000

typedef struct {
  RECT mon;
  int haveMon;
  int remote;
  DWORD session;
  DWORD console;
  int awayFromDefault;
  uint8_t sig[PROBE_W * PROBE_H * 3];
  int haveSig;
  int strikes;
  DWORD lastProbe;
} StaleWatch;

static int input_desktop_is_default(void) {
  HDESK d = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  WCHAR name[64];
  DWORD need = 0;
  int isDefault = 0;
  if (!d) return 0;
  ZeroMemory(name, sizeof(name));
  if (GetUserObjectInformationW(d, UOI_NAME, name, sizeof(name) - sizeof(WCHAR), &need)) isDefault = lstrcmpiW(name, L"Default") == 0;
  CloseDesktop(d);
  return isDefault;
}

static DWORD my_session(void) {
  DWORD sid = 0;
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &sid)) return 0xFFFFFFFFu;
  return sid;
}

/* Small GDI picture of the monitor (HALFTONE averaged). Returns 0 when GDI cannot read the screen (secure desktop). */
static int gdi_probe(const RECT *mon, uint8_t *out) {
  HDC screen = GetDC(NULL);
  HDC mem = NULL;
  HBITMAP bmp = NULL;
  HGDIOBJ old = NULL;
  void *bits = NULL;
  BITMAPINFO bi;
  int ok = 0;
  if (!screen) return 0;
  mem = CreateCompatibleDC(screen);
  ZeroMemory(&bi, sizeof(bi));
  bi.bmiHeader.biSize = sizeof(bi.bmiHeader);
  bi.bmiHeader.biWidth = PROBE_W;
  bi.bmiHeader.biHeight = -PROBE_H;
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;
  if (mem) bmp = CreateDIBSection(mem, &bi, DIB_RGB_COLORS, &bits, NULL, 0);
  if (bmp && bits) {
    old = SelectObject(mem, bmp);
    SetStretchBltMode(mem, HALFTONE);
    SetBrushOrgEx(mem, 0, 0, NULL);
    if (StretchBlt(mem, 0, 0, PROBE_W, PROBE_H, screen, mon->left, mon->top, mon->right - mon->left, mon->bottom - mon->top,
                   SRCCOPY)) {
      const uint8_t *px = (const uint8_t *)bits;
      int i;
      GdiFlush();
      for (i = 0; i < PROBE_W * PROBE_H; i++) {
        out[i * 3] = px[i * 4 + 2];
        out[i * 3 + 1] = px[i * 4 + 1];
        out[i * 3 + 2] = px[i * 4];
      }
      ok = 1;
    }
    SelectObject(mem, old);
  }
  if (bmp) DeleteObject(bmp);
  if (mem) DeleteDC(mem);
  ReleaseDC(NULL, screen);
  return ok;
}

static void stale_init(StaleWatch *w, const RECT *monitor) {
  ZeroMemory(w, sizeof(*w));
  if (monitor) {
    w->mon = *monitor;
    w->haveMon = 1;
  }
  w->remote = GetSystemMetrics(SM_REMOTESESSION);
  w->session = my_session();
  w->console = WTSGetActiveConsoleSessionId();
  w->awayFromDefault = !input_desktop_is_default();
  w->lastProbe = GetTickCount();
}

static void log_stale(const char *why) {
  fprintf(stderr, "{\"event\":\"stale\",\"why\":\"%s\"}\n", why);
  fflush(stderr);
}

/* Called about once a second. Returns the reason the capture is stale, or NULL. */
static const char *stale_check(StaleWatch *w, ID3D11Device *device, DWORD now, DWORD lastReal) {
  if (device && ID3D11Device_GetDeviceRemovedReason(device) != S_OK) return "device-lost";
  if (w->haveMon) {
    HMONITOR hmon = MonitorFromRect(&w->mon, MONITOR_DEFAULTTONULL);
    MONITORINFO info;
    ZeroMemory(&info, sizeof(info));
    info.cbSize = sizeof(info);
    if (!hmon || !GetMonitorInfo(hmon, &info) || !EqualRect(&info.rcMonitor, &w->mon)) return "display-changed";
  }
  if (GetSystemMetrics(SM_REMOTESESSION) != w->remote) return "session-changed";
  if (WTSGetActiveConsoleSessionId() != w->console) {
    /* Our session became (or stopped being) the console session: tscon / RDP takeover. */
    DWORD now_console = WTSGetActiveConsoleSessionId();
    if (now_console == w->session || w->console == w->session) return "session-changed";
    w->console = now_console;
  }
  if (!input_desktop_is_default()) {
    w->awayFromDefault = 1;
    w->haveSig = 0;
    w->strikes = 0;
    return NULL;
  }
  if (w->awayFromDefault) return "unlocked";
  if (w->haveMon && (now - lastReal) >= PROBE_IDLE_MS && (now - w->lastProbe) >= PROBE_IDLE_MS) {
    uint8_t cur[PROBE_W * PROBE_H * 3];
    w->lastProbe = now;
    if (gdi_probe(&w->mon, cur)) {
      if (w->haveSig) {
        int i, changed = 0;
        for (i = 0; i < PROBE_W * PROBE_H; i++) {
          int d = abs((int)cur[i * 3] - w->sig[i * 3]) + abs((int)cur[i * 3 + 1] - w->sig[i * 3 + 1]) +
                  abs((int)cur[i * 3 + 2] - w->sig[i * 3 + 2]);
          if (d > 48) changed++;
        }
        if (changed * 10 > PROBE_W * PROBE_H) w->strikes++;
        else w->strikes = 0;
        if (w->strikes >= 2) return "frozen";
      }
      memcpy(w->sig, cur, sizeof(cur));
      w->haveSig = 1;
    }
  }
  return NULL;
}

/* A real WGC frame arrived: the GDI baseline restarts from here. */
static void stale_frame(StaleWatch *w) {
  w->haveSig = 0;
  w->strikes = 0;
}

static int capture_loop(void *item, int maxW, int maxH, int fps, const char *source, const RECT *monitor) {
  typedef HRESULT(STDMETHODCALLTYPE *GetSizeFn)(void *, WgcSize *);
  typedef HRESULT(STDMETHODCALLTYPE *CreateFreeFn)(void *, void *, int, INT32, WgcSize, void **);
  typedef HRESULT(STDMETHODCALLTYPE *CreateSessionFn)(void *, void *, void **);
  typedef HRESULT(STDMETHODCALLTYPE *TryFrameFn)(void *, void **);
  typedef HRESULT(STDMETHODCALLTYPE *GetSurfaceFn)(void *, void **);
  typedef HRESULT(STDMETHODCALLTYPE *StartFn)(void *);
  typedef HRESULT(STDMETHODCALLTYPE *PutBoolFn)(void *, unsigned char);
  typedef HRESULT(STDMETHODCALLTYPE *GetIfaceFn)(void *, const GUID *, void **);

  WgcSize itemSize;
  WgcSize poolSize;
  void *poolFactory = NULL;
  void *pool = NULL;
  void *session = NULL;
  void *session2 = NULL;
  void *session3 = NULL;
  void *winrtDevice = NULL;
  ID3D11Device *device = NULL;
  ID3D11DeviceContext *context = NULL;
  ID3D11Texture2D *staging = NULL;
  uint8_t *rgba = NULL;
  size_t rgbaCap = 0;
  GpuScale gpu;
  int outW = 0, outH = 0;
  int cursorOn = 0, borderOff = 0;
  int have = 0, dirty = 0;
  uint64_t sentHash = 0, curHash = 0;
  DWORD lastChange = GetTickCount();
  int lowPrio = 0;
  int sentAny = 0;
  DWORD lastSend = 0;
  DWORD minGap, keepGap;
  HRESULT hr;
  int rc = 1;
  StaleWatch watch;
  DWORD lastReal, lastCheck;

  ZeroMemory(&gpu, sizeof(gpu));
  if (fps < 1) fps = 1;
  if (fps > 30) fps = 30;
  if (maxW > 1920) maxW = 1920;
  if (maxH > 1080) maxH = 1080;
  if (maxW < 2) maxW = 2;
  if (maxH < 2) maxH = 2;

  ZeroMemory(&itemSize, sizeof(itemSize));
  hr = ((GetSizeFn)vtbl_fn(item, 7))(item, &itemSize);
  if (FAILED(hr) || itemSize.Width < 2 || itemSize.Height < 2) {
    log_err("item-size", FAILED(hr) ? hr : E_FAIL);
    goto done;
  }
  fit_even(itemSize.Width, itemSize.Height, maxW, maxH, &outW, &outH);
  /* The frame pool MUST be the item's full physical size. WGC does not scale
   * into a smaller pool: it copies the top-left poolSize pixels of the monitor,
   * so a 1280x720 pool on a 1920x1080 (or 2560x1600, 4K, 125-200% scaled)
   * monitor sent only the top-left part of the desktop (bug 2026-10-10).
   * Downscaling to outW x outH happens on the GPU below (gpu_scale_blt). */
  poolSize.Width = itemSize.Width;
  poolSize.Height = itemSize.Height;

  if (!create_d3d(&device, &context, &winrtDevice)) goto done;

  poolFactory = activate(L"Windows.Graphics.Capture.Direct3D11CaptureFramePool", &IID_IFramePoolStatics2);
  if (!poolFactory) {
    log_err("frame-pool-factory", E_FAIL);
    goto done;
  }
  hr = ((CreateFreeFn)vtbl_fn(poolFactory, 6))(poolFactory, winrtDevice, PIX_BGRA8, 2, poolSize, &pool);
  release_obj(poolFactory);
  poolFactory = NULL;
  if (FAILED(hr) || !pool) {
    log_err("CreateFreeThreaded", hr);
    goto done;
  }
  hr = ((CreateSessionFn)vtbl_fn(pool, 10))(pool, item, &session);
  if (FAILED(hr) || !session) {
    log_err("CreateCaptureSession", hr);
    goto done;
  }
  if (SUCCEEDED(qi_obj(session, &IID_IGraphicsCaptureSession2, &session2)) && session2) {
    hr = ((PutBoolFn)vtbl_fn(session2, 7))(session2, 1);
    cursorOn = SUCCEEDED(hr);
  }
  if (SUCCEEDED(qi_obj(session, &IID_IGraphicsCaptureSession3, &session3)) && session3) {
    hr = ((PutBoolFn)vtbl_fn(session3, 7))(session3, 0);
    borderOff = SUCCEEDED(hr);
  }
  /* Affinity is already set. Wait for one composition so the first frame
   * shows the pixels behind excluded windows, not a stale black rectangle. */
  compose_flush();
  hr = ((StartFn)vtbl_fn(session, 6))(session);
  if (FAILED(hr)) {
    log_err("StartCapture", hr);
    goto done;
  }
  _setmode(_fileno(stdout), _O_BINARY);
  setvbuf(stdout, NULL, _IONBF, 0);
  log_ready(outW, outH, cursorOn, borderOff, source, monitor);

  minGap = (DWORD)(1000 / fps);
  keepGap = 1000; /* heartbeat only; the renderer re-pushes its last frame */
  if (keepGap < minGap) keepGap = minGap;
  lastSend = GetTickCount() - keepGap;
  stale_init(&watch, monitor);
  lastReal = GetTickCount();
  lastCheck = lastReal;

  for (;;) {
    void *frame = NULL;
    DWORD now;
    DWORD due;
    hr = ((TryFrameFn)vtbl_fn(pool, 7))(pool, &frame);
    if (SUCCEEDED(hr) && frame) {
      void *surface = NULL;
      void *access = NULL;
      ID3D11Texture2D *tex = NULL;
      hr = ((GetSurfaceFn)vtbl_fn(frame, 6))(frame, &surface);
      if (SUCCEEDED(hr) && surface && SUCCEEDED(qi_obj(surface, &IID_IDirect3DDxgiInterfaceAccess, &access)) && access) {
        hr = ((GetIfaceFn)vtbl_fn(access, 3))(access, &IID_ID3D11Texture2D_local, (void **)&tex);
      }
      {
        /* ContentSize (IDirect3D11CaptureFrame vtbl slot 8) differs from the
         * pool when the monitor's resolution / scaling changed: restart with a
         * new pool instead of sending a cropped or padded picture. */
        typedef HRESULT(STDMETHODCALLTYPE *ContentSizeFn)(void *, WgcSize *);
        WgcSize cs;
        ZeroMemory(&cs, sizeof(cs));
        if (SUCCEEDED(((ContentSizeFn)vtbl_fn(frame, 8))(frame, &cs)) && cs.Width > 0 && cs.Height > 0 &&
            (cs.Width != poolSize.Width || cs.Height != poolSize.Height)) {
          if (tex) ID3D11Texture2D_Release(tex);
          release_obj(access);
          release_obj(surface);
          release_obj(frame);
          log_stale("display-changed");
          rc = STALE_EXIT;
          goto done;
        }
      }
      if (tex) {
        D3D11_TEXTURE2D_DESC td;
        ID3D11Texture2D *readTex = tex;
        int tw = outW;
        int th = outH;
        ID3D11Texture2D_GetDesc(tex, &td);
        if ((int)td.Width <= maxW && (int)td.Height <= maxH && ((td.Width & 1) == 0) && ((td.Height & 1) == 0) && td.Width >= 2 &&
            td.Height >= 2) {
          tw = (int)td.Width;
          th = (int)td.Height;
        }
        /* Same size: one staging read. A different size is scaled on the GPU first. */
        if (tw != (int)td.Width || th != (int)td.Height) {
          if (gpu_scale_ensure(&gpu, device, context, (int)td.Width, (int)td.Height, tw, th)) {
            ID3D11Texture2D *scaled = gpu_scale_blt(&gpu, tex);
            if (scaled) readTex = scaled;
            else {
              gpu.dead = 1;
              log_note("video-blt");
            }
          }
        }
        if (readback_rgba(device, context, &staging, readTex, tw, th, &rgba, &rgbaCap)) {
          outW = tw;
          outH = th;
          have = 1;
          {
            curHash = frame_hash(rgba, (size_t)tw * (size_t)th * 4u, tw, th);
            if (!sentAny || curHash != sentHash) {
              dirty = 1;
              lastChange = GetTickCount();
              /* Picture changed: back to normal priority right away. */
              if (lowPrio) {
                SetPriorityClass(GetCurrentProcess(), NORMAL_PRIORITY_CLASS);
                lowPrio = 0;
              }
            }
          }
          lastReal = GetTickCount();
          stale_frame(&watch);
        }
      }
      if (tex) ID3D11Texture2D_Release(tex);
      release_obj(access);
      release_obj(surface);
      release_obj(frame);
    }
    now = GetTickCount();
    if (now - lastCheck >= 1000) {
      const char *why = stale_check(&watch, device, now, lastReal);
      lastCheck = now;
      if (why) {
        log_stale(why);
        rc = STALE_EXIT;
        goto done;
      }
    }
    /* Static screen for 3 s: drop to below-normal priority (heartbeats only). */
    if (!lowPrio && have && now - lastChange >= STATIC_PRIO_MS) {
      SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
      lowPrio = 1;
    }
    due = dirty ? minGap : keepGap;
    if (have && (now - lastSend) >= due) {
      if (dirty || !sentAny) {
        if (!write_frame(outW, outH, rgba)) break; /* parent closed the pipe */
        sentAny = 1;
        sentHash = curHash;
      } else if (!write_same(outW, outH)) {
        break;
      }
      lastSend = now;
      dirty = 0;
    } else {
      Sleep(2);
    }
  }
  rc = 0;

done:
  gpu_scale_free(&gpu);
  if (staging) ID3D11Texture2D_Release(staging);
  release_obj(session3);
  release_obj(session2);
  release_obj(session);
  release_obj(pool);
  release_obj(poolFactory);
  release_obj(winrtDevice);
  if (context) ID3D11DeviceContext_Release(context);
  if (device) ID3D11Device_Release(device);
  free(rgba);
  release_obj(item);
  return rc;
}

static int clamp_i(const char *s, int lo, int hi, int fallback) {
  long v = strtol(s, NULL, 10);
  if (v < lo || v > hi) return fallback;
  return (int)v;
}

static int capture_for_monitor(HMONITOR hmon, const RECT *rc, int maxW, int maxH, int fps) {
  void *interop;
  void *item = NULL;
  HRESULT hr;
  typedef HRESULT(STDMETHODCALLTYPE *CreateForMonitorFn)(void *, HMONITOR, const GUID *, void **);
  interop = activate(L"Windows.Graphics.Capture.GraphicsCaptureItem", &IID_IGraphicsCaptureItemInterop);
  if (!interop) {
    log_err("item-interop", E_FAIL);
    return 4;
  }
  /* IGraphicsCaptureItemInterop::CreateForMonitor is vtbl slot 4. */
  hr = ((CreateForMonitorFn)vtbl_fn(interop, 4))(interop, hmon, &IID_IGraphicsCaptureItem, &item);
  release_obj(interop);
  if (FAILED(hr) || !item) {
    log_err("CreateForMonitor", hr);
    return 4;
  }
  return capture_loop(item, maxW, maxH, fps, "monitor", rc);
}

static int cmd_capture_monitor(const char *leftS, const char *topS, const char *rightS, const char *bottomS,
                               const char *maxWS, const char *maxHS, const char *fpsS) {
  MonMatch match;
  MONITORINFO info;
  ZeroMemory(&match, sizeof(match));
  match.left = strtol(leftS, NULL, 10);
  match.top = strtol(topS, NULL, 10);
  match.right = strtol(rightS, NULL, 10);
  match.bottom = strtol(bottomS, NULL, 10);
  EnumDisplayMonitors(NULL, NULL, match_mon, (LPARAM)&match);
  if (!match.found && match.best) {
    /* 125-200 % scaling: Electron's DIP→physical rounding can miss by more than
     * 8 px (or report a DIP-sized rect); take the monitor it overlaps most. */
    fprintf(stderr, "{\"event\":\"log\",\"step\":\"monitor-overlap-match\"}\n");
    fflush(stderr);
    match.found = match.best;
  }
  if (!match.found) {
    fprintf(stderr, "{\"event\":\"error\",\"step\":\"monitor-not-found\",\"left\":%ld,\"top\":%ld,\"right\":%ld,\"bottom\":%ld}\n",
            (long)match.left, (long)match.top, (long)match.right, (long)match.bottom);
    fflush(stderr);
    return 4;
  }
  ZeroMemory(&info, sizeof(info));
  info.cbSize = sizeof(info);
  if (!GetMonitorInfo(match.found, &info)) {
    log_err("monitor-info", E_FAIL);
    return 4;
  }
  return capture_for_monitor(match.found, &info.rcMonitor, clamp_i(maxWS, 2, 1920, 1920), clamp_i(maxHS, 2, 1080, 1080),
                             clamp_i(fpsS, 1, 30, 15));
}

static int cmd_capture_window(const char *hwndDec, const char *maxWS, const char *maxHS, const char *fpsS) {
  unsigned long long hv = strtoull(hwndDec, NULL, 10);
  HWND hwnd = (HWND)(uintptr_t)hv;
  HMONITOR hmon;
  MONITORINFO info;
  if (!hwnd || !IsWindow(hwnd)) {
    log_err("window-hwnd", E_HANDLE);
    return 4;
  }
  hwnd = root_window(hwnd);
  hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  if (!hmon) {
    log_err("window-monitor", E_FAIL);
    return 4;
  }
  ZeroMemory(&info, sizeof(info));
  info.cbSize = sizeof(info);
  if (!GetMonitorInfo(hmon, &info)) {
    log_err("window-monitor-info", E_FAIL);
    return 4;
  }
  return capture_for_monitor(hmon, &info.rcMonitor, clamp_i(maxWS, 2, 1920, 1920), clamp_i(maxHS, 2, 1080, 1080),
                             clamp_i(fpsS, 1, 30, 15));
}

int main(int argc, char **argv) {
  set_per_monitor_dpi();
  if (argc >= 2 && strcmp(argv[1], "probe") == 0) return cmd_probe();
  if (argc >= 2 && strcmp(argv[1], "settle") == 0) return cmd_settle();
  if (argc >= 4 && strcmp(argv[1], "clickthrough") == 0) return cmd_clickthrough(argv[2], argv[3]);
  if (argc >= 9 && strcmp(argv[1], "capture-monitor") == 0)
    return cmd_capture_monitor(argv[2], argv[3], argv[4], argv[5], argv[6], argv[7], argv[8]);
  if (argc >= 6 && strcmp(argv[1], "capture-window") == 0)
    return cmd_capture_window(argv[2], argv[3], argv[4], argv[5]);
  fprintf(stderr, "{\"event\":\"error\",\"step\":\"usage\"}\n");
  return 1;
}
