// To 로케이션 파싱 유틸 — From은 단일값이므로 To 전용

export function parseLocations(input) {
  if (!input || !input.trim()) return [];
  const result = [];
  for (const seg of input.split(',').map(s => s.trim()).filter(Boolean)) {
    if (seg.includes('~')) {
      const tilde = seg.lastIndexOf('~');
      const startStr = seg.substring(0, tilde).trim();
      const endStr = seg.substring(tilde + 1).trim();
      const lastDash = startStr.lastIndexOf('-');
      if (lastDash === -1) return [];
      const prefix = startStr.substring(0, lastDash + 1);
      const startNumStr = startStr.substring(lastDash + 1);
      const startNum = parseInt(startNumStr, 10);
      const endNum = parseInt(endStr, 10);
      if (isNaN(startNum) || isNaN(endNum) || startNum > endNum) return [];
      const pad = startNumStr.length;
      for (let i = startNum; i <= endNum; i++) {
        result.push(prefix + String(i).padStart(pad, '0'));
      }
    } else {
      result.push(seg);
    }
  }
  return result;
}

// null 반환 = 유효, string 반환 = 오류 메시지
export function validateToLocation(input) {
  if (!input || !input.trim()) return '이동 로케이션 누락';
  for (const seg of input.split(',').map(s => s.trim()).filter(Boolean)) {
    if (seg.includes('~')) {
      const tilde = seg.lastIndexOf('~');
      const startStr = seg.substring(0, tilde).trim();
      const endStr = seg.substring(tilde + 1).trim();
      const lastDash = startStr.lastIndexOf('-');
      if (lastDash === -1) return '이동 로케이션 파싱 실패';
      const startNum = parseInt(startStr.substring(lastDash + 1), 10);
      const endNum = parseInt(endStr, 10);
      if (isNaN(startNum) || isNaN(endNum)) return '이동 로케이션 파싱 실패';
      if (startNum > endNum) return '범위 오류 (시작이 끝보다 큼)';
    }
  }
  if (parseLocations(input).length === 0) return '이동 로케이션 파싱 실패';
  return null;
}
