param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('probe', 'snapshot', 'send')]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [int]$TargetPid,

  [string]$Text = '',

  [string]$ResultPath = ''
)

$ErrorActionPreference = 'Stop'
# Preserve the original output pipe before attaching to another console. Nexus also
# passes a private result-file path because FreeConsole may detach stdout.
$script:originalOutput = [Console]::OpenStandardOutput()

$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class BridgeConsoleNative
{
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const ushort KEY_EVENT = 0x0001;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    public struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct CONSOLE_SCREEN_BUFFER_INFO
    {
        public COORD dwSize;
        public COORD dwCursorPosition;
        public ushort wAttributes;
        public SMALL_RECT srWindow;
        public COORD dwMaximumWindowSize;
    }

    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    public struct KEY_EVENT_RECORD
    {
        [FieldOffset(0), MarshalAs(UnmanagedType.Bool)] public bool bKeyDown;
        [FieldOffset(4)] public ushort wRepeatCount;
        [FieldOffset(6)] public ushort wVirtualKeyCode;
        [FieldOffset(8)] public ushort wVirtualScanCode;
        [FieldOffset(10)] public char UnicodeChar;
        [FieldOffset(12)] public uint dwControlKeyState;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT_RECORD
    {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
    }

    public sealed class SnapshotResult
    {
        public string Text { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public uint[] Processes { get; set; }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFileW(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes,
        uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetConsoleScreenBufferInfo(IntPtr hConsoleOutput, out CONSOLE_SCREEN_BUFFER_INFO info);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ReadConsoleOutputCharacterW(
        IntPtr hConsoleOutput, StringBuilder lpCharacter, uint nLength,
        COORD dwReadCoord, out uint lpNumberOfCharsRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetConsoleProcessList([Out] uint[] processList, uint processCount);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteConsoleInputW(
        IntPtr hConsoleInput, INPUT_RECORD[] lpBuffer, uint nLength, out uint lpNumberOfEventsWritten);

    private static void Attach(uint pid)
    {
        FreeConsole();
        if (!AttachConsole(pid))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "AttachConsole failed");
        }
    }

    private static IntPtr OpenConsoleDevice(string name)
    {
        IntPtr handle = CreateFileW(
            name, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
            IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (handle == INVALID_HANDLE_VALUE)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open " + name);
        }
        return handle;
    }

    private static uint[] AttachedProcesses()
    {
        uint[] first = new uint[32];
        uint count = GetConsoleProcessList(first, (uint)first.Length);
        if (count == 0) return new uint[0];
        if (count <= first.Length)
        {
            uint[] exact = new uint[count];
            Array.Copy(first, exact, count);
            return exact;
        }
        uint[] all = new uint[count];
        uint actual = GetConsoleProcessList(all, count);
        if (actual == 0) return new uint[0];
        if (actual == all.Length) return all;
        uint[] resized = new uint[actual];
        Array.Copy(all, resized, actual);
        return resized;
    }

    public static SnapshotResult Snapshot(uint pid, int maxLines)
    {
        Attach(pid);
        IntPtr output = IntPtr.Zero;
        try
        {
            output = OpenConsoleDevice("CONOUT$");
            CONSOLE_SCREEN_BUFFER_INFO info;
            if (!GetConsoleScreenBufferInfo(output, out info))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetConsoleScreenBufferInfo failed");
            }

            int left = info.srWindow.Left;
            int right = info.srWindow.Right;
            int bufferBottom = Math.Max(0, info.dwSize.Y - 1);
            int bottom = Math.Min(bufferBottom, Math.Max(info.srWindow.Bottom, info.dwCursorPosition.Y));
            int top = Math.Max(0, bottom - Math.Max(1, maxLines) + 1);
            int width = Math.Max(1, right - left + 1);
            var text = new StringBuilder();

            for (int y = top; y <= bottom; y++)
            {
                var line = new StringBuilder(width);
                uint read;
                var coord = new COORD { X = (short)left, Y = (short)y };
                if (!ReadConsoleOutputCharacterW(output, line, (uint)width, coord, out read))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "ReadConsoleOutputCharacter failed");
                }
                text.Append(line.ToString(0, (int)read).TrimEnd('\0', ' '));
                if (y < bottom) text.Append('\n');
            }

            return new SnapshotResult
            {
                Text = text.ToString(),
                Width = width,
                Height = bottom - top + 1,
                Processes = AttachedProcesses()
            };
        }
        finally
        {
            if (output != IntPtr.Zero && output != INVALID_HANDLE_VALUE) CloseHandle(output);
            FreeConsole();
        }
    }

    private static INPUT_RECORD KeyRecord(char ch, ushort virtualKey, bool down, ushort scanCode = 0)
    {
        return new INPUT_RECORD
        {
            EventType = KEY_EVENT,
            KeyEvent = new KEY_EVENT_RECORD
            {
                bKeyDown = down,
                wRepeatCount = 1,
                wVirtualKeyCode = virtualKey,
                wVirtualScanCode = scanCode,
                UnicodeChar = ch,
                dwControlKeyState = 0
            }
        };
    }

    public static int Send(uint pid, string text)
    {
        Attach(pid);
        IntPtr input = IntPtr.Zero;
        try
        {
            input = OpenConsoleDevice("CONIN$");
            var records = new List<INPUT_RECORD>();
            foreach (char ch in text ?? string.Empty)
            {
                records.Add(KeyRecord(ch, 0, true));
                records.Add(KeyRecord(ch, 0, false));
            }
            // Text and Enter must not share a WriteConsoleInput batch: give
            // Antigravity's TUI a bounded chance to process the newly typed
            // text before delivering one VK_RETURN with the real 0x1C scan.
            // A written console event is NOT proof that the app submitted.
            const int batchSize = 512;
            int totalWritten = 0;
            for (int offset = 0; offset < records.Count; offset += batchSize)
            {
                int count = Math.Min(batchSize, records.Count - offset);
                INPUT_RECORD[] array = records.GetRange(offset, count).ToArray();
                uint written;
                if (!WriteConsoleInputW(input, array, (uint)array.Length, out written))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "WriteConsoleInput text failed");
                }
                if (written != array.Length)
                {
                    throw new InvalidOperationException("WriteConsoleInput accepted only part of a text batch.");
                }
                totalWritten += (int)written;
            }
            if (records.Count > 0) System.Threading.Thread.Sleep(80);
            var enter = new INPUT_RECORD[] {
                KeyRecord('\r', 0x0D, true, 0x1C),
                KeyRecord('\r', 0x0D, false, 0x1C)
            };
            uint enterWritten;
            if (!WriteConsoleInputW(input, enter, (uint)enter.Length, out enterWritten))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "WriteConsoleInput Enter failed");
            if (enterWritten != enter.Length)
                throw new InvalidOperationException("WriteConsoleInput accepted only part of Enter; outcome unknown.");
            return totalWritten + (int)enterWritten;
        }
        finally
        {
            if (input != IntPtr.Zero && input != INVALID_HANDLE_VALUE) CloseHandle(input);
            FreeConsole();
        }
    }
}
'@

function Write-BridgeJson($obj, [int]$depth = 4) {
  $json = [pscustomobject]$obj | ConvertTo-Json -Compress -Depth $depth
  $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
  if ($ResultPath) { [System.IO.File]::WriteAllBytes($ResultPath, $bytes) }
  try {
    $script:originalOutput.Write($bytes, 0, $bytes.Length)
    $script:originalOutput.Flush()
  }
  catch { if (-not $ResultPath) { throw } }
}

try {
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop

  if ($Mode -eq 'send') {
    $sendText = $Text
    if (-not $PSBoundParameters.ContainsKey('Text')) {
      $encoded = [Console]::In.ReadToEnd().Trim()
      if ([string]::IsNullOrWhiteSpace($encoded)) {
        $sendText = ''
      }
      else {
        $sendText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
      }
    }
    $count = [BridgeConsoleNative]::Send([uint32]$TargetPid, $sendText)
    Write-BridgeJson @{ ok = $true; pid = $TargetPid; eventsWritten = $count }
    exit 0
  }

  # Discovery needs a short readable sample, not 640 console rows per candidate.
  $maxLines = if ($Mode -eq 'probe') { 6 } else { 640 }
  $snapshot = [BridgeConsoleNative]::Snapshot([uint32]$TargetPid, $maxLines)
  $payload = [ordered]@{
    ok = $true
    pid = $TargetPid
    width = $snapshot.Width
    height = $snapshot.Height
    processes = @($snapshot.Processes)
  }
  if ($Mode -eq 'snapshot') { $payload.text = $snapshot.Text }
  Write-BridgeJson $payload 4
  exit 0
}
catch {
  Write-BridgeJson @{
    ok = $false
    pid = $TargetPid
    error = $_.Exception.Message
    nativeError = if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $null }
  } 3
  exit 2
}
