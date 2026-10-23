# 구조

[← README로 돌아가기](../README.md)

```
electron/main.mjs      창·폴더 선택 대화상자·Finder 연동·클립보드·파일 드래그·시스템 트레이·Dock 메뉴·알림·자동 실행 (메인 프로세스)
electron/index-backup.mjs  색인 백업(.magem)·복원 — 복원은 다음 실행 때 엔진이 켜지기 전에 교체
electron/preload.cjs   렌더러에 노출하는 최소 API
                       화면: pickFolders, setTheme, systemLanguages
                       파일: reveal, revealFolder, openFile, copyImage, copyFiles, copyPaths, startFileDrag, pathForFile
                       백업: startBackup, startRestore, cancelIndexJob, getIndexJob, revealBackup, onIndexJob
                       앱 설정: getAppSettings, setOpenAtLogin, setRunInBackground, setTrayLabels, onOpenSettings
backend/               검색 엔진 (Electron utilityProcess에서 실행)
  main.mjs             엔진 시작점: 엔진·폴더 감시·미리보기를 연결
  embedder.mjs         EmbeddingGemma 2 실행 대기열 (검색 우선, 성능 설정의 휴식)
  embed-worker.mjs     모델 실행 (transformers.js + onnxruntime-node, 별도 스레드)
  media.mjs            사진·영상·오디오 디코딩 (sharp, ffmpeg-static, macOS sips, heic-decode)
  indexer.mjs          폴더 스캔·감시, 색인, 벡터 검색, 남은 시간 추정 (node:sqlite)
  previews.mjs         색인 전 파일의 미리보기 썸네일 (요청 시 생성, 색인 후 정리)
  server.mjs           127.0.0.1 HTTP API + UI (실행할 때마다 바뀌는 토큰 쿠키로 보호)
  db-check.mjs         복원할 백업의 색인 검사 (무결성, 테이블, 썸네일 이름)
  errors.mjs           요청 오류 (400 응답)
static/                UI (HTML/CSS/JS), i18n.js에 화면 문구 17개 언어
build/                 앱 아이콘 (icon-source.png 원본 → npm run make-icons로 생성)
models/                번들에 들어가는 모델 파일 (npm install 시 자동 다운로드)
```

## 임베딩 엔진
- 모델은 `onnx-community/embeddinggemma-2-ONNX`(Apache 2.0)입니다.
  텍스트와 비전은 fp16, 오디오는 q8 정밀도이고, 앱에 포함되는 용량은 약 1.2GB입니다.
- 실행 장치는 GPU를 먼저 시도하고, 안 되면 CPU로 자동 전환합니다.
  - macOS/Linux: WebGPU → CPU
  - Windows: WebGPU → DirectML → CPU
  - `MMF_DEVICE=cpu`로 강제할 수 있습니다.
- 속도 (M2 Pro 측정): WebGPU에서 사진 1장 약 0.55초, CPU만 쓰면 약 2.8초입니다.
- 모델은 별도 스레드에서 실행됩니다. 추론 중에도 엔진이 멈추지 않아, 색인 중에 폴더를 열거나 검색해도 기다리지 않습니다.
- 동영상은 2~30초 간격 프레임(최대 120장)과 15초 단위 오디오 조각으로 나눠 임베딩합니다.
  무음 조각은 건너뜁니다.
- 텍스트 검색에서는 각 벡터가 일반적인 쿼리들과 얼마나 비슷한지(baseline)를 빼서 보정한 뒤,
  관련도(%)가 40% 미만인 결과는 검색 결과에서 제외합니다.
- 파일·폴더 이름은 `title: … | text: …` 문서 형식으로 임베딩합니다.
  점수는 의미 유사도에 키워드 일치(검색어 단어 중 이름에 들어 있는 비율 × 0.2)를 더해 계산합니다.
  의미 점수만으로는 "INFP"처럼 정확한 단어를 찾는 검색이 묻힐 수 있기 때문입니다.
- macOS의 한글 파일 이름은 자모가 분리된 NFD 형식으로 저장되므로, 이름과 검색어를 NFC로 정규화해서 비교합니다.

## 데이터 위치
색인(SQLite)과 썸네일은 앱 데이터 폴더에 저장됩니다.

| 플랫폼 | 경로 |
|---|---|
| macOS | `~/Library/Application Support/Magem/` |
| Windows | `%APPDATA%\Magem\` |
| Linux | `~/.config/Magem/` |

로그는 같은 폴더의 `logs/`에 남습니다.

- `engine.log`: 검색 엔진 로그 (직전 실행분은 `engine.prev.log`)
- `main.log`: 화면·GPU·네트워크 프로세스 종료와 자동 복구, 잠자기·깨우기 기록 (누적)

앱 데이터 폴더의 `previews/`에는 색인 전 파일의 미리보기 썸네일이 잠시 저장됩니다. 최대 200MB이며, 엔진이 시작할 때와 색인이 끝날 때 정리합니다.
