using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Windows PowerShell 5.1 can be a 32-bit process inspecting a 64-bit app.
// Read the path and creation time from the same pinned kernel process handle.
public sealed class CageInstallProcess : IDisposable
{
    private const uint QueryLimited = 0x1000, Synchronize = 0x100000, Terminate = 1;
    private readonly SafeProcessHandle handle;
    public int Id { get; private set; }

    private CageInstallProcess(int id, SafeProcessHandle handle) { Id = id; this.handle = handle; }
    public void Dispose() { handle.Dispose(); }
    public bool HasExited { get { return WaitForExit(0); } }
    public bool WaitForExit(int milliseconds)
    {
        uint result = WaitForSingleObject(handle, checked((uint)milliseconds));
        if (result == 258) return false; // WAIT_TIMEOUT
        if (result != 0) throw new Win32Exception();
        return true;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct UniqueProcess { public int pid; public System.Runtime.InteropServices.ComTypes.FILETIME created; }

    [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageName(SafeProcessHandle process, int flags, StringBuilder name, ref int count);
    [DllImport("kernel32", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
    [DllImport("kernelbase")]
    private static extern bool CompareObjectHandles(SafeProcessHandle first, SafeProcessHandle second);
    [DllImport("kernel32", SetLastError = true)]
    private static extern bool ProcessIdToSessionId(int pid, out uint session);
    [DllImport("kernel32", SetLastError = true)]
    private static extern bool GetProcessTimes(SafeProcessHandle process, out System.Runtime.InteropServices.ComTypes.FILETIME created,
        out System.Runtime.InteropServices.ComTypes.FILETIME exited, out System.Runtime.InteropServices.ComTypes.FILETIME kernel,
        out System.Runtime.InteropServices.ComTypes.FILETIME user);
    [DllImport("kernel32", SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("advapi32", SetLastError = true)]
    private static extern bool OpenProcessToken(SafeProcessHandle process, uint access, out SafeFileHandle token);
    [DllImport("advapi32", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int infoClass, out uint value, int size, out uint returned);
    [DllImport("kernel32", SetLastError = true)]
    private static extern bool TerminateProcess(SafeProcessHandle process, uint exitCode);
    [DllImport("rstrtmgr", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint session, int flags, StringBuilder key);
    [DllImport("rstrtmgr", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(uint session, uint files, string[] names, uint apps, UniqueProcess[] processes, uint services, string[] serviceNames);
    [DllImport("rstrtmgr")]
    private static extern int RmShutdown(uint session, uint flags, IntPtr callback);
    [DllImport("rstrtmgr")]
    private static extern int RmEndSession(uint session);

    private static bool Matches(SafeProcessHandle handle, string executable)
    {
        var name = new StringBuilder(32768);
        int count = name.Capacity;
        return QueryFullProcessImageName(handle, 0, name, ref count)
            && string.Equals(name.ToString(), executable, StringComparison.OrdinalIgnoreCase);
    }

    public static CageInstallProcess[] AtPath(string executable)
    {
        var result = new List<CageInstallProcess>();
        try
        {
            foreach (var candidate in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(executable)))
            {
                using (candidate)
                using (var query = OpenProcess(QueryLimited, false, candidate.Id))
                {
                    if (query.IsInvalid || !Matches(query, executable)) continue;
                    var watched = OpenProcess(QueryLimited | Synchronize, false, candidate.Id);
                    if (watched.IsInvalid)
                    {
                        int code = Marshal.GetLastWin32Error();
                        watched.Dispose();
                        if (code == 87) continue; // The process exited between opens.
                        Check(code);
                    }
                    if (CompareObjectHandles(query, watched)) result.Add(new CageInstallProcess(candidate.Id, watched));
                    else watched.Dispose();
                }
            }
            return result.ToArray();
        }
        catch { foreach (var process in result) process.Dispose(); throw; }
    }

    private static void Check(int result)
    {
        if (result == 5) throw new UnauthorizedAccessException("Windows denied access to the application process.");
        if (result != 0) throw new Win32Exception(result);
    }

    private static bool IsElevated(IntPtr token)
    {
        uint elevated, returned;
        if (!GetTokenInformation(token, 20 /* TokenElevation */, out elevated, sizeof(uint), out returned))
            Check(Marshal.GetLastWin32Error());
        return elevated != 0;
    }

    public static bool NeedsElevation(CageInstallProcess[] processes)
    {
        using (var current = WindowsIdentity.GetCurrent())
        {
            if (IsElevated(current.Token)) return false;
            foreach (var process in processes)
                if (!process.HasExited && IsCurrentUserSession(process, true)) return true;
        }
        return false;
    }

    public static bool IsCurrentUserSession(CageInstallProcess process)
    {
        return IsCurrentUserSession(process, null);
    }

    public static bool IsUnelevatedWizard(CageInstallProcess process, bool elevatedHelper)
    {
        using (var current = WindowsIdentity.GetCurrent())
            return IsElevated(current.Token) == elevatedHelper && !process.HasExited && IsCurrentUserSession(process, false);
    }

    private static bool IsCurrentUserSession(CageInstallProcess process, bool? elevation)
    {
        using (var self = Process.GetCurrentProcess())
        using (var user = WindowsIdentity.GetCurrent())
        {
            uint session;
            if (!ProcessIdToSessionId(process.Id, out session)) return false;
            if (session != self.SessionId) return false;
            SafeFileHandle token;
            if (!OpenProcessToken(process.handle, 8 /* TOKEN_QUERY */, out token)) Check(Marshal.GetLastWin32Error());
            using (token)
            using (var owner = new WindowsIdentity(token.DangerousGetHandle()))
                return user.User.Equals(owner.User) && (!elevation.HasValue || IsElevated(owner.Token) == elevation.Value);
        }
    }

    // The launcher's single-instance pipe is scoped to its Windows user and
    // profile. Connecting without sending the activation byte leaves it hidden.
    public static bool OwnsWindowPipe(CageInstallProcess process, string profile)
    {
        if (!IsCurrentUserSession(process)) return false;
        using (var user = WindowsIdentity.GetCurrent())
        using (var sha = SHA256.Create())
        {
            string scope = user.User.Value;
            if (!string.IsNullOrEmpty(profile)) scope += "\0" + Path.GetFullPath(profile).TrimEnd(Path.DirectorySeparatorChar).ToUpperInvariant();
            string name = "Cage-" + BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(scope)), 0, 12).Replace("-", "");
            using (var pipe = new NamedPipeClientStream(".", name, PipeDirection.Out, PipeOptions.None,
                TokenImpersonationLevel.Anonymous))
            {
                try { pipe.Connect(1000); }
                catch (TimeoutException) { return false; }
                uint pid;
                return GetNamedPipeServerProcessId(pipe.SafePipeHandle, out pid) && pid == process.Id && !process.HasExited;
            }
        }
    }

    public static void CloseWindows(CageInstallProcess[] clients, string executable, bool stop)
    {
        var identities = new List<UniqueProcess>();
        foreach (var process in clients)
        {
            if (process.HasExited) continue;
            if (!Matches(process.handle, executable)) throw new IOException("Application path changed.");
            var item = new UniqueProcess { pid = process.Id };
            System.Runtime.InteropServices.ComTypes.FILETIME exited, kernel, user;
            if (!GetProcessTimes(process.handle, out item.created, out exited, out kernel, out user))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            identities.Add(item);
        }
        if (identities.Count == 0) return;
        uint session;
        Check(RmStartSession(out session, 0, new StringBuilder(33)));
        try
        {
            Check(RmRegisterResources(session, 0, null, (uint)identities.Count, identities.ToArray(), 0, null));
            // ENDSESSION_CLOSEAPP also reaches an old WinForms launcher hidden in the tray.
            int status = RmShutdown(session, 0, IntPtr.Zero);
            // Windows can report reboot required (350) or an unresponsive app
            // (351). Only the previously verified frontend may be terminated.
            if (!stop || (status != 350 && status != 351)) Check(status);
        }
        finally { RmEndSession(session); }
        foreach (var process in clients)
        {
            if (process.WaitForExit(5000)) continue;
            if (!stop || !IsCurrentUserSession(process))
                throw new IOException("The application is still running.");
            using (var end = OpenProcess(Terminate | QueryLimited, false, process.Id))
            {
                if (end.IsInvalid)
                {
                    int code = Marshal.GetLastWin32Error();
                    if (process.HasExited) continue;
                    Check(code);
                }
                if (!CompareObjectHandles(process.handle, end) || !Matches(end, executable))
                    throw new IOException("Application process changed.");
                if (!TerminateProcess(end, 0))
                {
                    int code = Marshal.GetLastWin32Error();
                    if (!process.HasExited) Check(code);
                }
            }
            if (!process.WaitForExit(5000)) throw new IOException("The application did not exit.");
        }
    }
}
