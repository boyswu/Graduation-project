$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$modelDir = Join-Path $root "public\models"
New-Item -ItemType Directory -Force -Path $modelDir | Out-Null

$models = @(
  @{
    Name = "pose_landmarker_lite.task"
    Url = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
  },
  @{
    Name = "selfie_multiclass_256x256.tflite"
    Url = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite"
  }
)

foreach ($model in $models) {
  $target = Join-Path $modelDir $model.Name
  if (Test-Path $target) {
    Write-Host "exists  $($model.Name)"
    continue
  }
  Write-Host "fetch   $($model.Name)"
  Invoke-WebRequest -Uri $model.Url -OutFile $target
}

$wasmSource = Join-Path $root "node_modules\@mediapipe\tasks-vision\wasm"
$wasmTarget = Join-Path $root "public\wasm"
if (Test-Path $wasmSource) {
  New-Item -ItemType Directory -Force -Path $wasmTarget | Out-Null
  Copy-Item -Path (Join-Path $wasmSource "*") -Destination $wasmTarget -Recurse -Force
  Write-Host "copied  MediaPipe WASM"
} else {
  Write-Host "warning: run npm install before copying MediaPipe WASM"
}
