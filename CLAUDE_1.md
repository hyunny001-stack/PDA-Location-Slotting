# CLAUDE.md — PDA 로케이션 오적치 방지 시스템

## 📌 프로젝트 개요

**목적**: 창고 작업자가 품목을 잘못된 로케이션에 적치하는 오적치를 원천 차단
**운영 방식**:
1. 관리자가 PC 웹에서 4컬럼 Excel(품번·현재로케이션·이동로케이션·수량)을 업로드
2. 작업자가 PDA로 품번 QR 스캔 → 대기 중인 TO 로케이션+수량 목록 확인 → TO 로케이션 QR 하나씩 스캔
3. 일치 시: 해당 로케이션 목록에서 제거 + PASS 피드백, 전체 완료 시 완료 화면
4. 불일치 또는 중복 적치 시: FAIL(빨강+경고음+장진동) → 정위치 스캔 전까지 차단

**ERP 연동 없음** — 완전 독립 standalone 시스템
**로그인 없음** — PDA는 URL 즐겨찾기 접속만으로 즉시 사용

---

## 🏗 아키텍처

```
[관리자 PC] → admin.html → Supabase DB
                                ↓ LTE 실시간 조회
[Keyence PDA (Android 최신)] → index.html (PWA)
```

- **DB**: Supabase (PostgreSQL) — 무료 티어
- **배포**: GitHub Pages — 무료, HTTPS 자동
- **PDA**: Keyence BT 시리즈 최신 Android 기종, Chrome 브라우저 접속

---

## 📁 파일 구조

```
/
├── CLAUDE.md
├── index.html              # PDA 작업자 화면 (메인)
├── admin.html              # 관리자 매핑 관리 화면
├── js/
│   ├── config.js           # Supabase URL / anon key 환경 설정
│   ├── supabaseClient.js   # Supabase 클라이언트 초기화
│   ├── locationParser.js   # To 로케이션 범위 파싱 유틸 (From은 단일값이므로 To 전용)
│   ├── audioFeedback.js    # 진동 + 부저음 처리
│   ├── pda.js              # PDA 스캔 메인 로직
│   └── admin.js            # 관리자 업로드/대시보드 로직
└── css/
    └── style.css           # PDA 최적화 스타일 (대형 터치 버튼)
```

---

## 🗄 Supabase DB 스키마

### 테이블 1: `item_mappings` (매핑 마스터)

```sql
CREATE TABLE item_mappings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_code      TEXT NOT NULL,        -- 품번 (= QR 스캔값과 동일)
  from_location  TEXT NOT NULL,        -- 출발 로케이션 단일값 (행당 1개)
  to_locations   TEXT[] NOT NULL,      -- TO 로케이션 배열 ["AM-01-101","AM-01-102",...]
  to_quantities  INT[],                -- to_locations 와 index 1:1 대응 수량 [150, 200, ...]
  to_display     TEXT NOT NULL,        -- 화면 표시용 (to_locations 쉼표 조인)
  status         TEXT DEFAULT 'active'
                 CHECK (status IN ('active','completed','cancelled')),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (item_code, from_location)    -- 품번+From 조합 유일
);

-- 기존 테이블 마이그레이션:
-- ALTER TABLE item_mappings DROP COLUMN IF EXISTS qty_per_location;
-- ALTER TABLE item_mappings ADD COLUMN IF NOT EXISTS to_quantities INT[];
```

### 테이블 2: `placement_logs` (이동 이력)

```sql
CREATE TABLE placement_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mapping_id      UUID REFERENCES item_mappings(id),
  item_code       TEXT NOT NULL,
  from_location   TEXT NOT NULL,       -- 작업자가 스캔한 From 로케이션
  scanned_to      TEXT NOT NULL,       -- 작업자가 실제 스캔한 To 값
  to_display      TEXT NOT NULL,       -- 기대값 표시용
  result          TEXT NOT NULL
                  CHECK (result IN ('pass','fail')),
  pda_ua          TEXT,                -- User-Agent (단말기 식별)
  logged_at       TIMESTAMPTZ DEFAULT NOW()
);
```

### RLS 정책 (Row Level Security)

```sql
-- 읽기/쓰기 모두 anon 허용 (로그인 없는 시스템)
ALTER TABLE item_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_all_item_mappings" ON item_mappings FOR ALL USING (true);
CREATE POLICY "allow_all_placement_logs" ON placement_logs FOR ALL USING (true);
```

---

## ⚙️ config.js 구조

```javascript
// js/config.js
const CONFIG = {
  SUPABASE_URL: 'YOUR_SUPABASE_URL',
  SUPABASE_ANON_KEY: 'YOUR_ANON_KEY',
};
```

> ⚠️ 실제 키는 GitHub에 올리기 전 `.gitignore` 또는 환경변수 처리 필수

---

## 📋 관리자 업로드 Excel 포맷

### 컬럼 구성 (4개) — 1행 = TO 로케이션 1개

| 열 | 컬럼명 | 필수 | 설명 |
|----|--------|------|------|
| **A** | `품번` | ✅ | 품번 (PDA QR 스캔값과 정확히 일치해야 함) |
| **B** | `현재 로케이션` | ✅ | From 단일 로케이션값 |
| **C** | `이동 로케이션` | ✅ | TO 로케이션 **1개** (범위 형식 `~` 사용 불가) |
| **D** | `수량` | ✅ | 해당 TO 로케이션에 이동할 수량 (1 이상 정수) |

> 같은 (품번 + 현재 로케이션) 조합이 여러 행이면 저장 시 자동으로 하나의 이동지시로 묶임

### 실제 입력 예시

| 품번 | 현재 로케이션 | 이동 로케이션 | 수량 |
|------|-------------|-------------|------|
| A | TEMP_LOC | AM-01-101 | 150 |
| A | TEMP_LOC | AM-01-102 | 200 |
| A | TEMP_LOC | AM-01-103 | 150 |
| B | TEMP_LOC | AM-02-201 | 100 |
| B | TEMP_LOC | AM-02-202 | 100 |

→ 저장 결과: 품번 A는 TEMP_LOC에서 AM-01-101(150), AM-01-102(200), AM-01-103(150)으로 이동하는 1건의 이동지시 생성

### C열 이동 로케이션 입력 규칙

| 형식 | 입력 예 | 파싱 결과 |
|------|---------|---------|
| 단일값 | `aa-01-112` | `["aa-01-112"]` |
| 연속 범위 | `aa-01-109~111` | `["aa-01-109","aa-01-110","aa-01-111"]` |
| 비연속 개별 | `aa-01-109, aa-01-111` | `["aa-01-109","aa-01-111"]` |
| 혼합 | `aa-01-109~110, aa-01-115` | `["aa-01-109","aa-01-110","aa-01-115"]` |

> **B열 현재 로케이션**: 반드시 단일값 (행당 1개 로케이션)
> **같은 품번 여러 행**: 품번 A처럼 From이 5개면 5행으로 입력

---

## 📐 핵심 로직 명세

### 1. To 로케이션 파싱 (`locationParser.js`)

From은 단일값이므로 파싱 불필요. To 전용으로 사용.

**범위 파싱 규칙:**
- 접두사(문자+하이픈) + 숫자 분리: `aa-01-109~111` → 접두사 `aa-01-`, 범위 `109~111`
- 쉼표로 1차 분리 → 각 세그먼트 `~` 포함 여부 판단
- 숫자 패딩 유지 (109 → 109, 001 → 001)
- 대소문자 구분 없음 (내부 처리 시 toLowerCase 통일)

```javascript
// 예시: "aa-01-109~111" → ["aa-01-109","aa-01-110","aa-01-111"]
// 예시: "aa-01-112"     → ["aa-01-112"]
function parseLocations(input) {
  const result = [];
  const segments = input.split(',').map(s => s.trim());
  segments.forEach(seg => {
    if (seg.includes('~')) {
      const parts = seg.split('~');
      const startStr = parts[0].trim();
      const endNum  = parseInt(parts[1].trim());
      // 접두사: 마지막 하이픈까지
      const lastDash = startStr.lastIndexOf('-');
      const prefix   = startStr.substring(0, lastDash + 1); // "aa-01-"
      const startNum = parseInt(startStr.substring(lastDash + 1));
      const pad      = startStr.substring(lastDash + 1).length;
      for (let i = startNum; i <= endNum; i++) {
        result.push(prefix + String(i).padStart(pad, '0'));
      }
    } else {
      result.push(seg);
    }
  });
  return result;
}
```

### 2. PDA 스캔 플로우 (`pda.js`)

**PDA가 대기 작업 한 건을 자동 선점하고 작업자에게 이동 순서를 안내함**

```
[자동 배정]
  → claim_next_item_mapping RPC가 active 작업 한 건을 원자적으로 선점
  → 같은 브라우저는 새로고침 후에도 기존 작업을 이어서 받음
  → 15분간 갱신되지 않은 작업은 다른 PDA가 다시 선점 가능

[STEP 1 · FROM]
  → 시스템이 FROM 로케이션을 크게 표시
  → 작업자는 해당 위치로 이동해 FROM QR 스캔

[STEP 2 · 품번]
  → 시스템이 품번과 총 이동 수량을 표시
  → 작업자는 품번 QR 스캔

[STEP 3 · TO]
  → 시스템이 남은 TO 로케이션별 수량을 표시
  → 작업자는 TO로 이동해 TO QR 스캔
  → placement_logs 저장 ACK 확인 후 완료 처리
  → 모든 TO 완료 시 item_mappings를 completed로 변경
  → 완료 화면 후 다음 작업을 자동 배정
```

**중요 규칙**:
- FAIL 시 해당 스텝 재스캔, 다음 단계 진입 차단
- PDA별 선점으로 다수 작업자의 동일 작업 중복 수행 방지
- 완료 로그 저장 실패 시 성공 화면을 표시하지 않음
- 작업이 없을 때 5초마다 자동 재조회
- 앱 재시작 시 같은 PDA의 미완료 작업과 완료된 TO 이력을 복원

**state 구조**:
```javascript
{
  screen: 'LOADING' | 'NO_WORK' | 'FROM' | 'ITEM' | 'TO' | 'FAIL' | 'PASS',
  mapping: null,                 // 현재 PDA가 선점한 단일 매핑
  passResult: null,
  completedLocations: new Set(), // 완료된 TO 로케이션
  failReturn: 'FROM' | 'ITEM' | 'TO',
}
```

### 3. 진동 + 부저음 (`audioFeedback.js`)

```javascript
// PASS 피드백
function passSignal() {
  navigator.vibrate?.(200);
  playTone(880, 0.3, 'sine');        // 맑은 고음 0.3초
}

// FAIL 피드백
function failSignal() {
  navigator.vibrate?.([400, 200, 400, 200, 400]);
  playTone(220, 1.5, 'sawtooth');    // 낮은 경고음 1.5초
}

function playTone(freq, duration, type = 'sine') {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.8, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.start();
  osc.stop(ctx.currentTime + duration);
}
```

> ⚠️ Keyence PDA에서 `navigator.vibrate()` 미작동 확인 시: 부저음 볼륨 최대화 + 화면 플래시로 대체

---

## 🖥 화면 명세

### index.html — PDA 작업자 화면

**전체 컨셉**: 글자 크기 최소 24px. 버튼 최소 60px 높이. 한 손 조작 최적화.

```
━━━━━━━━━━━━━━━━━━━━━━━━
[STEP 1] 첫 스캔 화면   배경: #1e40af
━━━━━━━━━━━━━━━━━━━━━━━━
  ● ○ ○   STEP 1

  품번 또는 로케이션 QR을
  스캔하세요

  [                      ]  ← 자동 포커스

━━━━━━━━━━━━━━━━━━━━━━━━
[STEP 2] 품번 스캔 후 화면   배경: #1e40af
(From 로케이션 스캔 대기)
━━━━━━━━━━━━━━━━━━━━━━━━
  ● ● ○   STEP 2   품번: A

  📍 픽업 대상 로케이션:
  ┌──────────────────────┐
  │ • aa-01-101          │
  │ • aa-01-102          │
  │ • aa-01-103          │
  │ • aa-01-104          │
  │ • aa-01-105          │
  └──────────────────────┘
  해당 로케이션 QR을 스캔하세요
  [                      ]

  [← 처음부터]
━━━━━━━━━━━━━━━━━━━━━━━━
[STEP 3] FROM→TO 확인 화면   배경: #1e40af
(From 특정 완료, To 스캔 대기)
━━━━━━━━━━━━━━━━━━━━━━━━
  ● ● ●   STEP 3   품번: A

  ┌──────────┐    ┌─────────────────┐
  │  FROM    │ →  │  TO             │
  │aa-01-102 │    │ aa-01-109       │
  └──────────┘    │ aa-01-110       │
                  │ aa-01-111       │
                  └─────────────────┘

  이동 로케이션 QR을 스캔하세요
  [                      ]

  [← 처음부터]
━━━━━━━━━━━━━━━━━━━━━━━━
[PASS 화면]   배경: #22c55e
━━━━━━━━━━━━━━━━━━━━━━━━
  ✅  적치 완료!

  aa-01-102 → aa-01-110

  [다음 작업 →]
━━━━━━━━━━━━━━━━━━━━━━━━
[STEP 2 FAIL 화면]   배경: #ef4444
━━━━━━━━━━━━━━━━━━━━━━━━
  🚫  픽업 위치 불일치!

  품번 A의 로케이션이 아닙니다
  스캔됨: aa-01-199

  올바른 로케이션 QR을 스캔하세요
  [                      ]
━━━━━━━━━━━━━━━━━━━━━━━━
[STEP 3 FAIL 화면]   배경: #ef4444
━━━━━━━━━━━━━━━━━━━━━━━━
  🚫  잘못된 적치 위치!

  정위치: aa-01-109~111
  스캔됨: aa-01-115

  올바른 로케이션 QR을 스캔하세요
  [                      ]
━━━━━━━━━━━━━━━━━━━━━━━━
```

> **From 로케이션 QR로 진입 시**: STEP 2 없이 STEP 3 화면으로 직행
> 단, 화면 상단 진행 표시는 `● ● ●`로 동일하게 표시

### admin.html — 관리자 화면

**탭 구조**: [매핑 등록] | [현황 대시보드]

**[매핑 등록 탭]**
```
① [📥 Excel 템플릿 다운로드]
   → SheetJS로 3컬럼 양식 xlsx 생성 다운로드
   → 헤더: 품번 / 현재 로케이션 / 이동 로케이션

② 파일 업로드 영역 (드래그&드롭 or 클릭)
   → SheetJS 파싱 → 미리보기 테이블 표시

③ 미리보기 테이블:
   | 품번 | 현재 로케이션 | 이동 로케이션(파싱결과)          | 상태 |
   | A    | aa-01-101    | aa-01-109, aa-01-110, aa-01-111 | ✅   |
   | B    | aa-01-106    | aa-01-112                       | ✅   |
   | B    | (누락)       | aa-01-113                       | ⚠️  |
   → 오류 행 빨강, [전체 저장] 비활성화

④ [전체 저장] → Supabase upsert (onConflict: 'item_code, from_location')
```

**[현황 대시보드 탭]**
```
필터: [전체 ▼] [active ▼] [completed ▼]    [🔄 새로고침]

| 품번 | 현재 로케이션 | 이동 로케이션   | 상태   | 이동총수량 | PASS   | FAIL | 등록일 | 조작         |
|------|-------------|----------------|--------|----------|--------|------|--------|------------|
| A    | aa-01-101   | aa-01-109~111  | active | 300      | 2 / 3  |  1   | 05-22  | [완료][취소] |
| B    | aa-01-106   | aa-01-112      | active | 200      | 1 / 1  |  0   | 05-22  | [완료][취소] |
```

- **이동총수량**: 완료된 PASS 수 × qty_per_location (qty=0이면 '-' 표시)
- **PASS**: `완료 수 / 전체 로케이션 수` (중복 스캔은 고유 로케이션 기준으로 집계)
```

---

## 📊 Excel 파싱 검증 규칙 (`admin.js`)

오류가 1개라도 있으면 [전체 저장] 비활성화:

| 검증 항목 | 오류 메시지 |
|----------|-----------|
| 품번 비어있음 | "품번 누락" |
| 현재 로케이션 비어있음 | "현재 로케이션 누락" |
| 이동 로케이션 비어있음 | "이동 로케이션 누락" |
| 이동 로케이션에 `~` 포함 (범위 형식) | "범위 형식 불가 — 로케이션 1개씩 입력하세요" |
| 수량이 1 미만이거나 정수 아님 | "수량은 1 이상 정수여야 합니다" |
| (품번 + 현재 로케이션 + TO 로케이션) 중복 행 | "동일 TO 로케이션 중복" |

---

## 📱 PWA 설정 (index.html)

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
```

> Service Worker 미구현 (LTE 상시 연결 환경으로 오프라인 불필요)

---

## 🎨 스타일 가이드 (`style.css`)

| 항목 | 값 |
|------|---|
| 기본 폰트 | `system-ui, -apple-system, sans-serif` |
| 기본 글자 크기 | `20px` (PDA 가독성) |
| 버튼 최소 높이 | `60px` |
| 터치 영역 최소 | `44px × 44px` |
| PASS 배경 | `#22c55e` |
| FAIL 배경 | `#ef4444` |
| 대기/안내 배경 | `#1e40af` |
| 텍스트 (PASS/FAIL) | `white`, `bold` |
| FROM→TO 박스 | `border: 2px solid white`, `border-radius: 8px` |

---

## ⚠️ 알려진 리스크 및 대응

| 리스크 | 상황 | 대응 |
|--------|------|------|
| Keyence 진동 미작동 | `navigator.vibrate()` 무반응 | FAIL 음 볼륨 최대화 + 화면 플래시 강화 |
| 스캔 Enter 미수신 | PDA 스캐너 설정 문제 | Tab키 대체 감지 추가 (`keyCode 9`) |
| LTE 단절 | 서버 조회 실패 | "네트워크 오류. 재시도 중..." + 자동 retry 3회 |
| 품번·로케이션 동시 조회 충돌 | 스캔값이 양쪽에 존재 | from_location 우선 판단 (더 구체적이므로) |
| 중복 등록 | 동일 (품번+From) 재업로드 | upsert 덮어쓰기 처리 |

---

## 🚀 개발 순서 (권장)

```
Phase 1: 기반 세팅
  1. Supabase 프로젝트 생성 + SQL 스키마 실행
  2. config.js 작성 (URL/KEY 입력)
  3. supabaseClient.js 초기화 확인

Phase 2: 관리자 기능
  4. locationParser.js 작성 + 콘솔 파싱 테스트
  5. admin.html — 3컬럼 템플릿 다운로드 기능
  6. admin.html — Excel 업로드 + 파싱 미리보기 + 검증
  7. admin.html — Supabase upsert 저장
  8. admin.html — 현황 대시보드 (PASS/FAIL 집계 포함)

Phase 3: PDA 기능
  9.  audioFeedback.js 작성
  10. index.html — STEP 1 스캔 + 품번/From 로케이션 이중 조회
  11. index.html — STEP 2 From 로케이션 목록 표시 + 스캔 검증
  12. index.html — STEP 3 FROM→TO 화면 + To 스캔 + PASS/FAIL 판정
  13. index.html — 피드백 (진동/부저) + 로그 저장 + 스텝 진행 표시

Phase 4: 검증
  14. 데스크탑 브라우저로 전체 플로우 테스트
  15. Keyence PDA 현장 테스트 (진동/부저 작동 여부 확인)
  16. 미작동 항목 대체 로직 적용
```

---

## 📝 테스트 시나리오

| 시나리오 | 기대 결과 |
|----------|---------|
| PDA 접속 | active 작업 한 건 자동 선점, FROM 안내 |
| PDA 2대 동시 접속 | 서로 다른 active 작업 배정 |
| 잘못된 FROM 스캔 | FAIL + "FROM 로케이션 불일치" |
| 올바른 FROM 스캔 | 품번과 이동 수량 표시 |
| 잘못된 품번 스캔 | FAIL + "품번 불일치" |
| 올바른 품번 스캔 | TO 로케이션별 수량 표시 |
| 잘못된 TO 스캔 | FAIL + "TO 로케이션 불일치" |
| 마지막 TO 스캔 | 저장 ACK 후 완료, 다음 작업 자동 배정 |
| 앱 재시작 | 같은 PDA의 미완료 작업과 완료 TO 복원 |
| 대기 작업 없음 | 안내 표시 후 5초마다 자동 재조회 |
| Excel — 수량 0 또는 문자 입력 | ⚠️ 오류, 저장 차단 |
| Excel — 품번 누락 행 포함 | ⚠️ 오류, 저장 차단 |
| Excel — 중복 (품번+From) 행 포함 | ⚠️ 오류, 저장 차단 |
| Excel — 정상 파일 업로드 | 미리보기에 수량 컬럼 표시, 저장 후 PDA 즉시 반영 |
| 관리자 대시보드 | 이동총수량(PASS수×수량), PASS "X/N" 형식 확인 |
