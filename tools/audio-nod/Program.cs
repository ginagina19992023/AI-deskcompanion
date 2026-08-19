// Real WASAPI loopback capture -- reads whatever the system is currently
// playing (the same audio you hear), no NAudio/NuGet dependency, so it
// compiles with the .NET Framework csc.exe that already ships on Windows
// (this machine has no dotnet SDK, only the runtime -- see tools/audio-nod/README.md).
//
// Emits one JSON line per detected beat to stdout:
//   {"beat":true,"energy":0.1234}
// so the Electron main process can spawn this exe and read it exactly like
// the existing PowerShell tools (send-reply.ps1, activate-claude-window.ps1).
//
// Beat detection is a classic instant-energy-vs-rolling-average onset
// detector (Sound Capture and Beat Detection algorithm) -- crude compared to
// real spectral-flux beat trackers, but it is a real reaction to real
// system audio, not a fake timer-based simulation.
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace AudioNod
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
        const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        const ushort WAVE_FORMAT_IEEE_FLOAT = 3;
        const ushort WAVE_FORMAT_EXTENSIBLE = 0xFFFE;

        static void Emit(string json)
        {
            Console.WriteLine(json);
            Console.Out.Flush();
        }

        static string JsonString(string s)
        {
            return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", " ").Replace("\r", "") + "\"";
        }

        static int Main()
        {
            try
            {
                var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                IMMDevice device;
                int hr = enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device);
                if (hr != 0 || device == null)
                {
                    Emit("{\"status\":\"error\",\"message\":\"no default playback device (hr=" + hr + ")\"}");
                    return 1;
                }

                Guid iidAudioClient = typeof(IAudioClient).GUID;
                object clientObj;
                hr = device.Activate(ref iidAudioClient, CLSCTX_ALL, IntPtr.Zero, out clientObj);
                if (hr != 0) { Emit("{\"status\":\"error\",\"message\":\"Activate(IAudioClient) failed hr=" + hr + "\"}"); return 1; }
                var client = (IAudioClient)clientObj;

                IntPtr pFormat;
                client.GetMixFormat(out pFormat);
                var fmt = (WAVEFORMATEX)Marshal.PtrToStructure(pFormat, typeof(WAVEFORMATEX));
                bool isFloat = fmt.wFormatTag == WAVE_FORMAT_IEEE_FLOAT || fmt.wFormatTag == WAVE_FORMAT_EXTENSIBLE;

                long hnsBufferDuration = 10000000; // 1s buffer, plenty of headroom for a ~15ms poll loop
                hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, hnsBufferDuration, 0, pFormat, IntPtr.Zero);
                if (hr != 0) { Emit("{\"status\":\"error\",\"message\":\"Initialize failed hr=" + hr + "\"}"); return 1; }

                Guid iidCaptureClient = typeof(IAudioCaptureClient).GUID;
                object captureObj;
                hr = client.GetService(ref iidCaptureClient, out captureObj);
                if (hr != 0) { Emit("{\"status\":\"error\",\"message\":\"GetService(IAudioCaptureClient) failed hr=" + hr + "\"}"); return 1; }
                var capture = (IAudioCaptureClient)captureObj;

                client.Start();
                Emit("{\"status\":\"started\",\"sampleRate\":" + fmt.nSamplesPerSec + ",\"channels\":" + fmt.nChannels + ",\"bits\":" + fmt.wBitsPerSample + "}");

                double avgEnergy = 0.0001;
                DateTime lastBeat = DateTime.MinValue;

                while (true)
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
                            int channels = Math.Max(1, (int)fmt.nChannels);
                            int totalSamples = (int)framesAvailable * channels;
                            double sumSq = 0;
                            if (isFloat)
                            {
                                float[] buf = new float[totalSamples];
                                Marshal.Copy(pData, buf, 0, totalSamples);
                                for (int i = 0; i < totalSamples; i++) sumSq += buf[i] * (double)buf[i];
                            }
                            else
                            {
                                short[] buf = new short[totalSamples];
                                Marshal.Copy(pData, buf, 0, totalSamples);
                                for (int i = 0; i < totalSamples; i++) { double v = buf[i] / 32768.0; sumSq += v * v; }
                            }
                            double rms = Math.Sqrt(sumSq / Math.Max(1, totalSamples));

                            avgEnergy = avgEnergy * 0.98 + rms * 0.02;
                            var now = DateTime.UtcNow;
                            if (rms > avgEnergy * 1.6 && rms > 0.02 && (now - lastBeat).TotalMilliseconds > 260)
                            {
                                lastBeat = now;
                                Emit("{\"beat\":true,\"energy\":" + rms.ToString("F4") + "}");
                            }
                        }

                        capture.ReleaseBuffer(framesAvailable);
                        capture.GetNextPacketSize(out packetSize);
                    }
                }
            }
            catch (Exception ex)
            {
                Emit("{\"status\":\"error\",\"message\":" + JsonString(ex.Message) + "}");
                return 1;
            }
        }
    }
}
