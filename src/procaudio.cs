// procaudio: records the audio of one process (and its children) to a WAV file with Windows'
// process loopback (Windows 10 2004+), so a video of a game gets only that game's sound: no
// microphone, no other programs. bedmcp compiles it with the .NET Framework's csc.exe on first use.
//
//   procaudio.exe <pid> <out.wav>
// Prints "start <unix ms>" when capture starts. Stops on "stop" or the end of stdin, then writes the
// WAV header and prints "done <frames> <peak 0..32767>". 48 kHz, stereo, 16-bit PCM. Gaps with no
// sound are filled with silence by time, so the file stays in sync with the wall clock.
using System;
using System.IO;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient {
  [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
  [PreserveSig] int GetBufferSize(out uint frames);
  [PreserveSig] int GetStreamLatency(out long latency);
  [PreserveSig] int GetCurrentPadding(out uint padding);
  [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, IntPtr closest);
  [PreserveSig] int GetMixFormat(out IntPtr format);
  [PreserveSig] int GetDevicePeriod(out long def, out long min);
  [PreserveSig] int Start();
  [PreserveSig] int Stop();
  [PreserveSig] int Reset();
  [PreserveSig] int SetEventHandle(IntPtr handle);
  [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient {
  [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
  [PreserveSig] int ReleaseBuffer(uint frames);
  [PreserveSig] int GetNextPacketSize(out uint frames);
}

[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceAsyncOperation {
  [PreserveSig] int GetActivateResult(out int hr, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceCompletionHandler {
  void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op);
}

// The callback must say it is agile (IAgileObject), or activation fails with E_ILLEGAL_METHOD_CALL.
[ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAgileObject { }

class Activated : IActivateAudioInterfaceCompletionHandler, IAgileObject {
  public readonly ManualResetEvent Done = new ManualResetEvent(false);
  public int Hr = -1;
  public object Client;
  public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op) {
    int hr; object iface;
    int r = op.GetActivateResult(out hr, out iface);
    Hr = r < 0 ? r : hr;
    Client = iface;
    Done.Set();
  }
}

static class Program {
  [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
  static extern int ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid iid, IntPtr activationParams, IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation op);

  const int RATE = 48000, CHANNELS = 2, BLOCK = 4;
  static volatile bool stop;

  static long Now100ns() { return (long)(Stopwatch.GetTimestamp() * (10000000.0 / Stopwatch.Frequency)); }

  [MTAThread]
  static int Main(string[] args) {
    if (args.Length < 2) { Console.Error.WriteLine("usage: procaudio <pid> <out.wav>"); return 2; }
    uint pid = uint.Parse(args[0]);
    string outPath = args[1];
    try { return Run(pid, outPath); }
    catch (Exception e) { Console.Error.WriteLine("error " + e.Message); return 1; }
  }

  static int Run(uint pid, string outPath) {
    // AUDIOCLIENT_ACTIVATION_PARAMS { PROCESS_LOOPBACK, { pid, INCLUDE_TARGET_PROCESS_TREE } } in a VT_BLOB PROPVARIANT.
    IntPtr p = Marshal.AllocHGlobal(12);
    Marshal.WriteInt32(p, 0, 1); Marshal.WriteInt32(p, 4, (int)pid); Marshal.WriteInt32(p, 8, 0);
    IntPtr pv = Marshal.AllocHGlobal(24);
    for (int i = 0; i < 24; i += 8) Marshal.WriteInt64(pv, i, 0);
    Marshal.WriteInt16(pv, 0, 65); Marshal.WriteInt32(pv, 8, 12); Marshal.WriteIntPtr(pv, 16, p);

    Guid iidClient = typeof(IAudioClient).GUID;
    Activated handler = new Activated();
    IActivateAudioInterfaceAsyncOperation op;
    int hr = ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iidClient, pv, handler, out op);
    if (hr < 0) throw new Exception("ActivateAudioInterfaceAsync 0x" + hr.ToString("X8") + " (process loopback needs Windows 10 2004 or later)");
    if (!handler.Done.WaitOne(10000)) throw new Exception("audio activation timed out");
    if (handler.Hr < 0) throw new Exception("audio activation 0x" + handler.Hr.ToString("X8"));
    IAudioClient client = (IAudioClient)handler.Client;

    IntPtr fmt = Marshal.AllocHGlobal(18); // WAVEFORMATEX, PCM 48 kHz stereo 16-bit
    Marshal.WriteInt16(fmt, 0, 1); Marshal.WriteInt16(fmt, 2, CHANNELS); Marshal.WriteInt32(fmt, 4, RATE);
    Marshal.WriteInt32(fmt, 8, RATE * BLOCK); Marshal.WriteInt16(fmt, 12, BLOCK); Marshal.WriteInt16(fmt, 14, 16); Marshal.WriteInt16(fmt, 16, 0);
    // LOOPBACK | AUTOCONVERTPCM | SRC_DEFAULT_QUALITY, 200 ms buffer, polled.
    hr = client.Initialize(0, 0x00020000 | 0x80000000 | 0x08000000, 2000000, 0, fmt, IntPtr.Zero);
    if (hr < 0) throw new Exception("IAudioClient.Initialize 0x" + hr.ToString("X8"));
    Guid iidCapture = typeof(IAudioCaptureClient).GUID;
    object svc;
    hr = client.GetService(ref iidCapture, out svc);
    if (hr < 0) throw new Exception("GetService 0x" + hr.ToString("X8"));
    IAudioCaptureClient capture = (IAudioCaptureClient)svc;

    FileStream fs = new FileStream(outPath, FileMode.Create, FileAccess.Write);
    fs.Write(new byte[44], 0, 44);
    long written = 0; // frames
    int peak = 0;
    byte[] buf = new byte[RATE * BLOCK];

    Thread reader = new Thread(delegate () {
      try { string l; while ((l = Console.ReadLine()) != null) if (l.Trim() == "stop") break; } catch { }
      stop = true;
    });
    reader.IsBackground = true;
    reader.Start();

    hr = client.Start();
    if (hr < 0) throw new Exception("IAudioClient.Start 0x" + hr.ToString("X8"));
    long t0 = Now100ns();
    long startMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
    Console.WriteLine("start " + startMs);
    Console.Out.Flush();

    while (!stop) {
      uint next;
      bool got = false;
      while (capture.GetNextPacketSize(out next) >= 0 && next > 0) {
        IntPtr data; uint frames, flags; ulong devPos, qpc;
        if (capture.GetBuffer(out data, out frames, out flags, out devPos, out qpc) < 0) break;
        got = true;
        // Silence before this packet (the game played nothing for a while): pad by its timestamp.
        long at = (long)(((long)qpc - t0) * (double)RATE / 10000000.0);
        if (at > written + RATE / 50) written += Pad(fs, at - written);
        int bytes = (int)frames * BLOCK;
        if (bytes > buf.Length) buf = new byte[bytes];
        if ((flags & 2) != 0 || data == IntPtr.Zero) Array.Clear(buf, 0, bytes);
        else Marshal.Copy(data, buf, 0, bytes);
        for (int i = 0; i + 1 < bytes; i += 2) { int s = (short)(buf[i] | (buf[i + 1] << 8)); if (s < 0) s = -s; if (s > peak) peak = s; }
        fs.Write(buf, 0, bytes);
        written += frames;
        capture.ReleaseBuffer(frames);
      }
      if (!got) {
        // No packets: keep the file in time, 100 ms behind now (a late packet still lands after).
        long due = (long)((Now100ns() - t0) * (double)RATE / 10000000.0) - RATE / 10;
        if (due > written + RATE / 10) written += Pad(fs, due - written);
      }
      Thread.Sleep(10);
    }
    client.Stop();
    long end = (long)((Now100ns() - t0) * (double)RATE / 10000000.0);
    if (end > written) written += Pad(fs, end - written);

    long dataBytes = written * BLOCK;
    fs.Seek(0, SeekOrigin.Begin);
    BinaryWriter w = new BinaryWriter(fs);
    w.Write(new char[] { 'R', 'I', 'F', 'F' }); w.Write((int)(36 + dataBytes)); w.Write(new char[] { 'W', 'A', 'V', 'E' });
    w.Write(new char[] { 'f', 'm', 't', ' ' }); w.Write(16); w.Write((short)1); w.Write((short)CHANNELS); w.Write(RATE);
    w.Write(RATE * BLOCK); w.Write((short)BLOCK); w.Write((short)16);
    w.Write(new char[] { 'd', 'a', 't', 'a' }); w.Write((int)dataBytes);
    w.Flush(); fs.Close();
    Console.WriteLine("done " + written + " " + peak);
    return 0;
  }

  static long Pad(FileStream fs, long frames) {
    byte[] z = new byte[4096 * BLOCK];
    long left = frames;
    while (left > 0) { int n = (int)Math.Min(left, 4096); fs.Write(z, 0, n * BLOCK); left -= n; }
    return frames;
  }
}
