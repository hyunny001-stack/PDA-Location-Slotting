-- 품번 우선 이동에서 스캔한 작업을 원자적으로 선점하는 운영 마이그레이션
-- JavaScript 배포 전에 Supabase SQL Editor에서 1회 적용한다.
BEGIN;

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

  -- FROM을 지정하지 않은 직접 선점은 후보가 정확히 한 건일 때만 허용한다.
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

  IF selected_id IS NULL THEN
    RETURN;
  END IF;

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

GRANT EXECUTE ON FUNCTION claim_item_mapping_by_item(TEXT, TEXT, TEXT)
  TO anon, authenticated;

COMMIT;
