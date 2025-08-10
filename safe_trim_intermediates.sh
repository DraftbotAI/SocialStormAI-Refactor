#!/usr/bin/env bash
set -euo pipefail
echo "[TRIM] Scanning jobs at $(date)"

if [ ! -d jobs ]; then
  echo "[TRIM][ERR] jobs/ missing"; exit 1
fi

# Build list of large intermediates in COMPLETED jobs (jobs that have final/megamux)
: > trim_candidates.txt
for d in jobs/*; do
  [ -d "$d" ] || continue
  if find "$d" -type f \( -name "*final*.mp4" -o -name "*megamux*.mp4" \) -print -quit 2>/dev/null | grep -q . ; then
    # keep finals/logs/subtitles/json; propose deleting other large files
    find "$d" -type f ! -name "*final*.mp4" ! -name "*megamux*.mp4" \
                     ! -name "*.log" ! -name "*.json" ! -name "*.srt" ! -name "*.vtt" \
                     -size +5M -print 2>/dev/null >> trim_candidates.txt || true
  fi
done

if [ ! -s trim_candidates.txt ]; then
  echo "[TRIM] No large intermediates to remove."
  exit 0
fi

echo "[TRIM] Top 50 candidate files (preview):"
xargs -I{} du -sh "{}" < trim_candidates.txt | sort -h | tail -n 50

read -r -p "[TRIM] Delete ALL listed intermediates? (finals stay) [y/N] " ans
if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
  xargs -I{} rm -f "{}" < trim_candidates.txt
  echo "[TRIM] Intermediates deleted."
else
  echo "[TRIM] Skipped deletion."
fi

echo "[TRIM] Space now:"
df -h .
du -sh jobs video_cache provider_cache renders 2>/dev/null || true
