#!/usr/bin/env bash
set -euo pipefail

echo "[SAFE-PRUNE] Starting at $(date)"
repo_root="$(pwd)"
if [[ ! -d "$repo_root/jobs" ]]; then
  echo "[SAFE-PRUNE][ERR] Not at repo root (missing jobs/)."; exit 1
fi

# Stop any running job writers (non-fatal if none)
pkill -f "node.*SocialStormAI-Refactor" 2>/dev/null || true

# Snapshot current usage (non-destructive)
du -sh jobs/* 2>/dev/null | sort -h | tee cleanup_manifest.txt || true

# Build candidate list of failed/partial jobs
> jobs_without_final.txt
shopt -s nullglob
for d in jobs/*; do
  [[ -d "$d" ]] || continue
  has_final="$(find "$d" -type f -name '*final*.mp4' -print -quit 2>/dev/null || true)"
  has_mega="$(find "$d" -type f -name '*megamux*.mp4' -print -quit 2>/dev/null || true)"
  if [[ -z "$has_final" && -z "$has_mega" ]]; then
    echo "$d" >> jobs_without_final.txt
  fi
done

echo
echo "[SAFE-PRUNE] Candidate failed/partial jobs (no finals found):"
if [[ -s jobs_without_final.txt ]]; then
  cat jobs_without_final.txt
else
  echo "(none)"
fi
echo

# Show sizes for candidates
if [[ -s jobs_without_final.txt ]]; then
  echo "[SAFE-PRUNE] Sizes of failed/partial jobs:"
  xargs -I{} du -sh "{}" < jobs_without_final.txt | sort -h | tee failed_jobs_sizes.txt
  echo
  read -r -p "[SAFE-PRUNE] Delete ONLY these failed/partial jobs? [y/N] " ans
  if [[ "$ans" == "y" || "$ans" == "Y" ]]; then
    xargs -I{} rm -rf "{}" < jobs_without_final.txt
    echo "[SAFE-PRUNE] Deleted failed/partial jobs."
  else
    echo "[SAFE-PRUNE] Skipped deletion."
  fi
fi

echo
echo "[SAFE-PRUNE] Current disk usage:"
df -h .
du -sh jobs video_cache provider_cache renders 2>/dev/null || true
echo "[SAFE-PRUNE] Done."
