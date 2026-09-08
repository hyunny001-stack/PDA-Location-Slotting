-- ============================================================
-- PDA 로케이션 오적치 방지 시스템 — Supabase 스키마
-- Supabase 콘솔 > SQL Editor 에서 전체 복사 후 실행
-- ============================================================

-- 테이블 1: 매핑 마스터
CREATE TABLE item_mappings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_code      TEXT NOT NULL,
  from_location  TEXT NOT NULL,
  to_locations   TEXT[] NOT NULL,         -- TO 로케이션 배열 (1개씩 개별 입력)
  to_quantities  INT[],                   -- to_locations 와 index 1:1 대응 수량 배열
  to_display     TEXT NOT NULL,           -- 화면 표시용 (to_locations 쉼표 조인)
  status         TEXT DEFAULT 'active'
                 CHECK (status IN ('active','completed','cancelled')),
  claimed_by     TEXT,
  claimed_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (item_code, from_location)
);

-- ※ 기존 테이블 마이그레이션 (신규 설치 아닌 경우):
-- ALTER TABLE item_mappings DROP COLUMN IF EXISTS qty_per_location;
-- ALTER TABLE item_mappings ADD COLUMN IF NOT EXISTS to_quantities INT[];

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

CREATE INDEX item_mappings_claim_queue_idx
  ON item_mappings(status, claimed_at, from_location, item_code);

CREATE OR REPLACE FUNCTION claim_next_item_mapping(p_device_id TEXT)
RETURNS SETOF item_mappings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  selected_id UUID;
BEGIN
  IF p_device_id IS NULL OR length(trim(p_device_id)) < 8 OR length(p_device_id) > 120 THEN
    RAISE EXCEPTION 'INVALID_DEVICE_ID';
  END IF;

  SELECT mapping.id INTO selected_id
  FROM item_mappings mapping
  WHERE mapping.status = 'active'
    AND (
      mapping.claimed_by = p_device_id
      OR mapping.claimed_by IS NULL
      OR mapping.claimed_at < now() - interval '15 minutes'
    )
  ORDER BY
    CASE WHEN mapping.claimed_by = p_device_id THEN 0 ELSE 1 END,
    mapping.from_location,
    mapping.item_code,
    mapping.created_at,
    mapping.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF selected_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  UPDATE item_mappings mapping
  SET claimed_by = p_device_id,
      claimed_at = now(),
      updated_at = now()
  WHERE mapping.id = selected_id
  RETURNING mapping.*;
END;
$$;

CREATE OR REPLACE FUNCTION claim_item_mapping_by_item(
  p_device_id TEXT,
  p_item_code TEXT,
  p_from_location TEXT DEFAULT NULL
)
RETURNS SETOF item_mappings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  selected_id UUID;
  eligible_count INTEGER;
BEGIN
  IF p_device_id IS NULL OR length(trim(p_device_id)) < 8 OR length(p_device_id) > 120 THEN
    RAISE EXCEPTION 'INVALID_DEVICE_ID';
  END IF;
  IF p_item_code IS NULL OR length(trim(p_item_code)) = 0 OR length(p_item_code) > 120 THEN
    RAISE EXCEPTION 'INVALID_ITEM_CODE';
  END IF;
  IF p_from_location IS NOT NULL AND
     (length(trim(p_from_location)) = 0 OR length(p_from_location) > 120) THEN
    RAISE EXCEPTION 'INVALID_FROM_LOCATION';
  END IF;

  SELECT count(*) INTO eligible_count
  FROM item_mappings mapping
  WHERE mapping.status = 'active'
    AND lower(trim(mapping.item_code)) = lower(trim(p_item_code))
    AND (
      mapping.claimed_by = p_device_id
      OR mapping.claimed_by IS NULL
      OR mapping.claimed_at < now() - interval '15 minutes'
    )
    AND (
      p_from_location IS NULL
      OR lower(trim(mapping.from_location)) = lower(trim(p_from_location))
    );

  IF p_from_location IS NULL AND eligible_count <> 1 THEN
    RETURN;
  END IF;

  SELECT mapping.id INTO selected_id
  FROM item_mappings mapping
  WHERE mapping.status = 'active'
    AND lower(trim(mapping.item_code)) = lower(trim(p_item_code))
    AND (
      mapping.claimed_by = p_device_id
      OR mapping.claimed_by IS NULL
      OR mapping.claimed_at < now() - interval '15 minutes'
    )
    AND (
      p_from_location IS NULL
      OR lower(trim(mapping.from_location)) = lower(trim(p_from_location))
    )
  ORDER BY
    CASE WHEN mapping.claimed_by = p_device_id THEN 0 ELSE 1 END,
    mapping.from_location,
    mapping.created_at,
    mapping.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF selected_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  UPDATE item_mappings mapping
  SET claimed_by = p_device_id,
      claimed_at = now(),
      updated_at = now()
  WHERE mapping.id = selected_id
    AND mapping.status = 'active'
  RETURNING mapping.*;
END;
$$;

CREATE OR REPLACE FUNCTION renew_item_mapping_claim(
  p_mapping_id UUID,
  p_device_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE item_mappings
  SET claimed_at = now(), updated_at = now()
  WHERE id = p_mapping_id
    AND status = 'active'
    AND claimed_by = p_device_id;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION complete_item_mapping(
  p_mapping_id UUID,
  p_device_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE item_mappings mapping
  SET status = 'completed',
      claimed_by = NULL,
      claimed_at = NULL,
      updated_at = now()
  WHERE mapping.id = p_mapping_id
    AND mapping.status = 'active'
    AND mapping.claimed_by = p_device_id
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(mapping.to_locations) target(location)
      WHERE NOT EXISTS (
        SELECT 1
        FROM placement_logs log
        WHERE log.mapping_id = mapping.id
          AND log.result = 'pass'
          AND lower(log.scanned_to) = lower(target.location)
      )
    );
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION claim_next_item_mapping(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_item_mapping_by_item(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION renew_item_mapping_claim(UUID, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION complete_item_mapping(UUID, TEXT) TO anon, authenticated;
