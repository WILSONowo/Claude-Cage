using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Windows PowerShell 5.1 can be a 32-bit process inspecting a 64-bit app.
// Read the path and creation time from the same pinned kernel process handle.
public static class CageInstallProcess
{
    [StructLayout(LayoutKind.Sequential)]
    private struct UniqueProcess { public int pid; public System.Runtime.InteropServices.ComTypes.FILETIME created; }

    [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int count);
    [DllImport("kernel32", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out System.Runtime.InteropServices.ComTypes.FILETIME created,
        out System.Runtime.InteropServices.ComTypes.FILETIME exited, out System.Runtime.InteropServices.ComTypes.FILETIME kernel,
        out System.Runtime.InteropServices.ComTypes.FILETIME user);
    [DllImport("rstrtmgr", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint session, int flags, StringBuilder key);
    [DllImport("rstrtmgr", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(uint session, uint files, string[] names, uint apps, UniqueProcess[] processes, uint services, string[] serviceNames);
    [DllImport("rstrtmgr")]
    private static extern int RmShutdown(uint session, uint flags, IntPtr callback);
    [DllImport("rstrtmgr")]
    private static extern int RmEndSession(uint session);

    private static bool Matches(Process process, string executable)
    {
        var name = new StringBuilder(32768);
        int count = name.Capacity;
        return QueryFullProcessImageName(process.Handle, 0, name, ref count)
            && string.Equals(name.ToString(), executable, StringComparison.OrdinalIgnoreCase);
    }

    public static Process[] AtPath(string executable)
    {
        var result = new List<Process>();
        foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(executable)))
        {
            try
            {
                if (Matches(process, executable) && !process.HasExited) { result.Add(process); continue; }
            }
            catch (InvalidOperationException) { }
            catch (Win32Exception) { } // Uninspectable images still face the installer's exclusive-file checks.
            process.Dispose();
        }
        return result.ToArray();
    }

    private static void Check(int result) { if (result != 0) throw new Win32Exception(result); }

    public static void CloseWindows(Process[] clients, string executable)
    {
        var identities = new List<UniqueProcess>();
        foreach (var process in clients)
        {
            if (process.HasExited) continue;
            if (!Matches(process, executable)) throw new IOException("Application path changed.");
            var item = new UniqueProcess { pid = process.Id };
            System.Runtime.InteropServices.ComTypes.FILETIME exited, kernel, user;
            if (!GetProcessTimes(process.Handle, out item.created, out exited, out kernel, out user))
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
            // Zero flags let the application refuse closure, without forced termination.
            Check(RmShutdown(session, 0, IntPtr.Zero));
        }
        finally { RmEndSession(session); }
        foreach (var process in clients)
            if (!process.WaitForExit(5000)) throw new IOException("The application is still running.");
    }
}
