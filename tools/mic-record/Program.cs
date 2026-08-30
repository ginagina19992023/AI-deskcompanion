// Real WASAPI microphone capture -- same raw COM-interop approach as
// tools/audio-nod/Program.cs (no NAudio/NuGet, compiles with the
// Framework csc.exe already on Windows), but capturing the default
// *microphone* endpoint (eCapture) instead of loopback, and writing a
// proper WAV file per utterance instead of doing beat detection.
//
// Driven the same way as tools/voice-stt.ps1: sits idle until "START"
// arrives on stdin, buffers raw PCM while running, and on "STOP" writes
// everything captured since START to a 16-bit PCM WAV file and prints its
// path. This exists specifically to feed whisper.cpp's CLI (which wants a
// WAV file, not a live stream) -- SAPI's own DictationGrammar captured
// live audio internally and never needed an intermediate file, but
// whisper.cpp has no equivalent "just listen to the mic" mode.
//
// Output: one JSON line per event.
//   {"status":"started",...}          once, after the capture device opens
//   {"status":"recording"}            on each STOP -> WAV file written
//   {"path":"C:\\...\\utt-123.wav"}   the WAV file for that utterance
//   {"status":"error","message":"..."} fatal init failure, then exits 1
//
// Stdin commands: START | STOP | EXIT
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace MicRecord
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
    enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int _EnumAudioEndpoints_NotUsed();
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppEndpoint);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        int Initialize(int shareMode, int streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
        int GetBufferSize(out uint pNumBufferFrames);
        int _GetStreamLatency_NotUsed();
        int GetCurrentPadding(out uint pNumPaddingFrames);
        int _IsFormatSupported_NotUsed();
        int GetMixFormat(out IntPtr ppDeviceFormat);
        int _GetDevicePeriod_NotUsed();
        int Start();
        int Stop();
        int Reset();
        int _SetEventHandle_NotUsed();
        int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr ppData, out uint pNumFramesToRead, out uint pdwFlags, out long pu64DevicePosition, out long pu64QPCPosition);
        int ReleaseBuffer(uint numFramesRead);
        int GetNextPacketSize(out uint pNumFramesInNextPacket);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    class Program
    {
        const int CLSCTX_ALL = 23;
        const int AUDCLNT_SHAREMODE_SHARED = 0;
        const ushort WAVE_FORMAT_IEEE_FLOAT = 3;
        const ushort WAVE_FORMAT_EXTENSIBLE = 0xFFFE;
        // whisper.cpp wants 16kHz mono 16-bit PCM -- downmixing/resampling
        // happens inline while copying each captured buffer rather than as
        // a separate pass, since the source format (whatever the mic's mix
        // format actually is) is already in hand at that point.
        const int TARGET_SAMPLE_RATE = 16000;

        static readonly object bufLock = new object();
        static MemoryStream pcmBuffer = null; // null when not recording
        static bool running = false;

        static void Emit(string json)
        {
            Console.WriteLine(json);
            Console.Out.Flush();
        }

        static string JsonString(string s)
        {
            return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", " ").Replace("\r", "") + "\"";
        }

        // Linear resample + downmix to 16kHz mono 16-bit PCM, writing
        // directly into the recording buffer. Good enough for speech (no
        // anti-alias filtering) -- whisper.cpp's own preprocessing already
        // expects imperfect real-world audio, and the accuracy difference
        // against a properly filtered resample is not the bottleneck here.
        static void AppendResampled(short[] mono, int srcRate)
        {
            lock (bufLock)
            {
                if (pcmBuffer == null) return;
                if (srcRate == TARGET_SAMPLE_RATE)
                {
                    var bytes = new byte[mono.Length * 2];
                    Buffer.BlockCopy(mono, 0, bytes, 0, bytes.Length);
                    pcmBuffer.Write(bytes, 0, bytes.Length);
                    return;
                }
                double ratio = (double)srcRate / TARGET_SAMPLE_RATE;
                int outLen = (int)(mono.Length / ratio);
                var outBuf = new short[outLen];
                for (int i = 0; i < outLen; i++)
                {
                    double srcPos = i * ratio;
                    int i0 = (int)srcPos;
                    int i1 = Math.Min(i0 + 1, mono.Length - 1);
                    double frac = srcPos - i0;
                    outBuf[i] = (short)(mono[i0] * (1 - frac) + mono[i1] * frac);
                }
                var outBytes = new byte[outBuf.Length * 2];
                Buffer.BlockCopy(outBuf, 0, outBytes, 0, outBytes.Length);
                pcmBuffer.Write(outBytes, 0, outBytes.Length);
            }
        }

        static void WriteWavFile(string path, byte[] pcm16Mono16k)
        {
            using (var fs = new FileStream(path, FileMode.Create, FileAccess.Write))
            using (var bw = new BinaryWriter(fs))
            {
                int byteRate = TARGET_SAMPLE_RATE * 2; // mono, 16-bit
                bw.Write(new char[] { 'R', 'I', 'F', 'F' });
                bw.Write(36 + pcm16Mono16k.Length);
                bw.Write(new char[] { 'W', 'A', 'V', 'E' });
                bw.Write(new char[] { 'f', 'm', 't', ' ' });
                bw.Write(16);
                bw.Write((ushort)1); // PCM
                bw.Write((ushort)1); // mono
                bw.Write(TARGET_SAMPLE_RATE);
                bw.Write(byteRate);
                bw.Write((ushort)2); // block align
                bw.Write((ushort)16); // bits per sample
                bw.Write(new char[] { 'd', 'a', 't', 'a' });
                bw.Write(pcm16Mono16k.Length);
                bw.Write(pcm16Mono16k);
            }
        }

        // Opens the default microphone endpoint fresh and starts the WASAPI
        // client streaming. Only ever called from inside a START -- see
        // Main() below. Kept as its own method (rather than the previous
        // do-it-once-at-launch shape) specifically so the capture device
        // is *not* touched at all between utterances: confirmed live (same
        // root cause already fixed once for the SAPI engine in
        // voice-stt.ps1, commit 274a72b) that requesting the eCommunications
        // role and calling IAudioClient.Start() keeps Windows' "in a call"
        // detection lit and ducks other apps' volume for as long as the
        // stream stays started, not just while audio is actually being
        // buffered -- so "running" alone was never enough to fix this, the
        // stream itself has to not exist outside a real utterance.
        static bool OpenDevice(out IAudioClient client, out IAudioCaptureClient capture, out WAVEFORMATEX fmt, out bool isFloat)
        {
            client = null; capture = null; fmt = default(WAVEFORMATEX); isFloat = false;
            try
            {
                var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                IMMDevice device;
                // eCommunications, not eMultimedia -- tuned for voice input
                // (often applies the mic's noise-suppression/AGC endpoint
                // effects that a "communications" role activates), matching
                // what a voice-chat app would normally request. This is
                // also exactly the role Windows watches to decide "an app
                // is in a call" and duck other apps' volume, which is the
                // whole reason this is opened only for the START..STOP
                // window rather than for the process's whole lifetime.
                int hr = enumerator.GetDefaultAudioEndpoint(EDataFlow.eCapture, ERole.eCommunications, out device);
                if (hr != 0 || device == null)
                {
                    Emit("{\"status\":\"error\",\"message\":\"no default microphone (hr=" + hr + ")\"}");
                    return false;
                }

                Guid iidAudioClient = typeof(IAudioClient).GUID;
                object clientObj;
                hr = device.Activate(ref iidAudioClient, CLSCTX_ALL, IntPtr.Zero, out clientObj);
                if (hr != 0) { Emit("{\"status\":\"error\",\"message\":\"Activate(IAudioClient) failed hr=" + hr + "\"}"); return false; }
                client = (IAudioClient)clientObj;

                IntPtr pFormat;
                client.GetMixFormat(out pFormat);
                fmt = (WAVEFORMATEX)Marshal.PtrToStructure(pFormat, typeof(WAVEFORMATEX));
                isFloat = fmt.wFormatTag == WAVE_FORMAT_IEEE_FLOAT || fmt.wFormatTag == WAVE_FORMAT_EXTENSIBLE;

                long hnsBufferDuration = 10000000; // 1s
                hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, hnsBufferDuration, 0, pFormat, IntPtr.Zero);
                if (hr != 0) { Emit("{\"status\":\"error\",\"message\":\"Initialize failed hr=" + hr + "\"}"); return false; }

                Guid iidCaptureClient = typeof(IAudioCaptureClient).GUID;
                object captureObj;
                hr = client.GetService(ref iidCaptureClient, out captureObj);
                if (hr != 0) { Emit("{\"status\":\"error\",\"message\":\"GetService(IAudioCaptureClient) failed hr=" + hr + "\"}"); return false; }
                capture = (IAudioCaptureClient)captureObj;

                client.Start();
                Emit("{\"status\":\"started\",\"sampleRate\":" + fmt.nSamplesPerSec + ",\"channels\":" + fmt.nChannels + ",\"bits\":" + fmt.wBitsPerSample + "}");
                return true;
            }
            catch (Exception ex)
            {
                Emit("{\"status\":\"error\",\"message\":" + JsonString(ex.Message) + "}");
                return false;
            }
        }

        static int Main(string[] args)
        {
            string outDir = args.Length > 0 ? args[0] : Path.GetTempPath();
            Directory.CreateDirectory(outDir);

            // No device is opened here anymore -- OpenDevice() runs fresh
            // per START, and the client/capture thread it creates exits
            // when that utterance's STOP arrives. The ~150-300ms this adds
            // to time-to-first-audio per utterance is the same trade this
            // app already made for the SAPI engine; it's not paid while
            // idle, which is the part that actually matters here.
            int uttCounter = 0;
            for (;;)
            {
                string line = Console.In.ReadLine();
                if (line == null) break; // stdin closed -- caller went away
                string cmd = line.Trim();
                if (cmd == "EXIT") break;
                if (cmd == "START")
                {
                    if (running) continue;
                    IAudioClient client; IAudioCaptureClient capture; WAVEFORMATEX fmt; bool isFloat;
                    if (!OpenDevice(out client, out capture, out fmt, out isFloat)) continue;

                    lock (bufLock) { pcmBuffer = new MemoryStream(); }
                    running = true;

                    var captureThread = new Thread(() =>
                    {
                        int channels = Math.Max(1, (int)fmt.nChannels);
                        while (running)
                        {
                            Thread.Sleep(15);
                            uint packetSize;
                            capture.GetNextPacketSize(out packetSize);
                            while (packetSize != 0)
                            {
                                IntPtr pData; uint framesAvailable; uint flags; long devPos, qpcPos;
                                capture.GetBuffer(out pData, out framesAvailable, out flags, out devPos, out qpcPos);
                                if (framesAvailable > 0 && pData != IntPtr.Zero)
                                {
                                    int totalSamples = (int)framesAvailable * channels;
                                    var mono = new short[framesAvailable];
                                    if (isFloat)
                                    {
                                        var buf = new float[totalSamples];
                                        Marshal.Copy(pData, buf, 0, totalSamples);
                                        for (int i = 0; i < framesAvailable; i++)
                                        {
                                            double sum = 0;
                                            for (int c = 0; c < channels; c++) sum += buf[i * channels + c];
                                            double avg = sum / channels;
                                            mono[i] = (short)Math.Max(-32768, Math.Min(32767, avg * 32767.0));
                                        }
                                    }
                                    else
                                    {
                                        var buf = new short[totalSamples];
                                        Marshal.Copy(pData, buf, 0, totalSamples);
                                        for (int i = 0; i < framesAvailable; i++)
                                        {
                                            int sum = 0;
                                            for (int c = 0; c < channels; c++) sum += buf[i * channels + c];
                                            mono[i] = (short)(sum / channels);
                                        }
                                    }
                                    AppendResampled(mono, (int)fmt.nSamplesPerSec);
                                }
                                capture.ReleaseBuffer(framesAvailable);
                                capture.GetNextPacketSize(out packetSize);
                            }
                        }
                        // running flipped false by STOP below -- stop the
                        // stream from this same thread that's been driving
                        // it, so nothing else needs a reference to `client`.
                        try { client.Stop(); } catch { /* device may already be gone (e.g. unplugged) */ }
                    });
                    captureThread.IsBackground = true;
                    captureThread.Start();
                }
                else if (cmd == "STOP")
                {
                    if (running)
                    {
                        running = false; // captureThread observes this and stops the WASAPI client itself
                        byte[] pcm;
                        lock (bufLock)
                        {
                            pcm = pcmBuffer != null ? pcmBuffer.ToArray() : new byte[0];
                            pcmBuffer = null;
                        }
                        uttCounter++;
                        string path = Path.Combine(outDir, "utt-" + DateTime.UtcNow.Ticks + "-" + uttCounter + ".wav");
                        if (pcm.Length > 0)
                        {
                            WriteWavFile(path, pcm);
                            Emit("{\"path\":" + JsonString(path) + "}");
                        }
                        else
                        {
                            Emit("{\"status\":\"error\",\"message\":\"no audio captured\"}");
                        }
                    }
                }
            }

            return 0;
        }
    }
}
