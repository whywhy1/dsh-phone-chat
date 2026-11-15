param([string]$Path)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
if (-not $info) {
  '{"text":"","error":"no zh-CN speech recognizer"}'
  exit 0
}
$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$rec.SetInputToWaveFile($Path)
$r = $rec.Recognize()
$text = ''
if ($r) { $text = $r.Text }
$rec.Dispose()
[pscustomobject]@{ text = $text } | ConvertTo-Json -Compress
