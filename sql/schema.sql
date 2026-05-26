-- ============================================================
-- PDA 로케이션 오적치 방지 시스템 — Supabase 스키마
-- Supabase 콘솔 > SQL Editor 에서 전체 복사 후 실행
-- ============================================================

-- 테이블 1: 매핑 마스터
CREATE TABLE item_mappings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_code     TEXT NOT NULL,
  from_location TEXT NOT NULL,
  to_locations  TEXT[] NOT NULL,
  to_display    TEXT NOT NULL,
  status        TEXT DEFAULT 'active'
                CHECK (status IN ('active','completed','cancelled')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (item_code, from_location)
);

-- 테이블 2: 이동 이력 로그
CREATE TABLE placement_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mapping_id    UUID REFERENCES item_mappings(id),
  item_code     TEXT NOT NULL,
  from_location TEXT NOT NULL,
  scanned_to    TEXT NOT NULL,
  to_display    TEXT NOT NULL,
  result        TEXT NOT NULL CHECK (result IN ('pass','fail')),
  pda_ua        TEXT,
  logged_at     TIMESTAMPTZ DEFAULT NOW()
);

-- RLS 활성화
ALTER TABLE item_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement_logs ENABLE ROW LEVEL SECURITY;

-- anon 전체 허용 정책 (로그인 없는 시스템)
CREATE POLICY "allow_all_item_mappings" ON item_mappings FOR ALL USING (true);
CREATE POLICY "allow_all_placement_logs" ON placement_logs FOR ALL USING (true);
