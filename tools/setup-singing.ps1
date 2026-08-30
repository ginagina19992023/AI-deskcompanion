# Setup singing transcription dependencies (Whisper + librosa + pyworld)
# Run this once to download models and install Python packages

Write-Host "🎵 Setting up singing transcription (Whisper + librosa + pyworld)..."

# Check Python
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (!$pythonCmd) {
    Write-Host "❌ Python not found. Please install Python 3.8+ first."
    exit 1
}

Write-Host "✓ Python found: $(python --version)"

# Install packages
Write-Host ""
Write-Host "📦 Installing Python packages..."
Write-Host "   - openai-whisper (speech-to-text)"
Write-Host "   - librosa (audio analysis)"
Write-Host "   - pyworld (pitch extraction)"
Write-Host ""

python -m pip install --upgrade openai-whisper librosa pyworld

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to install packages. Check your Python installation."
    exit 1
}

Write-Host ""
Write-Host "📥 Downloading Whisper base model (328 MB)..."
Write-Host "   This only needs to be done once."
Write-Host ""

python -c "import whisper; whisper.load_model('base')"

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to download Whisper model."
    exit 1
}

Write-Host ""
Write-Host "✅ Setup complete! Singing transcription is ready to use."
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Go to Dashboard → 唱歌 (Singing) tab"
Write-Host "  2. Click '选择音频文件' (Choose audio file)"
Write-Host "  3. Click '识歌' (Transcribe) to extract lyrics and notes"
Write-Host ""
