// Adapted from LaunchMenu/node-global-key-listener (MIT).
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <iostream>
#include <thread>
#include <string>
#include <cstddef>
#include <ctime>
#include <climits>

int timeoutTime = 30;

POINT zeroPoint { 0, 0 };

enum KeyState
{
    none = 0,
    down = 1,
    up = 2
};

void MessageLoop();
__declspec(dllexport) LRESULT CALLBACK KeyboardEvent(int nCode, WPARAM wParam, LPARAM lParam);
__declspec(dllexport) LRESULT CALLBACK MouseEvent(int nCode, WPARAM wParam, LPARAM lParam);
bool haltPropogation(bool isMouse, bool isDown, DWORD vkCode, DWORD scanCode, POINT location);
KeyState getKeyState(WPARAM wParam);
DWORD getMouseButtonCode(WPARAM wParam);
void printErr(const char *str);
void fakeKey(DWORD iKeyEventF, WORD vkVirtualKey, ULONG_PTR extraInfo = 0);
bool isInjectedCleanupEvent(const KBDLLHOOKSTRUCT &key);
bool isPhysicalKeyDown(int vKey);
void releaseTrackedModifier(DWORD vkCode);
void releaseAllTrackedModifiers();
DWORD WINAPI timeoutLoop(LPVOID lpParam);
DWORD WINAPI checkInputLoop(LPVOID lpParam);

struct data
{
    char *buffer;
    std::size_t size;
};

HHOOK hKeyboardHook;
HHOOK hMouseHook;
bool bIsMetaDown = false;
bool bIsAltDown = false;
bool bIsRightControlSuppressed = false;
bool bIsRightAltSuppressed = false;
bool bIsAltGrControlSuppressed = false;
const ULONG_PTR kCleanupExtraInfo = 0x4C4544554FULL;

int main(int argc, char **argv)
{
    HINSTANCE hInstance = GetModuleHandle(NULL);
    if (!hInstance)
        return 1;

    HANDLE timeoutThread = CreateThread(NULL, 0, timeoutLoop, NULL, 0, NULL);
    HANDLE inputThread = CreateThread(NULL, 0, checkInputLoop, NULL, 0, NULL);

    hKeyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, (HOOKPROC)KeyboardEvent, hInstance, 0);
    hMouseHook = SetWindowsHookEx(WH_MOUSE_LL, (HOOKPROC)MouseEvent, hInstance, 0);

    MessageLoop();
    releaseAllTrackedModifiers();

    UnhookWindowsHookEx(hKeyboardHook);
    UnhookWindowsHookEx(hMouseHook);

    CloseHandle(timeoutThread);
    CloseHandle(inputThread);

    return 0;
}

__declspec(dllexport) LRESULT CALLBACK KeyboardEvent(int nCode, WPARAM wParam, LPARAM lParam)
{
    KeyState ks = getKeyState(wParam);
    if ((nCode == HC_ACTION) && ks)
    {
        KBDLLHOOKSTRUCT key = *((KBDLLHOOKSTRUCT *)lParam);

        if (isInjectedCleanupEvent(key))
        {
            return CallNextHookEx(hKeyboardHook, nCode, wParam, lParam);
        }

        if (haltPropogation(false, ks == down, key.vkCode, key.scanCode, zeroPoint))
        {
            if (key.vkCode == VK_RCONTROL)
            {
                if (ks == down)
                    bIsRightControlSuppressed = true;
                else
                    releaseTrackedModifier(VK_RCONTROL);
            }
            if (key.vkCode == VK_RMENU)
            {
                if (ks == down)
                {
                    bIsRightAltSuppressed = true;
                    bIsAltGrControlSuppressed = isPhysicalKeyDown(VK_LCONTROL) || isPhysicalKeyDown(VK_CONTROL);
                }
                else
                    releaseTrackedModifier(VK_RMENU);
            }
            if (bIsMetaDown || bIsAltDown)
            {
                printErr("Sending VK_HELP to prevent win_key_up triggering start menu");
                fakeKey(KEYEVENTF_KEYUP, VK_HELP);
            }
            return 1;
        }
        else
        {
            if (key.vkCode == VK_RCONTROL && ks == up)
                bIsRightControlSuppressed = false;
            if (key.vkCode == VK_RMENU && ks == up)
            {
                bIsRightAltSuppressed = false;
                bIsAltGrControlSuppressed = false;
            }
            if (key.vkCode == VK_LWIN || key.vkCode == VK_RWIN)
                bIsMetaDown = ks == down;
            if (key.vkCode == VK_LMENU || key.vkCode == VK_RMENU)
                bIsAltDown = ks == down;
        }
    }
    return CallNextHookEx(hKeyboardHook, nCode, wParam, lParam);
}

__declspec(dllexport) LRESULT CALLBACK MouseEvent(int nCode, WPARAM wParam, LPARAM lParam)
{
    MOUSEHOOKSTRUCT * pMouseStruct = (MOUSEHOOKSTRUCT *)lParam;
    KeyState ks = getKeyState(wParam);
    DWORD vCode = getMouseButtonCode(wParam);

    if (nCode >= 0 && pMouseStruct != NULL && ks && vCode)
    {
        if (haltPropogation(true, ks == down, vCode, vCode, pMouseStruct->pt))
        {
            return 1;
        }
    }

    return CallNextHookEx(hKeyboardHook, nCode, wParam, lParam);
}

void MessageLoop()
{
    MSG message;
    while (GetMessage(&message, NULL, 0, 0))
    {
        TranslateMessage(&message);
        DispatchMessage(&message);
    }
}

KeyState getKeyState(WPARAM wParam)
{
    switch (wParam)
    {
    case WM_KEYDOWN:
        return down;
    case WM_KEYUP:
        return up;
    case WM_SYSKEYDOWN:
        return down;
    case WM_SYSKEYUP:
        return up;
    case WM_LBUTTONDOWN:
        return down;
    case WM_LBUTTONUP:
        return up;
    case WM_RBUTTONDOWN:
        return down;
    case WM_RBUTTONUP:
        return up;
    case WM_MBUTTONDOWN:
        return down;
    case WM_MBUTTONUP:
        return up;
    default:
        return none;
    }
}

DWORD getMouseButtonCode(WPARAM wParam)
{
    switch (wParam)
    {
    case WM_LBUTTONDOWN:
    case WM_LBUTTONUP:
        return VK_LBUTTON;
    case WM_RBUTTONDOWN:
    case WM_RBUTTONUP:
        return VK_RBUTTON;
    case WM_MBUTTONDOWN:
    case WM_MBUTTONUP:
        return VK_MBUTTON;
    default:
        return 0;
    }
}

void fakeKey(DWORD iKeyEventF, WORD vkVirtualKey, ULONG_PTR extraInfo)
{
    INPUT inputFix;
    inputFix.type = INPUT_KEYBOARD;
    inputFix.ki.wVk = vkVirtualKey;
    inputFix.ki.wScan = 0;
    inputFix.ki.dwFlags = iKeyEventF;
    inputFix.ki.time = 0;
    inputFix.ki.dwExtraInfo = extraInfo;
    SendInput(1, &inputFix, sizeof(inputFix));
}

bool isInjectedCleanupEvent(const KBDLLHOOKSTRUCT &key)
{
    return (key.flags & LLKHF_INJECTED) && key.dwExtraInfo == kCleanupExtraInfo;
}

bool isPhysicalKeyDown(int vKey)
{
    return (GetAsyncKeyState(vKey) & 0x8000) != 0;
}

void releaseTrackedModifier(DWORD vkCode)
{
    if (vkCode == VK_RCONTROL && bIsRightControlSuppressed)
    {
        printErr("Releasing suppressed VK_RCONTROL\n");
        fakeKey(KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, VK_RCONTROL, kCleanupExtraInfo);
        bIsRightControlSuppressed = false;
    }
    if (vkCode == VK_RMENU && bIsRightAltSuppressed)
    {
        printErr("Releasing suppressed VK_RMENU\n");
        fakeKey(KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, VK_RMENU, kCleanupExtraInfo);
        bIsRightAltSuppressed = false;
        if (bIsAltGrControlSuppressed)
        {
            printErr("Releasing AltGr companion VK_LCONTROL\n");
            fakeKey(KEYEVENTF_KEYUP, VK_LCONTROL, kCleanupExtraInfo);
            bIsAltGrControlSuppressed = false;
        }
    }
}

void releaseAllTrackedModifiers()
{
    releaseTrackedModifier(VK_RCONTROL);
    releaseTrackedModifier(VK_RMENU);
}

void printErr(const char str[])
{
    fprintf(stderr, str);
    fflush(stderr);
}

HANDLE signalMutex = CreateMutex(NULL, FALSE, NULL);
HANDLE requestTimeoutSemaphore = CreateSemaphore(NULL, 0, INT_MAX, NULL);
HANDLE responseSemaphore = CreateSemaphore(NULL, 0, INT_MAX, NULL);
long requestTime = 0;
long responseId = 0;
long timeoutId = 0;
long curId = 0;
std::string output = "";

bool haltPropogation(bool isMouse, bool isDown, DWORD vkCode, DWORD scanCode, POINT location)
{
    curId = curId + 1;
    printf("%s,%s,%i,%i,%ld,%ld,%i\n", (isMouse ? "MOUSE" : "KEYBOARD"), (isDown ? "DOWN" : "UP"), vkCode, scanCode, location.x, location.y, curId);
    fflush(stdout);

    requestTime = time(0) * 1000 + timeoutTime;
    ReleaseSemaphore(requestTimeoutSemaphore, 1, NULL);

    WaitForSingleObject(responseSemaphore, INFINITE);

    return output == "1";
}

DWORD WINAPI checkInputLoop(LPVOID lpParam)
{
    while (true)
    {
        std::string entry;
        std::getline(std::cin, entry);

        int index = entry.find_first_of(",");
        std::string code = entry.substr(0, index);
        int id = atoi((entry.substr(index + 1)).c_str());

        WaitForSingleObject(signalMutex, INFINITE);
        if (timeoutId < id)
        {
            responseId = id;
            output = code;
            ReleaseSemaphore(responseSemaphore, 1, NULL);
        }
        ReleaseMutex(signalMutex);
    }
    return 0;
}

DWORD WINAPI timeoutLoop(LPVOID lpParam)
{
    while (true)
    {
        WaitForSingleObject(requestTimeoutSemaphore, INFINITE);

        long sleepDuration = requestTime - time(0) * 1000;
        if (sleepDuration > 0)
            Sleep(sleepDuration);

        WaitForSingleObject(signalMutex, INFINITE);
        timeoutId = timeoutId + 1;
        if (responseId < timeoutId)
        {
            output = "0";
            ReleaseSemaphore(responseSemaphore, 1, NULL);
        }
        ReleaseMutex(signalMutex);
    }
    return 0;
}
