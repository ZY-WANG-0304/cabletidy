param(
    [ValidateSet('version', 'models')][string]$Query,
    [ValidateRange(1, 2147483647)][int]$DaemonPid
)
$ErrorActionPreference = 'Stop'
# Missing executables must not trigger a scan of every installed PowerShell module.
if (-not (Get-Command codex -CommandType Application -ListImported -ErrorAction SilentlyContinue)) {
    [Console]::Error.WriteLine('Cannot find codex in PATH')
    exit 127
}

# A Job Object also owns descendants whose launcher has already exited.
# Keep its non-inheritable handle open until this supervisor exits or is killed.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

public static class CableTidyCodexJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern bool SetConsoleCtrlHandler(IntPtr handler, bool ignore);
    static IntPtr job;

    public static int Run(string command, int daemonPid) {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)) ||
            !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle)) {
            throw new Win32Exception();
        }
        // The daemon controls Ctrl+C draining. This flag is inherited by children.
        SetConsoleCtrlHandler(IntPtr.Zero, true);
        // Hold a process handle so PID reuse cannot disguise daemon termination.
        var daemon = Process.GetProcessById(daemonPid);
        if (daemon.Handle == IntPtr.Zero) throw new Win32Exception();
        Task.Run(() => {
            daemon.WaitForExit();
            Environment.Exit(130);
        });
        // Only fixed arguments reach cmd.exe; it resolves native binaries and npm .cmd shims.
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec"),
            "/d /s /c \"codex " + command + "\"");
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        using (var child = Process.Start(start)) {
            var stdout = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            var stderr = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            child.WaitForExit();
            // Drain successful output, including pipes still held by descendants.
            // On failure, exiting this supervisor closes the job immediately.
            if (child.ExitCode == 0) Task.WaitAll(stdout, stderr);
            return child.ExitCode;
        }
    }
}
'@

$command = if ($Query -eq 'version') { '--version' } else { 'debug models --bundled' }
exit [CableTidyCodexJob]::Run($command, $DaemonPid)
