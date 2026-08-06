-- 기존 운영 Supabase에 1회 실행하는 자동 작업 배정 마이그레이션
BEGIN;

ALTER TABLE item_mappings ADD COLUMN IF NOT EXISTS claimed_by TEXT;
ALTER TABLE item_mappings ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS item_mappings_claim_queue_idx
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
GRANT EXECUTE ON FUNCTION renew_item_mapping_claim(UUID, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION complete_item_mapping(UUID, TEXT) TO anon, authenticated;

COMMIT;
