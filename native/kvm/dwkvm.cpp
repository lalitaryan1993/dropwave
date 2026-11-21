// dwkvm.exe — DropWave "one mouse, two PCs" helper. Talks to DropWave over stdin/stdout, one line
// per message. It only runs while mouse sharing is on, and only does what DropWave tells it.
//
// On the PC whose mouse is used ("here"):
//   edges <left> <right>      which screen edges lead to another PC (0/1 each)
//   capture                   the mouse went to the other PC: keep this cursor still, report input
//   release <side> <y>        it came back: stop, put the cursor at that edge (y = 0..1)
//   -> edge <side> <y>        the cursor was pushed against an active edge
//   -> m <dx> <dy>            mouse moved while captured (coalesced)
//   -> b <1-5> <d|u>          button 1 left, 2 right, 3 middle, 4 back, 5 forward
//   -> w <delta> / hw <delta> wheel / horizontal wheel
//   -> k <vk> <scan> <ext> <d|u>
//   -> takeback               Ctrl+Alt+Home pressed while captured: bring the mouse back
//
// On the PC that is controlled ("there"):
//   enter <side> <y>          the mouse arrives at this edge (side = where the other PC is)
//   m / b / w / hw / k ...    same events as above, injected here
//   leave                     stop (release any held keys and buttons)
//   -> leave <y>              the cursor went back over that edge
//
//   quit
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <atomic>
#include <mutex>
#include <set>

static HHOOK gMouse = nullptr, gKeys = nullptr;
static DWORD gMainThread = 0;
static std::atomic<bool> gCapture{false};
static std::atomic<bool> gEdgeL{false}, gEdgeR{false};
static std::atomic<bool> gEdgeArmed{true};
static POINT gPark{0, 0};
static std::mutex gOut;
static bool gCtrl = false, gAlt = false;

// Remote side ("there").
static std::atomic<bool> gRemote{false};
static int gHome = 0;          // -1 = the other PC is on the left, +1 = on the right
static double gX = 0, gY = 0;  // virtual cursor, in virtual-desktop pixels
static std::set<WORD> gDownKeys;
static int gDownButtons = 0;

static void out(const char* fmt, ...) {
  std::lock_guard<std::mutex> l(gOut);
  va_list a; va_start(a, fmt); vfprintf(stdout, fmt, a); va_end(a);
  fputc('\n', stdout); fflush(stdout);
}

struct Desk { int x, y, w, h; };
static Desk desk() {
  return { GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN),
           GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN) };
}

// Coalesce mouse moves: the hook adds, a 4 ms timer thread flushes.
static std::atomic<int> gDx{0}, gDy{0};

static LRESULT CALLBACK mouseProc(int code, WPARAM wp, LPARAM lp) {
  if (code != HC_ACTION) return CallNextHookEx(nullptr, code, wp, lp);
  auto* m = reinterpret_cast<MSLLHOOKSTRUCT*>(lp);
  if (m->flags & LLMHF_INJECTED) return CallNextHookEx(nullptr, code, wp, lp);
  if (gCapture) {
    switch (wp) {
      case WM_MOUSEMOVE: gDx += m->pt.x - gPark.x; gDy += m->pt.y - gPark.y; break;
      case WM_LBUTTONDOWN: out("b 1 d"); break;  case WM_LBUTTONUP: out("b 1 u"); break;
      case WM_RBUTTONDOWN: out("b 2 d"); break;  case WM_RBUTTONUP: out("b 2 u"); break;
      case WM_MBUTTONDOWN: out("b 3 d"); break;  case WM_MBUTTONUP: out("b 3 u"); break;
      case WM_XBUTTONDOWN: out("b %d d", HIWORD(m->mouseData) == XBUTTON1 ? 4 : 5); break;
      case WM_XBUTTONUP: out("b %d u", HIWORD(m->mouseData) == XBUTTON1 ? 4 : 5); break;
      case WM_MOUSEWHEEL: out("w %d", (short)HIWORD(m->mouseData)); break;
      case WM_MOUSEHWHEEL: out("hw %d", (short)HIWORD(m->mouseData)); break;
    }
    return 1; // swallowed: this cursor stays parked
  }
  if (wp == WM_MOUSEMOVE && (gEdgeL || gEdgeR)) {
    Desk d = desk();
    // Not while a button is held (dragging a window or selecting text up to the edge).
    bool held = (GetAsyncKeyState(VK_LBUTTON) | GetAsyncKeyState(VK_RBUTTON)) & 0x8000;
    double y = (m->pt.y - d.y) / (double)(d.h > 1 ? d.h - 1 : 1);
    int side = 0;
    if (gEdgeR && m->pt.x >= d.x + d.w - 1) side = 1;
    else if (gEdgeL && m->pt.x <= d.x) side = -1;
    if (side && !held && gEdgeArmed) { gEdgeArmed = false; out("edge %s %.4f", side > 0 ? "right" : "left", y); }
    else if (!side) gEdgeArmed = true;
  }
  return CallNextHookEx(nullptr, code, wp, lp);
}

static LRESULT CALLBACK keyProc(int code, WPARAM wp, LPARAM lp) {
  if (code != HC_ACTION) return CallNextHookEx(nullptr, code, wp, lp);
  auto* k = reinterpret_cast<KBDLLHOOKSTRUCT*>(lp);
  if (k->flags & LLKHF_INJECTED) return CallNextHookEx(nullptr, code, wp, lp);
  bool down = wp == WM_KEYDOWN || wp == WM_SYSKEYDOWN;
  if (k->vkCode == VK_LCONTROL || k->vkCode == VK_RCONTROL || k->vkCode == VK_CONTROL) gCtrl = down;
  if (k->vkCode == VK_LMENU || k->vkCode == VK_RMENU || k->vkCode == VK_MENU) gAlt = down;
  if (!gCapture) return CallNextHookEx(nullptr, code, wp, lp);
  if (down && k->vkCode == VK_HOME && gCtrl && gAlt) { out("takeback"); return 1; }
  out("k %lu %lu %d %s", k->vkCode, k->scanCode, (k->flags & LLKHF_EXTENDED) ? 1 : 0, down ? "d" : "u");
  return 1;
}

// ---------- injecting (the controlled PC) ----------

static void moveTo(double x, double y) {
  Desk d = desk();
  INPUT in{}; in.type = INPUT_MOUSE;
  in.mi.dx = (LONG)((x - d.x) * 65535.0 / (d.w > 1 ? d.w - 1 : 1));
  in.mi.dy = (LONG)((y - d.y) * 65535.0 / (d.h > 1 ? d.h - 1 : 1));
  in.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  SendInput(1, &in, sizeof(in));
}

static void button(int n, bool down) {
  INPUT in{}; in.type = INPUT_MOUSE;
  switch (n) {
    case 1: in.mi.dwFlags = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP; break;
    case 2: in.mi.dwFlags = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP; break;
    case 3: in.mi.dwFlags = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP; break;
    case 4: case 5: in.mi.dwFlags = down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP; in.mi.mouseData = n == 4 ? XBUTTON1 : XBUTTON2; break;
    default: return;
  }
  if (down) gDownButtons |= 1 << n; else gDownButtons &= ~(1 << n);
  SendInput(1, &in, sizeof(in));
}

static void key(WORD vk, WORD scan, bool ext, bool down) {
  INPUT in{}; in.type = INPUT_KEYBOARD;
  in.ki.wVk = vk; in.ki.wScan = scan;
  in.ki.dwFlags = (ext ? KEYEVENTF_EXTENDEDKEY : 0) | (down ? 0 : KEYEVENTF_KEYUP);
  if (down) gDownKeys.insert(vk); else gDownKeys.erase(vk);
  SendInput(1, &in, sizeof(in));
}

static void releaseAll() {
  for (WORD vk : std::set<WORD>(gDownKeys)) key(vk, (WORD)MapVirtualKey(vk, MAPVK_VK_TO_VSC), false, false);
  for (int n = 1; n <= 5; n++) if (gDownButtons & (1 << n)) button(n, false);
}

static void remoteMove(int dx, int dy) {
  Desk d = desk();
  gX += dx; gY += dy;
  if (gY < d.y) gY = d.y; if (gY > d.y + d.h - 1) gY = d.y + d.h - 1;
  // Back over the edge the mouse came in from: it goes home.
  if ((gHome < 0 && gX < d.x) || (gHome > 0 && gX > d.x + d.w - 1)) {
    double y = (gY - d.y) / (double)(d.h > 1 ? d.h - 1 : 1);
    releaseAll();
    gRemote = false;
    out("leave %.4f", y);
    return;
  }
  if (gX < d.x) gX = d.x; if (gX > d.x + d.w - 1) gX = d.x + d.w - 1;
  moveTo(gX, gY);
}

// ---------- commands ----------

static void command(const std::string& line) {
  char cmd[16] = {0};
  if (sscanf(line.c_str(), "%15s", cmd) != 1) return;
  const char* rest = line.c_str() + strlen(cmd);
  if (!strcmp(cmd, "edges")) { int l = 0, r = 0; sscanf(rest, "%d %d", &l, &r); gEdgeL = l != 0; gEdgeR = r != 0; }
  else if (!strcmp(cmd, "capture")) {
    // Park the cursor in the middle of the primary screen; every move is reported as a delta from it.
    gPark = { GetSystemMetrics(SM_CXSCREEN) / 2, GetSystemMetrics(SM_CYSCREEN) / 2 };
    SetCursorPos(gPark.x, gPark.y);
    gDx = 0; gDy = 0; gCapture = true;
  } else if (!strcmp(cmd, "release")) {
    char side[8] = {0}; double y = 0.5; sscanf(rest, "%7s %lf", side, &y);
    gCapture = false; gEdgeArmed = false;
    Desk d = desk();
    int x = !strcmp(side, "right") ? d.x + d.w - 3 : d.x + 2;
    SetCursorPos(x, d.y + (int)(y * (d.h - 1)));
  } else if (!strcmp(cmd, "enter")) {
    char side[8] = {0}; double y = 0.5; sscanf(rest, "%7s %lf", side, &y);
    Desk d = desk();
    gHome = !strcmp(side, "right") ? 1 : -1;
    gX = gHome > 0 ? d.x + d.w - 3 : d.x + 2;
    gY = d.y + y * (d.h - 1);
    gRemote = true;
    moveTo(gX, gY);
  } else if (!strcmp(cmd, "leave")) { releaseAll(); gRemote = false; }
  else if (!strcmp(cmd, "m")) { int dx = 0, dy = 0; sscanf(rest, "%d %d", &dx, &dy); if (gRemote) remoteMove(dx, dy); }
  else if (!strcmp(cmd, "b")) { int n = 0; char s[4] = {0}; sscanf(rest, "%d %3s", &n, s); if (gRemote) button(n, s[0] == 'd'); }
  else if (!strcmp(cmd, "w") || !strcmp(cmd, "hw")) {
    int v = 0; sscanf(rest, "%d", &v);
    if (gRemote) { INPUT in{}; in.type = INPUT_MOUSE; in.mi.dwFlags = cmd[0] == 'h' ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL; in.mi.mouseData = (DWORD)v; SendInput(1, &in, sizeof(in)); }
  } else if (!strcmp(cmd, "k")) {
    unsigned vk = 0, sc = 0; int ext = 0; char s[4] = {0};
    sscanf(rest, "%u %u %d %3s", &vk, &sc, &ext, s);
    if (gRemote && vk && vk < 256) key((WORD)vk, (WORD)sc, ext != 0, s[0] == 'd');
  } else if (!strcmp(cmd, "quit")) { PostThreadMessage(gMainThread, WM_QUIT, 0, 0); }
}

int main() {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); // real pixels on every screen
  gMainThread = GetCurrentThreadId();
  // Low-level hooks are called on this thread: it must keep pumping messages and answer fast.
  gMouse = SetWindowsHookExW(WH_MOUSE_LL, mouseProc, GetModuleHandleW(nullptr), 0);
  gKeys = SetWindowsHookExW(WH_KEYBOARD_LL, keyProc, GetModuleHandleW(nullptr), 0);
  if (!gMouse || !gKeys) { out("error hooks %lu", GetLastError()); return 1; }

  std::thread([] { // stdin: commands; EOF (DropWave closed) = quit
    char buf[256];
    while (fgets(buf, sizeof buf, stdin)) {
      std::string s(buf);
      while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
      if (!s.empty()) command(s);
    }
    gCapture = false;
    PostThreadMessage(gMainThread, WM_QUIT, 0, 0);
  }).detach();

  std::thread([] { // coalesced mouse moves, every 4 ms
    for (;;) {
      Sleep(4);
      int dx = gDx.exchange(0), dy = gDy.exchange(0);
      if (gCapture && (dx || dy)) out("m %d %d", dx, dy);
    }
  }).detach();

  out("ready");
  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) { TranslateMessage(&msg); DispatchMessageW(&msg); }
  gCapture = false;
  releaseAll();
  UnhookWindowsHookEx(gMouse);
  UnhookWindowsHookEx(gKeys);
  return 0;
}
